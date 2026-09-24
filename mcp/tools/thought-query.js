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
import { tokenize, parseMessage } from './git-extract.js';

const SEARCH_LIMIT = 15;
const SEARCH_MAX = 50;
const TEXT_CAP = 200;
const RECENT_DEFAULT = 5;

const cap = (s, n = TEXT_CAP) => (!s || s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');
const lowerFirst = (s) => s.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase());

/* ─────────────────────────────────────────────── one pass over everything */

/* `store` picks the graph read: the thought graph (the default, for search and
 * catch-up) or the context graph (for gitx_context). Filing thoughts under
 * commits happens within that graph alone. Links are looked up in BOTH, so a
 * link that crosses from one graph to the other reads as the thought it names
 * rather than "not on record". */
function context(repoDir, { store = 'thought' } = {}) {
  const { thoughts, stats } = loadThoughts(repoDir, { store });
  const other = loadThoughts(repoDir, { store: store === 'context' ? 'thought' : 'context' }).thoughts;
  const commits = gitTopology(repoDir);                     // newest first
  const total = commitCount(repoDir) || commits.length;
  const at = new Map(commits.map((c, i) => [c.hash, i]));
  const byId = new Map(thoughts.map((t) => [t.id, t]));

  /* The page's grouping, so an agent and a person looking at the graph see the
   * same thought under the same commit. A group is everything anchored at one
   * commit; its led_to is the one its accepted thoughts share, so a rejected
   * alternative sits with the choice that beat it. None at all means thinking
   * that has not produced a commit yet. */
  /* Pooled by anchor AND talk. The fallback below hands an untied thought to
   * the commit the rest of its pool led to, which is right when a pool is one
   * talk - a backfill window, where everything anchored at one commit came out
   * of one conversation. A live session breaks that: three separate talks
   * happened while HEAD sat on one commit, only one of them produced a commit,
   * and the vote filed the other two under it. A thought records the talk it
   * came from; one without a talk (the whole backfill) pools as it always did. */
  const byAnchor = new Map();
  for (const t of thoughts) push(byAnchor, (t.anchor && t.anchor.commit) + '|' + (t.talk || ''), t);
  for (const list of byAnchor.values()) {
    const votes = new Map();
    for (const t of list) if (t.resulted_in) votes.set(t.resulted_in.commit, (votes.get(t.resulted_in.commit) || 0) + 1);
    /* Ties go to the earliest commit, as on the page. */
    const shared = [...votes.entries()].sort((a, b) => (b[1] - a[1]) || ((at.get(b[0]) ?? -1) - (at.get(a[0]) ?? -1)))[0];
    /* Same rule as the page: a thought with no commit of its own follows the
     * thought it is tied to within this talk - lost-to, cost-of, derived-from
     * first, then the decision whose force cites it, then what it cites. */
    const local = new Map(list.map((x) => [x.id, x]));
    const citedBy = new Map();
    for (const x of list) for (const f of x.forces || []) for (const c of f.cites || []) push(citedBy, c, x);
    /* Decided but not committed stays pending, with everything tied to it. */
    const PENDING = '-';
    const follow = (x, depth) => {
      if (x.resulted_in) return x.resulted_in.commit;
      if (x.outcome === 'accepted' && (x.kind === 'decision' || x.kind === 'cost')) return PENDING;
      if (depth > 2) return null;
      const next = [
        ...(x.links || []).filter((l) => l.type === 'lost-to' || l.type === 'cost-of' || l.type === 'derived-from').map((l) => local.get(l.to)),
        ...(citedBy.get(x.id) || []),
        ...(x.forces || []).flatMap((f) => (f.cites || []).map((c) => local.get(c)))
      ];
      for (const y of next) {
        const r = y && y !== x && follow(y, depth + 1);
        if (r) return r;
      }
      return null;
    };
    for (const t of list) {
      const found = follow(t, 0);
      t._behind = found === PENDING ? null : (found || (shared && shared[0]) || null);
    }
  }

  const lookup = new Map([...other.map((t) => [t.id, t]), ...thoughts.map((t) => [t.id, t])]);
  const incoming = new Map();
  for (const t of [...thoughts, ...other]) {
    for (const l of t.links || []) push(incoming, l.to, { type: l.type, from: t.id });
    if (t.applied_to) push(incoming, t.applied_to, { type: 'applied-from', from: t.id });
  }
  /* Which graph a linked thought is in, said only when it is not this one. */
  const otherName = store === 'context' ? 'thought graph' : 'context graph';
  const elsewhere = (id) => (!byId.has(id) && lookup.has(id) ? otherName : undefined);

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

  const stashes = loadStashes(repoDir, { store });
  const stashOf = new Map();
  for (const s of stashes) for (const id of s.thoughts) stashOf.set(id, s);

  return { store, thoughts, stats, commits, total, at, byId, lookup, elsewhere, incoming, ref, recency, stashes, stashOf };
}

function push(map, k, v) {
  if (!map.has(k)) map.set(k, []);
  map.get(k).push(v);
}

function reopenable(t) {
  return t.outcome === 'rejected' && (t.forces || []).some((f) =>
    f.direction === 'backward' && f.kind === 'contingent' && f.revisit_if && !f.superseded_by);
}

/* A thought is never rewritten - a later one supersedes it - so a question
 * that has been answered that way must stop counting as open, or the open
 * list fills with decisions that were settled long ago. */
function supersededBy(ctx, t) {
  const by = (ctx.incoming.get(t.id) || []).find((l) => l.type === 'supersedes');
  return by ? by.from : null;
}

/* How much weight a thought can bear, in one phrase: was it said at the time
 * or pieced together later, and has its owner checked it. */
const standing = (t) => (t.provenance === 'inferred' ? 'inferred later from a transcript - read it twice' : 'recorded at the time');

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
    status: supersededBy(ctx, t) ? 'superseded by ' + supersededBy(ctx, t)
      : reopenable(t) ? 'reopenable - held back only by something that can change' : undefined,
    text: t.text,
    decided_by: t.decided_by || undefined,
    behind: t._behind ? ctx.ref(t._behind) : undefined,
    since: t._behind ? undefined : ctx.ref(t.anchor && t.anchor.commit),
    why: forward.length ? forward.slice(0, 2) : undefined,
    held_back_by: back.length ? back : undefined,
    links: (t.links || []).length ? t.links.map((l) => {
      const o = ctx.lookup.get(l.to);
      return prune({ type: l.type, to: l.to, text: o ? cap(o.text, 110) : '(not on record)', in: ctx.elsewhere(l.to) });
    }) : undefined,
    standing: standing(t)
  };
  return prune(out);
}

function full(ctx, t) {
  const inc = (ctx.incoming.get(t.id) || []).map((l) => {
    const o = ctx.lookup.get(l.from);
    return prune({ type: l.type, from: l.from, text: o ? cap(o.text, 140) : '(not on record)', in: ctx.elsewhere(l.from) });
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
  const head = { thoughts_on_record: ctx.stats.count, of_them_inferred: ctx.stats.inferred };
  if (ctx.stats.skipped) head.not_readable = ctx.stats.skipped + ' file(s) under .gitx are not readable as thoughts, so anything they say is NOT in these results - gitx_thought_history names them and why.';

  if (args.id) {
    const id = String(args.id).trim();
    const t = ctx.byId.get(id) || ctx.thoughts.find((x) => x.id.startsWith(id));
    if (!t) {
      const there = ctx.lookup.get(id) || [...ctx.lookup.values()].find((x) => x.id.startsWith(id));
      return { ...head, error: there ? there.id + ' is in the context graph, waiting for a commit - gitx_context with id reads it.' : 'No thought ' + id + ' in this repository.' };
    }
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
    how_to_use: 'Each result is one thought: a decision, a finding, a cost kept, or a rule learned. "behind" is the commit it led to. Rejected thoughts are alternatives that were turned down - do not re-propose one without answering its held_back_by. Pass id for one thought in full, with every link both ways. Cite thought ids and commit numbers; a thought whose standing says "inferred later" was reconstructed from a transcript rather than stated, so weigh it accordingly.'
  });
}

/* ─────────────────────────────────────────────── the context graph */

/* gitx_context: thinking no commit has settled yet - discussion, ideas, open
 * questions, findings - and the stashes. Same ranking and the same shapes as
 * gitx_thought_search, so a thought reads the same in either graph; "since"
 * names the commit the discussion came after. */
export function searchContext(repoDir, args = {}) {
  const ctx = context(repoDir, { store: 'context' });
  const head = prune({
    context_graph: ctx.stats.count,
    stashes: ctx.stashes.length || undefined,
    not_readable: ctx.stats.skipped ? ctx.stats.skipped + ' file(s) in the context graph are not readable as thoughts, so anything they say is NOT in these results - gitx_thought_history names them and why.' : undefined
  });

  if (args.id) {
    const id = String(args.id).trim();
    const t = ctx.byId.get(id) || ctx.thoughts.find((x) => x.id.startsWith(id));
    if (t) return { ...head, thought: full(ctx, t) };
    const there = ctx.lookup.get(id) || [...ctx.lookup.values()].find((x) => x.id.startsWith(id));
    return { ...head, error: there ? there.id + ' is in the thought graph, not here - gitx_thought_search with id reads it.' : 'No thought ' + id + ' in this repository.' };
  }

  if (args.stashes) {
    /* Until the migration moves them, older stashes are still in .gitx/stash/,
     * where catch-up shows them - said, so an empty list is not misread. */
    const legacy = loadStashes(repoDir).length;
    const stillThere = legacy ? legacy + ' older stash(es) are still in .gitx/stash/ and show in gitx_thought_catch_up until they are moved here.' : undefined;
    if (!ctx.stashes.length) return prune({ ...head, stashes: [], nothing_on_record: 'No stash in the context graph.', elsewhere: stillThere });
    return prune({
      ...head,
      stashes: ctx.stashes.map((s) => prune({
        id: s.id, title: s.title, state: s.state, note: s.note ? cap(s.note, 240) : undefined,
        applied_to: s.applied_to ? ctx.ref(s.applied_to) : undefined,
        thoughts: s.thoughts.map((id) => { const t = ctx.lookup.get(id); return prune({ id, text: t ? t.text : '(not on record)', in: ctx.elsewhere(id) }); }),
        references: s.references.length ? s.references.map((r) => prune({ repo: r.repo, thought: r.thought, commit: r.commit ? r.commit.slice(0, 7) : undefined, why: r.why })) : undefined
      })),
      elsewhere: stillThere
    });
  }

  if (!ctx.stats.count) {
    return { ...head, results: [], nothing_on_record: 'The context graph is empty: every thought on record is in the thought graph, settled by a commit or tied to one.' };
  }

  let pool = ctx.thoughts;
  const scope = {};
  let absence = null;
  const want = (v) => (v ? (Array.isArray(v) ? v : [v]).map(String) : null);
  const outcomes = want(args.outcome), kinds = want(args.kind);
  if (outcomes) pool = pool.filter((t) => outcomes.includes(t.outcome));
  if (kinds) pool = pool.filter((t) => kinds.includes(t.kind));
  if (!pool.length) absence = 'No thought in the context graph matches these filters.';

  let ranked = pool.map((t) => ({ t, s: 0 }));
  const q = String(args.query || '').trim();
  if (!absence && q) {
    const qTokens = [...new Set(tokenize(q))];
    if (!qTokens.length) return { ...head, error: 'The query has no searchable words (3+ letters, not stopwords).' };
    scope.query = q;
    ranked = ranked.map((r) => ({ t: r.t, s: score(qTokens, r.t) })).filter((r) => r.s > 0);
    if (!ranked.length) absence = `Nothing waiting in the context graph mentions "${q}". It may have been settled already - gitx_thought_search reads the thought graph.`;
  }
  if (absence) return { ...head, ...scope, results: [], nothing_on_record: absence };

  /* Best match first; otherwise newest discussion first. */
  ranked.sort((a, b) => (b.s - a.s) || (ctx.recency(a.t) - ctx.recency(b.t)) || String(b.t.created).localeCompare(String(a.t.created)));
  const limit = Math.max(1, Math.min(SEARCH_MAX, Number(args.limit) || SEARCH_LIMIT));
  const results = ranked.slice(0, limit).map((r) => brief(ctx, r.t));
  return prune({
    ...head,
    ...scope,
    matched: ranked.length,
    returned: results.length,
    results,
    more: ranked.length > results.length ? `${ranked.length - results.length} more - raise limit or narrow the search.` : undefined,
    how_to_use: 'These are thoughts no commit has settled yet: discussion that is waiting, ideas, open questions, findings. "since" is the commit the discussion came after. An accepted decision here was decided but has not been built; a rejected one was turned down - do not re-propose it without answering its held_back_by. Build on what is here instead of working it out again, and link a new thought to the one it continues. A thought moves to the thought graph when a commit settles it. Pass id for one thought in full.'
  });
}

/* ─────────────────────────────────────────────── catch up */

/* One line for catch-up: what is waiting in the context graph, counted and
 * never shown, because that graph is read only when an agent asks for it.
 * "Written since HEAD" is the in-progress signal - new thinking lands in the
 * context graph first, so this is where the last session's unfinished work is. */
function contextSummary(repoDir, headHash) {
  const { thoughts, stats } = loadThoughts(repoDir, { store: 'context' });
  const stashes = loadStashes(repoDir, { store: 'context' });
  if (!thoughts.length && !stashes.length && !stats.skipped) return 'empty - no thought is waiting for a commit';
  const n = (k, one, many) => k + ' ' + (k === 1 ? one : many);
  const parts = [
    n(thoughts.filter((t) => t.outcome === 'open').length, 'open question', 'open questions'),
    n(thoughts.filter((t) => t.outcome === 'stashed').length, 'stashed', 'stashed'),
    n(thoughts.filter((t) => t.anchor && t.anchor.commit === headHash).length, 'written since HEAD', 'written since HEAD')
  ];
  if (stashes.length) parts.push(n(stashes.length, 'stash', 'stashes'));
  if (stats.skipped) parts.push(n(stats.skipped, 'file not readable', 'files not readable'));
  return n(thoughts.length, 'thought', 'thoughts') + ' waiting for a commit (' + parts.join(', ') + ') - read them with gitx_context';
}

/* A commit that names no thoughts moves none - promotion never guesses. But
 * if thinking was written just before it, while its parent was HEAD, the
 * commit may well have settled some of it without saying so. Said, with the
 * way to settle them by hand; nothing is moved here. */
function headUnsettled(repoDir, headHash) {
  let body, parent;
  try {
    body = execFileSync('git', ['log', '-1', '--format=%B', headHash], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    parent = execFileSync('git', ['rev-parse', headHash + '^'], { cwd: repoDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch (_) { return undefined; }
  if (parseMessage('', body).thoughts.length) return undefined;
  const before = loadThoughts(repoDir, { store: 'context' }).thoughts.filter((t) => t.anchor && t.anchor.commit === parent);
  const decided = before.filter((t) => t.outcome === 'accepted' && (t.kind === 'decision' || t.kind === 'cost'));
  if (!decided.length) return undefined;
  return 'HEAD names no thoughts in a GitX-Thoughts trailer, and ' + decided.length + ' decision(s) were waiting from just before it: '
    + decided.slice(0, 5).map((t) => t.id).join(', ') + (decided.length > 5 ? ', ...' : '')
    + '. If this commit carried any of them out, settle them: node mcp/tools/promote.js "' + repoDir + '" ' + headHash.slice(0, 7) + ' <t-id> ...';
}

export function catchUp(repoDir, args = {}) {
  const ctx = context(repoDir);
  if (!ctx.commits.length) return { error: 'This repository has no commits yet.' };
  const headC = ctx.commits[0];
  const head = { head: ctx.ref(headC.hash), thoughts_on_record: ctx.stats.count, of_them_inferred: ctx.stats.inferred };
  if (ctx.stats.skipped) head.not_readable = ctx.stats.skipped + ' file(s) under .gitx are not readable as thoughts, so anything they say is NOT in these results - gitx_thought_history names them and why.';
  const waiting = contextSummary(repoDir, headC.hash);

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
      context_graph: waiting,
      nothing_on_record: 'The thought graph records nothing: no commit here has reasoning on record beyond its message - gitx_graph_map is the way in.' + (waiting.startsWith('empty') ? '' : ' Thoughts are waiting in the context graph, though - see context_graph.')
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

  /* Thinking not yet in any commit - what the previous agent was in the
   * middle of. Not only what is anchored at HEAD: a decision made before the
   * last commit and still waiting for its own is just as unfinished, and
   * dropping it the moment an unrelated commit lands would hide it. */
  const pending = ctx.thoughts.filter((t) => !t._behind && t.anchor && ctx.at.has(t.anchor.commit));
  const olderAnchors = [...new Set(pending.map((t) => t.anchor.commit).filter((h) => h !== headC.hash))];

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
  const open = byRecency(ctx.thoughts.filter((t) => t.outcome === 'open' && !supersededBy(ctx, t)));
  const back = byRecency(ctx.thoughts.filter((t) => reopenable(t) && !supersededBy(ctx, t)));
  /* Stashes first, as the containers someone made on purpose; then stashed
   * thoughts no stash holds (a backfill records the outcome without one). */
  const kept = ctx.stashes.filter((s) => s.state === 'kept');
  const loose = byRecency(ctx.thoughts.filter((t) => t.outcome === 'stashed' && !t.applied_to && !ctx.stashOf.has(t.id)));
  const stashedOut = (kept.length || loose.length) ? prune({
    stashes: kept.length ? kept.map((s) => prune({
      id: s.id, title: s.title, note: s.note ? cap(s.note, 240) : undefined,
      thoughts: s.thoughts.map((id) => { const t = ctx.lookup.get(id); return { id, text: t ? t.text : '(not on record)' }; }),
      references: s.references.length ? s.references.map((r) => prune({ repo: r.repo, thought: r.thought, commit: r.commit ? r.commit.slice(0, 7) : undefined, why: r.why })) : undefined
    })) : undefined,
    not_in_a_stash: loose.length ? loose.slice(0, 8).map((t) => ({ id: t.id, text: t.text })) : undefined
  }) : undefined;
  const learned = byRecency(ctx.thoughts.filter((t) => t.kind === 'learned' && t.outcome === 'accepted'));

  return prune({
    ...head,
    in_progress: pending.length
      ? prune({
        note: 'Thinking not in any commit yet.',
        started_before_head: olderAnchors.length ? olderAnchors.map((h) => 'since ' + ctx.ref(h)) : undefined,
        ...summarise(pending)
      })
      : 'Nothing in progress: every recorded thought is in a commit.',
    context_graph: waiting,
    not_named_by_head: headUnsettled(repoDir, headC.hash),
    recent_commits: recentOut,
    recent_without_reasoning: bare ? `${bare} of these ${recentOut.length} commits have no thinking on record; their messages are all there is.` : undefined,
    latest_with_reasoning: latest,
    still_open: open.length ? { count: open.length, newest: open.slice(0, 8).map((t) => ({ id: t.id, text: t.text, raised_at: ctx.ref(t._behind || t.anchor.commit) })) } : undefined,
    can_come_back: back.length ? { count: back.length, newest: back.slice(0, 8).map((t) => ({ id: t.id, text: t.text, if: t.forces.filter((f) => f.revisit_if && !f.superseded_by).map((f) => lowerFirst(f.revisit_if)).join(' · ') })) } : undefined,
    stashed_for_later: stashedOut,
    rules_learned: learned.length ? learned.slice(0, 20).map((t) => ({ id: t.id, rule: t.text })) : undefined,
    how_to_use: 'Read in_progress first - it is what was being worked out when the last session stopped. context_graph counts the thinking no commit has settled yet - discussion, ideas, open questions, stashes - which is not shown here: when the task touches something that may already have been discussed, read it with gitx_context before working it out again. rules_learned are corrections that became general rules: follow them. still_open are questions nobody has settled; do not settle one silently. stashed_for_later holds ideas set aside on purpose - the references in a stash are notes about other thoughts and commits, possibly in other repositories, not links to follow. Before proposing something, gitx_thought_search it: it may already have been turned down, and why. Cite thought ids.' + (ctx.stats.inferred ? ' ' + ctx.stats.inferred + ' thought(s) in this repository were inferred from a transcript rather than stated outright; gitx_thought_search says which.' : '')
  });
}
