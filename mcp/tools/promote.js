/*
 * Promotion: a thought leaves the context graph for the thought graph when a
 * commit settles it - step 5 of docs/context-graph-plan.md.
 *
 * A commit names the thoughts it settles in a trailer:
 *
 *     GitX-Thoughts: t-2be9f7be8d, t-85e4de1676
 *
 * The broker calls promotePending() whenever it re-reads git - at start, on a
 * repository switch, and when HEAD moves from anywhere (Source Control, the
 * command line, gitx_commit_chronicle). It scans the recent history for that
 * trailer and promotes every named thought still waiting in the context graph.
 * Scanning rather than reacting to one commit is deliberate: a commit made
 * while the broker was down is still found, and running it twice changes
 * nothing, because a promoted thought is no longer in the context graph.
 *
 * WHAT MOVES follows the migration's directional rule (migrate-context.js).
 * A named accepted decision or cost gets resulted_in set to the commit. From
 * it, the thoughts that made it happen come along: the evidence it cites, what
 * it supersedes, refines or derives from, and what was weighed against it
 * (lost-to, cost-of, supports pointing at it). A brought decision or cost was
 * carried out by the same commit, so it gets the same resulted_in. A later
 * thought that only points back stays waiting - it is not settled.
 *
 * A named thought that is not a decision or cost - a finding, a rejection, an
 * open question - moves only if a promoted decision reaches it; otherwise it
 * is left where it is and reported, because putting it in the thought graph
 * with nothing it made happen would recreate the wanderer this whole plan
 * exists to remove. A named id that is nowhere is reported, never ignored.
 *
 * HOW. Content first, then the rename: resulted_in is written to the file in
 * the context graph, then the file is renamed across. A crash between the two
 * leaves a waiting thought that already knows its commit - the next scan
 * finishes the move - never a thought-graph thought with no commit. The rename
 * is what makes the watcher log one "moved" entry.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadThoughts, thoughtDirs } from './thoughts.js';
import { parseMessage } from './git-extract.js';

const SCAN = 50;                                                   // recent commits read for the trailer
const WEIGHED_AGAINST_IT = ['lost-to', 'cost-of', 'supports'];
const ITS_OWN_HISTORY = ['supersedes', 'refines', 'derived-from'];
const REC = '\x1e', FLD = '\x1f';

const git = (repoDir, args, input) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] });
const leads = (t) => t.outcome === 'accepted' && (t.kind === 'decision' || t.kind === 'cost');

/* The recent commits that name thoughts, newest first. */
export function commitsNamingThoughts(repoDir, limit = SCAN) {
  let raw = '';
  try { raw = git(repoDir, ['log', '-n', String(limit), '--format=' + REC + '%H' + FLD + '%s' + FLD + '%B']); } catch (_) { return []; }
  return raw.split(REC).filter(Boolean).map((rec) => {
    const [hash, subject, body] = rec.split(FLD);
    return { hash: hash.trim(), subject, ids: parseMessage(subject, body).thoughts };
  }).filter((c) => c.ids.length);
}

/* Settle the named thoughts into the thought graph under one commit. */
export function promote(repoDir, commit, named) {
  const dirs = thoughtDirs(repoDir);
  const ctx = loadThoughts(repoDir, { store: 'context' });
  const graph = loadThoughts(repoDir);
  const inCtx = new Map(ctx.thoughts.map((t) => [t.id, t]));
  const inGraph = new Map(graph.thoughts.map((t) => [t.id, t]));
  const out = { commit: commit.slice(0, 7), promoted: [], brought: [], already: [], missing: [], not_settled: [] };

  const moving = new Map();          // id -> why
  for (const id of named) {
    if (inGraph.has(id)) out.already.push(id);
    else if (!inCtx.has(id)) out.missing.push(id);
    else if (leads(inCtx.get(id))) moving.set(id, 'named');
  }

  /* Directional closure, inside the context graph only. */
  const linkedIn = new Map();
  for (const t of ctx.thoughts) for (const l of t.links || []) {
    if (!linkedIn.has(l.to)) linkedIn.set(l.to, []);
    linkedIn.get(l.to).push({ from: t.id, type: l.type });
  }
  const queue = [...moving.keys()];
  while (queue.length) {
    const t = inCtx.get(queue.shift());
    const next = [
      ...(t.forces || []).flatMap((f) => f.cites || []),
      ...(t.links || []).filter((l) => ITS_OWN_HISTORY.includes(l.type)).map((l) => l.to),
      ...(linkedIn.get(t.id) || []).filter((l) => WEIGHED_AGAINST_IT.includes(l.type)).map((l) => l.from)
    ];
    for (const id of next) if (inCtx.has(id) && !moving.has(id)) { moving.set(id, 'brought'); queue.push(id); }
  }
  for (const id of named) if (inCtx.has(id) && !moving.has(id)) out.not_settled.push(id);
  if (!moving.size) return out;

  let patchId = null;
  try { patchId = git(repoDir, ['patch-id', '--stable'], git(repoDir, ['show', '--format=', commit]) + '\n').split(' ')[0] || null; } catch (_) { /* a merge or an empty commit has none */ }

  /* A thought's parent stays in its own graph: the nearest ancestor that is,
   * or will be, in the thought graph - walked through both. */
  const staysIn = (id) => inGraph.has(id) || moving.has(id);
  const any = (id) => inGraph.get(id) || inCtx.get(id);
  fs.mkdirSync(dirs.thoughts, { recursive: true });
  for (const [id, why] of moving) {
    const t = { ...inCtx.get(id) };
    if (leads(t)) t.resulted_in = { commit, patch_id: patchId };
    if (t.parent && !staysIn(t.parent)) {
      let p = t.parent;
      const seen = new Set();
      while (p && !staysIn(p) && any(p) && !seen.has(p)) { seen.add(p); p = any(p).parent || null; }
      if (!t.was_parent) t.was_parent = t.parent;
      t.parent = p && staysIn(p) ? p : null;
    }
    const from = path.join(repoDir, ctx.fileOf[id]);
    const to = path.join(dirs.thoughts, id + '.json');
    /* The broker and gitx_commit_chronicle both promote; whichever comes
     * second finds the thought already across and has nothing to do. */
    if (!fs.existsSync(from) && fs.existsSync(to)) { out.already.push(id); continue; }
    fs.writeFileSync(from, JSON.stringify(t, null, 2) + '\n');
    fs.renameSync(from, to);
    (why === 'named' ? out.promoted : out.brought).push(id);
  }
  return out;
}

/* Everything the recent history has named and the context graph still holds,
 * oldest commit first, so a thought named twice is settled by the first. */
export function promotePending(repoDir, { limit = SCAN } = {}) {
  const waiting = new Set(loadThoughts(repoDir, { store: 'context' }).thoughts.map((t) => t.id));
  let head = null;
  try { head = git(repoDir, ['rev-parse', 'HEAD']).trim(); } catch (_) { /* no commits */ }
  const results = [];
  for (const c of commitsNamingThoughts(repoDir, limit).reverse()) {
    if (!c.ids.some((id) => waiting.has(id))) continue;
    const r = promote(repoDir, c.hash, c.ids);
    for (const id of [...r.promoted, ...r.brought]) waiting.delete(id);
    /* A named thought that could not be settled stays waiting, so every later
     * scan meets it again. Said when it is news - the commit at HEAD, or one
     * that moved something - and not again on every look at git after that. */
    if (r.promoted.length || r.brought.length || c.hash === head) results.push({ ...r, subject: c.subject });
  }
  return results;
}

/* One line per commit that moved something or had something to say. */
export function describe(r) {
  const parts = [];
  if (r.promoted.length) parts.push('settled ' + r.promoted.join(', '));
  if (r.brought.length) parts.push('with ' + r.brought.length + ' that made it happen');
  if (r.not_settled.length) parts.push('left waiting (not a decision nothing promoted reaches): ' + r.not_settled.join(', '));
  if (r.missing.length) parts.push('named but on record nowhere: ' + r.missing.join(', '));
  return r.commit + ' ' + (parts.join('; ') || 'nothing to do');
}

/* Command line, for a commit that settled thoughts without naming them:
 *   node mcp/tools/promote.js <repo> <commit> <t-id> [<t-id> ...]
 *   node mcp/tools/promote.js <repo>                 scan, as the broker does */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, commit, ...ids] = process.argv.slice(2);
  if (!repo) { console.error('usage: node mcp/tools/promote.js <repo> [<commit> <t-id> ...]'); process.exit(2); }
  const dir = path.resolve(repo);
  try {
    if (commit) {
      const hash = git(dir, ['rev-parse', '--verify', commit + '^{commit}']).trim();
      console.log(describe(promote(dir, hash, ids)));
    } else {
      const results = promotePending(dir);
      console.log(results.length ? results.map(describe).join('\n') : 'nothing waiting that a recent commit names');
    }
  } catch (err) { console.error(err.message); process.exit(1); }
}
