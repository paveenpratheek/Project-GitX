#!/usr/bin/env node
/*
 * A Claude Code hook that tells GitX what the agent read (t-6d46b4df16).
 *
 * The learner learns from what agents use, and saw only what they opened
 * through GitX - a thought by id, a function expanded. Most answers are found
 * by reading files: in the learning rounds on the held-out questions, the
 * agents that found their answer mostly found it with Read, and the walk GitX
 * recorded said nothing was used. This hook closes that gap: after every Read
 * it appends one line - which repository, which file, which lines, or which
 * thought - to <data folder>/reads/<repository key>.jsonl, and walk-learn.js
 * counts a read like an open for the walk it happened in.
 *
 * Set it up as a PostToolUse hook on Read, in .claude/settings.json:
 *
 *   { "hooks": { "PostToolUse": [ { "matcher": "Read", "hooks": [ { "type": "command",
 *       "command": "node \"<GitX>/mcp/hook.js\"", "async": true } ] } ] } }
 *
 * The data folder is --data <dir> if given, else GITX_DATA_DIR, else the one
 * in GitX's .gitx/local.json - where the MCP server's recorder writes walks,
 * so reads land beside the walks they belong to. It never stops the agent:
 * every failure is swallowed and it always exits 0, and run async it does
 * not hold up the next turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { repoKey } from './tools/path-recorder.js';
import { NO_CONSOLE } from './tools/no-console.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function dataDir() {
  const i = process.argv.indexOf('--data');
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  if (process.env.GITX_DATA_DIR) return process.env.GITX_DATA_DIR;
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '.gitx', 'local.json'), 'utf8')).dataDir || null; } catch (_) { return null; }
}

/* Git Bash hands C:\ over as /c/ when a path came through it. */
const win = (p) => String(p || '').replace(/^\/([a-z])\//i, (_, d) => d + ':/');

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const e = JSON.parse(input);
  if (e.tool_name !== 'Read') return;
  const data = dataDir();
  const file = path.resolve(win(e.tool_input && e.tool_input.file_path));
  if (!data || !file) return;
  let root;
  try { root = execFileSync('git', ['rev-parse', '--show-toplevel'], { windowsHide: NO_CONSOLE, cwd: e.cwd || path.dirname(file), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch (_) { return; }
  root = path.resolve(win(root));
  const rel = path.relative(root, file).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..')) return;
  const offset = Number(e.tool_input.offset) || 0;
  const limit = Number(e.tool_input.limit) || 0;
  const thought = /(?:^|\/)\.gitx\/(?:context\/)?thoughts\/(t-[0-9a-f]+)\.json$/.exec(rel);
  const line = {
    at: new Date().toISOString(),
    session: e.session_id || null,
    repo: root,
    file: rel,
    from: offset ? offset : null,
    to: offset && limit ? offset + limit - 1 : null,
    thought: thought ? thought[1] : undefined
  };
  const dir = path.join(data, 'reads');
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, repoKey(root) + '.jsonl'), JSON.stringify(line) + '\n');
}

main().catch(() => {}).finally(() => process.exit(0));
