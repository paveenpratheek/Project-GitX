/*
 * Reading the thought layer from an agent's side: gitx_thought_search and
 * gitx_thought_catch_up.
 *
 * The graph tools answer "what happened and why, as the commits tell it".
 * These answer the part commits never carry: what was weighed and turned
 * down, what is still undecided, what was put aside for later, and what was
 * learned from a mistake. Same budget rule as the graph tools - small answers
 * an agent can drill into, never the whole layer at once.
 *
 * ABSENCE IS AN ANSWER. "No thinking was saved for this commit" is a fact an
 * agent must be able to state, and it is a different fact from "no thought
 * matched your words" or "this repository records no thoughts at all". Each
 * empty result says which of those it is, so an agent never reads an empty
 * list as "nothing was considered".
 *
 * Read-only, like every reader in this folder: nothing here writes a thought,
 * a commit or a file. Thoughts are private to the repository's owner (see
 * thoughts.js), and these tools only ever read the owner's own clone.
 */

import { execFileSync } from 'node:child_process';
import { loadThoughts, loadStashes, gitTopology, commitCount } from './thoughts.js';
import { tokenize } from './git-extract.js';

const SEARCH_LIMIT = 15;
const SEARCH_MAX = 50;
const TEXT_CAP = 200;
const RECENT_DEFAULT = 5;

const cap = (s, n = TEXT_CAP) => (!s || s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');
const lowerFirst = (s) => s.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase());

/* ─────────────────────────────────────────────── one pass over everything */

function context(repoDir) {
  const { thoughts, stats } = loadThoughts(repoDir);
  const commits = gitTopology(repoDir);                     // newest first
  const total = commitCount(repoDir) || commits.length;
  const at = new Map(commits.map((c, i) => [c.hash, i]));
  const byId = new Map(thoughts.map((t) => [t.id, t]));

  /* The page's grouping, so an agent and a person looking at the graph see the
   * same thought under the same commit. A group is everything anchored at one
   * commit; its led_to is the one its accepted thoughts share, so a rejected
   * alternative sits with the choice that beat it. None at all means thinking
   * that has not produced a commit yet. */
  const byAnchor = new Map();
  for (const t of thoughts) push(byAnchor, t.anchor && t.anchor.commit, t);
  for (const list of byAnchor.values()) {
    const votes = new Map();
    for (const t of list) if (t.resulted_in) votes.set(t.resulted_in.commit, (votes.get(t.resulted_in.commit) || 0) + 1);
    const shared = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
    for (const t of list) t._behind = (t.resulted_in && t.resulted_in.commit) || (shared && shared[0]) || null;
  }

  const incoming = new Map();
  for (const t of thoughts) {
    for (const l of t.links || []) push(incoming, l.to, { type: l.type, from: t.id });
    if (t.applied_to) push(incoming, t.applied_to, { type: 'applied-from', from: t.id });
  }

  const ref = (h) => {
    if (!h) return undefined;
    if (h === 'genesis') return 'before the first commit';
    if (!at.has(h)) return h.slice(0, 7) + ' (not in the history read)';
    const c = commits[at.get(h)];
    return `#${total - at.get(h)} ${h.slice(0, 7)} ${cap(c.subject, 90)}`;
  };
  /* Newer first. A thought's place in time is the commit it led to, or failing
   * that the commit it started from. */
  const recency = (t) => {
    const h = t._behind || (t.anchor && t.anchor.commit);
    return at.has(h) ? at.get(h) : Number.MAX_SAFE_INTEGER;
  };

  const stashes = loadStashes(repoDir);
  const stashOf = new Map();
  for (const s of stashes) for (const id of s.thoughts) stashOf.set(id, s);

  return { thoughts, stats, commits, total, at, byId, incoming, ref, recency, stashes, stashOf };
}

function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

function reopenable(t) {
  return t.outcome === 'rejected' && (t.forces || []).some((f) =>
    f.direction === 'backward' && f.kind === 'contingent' && f.revisit_if && !f.superseded_by);
}

/* How much weight a thought can bear, in one phrase: was it said at the time
 * or pieced together later, and has its owner checked it. */
const standing = (t) => `${t.provenance === 'inferred' ? 'inferred later' : 'recorded at the time'}, ${t.confirmed ? 'confirmed by the owner' : 'unconfirmed draft'}`;

/* ─────────────────────────────────────────────── shapes */

function brief(ctx, t) {
  const forward = (t.forces || []).filter((f) => f.direction === 'forward').map((f) => cap(f.text));
  const back = (t.forces || []).filter((f) => f.direction === 'backward').map((f) => ({
    kind: f.kind || undefined, why: cap(f.text), revisit_if: f.revisit_if || undefined
  }));
  const out = {
    id: t.id,
    kind: t.kind,
    outcome: t.outcome,
    status: reopenable(t) ? 'reopenable - held back only by something that can change' : undefined,
    text: t.text,
    decided_by: t.decided_by || undefined,
    behind: t._behind ? ctx.ref(t._behind) : undefined,
    since: t._behind ? undefined : ctx.ref(t.anchor && t.anchor.commit),
    why: forward.length ? forward.slice(0, 2) : undefined,
    held_back_by: back.length ? back : undefined,
    links: (t.links || []).length ? t.links.map((l) => {
      const o = ctx.byId.get(l.to);
      return { type: l.type, to: l.to, text: o ? cap(o.text, 110) : '(not on record)' };
    }) : undefined,
    standing: standing(t)
  };
  return prune(out);
}

function full(ctx, t) {
  const inc = (ctx.incoming.get(t.id) || []).map((l) => {
    const o = ctx.byId.get(l.from);
    return { type: l.type, from: l.from, text: o ? cap(o.text, 140) : '(not on record)' };
  });
  return prune({
    ...brief(ctx, t),
    why: undefined,
    held_back_by: undefined,
    forces: (t.forces || []).map((f) => prune({
      direction: f.direction, kind: f.kind || undefined, text: f.text,
      revisit_if: f.revisit_if || undefined, no_longer_holds: f.superseded_by ? 'superseded by ' + f.superseded_by : undefined
    })),
    linked_from: inc.length ? inc : undefined,
    applied_to: t.applied_to || undefined,
    in_stash: ctx.stashOf.has(t.id) ? { id: ctx.stashOf.get(t.id).id, title: ctx.stashOf.get(t.id).title, state: ctx.stashOf.get(t.id).state } : undefined,
    anchored_at: ctx.ref(t.anchor && t.anchor.commit),
    patch_id: t.anchor && t.anchor.patch_id ? t.anchor.patch_id.slice(0, 12) : undefined,
    led_to: t.resulted_in ? ctx.ref(t.resulted_in.commit) : (t.outcome === 'rejected' ? 'no commit - rejected' : undefined),
    parent: t.parent || undefined,
    session: t.session || undefined,
    said_at: (t.sources && t.sources[0] && t.sources[0].at) || undefined,
    sources: t.sources ? t.sources.length : 0
  });
}

function prune(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}

/* ─────────────────────────────────────────────── search */

function resolveCommit(ctx, ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(r)) return { error: 'Give a commit hash (at least 4 hex characters).' };
  const hits = ctx.commits.filter((c) => c.hash.startsWith(r));
  if (!hits.length) return { error: 'No commit starts with ' + r + ' in the history read (newest ' + ctx.commits.length + ').' };
  if (hits.length > 1) return { error: r + ' matches ' + hits.length + ' commits - give more characters.' };
  return { hash: hits[0].hash };
}

/* Which commits touched these paths. A region ("file::function") narrows to its
 * file: thoughts are kept per commit, not per hunk, so the file is as close as
 * this can honestly get. */
function commitsTouching(repoDir, paths) {
  const wants = paths.map((p) => String(p).split('::')[0].replace(/\\/g, '/').replace(/^\.\//, '')).filter(Boolean);
  let raw = '';
  try {
    raw = execFileSync('git', ['log', '-n', '600', '--no-renames', '--name-only', '--format=%x1e%H'], {
      cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore']
    });
  } catch (_) { return new Set(); }
  const hit = new Set();
  for (const rec of raw.split('\x1e')) {
    const lines = rec.trim().split('\n');
    const hash = lines.shift();
    if (!hash) continue;
    if (lines.some((f) => wants.some((w) => f === w || (w.endsWith('/') ? f.startsWith(w) : f.startsWith(w + '/'))))) hit.add(hash);
  }
  return hit;
}

/* Token overlap, with prefix matching so "tunnels" finds "tunnel" and
 * "reopen" finds "reopenable". The thought's own words count double against
 * the words of its forces: a thought ABOUT the query beats one that merely
 * mentions it in passing. */
function score(qTokens, t) {
  const words = (s) => new Set(tokenize(s));
  const own = words(t.text);
  const rest = words((t.forces || []).map((f) => f.text + ' ' + (f.revisit_if || '')).join(' '));
  const has = (set, q) => [...set].some((w) => w === q || (Math.min(w.length, q.length) >= 4 && (w.startsWith(q) || q.startsWith(w))));
  let s = 0, matched = 0;
  for (const q of qTokens) {
    const a = has(own, q), b = has(rest, q);
    if (a || b) matched++;
    s += (a ? 2 : 0) + (b ? 1 : 0);
  }
  return matched ? s * matched : 0;
}

export function searchThoughts(repoDir, args = {}) {
  const ctx = context(repoDir);
  const head = { thoughts_on_record: ctx.stats.count, of_them_drafts: ctx.stats.drafts };

  if (args.id) {
    const id = String(args.id).trim();
    const t = ctx.byId.get(id) || ctx.thoughts.find((x) => x.id.startsWith(id));
    if (!t) return { ...head, error: 'No thought ' + id + ' in this repository.' };
    return { ...head, thought: full(ctx, t) };
  }

  if (!ctx.stats.count) {
    return {
      ...head,
      results: [],
      nothing_on_record: 'This repository records no thoughts at all. The only reasoning on record is what its commit messages say - read those with gitx_graph_chain or gitx_graph_commit.'
    };
  }

  let pool = ctx.thoughts;
  const scope = {};
  let absence = null;

  if (args.commit) {
    const c = resolveCommit(ctx, args.commit);
    if (c.error) return { ...head, error: c.error };
    scope.commit = ctx.ref(c.hash);
    pool = pool.filter((t) => t._behind === c.hash || (!t._behind && t.anchor && t.anchor.commit === c.hash));
    if (!pool.length) absence = `Nothing on record for ${ctx.ref(c.hash)}: no thinking was saved for this commit. Its message is the only reason on record - gitx_graph_commit ${c.hash.slice(0, 7)}.`;
  }

  if (!absence && Array.isArray(args.paths) && args.paths.length) {
    const touched = commitsTouching(repoDir, args.paths);
    scope.paths = args.paths;
    scope.commits_touching_paths = touched.size;
    pool = pool.filter((t) => touched.has(t._behind));
    if (!touched.size) absence = 'No commit in the history read touched these paths, so there is no thinking to attach to them.';
    else if (!pool.length) absence = `${touched.size} commit${touched.size === 1 ? '' : 's'} touched these paths, and none has thinking on record. Their messages are the only reasons on record.`;
  }

  if (!absence) {
    const want = (v, list) => (v ? (Array.isArray(v) ? v : [v]).map(String) : list);
    const outcomes = want(args.outcome, null), kinds = want(args.kind, null);
    if (outcomes) pool = pool.filter((t) => outcomes.includes(t.outcome));
    if (kinds) pool = pool.filter((t) => kinds.includes(t.kind));
    if (args.reopenable) pool = pool.filter(reopenable);
    if (args.confirmed_only) pool = pool.filter((t) => t.confirmed);
    if (!pool.length) absence = 'No thought matches these filters' + (scope.commit || scope.paths ? ' here' : '') + '.';
  }

  let ranked = pool.map((t) => ({ t, s: 0 }));
  const q = String(args.query || '').trim();
  if (!absence && q) {
    const qTokens = [...new Set(tokenize(q))];
    if (!qTokens.length) return { ...head, error: 'The query has no searchable words (3+ letters, not stopwords).' };
    scope.query = q;
    ranked = ranked.map((r) => ({ t: r.t, s: score(qTokens, r.t) })).filter((r) => r.s > 0);
    if (!ranked.length) absence = `No thought mentions "${q}". That is not evidence nothing about it was ever considered - only that no thought records it. Try other words, or gitx_find_related for commits.`;
  }

  if (absence) return { ...head, ...scope, results: [], nothing_on_record: absence };

  ranked.sort((a, b) => (b.s - a.s) || (ctx.recency(a.t) - ctx.recency(b.t)));
  const limit = Math.max(1, Math.min(SEARCH_MAX, Number(args.limit) || SEARCH_LIMIT));
  const results = ranked.slice(0, limit).map((r) => brief(ctx, r.t));
  return prune({
    ...head,
    ...scope,
    matched: ranked.length,
    returned: results.length,
    results,
    more: ranked.length > results.length ? `${ranked.length - results.length} more - raise limit or narrow the search.` : undefined,
    how_to_use: 'Each result is one thought: a decision, a finding, a cost kept, or a rule learned. "behind" is the commit it led to. Rejected thoughts are alternatives that were turned down - do not re-propose one without answering its held_back_by. Pass id for one thought in full, with every link both ways. Cite thought ids and commit numbers; say when a thought is an unconfirmed draft.'
  });
}

/* ─────────────────────────────────────────────── catch up */

export function catchUp(repoDir, args = {}) {
  const ctx = context(repoDir);
  if (!ctx.commits.length) return { error: 'This repository has no commits yet.' };
  const headC = ctx.commits[0];
  const head = { head: ctx.ref(headC.hash), thoughts_on_record: ctx.stats.count, of_them_drafts: ctx.stats.drafts };

  let recent = ctx.commits.slice(0, RECENT_DEFAULT);
  if (args.since) {
    const c = resolveCommit(ctx, args.since);
    if (c.error) return { ...head, error: c.error };
    recent = ctx.commits.slice(0, ctx.at.get(c.hash));
    if (!recent.length) return { ...head, since: ctx.ref(c.hash), note: 'That commit is HEAD - nothing has been committed since.' };
    head.since = ctx.ref(c.hash);
  }
  const limitRecent = Math.max(1, Math.min(30, Number(args.limit) || recent.length));
  recent = recent.slice(0, limitRecent);

  if (!ctx.stats.count) {
    return {
      ...head,
      nothing_on_record: 'This repository records no thoughts. There is no reasoning beyond commit messages to catch up on - gitx_graph_map is the way in.'
    };
  }

  const texts = (list, n = 5) => list.slice(0, n).map((t) => ({ id: t.id, text: t.text }));
  const summarise = (list) => {
    const decided = list.filter((t) => t.outcome === 'accepted' && t.kind === 'decision');
    const turned = list.filter((t) => t.outcome === 'rejected');
    return prune({
      thoughts: list.length,
      decided: decided.length ? texts(decided) : undefined,
      turned_down: turned.length ? turned.slice(0, 4).map((t) => prune({
        id: t.id, text: t.text,
        lost_to: (t.links || []).filter((l) => l.type === 'lost-to').map((l) => l.to)[0],
        can_come_back_if: reopenable(t) ? t.forces.filter((f) => f.revisit_if).map((f) => lowerFirst(f.revisit_if)).join(' · ') : undefined
      })) : undefined,
      found: list.some((t) => t.kind === 'finding') ? texts(list.filter((t) => t.kind === 'finding'), 3) : undefined,
      still_open: list.some((t) => t.outcome === 'open') ? texts(list.filter((t) => t.outcome === 'open')) : undefined
    });
  };

  /* Thinking since the last commit: anchored at HEAD and not yet in a commit.
   * This is what the previous agent was in the middle of. */
  const pending = ctx.thoughts.filter((t) => !t._behind && t.anchor && t.anchor.commit === headC.hash);

  const recentOut = recent.map((c) => {
    const list = ctx.thoughts.filter((t) => t._behind === c.hash);
    return list.length ? { commit: ctx.ref(c.hash), ...summarise(list) } : { commit: ctx.ref(c.hash), nothing_on_record: true };
  });
  const bare = recentOut.filter((r) => r.nothing_on_record).length;
  /* When the recent commits carry no thinking at all, the answer would stop at
   * "nothing" - true, and no help. Say where the newest thinking IS, and how
   * far back, so the agent knows what it is standing on. */
  let latest;
  if (bare === recentOut.length) {
    const idx = ctx.commits.findIndex((c) => ctx.thoughts.some((t) => t._behind === c.hash));
    if (idx >= 0) {
      const c = ctx.commits[idx];
      latest = { commit: ctx.ref(c.hash), commits_ago: idx, ...summarise(ctx.thoughts.filter((t) => t._behind === c.hash)) };
    }
  }

  const byRecency = (list) => list.slice().sort((a, b) => ctx.recency(a) - ctx.recency(b));
  const open = byRecency(ctx.thoughts.filter((t) => t.outcome === 'open'));
  const back = byRecency(ctx.thoughts.filter(reopenable));
  /* Stashes first, as the containers someone made on purpose; then stashed
   * thoughts no stash holds (a backfill records the outcome without one). */
  const kept = ctx.stashes.filter((s) => s.state === 'kept');
  const loose = byRecency(ctx.thoughts.filter((t) => t.outcome === 'stashed' && !t.applied_to && !ctx.stashOf.has(t.id)));
  const stashedOut = (kept.length || loose.length) ? prune({
    stashes: kept.length ? kept.map((s) => prune({
      id: s.id, title: s.title, note: s.note ? cap(s.note, 240) : undefined,
      thoughts: s.thoughts.map((id) => { const t = ctx.byId.get(id); return { id, text: t ? t.text : '(not on record)' }; }),
      references: s.references.length ? s.references.map((r) => prune({ repo: r.repo, thought: r.thought, commit: r.commit ? r.commit.slice(0, 7) : undefined, why: r.why })) : undefined
    })) : undefined,
    not_in_a_stash: loose.length ? loose.slice(0, 8).map((t) => ({ id: t.id, text: t.text })) : undefined
  }) : undefined;
  const learned = byRecency(ctx.thoughts.filter((t) => t.kind === 'learned' && t.outcome === 'accepted'));

  return prune({
    ...head,
    in_progress: pending.length
      ? { note: 'Thinking since the last commit - not in any commit yet.', ...summarise(pending) }
      : 'Nothing in progress: no thinking is recorded since the last commit.',
    recent_commits: recentOut,
    recent_without_reasoning: bare ? `${bare} of these ${recentOut.length} commits have no thinking on record; their messages are all there is.` : undefined,
    latest_with_reasoning: latest,
    still_open: open.length ? { count: open.length, newest: open.slice(0, 8).map((t) => ({ id: t.id, text: t.text, raised_at: ctx.ref(t._behind || t.anchor.commit) })) } : undefined,
    can_come_back: back.length ? { count: back.length, newest: back.slice(0, 8).map((t) => ({ id: t.id, text: t.text, if: t.forces.filter((f) => f.revisit_if && !f.superseded_by).map((f) => lowerFirst(f.revisit_if)).join(' · ') })) } : undefined,
    stashed_for_later: stashedOut,
    rules_learned: learned.length ? learned.slice(0, 20).map((t) => ({ id: t.id, rule: t.text })) : undefined,
    how_to_use: 'Read in_progress first - it is what was being worked out when the last session stopped. rules_learned are corrections that became general rules: follow them. still_open are questions nobody has settled; do not settle one silently. stashed_for_later holds ideas set aside on purpose - the references in a stash are notes about other thoughts and commits, possibly in other repositories, not links to follow. Before proposing something, gitx_thought_search it: it may already have been turned down, and why. Cite thought ids; every thought here is ' + (ctx.stats.drafts === ctx.stats.count ? 'an unconfirmed draft.' : 'marked with its standing in gitx_thought_search.')
  });
}
