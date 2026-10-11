#!/usr/bin/env node
/*
 * A Claude Code hook that tells GitX what the agent read (t-6d46b4df16), and
 * for thermal vision (4th Dimension v2) what it edited and what its final
 * answer cited.
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
 * Set it up as a PostToolUse hook on Read (and Edit, Write, MultiEdit), and
 * as a Stop hook, in .claude/settings.json:
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

const gitOut = (cwd, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/* The repository a path or folder is in, and the path inside it. */
function place(cwd, file) {
  let root;
  try { root = path.resolve(win(gitOut(cwd || path.dirname(file), ['rev-parse', '--show-toplevel']))); } catch (_) { return null; }
  const rel = file ? path.relative(root, file).replace(/\\/g, '/') : '';
  if (file && (!rel || rel.startsWith('..'))) return null;
  let head = null;
  try { head = gitOut(root, ['rev-parse', 'HEAD']); } catch (_) {}
  return { root, rel, head };
}
function append(data, sub, root, line) {
  const dir = path.join(data, sub);
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(path.join(dir, repoKey(root) + '.jsonl'), JSON.stringify(line) + '\n');
}

/* What a final answer cites: file:line or file:a-b, file::function, thought
 * ids. For thermal vision (4th Dimension v2) the strongest sign of what
 * answered the question is what the agent pointed at when it answered. */
function citations(text) {
  const refs = [], seen = new Set();
  const add = (r) => { const k = JSON.stringify(r); if (!seen.has(k)) { seen.add(k); refs.push(r); } };
  for (const m of text.matchAll(/([\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html|json))::([\w$.]+)/g)) add({ file: m[1], name: m[2] });
  for (const m of text.matchAll(/([\w./-]+\.(?:m?js|cjs|ts|tsx|py|css|html))[:#]L?(\d+)(?:-L?(\d+))?/g)) add({ file: m[1], line: Number(m[2]), to: m[3] ? Number(m[3]) : undefined });
  for (const m of text.matchAll(/\bt-[0-9a-f]{10}\b/g)) add({ id: m[0] });
  return refs.slice(0, 40);
}
function lastAnswer(transcript) {
  let text = '';
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    let m; try { m = JSON.parse(l); } catch (_) { continue; }
    if (m.type !== 'assistant' || !m.message || !Array.isArray(m.message.content)) continue;
    const t = m.message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    if (t.trim()) text = t;
  }
  return text;
}

async function main() {
  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  const e = JSON.parse(input);
  const data = dataDir();
  if (!data) return;
  const at = new Date().toISOString(), session = e.session_id || null;

  /* The answer the agent gave, by what it cited. */
  if (e.hook_event_name === 'Stop') {
    if (!e.transcript_path) return;
    const p = place(e.cwd, null);
    if (!p) return;
    const refs = citations(lastAnswer(e.transcript_path));
    if (refs.length) append(data, 'thermal', p.root, { at, session, kind: 'cite', repo: p.root, head: p.head, refs });
    return;
  }

  const file = path.resolve(win(e.tool_input && e.tool_input.file_path));
  if (!file) return;
  const p = place(e.cwd, file);
  if (!p) return;

  /* What the agent changed, by the lines its new text now sits on. */
  if (['Edit', 'Write', 'MultiEdit'].includes(e.tool_name)) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch (_) { return; }
    const pieces = e.tool_name === 'Write' ? [text] : e.tool_name === 'MultiEdit' ? (e.tool_input.edits || []).map((x) => x.new_string) : [e.tool_input.new_string];
    for (const piece of pieces) {
      if (!piece) continue;
      const i = text.indexOf(piece);
      if (i < 0) continue;
      const from = text.slice(0, i).split('\n').length;
      append(data, 'thermal', p.root, { at, session, kind: 'edit', repo: p.root, head: p.head, file: p.rel, from, to: from + piece.split('\n').length - 1 });
    }
    return;
  }

  if (e.tool_name !== 'Read') return;
  const offset = Number(e.tool_input.offset) || 0;
  const limit = Number(e.tool_input.limit) || 0;
  const thought = /(?:^|\/)\.gitx\/(?:context\/)?thoughts\/(t-[0-9a-f]+)\.json$/.exec(p.rel);
  append(data, 'reads', p.root, {
    at, session, repo: p.root, head: p.head, file: p.rel,
    from: offset ? offset : null,
    to: offset && limit ? offset + limit - 1 : null,
    thought: thought ? thought[1] : undefined
  });
}

main().catch(() => {}).finally(() => process.exit(0));
