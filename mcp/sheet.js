#!/usr/bin/env node
/*
 * The cheat sheet (t-5c19e1b475), first part: GitX introduced to the agent
 * on its prompt, as a short note beside it - what GitX is, why it is the
 * shorter path, and how to call its search and stack.
 *
 * Asked by hand, agents treated GitX as one more tool beside grep and
 * searched both ways: 41 of 45 file calls in a subjects run were the agent's
 * own parallel search, at three times the tokens of GitX alone and no more
 * found (14 October). Nothing reached the agent before its first call that
 * said GitX already holds the record. Later parts of the sheet - where the
 * agent stands, what it owes, writing and committing thoughts - come once
 * this one is measured.
 *
 * A Claude Code hook: UserPromptSubmit (and SessionStart). Reads the event on
 * stdin, writes { hookSpecificOutput: { additionalContext } } on stdout.
 * Fails open: anything wrong, slow or missing prints {} and the agent works
 * as it would have. --subjects gives the by-subject form of the call.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const BY_SUBJECT = process.argv.includes('--subjects');
const out = (o) => { process.stdout.write(JSON.stringify(o)); process.exit(0); };
/* Fail open: never hold the agent's prompt for long. */
setTimeout(() => out({}), 8000).unref();

let event = {};
try { event = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch (_) { out({}); }
const name = event.hook_event_name || 'UserPromptSubmit';
const cwd = event.cwd || process.cwd();

function repoOf(dir) {
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch (_) { return null; }
}

/* The subject list is the project's own, and building it reads the whole
 * record (~1.5 s), so it is kept per HEAD and thought count. */
async function subjectsLine(repo) {
  let head = '', n = 0;
  try { head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }).trim(); } catch (_) {}
  for (const d of ['.gitx/thoughts', '.gitx/context/thoughts', '.gitx/context/topics']) { try { n += fs.readdirSync(path.join(repo, d)).length; } catch (_) {} }
  const key = crypto.createHash('sha1').update(path.resolve(repo) + ':' + head + ':' + n).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), 'gitx-sheet-' + key + '.txt');
  try { return fs.readFileSync(file, 'utf8'); } catch (_) { /* build it */ }
  const { lensModel } = await import('./lens/lens.js');
  const { menuOf } = await import('./lens/subjects.js');
  const menu = menuOf(lensModel(repo));
  const line = menu.map((e) => e.name + (e.also && e.also.length ? ' (also ' + e.also.slice(0, 2).join(', ') + ')' : '')).join('; ');
  try { fs.writeFileSync(file, line); } catch (_) { /* used once, not kept */ }
  return line;
}

async function sheet() {
  const repo = repoOf(cwd);
  if (!repo || !fs.existsSync(path.join(repo, '.gitx'))) return null;
  const subjects = BY_SUBJECT ? await subjectsLine(repo) : null;
  return [
    'GitX cheat sheet - this project has GitX, its memory, one tool call away.',
    'What it holds: the project\'s whole record linked into one stack - the code by function, every commit and why it was made, and the reasoning behind them: decisions, rejected ideas and what held them back, constraints, rules, open questions.',
    'Why first: one GitX call returns what would take many greps, file reads and git log calls - the code that implements a subject, the commits that wrote it and the decisions behind them, already joined. It is the shorter path; reach for files when GitX points you to them or has nothing.',
    BY_SUBJECT
      ? 'Search: gitx_search {"subjects": [...], "lens": ["what"|"how"|"where"|"when"|"why"], "include": ["decided","rejected","constraint","rule","open"], "effort": "brief"|"normal"|"deep"} - several subjects in one call also give where they meet. Subjects here: ' + subjects + '.'
      : 'Search: gitx_search {"query": "<the subject in a few words>", "lens": ["what"|"how"|"where"|"when"|"why"], "include": ["decided","rejected","constraint","rule","open"], "effort": "brief"|"normal"|"deep"}.',
    'Exact lookups: ' + (BY_SUBJECT ? 'gitx_find' : 'gitx_search') + ' {"find": "a name, value or /regex/"} or {"expand": "a function from an answer"}. A thought by id: gitx_thought {"id": "t-..."}.',
    'GitX returns what is recorded; you decide. Cite what it shows by id: t-..., commit hashes, file::function.'
  ].join('\n');
}

sheet().then((text) => out(text ? { hookSpecificOutput: { hookEventName: name, additionalContext: text } } : {})).catch(() => out({}));
