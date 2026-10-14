/*
 * A plain keyword retriever, for the bench only: BM25 over the same data
 * GitX has - the code, the commit messages and the recorded thoughts - and
 * nothing else GitX does. No map, no blame from lines to commits to thoughts,
 * no statuses joined to code, no lenses, no learning.
 *
 * It is the baseline that tells whether GitX's structure and learning earn
 * their keep: GitX's own word step is IDF, the family BM25 belongs to, so the
 * gap between the two arms is what everything after that step is worth.
 *
 * Kept neutral on purpose:
 *   - code is cut into fixed windows of lines, not GitX's regions, which would
 *     hand it GitX's notion of where a function starts;
 *   - one document per commit message and per thought, with the thought's own
 *     fields (kind, outcome, forces) - the same data, stated plainly;
 *   - an answer is capped near a normal GitX answer (~2,000 tokens), so
 *     neither side wins by sending more; `page` gives the next results.
 *
 * MCP over stdio, one tool, `search`. Reads only; the repository is BM25_REPO
 * or the folder it was started in. Not part of GitX - nothing imports it.
 *
 *   BM25_REPO=<repo> node mcp/bench-bm25.js
 */

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const REPO = path.resolve(process.env.BM25_REPO || process.cwd());
const K1 = 1.2, B = 0.75;            // the usual BM25 constants
const WINDOW = 40, STEP = 30;        // lines per code window, and the stride (10 lines overlap)
const ANSWER_CHARS = 8000;           // ~2,000 tokens an answer
const DOC_CHARS = 1600;              // one result at most
const CODE_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|cs|rb|php|css|html|md|sh|ps1|json)$/i;
const SKIP = /(^|\/)(node_modules|vendor|dist|build)\/|package-lock\.json$|\.min\.js$/;

const STOP = new Set(('a an and are as at be but by can could did do does for from had has have how i if in into is it its ' +
  'may more most no not of on or our should so some such than that the their them then there these they this those to ' +
  'too was we were what when where which while who why will with would you your about after all also any been before ' +
  'being both each just like make many much must only other over same she he him his her here use used using very').split(' '));

/* Lower case, split camelCase and snake_case, drop stop words, strip the
 * commonest English endings - the textbook BM25 preprocessing. */
function stem(w) {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}
function tokens(text) {
  const out = [];
  const spaced = String(text).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_\-]/g, ' ');
  for (const raw of spaced.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 2 || STOP.has(raw) || /^\d+$/.test(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

const git = (args) => execFileSync('git', args, { cwd: REPO, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });

/* ------------------------------------------------------------ the documents */

function documents() {
  const docs = [];
  /* Code and docs at HEAD, in fixed windows. */
  for (const file of git(['ls-files']).split('\n').filter((f) => f && CODE_EXT.test(f) && !SKIP.test(f))) {
    let text; try { text = fs.readFileSync(path.join(REPO, file), 'utf8'); } catch (_) { continue; }
    if (text.length > 2_000_000) continue;
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += STEP) {
      const to = Math.min(lines.length, i + WINDOW);
      docs.push({ id: file + ':' + (i + 1) + '-' + to, kind: 'code', text: lines.slice(i, to).join('\n') });
      if (to >= lines.length) break;
    }
  }
  /* One document per commit message. */
  for (const rec of git(['log', '--format=%H%x1f%as%x1f%s%x1f%b%x1e']).split('\x1e')) {
    const [hash, date, subject, body] = rec.replace(/^\s+/, '').split('\x1f');
    if (!hash) continue;
    docs.push({ id: 'commit ' + hash.slice(0, 7), kind: 'commit', text: date + '  ' + subject + '\n' + (body || '').trim() });
  }
  /* One document per thought, settled and waiting, with its own fields. */
  for (const [dir, graph] of [['.gitx/thoughts', 'settled'], ['.gitx/context/thoughts', 'waiting']]) {
    let names = []; try { names = fs.readdirSync(path.join(REPO, dir)); } catch (_) { continue; }
    for (const f of names.filter((x) => x.endsWith('.json'))) {
      let t; try { t = JSON.parse(fs.readFileSync(path.join(REPO, dir, f), 'utf8')); } catch (_) { continue; }
      const forces = (t.forces || []).map((x) => '- ' + (x.direction === 'backward' ? 'against' : 'for') + ': ' + x.text + (x.revisit_if ? ' (revisit if: ' + x.revisit_if + ')' : '')).join('\n');
      const links = (t.links || []).map((l) => l.type + ' ' + l.to).join(', ');
      docs.push({ id: t.id, kind: 'thought', text: '[' + t.kind + ', ' + t.outcome + ', ' + graph + (t.topic ? ', ' + t.topic : '') + '] ' + t.text + (forces ? '\n' + forces : '') + (links ? '\nlinks: ' + links : '') });
    }
  }
  /* Topic summaries, which GitX also reads. */
  let topics = []; try { topics = fs.readdirSync(path.join(REPO, '.gitx/context/topics')); } catch (_) { /* none */ }
  for (const f of topics.filter((x) => x.endsWith('.json'))) {
    let t; try { t = JSON.parse(fs.readFileSync(path.join(REPO, '.gitx/context/topics', f), 'utf8')); } catch (_) { continue; }
    const summary = (t.digest && t.digest.text) || t.summary || '';
    if (summary) docs.push({ id: t.id, kind: 'topic', text: (t.title || t.id) + ': ' + summary });
  }
  return docs;
}

/* ------------------------------------------------------------ BM25 */

function buildIndex(docs) {
  const df = new Map(), tf = [], len = [];
  for (const d of docs) {
    const m = new Map();
    for (const w of tokens(d.id.startsWith('t-') ? d.text : d.id + ' ' + d.text)) m.set(w, (m.get(w) || 0) + 1);
    tf.push(m);
    let n = 0; for (const c of m.values()) n += c;
    len.push(n);
    for (const w of m.keys()) df.set(w, (df.get(w) || 0) + 1);
  }
  const avg = len.reduce((a, b) => a + b, 0) / Math.max(1, len.length);
  return { docs, df, tf, len, avg, N: docs.length };
}

function search(ix, query) {
  const q = [...new Set(tokens(query))];
  const idf = (w) => Math.log(1 + (ix.N - (ix.df.get(w) || 0) + 0.5) / ((ix.df.get(w) || 0) + 0.5));
  const scored = [];
  for (let i = 0; i < ix.N; i++) {
    let s = 0;
    for (const w of q) {
      const f = ix.tf[i].get(w);
      if (!f) continue;
      s += idf(w) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * ix.len[i] / ix.avg));
    }
    if (s > 0) scored.push([i, s]);
  }
  return { words: q, hits: scored.sort((a, b) => b[1] - a[1]) };
}

let INDEX = null;
const index = () => INDEX || (INDEX = buildIndex(documents()));

function answer({ query, page = 1 }) {
  const ix = index();
  const { words, hits } = search(ix, String(query || ''));
  const out = [];
  let used = 0, i = 0;
  /* Pages are cut by size, so page n starts where page n-1 stopped. */
  for (let p = 1; p <= Math.max(1, Number(page) || 1); p++) {
    out.length = 0; used = 0;
    for (; i < hits.length; i++) {
      const d = ix.docs[hits[i][0]];
      const text = d.text.length > DOC_CHARS ? d.text.slice(0, DOC_CHARS) + ' …' : d.text;
      if (out.length && used + text.length > ANSWER_CHARS) break;
      out.push({ source: d.id, kind: d.kind, score: Number(hits[i][1].toFixed(2)), text });
      used += text.length;
    }
  }
  return { query, words, page: Number(page) || 1, matched: hits.length, results: out, more: i < hits.length ? 'page ' + ((Number(page) || 1) + 1) + ' has the next results' : undefined };
}

/* ------------------------------------------------------------ MCP over stdio */

const TOOLS = [{
  name: 'search',
  description: 'Search this project by keywords: its code, its git commit messages and its recorded design reasoning (thoughts - decisions, rejected ideas, open questions, rules - with ids t-...). Returns the best-matching pieces, best first, each with its source: file:lines for code, a commit hash, or a thought id. Use page for the next results.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords or a question.' },
      page: { type: 'number', description: 'Which page of results, from 1. Each page is about 2,000 tokens.' }
    },
    required: ['query']
  }
}];

const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let req; try { req = JSON.parse(line); } catch (_) { return; }
  const { id, method, params } = req;
  if (method === 'initialize') return send({ jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'search', version: '1.0.0' } } });
  if (method === 'notifications/initialized' || id === undefined) return;
  if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
  if (method === 'tools/call') {
    try {
      if (params.name !== 'search') throw new Error('Unknown tool: ' + params.name);
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(answer(params.arguments || {})) }] } });
    } catch (err) { return send({ jsonrpc: '2.0', id, error: { code: -32000, message: err.message } }); }
  }
  send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
});

/* Run directly with a query to see what an agent would get. */
if (process.argv[2] === '--ask') { console.log(JSON.stringify(answer({ query: process.argv.slice(3).join(' ') }), null, 1)); process.exit(0); }
