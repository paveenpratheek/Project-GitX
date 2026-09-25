/*
 * Put the context graph's thoughts into topics, place the ones whose domain is
 * not their kind's, and set the goal - step 2 of docs/context-map-plan.md.
 * From a grouping the owner agreed, usually by looking at the context map
 * mockup drawn from the same file:
 *
 *   node mcp/assign-topics.js <repo> --spec=<grouping.json>           dry run
 *   node mcp/assign-topics.js <repo> --spec=<grouping.json> --apply
 *   node mcp/assign-topics.js <repo> --undo                            put it back
 *
 * The spec:
 *
 *   { goal:    { text, set_by, topics: [topic keys] },
 *     topics:  { <key>: { title, thoughts: "1c8d 1cd0 ..." } },
 *     domains: { <domain>: "a5e4 4eee ..." } }            only the hand-placed
 *
 * Thoughts are named by the start of their id after "t-" (four hex digits is
 * usually enough) or in full; a name matching none or several is an error, and
 * so is a thought in two topics. A topic's id is "tp-" + its key.
 *
 * WHAT IT WRITES. Topic files in .gitx/context/topics/, goal.json, and on each
 * named thought "topic" - and "domain" only where the spec places it somewhere
 * its kind would not; the spec is the whole truth, so a "domain" left over from
 * an earlier pass that the spec no longer gives is removed. Nothing moves
 * between graphs and no thought is created or deleted.
 *
 * HOW. Every file is written to a temporary name and renamed, so the watcher
 * never reads half of one. Every write is recorded, with the file's original
 * text, in .gitx/context/topics-manifest.json, so --undo restores each file
 * byte for byte and removes what was created; an error part-way reverses what
 * was already done. A second pass archives the first pass's manifest, and
 * --undo reverses the newest.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadThoughts } from './tools/thoughts.js';
import { TOPIC_SCHEMA, GOAL_SCHEMA, isDomain, domainByKind, mapPaths } from './tools/topics.js';

const KEY_RE = /^[a-z0-9][a-z0-9-]*$/;
const words = (s) => String(s || '').split(/[\s,]+/).filter(Boolean);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const MANIFEST = (repoDir) => path.join(repoDir, '.gitx', 'context', 'topics-manifest.json');

export function planAssignment(repoDir, spec) {
  const errors = [];
  const ctx = loadThoughts(repoDir, { store: 'context' });
  const byId = new Map(ctx.thoughts.map((t) => [t.id, t]));
  const resolve = (name, where) => {
    const p = name.startsWith('t-') ? name : 't-' + name;
    const hits = ctx.thoughts.filter((t) => t.id.startsWith(p));
    if (hits.length === 1) return hits[0].id;
    errors.push(where + ': "' + name + '" ' + (hits.length ? 'matches ' + hits.length + ' thoughts - give more of the id' : 'matches no thought in the context graph'));
    return null;
  };

  /* Topics. */
  const topicOf = new Map();               // thought id -> topic id
  const topics = [];
  for (const [key, t] of Object.entries(spec.topics || {})) {
    if (!KEY_RE.test(key)) { errors.push('topic key "' + key + '" must be lowercase letters, digits and dashes'); continue; }
    if (!t || !t.title) { errors.push('topic "' + key + '" has no title'); continue; }
    const id = 'tp-' + key;
    const file = path.join(mapPaths(repoDir).topics, id + '.json');
    topics.push({ id, key, title: t.title, file, exists: fs.existsSync(file) });
    for (const name of words(t.thoughts)) {
      const tid = resolve(name, 'topic ' + key);
      if (!tid) continue;
      if (topicOf.has(tid) && topicOf.get(tid) !== id) errors.push(tid + ' is in two topics: ' + topicOf.get(tid) + ' and ' + id);
      else topicOf.set(tid, id);
    }
  }

  /* Hand-placed domains. */
  const placedIn = new Map();              // thought id -> domain
  const sameAsKind = [];
  for (const [domain, list] of Object.entries(spec.domains || {})) {
    if (!isDomain(domain)) { errors.push('"' + domain + '" is not a domain'); continue; }
    for (const name of words(list)) {
      const tid = resolve(name, 'domain ' + domain);
      if (!tid) continue;
      if (placedIn.has(tid)) { errors.push(tid + ' is placed in two domains'); continue; }
      if (domainByKind(byId.get(tid)) === domain) sameAsKind.push(tid);
      else placedIn.set(tid, domain);
    }
  }

  /* The goal. */
  let goal = null;
  if (spec.goal) {
    const ids = (spec.goal.topics || []).map((k) => 'tp-' + k);
    for (const id of ids) if (!topics.some((t) => t.id === id)) errors.push('the goal names topic ' + id + ', which the spec does not define');
    goal = { text: spec.goal.text || '', set_by: spec.goal.set_by || 'user', topics: ids };
  }

  /* What changes on each thought. */
  const edits = [];
  for (const t of ctx.thoughts) {
    const topic = topicOf.get(t.id) || null;
    const domain = placedIn.get(t.id) || null;
    if (!topic) continue;
    if ((t.topic || null) === topic && (t.domain || null) === domain) continue;
    edits.push({ id: t.id, file: ctx.fileOf[t.id], topic, domain, was: { topic: t.topic || null, domain: t.domain || null } });
  }
  const count = (key) => ctx.thoughts.reduce((m, t) => {
    const k = key(t);
    m[k] = (m[k] || 0) + 1;
    return m;
  }, {});
  return {
    total: ctx.thoughts.length, topics, goal, edits, errors,
    unsorted: ctx.thoughts.filter((t) => !topicOf.has(t.id)).map((t) => t.id),
    sameAsKind,
    perTopic: count((t) => topicOf.get(t.id) || '(unsorted)'),
    perDomain: count((t) => placedIn.get(t.id) || domainByKind(t)),
    unreadable: ctx.stats.unreadable
  };
}

/* Write through a temporary name, so nothing ever reads half a file. */
function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

export function applyAssignment(repoDir, spec, { specFile = null } = {}) {
  const p = planAssignment(repoDir, spec);
  if (p.errors.length) throw new Error('the spec has problems, nothing written:\n  ' + p.errors.join('\n  '));
  const m = MANIFEST(repoDir);
  if (fs.existsSync(m)) {
    const prev = readJson(m);
    fs.renameSync(m, m.replace(/\.json$/, '-' + String(prev.at).replace(/[:.]/g, '-') + '.json'));
  }
  const now = new Date().toISOString();
  const rel = (f) => path.relative(repoDir, f).replace(/\\/g, '/');
  const manifest = { at: now, spec: specFile, writes: [] };
  const done = [];
  const write = (file, text) => {
    const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    writeFile(file, text);
    done.push({ file, raw });
    manifest.writes.push({ file: rel(file), raw });
  };
  try {
    for (const t of p.topics) {
      const old = t.exists ? readJson(t.file) : null;
      write(t.file, JSON.stringify({
        schema: TOPIC_SCHEMA, id: t.id, title: t.title,
        status: (old && old.status) || 'open',
        waiting_for: (old && old.waiting_for) || null,
        revisit_if: (old && old.revisit_if) || null,
        digest: (old && old.digest) || null,
        owner: (old && old.owner) || null,
        created: (old && old.created) || now,
        updated: now
      }, null, 2) + '\n');
    }
    if (p.goal) {
      const file = mapPaths(repoDir).goal;
      let old = null;
      try { old = readJson(file); } catch (_) { /* first goal */ }
      write(file, JSON.stringify({
        schema: GOAL_SCHEMA, text: p.goal.text, set_by: p.goal.set_by, at: now,
        topics: p.goal.topics, domains_off: (old && Array.isArray(old.domains_off)) ? old.domains_off : []
      }, null, 2) + '\n');
    }
    for (const e of p.edits) {
      const file = path.join(repoDir, e.file);
      const t = readJson(file);
      t.topic = e.topic;
      if (e.domain) t.domain = e.domain; else delete t.domain;
      write(file, JSON.stringify(t, null, 2) + '\n');
    }
    writeFile(m, JSON.stringify(manifest, null, 2) + '\n');
  } catch (err) {
    for (const d of done.reverse()) {
      try { if (d.raw === null) fs.unlinkSync(d.file); else writeFile(d.file, d.raw); } catch (_) { /* reported below */ }
    }
    throw new Error('stopped part-way and put back what was done: ' + err.message);
  }
  return { plan: p, manifest };
}

export function undoAssignment(repoDir) {
  const m = MANIFEST(repoDir);
  if (!fs.existsSync(m)) throw new Error('nothing to undo - no topics-manifest.json in .gitx/context/');
  const manifest = readJson(m);
  const problems = [];
  for (const w of manifest.writes.slice().reverse()) {
    const file = path.join(repoDir, w.file);
    try { if (w.raw === null) fs.unlinkSync(file); else writeFile(file, w.raw); } catch (e) { problems.push(w.file + ': ' + e.message); }
  }
  /* The topics folder goes too if this pass made it and it is empty now. */
  try { const dir = mapPaths(repoDir).topics; if (!fs.readdirSync(dir).length) fs.rmdirSync(dir); } catch (_) { /* kept */ }
  fs.renameSync(m, m.replace(/\.json$/, '-undone-' + Date.now() + '.json'));
  return { manifest, problems };
}

function report(repoDir, p) {
  const fmt = (o) => Object.entries(o).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v).join(', ');
  const lines = ['# ' + path.basename(repoDir) + ' - topics, dry run (nothing written)', ''];
  lines.push(p.total + ' thoughts in the context graph.' + (p.unreadable.length ? ' ' + p.unreadable.length + ' unreadable file(s) are not thoughts and are left alone.' : ''));
  lines.push('- topics: ' + p.topics.length + ' (' + p.topics.filter((t) => t.exists).length + ' already on disk)');
  lines.push('- by topic: ' + fmt(p.perTopic));
  lines.push('- by domain: ' + fmt(p.perDomain));
  lines.push('- thoughts to write: ' + p.edits.length + ', of them placed by hand in a domain: ' + p.edits.filter((e) => e.domain).length);
  if (p.sameAsKind.length) lines.push('- placed by hand where their kind already puts them, so nothing written for it: ' + p.sameAsKind.join(', '));
  lines.push('- goal: ' + (p.goal ? '"' + p.goal.text + '", active topics ' + p.goal.topics.join(', ') : 'none in the spec'));
  lines.push('- in no topic: ' + (p.unsorted.length ? p.unsorted.length + ' - ' + p.unsorted.join(', ') : 'none'));
  lines.push('- problems: ' + (p.errors.length ? '\n  ' + p.errors.join('\n  ') : 'none'));
  return lines.join('\n') + '\n';
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  const val = (n) => { const f = args.find((a) => a.startsWith('--' + n + '=')); return f ? f.slice(n.length + 3) : null; };
  const has = (n) => args.includes('--' + n);
  if (!repo) { console.error('usage: node mcp/assign-topics.js <repo> --spec=<grouping.json> [--apply] | --undo'); process.exit(2); }
  const dir = path.resolve(repo);
  try {
    if (has('undo')) {
      const { manifest, problems } = undoAssignment(dir);
      console.log('undone: ' + manifest.writes.length + ' files restored or removed');
      if (problems.length) { console.error('could not put back:\n  ' + problems.join('\n  ')); process.exit(1); }
    } else {
      const specFile = val('spec');
      if (!specFile) { console.error('--spec=<grouping.json> is required: the grouping is the owner\'s, not a default'); process.exit(2); }
      const spec = readJson(specFile);
      if (has('apply')) {
        const { plan, manifest } = applyAssignment(dir, spec, { specFile: path.resolve(specFile) });
        console.log('wrote ' + plan.topics.length + ' topics, ' + (plan.goal ? 'the goal, ' : '') + plan.edits.length + ' thoughts (' + manifest.writes.length + ' files). In no topic: ' + plan.unsorted.length + '. Undo with --undo.');
      } else {
        const p = planAssignment(dir, spec);
        process.stdout.write(report(dir, p));
        if (p.errors.length) process.exit(1);
      }
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
