/*
 * gitx_mark: an agent says where the answer was - after a gitx_search, when it
 * found it with its own tools (Grep, a file) or in the answer - in as few
 * words as it can: { to: "server.js:321" }. Each target is checked to exist
 * and named the way learning keys it (walk-learn.js): code as file::function,
 * so it survives line shifts; a thought by its id; a commit by its short hash.
 *
 * The mark becomes a step on the agent's current walk (path-recorder.js), so
 * the question it answers is the last one the agent asked - nothing to
 * restate - and the next agent asking something like it is shown the target
 * first. A note goes with it, one sentence, shown beside the target to later
 * agents as theirs, not GitX's.
 *
 * Why: on ter-manager, 16 October, GitX landed questions in words on the
 * wrong code where an agent with Grep found the right function in one or two
 * tries, and nothing carried what that agent found to the next one: learning
 * credited what agents opened and read, never a Grep line, and every read the
 * same whether it was the answer or a wrong turn.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { buildCodeIndex, shortName } from './code-find.js';
import { NO_CONSOLE } from './no-console.js';

export const MARK_MAX = 8;          // targets in one mark
export const NOTE_MAX = 300;        // characters of a note

const entry = (r) => r.file + ' · ' + shortName(r) + ' ' + r.from + '-' + r.to;

function thoughtOf(repoDir, id) {
  for (const [dir, layer] of [['thoughts', 'thought'], [path.join('context', 'thoughts'), 'context']]) {
    try { const t = JSON.parse(fs.readFileSync(path.join(repoDir, '.gitx', dir, id + '.json'), 'utf8')); return { layer, text: String(t.text || '').slice(0, 160) }; } catch (_) { /* next */ }
  }
  return null;
}

function commitOf(repoDir, hash) {
  try {
    const [h, s] = execFileSync('git', ['log', '-1', '--format=%h%x09%s', hash + '^{commit}', '--'], { windowsHide: NO_CONSOLE, cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\t');
    return h ? { short: h.slice(0, 7), subject: String(s || '').slice(0, 160) } : null;
  } catch (_) { return null; }
}

/* One target to { key, layer, name } or { to, error }. Code is the function
 * holding a line (file:line), or named as an answer or find writes it
 * ("app.js · fontChoice", "app.js::fontChoice", "fontChoice"). */
function resolve(repoDir, cx, raw) {
  const to = String(raw || '').trim();
  if (!to) return { to, error: 'empty' };
  if (/^t-[0-9a-f]{10}$/.test(to)) {
    const t = thoughtOf(repoDir, to);
    return t ? { to, key: to, layer: t.layer, name: to + ' ' + t.text } : { to, error: 'no thought ' + to };
  }
  if (/^[0-9a-f]{7,40}$/.test(to)) {
    const c = commitOf(repoDir, to);
    if (c) return { to, key: c.short, layer: 'commit', name: c.short + ' ' + c.subject };
  }
  const code = cx.regions.filter((r) => r.kind !== 'doc');
  const ends = (file, hint) => file === hint || file.endsWith('/' + hint);
  const at = to.match(/^(.+?):(\d+)(?:-\d+)?$/);
  let hits;
  if (at && !at[1].includes('::')) hits = code.filter((r) => ends(r.file, at[1].replace(/\\/g, '/').replace(/^\.\//, '')) && Number(at[2]) >= r.from && Number(at[2]) <= r.to);
  else {
    const want = to.replace(/\s+\d+-\d+$/, '');
    const [file, name] = want.includes('::') ? want.split('::') : want.includes(' · ') ? want.split(' · ') : [null, want];
    hits = code.filter((r) => shortName(r) === name.trim() && (!file || ends(r.file, file.trim().replace(/\\/g, '/'))));
  }
  if (!hits.length) return { to, error: 'nothing at HEAD by that name or line - give file:line, or a function as find or the map writes it' };
  const r = hits[0];
  return { to, key: r.file + '::' + shortName(r), layer: 'code', name: entry(r), also: hits.length > 1 ? hits.slice(1, 4).map(entry) : undefined };
}

export function markTargets(repoDir, to, note) {
  const list = [].concat(to || []).slice(0, MARK_MAX);
  const cx = buildCodeIndex(repoDir);
  const out = list.map((x) => resolve(repoDir, cx, x));
  return {
    marked: out.filter((x) => x.key),
    rejected: out.filter((x) => x.error).map((x) => ({ to: x.to, why: x.error })),
    note: note ? String(note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) : undefined
  };
}
