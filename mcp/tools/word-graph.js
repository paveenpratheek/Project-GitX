/*
 * The word graph (t-953ac5c019, t-9fc1d697b9, t-b463142089, t-087cdebc2f):
 * a codebase's own words - the names it defines - as clues for a setup agent,
 * never as answers. A node is a word in a place (a function); its near words
 * share that place, and a far context is the same word used in a place whose
 * neighbours are strangers to it. Words are grouped by a shared name part, so
 * toggleConstellationMode and drawConstellationLinks sit together, labelled
 * related by NAME - recall over precision: the agent judges what they mean.
 * No line numbers: the agent greps.
 *
 * Prototype, not yet wired into gitx_investigate's setup mode. Tested on
 * file-fabric (docs/word-graph-plan.md):
 *   node mcp/tools/word-graph.js <repo dir> [out file, default <repo>/.gitx/words.md]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCodeIndex, shortName } from './code-find.js';

const NL = '\n';
/* Words every web app has: they say nothing about this one. */
const GENERIC = new Set('else delete from block body input html script select label range button container span draw inside toggle download fill line from then true false null undefined return function const async await break continue default case switch typeof instanceof void with new this super class extends import export static get set some every find filter reduce push join split slice keys values entries length display none auto flex grid hidden visible absolute relative fixed pointer click change keydown keyup mousedown touchstart item data elem element target value list name type index count text style class parent child temp result error handler options config width height left right size color file files path state mode menu panel popup modal overlay layer view sync this self e el ev evt btn rect pos idx'.split(' '));
const parts = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3);
const similarity = (a, b) => {
  if (a === b) return 1;
  const x = new Set(parts(a)), y = new Set(parts(b));
  let n = 0; for (const w of x) if (y.has(w)) n++;
  return n / ((x.size + y.size - n) || 1);
};

export function wordGraph(repo, { groupsMax = 90 } = {}) {
  const regions = buildCodeIndex(repo).regions.filter((r) => r.kind !== 'doc');
  let html = ''; try { html = fs.readFileSync(path.join(repo, 'index.html'), 'utf8'); } catch (_) {}
  const all = regions.map((r) => r.text).join(NL) + NL + html;
  const grab = (re) => [...all.matchAll(re)].map((m) => m[1]);
  /* Names this code defines - not the platform's, and not style properties. */
  const STYLE = new Set(grab(/\.style\.([a-zA-Z]+)\s*=/g));
  const defined = new Set([
    ...regions.map((r) => shortName(r)),
    ...grab(/\b(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]{3,})/g),
    ...grab(/^\s{2,}([a-zA-Z_$][\w$]{3,})\s*:/gm),
    ...grab(/(?<!style)\.([a-z][a-zA-Z0-9]{3,})\s*=(?!=)/g),
    ...grab(/\bid="([\w-]+)"/g),
    ...grab(/(?:localStorage|sessionStorage)\.(?:get|set)Item\(['"]([\w.-]+)['"]/g),
    ...grab(/get(?:File|Directory)Handle\(['"]([\w.-]+)['"]/g),
    ...grab(/mode\s*===?\s*['"]([\w-]+)['"]/g),
    ...grab(/setMode\(['"]([\w-]+)['"]\)/g)
  ].map((t) => t.replace(/^[.#]/, '')).filter((t) => !STYLE.has(t)));
  /* Words in places. Split on dots: state.graphicsPreset is the field graphicsPreset. */
  const used = regions.map((r) => new Set([...(r.text.match(/[A-Za-z_$][\w$-]{3,}/g) || [])].filter((t) => defined.has(t) && !GENERIC.has(t.toLowerCase()))));
  const placesOf = new Map();
  used.forEach((s, i) => { for (const t of s) { if (!placesOf.has(t)) placesOf.set(t, []); placesOf.get(t).push(i); } });
  const N = regions.length;
  const idf = (t) => Math.log((N + 1) / ((placesOf.get(t) || []).length + 0.5));
  /* Name links: a group per distinctive name part, ranked by how many places and words it spans. */
  const byPart = new Map();
  for (const [t, p] of placesOf) {
    if (p.length > 40) continue;
    for (const w of new Set(parts(t))) {
      if (w.length < 4 || GENERIC.has(w)) continue;
      if (!byPart.has(w)) byPart.set(w, new Set());
      byPart.get(w).add(t);
    }
  }
  const groups = [...byPart].map(([w, ts]) => ({ w, terms: [...ts], places: new Set([...ts].flatMap((t) => placesOf.get(t))).size }))
    .filter((g) => g.terms.length >= 2 && g.places >= 2 && g.places <= N * 0.2)
    .sort((a, b) => b.places * Math.log(1 + b.terms.length) - a.places * Math.log(1 + a.terms.length)).slice(0, groupsMax);
  const neighboursIn = (i, t, k = 3) => [...used[i]].filter((u) => u !== t).sort((a, b) => idf(b) - idf(a)).slice(0, k);
  const shown = new Set();
  return groups.map((g) => ({
    part: g.w, places: g.places, words: g.terms.length,
    terms: g.terms.sort((a, b) => placesOf.get(b).length - placesOf.get(a).length).slice(0, 7).map((t) => {
      if (shown.has(t)) return { word: t, seen: true };
      shown.add(t);
      const ps = placesOf.get(t);
      const near = new Map();
      for (const i of ps) for (const u of used[i]) if (u !== t) near.set(u, (near.get(u) || 0) + idf(u));
      /* Far contexts: places whose neighbourhood shares nothing with the first - the word's far relatives. */
      const hoods = ps.map((i) => neighboursIn(i, t));
      const first = new Set(hoods[0]);
      return {
        word: t, places: ps.length,
        near: [...near].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([u]) => ({ word: u, byName: similarity(t, u) >= 0.34 })),
        far: hoods.slice(1).filter((h) => !h.some((x) => first.has(x))).slice(0, 2)
      };
    })
  }));
}

export function wordGraphText(repo, graph = wordGraph(repo)) {
  const lines = [
    '# Word graph - ' + path.basename(repo), '',
    'The words this code defines and uses, as GitX extracts them - no line numbers: grep a word to find it.',
    'They are clues, not answers: a name says what someone meant when they wrote it, not what the code does now,',
    'and these are not all the words there are. Words are grouped by a shared name part (related by NAME - not proof',
    'they are one feature). For each word: how many places use it; its near words (used in the same places, "~name"',
    'when the names are alike); and, where it is used with different neighbours, those far contexts - they share the',
    'word, not its neighbours, and their words may be strangers to it. Generic or misleading words are in here too.', ''
  ];
  for (const g of graph) {
    lines.push('## ' + g.part + ' (' + g.places + ' places, ' + g.words + ' words)');
    for (const t of g.terms) {
      if (t.seen) { lines.push('- ' + t.word + ' (see above)'); continue; }
      let line = '- **' + t.word + '** (' + t.places + ' places) - near: ' + (t.near.map((n) => n.word + (n.byName ? '~name' : '')).join(', ') || '-');
      if (t.far.length) line += ' | also used with: ' + t.far.map((h) => '[' + h.join(', ') + ']').join(' ');
      lines.push(line);
    }
    lines.push('');
  }
  return lines.join(NL);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, out = path.join(process.argv[2] || '.', '.gitx', 'words.md')] = process.argv.slice(2);
  if (!repo) { console.error('usage: node mcp/tools/word-graph.js <repo dir> [out file]'); process.exit(1); }
  const graph = wordGraph(repo);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, wordGraphText(repo, graph) + NL);
  console.log('wrote', out, graph.length, 'groups,', graph.reduce((n, g) => n + g.terms.filter((t) => !t.seen).length, 0), 'words,', fs.statSync(out).size, 'bytes');
}
