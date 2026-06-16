/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* OpenCode session parser
 *
 * Current OpenCode stores sessions in SQLite under its XDG data directory:
 *   ~/.local/share/opencode/opencode.db
 *   ~/.local/share/opencode/opencode-<channel>.db
 *
 * Legacy OpenCode also used JSON files:
 *   ~/.local/share/opencode/storage/session/global/<session-id>.json   -- session metadata
 *   ~/.local/share/opencode/storage/message/<session-id>/<msg-id>.json -- message metadata
 *   ~/.local/share/opencode/storage/part/<msg-id>/<part-id>.json       -- content parts (text, tool, step-start/finish)
 *
 * Sessions have: id, slug, version, projectID, directory, title, time.created/updated
 * Messages have: id, sessionID, role (user|assistant), time, agent, model {providerID, modelID}, tokens, cost
 * Parts have: id, sessionID, messageID, type (text|tool|step-start|step-finish), text, tool, callID, state, tokens, cost
 */

import * as fs from 'fs';
import * as path from 'path';
import { Session, SessionRequest } from './types';
import { assertTrustedPath, createRequest, createSession, detectDevcontainerFromRequests } from './parser-shared';
import { canonicalizeReasoningEffort, extractReasoningEffortFromModelId } from './helpers';

interface OcSession {
  id: string;
  slug?: string;
  version?: string;
  projectID?: string;
  directory?: string;
  path?: string;
  title?: string;
  time?: { created?: number; updated?: number };
  agent?: string;
  model?: { id?: string; providerID?: string; modelID?: string; variant?: string };
}

interface OcMessage {
  id: string;
  sessionID: string;
  role: string;
  time?: { created?: number; completed?: number };
  parentID?: string;
  modelID?: string;
  providerID?: string;
  mode?: string;
  agent?: string;
  cost?: number;
  tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } };
  finish?: string;
  summary?: { title?: string; diffs?: unknown[] };
  variant?: string;
  model?: { providerID?: string; modelID?: string; id?: string; variant?: string };
}

interface OcPart {
  id: string;
  sessionID: string;
  messageID: string;
  type: string;
  text?: string;
  tool?: string;
  callID?: string;
  state?: {
    status?: string;
    input?: Record<string, unknown>;
    output?: string;
    outputPaths?: string[];
    result?: unknown;
    content?: unknown;
  };
  tokens?: { input?: number; output?: number; reasoning?: number };
  cost?: number;
  reason?: string;
}

interface OpenCodeAssistantData {
  responseText: string;
  toolsUsed: string[];
  editedFiles: string[];
  referencedFiles: string[];
  modelId: string;
  totalElapsed: number | null;
  lastTs: number | null;
  tokenSource: OcMessage['tokens'] | null;
  variant?: string;
}

const WRITE_TOOLS = new Set(['write', 'edit', 'create', 'patch']);
const READ_TOOLS = new Set(['read', 'glob', 'grep', 'ls', 'find']);

type JsonRecord = Record<string, unknown>;
type SqliteRow = Record<string, unknown>;

interface SqliteStatement {
  all(...args: unknown[]): SqliteRow[];
  get(...args: unknown[]): SqliteRow | undefined;
}

interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  close(): void;
}

interface SqliteDatabaseConstructor {
  new (filename: string, options: { readOnly?: boolean; readonly?: boolean }): SqliteDatabase;
}

export function findOpenCodeDirs(): string[] {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const dirs: string[] = [];
  const dataDirs = getOpenCodeDataDirs(home);

  const envDb = process.env.OPENCODE_DB;
  if (envDb && envDb !== ':memory:') {
    for (const dataDir of dataDirs) {
      const dbPath = path.isAbsolute(envDb) ? envDb : path.join(dataDir, envDb);
      if (fs.existsSync(dbPath)) dirs.push(dbPath);
    }
  }

  for (const dataDir of dataDirs) {
    const defaultDb = path.join(dataDir, 'opencode.db');
    if (fs.existsSync(defaultDb)) dirs.push(defaultDb);

    try {
      for (const entry of fs.readdirSync(dataDir, { withFileTypes: true })) {
        if (entry.isFile() && /^opencode-.+\.db$/i.test(entry.name)) {
          dirs.push(path.join(dataDir, entry.name));
        }
      }
    } catch {
      /* skip unreadable dirs */
    }

    const legacyStorage = path.join(dataDir, 'storage');
    if (fs.existsSync(legacyStorage)) dirs.push(legacyStorage);
  }

  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function getOpenCodeDataDirs(home: string): string[] {
  const dirs: string[] = [];
  if (process.env.XDG_DATA_HOME) dirs.push(path.join(process.env.XDG_DATA_HOME, 'opencode'));
  if (home) dirs.push(path.join(home, '.local', 'share', 'opencode'));
  return [...new Set(dirs.map(dir => path.resolve(dir)))];
}

function readJsonSafe<T>(filePath: string): T | null {
  try {
    assertTrustedPath(filePath);
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

function readAllJsonInDir<T>(dir: string): T[] {
  const results: T[] = [];
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.json')) continue;
      const data = readJsonSafe<T>(path.join(dir, e.name));
      if (data) results.push(data);
    }
  } catch {
    /* skip unreadable dirs */
  }
  return results;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordFromUnknown(value: unknown): JsonRecord {
  if (isRecord(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function arrayFromUnknown(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringFromUnknown(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberFromUnknown(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function stringArrayFromUnknown(value: unknown): string[] {
  return arrayFromUnknown(value).filter((item): item is string => typeof item === 'string' && item.length > 0);
}

function parseModel(value: unknown): OcMessage['model'] {
  const model = recordFromUnknown(value);
  const modelID = stringFromUnknown(model.modelID) || stringFromUnknown(model.id);
  const providerID = stringFromUnknown(model.providerID);
  const variant = stringFromUnknown(model.variant);
  if (!modelID && !providerID && !variant) return undefined;
  return { id: modelID, modelID, providerID, variant };
}

function parseTokens(value: unknown): OcMessage['tokens'] | undefined {
  const tokens = recordFromUnknown(value);
  if (Object.keys(tokens).length === 0) return undefined;
  const cache = recordFromUnknown(tokens.cache);
  return {
    input: numberFromUnknown(tokens.input),
    output: numberFromUnknown(tokens.output),
    reasoning: numberFromUnknown(tokens.reasoning),
    cache: {
      read: numberFromUnknown(cache.read),
      write: numberFromUnknown(cache.write),
    },
  };
}

function parseTime(data: JsonRecord, row?: SqliteRow): { created?: number; completed?: number } {
  const time = recordFromUnknown(data.time);
  return {
    created: numberFromUnknown(time.created) ?? numberFromUnknown(row?.time_created),
    completed: numberFromUnknown(time.completed) ?? numberFromUnknown(row?.time_updated),
  };
}

function rowString(row: SqliteRow, key: string): string | undefined {
  return stringFromUnknown(row[key]);
}

function rowNumber(row: SqliteRow, key: string): number | undefined {
  return numberFromUnknown(row[key]);
}

function projectNameFromDir(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop() || 'unknown';
}

function getOpenCodeUserText(msg: OcMessage, partsByMsg: Map<string, OcPart[]>): string {
  const userParts = partsByMsg.get(msg.id) || [];
  const userTextFromParts = userParts
    .filter(part => part.type === 'text' && part.text)
    .map(part => part.text!)
    .join('\n');
  return userTextFromParts || msg.summary?.title || '';
}

function findAssistantMessage(messages: OcMessage[], startIndex: number, parentId: string): OcMessage | null {
  for (let i = startIndex; i < messages.length; i++) {
    const candidate = messages[i];
    if (candidate.role === 'assistant' && candidate.parentID === parentId) return candidate;
  }

  const next = messages[startIndex];
  return next?.role === 'assistant' ? next : null;
}

function applyOpenCodePart(part: OcPart, data: Pick<OpenCodeAssistantData, 'toolsUsed' | 'editedFiles' | 'referencedFiles'>, textParts: string[]): void {
  if (part.type === 'text' && part.text) {
    textParts.push(part.text);
    return;
  }

  if (part.type !== 'tool' || !part.tool) return;

  data.toolsUsed.push(part.tool);
  const input = part.state?.input || {};
  const outputPaths = part.state?.outputPaths || [];
  const filePath = typeof input.filePath === 'string'
    ? input.filePath
    : typeof input.file_path === 'string'
      ? input.file_path
      : typeof input.path === 'string'
        ? input.path
        : null;

  const toolLower = part.tool.toLowerCase();
  if (WRITE_TOOLS.has(toolLower)) {
    const editedFiles = filePath ? [filePath, ...outputPaths] : outputPaths;
    data.editedFiles.push(...editedFiles);
    // Include generated code content so extractCodeBlocks() can detect AI-produced code.
    // Write tools store the code in various input fields; also check state.output.
    const content = typeof input.content === 'string' ? input.content
      : typeof input.code === 'string' ? input.code
        : typeof input.new_string === 'string' ? input.new_string
          : typeof part.state?.output === 'string' ? part.state.output
            : null;
    if (content) {
      const ext = (filePath || outputPaths[0] || '').split('.').pop() || 'unknown';
      textParts.push(`\n\`\`\`${ext}\n${content}\n\`\`\`\n`);
    }
  } else if (READ_TOOLS.has(toolLower) && filePath) {
    data.referencedFiles.push(filePath);
  }
}

function collectAssistantData(
  assistantMsg: OcMessage | null,
  partsByMsg: Map<string, OcPart[]>,
  userTs: number | null,
  lastTs: number | null,
): OpenCodeAssistantData {
  const data: OpenCodeAssistantData = {
    responseText: '',
    toolsUsed: [],
    editedFiles: [],
    referencedFiles: [],
    modelId: '',
    totalElapsed: null,
    lastTs,
    tokenSource: null,
    variant: undefined,
  };
  if (!assistantMsg) return data;

  const assistantTs = assistantMsg.time?.completed || assistantMsg.time?.created || null;
  if (assistantTs && (!data.lastTs || assistantTs > data.lastTs)) data.lastTs = assistantTs;
  if (userTs && assistantTs) data.totalElapsed = assistantTs - userTs;

  data.modelId = assistantMsg.modelID || '';
  data.tokenSource = assistantMsg.tokens ?? null;
  data.variant = assistantMsg.variant;

  const textParts: string[] = [];
  const parts = partsByMsg.get(assistantMsg.id) || [];
  for (const part of parts) {
    applyOpenCodePart(part, data, textParts);
  }
  data.responseText = textParts.join('\n');

  return data;
}

function indexPartsByMessage(rawMessages: OcMessage[], storageDir: string): Map<string, OcPart[]> {
  const partsByMsg = new Map<string, OcPart[]>();
  for (const msg of rawMessages) {
    const partDir = path.join(storageDir, 'part', msg.id);
    const parts = readAllJsonInDir<OcPart>(partDir);
    if (parts.length > 0) partsByMsg.set(msg.id, parts);
  }
  return partsByMsg;
}

function getOpenCodeWorkspace(rawSession: OcSession): { wsId: string; wsName: string } {
  return {
    wsId: `opencode-${rawSession.id}`,
    wsName: rawSession.directory
      ? projectNameFromDir(rawSession.directory)
      : rawSession.title || rawSession.slug || 'unknown',
  };
}

function loadDatabaseSync(): SqliteDatabaseConstructor | null {
  try {
    // Optional runtime dependency: older VS Code/Electron builds may not expose node:sqlite.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function'
      ? sqlite.DatabaseSync as SqliteDatabaseConstructor
      : null;
  } catch {
    return null;
  }
}

function tableExists(db: SqliteDatabase, tableName: string): boolean {
  try {
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(tableName);
    return row != null;
  } catch {
    return false;
  }
}

function sessionFromSqliteRow(row: SqliteRow): OcSession | null {
  const id = rowString(row, 'id');
  if (!id) return null;
  return {
    id,
    slug: rowString(row, 'slug'),
    version: rowString(row, 'version'),
    projectID: rowString(row, 'project_id'),
    directory: rowString(row, 'directory'),
    path: rowString(row, 'path'),
    title: rowString(row, 'title'),
    time: {
      created: rowNumber(row, 'time_created'),
      updated: rowNumber(row, 'time_updated'),
    },
    agent: rowString(row, 'agent'),
    model: parseModel(row.model),
  };
}

function sqliteToolPartFromContent(sessionID: string, messageID: string, content: JsonRecord, index: number): OcPart | null {
  if (content.type === 'text') {
    return {
      id: stringFromUnknown(content.id) || `${messageID}-text-${String(index)}`,
      sessionID,
      messageID,
      type: 'text',
      text: stringFromUnknown(content.text),
    };
  }
  if (content.type !== 'tool') return null;

  const state = recordFromUnknown(content.state);
  return {
    id: stringFromUnknown(content.id) || `${messageID}-tool-${String(index)}`,
    sessionID,
    messageID,
    type: 'tool',
    tool: stringFromUnknown(content.name),
    state: {
      status: stringFromUnknown(state.status),
      input: recordFromUnknown(state.input),
      output: stringFromUnknown(state.output) || stringFromUnknown(state.result),
      outputPaths: stringArrayFromUnknown(state.outputPaths),
      result: state.result,
      content: state.content,
    },
  };
}

function sqliteV2Messages(rawSession: OcSession, rows: SqliteRow[]): { messages: OcMessage[]; partsByMsg: Map<string, OcPart[]> } {
  const messages: OcMessage[] = [];
  const partsByMsg = new Map<string, OcPart[]>();
  let lastUserId: string | undefined;
  let currentAgent = rawSession.agent;
  let currentModel = rawSession.model;

  for (const row of rows) {
    const data = recordFromUnknown(row.data);
    const id = rowString(row, 'id') || stringFromUnknown(data.id);
    const type = rowString(row, 'type') || stringFromUnknown(data.type);
    if (!id || !type) continue;

    if (type === 'agent-switched') {
      currentAgent = stringFromUnknown(data.agent) || currentAgent;
      continue;
    }
    if (type === 'model-switched') {
      currentModel = parseModel(data.model) || currentModel;
      continue;
    }
    if (type === 'user') {
      const text = stringFromUnknown(data.text) || '';
      messages.push({
        id,
        sessionID: rawSession.id,
        role: 'user',
        time: parseTime(data, row),
        summary: { title: text },
        agent: currentAgent,
        model: currentModel,
        variant: currentModel?.variant,
      });
      partsByMsg.set(id, [{ id: `${id}-text`, sessionID: rawSession.id, messageID: id, type: 'text', text }]);
      lastUserId = id;
      continue;
    }
    if (type !== 'assistant') continue;

    const model = parseModel(data.model) || currentModel;
    messages.push({
      id,
      sessionID: rawSession.id,
      role: 'assistant',
      parentID: lastUserId,
      time: parseTime(data, row),
      agent: stringFromUnknown(data.agent) || currentAgent,
      modelID: model?.modelID || model?.id,
      providerID: model?.providerID,
      model,
      variant: model?.variant,
      cost: numberFromUnknown(data.cost),
      tokens: parseTokens(data.tokens),
      finish: stringFromUnknown(data.finish),
    });

    const parts = arrayFromUnknown(data.content)
      .map((part, index) => isRecord(part) ? sqliteToolPartFromContent(rawSession.id, id, part, index) : null)
      .filter((part): part is OcPart => part != null);
    if (parts.length > 0) partsByMsg.set(id, parts);
  }

  return { messages, partsByMsg };
}

function inlinePartFromV1(message: OcMessage, part: JsonRecord, index: number): OcPart | null {
  const type = stringFromUnknown(part.type);
  if (!type) return null;
  const id = stringFromUnknown(part.id) || `${message.id}-inline-${String(index)}`;
  if (type === 'tool-invocation') {
    const invocation = recordFromUnknown(part.toolInvocation);
    return {
      id,
      sessionID: message.sessionID,
      messageID: message.id,
      type: 'tool',
      tool: stringFromUnknown(invocation.toolName),
      callID: stringFromUnknown(invocation.toolCallId),
      state: {
        status: stringFromUnknown(invocation.state),
        input: recordFromUnknown(invocation.args),
        output: stringFromUnknown(invocation.result),
      },
    };
  }
  return {
    id,
    sessionID: message.sessionID,
    messageID: message.id,
    type,
    text: stringFromUnknown(part.text),
    tool: stringFromUnknown(part.tool),
    callID: stringFromUnknown(part.callID),
    state: isRecord(part.state)
      ? {
          status: stringFromUnknown(part.state.status),
          input: recordFromUnknown(part.state.input),
          output: stringFromUnknown(part.state.output),
        }
      : undefined,
  };
}

function sqliteV1MessageFromRow(row: SqliteRow): { message: OcMessage; inlineParts: OcPart[] } | null {
  const data = recordFromUnknown(row.data);
  const metadata = recordFromUnknown(data.metadata);
  const assistantMetadata = recordFromUnknown(metadata.assistant);
  const id = rowString(row, 'id') || stringFromUnknown(data.id);
  const sessionID = rowString(row, 'session_id') || stringFromUnknown(data.sessionID) || stringFromUnknown(metadata.sessionID);
  const role = stringFromUnknown(data.role);
  if (!id || !sessionID || !role) return null;

  const model = parseModel(data.model);
  const summary = recordFromUnknown(data.summary);
  const message: OcMessage = {
    id,
    sessionID,
    role,
    time: parseTime(Object.keys(metadata).length > 0 ? metadata : data, row),
    parentID: stringFromUnknown(data.parentID),
    modelID: stringFromUnknown(data.modelID) || stringFromUnknown(assistantMetadata.modelID) || model?.modelID || model?.id,
    providerID: stringFromUnknown(data.providerID) || stringFromUnknown(assistantMetadata.providerID) || model?.providerID,
    mode: stringFromUnknown(data.mode),
    agent: stringFromUnknown(data.agent),
    cost: numberFromUnknown(data.cost) ?? numberFromUnknown(assistantMetadata.cost),
    tokens: parseTokens(data.tokens) || parseTokens(assistantMetadata.tokens),
    finish: stringFromUnknown(data.finish),
    summary: Object.keys(summary).length > 0 ? summary : undefined,
    variant: stringFromUnknown(data.variant) || model?.variant,
    model,
  };

  const inlineParts = arrayFromUnknown(data.parts)
    .map((part, index) => isRecord(part) ? inlinePartFromV1(message, part, index) : null)
    .filter((part): part is OcPart => part != null);
  return { message, inlineParts };
}

function sqliteV1PartFromRow(row: SqliteRow): OcPart | null {
  const message: OcMessage = {
    id: rowString(row, 'message_id') || '',
    sessionID: rowString(row, 'session_id') || '',
    role: 'assistant',
  };
  if (!message.id || !message.sessionID) return null;
  return inlinePartFromV1(message, { ...recordFromUnknown(row.data), id: rowString(row, 'id') }, 0);
}

function buildOpenCodeRequest(
  msg: OcMessage,
  partsByMsg: Map<string, OcPart[]>,
  assistantData: OpenCodeAssistantData,
  userTs: number | null,
): SessionRequest {
  const cacheRead = assistantData.tokenSource?.cache?.read ?? 0;
  const cacheWrite = assistantData.tokenSource?.cache?.write ?? 0;
  const hasTokenData = assistantData.tokenSource != null;
  return createRequest({
    requestId: msg.id,
    timestamp: userTs,
    messageText: getOpenCodeUserText(msg, partsByMsg),
    responseText: assistantData.responseText,
    agentName: msg.agent || 'OpenCode',
    agentMode: msg.agent || 'build',
    modelId: assistantData.modelId,
    toolsUsed: assistantData.toolsUsed,
    editedFiles: [...new Set(assistantData.editedFiles)],
    referencedFiles: [...new Set(assistantData.referencedFiles)],
    totalElapsed: assistantData.totalElapsed,
    // promptTokens = total input context (uncached input + cache read + cache write)
    // so that context-window analysis sees the full context. Cached portions
    // are tracked separately for billing.
    promptTokens: hasTokenData ? (assistantData.tokenSource?.input ?? 0) + cacheRead + cacheWrite : null,
    completionTokens: hasTokenData ? (assistantData.tokenSource?.output ?? 0) : null,
    cacheReadTokens: cacheRead > 0 ? cacheRead : null,
    cacheWriteTokens: cacheWrite > 0 ? cacheWrite : null,
    // OpenCode stores reasoning effort as "variant" on user messages
    reasoningEffort: canonicalizeReasoningEffort(msg.variant || assistantData.variant)
      ?? extractReasoningEffortFromModelId(assistantData.modelId),
  });
}

function parseOpenCodeSession(rawSession: OcSession, storageDir: string): Session | null {
  if (!rawSession.id) return null;

  const msgDir = path.join(storageDir, 'message', rawSession.id);
  const rawMessages = readAllJsonInDir<OcMessage>(msgDir);
  rawMessages.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
  const partsByMsg = indexPartsByMessage(rawMessages, storageDir);
  return parseOpenCodeSessionFromMessages(rawSession, rawMessages, partsByMsg);
}

function parseOpenCodeSessionFromMessages(
  rawSession: OcSession,
  rawMessages: OcMessage[],
  partsByMsg: Map<string, OcPart[]>,
): Session | null {
  if (rawMessages.length === 0) return null;

  const { wsId, wsName } = getOpenCodeWorkspace(rawSession);
  const requests: SessionRequest[] = [];
  let firstTs: number | null = null;
  let lastTs: number | null = null;

  for (let i = 0; i < rawMessages.length; i++) {
    const msg = rawMessages[i];
    if (msg.role !== 'user') continue;

    const userTs = msg.time?.created || null;
    if (userTs && (!firstTs || userTs < firstTs)) firstTs = userTs;

    const assistantMsg = findAssistantMessage(rawMessages, i + 1, msg.id);
    const assistantData = collectAssistantData(assistantMsg, partsByMsg, userTs, lastTs);
    lastTs = assistantData.lastTs;
    requests.push(buildOpenCodeRequest(msg, partsByMsg, assistantData, userTs));
  }

  if (requests.length === 0) return null;

  return createSession({
    sessionId: rawSession.id,
    workspaceId: wsId,
    workspaceName: wsName,
    location: 'terminal',
    harness: 'OpenCode',
    creationDate: firstTs || (rawSession.time?.created || null),
    lastMessageDate: lastTs || (rawSession.time?.updated || null),
    requests,
    hasDevcontainer: detectDevcontainerFromRequests(requests, rawSession.directory),
    workspaceRootPath: rawSession.directory || undefined,
  });
}

function parseOpenCodeSqliteSession(rawSession: OcSession, db: SqliteDatabase): Session | null {
  if (tableExists(db, 'session_message')) {
    const rows = db
      .prepare('SELECT * FROM session_message WHERE session_id = ? ORDER BY seq ASC, time_created ASC, id ASC')
      .all(rawSession.id);
    const normalized = sqliteV2Messages(rawSession, rows);
    const session = parseOpenCodeSessionFromMessages(rawSession, normalized.messages, normalized.partsByMsg);
    if (session) return session;
  }

  if (!tableExists(db, 'message')) return null;
  const rows = db
    .prepare('SELECT * FROM message WHERE session_id = ? ORDER BY time_created ASC, id ASC')
    .all(rawSession.id);
  const rawMessages: OcMessage[] = [];
  let partsByMsg = new Map<string, OcPart[]>();
  for (const row of rows) {
    const normalized = sqliteV1MessageFromRow(row);
    if (!normalized) continue;
    rawMessages.push(normalized.message);
    if (normalized.inlineParts.length > 0) partsByMsg.set(normalized.message.id, normalized.inlineParts);
  }

  if (tableExists(db, 'part')) {
    partsByMsg = new Map(partsByMsg);
    const partRows = db
      .prepare('SELECT * FROM part WHERE session_id = ? ORDER BY time_created ASC, id ASC')
      .all(rawSession.id);
    for (const row of partRows) {
      const part = sqliteV1PartFromRow(row);
      if (!part) continue;
      const parts = partsByMsg.get(part.messageID) || [];
      parts.push(part);
      partsByMsg.set(part.messageID, parts);
    }
  }

  return parseOpenCodeSessionFromMessages(rawSession, rawMessages, partsByMsg);
}

function parseOpenCodeSqliteSessions(dbPath: string): Session[] {
  const DatabaseSync = loadDatabaseSync();
  if (!DatabaseSync) return [];
  try {
    assertTrustedPath(dbPath);
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      if (!tableExists(db, 'session')) return [];
      const rawSessions = db
        .prepare('SELECT * FROM session ORDER BY time_created ASC, id ASC')
        .all()
        .map(sessionFromSqliteRow)
        .filter((session): session is OcSession => session != null);
      const sessions: Session[] = [];
      for (const rawSession of rawSessions) {
        const session = parseOpenCodeSqliteSession(rawSession, db);
        if (session) sessions.push(session);
      }
      return sessions;
    } finally {
      db.close();
    }
  } catch {
    return [];
  }
}

export function parseOpenCodeSessions(storageDir: string): Session[] {
  try {
    if (fs.statSync(storageDir).isFile()) return parseOpenCodeSqliteSessions(storageDir);
  } catch {
    return [];
  }

  const sessions: Session[] = [];
  const sessionDir = path.join(storageDir, 'session', 'global');
  const rawSessions = readAllJsonInDir<OcSession>(sessionDir);

  for (const rawSession of rawSessions) {
    const session = parseOpenCodeSession(rawSession, storageDir);
    if (session) sessions.push(session);
  }

  return sessions;
}
