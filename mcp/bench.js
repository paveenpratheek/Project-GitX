/*
 * The test bench for gitx_related's answer - the System-1 layer: what an agent
 * receives in one call, judged on fixed questions against a frozen copy of the
 * repository, every run compared with the last.
 *
 *   node mcp/bench.js [repo] [--at <commit>] [--variants full,stack,no-thoughts]
 *                     [--only id,id] [--verbose] [--no-save]
 *
 * Cases live in <repo>/.gitx/bench/cases.json - private, like the thoughts
 * they name - as { schema: "gitx.bench/0", at, include, cases, facts }:
 *
 *   at       the commit to freeze at, unless --at says otherwise
 *   include  other case files in .gitx (rank-eval.json) whose query cases join
 *   cases    { id, q, expect: { thoughts: [], commits: [], code: [] }, source }
 *   facts    { name, over: [case ids], re } - a fact is given when any of those
 *            answers matches; "(?i)" at the start of re ignores case
 *
 * Variants:
 *   full         gitx_related through the session pool, as the MCP server
 *                answers a new question - with no walks to learn from
 *   stack        the 4-hop stack it replaced (rank.js) - the baseline
 *   no-thoughts  full, on a copy with no recorded thinking: code and commits
 *                only, which is what any repository without GitX has
 *
 * FROZEN, because a question asked of the live repository can be answered by
 * the commit that recorded it: 7e59c97's message quoted three of these
 * questions, and they then found themselves (t-a7ee05c99d). The copy is a
 * clone checked out at `at`, and of the private graph it keeps only what
 * existed then: thoughts created by that commit's date and anchored in its
 * history, settled only by commits in it, and each topic summary rewound
 * through its earlier versions to the one written inside that history.
 * A thought recorded before `at` and settled after it was waiting at the
 * time; it is left out rather than moved, and counted, so the copy only ever
 * holds less than was known, never more.
 *
 * Scored per case:
 *   hit     an expected id appears in the answer
 *   reach   ... or, for a thought, the commit that settled it does - the same
 *           reason reached through its commit message, which is all a
 *           repository with no recorded thinking can offer
 *   depth   how far into the answer the first expected id sits, 0 at the top
 *           and 1 at the bottom: an answer that holds it in its last line
 *           makes the agent read everything above it
 *   tokens  the answer's compact JSON / 4, the measure every earlier
 *           benchmark used; how_to_use is left out, an agent gets it once
 *   ms      the first case of a variant is the cold one - it builds the index
 *
 * A case whose expected thoughts did not exist yet at `at` is reported, and
 * left out of every count rather than counted as a miss.
 *
 * Writes only inside a temporary folder and <repo>/.gitx/bench/runs/; the
 * repository, its graph and the walk folder are only read.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { NO_CONSOLE } from './tools/no-console.js';
import { newSessions, askPooled } from './tools/session-pool.js';
import { related } from './tools/rank.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => argv.includes('--' + name);
const opt = (name) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : null; };
const TAKES_VALUE = ['--at', '--variants', '--only'];
const positional = argv.filter((a, i) => !a.startsWith('--') && !TAKES_VALUE.includes(argv[i - 1]));
const REPO = path.resolve(positional[0] || path.join(HERE, '..'));
const BENCH = path.join(REPO, '.gitx', 'bench');
const VARIANTS = (opt('variants') || 'full,stack,no-thoughts').split(',');
const ONLY = opt('only') ? new Set(opt('only').split(',')) : null;

const git = (args, cwd = REPO) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
/* A thought names a commit as { commit, patch_id, branch }; older records as a bare hash. */
const hashOf = (x) => (typeof x === 'string' ? x : x && x.commit) || null;

/* ---------------------------------------------------------------- cases */

function loadCases() {
  const file = path.join(BENCH, 'cases.json');
  if (!fs.existsSync(file)) throw new Error('No cases at ' + file);
  const spec = readJson(file);
  const cases = [...(spec.cases || [])];
  for (const inc of spec.include || []) {
    const other = path.join(REPO, '.gitx', inc);
    if (!fs.existsSync(other)) continue;
    for (const c of readJson(other).cases || []) {
      if (c.mode !== 'query') continue;
      cases.push({ id: c.id, q: c.q, source: inc, expect: { thoughts: c.expect.filter((e) => e.startsWith('t-')), commits: c.expect.filter((e) => !e.startsWith('t-')) } });
    }
  }
  const facts = (spec.facts || []).map((f) => {
    const ci = f.re.startsWith('(?i)');
    return { ...f, rx: new RegExp(ci ? f.re.slice(4) : f.re, ci ? 'i' : '') };
  });
  return { at: opt('at') || spec.at || 'HEAD', cases: ONLY ? cases.filter((c) => ONLY.has(c.id)) : cases, facts };
}

/* --------------------------------------------------------------- freeze */

function freeze(at, { thinking = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-bench-'));
  git(['clone', '-q', '--no-hardlinks', '--no-checkout', REPO, dir]);
  git(['checkout', '-q', '--detach', at], dir);
  const history = git(['rev-list', 'HEAD'], dir).split('\n').filter(Boolean);
  const full = new Set(history);
  const inHistory = (h) => !!h && (full.has(h) || (h.length >= 7 && history.some((x) => x.startsWith(h))));
  const when = git(['log', '-1', '--format=%cI', 'HEAD'], dir).trim();
  const before = (iso) => !iso || new Date(iso) <= new Date(when);
  const stats = { thoughts: 0, context: 0, after: 0, unsettled: 0, topics: 0, rewound: 0 };
  const known = new Set();
  if (thinking) {
    const src = path.join(REPO, '.gitx'), dst = path.join(dir, '.gitx');
    const keep = (sub, test, count) => {
      const from = path.join(src, sub);
      if (!fs.existsSync(from)) return;
      fs.mkdirSync(path.join(dst, sub), { recursive: true });
      for (const f of fs.readdirSync(from)) {
        if (!f.endsWith('.json')) continue;
        let t; try { t = readJson(path.join(from, f)); } catch (_) { continue; }
        const verdict = test(t);
        if (verdict === true) { fs.copyFileSync(path.join(from, f), path.join(dst, sub, f)); stats[count]++; known.add(t.id); } else stats[verdict]++;
      }
    };
    const recorded = (t) => before(t.created) && (!hashOf(t.anchor) || inHistory(hashOf(t.anchor)));
    keep('thoughts', (t) => (!recorded(t) ? 'after' : hashOf(t.resulted_in) && !inHistory(hashOf(t.resulted_in)) ? 'unsettled' : true), 'thoughts');
    keep(path.join('context', 'thoughts'), (t) => (recorded(t) ? true : 'after'), 'context');
    const topics = path.join(src, 'context', 'topics');
    if (fs.existsSync(topics)) {
      fs.mkdirSync(path.join(dst, 'context', 'topics'), { recursive: true });
      for (const f of fs.readdirSync(topics)) {
        if (!f.endsWith('.json')) continue;
        let t; try { t = readJson(path.join(topics, f)); } catch (_) { continue; }
        let d = t.digest, steps = 0;
        while (d && d.at_commit && !inHistory(d.at_commit)) { d = d.previous || null; steps++; }
        if (steps) stats.rewound++;
        fs.writeFileSync(path.join(dst, 'context', 'topics', f), JSON.stringify({ ...t, digest: d || null }, null, 2) + '\n');
        stats.topics++;
      }
    }
    for (const f of ['context/topics-manifest.json', 'context/goal.json']) {
      if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dst, f));
    }
  }
  return { dir, when, head: history[0], stats, known };
}

/* ---------------------------------------------------------------- score */

const SECTIONS = ['trees', 'map', 'commits_by_message', 'thinking', 'context', 'more_context', 'summaries', 'results'];
function whereIn(answer, needle) {
  for (const s of SECTIONS) if (answer[s] !== undefined && JSON.stringify(answer[s]).includes(needle)) return s;
  return 'elsewhere';
}

function score(c, answer, settledBy) {
  const text = JSON.stringify(answer);
  const ids = [...(c.expect.thoughts || []), ...(c.expect.commits || []).map((h) => h.slice(0, 7)), ...(c.expect.code || [])];
  const found = ids.filter((e) => text.includes(e));
  const viaCommit = (c.expect.thoughts || []).filter((t) => !text.includes(t) && settledBy.get(t) && text.includes(settledBy.get(t).slice(0, 7)));
  const firstAt = Math.min(...[...found, ...viaCommit.map((t) => settledBy.get(t).slice(0, 7))].map((e) => text.indexOf(e)).filter((i) => i >= 0), Infinity);
  return {
    hit: found.length > 0,
    reach: found.length > 0 || viaCommit.length > 0,
    recall: ids.length ? found.length / ids.length : 0,
    depth: Number.isFinite(firstAt) ? Math.round((firstAt / text.length) * 100) / 100 : null,
    where: found.length ? whereIn(answer, found[0]) : viaCommit.length ? 'commit:' + whereIn(answer, settledBy.get(viaCommit[0]).slice(0, 7)) : '-',
    tokens: Math.round(text.length / 4)
  };
}

/* ------------------------------------------------------------- variants */

function emptyDataDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-bench-data-')); }

const ASK = {
  /* A new session per case: every question is an agent's first, so the topic
   * summaries a session sends once are counted every time - the worst case. */
  full: (dir, q, dataDir) => {
    const r = askPooled(newSessions(), dir, { query: q, fresh: true, dataDir });
    return { repo: dir, ...r.answer };
  },
  stack: (dir, q, dataDir) => {
    const out = related(dir, { query: q }, { dataDir });
    delete out._monitor;
    return { repo: dir, ...out };
  }
};
ASK['no-thoughts'] = ASK.full;

function runVariant(name, frozen, cases, settledBy) {
  const dataDir = emptyDataDir();
  const rows = [];
  try {
    for (const c of cases) {
      const t0 = performance.now();
      let answer, error = null;
      try { answer = ASK[name](frozen.dir, c.q, dataDir); } catch (err) { answer = {}; error = err.message; }
      const ms = Math.round(performance.now() - t0);
      rows.push({ id: c.id, ms, error, ...score(c, answer, settledBy), text: JSON.stringify(answer) });
    }
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  return rows;
}

function summarise(rows, facts, cases) {
  const n = rows.length;
  const median = (xs) => { const s = xs.filter((x) => x !== null).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
  const byId = new Map(rows.map((r) => [r.id, r]));
  const factHits = facts.filter((f) => f.over.some((id) => byId.has(id) && f.rx.test(byId.get(id).text)));
  const factsAsked = facts.filter((f) => f.over.some((id) => byId.has(id)));
  return {
    cases: n,
    hit: rows.filter((r) => r.hit).length,
    reach: rows.filter((r) => r.reach).length,
    recall: Math.round((rows.reduce((s, r) => s + r.recall, 0) / (n || 1)) * 100) / 100,
    depth_median: median(rows.map((r) => r.depth)),
    tokens_mean: Math.round(rows.reduce((s, r) => s + r.tokens, 0) / (n || 1)),
    cold_ms: rows[0] ? rows[0].ms : null,
    warm_ms_median: median(rows.slice(1).map((r) => r.ms)),
    facts: factsAsked.length ? factHits.length + '/' + factsAsked.length : null,
    facts_given: factHits.map((f) => f.name),
    errors: rows.filter((r) => r.error).length
  };
}

/* ------------------------------------------------------------------ run */

function lastRun(at) {
  const dir = path.join(BENCH, 'runs');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  for (const f of files.reverse()) {
    try { const r = readJson(path.join(dir, f)); if (r.at === at) return { file: f, ...r }; } catch (_) {}
  }
  return null;
}

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function main() {
  const { at, cases, facts } = loadCases();
  const frozenFull = freeze(at);
  const frozenBare = VARIANTS.includes('no-thoughts') ? freeze(at, { thinking: false }) : null;
  try {
    /* What settled each thought, for reach - read from the frozen copy. */
    const settledBy = new Map();
    const tdir = path.join(frozenFull.dir, '.gitx', 'thoughts');
    if (fs.existsSync(tdir)) for (const f of fs.readdirSync(tdir)) { try { const t = readJson(path.join(tdir, f)); if (hashOf(t.resulted_in)) settledBy.set(t.id, hashOf(t.resulted_in)); } catch (_) {} }

    const valid = cases.filter((c) => (c.expect.thoughts || []).every((t) => frozenFull.known.has(t)));
    const absent = cases.filter((c) => !valid.includes(c));
    const s = frozenFull.stats;
    console.log(`Frozen at ${frozenFull.head.slice(0, 8)} (${frozenFull.when}) - ${s.thoughts} settled and ${s.context} waiting thoughts kept; ` +
      `${s.after} recorded later and ${s.unsettled} settled later left out; ${s.rewound} of ${s.topics} topic summaries rewound.`);
    if (absent.length) console.log(`Not yet recorded at this commit, so left out: ${absent.map((c) => c.id).join(', ')}`);
    console.log(`${valid.length} cases, variants: ${VARIANTS.join(', ')}\n`);

    const results = {};
    for (const v of VARIANTS) {
      if (!ASK[v]) { console.log('No such variant: ' + v); continue; }
      const rows = runVariant(v, v === 'no-thoughts' ? frozenBare : frozenFull, valid, settledBy);
      results[v] = { summary: summarise(rows, facts, valid), cases: rows.map(({ text, ...r }) => r) };
      results[v]._rows = rows;
    }

    /* Per case, every variant side by side. */
    const cols = Object.keys(results);
    console.log(pad('case', 22) + cols.map((v) => pad(v, 30)).join(''));
    for (const c of valid) {
      const cells = cols.map((v) => {
        const r = results[v]._rows.find((x) => x.id === c.id);
        const mark = r.error ? 'ERR' : r.hit ? 'HIT' : r.reach ? 'via' : ' - ';
        return pad(`${mark} ${r.depth === null ? '  -  ' : r.depth.toFixed(2)} ${lpad(r.tokens, 5)}t ${lpad(r.ms, 5)}ms`, 30);
      });
      console.log(pad(c.id.slice(0, 21), 22) + cells.join(''));
      if (flag('verbose')) for (const v of cols) { const r = results[v]._rows.find((x) => x.id === c.id); console.log('    ' + pad(v, 12) + 'found in ' + r.where + (r.error ? ' - ' + r.error : '')); }
    }

    console.log('\n' + pad('', 22) + cols.map((v) => pad(v, 30)).join(''));
    const line = (label, f) => console.log(pad(label, 22) + cols.map((v) => pad(f(results[v].summary), 30)).join(''));
    line('hit (id in answer)', (x) => `${x.hit}/${x.cases}`);
    line('reach (or its commit)', (x) => `${x.reach}/${x.cases}`);
    line('recall', (x) => x.recall);
    line('depth, median', (x) => x.depth_median);
    line('tokens, mean', (x) => x.tokens_mean);
    line('cold ms', (x) => x.cold_ms);
    line('warm ms, median', (x) => x.warm_ms_median);
    line('facts', (x) => x.facts || '-');
    line('errors', (x) => x.errors);

    const prev = lastRun(at);
    if (prev) {
      console.log(`\nAgainst the last run at this commit (${prev.file}):`);
      for (const v of cols) {
        const a = results[v].summary, b = prev.variants && prev.variants[v] && prev.variants[v].summary;
        if (!b) continue;
        const d = (k) => { const x = a[k] - b[k]; return x === 0 || Number.isNaN(x) ? '=' : (x > 0 ? '+' : '') + Math.round(x * 100) / 100; };
        console.log(`  ${pad(v, 12)} hit ${d('hit')}  reach ${d('reach')}  recall ${d('recall')}  tokens ${d('tokens_mean')}  facts ${a.facts} (was ${b.facts})`);
      }
    }

    if (!flag('no-save')) {
      for (const v of cols) delete results[v]._rows;
      const runs = path.join(BENCH, 'runs');
      fs.mkdirSync(runs, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      let code = null; try { code = git(['rev-parse', '--short', 'HEAD']).trim() + (git(['status', '--porcelain', '--', 'mcp']).trim() ? '+changes' : ''); } catch (_) {}
      const file = path.join(runs, stamp + '.json');
      fs.writeFileSync(file, JSON.stringify({ schema: 'gitx.bench-run/0', when: new Date().toISOString(), at, frozen: { head: frozenFull.head, when: frozenFull.when, ...frozenFull.stats }, code, left_out: absent.map((c) => c.id), variants: results }, null, 2) + '\n');
      console.log('\nSaved ' + path.relative(REPO, file));
    }
  } finally {
    for (const f of [frozenFull, frozenBare]) if (f) fs.rmSync(f.dir, { recursive: true, force: true });
  }
}

main();
