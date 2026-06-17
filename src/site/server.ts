/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { URL } from 'url';
import { Analyzer } from '../core/analyzer';
import { findLogsDirs, parseAllLogsViaWorker, type LoadProgress, type ParseResult } from '../core/parser';
import { hasExternalHarnessSources } from '../core/parser-harnesses';
import {
  buildSummaryExportFromAnalyzer,
  getSummaryExportFilenames,
  renderSummaryJson,
  renderSummaryMarkdown,
} from '../core/summary-export';
import type { WebviewMessage } from '../core/types';
import {
  approve as approveTrust,
  clearPending,
  createTrustGate,
  getPending,
  listApproved,
  revoke as revokeTrust,
  setDefaultTrustStore,
  type TrustMemento,
} from '../core/rule-trust';
import { invalidateDetectorRegistry } from '../core/detector-registry';
import {
  setDefaultTrustGate,
  loadAllMetricLayersAsync,
  loadAllRuleLayersAsync,
} from '../core/rule-loader';
import { fileUriToPath } from '../core/helpers';
import { getCatalogItems } from '../webview/panel-catalog';
import { getRpcHandler, setDefaultWorkspaceRoot, validateDateFilter } from '../webview/panel-rpc';
import { errorResult, isNumber, isRecord, isRequestMessage, isString, safeJoinUnder } from '../webview/panel-shared';
import { readTextWithByteLimit } from '../webview/fetch-utils';
import { handleLocalAiMethod, isLocalAiMethod } from './ai-handlers';
import { handleCoachChat } from './chat';
import { getLocalDashboardHtml } from './html';

type ResponseMessage = Extract<WebviewMessage, { type: 'response' }>;
type LocalEvent =
  | ResponseMessage
  | ({ type: 'progress' } & LoadProgress)
  | { type: 'dataReady'; currentWorkspace: string }
  | { type: 'event'; method: string; data: unknown };

const CATALOG_MAX_BYTES = 1024 * 1024;
const DEFAULT_PORT = 3987;
const STATE_DIR = path.join(os.homedir(), '.ai-engineer-coach');
const STATE_PATH = path.join(STATE_DIR, 'local-site-state.json');
const DEFAULT_EXPORT_DIR = path.join(STATE_DIR, 'exports');

class JsonMemento implements TrustMemento {
  private data: Record<string, unknown> | undefined;

  constructor(private readonly filePath: string) {}

  get<T>(key: string, defaultValue: T): T {
    const data = this.read();
    return Object.prototype.hasOwnProperty.call(data, key) ? data[key] as T : defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    const data = { ...this.read(), [key]: value };
    await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.promises.writeFile(this.filePath, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
    this.data = data;
  }

  private read(): Record<string, unknown> {
    if (this.data) return this.data;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) as unknown;
      this.data = isRecord(parsed) ? parsed : {};
    } catch {
      this.data = {};
    }
    return this.data;
  }
}

function parseArgs(argv: string[]): { port: number; workspaceRoot: string; host: string } {
  let port = Number(process.env.AIEC_PORT || process.env.PORT || DEFAULT_PORT);
  let workspaceRoot = process.env.AIEC_WORKSPACE || process.cwd();
  let host = process.env.AIEC_HOST || '127.0.0.1';

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--port' && argv[i + 1]) {
      port = Number(argv[++i]);
    } else if (arg.startsWith('--port=')) {
      port = Number(arg.slice('--port='.length));
    } else if (arg === '--workspace' && argv[i + 1]) {
      workspaceRoot = argv[++i];
    } else if (arg.startsWith('--workspace=')) {
      workspaceRoot = arg.slice('--workspace='.length);
    } else if (arg === '--host' && argv[i + 1]) {
      host = argv[++i];
    } else if (arg.startsWith('--host=')) {
      host = arg.slice('--host='.length);
    }
  }

  if (!Number.isFinite(port) || port <= 0) port = DEFAULT_PORT;
  return { port, workspaceRoot: path.resolve(workspaceRoot), host };
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, contentType: string, body: string | Buffer): void {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function responseMessage(id: string, data: unknown): ResponseMessage {
  return { type: 'response', id, data };
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter(isString) : [];
}

async function readRequestJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const rawChunk of req as AsyncIterable<unknown>) {
    let buffer: Uint8Array;
    if (typeof rawChunk === 'string') {
      buffer = Buffer.from(rawChunk, 'utf-8');
    } else if (rawChunk instanceof Uint8Array) {
      buffer = rawChunk;
    } else {
      throw new Error('Invalid request body');
    }
    total += buffer.length;
    if (total > 1024 * 1024) throw new Error('Request body too large');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString('utf-8')) as unknown;
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath)) {
    case '.css': return 'text/css; charset=utf-8';
    case '.js': return 'application/javascript; charset=utf-8';
    case '.map': return 'application/json; charset=utf-8';
    case '.png': return 'image/png';
    case '.svg': return 'image/svg+xml';
    default: return 'application/octet-stream';
  }
}

function readJsonRecord(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function safeWorkspaceRoot(workspacePath: string): string | null {
  const wsJson = path.join(workspacePath, 'workspace.json');
  const json = readJsonRecord(wsJson);
  if (json) {
    const raw = isString(json.folder) ? json.folder : isString(json.workspace) ? json.workspace : '';
    const decoded = fileUriToPath(raw).replace(/\/+$/, '');
    if (decoded && fs.existsSync(decoded)) return decoded;
  }

  const wsYaml = path.join(workspacePath, 'workspace.yaml');
  try {
    const yamlText = fs.readFileSync(wsYaml, 'utf-8');
    const folderMatch = yamlText.match(/folder:\s*['"]?([^'"\n]+)/);
    if (folderMatch) {
      const decoded = fileUriToPath(folderMatch[1]).replace(/\/+$/, '');
      if (fs.existsSync(decoded)) return decoded;
    }
  } catch {
    // Fall through.
  }

  if (fs.existsSync(path.join(workspacePath, 'package.json'))) return workspacePath;
  return null;
}

function getGitHubRemote(rootPath: string): string | null {
  try {
    const configPath = path.join(rootPath, '.git', 'config');
    const gitConfig = fs.readFileSync(configPath, 'utf-8');
    const remoteMatch = gitConfig.match(/url\s*=\s*(?:https?:\/\/github\.com\/|git@github\.com:)([^/\s]+\/[^/\s.]+)/);
    return remoteMatch ? remoteMatch[1].replace(/\.git$/, '') : null;
  } catch {
    return null;
  }
}

function readDirectoryEntries(dirPath: string, include: (entry: string) => boolean, mapEntry: (entry: string) => string = entry => entry): string[] {
  try {
    if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
    return fs.readdirSync(dirPath).filter(include).map(mapEntry);
  } catch {
    return [];
  }
}

function scanRepo(workspace: { workspaceName: string; rootPath: string }): {
  workspace: string;
  remote: string | null;
  contextFiles: string[];
  workflows: string[];
  agenticWorkflows: string[];
} {
  const contextFiles = readDirectoryEntries(
    path.join(workspace.rootPath, '.github', 'agents'),
    entry => entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.md'),
    entry => `agents/${entry}`,
  );
  if (fs.existsSync(path.join(workspace.rootPath, '.github', 'copilot-setup-steps.yml'))) {
    contextFiles.push('copilot-setup-steps.yml');
  }
  if (fs.existsSync(path.join(workspace.rootPath, '.github', 'copilot-instructions.md'))) {
    contextFiles.push('copilot-instructions.md');
  }

  return {
    workspace: workspace.workspaceName,
    remote: getGitHubRemote(workspace.rootPath),
    contextFiles,
    workflows: readDirectoryEntries(path.join(workspace.rootPath, '.github', 'workflows'), entry => entry.endsWith('.yml') || entry.endsWith('.yaml')),
    agenticWorkflows: readDirectoryEntries(path.join(workspace.rootPath, '.github', 'aw'), entry => entry.endsWith('.yml') || entry.endsWith('.yaml') || entry.endsWith('.md')),
  };
}

function resolveWorkspaceRoots(parseResult: ParseResult | undefined): Array<{ workspaceId: string; workspaceName: string; rootPath: string }> {
  if (!parseResult) return [];
  const roots: Array<{ workspaceId: string; workspaceName: string; rootPath: string }> = [];
  for (const [, workspace] of parseResult.workspaces) {
    const rootPath = safeWorkspaceRoot(workspace.path);
    if (rootPath) roots.push({ workspaceId: workspace.id, workspaceName: workspace.name, rootPath });
  }
  return roots;
}

function matchesWorkspace(session: { workspaceId: string; workspaceName: string }, workspaceId?: string): boolean {
  if (!workspaceId) return true;
  return session.workspaceId === workspaceId || session.workspaceName === workspaceId;
}

function isCopilotLogin(login: string | undefined): boolean {
  return login?.toLowerCase()?.includes('copilot') === true ||
    login === 'github-actions[bot]' ||
    login?.startsWith('copilot-swe-agent') === true;
}

async function fetchGitHubCount(url: string, headers: Record<string, string>): Promise<number | null> {
  try {
    const response = await fetch(url, { headers, redirect: 'error' });
    if (!response.ok) return null;
    const data = await response.json() as { total_count?: number } | Array<unknown>;
    if (Array.isArray(data)) return data.length;
    return isRecord(data) && isNumber(data.total_count) ? data.total_count : 0;
  } catch {
    return null;
  }
}

async function fetchCopilotPrStats(owner: string, repo: string, headers: Record<string, string>): Promise<{ total: number; assignedToCopilot: number; reviewedByCopilot: number }> {
  const stats = { total: 0, assignedToCopilot: 0, reviewedByCopilot: 0 };
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=all&per_page=50&sort=updated&direction=desc`,
      { headers, redirect: 'error' },
    );
    if (!response.ok) return stats;
    const prs = await response.json() as Array<{
      user?: { login?: string };
      assignees?: Array<{ login?: string }>;
      requested_reviewers?: Array<{ login?: string }>;
    }>;
    stats.total = prs.length;
    for (const pr of prs) {
      const isCopilotAuthor = isCopilotLogin(pr.user?.login);
      const isCopilotAssignee = pr.assignees?.some(assignee => isCopilotLogin(assignee.login)) === true;
      const isCopilotReviewer = pr.requested_reviewers?.some(reviewer => isCopilotLogin(reviewer.login)) === true;
      if (isCopilotAuthor || isCopilotAssignee) stats.assignedToCopilot++;
      if (isCopilotReviewer) stats.reviewedByCopilot++;
    }
  } catch {
    // Ignore API failures.
  }
  return stats;
}

async function fetchCollaboratorStats(owner: string, repo: string, headers: Record<string, string>): Promise<Array<{ total: number; withCopilot: number }>> {
  try {
    const response = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/collaborators?per_page=100`,
      { headers, redirect: 'error' },
    );
    if (!response.ok) return [];
    const collaborators = await response.json() as Array<{ login?: string }>;
    return [{ total: collaborators.length, withCopilot: 0 }];
  } catch {
    return [];
  }
}

class LocalDashboardServer {
  private readonly events = new Set<http.ServerResponse>();
  private readonly stateStore = new JsonMemento(STATE_PATH);
  private readonly assetsDir = path.join(__dirname, 'webview');
  private analyzer: Analyzer | undefined;
  private parseResult: ParseResult | undefined;
  private loadPromise: Promise<void> | undefined;
  private loadError: string | undefined;
  private dataReady = false;

  constructor(private readonly workspaceRoot: string) {
    setDefaultWorkspaceRoot(workspaceRoot);
    const trustGate = createTrustGate(this.stateStore);
    setDefaultTrustGate(trustGate);
    setDefaultTrustStore(this.stateStore);
    clearPending();
  }

  handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    try {
      const requestUrl = new URL(req.url || '/', 'http://localhost');
      if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
        sendText(res, 200, 'text/html; charset=utf-8', getLocalDashboardHtml());
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/api/events') {
        this.handleEvents(req, res);
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/rpc') {
        await this.handleRpc(req, res);
        return;
      }
      if (req.method === 'POST' && requestUrl.pathname === '/api/reload') {
        await this.loadData(true);
        sendJson(res, 200, { ok: true });
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname.startsWith('/assets/')) {
        await this.serveAsset(requestUrl.pathname, res);
        return;
      }
      if (req.method === 'GET' && requestUrl.pathname === '/favicon.ico') {
        res.writeHead(204, { 'Cache-Control': 'no-store' });
        res.end();
        return;
      }
      sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
    } catch (error: unknown) {
      sendJson(res, 500, errorResult(error instanceof Error ? error.message : 'Internal server error'));
    }
  };

  async startLoading(): Promise<void> {
    await this.loadData(false);
  }

  private handleEvents(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    this.events.add(res);
    req.on('close', () => this.events.delete(res));

    if (this.dataReady) {
      this.sendEvent(res, { type: 'dataReady', currentWorkspace: path.basename(this.workspaceRoot) });
    } else if (this.loadError) {
      this.sendEvent(res, { type: 'progress', phase: 5, pct: 100, detail: this.loadError });
    } else {
      void this.loadData(false);
    }
  }

  private sendEvent(res: http.ServerResponse, event: LocalEvent): void {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  private broadcast(event: LocalEvent): void {
    for (const res of this.events) this.sendEvent(res, event);
  }

  private async serveAsset(requestPath: string, res: http.ServerResponse): Promise<void> {
    const segments = requestPath.replace(/^\/assets\/?/, '').split('/').filter(Boolean);
    const filePath = safeJoinUnder(this.assetsDir, segments, { allowedExts: ['.js', '.css', '.map'] });
    if (!filePath || !fs.existsSync(filePath)) {
      sendText(res, 404, 'text/plain; charset=utf-8', 'Not found');
      return;
    }
    sendText(res, 200, contentTypeFor(filePath), await fs.promises.readFile(filePath));
  }

  private async loadData(force: boolean): Promise<void> {
    if (this.loadPromise && !force) return this.loadPromise;
    if (this.dataReady && !force) return;

    this.loadPromise = (async () => {
      this.loadError = undefined;
      this.dataReady = false;
      await Promise.all([
        loadAllRuleLayersAsync(this.workspaceRoot),
        loadAllMetricLayersAsync(this.workspaceRoot),
      ]);

      this.broadcast({ type: 'progress', phase: 0, detail: 'Discovering log directories', pct: 0 });
      const dirs = findLogsDirs();
      const hasExternal = hasExternalHarnessSources();
      if (dirs.length === 0 && !hasExternal) {
        this.loadError = 'No AI coding session logs found. Looked for VS Code, GitHub Copilot CLI and Xcode, Claude Code, Codex, and OpenCode sessions.';
        this.broadcast({ type: 'progress', phase: 5, detail: this.loadError, pct: 100 });
        return;
      }

      this.parseResult = await parseAllLogsViaWorker(dirs, progress => {
        this.broadcast({ type: 'progress', ...progress });
      });
      this.broadcast({
        type: 'progress',
        phase: 4,
        detail: 'Building analyzer',
        pct: 90,
        sessions: this.parseResult.sessions.length,
      });
      this.analyzer = new Analyzer(this.parseResult.sessions, this.parseResult.editLocIndex, this.parseResult.workspaces);
      this.broadcast({
        type: 'progress',
        phase: 5,
        detail: 'Ready',
        pct: 100,
        sessions: this.parseResult.sessions.length,
      });
      this.dataReady = true;
      this.broadcast({ type: 'dataReady', currentWorkspace: path.basename(this.workspaceRoot) });
      void this.analyzer.warmUp().catch(() => undefined);
    })().finally(() => {
      this.loadPromise = undefined;
    });

    return this.loadPromise;
  }

  private async handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const raw = await readRequestJson(req);
    if (!isRequestMessage(raw)) {
      sendJson(res, 400, responseMessage('', errorResult('Invalid request')));
      return;
    }

    const local = await this.handleLocalMethod(raw);
    if (local.handled) {
      sendJson(res, 200, responseMessage(raw.id, local.data));
      return;
    }

    await this.loadData(false);
    if (!this.analyzer || !this.parseResult) {
      sendJson(res, 200, responseMessage(raw.id, errorResult(this.loadError || 'Dashboard data is not available')));
      return;
    }

    const handler = getRpcHandler(raw.method);
    if (!handler) {
      sendJson(res, 200, responseMessage(raw.id, errorResult(`Unknown method: ${raw.method}`)));
      return;
    }

    try {
      const result = await handler(this.analyzer, this.parseResult, (raw.params ?? {}) as Record<string, unknown>);
      sendJson(res, 200, responseMessage(raw.id, result));
    } catch (error: unknown) {
      sendJson(res, 200, responseMessage(raw.id, errorResult(error instanceof Error ? error.message : 'Internal error')));
    }
  }

  private async handleLocalMethod(msg: Extract<WebviewMessage, { type: 'request' }>): Promise<{ handled: boolean; data?: unknown }> {
    if (isLocalAiMethod(msg.method)) {
      if (msg.method !== 'generateRule' && msg.method !== 'createSkill') {
        await this.loadData(false);
      }
      return {
        handled: true,
        data: await handleLocalAiMethod(msg.method, msg.params, {
          analyzer: this.analyzer,
          parseResult: this.parseResult,
          emitEvent: (method, data) => this.broadcast({ type: 'event', method, data }),
        }),
      };
    }

    switch (msg.method) {
      case 'saveModelBudgets':
        await this.stateStore.update('modelBudgets', isRecord(msg.params) ? (msg.params as Record<string, unknown>).budgets : {});
        return { handled: true, data: { ok: true } };
      case 'loadModelBudgets':
        return { handled: true, data: this.stateStore.get<Record<string, number>>('modelBudgets', {}) };
      case 'exportSummary':
        return { handled: true, data: await this.exportSummary(msg.params) };
      case 'reviewLocalRules':
        return { handled: true, data: await this.reviewLocalRules(msg.params) };
      case 'coachChat':
        await this.loadData(false);
        if (!this.analyzer) return { handled: true, data: errorResult(this.loadError || 'Dashboard data is not available') };
        try {
          return { handled: true, data: await handleCoachChat(msg.params, this.analyzer) };
        } catch (error: unknown) {
          return { handled: true, data: errorResult(error instanceof Error ? error.message : 'Coach chat failed') };
        }
      case 'installSkill':
        return { handled: true, data: await this.installSkill(msg.params) };
      case 'installCatalogItem':
        return { handled: true, data: await this.installCatalogItem(msg.params) };
      case 'discoverCatalog':
        return { handled: true, data: await this.discoverCatalog() };
      case 'getWorkspaceDeps':
        return { handled: true, data: this.getWorkspaceDeps(msg.params) };
      case 'getSdlcToolAnalysis':
        return { handled: true, data: this.getSdlcToolAnalysis(msg.params) };
      case 'getSdlcRepoScan':
        return { handled: true, data: this.getSdlcRepoScan() };
      case 'getSdlcGitHubData':
        return { handled: true, data: await this.getSdlcGitHubData(msg.params) };
      default:
        return { handled: false };
    }
  }

  private async reloadRuleLayers(): Promise<void> {
    clearPending();
    await Promise.all([
      loadAllRuleLayersAsync(this.workspaceRoot),
      loadAllMetricLayersAsync(this.workspaceRoot),
    ]);
    invalidateDetectorRegistry();
    this.broadcast({ type: 'dataReady', currentWorkspace: path.basename(this.workspaceRoot) });
  }

  private async reviewLocalRules(params: unknown): Promise<unknown> {
    const p = isRecord(params) ? params : {};
    const approved = listApproved(this.stateStore);

    if (p.revokeAll === true) {
      const paths = Object.keys(approved);
      for (const filePath of paths) {
        await revokeTrust(this.stateStore, filePath);
      }
      await this.reloadRuleLayers();
      return { ok: true, revoked: paths.length, approved: 0, pending: getPending().length };
    }

    const pending = getPending();
    if (pending.length === 0) {
      return { ok: true, approved: 0, approvedTotal: Object.keys(approved).length, pending: 0 };
    }

    const requestedPaths = new Set(stringArray(p.filePaths));
    const selected = requestedPaths.size > 0
      ? pending.filter(entry => requestedPaths.has(entry.filePath))
      : pending;
    for (const entry of selected) {
      await approveTrust(this.stateStore, entry.filePath, entry.content);
    }

    await this.reloadRuleLayers();
    return { ok: true, approved: selected.length, pending: getPending().length };
  }

  private async exportSummary(params: unknown): Promise<unknown> {
    await this.loadData(false);
    if (!this.analyzer) return errorResult(this.loadError || 'Dashboard data is not available');
    const filter = isRecord(params) && isRecord(params.filter)
      ? validateDateFilter(params.filter)
      : isRecord(params) ? validateDateFilter(params) : undefined;
    const generatedAt = new Date();
    const report = buildSummaryExportFromAnalyzer(this.analyzer, filter, generatedAt);
    const filenames = getSummaryExportFilenames(generatedAt);
    const folder = path.resolve(process.env.AIEC_EXPORT_DIR || DEFAULT_EXPORT_DIR);
    await fs.promises.mkdir(folder, { recursive: true });
    const markdownPath = path.join(folder, filenames.markdown);
    const jsonPath = path.join(folder, filenames.json);
    await Promise.all([
      fs.promises.writeFile(markdownPath, renderSummaryMarkdown(report), 'utf-8'),
      fs.promises.writeFile(jsonPath, renderSummaryJson(report), 'utf-8'),
    ]);
    return { ok: true, folder, markdownPath, jsonPath };
  }

  private async installSkill(params: unknown): Promise<unknown> {
    if (!isRecord(params)) return errorResult('Missing filename or content');
    const filename = isString(params.filename) ? params.filename : '';
    const content = isString(params.content) ? params.content : '';
    if (!filename || !content) return errorResult('Missing filename or content');
    const targetPath = safeJoinUnder(path.join(os.homedir(), '.agents', 'skills'), filename.split('/'), { allowedExts: ['.md'] });
    if (!targetPath) return errorResult('Invalid filename');
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, 'utf-8');
    return { ok: true, path: targetPath };
  }

  private async installCatalogItem(params: unknown): Promise<unknown> {
    if (!isRecord(params)) return errorResult('Invalid catalog item');
    const catalogPath = isString(params.path) ? params.path : '';
    const kind = isString(params.kind) ? params.kind : 'skill';
    const title = isString(params.title) ? params.title : '';
    if (!catalogPath || catalogPath.includes('..') || catalogPath.startsWith('/') || catalogPath.startsWith('\\')) {
      return errorResult('Invalid catalog path');
    }

    const rawUrl = `https://raw.githubusercontent.com/github/awesome-copilot/main/${catalogPath}`;
    const parsedUrl = new URL(rawUrl);
    if (parsedUrl.hostname !== 'raw.githubusercontent.com' || !parsedUrl.pathname.startsWith('/github/awesome-copilot/')) {
      return errorResult('Invalid catalog URL');
    }
    const response = await fetch(parsedUrl.toString(), { redirect: 'error' });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.status}`);
    const content = await readTextWithByteLimit(response, CATALOG_MAX_BYTES, 'Catalog item too large');
    const subDir = kind === 'agent' ? 'agents' : 'skills';
    const slug = title.toLowerCase().replaceAll(/[^a-z0-9]+/g, '-').replaceAll(/-+/g, '-').replaceAll(/^-|-$/g, '') || 'catalog-item';
    const filename = catalogPath.split('/').pop() || `${slug}.md`;
    const targetPath = safeJoinUnder(path.join(os.homedir(), '.agents', subDir), [slug, filename], { allowedExts: ['.md'] });
    if (!targetPath) return errorResult('Invalid path');
    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.writeFile(targetPath, content, 'utf-8');
    return { content, filename: `${slug}/${filename}` };
  }

  private async discoverCatalog(): Promise<unknown> {
    const items = (await getCatalogItems()).map(item => ({
      ...item,
      relevanceScore: 0,
      matchReasons: [],
    }));
    return { items, totalScanned: items.length };
  }

  private getWorkspaceDeps(params: unknown): unknown {
    const limit = isRecord(params) && isNumber(params.limit) ? Math.min(params.limit, 20) : 10;
    const roots = resolveWorkspaceRoots(this.parseResult);
    const wsActivity = new Map<string, number>();
    for (const session of this.parseResult?.sessions ?? []) {
      const existing = wsActivity.get(session.workspaceId) || 0;
      const ts = session.lastMessageDate || session.creationDate || 0;
      if (ts > existing) wsActivity.set(session.workspaceId, ts);
    }
    const deps = roots
      .sort((a, b) => (wsActivity.get(b.workspaceId) || 0) - (wsActivity.get(a.workspaceId) || 0))
      .slice(0, limit)
      .flatMap(workspace => {
        const pkg = readJsonRecord(path.join(workspace.rootPath, 'package.json'));
        if (!pkg) return [];
        return [{
          workspace: workspace.workspaceName,
          dependencies: Object.keys(isRecord(pkg.dependencies) ? pkg.dependencies : {}),
          devDependencies: Object.keys(isRecord(pkg.devDependencies) ? pkg.devDependencies : {}),
        }];
      });
    return { deps };
  }

  private getSdlcToolAnalysis(params: unknown): unknown {
    if (!this.parseResult) return { mcpServers: [], toolCounts: {} };
    const filter = isRecord(params) && isRecord(params.filter) ? validateDateFilter(params.filter) : undefined;
    const serverCounts = new Map<string, number>();
    const sdlcServerMap: Record<string, { label: string; category: string }> = {
      github: { label: 'GitHub', category: 'Source Control' },
      atlassian: { label: 'Atlassian (Jira/Confluence)', category: 'Project Management' },
      jira: { label: 'Jira', category: 'Project Management' },
      docker: { label: 'Docker', category: 'Containers' },
      playwright: { label: 'Playwright', category: 'Testing' },
      postgres: { label: 'PostgreSQL', category: 'Database' },
      sentry: { label: 'Sentry', category: 'Error Tracking' },
      terraform: { label: 'Terraform', category: 'Infrastructure' },
    };
    for (const session of this.parseResult.sessions) {
      if (!matchesWorkspace(session, filter?.workspaceId)) continue;
      if (filter?.harness && session.harness !== filter.harness) continue;
      for (const request of session.requests) {
        for (const tool of request.toolsUsed) {
          if (!tool.startsWith('mcp_')) continue;
          const rest = tool.slice(4);
          const underscoreIdx = rest.indexOf('_');
          const serverId = underscoreIdx > 0 ? rest.slice(0, underscoreIdx) : rest;
          serverCounts.set(serverId, (serverCounts.get(serverId) || 0) + 1);
        }
      }
    }
    const mcpServers = Array.from(serverCounts.entries()).map(([serverId, toolCalls]) => {
      const info = sdlcServerMap[serverId];
      return {
        id: serverId,
        label: info?.label || serverId,
        category: info?.category || 'Other',
        toolCalls,
        isSdlcRelevant: !!info,
      };
    }).sort((a, b) => b.toolCalls - a.toolCalls);
    return { mcpServers };
  }

  private getSdlcRepoScan(): unknown {
    const roots = resolveWorkspaceRoots(this.parseResult);
    const wsActivity = new Map<string, number>();
    for (const session of this.parseResult?.sessions ?? []) {
      const existing = wsActivity.get(session.workspaceId) || 0;
      const ts = session.lastMessageDate || session.creationDate || 0;
      if (ts > existing) wsActivity.set(session.workspaceId, ts);
    }
    const repos = roots
      .sort((a, b) => (wsActivity.get(b.workspaceId) || 0) - (wsActivity.get(a.workspaceId) || 0))
      .map(workspace => scanRepo(workspace));
    return { repos };
  }

  private async getSdlcGitHubData(params: unknown): Promise<unknown> {
    if (!isRecord(params)) return errorResult('Missing owner/repo');
    const owner = isString(params.owner) ? params.owner : '';
    const repo = isString(params.repo) ? params.repo : '';
    if (!owner || !repo) return errorResult('Missing owner/repo');
    if (owner !== '_auth_' && (!/^[A-Za-z0-9._-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo))) {
      return errorResult('Invalid owner/repo');
    }
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
    if (!token) {
      return {
        authRequired: true,
        error: 'GitHub authentication required. Set GITHUB_TOKEN or GH_TOKEN before starting the local site.',
      };
    }
    if (owner === '_auth_') return { authRequired: false };
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    const previewHeaders = { ...headers, 'X-GitHub-Api-Version': '2026-03-10' };
    return {
      copilotPrs: await fetchCopilotPrStats(owner, repo, headers),
      codingAgentRuns: await fetchGitHubCount(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/copilot/coding-agent/runs?per_page=100`,
        previewHeaders,
      ),
      agentTasks: await fetchGitHubCount(
        `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/agent-tasks?per_page=100`,
        previewHeaders,
      ),
      collaborators: await fetchCollaboratorStats(owner, repo, headers),
    };
  }
}

const { port, workspaceRoot, host } = parseArgs(process.argv.slice(2));
const localServer = new LocalDashboardServer(workspaceRoot);
const server = http.createServer((req, res) => {
  void localServer.handler(req, res);
});

server.listen(port, host, () => {
  const displayHost = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`AI Engineer Coach local site: http://${displayHost}:${port}`);
  console.log(`Workspace root: ${workspaceRoot}`);
});

void localServer.startLoading().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
});
