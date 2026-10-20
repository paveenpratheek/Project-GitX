/*
 * The map's index of the code it describes, and what has changed since
 * (t-fa7e9ceba9). GitX.md is the code layer of the stack only while it is
 * current: the code layer it replaces was computed from HEAD and never stale,
 * a written map can be. So GitX keeps a fingerprint of every function each
 * section names, and of every function in the code, as they were when the
 * map was last stamped. A section whose functions changed is stale; a changed
 * or new function no section names is uncovered. Boredom (tools/boredom.js)
 * works from these two lists, the index marks stale sections for readers,
 * and the stack falls back to the code itself for them.
 *
 * Fingerprints are of the functions' text, so this needs no git: file-fabric
 * has none. Stored in <repo>/.gitx/map-index.json, beside the map's state.
 *   node mcp/tools/map-index.js <repo> [status|stamp]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { shortName } from './code-find.js';
import { regionsFor, mapPath, bodyOf, sectionsOf } from './gitx-map.js';

const SCHEMA = 'gitx.map-index/1';
const STATEMENT = /^(if|for|while|switch|try|catch|else|return|do|body|html|head)$/;
const NAME = /[A-Za-z_$][\w$]*/g;
const hash = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 16);
export const indexFile = (dir) => path.join(dir, '.gitx', 'map-index.json');

/* Every function the code defines, by name, with all its regions (a long
 * function is cut into several) and one fingerprint over their text. */
export function functionsOf(dir) {
  const byName = new Map();
  for (const r of regionsFor(dir)) {
    if (r.kind !== 'code') continue;
    const n = shortName(r);
    if (!n || STATEMENT.test(n) || n.length < 3) continue;
    if (!byName.has(n)) byName.set(n, []);
    byName.get(n).push(r);
  }
  const out = new Map();
  for (const [n, rs] of byName) {
    rs.sort((a, b) => (a.file + a.from).localeCompare(b.file + b.from));
    out.set(n, { name: n, file: rs[0].file, from: rs[0].from, to: rs[rs.length - 1].to, regions: rs, hash: hash(rs.map((r) => r.file + '\n' + r.text).join('\n')) });
  }
  return out;
}

/* Each section of the map, with the functions it names (in backticks). */
export function sectionFunctions(dir, file = mapPath(dir), fns = functionsOf(dir)) {
  if (!file) return [];
  const body = bodyOf(fs.readFileSync(file, 'utf8'));
  const lines = body.split('\n');
  return sectionsOf(body).filter((s) => !/^features\b/i.test(s.title) || s.level === 3).map((s) => {
    const names = new Set();
    for (const l of lines.slice(s.from - 1, s.to)) for (const m of l.matchAll(/`([^`\n]+)`/g)) for (const n of m[1].matchAll(NAME)) if (fns.has(n[0])) names.add(n[0]);
    return { title: s.title, level: s.level, kind: s.kind, fns: [...names] };
  });
}

let headOf = (dir) => { try { return fs.readFileSync(path.join(dir, '.git', 'HEAD'), 'utf8').trim(); } catch (_) { return null; } };
export function loadIndex(dir) {
  try { const x = JSON.parse(fs.readFileSync(indexFile(dir), 'utf8')); return x.schema === SCHEMA ? x : null; } catch (_) { return null; }
}

/* Fingerprint the map as fresh. With only (section titles), only those
 * sections - and the functions they and handled name - are taken as current:
 * a partial update must not absorb changes in sections it did not touch. */
export function stampIndex(dir, { file = mapPath(dir), only = null, handled = [] } = {}) {
  if (!file) return null;
  const fns = functionsOf(dir);
  const secs = sectionFunctions(dir, file, fns);
  const old = only ? loadIndex(dir) : null;
  const idx = old ? { ...old, sections: { ...old.sections }, all: { ...old.all } } : { schema: SCHEMA, sections: {}, all: {} };
  const take = (n) => { const f = fns.get(n); if (f) idx.all[n] = f.hash; else delete idx.all[n]; };
  for (const s of secs) {
    if (only && !only.includes(s.title)) continue;
    idx.sections[s.title] = Object.fromEntries(s.fns.map((n) => [n, fns.get(n).hash]));
    for (const n of s.fns) take(n);
  }
  if (!only) { idx.all = Object.fromEntries([...fns].map(([n, f]) => [n, f.hash])); }
  else for (const n of handled) take(n);
  /* Sections renamed or removed drop out. */
  for (const t of Object.keys(idx.sections)) if (!secs.some((s) => s.title === t)) delete idx.sections[t];
  idx.stamped = { at: new Date().toISOString(), head: headOf(dir), partial: !!only };
  fs.mkdirSync(path.dirname(indexFile(dir)), { recursive: true });
  fs.writeFileSync(indexFile(dir), JSON.stringify(idx) + '\n');
  return idx;
}

/* A map with no index is stamped as it is - the first look at it is the
 * baseline. Setup stamps it as it finishes, so this is for maps made
 * before the index existed. */
export function ensureIndex(dir, file = mapPath(dir)) {
  return loadIndex(dir) || (file ? stampIndex(dir, { file }) : null);
}

/* What changed since the map was stamped: stale sections (a function they
 * name changed or is gone) and uncovered functions (changed or new, named by
 * no section). */
export function staleness(dir, file = mapPath(dir)) {
  const idx = loadIndex(dir);
  if (!idx || !file) return null;
  const fns = functionsOf(dir);
  const secs = sectionFunctions(dir, file, fns);
  const named = new Set(secs.flatMap((s) => s.fns));
  const sections = secs.map((s) => {
    const was = idx.sections[s.title] || {};
    const changed = s.fns.filter((n) => (was[n] || idx.all[n]) && fns.get(n).hash !== (was[n] || idx.all[n]));
    const missing = Object.keys(was).filter((n) => !fns.has(n));
    return { title: s.title, kind: s.kind, fns: s.fns, changed, missing, stale: !!(changed.length || missing.length) };
  });
  const uncovered = [...fns.values()].filter((f) => !named.has(f.name) && f.hash !== idx.all[f.name])
    .map((f) => ({ name: f.name, at: f.file + ':' + f.from + '-' + f.to, isNew: !(f.name in idx.all) }));
  return { stamped: idx.stamped, sections, stale: sections.filter((s) => s.stale), uncovered };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [repo, cmd = 'status'] = process.argv.slice(2);
  if (!repo) { console.error('usage: node mcp/tools/map-index.js <repo> [status|stamp]'); process.exit(1); }
  if (cmd === 'stamp') { const x = stampIndex(repo); console.log(x ? 'stamped ' + Object.keys(x.sections).length + ' sections, ' + Object.keys(x.all).length + ' functions' : 'no map'); }
  else {
    ensureIndex(repo);
    const s = staleness(repo);
    if (!s) { console.log('no map'); process.exit(0); }
    console.log('stamped', s.stamped.at, '| stale sections', s.stale.length, '| uncovered changed functions', s.uncovered.length);
    for (const x of s.stale) console.log('  STALE', x.title, '- changed:', x.changed.join(', ') || '-', '| gone:', x.missing.join(', ') || '-');
    for (const u of s.uncovered.slice(0, 20)) console.log('  uncovered', u.name, u.at, u.isNew ? '(new)' : '(changed)');
  }
}
