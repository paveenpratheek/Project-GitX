/*
 * Asking by structure - the 4th Dimension, v3.1.
 *
 * v3 read what an agent wanted from the words of its question, and every
 * lens bug was a misreading: "a folder where the details are stored" taken
 * for a where, "open questions" taken for a subject, "v3" and "4th" dropped.
 * The agent knows what it wants exactly, so it says so; only the subject
 * stays in its own words, because a fresh agent does not know the project's
 * names and finding them is GitX's work (aliases, thermal, phrases):
 *
 *   query    the subject, in the agent's words
 *   lens     one or more of what, how, where, when, why - several in one call,
 *            since agents asked compound questions every time
 *   include  the kinds to give in full beside the lens - decided, rejected,
 *            constraint, rule, open, finding, commits, code - scoped to the
 *            subject. These are the edges the answer otherwise counts: all 30
 *            task-bench agents followed every one of them with a repo-wide
 *            listing call, 3.1 a agent, so the agent opens what it will open
 *            in the call that asks
 *   topics   parts to keep to (tp-...); with no query, they are the subject
 *   effort   brief, normal or deep - how much of each, not a token count
 *   next     every answer ends with the calls worth making next, written as
 *            calls, so the agent copies one instead of rewording
 *
 * The words of a question still decide the lens when none is named.
 */

import { overviewOf, timelineOf, reasonsOf, briefOf, onCodeOf, kindOf, poolOf, rankWith, item, thoughtsIn, mainCode } from './lens.js';

export const LENSES = ['what', 'how', 'where', 'when', 'why'];
export const KINDS = ['decided', 'rejected', 'constraint', 'rule', 'open', 'finding', 'commits', 'code'];
export const EFFORT = {
  brief: { each: 1, parts: 4, closest: 3, timeline: 8, include: 2, budget: 900 },
  normal: { each: 1, parts: 8, closest: 5, timeline: 14, include: 4, budget: 0 },
  deep: { each: 2, parts: 12, closest: 8, timeline: 24, include: 8, budget: 0 }
};

/* The subject kept to some parts - or, with no subject in words, made of them. */
export function scopeTo(model, found, topics) {
  const want = new Set((topics || []).filter((t) => model.rx.topics.has(t)));
  if (!want.size) return found;
  const inScope = (r) => want.has(r.topic) || (r.layer === 'commit' && model.records.some((t) => t.n && t.n.commit === r.id && want.has(t.topic)));
  if (found) return { ...found, subject: { ...found.subject, records: found.subject.records.filter(inScope) } };
  const records = model.records.filter((r) => (r.n && (r.layer === 'thought' || r.layer === 'context') && want.has(r.topic)) || (r.layer === 'topic' && want.has(r.id)));
  const commits = new Set(records.map((r) => r.n && r.n.commit).filter(Boolean));
  for (const r of model.records) if (r.layer === 'commit' && commits.has(r.id)) records.push(r);
  const title = [...want].map((t) => model.rx.topics.get(t).title).join(', ');
  return { subject: { phrase: title, own: records.length, branch: 0, records, names: new Map(), first: records.map((r) => r.created).filter(Boolean).sort()[0] || '' }, context: [], nested: false };
}

/* The kinds asked for, in full, from the subject and what the search ranked. */
export function includedOf(model, found, kinds, { seed = [], n = 4 } = {}) {
  const pool = poolOf(model, found, seed);
  const order = rankWith(model, seed);
  const out = {};
  for (const k of kinds || []) {
    if (k === 'commits') {
      const rs = found ? found.subject.records.filter((r) => r.layer === 'commit').sort((a, b) => b.created.localeCompare(a.created)).slice(0, n) : [];
      if (rs.length) out.commits = rs.map((r) => ({ commit: r.id.slice(0, 7), date: r.created.slice(0, 10), subject: r.n.text.slice(0, 100) }));
    } else if (k === 'code') {
      const code = mainCode(model, thoughtsIn(found ? found.subject.records : []), n);
      if (code.length) out.code = code;
    } else if (KINDS.includes(k)) {
      const rs = pool.filter((r) => kindOf(r.n) === k).sort(order).slice(0, n);
      /* An empty kind is said, so the agent does not go and list it repo-wide. */
      out[k] = rs.length ? rs.map((r) => item(model, r, 160)) : 'none recorded about ' + (found ? found.subject.phrase : 'this');
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/* The calls worth making next, written as calls. */
function nextOf(lenses, found, overview, include) {
  if (!found) return undefined;
  const q = found.subject.phrase, out = [];
  const part = overview && overview.parts && overview.parts[0];
  if (!lenses.includes('why')) out.push({ query: q, lens: ['why'] });
  if (!lenses.includes('how')) out.push({ query: q, lens: ['how'] });
  if (part && part.topic && (overview.parts.length > 1)) out.push({ query: q, lens: ['what'], topics: [part.topic], effort: 'deep' });
  if (!lenses.includes('where') && !(include || []).includes('rejected')) out.push({ query: q, lens: lenses, include: ['rejected', 'open', 'constraint'] });
  return out.slice(0, 3);
}

/* Nothing twice, for the lens sections too. The base answer already sends a
 * function, commit or thought once per question's stack and names it after
 * that; the lens sections were built afresh each call and sent whole - on
 * five sub-questions about one subject 50-70% of the ids in answers 2-4 had
 * been sent already, and the answers stayed at 2-4k tokens where the base
 * ones fell to 300-1,700. Here an item the stack already holds becomes its id
 * and the round it came in, a part already described keeps only its name,
 * and the brief comes once a stack. `sent` is the stack's id -> round. */
const identity = (x) => (x && typeof x === 'object' ? x.id || x.open || (x.commit ? 'commit:' + x.commit : null) : null);
export function notTwice(answer, sent, round, ever = null, stack = null) {
  const fresh = [];
  /* ever: what this session sent in other stacks - a new question starts a
   * new stack, but the agent still holds what the old ones gave it. */
  const earlier = (id) => !!ever && ever.has(id) && ever.get(id) !== stack;
  const before = (id) => (sent.has(id) && sent.get(id) < round) || earlier(id);
  /* Within one answer too: the same rejected idea sat in reasons and in
   * included, and on every function its commit wrote. */
  const now = new Set();
  const named = (id) => id.replace(/^commit:/, '') + (sent.has(id) && sent.get(id) < round ? ' (round ' + sent.get(id) + ')' : earlier(id) ? ' (earlier question)' : ' (above)');
  /* The code answer comes first in the reply: a thought it already gives in
   * full - settled by a tree's commit, decided, waiting - is above. */
  const seen = (v) => { if (Array.isArray(v)) v.forEach(seen); else if (v && typeof v === 'object') { if (/^t-/.test(String(v.id || '')) && typeof v.text === 'string') now.add(v.id); for (const k of Object.keys(v)) if (k !== 'on_this_code') seen(v[k]); } };
  seen([answer.trees, answer.decided, answer.context]);
  const walk = (o) => {
    if (!o || typeof o !== 'object' || Array.isArray(o)) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (Array.isArray(v) && v.some(identity)) {
        const keep = [], given = [];
        for (const x of v) {
          const id = identity(x);
          if (id && (before(id) || now.has(id))) given.push(named(id));
          else { keep.push(x); if (id) { fresh.push(id); now.add(id); } walk(x); }
        }
        if (given.length) { o[k] = keep.length ? keep : undefined; o[k + '_given_before'] = given; }
      } else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  const a = { ...answer };
  for (const k of ['overview', 'reasons', 'included', 'timeline']) if (a[k]) { a[k] = JSON.parse(JSON.stringify(a[k])); walk(a[k]); }
  /* The rules, constraints and rejected ideas on a piece of code (how): the
   * same thought sits on every function its commit wrote. */
  if (a.trees) a.trees = a.trees.map((tr) => { if (!tr.on_this_code) return tr; const c = { on_this_code: JSON.parse(JSON.stringify(tr.on_this_code)) }; walk(c); return { ...tr, ...c }; });
  /* A decision's evidence already sent is named by its id. */
  for (const d of (a.reasons && a.reasons.decided) || []) if (d.evidence && before(d.evidence.id)) d.evidence = d.evidence.id + ' (round ' + sent.get(d.evidence.id) + ')'; else if (d.evidence) fresh.push(d.evidence.id);
  for (const p of (a.overview && a.overview.parts) || []) {
    const id = 'part:' + p.topic;
    if (before(id)) delete p.is; else fresh.push(id);
  }
  if (a.brief) { const id = 'brief:' + a.brief.subject; if (before(id)) delete a.brief; else fresh.push(id); }
  return { answer: a, fresh };
}

/* One answer for several lenses and the kinds asked for: the brief once,
 * each lens's own section, then what was included. */
export function composeLenses(body, { model, found, lenses, include, effort }) {
  const caps = EFFORT[effort] || EFFORT.normal;
  const seed = [...new Set(JSON.stringify(body).match(/\bt-[0-9a-f]{10}\b/g) || [])];
  const out = { brief: briefOf(model, found), asked: body.asked, no_code: body.no_code };
  let overview = null;
  for (const as of lenses) {
    if (as === 'what' && found) out.overview = overview = overviewOf(model, found, { seed, caps, code: [...((body.map && body.map.core) || []).slice(0, 4), ...((body.map && body.map.wiring) || []).slice(0, 2)] });
    else if (as === 'when' && found) out.timeline = timelineOf(model, found, { max: caps.timeline });
    else if (as === 'why') out.reasons = reasonsOf(model, found, { seed, caps });
    else if (as === 'where') { if (body.map) out.map = { feature: body.map.feature, core: body.map.core, wiring: body.map.wiring, surface: body.map.surface }; if (body.trees && !lenses.includes('how')) out.code_at = body.trees.map((t) => t.function + (t.ref ? ' (' + t.ref + ')' : '')); }
    else if (as === 'how') {
      if (body.map && !out.map) out.map = { feature: body.map.feature, core: body.map.core, wiring: body.map.wiring };
      if (body.trees) out.trees = body.trees.map((t) => { const m = String(t.ref || '').match(/^(.*):(\d+)$/); const on = m ? onCodeOf(model, m[1], Number(m[2])) : undefined; return on ? { ...t, on_this_code: on } : t; });
      if (body.thinking) out.thinking = body.thinking;
      if (body.lead) { out.lead = body.lead; out.decided = body.decided; out.context = body.context; }
    }
  }
  const inc = includedOf(model, found, include, { seed, n: caps.include });
  if (inc) out.included = inc;
  out.next = nextOf(lenses, found, overview, include);
  return effort === 'brief' ? brief(out, caps.budget) : out;
}

/* brief means brief: the lens sections are built after the budget cut, so
 * they are trimmed here - texts to a line, then lists to their first items -
 * until the answer fits. */
const size = (x) => Math.round(JSON.stringify(x).length / 4);
function brief(a, budget) {
  const walk = (v, f) => { if (Array.isArray(v)) { v.forEach((x) => walk(x, f)); return; } if (v && typeof v === 'object') { f(v); for (const k of Object.keys(v)) walk(v[k], f); } };
  for (const [text, list] of [[110, 2], [80, 1], [60, 1]]) {
    if (size(a) <= budget) break;
    walk(a, (o) => {
      for (const k of Object.keys(o)) {
        if (k === 'text' && typeof o[k] === 'string' && o[k].length > text) o[k] = o[k].slice(0, text - 1) + '…';
        else if (['because', 'held_back', 'evidence'].includes(k) && list < 2) delete o[k];
        else if (Array.isArray(o[k]) && o[k].length > list && k !== 'next' && k !== 'lens') o[k] = o[k].slice(0, list);
      }
    });
  }
  if (size(a) > budget && a.overview && a.overview.parts) a.overview.parts = a.overview.parts.slice(0, 3);
  a.cut = size(a) > budget ? undefined : 'brief: one line each - effort "normal" gives the rest';
  return a;
  return out;
}
