/*
 * Project graph: what a NEW agent reads to get on track with a project and the
 * agents already working on it.
 *
 * gitx_find_related answers "what earlier work does THIS change relate to?" for an
 * agent in the middle of a change. This answers "what is this project, where does
 * each line of work stand, and why?" for an agent that has not changed anything
 * yet. Same index underneath, a different reader with a different job - search
 * ranks, this navigates.
 *
 * Top-down on purpose, because budget is the constraint:
 *
 *   map     every line of work (root tree), every thread, how they connect
 *   area    one root tree or thread: how it began, where it split, where it is now
 *   chain   one commit's path back to its root, and what was built on it since
 *   commit  one commit in full: its message, links, files
 *
 * WHERE MESSAGES COME FROM
 *
 *   git             the commit's own message - always the fallback
 *   .gitx/commits/  <hash>.txt - a fuller message written later for a commit whose
 *                   original says too little. Read INSTEAD of the git message by
 *                   this reader only. The commit and its message are never touched,
 *                   and find_related keeps reading git as it always has.
 *
 * Measured before it shipped: on ter-manager, an agent orienting through this map
 * read ~22k tokens for an overview that took ~55k tokens reading files directly.
 *
 * A reader, never a writer: nothing here changes the repository, the cached
 * index, or the message files.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadOrBuildIndex, COMMON_WORD_CUTOFF } from './commit-index.js';
import { parseMessage, tokenize } from './git-extract.js';
import { formThreads } from './threads.js';

const WHY_SHORT = 300;    // map and lists: enough to know what a commit was for
const WHY_CHAIN = 700;    // chain walk: enough to follow the reasoning
const CHAIN_LIMIT = 30;

export function messageDir(repoDir) {
  return path.join(repoDir, '.gitx', 'commits');
}

/* ─────────────────────────────────────────────── loading */

function readMessageFiles(repoDir) {
  const dir = messageDir(repoDir);
  const files = new Map();
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => /^[0-9a-f]{7,40}\.txt$/i.test(n)).sort();
  } catch (_) {
    return { files, signature: 'none' };
  }
  /* Size and mtime of every file, so an edited message is picked up without
   * HEAD moving - the index cache alone would never notice. */
  let signature = '';
  for (const n of names) {
    try {
      const file = path.join(dir, n);
      const st = fs.statSync(file);
      signature += n + ':' + st.size + ':' + st.mtimeMs + ';';
      files.set(n.slice(0, -4).toLowerCase(), fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'));
    } catch (_) { /* unreadable file - that commit falls back to git */ }
  }
  return { files, signature };
}

const cache = new Map();

export function loadGraph(repoDir) {
  const { index, rebuilt } = loadOrBuildIndex(repoDir);
  const { files, signature } = readMessageFiles(repoDir);
  const key = index.head + '|' + index.version + '|' + signature;
  const hit = cache.get(repoDir);
  if (hit && hit.key === key) return { ...hit.graph, index_rebuilt: false };
  const graph = buildGraph(index, files);
  cache.set(repoDir, { key, graph });
  return { ...graph, index_rebuilt: rebuilt };
}

/* ─────────────────────────────────────────────── building */

function buildGraph(base, files) {
  /* Resolve each message file to exactly one commit. A prefix matching two
   * commits, or none, is reported rather than guessed at. */
  const fileFor = new Map();
  const unmatched = [];
  for (const [key, raw] of files) {
    const hits = base.commits.filter((c) => c.hash.startsWith(key));
    if (hits.length === 1) fileFor.set(hits[0].hash, raw);
    else unmatched.push(key);
  }

  const commits = base.commits.map((c) => {
    const raw = fileFor.get(c.hash);
    if (!raw) return { ...c, source: 'git' };
    const nl = raw.indexOf('\n');
    const subject = (nl === -1 ? raw : raw.slice(0, nl)).trim();
    const m = parseMessage(subject, raw);
    return {
      ...c, subject, type: m.type, scope: m.scope, body: m.body, trailers: m.trailers, root: m.root,
      source: 'gitx', original_subject: c.subject
    };
  });

  /* Words and edges are recomputed from the messages actually in force - the
   * same rules buildIndex applies, so threads form exactly as they would had
   * these messages been in git from the start. */
  const N = commits.length || 1;
  const pre = new Map();
  const tokens = commits.map((c) => {
    const s = new Set([...tokenize(c.subject), ...tokenize(c.body)]);
    for (const w of s) pre.set(w, (pre.get(w) || 0) + 1);
    return s;
  });
  commits.forEach((c, i) => { c.words = [...tokens[i]].filter((w) => pre.get(w) / N <= COMMON_WORD_CUTOFF); });
  const wordDf = {}, wordIdf = {};
  for (const c of commits) for (const w of c.words) wordDf[w] = (wordDf[w] || 0) + 1;
  for (const w in wordDf) wordIdf[w] = Math.log(N / wordDf[w]);

  const byHash = new Map(commits.map((c) => [c.hash, c]));
  const resolve = (ref) => {
    const hits = commits.filter((c) => c.hash.startsWith(ref));
    return hits.length === 1 ? hits[0] : null;
  };
  const edges = {};
  let unresolvedLinks = 0;
  const push = (from, to, kind) => { (edges[from] = edges[from] || []).push({ hash: to, kind }); };
  for (const c of commits) {
    for (const t of c.trailers) {
      const target = resolve(t.ref);
      if (!target || target.hash === c.hash) { unresolvedLinks++; continue; }
      push(c.hash, target.hash, t.kind);
      push(target.hash, c.hash, 'referenced-by:' + t.kind);
    }
  }

  const index = { ...base, commits, edges, wordDf, wordIdf, trailerEdges: Object.keys(edges).length };
  const threads = formThreads(index);

  /* Chains. Only builds-on continues a line of work; every other relation kind
   * is a sideways link between lines. */
  const parents = new Map(commits.map((c) => [c.hash, []]));
  const children = new Map(commits.map((c) => [c.hash, []]));
  const sideways = new Map(commits.map((c) => [c.hash, []]));
  for (const [from, list] of Object.entries(edges)) {
    for (const e of list) {
      if (e.kind === 'builds-on') { parents.get(from).push(e.hash); children.get(e.hash).push(from); }
      else if (!e.kind.startsWith('referenced-by:')) { sideways.get(from).push({ hash: e.hash, kind: e.kind }); sideways.get(e.hash).push({ hash: from, kind: e.kind, reverse: true }); }
    }
  }

  const rootMemo = new Map();
  const rootsOf = (h, stack = new Set()) => {
    if (rootMemo.has(h)) return rootMemo.get(h);
    const c = byHash.get(h);
    if (!c || stack.has(h)) return [];
    if (c.root) { rootMemo.set(h, [c.root]); return [c.root]; }
    stack.add(h);
    const r = [...new Set(parents.get(h).flatMap((p) => rootsOf(p, stack)))];
    stack.delete(h);
    rootMemo.set(h, r);
    return r;
  };
  const depthMemo = new Map();
  const depthOf = (h, stack = new Set()) => {
    if (depthMemo.has(h)) return depthMemo.get(h);
    const c = byHash.get(h);
    if (!c || c.root || !parents.get(h).length || stack.has(h)) return 0;
    stack.add(h);
    const d = 1 + Math.max(...parents.get(h).map((p) => depthOf(p, stack)));
    stack.delete(h);
    depthMemo.set(h, d);
    return d;
  };

  const position = new Map(commits.map((c, i) => [c.hash, i]));   // git log order: newest first
  const trees = new Map();
  const unrooted = [];
  for (const c of commits) {
    const rs = rootsOf(c.hash);
    if (!rs.length) unrooted.push(c.hash);
    for (const r of rs) {
      if (!trees.has(r)) trees.set(r, { name: r, members: [], start: null });
      trees.get(r).members.push(c.hash);
      if (c.root === r) trees.get(r).start = c.hash;   // newest-first, so the last seen is the oldest
    }
  }

  const threadOf = new Map();
  for (const t of threads.threads) for (const h of t.commits) threadOf.set(h, t);

  return {
    index, commits, byHash, position, parents, children, sideways, trees, unrooted,
    rootsOf, depthOf, threads, threadOf,
    stats: {
      commits: commits.length,
      messages_from_gitx: fileFor.size,
      messages_from_git: commits.length - fileFor.size,
      unmatched_message_files: unmatched,
      unresolved_links: unresolvedLinks
    }
  };
}

/* ─────────────────────────────────────────────── views */

const brief = (c) => ({ hash: c.short, date: c.date, subject: c.subject });

function whyOf(c, cap) {
  if (!c.body) return undefined;
  if (!cap || c.body.length <= cap) return c.body;
  return c.body.slice(0, cap).replace(/\s+\S*$/, '') + ' […' + c.body.length + ' chars - gitx_graph_commit ' + c.short + ']';
}

function newestFirst(g, hashes) {
  return hashes.slice().sort((a, b) => g.position.get(a) - g.position.get(b));
}

function topRegions(g, hashes, limit = 6) {
  const idf = g.index.regionIdf || {};
  const score = new Map();
  for (const h of hashes) {
    for (const r of Object.keys(g.byHash.get(h).regions || {})) score.set(r, (score.get(r) || 0) + (idf[r] || 0));
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit).map(([r]) => r);
}

function findCommit(g, ref) {
  const r = String(ref || '').trim().toLowerCase();
  if (!/^[0-9a-f]{4,40}$/.test(r)) return { error: 'Give a commit hash (at least 4 hex characters).' };
  const hits = g.commits.filter((c) => c.hash.startsWith(r));
  if (!hits.length) return { error: 'No commit starts with ' + r + ' in this repository.' };
  if (hits.length > 1) return { error: r + ' matches ' + hits.length + ' commits - give more characters.', candidates: hits.slice(0, 5).map(brief) };
  return { commit: hits[0] };
}

function crossRootLinks(g, members) {
  const inTree = new Set(members);
  const out = new Map();
  for (const h of members) {
    const neighbours = [
      ...g.sideways.get(h).map((s) => ({ other: s.hash, kind: s.kind })),
      ...g.parents.get(h).map((p) => ({ other: p, kind: 'builds-on' })),
      ...g.children.get(h).map((ch) => ({ other: ch, kind: 'built-on-by' }))
    ];
    for (const { other, kind } of neighbours) {
      if (inTree.has(other)) continue;
      for (const r of g.rootsOf(other)) {
        if (!out.has(r)) out.set(r, []);
        out.get(r).push({ from: g.byHash.get(h).short, to: g.byHash.get(other).short, kind });
      }
    }
  }
  return [...out.entries()].map(([name, via]) => ({ name, links: via.length, via: via.slice(0, 4) }))
    .sort((a, b) => b.links - a.links);
}

export function graphMap(g) {
  const roots = [...g.trees.values()].sort((a, b) => b.members.length - a.members.length).map((t) => {
    const start = t.start ? g.byHash.get(t.start) : null;
    return {
      name: t.name,
      commits: t.members.length,
      longest_chain: Math.max(0, ...t.members.map((h) => g.depthOf(h))),
      started: start ? { ...brief(start), why: whyOf(start, WHY_SHORT) } : undefined,
      latest: newestFirst(g, t.members).slice(0, 3).map((h) => brief(g.byHash.get(h))),
      connected_to: crossRootLinks(g, t.members).map((x) => x.name)
    };
  });

  const nameOf = new Map(g.threads.threads.map((t) => [t.id, t.name]));
  return {
    stats: g.stats,
    roots,
    unrooted: g.unrooted.length ? {
      commits: g.unrooted.length,
      latest: newestFirst(g, g.unrooted).slice(0, 5).map((h) => brief(g.byHash.get(h))),
      note: 'Commits whose chain reaches no GitX-Root - usually history from before the format was adopted. Their messages still count; they just are not part of a named line of work.'
    } : undefined,
    threads: g.threads.threads.map((t) => ({
      name: t.name,
      named_by: t.namedBy,
      commits: t.commits.length,
      keywords: t.keywords.slice(0, 6),
      regions: t.regions.slice(0, 3),
      roots: countBy(t.commits.flatMap((h) => g.rootsOf(h)))
    })),
    thread_links: (g.threads.links || []).map((l) => ({
      a: nameOf.get(l.a), b: nameOf.get(l.b), strength: l.strength,
      stated_links: Math.round((l.sources.trailer || 0) / 3), shared_code: +(l.sources.region || 0).toFixed(1)
    })),
    how_to_use: [
      'ROOTS are lines of work someone declared (GitX-Root) with every commit that builds on them - facts. THREADS are areas of code that change together, grouped by GitX - inferred; say so when you cite a thread.',
      'For an overview, read "started" and "latest" for every root. For one area, call gitx_graph_area with its name.',
      'To find out WHY something exists, call gitx_graph_chain on the most relevant commit and read back toward the root. Stop once the reason is found.',
      'Messages record intent at the time. Before stating how something works TODAY, check the code - when they disagree, the code wins, and say so.',
      'Cite commit hashes for every claim.'
    ].join('\n')
  };
}

function countBy(list) {
  const out = {};
  for (const x of list) out[x] = (out[x] || 0) + 1;
  return out;
}

export function graphArea(g, name) {
  const want = String(name || '').trim().toLowerCase();
  const available = { roots: [...g.trees.keys()], threads: g.threads.threads.map((t) => t.name) };
  if (!want) return { error: 'Give the name of a root or thread from gitx_graph_map.', available };

  const tree = g.trees.get(want);
  if (tree) {
    const members = newestFirst(g, tree.members);
    const inTree = new Set(members);
    const start = tree.start ? g.byHash.get(tree.start) : null;
    const splits = members.filter((h) => g.children.get(h).filter((ch) => inTree.has(ch)).length >= 2).map((h) => ({
      ...brief(g.byHash.get(h)),
      continues_as: newestFirst(g, g.children.get(h).filter((ch) => inTree.has(ch))).map((ch) => brief(g.byHash.get(ch)))
    }));
    return {
      kind: 'root',
      name: tree.name,
      commits: members.length,
      from: g.byHash.get(members[members.length - 1]).date,
      to: g.byHash.get(members[0]).date,
      longest_chain: Math.max(0, ...members.map((h) => g.depthOf(h))),
      started: start ? { ...brief(start), why: whyOf(start, WHY_CHAIN) } : undefined,
      latest: members.slice(0, 5).map((h) => ({ ...brief(g.byHash.get(h)), why: whyOf(g.byHash.get(h), WHY_SHORT) })),
      splits,
      regions: topRegions(g, members),
      threads: countBy(members.map((h) => (g.threadOf.get(h) || { name: 'loose' }).name)),
      connected_roots: crossRootLinks(g, members),
      how_to_use: 'A split is a commit that several later commits build on - the work after each split is a phase. Call gitx_graph_chain on a commit to follow its reasoning, or gitx_graph_commit for one message in full.'
    };
  }

  const thread = g.threads.threads.find((t) => t.name.toLowerCase() === want || t.id === want);
  if (thread) {
    const members = newestFirst(g, thread.commits);
    return {
      kind: 'thread',
      name: thread.name,
      inferred: true,
      named_by: thread.namedBy,
      commits: members.length,
      from: g.byHash.get(members[members.length - 1]).date,
      to: g.byHash.get(members[0]).date,
      keywords: thread.keywords,
      regions: thread.regions,
      roots: countBy(members.flatMap((h) => g.rootsOf(h))),
      latest: members.slice(0, 5).map((h) => ({ ...brief(g.byHash.get(h)), why: whyOf(g.byHash.get(h), WHY_SHORT) })),
      all_commits: members.map((h) => brief(g.byHash.get(h))),
      how_to_use: 'A thread is GitX\'s grouping of commits that touch the same code or say the same things - a guess, not something anyone declared. Its roots say which declared lines of work it cuts across.'
    };
  }

  return { error: 'No root or thread named "' + name + '".', available };
}

export function graphChain(g, ref, limit) {
  const found = findCommit(g, ref);
  if (found.error) return found;
  const c = found.commit;
  const cap = Math.max(1, Math.min(100, limit || CHAIN_LIMIT));

  /* Back toward the root, breadth first, so the nearest reasons come first. */
  const back = [];
  const seen = new Set([c.hash]);
  let frontier = [c.hash], depth = 0, reachedRoot = !!c.root;
  while (frontier.length && back.length < cap) {
    depth++;
    const next = [];
    for (const h of frontier) {
      for (const p of g.parents.get(h)) {
        if (seen.has(p)) continue;
        seen.add(p);
        const pc = g.byHash.get(p);
        if (pc.root) reachedRoot = true;
        back.push({ steps_back: depth, ...brief(pc), root: pc.root || undefined, why: whyOf(pc, WHY_CHAIN) });
        next.push(p);
      }
    }
    frontier = next;
  }

  const forward = [];
  const seenF = new Set([c.hash]);
  frontier = [c.hash]; depth = 0;
  while (frontier.length && forward.length < cap) {
    depth++;
    const next = [];
    for (const h of newestFirst(g, frontier)) {
      for (const ch of g.children.get(h)) {
        if (seenF.has(ch)) continue;
        seenF.add(ch);
        forward.push({ steps_forward: depth, ...brief(g.byHash.get(ch)) });
        next.push(ch);
      }
    }
    frontier = next;
  }

  const t = g.threadOf.get(c.hash);
  return {
    commit: { ...brief(c), root: c.root || undefined, why: c.body || undefined },
    line_of_work: g.rootsOf(c.hash),
    thread: t ? t.name + ' (inferred)' : undefined,
    back_to_root: back.slice(0, cap),
    built_on_since: forward.slice(0, cap),
    related: g.sideways.get(c.hash).map((s) => ({ kind: s.reverse ? 'referenced-by:' + s.kind : s.kind, ...brief(g.byHash.get(s.hash)) })),
    notes: [
      back.length >= cap || forward.length >= cap ? 'Truncated at ' + cap + ' commits each way - pass limit to see more.' : null,
      !reachedRoot && g.parents.get(c.hash).length ? 'This chain ends before any GitX-Root: its oldest commits predate the format, or a link was never written.' : null,
      !g.parents.get(c.hash).length && !c.root ? 'This commit builds on nothing and declares no root: it is not part of a stated chain. gitx_find_related can suggest what it is related to.' : null
    ].filter(Boolean)
  };
}

/* Everything the graph page draws, in one compact payload the broker ships with
 * SYNC_STATE. Oldest first, because the page lays commits out left to right in
 * time. Capped so a very long history cannot turn one state message into tens of
 * megabytes - the newest commits are the ones someone opening the graph is after. */
export function graphPayload(g, maxCommits = 600) {
  const threads = g.threads.threads;
  const threadIndex = new Map(threads.map((t, i) => [t.id, i]));
  const ordered = g.commits.slice(0, maxCommits).reverse();
  const kept = new Set(ordered.map((c) => c.hash));
  const shortOf = (h) => g.byHash.get(h).short;

  const commits = ordered.map((c, x) => {
    const t = g.threadOf.get(c.hash);
    const files = [];
    for (const r of Object.keys(c.regions || {}).sort((a, b) => c.regions[b] - c.regions[a])) {
      const f = r.split('::')[0];
      if (!files.includes(f)) files.push(f);
    }
    return {
      h: c.short, x, t: t ? threadIndex.get(t.id) : -1, date: c.date,
      subject: c.subject, body: (c.body || '').slice(0, 4000),
      root: c.root || null, lines: g.rootsOf(c.hash),
      source: c.source, original: c.original_subject || null,
      files: files.slice(0, 8)
    };
  });

  const rels = [];
  for (const [from, list] of Object.entries(g.index.edges || {})) {
    if (!kept.has(from)) continue;
    for (const e of list) {
      if (e.kind.startsWith('referenced-by:') || !kept.has(e.hash)) continue;
      rels.push({ a: shortOf(from), b: shortOf(e.hash), k: e.kind });
    }
  }

  return {
    head: (g.index.head || '').slice(0, 8),
    stats: g.stats,
    truncated: g.commits.length > maxCommits,
    threads: threads.map((t) => ({ name: t.name, keywords: t.keywords.slice(0, 6), regions: t.regions.slice(0, 4), n: t.commits.length })),
    roots: [...g.trees.values()].map((t) => ({ name: t.name, n: t.members.length, start: t.start ? shortOf(t.start) : null }))
      .sort((a, b) => b.n - a.n),
    commits,
    rels,
    links: (g.threads.links || []).map((l) => ({
      a: threadIndex.get(l.a), b: threadIndex.get(l.b),
      trailer: Math.round((l.sources.trailer || 0) / 3), region: +(l.sources.region || 0).toFixed(1)
    }))
  };
}

export function graphCommit(g, ref) {
  const found = findCommit(g, ref);
  if (found.error) return found;
  const c = found.commit;
  const t = g.threadOf.get(c.hash);
  const shares = Object.entries(c.regions || {}).sort((a, b) => b[1] - a[1]);
  const files = [];
  for (const [r] of shares) { const f = r.split('::')[0]; if (!files.includes(f)) files.push(f); }
  return {
    hash: c.hash,
    short: c.short,
    date: c.date,
    message_source: c.source === 'gitx' ? '.gitx/commits (written later; the commit itself is unchanged)' : 'git',
    subject: c.subject,
    original_subject: c.original_subject,
    type: c.type || undefined,
    scope: c.scope || undefined,
    why: c.body || undefined,
    root: c.root || undefined,
    line_of_work: g.rootsOf(c.hash),
    thread: t ? t.name + ' (inferred)' : undefined,
    builds_on: g.parents.get(c.hash).map((h) => brief(g.byHash.get(h))),
    built_on_by: newestFirst(g, g.children.get(c.hash)).map((h) => brief(g.byHash.get(h))),
    related: g.sideways.get(c.hash).map((s) => ({ kind: s.reverse ? 'referenced-by:' + s.kind : s.kind, ...brief(g.byHash.get(s.hash)) })),
    files,
    regions: shares.slice(0, 8).map(([r, s]) => ({ region: r, share: +s.toFixed(2) })),
    how_to_use: 'files and regions come from git and are exact. Read those regions in the code before describing how this works today: the message says what was intended when it was written.'
  };
}
