/*
 * Asking by subject (4th Dimension, subjects): the agent names WHAT it wants
 * the record of - subjects from a list GitX gives it - and GitX returns that
 * record. It does not hand GitX its question.
 *
 * A question in words made the agent's wording the search. A new agent knows
 * the project no better than an outsider, and what it writes is what is most
 * likely in the moment, not a deliberate choice: round 3's agent bundled
 * several questions into one sentence and GitX took "together" as the
 * subject (one-agent rounds, 14 October). And a question like "can we do X"
 * or "do we need Y" asks for a decision, which no retrieval can make: GitX
 * returns what is recorded, the agent decides.
 *
 *   menuOf       the subjects there are: the project, its topics, the
 *                concepts its branches, commit scopes and reasoning name, each
 *                with its other names - generated, so it follows the record
 *   resolve      a name to a subject: a topic, a concept or the project, by
 *                today's name or an old one; anything else is "not a subject
 *                here" with the closest, never a silent misreading
 *   meetsOf      where named subjects come together: each pair, and all of
 *                them - records in both, and records in one linked to the other
 *   instructions what an agent reads before its first call
 *
 * Nothing here writes.
 */

import path from 'node:path';
import { conceptsOf, namesFor, item } from './lens.js';
import { statusOf } from '../tools/rank.js';

const cap = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const words = (s) => String(s || '').toLowerCase().replace(/&/g, ' ').match(/[a-z0-9.]+/g) || [];
const MENU_MAX = 40;
const MEET = { brief: 4, normal: 8, deep: 16 };
/* Scopes and phrases too general to stand for a part of a project. */
const FUNCTION_WORDS = new Set(['rather', 'than', 'also', 'via', 'just', 'still', 'only', 'even', 'much', 'many', 'more', 'less', 'same', 'other', 'every', 'each']);
const GENERAL = new Set(['thought', 'thoughts', 'context', 'graph', 'ui', 'mcp', 'gitx', 'commit', 'index', 'sync', 'promote', 'held out', 'fewer tokens', 'filed under', 'comes back', 'dry run']);

/* The project's name as the folder spells it: "Project GitX" -> GitX. */
export function projectName(repoDir) {
  const parts = path.basename(repoDir).split(/[^A-Za-z0-9]+/).filter((w) => w && !/^(project|repo|the)$/i.test(w));
  return parts.join(' ') || path.basename(repoDir);
}

/* A named concept, however large: the cap subjectOf uses - a quarter of the
 * record - is for picking a subject out of a sentence, and on a name the agent
 * chose it turned "4th Dimension" (most of the recent work) away. Only a
 * phrase in nearly everything is no subject. */
function conceptFor(model, name) {
  const want = words(name).join(' ');
  const cs = conceptsOf(model, want).filter((c) => c.own >= 2 && c.records.length <= model.records.length * 0.9);
  if (!cs.length) return null;
  /* The concept that covers most of the name, then the narrower. */
  cs.sort((a, b) => b.phrase.split(' ').length - a.phrase.split(' ').length || a.records.length - b.records.length);
  return cs[0];
}

function topicRecords(model, id) {
  const records = model.records.filter((r) => (r.n && (r.layer === 'thought' || r.layer === 'context') && r.topic === id) || (r.layer === 'topic' && r.id === id));
  const commits = new Set(records.map((r) => r.n && r.n.commit).filter(Boolean));
  for (const r of model.records) if (r.layer === 'commit' && commits.has(r.id)) records.push(r);
  return records;
}

function topicFor(model, name) {
  const n = String(name || '').trim().toLowerCase();
  if (model.rx.topics.has(n)) return model.rx.topics.get(n);
  const w = words(n).filter((x) => x.length > 2);
  if (!w.length) return null;
  let best = null, bestScore = 0;
  for (const t of model.rx.topics.values()) {
    const tw = words(t.title).filter((x) => x.length > 2);
    if (t.title.toLowerCase() === n) return t;
    const shared = w.filter((x) => tw.some((y) => y === x || (x.length > 4 && y.startsWith(x.slice(0, -1))))).length;
    /* All of the name's words in the title, or the title's in the name. */
    const score = shared / Math.max(w.length, Math.min(tw.length, 2));
    if (shared === w.length && score > bestScore) { best = t; bestScore = score; }
  }
  return best;
}

/* --------------------------------------------------------------- the menu */

const menus = new Map();          // model -> menu
export function menuOf(model) {
  if (menus.has(model)) return menus.get(model);
  const entries = [];
  const seen = new Set();
  const push = (e) => { const k = e.name.toLowerCase(); if (seen.has(k)) return; seen.add(k); entries.push(e); };
  push({ name: projectName(model.repoDir), kind: 'project', size: model.records.filter((r) => r.n).length });
  for (const t of model.rx.topics.values()) push({ name: t.title, kind: 'topic', id: t.id, size: topicRecords(model, t.id).length });
  /* Concepts: the branches work was thought on, the commit scopes, and the
   * phrases the reasoning keeps using - each only if it resolves to a
   * concept of its own and is not a topic already. */
  const cands = new Map();
  for (const r of model.records) if (r.branch && !/^(main|master)$/.test(r.branch)) cands.set(r.branch.replace(/ v[\d.]+$/, ''), 'branch');
  const scopes = new Map();
  for (const c of model.cx.commits.values()) { const m = String(c.subject || '').match(/^\w+\(([a-z0-9-]+)\)/); if (m) scopes.set(m[1], (scopes.get(m[1]) || 0) + 1); }
  for (const [s, n] of scopes) if (n >= 2) cands.set(s.replace(/-/g, ' '), cands.get(s) || 'scope');
  const thoughts = model.records.filter((r) => r.layer === 'thought' || r.layer === 'context');
  const pairs = new Map(), single = new Map();
  for (const r of thoughts) {
    const toks = r.text.split('\n')[0].match(/[a-z0-9]+/g) || [];
    for (const a of new Set(toks)) single.set(a, (single.get(a) || 0) + 1);
    const once = new Set();
    for (let i = 0; i + 1 < toks.length; i++) { const p = toks[i] + ' ' + toks[i + 1]; if (!once.has(p)) { once.add(p); pairs.set(p, (pairs.get(p) || 0) + 1); } }
  }
  for (const [p, c] of pairs) {
    if (c < 6) continue;
    const [a, b] = p.split(' ');
    if (/^\d+$/.test(a) || /^\d/.test(b) || a.length < 3 || b.length < 3 || FUNCTION_WORDS.has(a) || FUNCTION_WORDS.has(b)) continue;
    const pmi = Math.log((c * thoughts.length) / ((single.get(a) || 1) * (single.get(b) || 1)));
    if (pmi > 2 && !cands.has(p)) cands.set(p, 'phrase');
  }
  const concepts = [];
  for (const [name, from] of cands) {
    if (GENERAL.has(name)) continue;
    if (topicFor(model, name)) continue;
    const c = conceptFor(model, name);
    if (!c || c.own < 3 || c.phrase !== words(name).join(' ')) continue;
    const also = [...c.names.keys()].filter((x) => x !== c.phrase);
    /* An old name of a topic is listed with the topic, not as a subject of its own. */
    if (also.some((a) => topicFor(model, a))) continue;
    concepts.push({ name: c.phrase, kind: 'concept', from, size: c.records.length, also: also.slice(0, 3) });
  }
  concepts.sort((a, b) => b.size - a.size);
  for (const c of concepts) push(c);
  /* Topics carry their other names too ("Path knowledge", once "trails"). */
  for (const e of entries) if (e.kind === 'topic') { const also = [...namesFor(model, e.name.toLowerCase()).keys()]; if (also.length) e.also = also.slice(0, 3); }
  const menu = entries.slice(0, MENU_MAX);
  menus.set(model, menu);
  return menu;
}

/* ------------------------------------------------------------- resolving */

/* A name to a subject, shaped as subjectOf's answer (found), plus how it was
 * read. Unknown names come back with the closest subjects instead. */
export function resolve(model, name) {
  const asked = String(name || '').trim();
  const lower = asked.toLowerCase();
  const project = projectName(model.repoDir);
  if (!asked) return { asked, unknown: true, closest: [] };
  if (lower === project.toLowerCase() || words(project).every((w) => words(lower).includes(w)) && words(lower).length <= words(project).length + 1) {
    const records = model.records.filter((r) => r.n && r.layer !== 'topic');
    return { asked, read_as: project + ' (the whole project)', kind: 'project', found: { subject: { phrase: project.toLowerCase(), own: records.length, branch: 0, records, names: new Map(), first: '' }, context: [], nested: false, whole: true } };
  }
  const topic = topicFor(model, asked);
  const concept = conceptFor(model, asked);
  if (!topic && !concept) {
    const w = words(lower);
    const closest = menuOf(model).map((e) => ({ e, s: words(e.name).filter((x) => w.some((y) => y === x || (y.length > 3 && x.startsWith(y.slice(0, 4))))).length + (e.also || []).filter((a) => words(a).some((x) => w.includes(x))).length }))
      .filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 4).map((x) => x.e.name);
    return { asked, unknown: true, closest };
  }
  const all = new Map();
  for (const r of topic ? topicRecords(model, topic.id) : []) all.set(r.id, r);
  for (const r of concept ? concept.records : []) all.set(r.id, r);
  const records = [...all.values()];
  const phrase = concept ? concept.phrase : topic.title.toLowerCase();
  const names = concept ? concept.names : namesFor(model, phrase);
  const read = topic && concept ? topic.title + ' (topic) and the concept "' + concept.phrase + '"' : topic ? topic.title + ' (topic)' : '"' + concept.phrase + '" (concept)';
  return {
    asked, read_as: read, kind: topic ? 'topic' : 'concept', topic: topic ? topic.id : undefined,
    also_called: names.size ? [...names.keys()] : undefined,
    found: { subject: { phrase, own: concept ? concept.own : records.length, branch: concept ? concept.branch : 0, records, names, first: concept ? concept.first : '' }, context: [], nested: false }
  };
}

/* --------------------------------------------------------- where they meet */

/* Records of every subject in a group, or in one and linked to the others -
 * the thinking that joins them. The whole project meets everything, so it is
 * left out of the groups. */
export function meetsOf(model, resolved, { effort = 'normal' } = {}) {
  const parts = resolved.filter((r) => r.found && !r.found.whole);
  if (parts.length < 2) return undefined;
  const n = MEET[effort] || MEET.normal;
  const sets = parts.map((p) => new Set(p.found.subject.records.map((r) => r.id)));
  const linkedTo = (id, set) => (model.rx.adj.get(id) || []).find((e) => set.has(e.to));
  const mentions = (p, r) => [p.found.subject.phrase, ...p.found.subject.names.keys()].some((x) => x && r.text.includes(x));
  const groups = [];
  for (let i = 0; i < parts.length; i++) for (let j = i + 1; j < parts.length; j++) groups.push([i, j]);
  if (parts.length >= 3) groups.push(parts.map((_, i) => i));
  const out = [];
  for (const g of groups) {
    const items = [];
    const ids = new Set(g.flatMap((i) => [...sets[i]]));
    for (const id of ids) {
      const r = model.byId.get(id);
      if (!r || !r.n || r.layer === 'topic') continue;
      let direct = 0, named = 0; const via = [];
      for (const i of g) {
        /* Naming a subject counts above belonging to it: the 4th Dimension
         * holds most of the recent record, so "in both" alone ranks nothing. */
        if (sets[i].has(id)) { direct++; if (mentions(parts[i], r)) named++; continue; }
        const e = linkedTo(id, sets[i]);
        if (e) via.push(e.type + ' ' + String(e.to).replace(/^(.{7}).{33}$/, '$1') + ' (' + parts[i].asked + ')');
        else { direct = -1; break; }
      }
      if (direct < 0) continue;
      items.push({ r, score: named * 2 + direct + via.length * 0.5, how: named === g.length ? 'names all of them' : direct === g.length ? 'in all of them' : 'linked: ' + via.join('; ') });
    }
    items.sort((a, b) => b.score - a.score || String(b.r.created).localeCompare(String(a.r.created)));
    const names = g.map((i) => parts[i].asked);
    out.push(items.length
      ? { between: names, count: items.length, records: items.slice(0, n).map((x) => (x.r.layer === 'commit' ? { id: String(x.r.id).slice(0, 7), status: 'COMMIT', text: cap(x.r.n.text, 140), how: x.how } : { ...item(model, x.r), how: x.how })) }
      : { between: names, count: 0, records: 'nothing recorded joins ' + names.join(' and ') });
  }
  return out;
}

/* ---------------------------------------------------------- instructions */

export function instructionsFor(model) {
  const menu = menuOf(model);
  const line = (e) => e.name + (e.also && e.also.length ? ' (also: ' + e.also.join(', ') + ')' : '');
  return [
    'GitX returns this project\'s RECORD - code, the commits that wrote it, and the reasoning behind them: decisions, rejected ideas with what held them back, constraints, rules, open questions. It does not answer questions or make decisions: you reason and decide; GitX gives you the record to decide on.',
    '',
    'Ask gitx_related by SUBJECT, not by question: name one or several subjects from this list, the lens you need, and the kinds of record.',
    'Subjects - the project: ' + menu.filter((e) => e.kind === 'project').map(line).join(', '),
    'Topics: ' + menu.filter((e) => e.kind === 'topic').map(line).join('; '),
    'Concepts: ' + menu.filter((e) => e.kind === 'concept').map(line).join('; '),
    'Several subjects in one call also give where they meet - each pair, and all of them together.',
    '',
    'Turn your question into kinds of record (include): "do we need X" - decided, rejected; "can we do X" - constraint, rule, rejected; "is X built / possible" - lens how, plus open; "why is X so" - lens why, and when for its history.',
    'lens: what (its parts), how (code with commits and rules on it), where (files, functions), when (history in order), why (decisions and reasons). effort: brief, normal, deep.',
    'Example: {"subjects": ["path knowledge", "4th Dimension"], "lens": ["what", "why"], "include": ["rejected", "open"], "effort": "brief"}',
    'For an exact name, value or list use gitx_find (find), and to open a function from an answer gitx_find (expand).'
  ].join('\n');
}

export { statusOf };
