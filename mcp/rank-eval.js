/*
 * Judges the ranking engine (tools/rank.js) against real questions, and the
 * scorers it replaces against the same questions - t-271374b008: judged on a
 * set of the owner's real questions, not on one good-looking example.
 *
 *   node mcp/rank-eval.js [repo] [--cases file] [--verbose] [--only id,id]
 *   node mcp/rank-eval.js [repo] --ask "a question" [--topic tp-…] [--paths a,b]
 *
 * The cases live in <repo>/.gitx/rank-eval.json - private, like the thoughts
 * they name - as { schema: "gitx.rank-eval/0", cases: [...] }. A case is
 *
 *   query   { id, mode: "query", q, expect: [ids or commit hashes], layers? }
 *           an agent's question, asked of the graph as it is now
 *   record  { id, mode: "record", as: "t-…", topic, ids, expect }
 *           replays the moment a thought was recorded: the graph as it was
 *           just before, the draft's own text and reasons, the topic it was
 *           filed under then and the ids it linked to then - so a link added
 *           afterwards cannot leak the answer
 *
 * A case passes at rank k when any expected node is among the first k. The
 * baseline is what an agent had before the engine: the word searches of the
 * context graph and the thought graph (retired as tools on 29 September, kept
 * as functions for this) - whichever graph the answer is in, the generous
 * reading, since an agent could pick the wrong one - findRelated for a commit,
 * and the record tool's old similar-thoughts check for a draft.
 *
 * Read-only: it builds indexes and runs queries, and writes nothing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { buildRankIndex, rank, relatedToDraft, pull } from './tools/rank.js';
import { searchContext, searchThoughts, similarThoughts } from './tools/thought-query.js';
import { loadThoughts } from './tools/thoughts.js';
import { loadOrBuildIndex } from './tools/commit-index.js';
import { findRelated } from './tools/retrieval.js';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };
const positional = [];
for (let i = 0; i < argv.length; i++) {
  if (['--cases', '--only', '--ask', '--topic', '--paths'].includes(argv[i])) { i++; continue; }
  if (!argv[i].startsWith('--')) positional.push(argv[i]);
}
const repo = path.resolve(positional[0] || process.cwd());
const casesFile = opt('cases') || path.join(repo, '.gitx', 'rank-eval.json');
const only = opt('only') ? new Set(opt('only').split(',')) : null;
const verbose = flag('verbose');
const DEPTH = 50;

/* --ask "words": put one question to the engine and show what it ranks, with
 * why - for trying it by hand while features are built on it. */
if (opt('ask')) {
  const t0 = Date.now();
  const ix = buildRankIndex(repo);
  const out = rank(ix, { text: opt('ask'), topic: opt('topic'), paths: opt('paths') ? opt('paths').split(',') : [], limit: 10 });
  console.log(`\n${ix.nodes.size} nodes, ${Date.now() - t0} ms · words: ${out.words.join(' ')}` +
    (out.unmatched.length ? ' · not in the graph: ' + out.unmatched.join(' ') : '') + ` · signals: ${out.signals.join(', ')}\n`);
  for (const x of out.results) {
    console.log(`${String(x.score).padStart(6)}  ${x.id}  ${x.layer}${x.outcome ? ' · ' + x.outcome : ''}${x.topic ? ' · ' + x.topic : ''}` +
      `\n        ${x.text}\n        ${x.why.join(' · ')}\n`);
  }
  process.exit(0);
}

const spec = JSON.parse(fs.readFileSync(casesFile, 'utf8'));
if (spec.schema !== 'gitx.rank-eval/0') throw new Error(casesFile + ' is not a gitx.rank-eval/0 file');
const cases = spec.cases.filter((c) => !only || only.has(c.id));

const t0 = Date.now();
const commitIndex = loadOrBuildIndex(repo).index;
const ix = buildRankIndex(repo, { commitIndex });
const built = Date.now() - t0;

const byId = new Map();
for (const store of ['thought', 'context']) for (const t of loadThoughts(repo, { store }).thoughts) byId.set(t.id, { t, store });

/* A result id matches an expected one exactly, or as a commit hash prefix. */
const same = (got, want) => got === want || (/^[0-9a-f]{7,40}$/.test(want) && /^[0-9a-f]{7,40}$/.test(got) && (got.startsWith(want) || want.startsWith(got)));
const firstRank = (ids, expect) => {
  const i = ids.findIndex((id) => expect.some((e) => same(id, e)));
  return i < 0 ? null : i + 1;
};
/* An engine result is its own id and, for a thought, the commit it settled -
 * the same route, which the engine says rather than folding yet. */
const engineRank = (results, expect) => {
  const i = results.findIndex((r) => expect.some((e) => same(r.id, e) || (r.commit && same(r.commit, e))));
  return i < 0 ? null : i + 1;
};

function baseline(c) {
  if (c.mode === 'record') {
    const draft = byId.get(c.as).t;
    const before = draft.created;
    const ids = similarThoughts(repo, draft.text, { exclude: [c.as], limit: DEPTH })
      .filter((r) => { const o = byId.get(r.id); return !o || !o.t.created || o.t.created < before; })
      .map((r) => r.id);
    return firstRank(ids, c.expect);
  }
  const commits = c.expect.filter((e) => !e.startsWith('t-'));
  const thoughts = c.expect.filter((e) => e.startsWith('t-'));
  const ranks = [];
  if (commits.length) {
    ranks.push(firstRank(findRelated(commitIndex, { description: c.q, limit: DEPTH }).results.map((r) => r.short), commits));
  }
  if (thoughts.length) {
    const inCtx = thoughts.filter((id) => byId.get(id) && byId.get(id).store === 'context');
    const inTg = thoughts.filter((id) => byId.get(id) && byId.get(id).store === 'thought');
    if (inCtx.length) ranks.push(firstRank((searchContext(repo, { query: c.q, limit: DEPTH }).results || []).map((r) => r.id), inCtx));
    if (inTg.length) ranks.push(firstRank((searchThoughts(repo, { query: c.q, limit: DEPTH }).results || []).map((r) => r.id), inTg));
  }
  const found = ranks.filter((r) => r !== null);
  return found.length ? Math.min(...found) : null;
}

function engine(c) {
  if (c.mode === 'record') {
    const draft = byId.get(c.as).t;
    const reasons = (draft.forces || []).map((f) => f.text).join(' ');
    /* The record tool's own call, with no floor, so the rank is where the
     * answer sat even when the tool would not have offered it. */
    const results = relatedToDraft(ix, {
      text: draft.text, also: reasons, ids: c.ids || [], topic: c.topic || null,
      before: draft.created, exclude: [c.as], limit: DEPTH, floor: 0
    });
    return { words: [], unmatched: [], results };
  }
  return rank(ix, { text: c.q, layers: c.layers || null, limit: DEPTH });
}

const rows = [];
for (const c of cases) {
  const missing = c.expect.filter((e) => !(e.startsWith('t-') ? byId.has(e) : commitIndex.commits.some((k) => k.hash.startsWith(e))));
  if (missing.length) { rows.push({ c, missing }); continue; }
  const t = Date.now();
  const out = engine(c);
  const ms = Date.now() - t;
  rows.push({ c, eng: engineRank(out.results, c.expect), base: baseline(c), ms, out, stack: stackRank(c) });
}

/* The stack gitx_related answers with (t-8e3f4c2aa9): where the expected node
 * sits in its order - the core, then the edge, then what words alone found -
 * and in which of them. A question only: a draft being recorded is asked of
 * rank() through relatedToDraft. */
function stackRank(c) {
  if (c.mode !== 'query') return null;
  const p = pull(ix, { text: c.q, layers: c.layers || null });
  const order = [...p.core, ...p.edge, ...p.wordsOnly];
  const i = order.findIndex((r) => c.expect.some((e) => same(r.n.id, e) || (r.n.commit && same(r.n.commit, e))));
  if (i < 0) return { rank: null, group: 'lost' };
  return { rank: i + 1, group: i < p.core.length ? 'core' : i < p.core.length + p.edge.length ? 'edge' : 'words' };
}

const fmt = (r) => (r === null ? '—' : String(r));
console.log(`\nranking engine on ${path.basename(repo)}: ${ix.nodes.size} nodes indexed in ${built} ms\n`);
console.log('case'.padEnd(24) + 'engine'.padStart(7) + 'today'.padStart(7) + '   ms' + '     stack');
for (const r of rows) {
  if (r.missing) { console.log(r.c.id.padEnd(24) + '   expected id not on record: ' + r.missing.join(', ')); continue; }
  const mark = r.eng !== null && (r.base === null || r.eng < r.base) ? '  ▲' : (r.base !== null && (r.eng === null || r.eng > r.base) ? '  ▼' : '   ');
  console.log(r.c.id.padEnd(24) + fmt(r.eng).padStart(7) + fmt(r.base).padStart(7) + String(r.ms).padStart(5) + mark +
    (r.stack ? '  ' + (r.stack.rank === null ? 'lost' : r.stack.rank + ' (' + r.stack.group + ')') : ''));
  if (verbose) {
    console.log('    ' + (r.c.q || 'record as ' + r.c.as) + '\n    words: ' + r.out.words.join(' ') + (r.out.unmatched.length ? '   unmatched: ' + r.out.unmatched.join(' ') : ''));
    for (const x of r.out.results.slice(0, 5)) {
      const hit = r.c.expect.some((e) => same(x.id, e) || (x.commit && same(x.commit, e))) ? '*' : ' ';
      console.log(`   ${hit}${String(x.score).padStart(6)}  ${x.id}  ${x.text.slice(0, 90)}\n              ${x.why.join(' · ')}`);
    }
  }
}

const scored = rows.filter((r) => !r.missing);
const at = (key, k) => scored.filter((r) => r[key] !== null && r[key] <= k).length;
const mrr = (key) => (scored.reduce((s, r) => s + (r[key] ? 1 / r[key] : 0), 0) / (scored.length || 1)).toFixed(3);
console.log(`\n${scored.length} cases        engine   today`);
for (const k of [1, 3, 5, 10]) console.log(`  in top ${String(k).padEnd(3)}      ${String(at('eng', k)).padStart(6)}  ${String(at('base', k)).padStart(6)}`);
console.log(`  MRR           ${mrr('eng').padStart(6)}  ${mrr('base').padStart(6)}\n`);

const asked = scored.filter((r) => r.stack);
if (asked.length) {
  const engOf = asked.map((r) => r.eng), stOf = asked.map((r) => r.stack.rank);
  const mrrOf = (list) => (list.reduce((s, x) => s + (x ? 1 / x : 0), 0) / list.length).toFixed(3);
  const groups = asked.reduce((m, r) => ((m[r.stack.group] = (m[r.stack.group] || 0) + 1), m), {});
  console.log(`${asked.length} questions    engine   stack`);
  for (const k of [1, 3, 10]) console.log(`  in top ${String(k).padEnd(3)}      ${String(engOf.filter((x) => x && x <= k).length).padStart(6)}  ${String(stOf.filter((x) => x && x <= k).length).padStart(6)}`);
  console.log(`  MRR           ${mrrOf(engOf).padStart(6)}  ${mrrOf(stOf).padStart(6)}`);
  console.log(`  the expected node is in the stack's ${Object.entries(groups).map(([g, n]) => g + ' ' + n).join(', ')}\n`);
}
