/*
 * The thought layer: the reasoning behind commits, kept BESIDE the commit graph.
 *
 *   .gitx/thoughts/   the thought graph: what made each commit happen
 *   .gitx/drafts/     a batch still being written, any depth (a backfill
 *                     writes to drafts/backfill/ until it is done)
 *   .gitx/context/    the context graph: thoughts no commit has settled yet,
 *                     and the stashes - read only when an agent asks for it.
 *                     See docs/context-graph-plan.md.
 *
 * All of them are PRIVATE: the owner's own reasoning, git-ignored, never pushed. What
 * IS shared is the commit graph beside it - .gitx/commits - and
 * ensureGitignored in server.js is what draws that line in each repository.
 *
 * There used to be a third idea here: thoughts/ held CONFIRMED thoughts, and
 * confirming was the act of publishing one. That reason went when thoughts
 * became private whether confirmed or not, and confirming was redefined as the
 * owner reviewing a thought - which then went too, because thoughts are written
 * after a discussion is settled and agents edit them directly. Nothing reviews
 * them, so nothing is a draft awaiting review, and the word is gone rather than
 * redefined a third time. What a thought is worth is said by its PROVENANCE:
 * recorded at the time, or inferred later from a transcript.
 *
 * One file per thought, schema gitx.thought/0. The dependency runs one way: a
 * thought names the commits it was anchored at and led to, and nothing about a
 * commit, its message or the index changes because a thought exists. So this is
 * a reader only - it never writes, and it never feeds the commit index.
 *
 * It also carries the git topology the page needs to draw lanes. The commit
 * index deliberately holds no parents (it is keyed on messages and hunks), and
 * adding them there would change a shared artifact for one reader's sake - so
 * the parents come from one `git log` here instead.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { contextMap } from './topics.js';

const SCHEMA = 'gitx.thought/0';
const STASH_SCHEMA = 'gitx.stash/0';
const MAX_DEPTH = 3;          // drafts/<batch>/<file> is the deepest in use
const MAX_COMMITS = 600;      // same cap as the graph payload

export function thoughtDirs(repoDir) {
  return {
    thoughts: path.join(repoDir, '.gitx', 'thoughts'),
    drafts: path.join(repoDir, '.gitx', 'drafts'),
    stash: path.join(repoDir, '.gitx', 'stash'),
    /* The context graph. Every caller names the folders it reads, so these are
     * read by nothing until the context graph is wired in. */
    context: path.join(repoDir, '.gitx', 'context', 'thoughts'),
    contextStash: path.join(repoDir, '.gitx', 'context', 'stash')
  };
}

function jsonFiles(dir, depth = 0, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < MAX_DEPTH) jsonFiles(p, depth + 1, out);
    else if (e.isFile() && e.name.endsWith('.json')) out.push(p);
  }
  return out;
}

/* Every thought on disk. A file that is not a thought - not JSON, wrong schema,
 * no id, no anchor - is skipped rather than failing the whole layer, and SAID:
 * which file and why. A write in the wrong shape is the one mistake nothing
 * else can catch, because the thought never exists to be missed, so the skip is
 * reported rather than counted. Two files claiming one id is a collision: the
 * first read wins and the second is reported, because one id is one thought
 * wherever its file happens to sit.
 *
 * `store` picks the graph: 'thought' (the default - thoughts/ and drafts/) or
 * 'context' (context/thoughts/). Each is read on its own and neither ever
 * includes the other, so everything that reads the thought graph today reads
 * exactly what it read before the context graph existed. Only the watcher
 * reads both, because only it has to see a thought pass from one to the other. */
export function loadThoughts(repoDir, { store = 'thought' } = {}) {
  const dirs = thoughtDirs(repoDir);
  const folders = store === 'context' ? [dirs.context] : [dirs.thoughts, dirs.drafts];
  const stashDir = store === 'context' ? dirs.contextStash : dirs.stash;
  const byId = new Map();
  const claimed = new Map();                 // id -> the file that already holds it
  const unreadable = [];
  let newest = 0;
  const rel = (file) => path.relative(repoDir, file).replace(/\\/g, '/');
  /* Hashed on its contents, so an unreadable file edited and still wrong reads
   * as new; one that cannot be read at all is hashed on its name instead, which
   * keeps it from re-reporting on every pass. */
  const bad = (file, why, raw) => unreadable.push({
    file: rel(file), why,
    hash: crypto.createHash('sha256').update(raw === undefined ? file : raw).digest('hex').slice(0, 16)
  });

  for (const folder of folders) {
    for (const file of jsonFiles(folder)) {
      let raw;
      try {
        newest = Math.max(newest, fs.statSync(file).mtimeMs);
        raw = fs.readFileSync(file, 'utf8');
      } catch (_) { bad(file, 'the file could not be read'); continue; }

      let t;
      try { t = JSON.parse(raw); } catch (err) { bad(file, 'not valid JSON: ' + err.message, raw); continue; }
      if (!t || typeof t !== 'object' || Array.isArray(t)) { bad(file, 'not a JSON object', raw); continue; }
      if (t.schema !== SCHEMA) {
        bad(file, t.schema ? 'schema is "' + t.schema + '", not "' + SCHEMA + '"'
                           : 'no schema field - a thought needs "schema": "' + SCHEMA + '"', raw);
        continue;
      }
      if (!t.id) { bad(file, 'no id - a thought needs one of its own, like "t-1a2b3c4d5e"', raw); continue; }
      if (!t.anchor) { bad(file, 'no anchor - a thought needs anchor: { commit, patch_id }, the state it was thought at', raw); continue; }

      const held = claimed.get(t.id);
      if (held) {
        bad(file, 'id ' + t.id + ' is already held by ' + held.file + ' - this file is not being read', raw);
        continue;
      }
      claimed.set(t.id, { file: rel(file) });
      byId.set(t.id, t);
    }
  }

  const thoughts = [...byId.values()];
  /* The one grade a thought carries: said at the time, or reconstructed after
   * the fact from a transcript. The second is worth reading twice. */
  const inferred = thoughts.filter((t) => t.provenance === 'inferred').length;
  /* Stash files move the signature too, so the page refetches when one is
   * added or applied - they are only stat'ed here, and parsed by loadStashes. */
  let stashes = 0;
  for (const file of jsonFiles(stashDir, MAX_DEPTH)) {
    try { newest = Math.max(newest, fs.statSync(file).mtimeMs); stashes++; } catch (_) { /* gone meanwhile */ }
  }
  return {
    thoughts,
    /* Which file holds each thought, for a report that has to name one. Kept
     * out of stats: the broker sends stats with every state message. */
    fileOf: Object.fromEntries([...claimed].map(([id, c]) => [id, c.file])),
    stats: {
      count: thoughts.length,
      inferred,
      skipped: unreadable.length,
      unreadable,
      stashes,
      /* Cheap change detector for the page: it refetches only when this moves.
       * A skipped file counts, or deleting one would move nothing. */
      signature: thoughts.length + ':' + inferred + ':' + stashes + ':' + unreadable.length + ':' + Math.round(newest)
    }
  };
}

/* A stash sets thoughts aside for later: an idea not taken up now, kept so it
 * can be picked up again instead of rediscovered.
 *
 *   .gitx/stash/s-<id>.json   { schema: gitx.stash/0, id, title, note,
 *                               state: kept | applied, applied_to,
 *                               thoughts: [ids of this repo's stashed thoughts],
 *                               references: [{ repo, thought, commit, why }],
 *                               created, by }
 *
 * thoughts are the stash's OWN - thoughts in this repo with outcome
 * "stashed"; deleting a stash deletes them. references are only written
 * down: a thought or commit elsewhere, possibly in another repository, noted
 * for whoever picks the stash up. Nothing follows or checks them yet - linking
 * across repositories is itself a stashed idea - and removing a stash can
 * never touch what a reference names. Private, like the thoughts.
 *
 * `store` as in loadThoughts: the default reads .gitx/stash/, 'context' reads
 * .gitx/context/stash/, where the stashes move with the context graph. */
export function loadStashes(repoDir, { store = 'thought' } = {}) {
  const out = [];
  const dirs = thoughtDirs(repoDir);
  for (const file of jsonFiles(store === 'context' ? dirs.contextStash : dirs.stash, MAX_DEPTH)) {
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (s.schema !== STASH_SCHEMA || !s.id) continue;
      out.push({
        id: s.id, title: s.title || s.id, note: s.note || '', state: s.state === 'applied' ? 'applied' : 'kept',
        applied_to: s.applied_to || null, thoughts: Array.isArray(s.thoughts) ? s.thoughts : [],
        references: Array.isArray(s.references) ? s.references : [], created: s.created || null, by: s.by || null
      });
    } catch (_) { /* not a stash - skipped, like a bad thought file */ }
  }
  return out.sort((a, b) => String(b.created).localeCompare(String(a.created)));
}

/* How many commits HEAD has, so the page can number them #1..#N from the first
 * commit even when only the newest MAX_COMMITS are sent. */
export function commitCount(repoDir) {
  try {
    return Number(execFileSync('git', ['rev-list', '--count', 'HEAD'], {
      cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']
    }).trim()) || 0;
  } catch (_) { return 0; }
}

export function gitTopology(repoDir) {
  let raw = '';
  try {
    raw = execFileSync('git', ['log', '-n', String(MAX_COMMITS), '--format=%H%x1f%P%x1f%aI%x1f%s%x1e'], {
      cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_) { return []; }
  return raw.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
    const [hash, parents, date, subject] = r.split('\x1f');
    return { hash, parents: parents ? parents.split(' ') : [], date, subject };
  });
}

/* Lanes, the way a git graph assigns them: each lane is waiting for one hash.
 * A commit takes the lane that was waiting for it (the first one, if several
 * were - the rest end here), its first parent continues that lane, and every
 * other parent is given a lane of its own. Newest first, same order as git log. */
function assignLanes(commits) {
  const lanes = [];
  let width = 0;
  for (const c of commits) {
    let lane = lanes.indexOf(c.hash);
    if (lane === -1) {
      lane = lanes.indexOf(null);
      if (lane === -1) { lane = lanes.length; lanes.push(null); }
    }
    for (let i = 0; i < lanes.length; i++) if (i !== lane && lanes[i] === c.hash) lanes[i] = null;
    c.lane = lane;
    lanes[lane] = c.parents[0] || null;
    for (const p of c.parents.slice(1)) {
      if (lanes.includes(p)) continue;
      let j = lanes.indexOf(null);
      if (j === -1) { j = lanes.length; lanes.push(null); }
      lanes[j] = p;
    }
    width = Math.max(width, lanes.length);
  }
  return width;
}

const compact = (t) => ({
  id: t.id,
  kind: t.kind,
  text: t.text,
  outcome: t.outcome,
  decided_by: t.decided_by || null,
  anchor: t.anchor && t.anchor.commit,
  patch_id: (t.anchor && t.anchor.patch_id) || null,
  led_to: (t.resulted_in && t.resulted_in.commit) || null,
  branch: (t.anchor && t.anchor.branch) || null,
  parent: t.parent || null,
  session: t.session || null,
  links: t.links || [],
  forces: t.forces || [],
  applied_to: t.applied_to || null,
  provenance: t.provenance || null,
  at: (t.sources && t.sources[0] && t.sources[0].at) || t.created || null,
  sources: (t.sources || []).length
});

export function thoughtsPayload(repoDir) {
  const { thoughts, stats } = loadThoughts(repoDir);
  const commits = gitTopology(repoDir);
  const lanes = assignLanes(commits);
  return {
    repo: path.basename(repoDir),
    lanes,
    total: commitCount(repoDir) || commits.length,
    truncated: commits.length >= MAX_COMMITS,
    commits: commits.map((c) => ({ h: c.hash, p: c.parents, d: c.date, s: c.subject, lane: c.lane })),
    thoughts: thoughts.map(compact),
    stashes: loadStashes(repoDir),
    stats,
    /* The context graph, for the page's own view of it: never drawn on the
     * commit graph, and kept apart here so nothing that reads the thoughts
     * above can mistake a waiting thought for a settled one. */
    context: (() => {
      const c = loadThoughts(repoDir, { store: 'context' });
      /* Each waiting thought carries its topic and domain, and the map
       * carries the topics and the goal (tools/topics.js). */
      const map = contextMap(repoDir, c.thoughts);
      const where = new Map(map.placed.map((p) => [p.id, p]));
      const { placed, newest, ...rest } = map;
      return {
        thoughts: c.thoughts.map((t) => ({ ...compact(t), topic: where.get(t.id).topic, domain: where.get(t.id).domain })),
        stashes: loadStashes(repoDir, { store: 'context' }),
        stats: c.stats,
        map: rest
      };
    })()
  };
}

/* ─────────────────────────────────────────────── what became of a thought */

/* One rule for every reader - gitx_related, gitx_thought and catch-up - so two
 * tools never tell an agent different things about the same thought. They did:
 * gitx_thought called t-99e44e7b95 answered while gitx_related, the tool agents
 * are sent to first, still said OPEN QUESTION.
 *
 * A thought is never rewritten; what comes after it says what became of it.
 * `incoming` is every link pointing AT the thought, as { type, from };
 * `settledIn(id)` is the commit a thought was carried out in, or null.
 *
 *   superseded  a later thought supersedes it
 *   refined     a thought refining it is in a commit - for an open question
 *               that is the answer, built; for a decision still waiting it is
 *               the work carried on in a commit, though not this thought itself
 *
 * Refined only by thinking that is still waiting is no answer yet. */
export function laterOf(incoming, settledIn) {
  const sup = incoming.find((l) => l.type === 'supersedes');
  if (sup) return { how: 'superseded', by: sup.from, commit: settledIn(sup.from) || null };
  for (const l of incoming) {
    if (l.type !== 'refines') continue;
    const commit = settledIn(l.from);
    if (commit) return { how: 'refined', by: l.from, commit };
  }
  return null;
}

/* An open thought is a question only when it asks one. One that states
 * something - "Activation belongs to an agent and a task" - is a proposal
 * nobody confirmed, and calling it a question sends an agent to ask the owner
 * something that was never asked. */
export function asksQuestion(t) {
  return /\?\s*$/.test(String((t && t.text) || '').trim());
}
