/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/* Tests for the OpenCode parser — verifies that assistant messages with
 * `tokens: {input:0, output:0}` (tool-only / cached continuation steps)
 * are recorded as data (zero tokens), not flagged as missing. */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import { findOpenCodeDirs, parseOpenCodeSessions } from './parser-opencode';

interface TestSqliteStatement {
  run(...args: unknown[]): unknown;
}

interface TestSqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): TestSqliteStatement;
  close(): void;
}

interface TestSqliteDatabaseConstructor {
  new (filename: string, options: Record<string, never>): TestSqliteDatabase;
}

function loadTestDatabaseSync(): TestSqliteDatabaseConstructor | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const sqlite = require('node:sqlite') as { DatabaseSync?: unknown };
    return typeof sqlite.DatabaseSync === 'function'
      ? sqlite.DatabaseSync as TestSqliteDatabaseConstructor
      : null;
  } catch {
    return null;
  }
}

function withStorage(
  rawSession: object,
  messages: object[],
  run: (storageDir: string) => void,
): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-test-'));
  const storageDir = path.join(root, 'storage');
  const sessId = (rawSession as { id: string }).id;
  fs.mkdirSync(path.join(storageDir, 'session', 'global'), { recursive: true });
  fs.writeFileSync(
    path.join(storageDir, 'session', 'global', `${sessId}.json`),
    JSON.stringify(rawSession),
    'utf-8',
  );
  fs.mkdirSync(path.join(storageDir, 'message', sessId), { recursive: true });
  for (const msg of messages) {
    const m = msg as { id: string };
    fs.writeFileSync(
      path.join(storageDir, 'message', sessId, `${m.id}.json`),
      JSON.stringify(msg),
      'utf-8',
    );
  }
  try { run(storageDir); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

function withSqliteDb(run: (dbPath: string, db: TestSqliteDatabase) => void): void {
  const DatabaseSync = loadTestDatabaseSync();
  expect(DatabaseSync).not.toBeNull();
  if (!DatabaseSync) return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-parser-sqlite-test-'));
  const dbPath = path.join(root, 'opencode.db');
  const db = new DatabaseSync(dbPath, {});
  try {
    run(dbPath, db);
  } finally {
    db.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('parseOpenCodeSessions', () => {
  it('records {input:0,output:0} assistants as zero-token data, not missing', () => {
    withStorage(
      { id: 'sess1', directory: '/Users/me/proj', time: { created: 1700000000000 } },
      [
        { id: 'm1', sessionID: 'sess1', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        // First assistant: tool-only continuation step with zeroed tokens
        {
          id: 'm2', sessionID: 'sess1', role: 'assistant', parentID: 'm1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 0, output: 0 },
        },
        { id: 'm3', sessionID: 'sess1', role: 'user', time: { created: 1700000003000 }, summary: { title: 'go on' } },
        // Second assistant: real tokens
        {
          id: 'm4', sessionID: 'sess1', role: 'assistant', parentID: 'm3',
          time: { created: 1700000004000, completed: 1700000005000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 1000, output: 50 },
        },
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        const reqs = sessions[0].requests;
        expect(reqs).toHaveLength(2);
        // The zero-token assistant should produce 0 tokens, NOT null/missing
        expect(reqs[0].promptTokens).toBe(0);
        expect(reqs[0].completionTokens).toBe(0);
        // Second assistant has real numbers
        expect(reqs[1].promptTokens).toBe(1000);
        expect(reqs[1].completionTokens).toBe(50);
      },
    );
  });

  it('marks a request as missing when the assistant message is absent entirely', () => {
    withStorage(
      { id: 'sess2', directory: '/Users/me/proj' },
      [
        { id: 'u1', sessionID: 'sess2', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        // No assistant message at all
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].requests[0].promptTokens).toBeNull();
        expect(sessions[0].requests[0].completionTokens).toBeNull();
      },
    );
  });

  it('stores the OpenCode session directory as workspaceRootPath', () => {
    // rawSession.directory is the project root. Surfacing it as
    // workspaceRootPath lets config-health / SDLC workspace scans resolve the
    // repo for OpenCode sessions, the same way the Codex parser already does.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-dir-test-'));
    withStorage(
      { id: 'sess-dir', directory: dir, time: { created: 1700000000000 } },
      [
        { id: 'u1', sessionID: 'sess-dir', role: 'user', time: { created: 1700000000000 }, summary: { title: 'hi' } },
        {
          id: 'a1', sessionID: 'sess-dir', role: 'assistant', parentID: 'u1',
          time: { created: 1700000001000, completed: 1700000002000 },
          modelID: 'claude-sonnet-4',
          tokens: { input: 100, output: 20 },
        },
      ],
      (storageDir) => {
        const sessions = parseOpenCodeSessions(storageDir);
        expect(sessions).toHaveLength(1);
        expect(sessions[0].workspaceRootPath).toBe(dir);
      },
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('parses current OpenCode SQLite session_message rows', () => {
    withSqliteDb((dbPath, db) => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sqlite-workspace-'));
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          slug TEXT,
          directory TEXT,
          path TEXT,
          title TEXT,
          version TEXT,
          agent TEXT,
          model TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          type TEXT,
          seq INTEGER,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
      `);
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses_sql',
        'proj_sql',
        'sql-slug',
        dir,
        null,
        'SQLite session',
        '1.17.7',
        'build',
        JSON.stringify({ id: 'claude-sonnet-4', providerID: 'anthropic', variant: 'high' }),
        1700000000000,
        1700000005000,
      );
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'msg_user',
        'ses_sql',
        'user',
        1,
        1700000000000,
        1700000000000,
        JSON.stringify({ text: 'implement feature', files: [], agents: [], time: { created: 1700000000000 } }),
      );
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'msg_assistant',
        'ses_sql',
        'assistant',
        2,
        1700000001000,
        1700000005000,
        JSON.stringify({
          agent: 'build',
          model: { id: 'claude-sonnet-4', providerID: 'anthropic', variant: 'high' },
          content: [
            { type: 'text', id: 'txt1', text: 'done' },
            {
              type: 'tool',
              id: 'tool1',
              name: 'write',
              state: {
                status: 'completed',
                input: { filePath: 'src/app.ts', content: 'export const answer = 42;' },
                outputPaths: ['src/app.ts'],
                content: [],
                structured: {},
                result: 'ok',
              },
              time: { created: 1700000002000, completed: 1700000004000 },
            },
          ],
          tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } },
          time: { created: 1700000001000, completed: 1700000005000 },
        }),
      );

      const sessions = parseOpenCodeSessions(dbPath);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].workspaceRootPath).toBe(dir);
      const req = sessions[0].requests[0];
      expect(req.messageText).toBe('implement feature');
      expect(req.modelId).toBe('claude-sonnet-4');
      expect(req.agentName).toBe('build');
      expect(req.promptTokens).toBe(112);
      expect(req.completionTokens).toBe(20);
      expect(req.cacheReadTokens).toBe(10);
      expect(req.cacheWriteTokens).toBe(2);
      expect(req.reasoningEffort).toBe('high');
      expect(req.toolsUsed).toEqual(['write']);
      expect(req.editedFiles).toEqual(['src/app.ts']);
      expect(req.aiCode.length).toBeGreaterThan(0);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  });

  it('parses legacy OpenCode SQLite message and part rows', () => {
    withSqliteDb((dbPath, db) => {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          slug TEXT,
          directory TEXT,
          title TEXT,
          version TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          session_id TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
      `);
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses_legacy',
        'proj_legacy',
        'legacy-slug',
        '/tmp/opencode-legacy',
        'Legacy session',
        '1.0.0',
        1700000000000,
        1700000003000,
      );
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        'msg_legacy_user',
        'ses_legacy',
        1700000000000,
        1700000000000,
        JSON.stringify({
          role: 'user',
          time: { created: 1700000000000 },
          summary: { title: 'read config' },
          agent: 'build',
          model: { providerID: 'anthropic', modelID: 'claude-sonnet-4', variant: 'low' },
        }),
      );
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        'msg_legacy_assistant',
        'ses_legacy',
        1700000001000,
        1700000003000,
        JSON.stringify({
          role: 'assistant',
          parentID: 'msg_legacy_user',
          time: { created: 1700000001000, completed: 1700000003000 },
          modelID: 'claude-sonnet-4',
          providerID: 'anthropic',
          agent: 'build',
          tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 4, write: 1 } },
        }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
        'part_text',
        'msg_legacy_assistant',
        'ses_legacy',
        1700000001000,
        1700000001000,
        JSON.stringify({ type: 'text', text: 'config read' }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
        'part_tool',
        'msg_legacy_assistant',
        'ses_legacy',
        1700000001000,
        1700000002000,
        JSON.stringify({ type: 'tool', tool: 'read', state: { status: 'completed', input: { filePath: 'opencode.json' }, output: '{}' } }),
      );

      const sessions = parseOpenCodeSessions(dbPath);
      expect(sessions).toHaveLength(1);
      const req = sessions[0].requests[0];
      expect(req.messageText).toBe('read config');
      expect(req.promptTokens).toBe(55);
      expect(req.completionTokens).toBe(5);
      expect(req.cacheReadTokens).toBe(4);
      expect(req.cacheWriteTokens).toBe(1);
      expect(req.referencedFiles).toEqual(['opencode.json']);
    });
  });

  it('falls back to legacy SQLite rows when session_message only has switch events', () => {
    withSqliteDb((dbPath, db) => {
      db.exec(`
        CREATE TABLE session (
          id TEXT PRIMARY KEY,
          project_id TEXT,
          slug TEXT,
          directory TEXT,
          title TEXT,
          version TEXT,
          time_created INTEGER,
          time_updated INTEGER
        );
        CREATE TABLE session_message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          type TEXT,
          seq INTEGER,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
        CREATE TABLE message (
          id TEXT PRIMARY KEY,
          session_id TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
        CREATE TABLE part (
          id TEXT PRIMARY KEY,
          message_id TEXT,
          session_id TEXT,
          time_created INTEGER,
          time_updated INTEGER,
          data TEXT
        );
      `);
      db.prepare('INSERT INTO session VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
        'ses_mixed',
        'proj_mixed',
        'mixed-slug',
        '/tmp/opencode-mixed',
        'Mixed session',
        '1.17.7',
        1700000000000,
        1700000003000,
      );
      db.prepare('INSERT INTO session_message VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        'msg_switch',
        'ses_mixed',
        'model-switched',
        1,
        1700000000000,
        1700000000000,
        JSON.stringify({ model: { id: 'gpt-5.5-fast', providerID: 'openai', variant: 'xhigh' }, time: { created: 1700000000000 } }),
      );
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        'msg_mixed_user',
        'ses_mixed',
        1700000001000,
        1700000001000,
        JSON.stringify({ role: 'user', time: { created: 1700000001000 }, summary: { title: 'use legacy rows' } }),
      );
      db.prepare('INSERT INTO message VALUES (?, ?, ?, ?, ?)').run(
        'msg_mixed_assistant',
        'ses_mixed',
        1700000002000,
        1700000003000,
        JSON.stringify({
          role: 'assistant',
          parentID: 'msg_mixed_user',
          time: { created: 1700000002000, completed: 1700000003000 },
          modelID: 'gpt-5.5-fast',
          providerID: 'openai',
          agent: 'build',
          tokens: { input: 70, output: 8, reasoning: 3, cache: { read: 6, write: 2 } },
        }),
      );
      db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?, ?)').run(
        'part_mixed_text',
        'msg_mixed_assistant',
        'ses_mixed',
        1700000002000,
        1700000003000,
        JSON.stringify({ type: 'text', text: 'legacy rows parsed' }),
      );

      const sessions = parseOpenCodeSessions(dbPath);
      expect(sessions).toHaveLength(1);
      const req = sessions[0].requests[0];
      expect(req.messageText).toBe('use legacy rows');
      expect(req.responseText).toBe('legacy rows parsed');
      expect(req.modelId).toBe('gpt-5.5-fast');
      expect(req.promptTokens).toBe(78);
      expect(req.completionTokens).toBe(8);
    });
  });
});

describe('findOpenCodeDirs', () => {
  it('discovers current database files, OPENCODE_DB, and legacy storage', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-find-test-'));
    const dataHome = path.join(root, 'xdg-data');
    const dataDir = path.join(dataHome, 'opencode');
    const storageDir = path.join(dataDir, 'storage');
    fs.mkdirSync(storageDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'opencode.db'), '', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'opencode-dev.db'), '', 'utf-8');
    fs.writeFileSync(path.join(dataDir, 'custom.db'), '', 'utf-8');

    const oldXdg = process.env.XDG_DATA_HOME;
    const oldHome = process.env.HOME;
    const oldUserProfile = process.env.USERPROFILE;
    const oldDb = process.env.OPENCODE_DB;
    process.env.XDG_DATA_HOME = dataHome;
    process.env.HOME = path.join(root, 'home');
    delete process.env.USERPROFILE;
    process.env.OPENCODE_DB = 'custom.db';
    try {
      const dirs = findOpenCodeDirs();
      expect(dirs).toContain(path.resolve(path.join(dataDir, 'opencode.db')));
      expect(dirs).toContain(path.resolve(path.join(dataDir, 'opencode-dev.db')));
      expect(dirs).toContain(path.resolve(path.join(dataDir, 'custom.db')));
      expect(dirs).toContain(path.resolve(storageDir));
    } finally {
      if (oldXdg == null) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = oldXdg;
      if (oldHome == null) delete process.env.HOME;
      else process.env.HOME = oldHome;
      if (oldUserProfile == null) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = oldUserProfile;
      if (oldDb == null) delete process.env.OPENCODE_DB;
      else process.env.OPENCODE_DB = oldDb;
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
