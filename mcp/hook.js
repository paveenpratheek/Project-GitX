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
 * Antigravity (agy) is read too: its hooks send camelCase - toolCall,
 * conversationId, workspacePaths, transcriptPath - with its own tools
 * (view_file, write_to_file, replace_file_content, multi_replace_file_content),
 * run synchronously, and expect JSON back, so every run prints {}. Set it up
 * in ~/.gemini/config/hooks.json on PostToolUse for those four tools and on
 * Stop.
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
/* agy's tool arguments may arrive JSON-encoded ("\"e:\\\\x\""), as in its transcripts. */
const unq = (v) => { if (typeof v === 'string' && /^"[\s\S]*"$/.test(v)) { try { return JSON.parse(v); } catch (_) {} } return v; };

/* An agy hook event in the shape the rest of this file reads. */
const AGY_TOOLS = { view_file: 'Read', write_to_file: 'Write', replace_file_content: 'Edit', multi_replace_file_content: 'MultiEdit' };
function fromAgy(e) {
  const base = { session_id: e.conversationId || null, cwd: (e.workspacePaths || [])[0] || null, transcript_path: e.transcriptPath || null, agy: true };
  if (e.terminationReason !== undefined || e.executionNum !== undefined) return { ...base, hook_event_name: 'Stop' };
  const call = e.toolCall || {}, a = call.args || {};
  const tool = AGY_TOOLS[call.name];
  if (!tool) return { ...base, hook_event_name: 'PostToolUse', tool_name: call.name };
  const file = unq(a.AbsolutePath || a.TargetFile);
  const input = { file_path: file };
  if (tool === 'Read') { const from = Number(unq(a.StartLine)) || 0, to = Number(unq(a.EndLine)) || 0; if (from) { input.offset = from; if (to >= from) input.limit = to - from + 1; } }
  if (tool === 'Write') input.content = unq(a.CodeContent);
  if (tool === 'Edit') input.new_string = unq(a.ReplacementContent);
  if (tool === 'MultiEdit') { let chunks = unq(a.ReplacementChunks); if (typeof chunks === 'string') { try { chunks = JSON.parse(chunks); } catch (_) { chunks = []; } } input.edits = (chunks || []).map((c) => ({ new_string: unq(c.ReplacementContent) })); }
  return { ...base, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: input };
}

/* agy's transcript: one step a line; the answer is the model's last
 * PLANNER_RESPONSE with content. */
function lastAgyAnswer(transcript) {
  let text = '';
  for (const l of fs.readFileSync(transcript, 'utf8').split('\n')) {
    let m; try { m = JSON.parse(l); } catch (_) { continue; }
    if (m.source === 'MODEL' && m.type === 'PLANNER_RESPONSE' && typeof m.content === 'string' && m.content.trim()) text = m.content;
  }
  return text;
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
  const raw = JSON.parse(input);
  const e = raw.toolCall || raw.conversationId ? fromAgy(raw) : raw;
  const data = dataDir();
  if (!data) return;
  const at = new Date().toISOString(), session = e.session_id || null;

  /* The answer the agent gave, by what it cited. */
  if (e.hook_event_name === 'Stop') {
    /* Claude Code hands the answer over as last_assistant_message; the
     * transcript is the fallback, and with --no-session-persistence it is
     * never written - every headless run's answer was lost (scan bench,
     * 18 October). */
    const given = typeof raw.last_assistant_message === 'string' ? raw.last_assistant_message : '';
    if (!given.trim() && !e.transcript_path) return;
    const p = place(e.cwd, null);
    if (!p) return;
    /* Setup mode: not done until the repository is covered - the agent is
     * sent back with the next biggest unmarked functions (tools/marks.js
     * setupNext), for a bounded number of rounds. Claude Code only. */
    if (!e.agy) {
      try {
        const { setupNext } = await import('./tools/marks.js');
        const reason = setupNext(p.root, data);
        if (reason) return { decision: 'block', reason };
      } catch (_) { /* never stops the agent from stopping */ }
    }
    let answer = given;
    if (!answer.trim()) { try { answer = e.agy ? lastAgyAnswer(e.transcript_path) : lastAnswer(e.transcript_path); } catch (_) { return; } }
    const refs = citations(answer);
    if (refs.length) append(data, 'thermal', p.root, { at, session, kind: 'cite', repo: p.root, head: p.head, refs });
    /* A scan's answer is the agent's notes, each on the code it names; so is
     * what an answer says about code this session changed, in a repository
     * not yet GitX-ready; any other answer's citations the last GitX search
     * had not shown become cited marks on that code (tools/marks.js). */
    try {
      const { marksFromAnswer, marksFromCitations } = await import('./tools/marks.js');
      let edits = [];
      try {
        edits = fs.readFileSync(path.join(data, 'thermal', repoKey(p.root) + '.jsonl'), 'utf8').split('\n')
          .map((l) => { try { return JSON.parse(l); } catch (_) { return null; } })
          .filter((x) => x && x.kind === 'edit' && session && x.session === session);
      } catch (_) { /* no edits recorded */ }
      const noted = marksFromAnswer(p.root, data, answer, { by: session, edits });
      if (!noted.made && refs.length) await marksFromCitations(p.root, data, refs, { by: session });
    } catch (_) { /* never stops the agent */ }
    return;
  }

  const file = path.resolve(win(e.tool_input && e.tool_input.file_path));
  if (!file) return;
  const p = place(e.cwd, file);
  if (!p) return;

  /* What the agent changed, by the lines its new text now sits on. */
  if (['Edit', 'Write', 'MultiEdit'].includes(e.tool_name)) {
    let text = '';
    /* Line endings as one: an Edit's new text comes in LF, and a file checked
     * out with CRLF on Windows never contained it - every edit to file-
     * fabric's script.js went unrecorded (code bench, 18 October). Lines are
     * counted the same either way. */
    const lf = (s) => String(s || '').replace(/\r\n/g, '\n');
    try { text = lf(fs.readFileSync(file, 'utf8')); } catch (_) { return; }
    const pieces = (e.tool_name === 'Write' ? [text] : e.tool_name === 'MultiEdit' ? (e.tool_input.edits || []).map((x) => x.new_string) : [e.tool_input.new_string]).map(lf);
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

/* agy runs hooks in line and wants JSON back; Claude Code reads it only for
 * a decision - setup mode's "block" at Stop, which sends the agent back. */
let said = null;
main().then((r) => { said = r || null; }).catch(() => {}).finally(() => { process.stdout.write(JSON.stringify(said || {}) + '\n'); process.exit(0); });
