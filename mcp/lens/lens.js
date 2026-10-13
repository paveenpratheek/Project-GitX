/*
 * The lens - the 4th Dimension, v3: what a question asks for, about what, and
 * under which names.
 *
 * Asked to know the 4th Dimension, all 20 agents of the first task bench
 * opened the newest commit first and spent 97 sub-questions on the newest
 * work, none on the monitor, the ranking engine or the session pool: GitX
 * answered "what is it" the way it answers "where is it", from the code the
 * words land on. Three things are read from the question here, none of them
 * a search of their own - they decide what the search is about and how the
 * answer is shaped (t-58927692a8, t-d8b53e357e, t-ccb39f6d6d):
 *
 *   lens      the asking word, which GitX used to throw away: what gives the
 *             subject's parts, summary and key decisions; how its code; where
 *             its files and functions; when its commits in order; why its
 *             decisions, their forces and what lost to them. A weight on the
 *             shape, not a switch: "how was it decided" is a why.
 *   subject   of two concepts a question names, the narrower is the subject
 *             and the broader its context - "the 4th Dimension's path
 *             knowledge" is about path knowledge, within the 4th Dimension -
 *             judged by how many records each phrase is in, not by grammar.
 *             Phrases are matched as written, so "4th" survives (the
 *             tokenizer drops it: t-372ae0adb3).
 *   names     an old name and today's are one concept. From the data, three
 *             structural signs: a file replaced by one named like it in the
 *             same commit (trail-recorder.js by path-recorder.js in 7279f00),
 *             one commit scope ending where another on the same files begins
 *             (trails, then paths), and a record that names both with a word
 *             of succession ("trails ... kept for path knowledge", 30f8eaf).
 *             Appearing together is not enough: trails and graph caching
 *             share records, and 30f8eaf says "not graph caching" - a record
 *             saying "not X" beside a name rules X out. From agents, thermal
 *             links words through the code they led to (thermal.js).
 *
 * Read from the rank and code indexes and git; cached per HEAD and thought
 * files. Nothing here writes.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { NO_CONSOLE } from '../tools/no-console.js';
import { buildCodeIndex, rankIndexFor, shortName } from '../tools/code-find.js';
import { stem, statusOf, summaryOf } from '../tools/rank.js';
import { ASKING } from '../tools/learn.js';
import { loadThoughts } from '../tools/thoughts.js';

const git = (cwd, args) => execFileSync('git', args, { windowsHide: NO_CONSOLE, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
const cap = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };

const STOP = new Set(('a an the of to in on at by for with from as into is are was were be been it its s t and or this that these those our ' +
  'we you i me my do does did can could should would will about there their tell explain describe overview give show me us all whole ' +
  'work works working part parts thing things gitx project').split(' '));
/* Words that name what the agent wants back about a subject, not a subject:
 * "4th Dimension: what it is, how it works, decisions, rejected, costs, open
 * questions" is one question about the 4th Dimension. Read as a concept,
 * "open questions" became the subject (first agent run of v3). */
const FACETS = new Set(('decision decisions decided rejected rejection rejections cost costs open question questions answer answers ' +
  'built build works work working reason reasons rationale tradeoff tradeoffs trade offs constraint constraints rule rules status ' +
  'history overview summary detail details layer layers part parts piece pieces how why what when where idea ideas').split(' '));
const SPECIFIC = 0.06;           // a phrase in more than this share of records is too common to stand for a concept
const SCOPE_FILES = 0.08;        // a file touched by more than this share of commits says nothing about a scope
const ALIAS_MIN = 0.6;           // evidence a link needs
/* Said of a name in a commit subject: what it is kept as, or was renamed to.
 * Bodies are left out - "becomes" and "is now" in a body describe behaviour. */
const SUCCESSION = /\b(?:kept for|kept as|renamed(?: to)?|now called|was called|formerly|replaced by)\b/;
/* A single word stands for a concept only when it is a name, not a verb of talk. */
const VERBISH = /(?:ed|ing)$/;
const VERBS = new Set(('kept keep change changes make made build built run runs use used save saves set get start stop add show hold holds need needs find found ' +
  'decide decides decision decisions reject reason reasons rationale history timeline happen happens move moves return returns belong belongs ' +
  'link links linked work works mean means come comes go goes say says know knows').split(' '));
const NEGATION = (q) => new RegExp('\\b(?:not|rather than|instead of|unlike)\\s+(?:the\\s+)?' + q.replace(/ /g, '[\\s_-]+') + '\\b');

/* ---------------------------------------------------------------- lens */

/* The shape a question asks for, from the words that OPEN it. An asking
 * word further in is usually part of the sentence, not the question: "is it
 * possible ... a folder where the details are stored" asks no where, and
 * "how is it linked - when does a thought move" asks a how; "when does X"
 * is a condition, only "when did / was / were" a date (tune2 and cases, where
 * a word read anywhere lost two answers). */
export function lensOf(query) {
  const q = " " + String(query || "").toLowerCase().replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ") + " ";
  const open = " " + q.trim().split(" ").slice(0, 4).join(" ") + " ";
  if (/ (why|reason|reasons|rationale) /.test(open)) return "why";
  if (/^ how (was|were|did we|did you|have we) .*(decid|chose|chos|choice|settl|agree|reject|turned down)/.test(q)) return "why";
  if (/^ what (was|were|did we|have we|is|are)? ?(decid|reject|settled|turned down|the reason|the trade)/.test(q) || /^ what [a-z ]{0,30} (decided|rejected) /.test(q)) return "why";
  if (/ (when (did|was|were|has|have)|since when|how long) /.test(open) || /^ (timeline|history) /.test(q) || / (timeline|history) of /.test(open)) return "when";
  if (/ (where|which file|which function|locate|location of) /.test(open) || / how (many|much) /.test(open)) return "where";
  if (/ how /.test(open) || /^ when /.test(q)) return "how";
  if (/ (what|explain|describe|overview|tell me about|introduce|give me an overview) /.test(open)) return "what";
  return null;
}

/* --------------------------------------------------------------- model */

const cache = new Map();         // repoDir -> { sig, model }

function signature(repoDir) {
  let head = '';
  try { head = git(repoDir, ['rev-parse', 'HEAD']).trim(); } catch (_) {}
  let n = 0, latest = 0;
  for (const sub of ['thoughts', path.join('context', 'thoughts'), path.join('context', 'topics')]) {
    const d = path.join(repoDir, '.gitx', sub);
    for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) { n++; try { latest = Math.max(latest, fs.statSync(path.join(d, f)).mtimeMs); } catch (_) {} }
  }
  return head + ':' + n + ':' + latest;
}

export function lensModel(repoDir) {
  const sig = signature(repoDir);
  const hit = cache.get(repoDir);
  if (hit && hit.sig === sig) return hit.model;
  const rx = rankIndexFor(repoDir), cx = buildCodeIndex(repoDir);
  /* The branch a thought was thought on: a feature's own name for its work
   * (4th_Dimension), and evidence a thought belongs to it even when its text
   * never says so. */
  const branchOf = new Map();
  for (const store of ['thought', 'context']) for (const t of loadThoughts(repoDir, { store }).thoughts) if (t.anchor && t.anchor.branch) branchOf.set(t.id, String(t.anchor.branch).toLowerCase().replace(/[_/-]+/g, ' '));
  const records = [];
  for (const n of rx.nodes.values()) {
    let text = n.text || '', created = n.created;
    if (n.layer === 'commit') { const c = cx.commits.get(n.id.slice(0, 12)); if (c) { text += '\n' + (c.body || ''); created = c.date; } }
    else text += '\n' + (n.held || []).join(' ');
    records.push({ id: n.id, layer: n.layer, n, topic: n.topic || null, created: String(created || ''), text: text.toLowerCase(), branch: branchOf.get(n.id) || '' });
  }
  for (const t of rx.topics.values()) records.push({ id: t.id, layer: 'topic', topic: t.id, created: String(t.created || ''), text: (t.title + '\n' + ((t.digest && t.digest.text) || '')).toLowerCase() });
  const model = { repoDir, rx, cx, records, byId: new Map(records.map((r) => [r.id, r])), hits: new Map() };
  model.aliases = aliasesOf(model);
  cache.set(repoDir, { sig, model });
  return model;
}

const reOf = (words) => new RegExp('\\b' + words.map((w) => w.replace(/(?:es|s)$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:s|es)?').join('[\\s_-]+') + '\\b');
function hitsOf(model, phrase) {
  if (!model.hits.has(phrase)) { const re = reOf(phrase.split(' ')); model.hits.set(phrase, model.records.filter((r) => re.test(r.text))); }
  return model.hits.get(phrase);
}
const firstOf = (rs) => rs.map((r) => r.created).filter(Boolean).sort()[0] || '';
const specific = (model, phrase) => hitsOf(model, phrase).length <= model.records.length * SPECIFIC;

/* -------------------------------------------------------------- names */

/* Links between names, from three structural signs in the history. Each
 * link is a pair of phrases with the evidence for it; both directions. */
function aliasesOf(model) {
  const { repoDir } = model;
  const links = new Map();       // phrase -> Map(phrase -> { score, evidence: [] })
  const add = (a, b, score, why) => {
    if (!a || !b || a === b) return;
    for (const [x, y] of [[a, b], [b, a]]) {
      if (!links.has(x)) links.set(x, new Map());
      const e = links.get(x).get(y) || { score: 0, evidence: [] };
      e.score = Math.min(1, e.score + score);
      if (!e.evidence.includes(why)) e.evidence.push(why);
      links.get(x).set(y, e);
    }
  };
  let log = '';
  try { log = git(repoDir, ['log', '--no-renames', '--name-status', '--format=\x1e%h\x1f%as\x1f%s']); } catch (_) { return links; }
  const commits = log.split('\x1e').filter(Boolean).map((rec) => {
    const [head, ...rest] = rec.split('\n');
    const [hash, date, subject] = head.split('\x1f');
    const files = rest.map((l) => l.split('\t')).filter((p) => p.length >= 2).map(([s, f]) => ({ s: s[0], f }));
    const m = subject.match(/^\w+\(([a-z0-9-]+)\)/);
    return { hash, date, subject, scope: m ? m[1] : null, files };
  });
  const words = (f) => path.basename(f).replace(/\.[^.]+$/, '').toLowerCase().split(/[-_.]+/).filter(Boolean);
  /* 1. A file replaced in one commit by one named like it. */
  const renamed = new Map();     // old file -> new file
  for (const c of commits) {
    const gone = c.files.filter((x) => x.s === 'D'), came = c.files.filter((x) => x.s === 'A');
    for (const d of gone) for (const a of came) {
      if (path.dirname(d.f) !== path.dirname(a.f) || path.extname(d.f) !== path.extname(a.f)) continue;
      const wd = words(d.f), wa = words(a.f);
      const shared = wd.filter((w) => wa.includes(w));
      const was = wd.filter((w) => !wa.includes(w)), now = wa.filter((w) => !wd.includes(w));
      if (!shared.length || !was.length || !now.length || was.length > 2 || now.length > 2) continue;
      renamed.set(d.f, a.f);
      add(was.join(' '), now.join(' '), 0.7, c.hash + ' replaced ' + path.basename(d.f) + ' with ' + path.basename(a.f));
      add(wd.join(' '), wa.join(' '), 0.7, c.hash + ' replaced ' + path.basename(d.f) + ' with ' + path.basename(a.f));
    }
  }
  /* 2. One scope ending where another on the same files begins. */
  const fileUse = new Map();
  for (const c of commits) for (const x of c.files) fileUse.set(x.f, (fileUse.get(x.f) || 0) + 1);
  const scopes = new Map();
  for (const c of [...commits].reverse()) {
    if (!c.scope) continue;
    const s = scopes.get(c.scope) || { first: c.date, last: c.date, files: new Set() };
    s.last = c.date;
    for (const x of c.files) if (fileUse.get(x.f) <= commits.length * SCOPE_FILES) s.files.add(renamed.get(x.f) || x.f);
    scopes.set(c.scope, s);
  }
  for (const [a, sa] of scopes) for (const [b, sb] of scopes) {
    if (a >= b || !sa.files.size || !sb.files.size) continue;
    const [early, late, se, sl] = sa.last <= sb.first ? [a, b, sa, sb] : sb.last <= sa.first ? [b, a, sb, sa] : [];
    if (!early) continue;
    const shared = [...se.files].filter((f) => sl.files.has(f));
    if (shared.length / Math.min(se.files.size, sl.files.size) < 0.3) continue;
    add(early, late, 0.4, 'scope ' + early + ' (to ' + se.last + ') then ' + late + ' (from ' + sl.first + ') on ' + shared.slice(0, 2).map((f) => path.basename(f)).join(', '));
  }
  /* 3. A record naming both, with a word of succession. Scopes and replaced
   * names are the candidates; the record says which phrase they became. */
  const names = new Set([...scopes.keys(), ...links.keys()].filter((p) => p.length >= 4));
  for (const c of commits) {
    if (!c.scope || !names.has(c.scope)) continue;
    const text = c.subject.toLowerCase();
    const m = text.match(SUCCESSION);
    if (!m) continue;
    const after = text.slice(m.index + m[0].length).match(/^\s*([a-z0-9][a-z0-9 -]{2,40}?)(?:[,.;:()]|\s-\s|$)/);
    if (!after) continue;
    const phrase = after[1].trim().split(/\s+/).slice(0, 3).filter((w) => !STOP.has(w)).join(' ');
    if (phrase && phrase !== c.scope && specific(model, phrase)) add(c.scope, phrase, 0.6, c.hash + ': "' + cap(c.subject, 80) + '"');
  }
  /* A link a record rules out with "not X" is dropped. */
  for (const [a, m] of links) for (const b of [...m.keys()]) {
    const neg = NEGATION(b);
    if (hitsOf(model, a).some((r) => neg.test(r.text))) m.delete(b);
  }
  return links;
}

/* The names linked to a phrase, through one other name at most. */
export function namesFor(model, phrase) {
  const out = new Map();
  const direct = model.aliases.get(phrase) || new Map();
  for (const [b, e] of direct) if (e.score >= ALIAS_MIN) out.set(b, e);
  /* trails -> paths -> ... only by a strong first step. */
  for (const [b, e] of direct) if (e.score >= ALIAS_MIN) for (const [c, e2] of model.aliases.get(b) || []) {
    const s = Math.min(e.score, e2.score) * 0.8;
    if (c !== phrase && !out.has(c) && s >= ALIAS_MIN * 0.8) out.set(c, { score: s, evidence: [...e.evidence, ...e2.evidence] });
  }
  /* A phrase's words carry their own links: "path knowledge" meets trails
   * through "path" only when the link names the whole phrase or a scope. */
  return out;
}

/* ---------------------------------------------------------- concepts */

/* The concepts a question names: its longest phrases found in the record,
 * each with its records and those of its other names. */
export function conceptsOf(model, query) {
  const toks = String(query || '').toLowerCase().replace(/'s\b/g, ' ').match(/[a-z0-9]+/g) || [];
  const runs = []; let cur = [];
  for (const t of toks) { if (ASKING.has(t) || STOP.has(t) || FACETS.has(t)) { if (cur.length) runs.push(cur); cur = []; } else cur.push(t); }
  if (cur.length) runs.push(cur);
  const found = [];
  for (const run of runs) for (let n = Math.min(3, run.length); n >= 1; n--) for (let i = 0; i + n <= run.length; i++) {
    const words = run.slice(i, i + n);
    if (n === 1 && (/^\d/.test(words[0]) || words[0].length < 4 || VERBS.has(words[0]) || VERBISH.test(words[0]))) continue;
    if (n > 1 && (VERBS.has(words[n - 1]) || VERBISH.test(words[n - 1]) || VERBS.has(words[0]))) continue;
    const phrase = words.join(' ');
    if (found.some((f) => f.phrase.includes(phrase))) continue;
    const own = hitsOf(model, phrase);
    if (own.length < 2) continue;
    found.push({ phrase, own });
  }
  return found.map((c) => {
    const names = new Map();
    for (const [b, e] of namesFor(model, c.phrase)) names.set(b, e);
    /* One word of a phrase may carry a link of its own (trail in "trail recorder"). */
    for (const w of c.phrase.split(' ')) for (const [b, e] of namesFor(model, w)) if (!names.has(b) && b.includes(' ')) names.set(b, e);
    const all = new Map(c.own.map((r) => [r.id, r]));
    /* A concept named like a branch holds what was thought on that branch. */
    const onBranch = c.phrase.includes(' ') || c.phrase.length >= 6 ? model.records.filter((r) => r.branch && reOf(c.phrase.split(' ')).test(r.branch)) : [];
    for (const r of onBranch) all.set(r.id, r);
    for (const b of names.keys()) if (specific(model, b)) for (const r of hitsOf(model, b)) all.set(r.id, r);
    return { phrase: c.phrase, own: c.own.length, branch: onBranch.length, records: [...all.values()], names, first: firstOf(c.own) };
  });
}

/* The subject: the narrowest concept; the rest are its context. A concept
 * as common as a word of talk is neither. */
export function subjectOf(model, query) {
  const cs = conceptsOf(model, query).filter((c) => c.own >= 3 && c.own <= model.records.length * 0.25);
  if (!cs.length) return null;
  cs.sort((a, b) => a.records.length - b.records.length);
  /* A question that lists parts beside their whole - "the 4th Dimension:
   * layers, stack, the agent's walk, path knowledge" - is about the whole: a
   * concept whose records hold at least half of two others' is their container
   * and the subject. Otherwise the narrowest is. */
  const holds = (big, small) => { const ids = new Set(big.records.map((r) => r.id)); return small.records.filter((r) => ids.has(r.id)).length >= 0.5 * small.records.length; };
  const container = cs.length >= 3 ? cs.slice().reverse().find((c) => cs.filter((o) => o !== c && holds(c, o)).length >= 2) : null;
  const subject = container || cs[0], context = cs.filter((c) => c !== subject);
  /* Nested: the subject lives inside one broader concept - "the 4th Dimension's
   * path knowledge". Only then does the context count for less; a question
   * that names several things side by side keeps every word at full weight,
   * since lowering them moved its code search (cf-link, cf-domain on the bench). */
  const ids = new Set(subject.records.map((r) => r.id));
  const nested = context.length === 1 && context[0].records.filter((r) => ids.has(r.id)).length >= 0.5 * ids.size;
  return { subject, context, nested };
}

/* Is the question about the concept itself - "what is the 4th Dimension",
 * "explain path knowledge" - or about something in it? Broad when the
 * subject's and context's phrases hold nearly all of its words. A "what"
 * that asks for a detail is answered as any other question: given an
 * overview first, held-out answers moved down or out (bench, wording 1). */
export function isBroad(query, found) {
  if (!found) return false;
  const toks = (String(query || '').toLowerCase().replace(/'s\b/g, ' ').match(/[a-z0-9]+/g) || []).filter((t) => !ASKING.has(t) && !STOP.has(t) && !FACETS.has(t));
  if (!toks.length) return false;
  const held = new Set([found.subject, ...found.context].flatMap((c) => c.phrase.split(' ')));
  return toks.filter((t) => held.has(t)).length >= 0.7 * toks.length;
}

/* Words to search with, beyond the question's: the subject's other names,
 * and the context at less than the subject. */
export function weightsFor(found, { alias = 0.6, context = 0.5 } = {}) {
  const out = new Map();
  if (!found) return out;
  for (const [b, e] of found.subject.names) for (const w of b.split(' ')) if (w.length >= 3) out.set(stem(w), Math.max(out.get(stem(w)) || 0, alias * e.score));
  if (found.nested) for (const c of found.context) for (const w of c.phrase.split(' ')) if (w.length >= 3 && !/^\d/.test(w)) out.set(stem(w), context);
  return out;
}

/* ------------------------------------------------------------ answers */

const degree = (model, id) => (model.rx.adj.get(id) || []).length;
export const thoughtsIn = (rs) => rs.filter((r) => (r.layer === 'thought' || r.layer === 'context') && r.n);
const tie = (model, rs, ctx) => (ctx && ctx.length ? rs.filter((r) => ctx.some((c) => c.records.some((x) => x.id === r.id))) : []);
const firstSentence = (s, n) => cap(String(s || '').split(/(?<=[.!?])\s/)[0], n);

/* Every kind of thought has one place: what it is decides which lens
 * carries it (t-58927692a8). */
export function kindOf(n) {
  if (n.outcome === 'rejected' || n.outcome === 'stashed') return 'rejected';
  if (n.outcome === 'open') return 'open';
  if (n.kind === 'cost') return 'constraint';
  if (n.kind === 'learned') return 'rule';
  if (n.kind === 'finding') return 'finding';
  return 'decided';
}

/* The thoughts an answer chooses from: the subject's own, and those the word
 * search ranked for this question (seed), which come first in their kind -
 * so the one thought a question is about is not lost to a better-linked one. */
export function focusTopic(records) {
  const n = new Map();
  for (const r of records) if (r.topic && r.layer !== 'topic') n.set(r.topic, (n.get(r.topic) || 0) + 1);
  const all = [...n.values()].reduce((a, b) => a + b, 0);
  const top = [...n].sort((a, b) => b[1] - a[1])[0];
  return top && top[1] >= 0.5 * all && top[1] >= 3 ? top[0] : null;
}
export function poolOf(model, found, seed) {
  const pool = new Map();
  for (const id of seed || []) { const r = model.byId.get(id); if (r && r.n && (r.layer === 'thought' || r.layer === 'context')) pool.set(id, r); }
  if (found) for (const r of thoughtsIn(found.subject.records)) if (!pool.has(r.id)) pool.set(r.id, r);
  /* A subject that is mostly one topic is that topic: its thoughts count even
   * when they never say the phrase. "path knowledge" named none of its four
   * rejected ideas, all filed under Path knowledge. */
  const t = found && focusTopic(found.subject.records);
  if (t) for (const r of model.records) if (r.topic === t && r.n && (r.layer === 'thought' || r.layer === 'context') && !pool.has(r.id)) pool.set(r.id, r);
  return [...pool.values()];
}
export function rankWith(model, seed, ctxIds = new Set()) {
  const at = new Map((seed || []).map((id, i) => [id, i]));
  const s = (r) => (at.has(r.id) ? at.get(r.id) : 1e6);
  return (a, b) => s(a) - s(b) || (ctxIds.has(b.id) - ctxIds.has(a.id)) || (b.n.decided_by === 'user') - (a.n.decided_by === 'user') ||
    degree(model, b.id) - degree(model, a.id) || String(b.created).localeCompare(String(a.created));
}
export const item = (model, r, n = 140) => ({ id: r.id, status: statusOf(model.rx, r.n), text: cap(r.n.text, n) });

/* The one line every lens may carry: what the subject is, and its other names. */
export function briefOf(model, found) {
  if (!found) return undefined;
  const S = found.subject;
  const tops = new Map();
  for (const r of S.records) if (r.topic) tops.set(r.topic, (tops.get(r.topic) || 0) + 1);
  const top = [...tops].sort((a, b) => b[1] - a[1])[0];
  const t = top && model.rx.topics.get(top[0]);
  const is = t && t.digest && top[1] >= 0.5 * [...tops.values()].reduce((x, y) => x + y, 0) ? firstSentence(t.digest.text, 170) : undefined;
  return { subject: S.phrase, also_called: S.names.size ? [...S.names.keys()] : undefined, within: found.nested ? found.context.map((c) => c.phrase) : undefined, is };
}

/* Code a set of thoughts' commits wrote most of: names only, never lines. */
export function mainCode(model, rs, n = 3) {
  const commits = new Set(rs.map((r) => r.n.commit).filter(Boolean).map((h) => h.slice(0, 12)));
  if (!commits.size) return [];
  const scored = [];
  for (const g of model.cx.regions) { let s = 0; for (const [c, k] of Object.entries(g.commits || {})) if (commits.has(c)) s += k; if (s >= 3) scored.push([g, s]); }
  return scored.sort((a, b) => b[1] - a[1]).slice(0, n).map(([g]) => path.basename(g.file) + ' · ' + shortName(g));
}

/* what: the parts, and in each one or two of every kind - decided, rejected,
 * a constraint, a rule, an open question - and its main code by name. No
 * code lines, no reasons, no dates: those are how, why and when. */
export function overviewOf(model, found, { seed = [], parts = 8, code = [], caps = {} } = {}) {
  const S = found.subject;
  const pool = poolOf(model, found, seed);
  const order = rankWith(model, seed);
  const byTopic = new Map();
  for (const r of S.records) { const t = r.topic || ''; byTopic.set(t, (byTopic.get(t) || 0) + 1); }
  const top = [...byTopic].filter(([t]) => t).sort((a, b) => b[1] - a[1]);
  const focused = top.length && top[0][1] >= 0.6 * top.reduce((s, [, n]) => s + n, 0);
  const k1 = caps.each || 1;
  const want = { decided: 2 * k1, rejected: k1, constraint: k1, rule: k1, open: k1 };
  const kinds = (rs) => {
    const out = {}, more = {};
    for (const k of Object.keys(want)) {
      const all = rs.filter((r) => kindOf(r.n) === k).sort(order);
      if (all.length) out[k] = all.slice(0, want[k]).map((r) => item(model, r));
      if (all.length > want[k]) more[k] = all.length - want[k];
    }
    return { ...out, more: Object.keys(more).length ? Object.entries(more).map(([k, v]) => v + ' ' + k).join(', ') : undefined };
  };
  const partOf = (tid) => {
    const t = model.rx.topics.get(tid);
    const rs = pool.filter((r) => r.topic === tid);
    const code = mainCode(model, rs);
    return { part: t ? t.title : tid, topic: tid, is: t && t.digest ? firstSentence(t.digest.text, 160) : undefined, ...kinds(rs), main_code: code.length ? code : undefined };
  };
  const out = { subject: S.phrase };
  out.parts = (focused ? top.slice(0, 3) : top.slice(0, caps.parts || parts)).map(([tid]) => partOf(tid));
  const loose = pool.filter((r) => !r.topic);
  if (loose.length) out.not_in_a_topic = kinds(loose);
  /* What the word search found for this very question - the code it landed
   * on, by name, and its closest thoughts of any kind. A "what is X" about one
   * thing is often answered there (held-out: a function name, a finding),
   * and the parts above choose by kind and could leave it out. */
  const names = [...new Set((code || []).map((e) => String(e).replace(/ \(tree below\)$/, '').replace(/\s+\d+-\d+$/, '')))].slice(0, 6);
  if (names.length) out.main_code = names;
  const listed = new Set(JSON.stringify(out).match(/t-[0-9a-f]{10}/g) || []);
  const closest = (seed || []).filter((id) => !listed.has(id)).map((id) => model.byId.get(id)).filter((r) => r && r.n).slice(0, caps.closest || 5);
  if (closest.length) out.closest_to_your_question = closest.map((r) => ({ ...item(model, r), kind: kindOf(r.n) }));
  out.go_deeper = 'how / where / when / why about a part, by its name';
  return out;
}

/* when: the subject's commits in order under every name it had, each with
 * its reason in a sentence and what it settled, and the open questions in
 * the order they were raised. No code. */
export function timelineOf(model, found, { max = 14 } = {}) {
  const S = found.subject;
  const settledBy = new Map();
  for (const r of thoughtsIn(S.records)) if (r.n.commit) { const l = settledBy.get(r.n.commit) || []; l.push(r.id); settledBy.set(r.n.commit, l); }
  const ids = new Set([...S.records.filter((r) => r.layer === 'commit').map((r) => r.id), ...settledBy.keys()]);
  const commits = [...ids].map((h) => model.byId.get(h)).filter(Boolean).sort((a, b) => a.created.localeCompare(b.created));
  const pick = commits.length > max ? [...commits.slice(0, 4), ...commits.slice(-(max - 4))] : commits;
  const reasonOf = (h) => { const c = model.cx.commits.get(h.slice(0, 12)); const body = c && c.body ? c.body.split(/\n\s*\n/).find((p) => !/^[\w-]+:\s/.test(p.trim())) : ''; return body ? firstSentence(body.replace(/\s+/g, ' '), 150) : undefined; };
  const steps = pick.map((r) => ({ date: r.created.slice(0, 10), commit: r.id.slice(0, 7), subject: cap(r.n.text, 90), reason: reasonOf(r.id), settled: settledBy.get(r.id) }));
  const opened = thoughtsIn(S.records).filter((r) => kindOf(r.n) === 'open').sort((a, b) => a.created.localeCompare(b.created)).slice(-3);
  for (const r of opened) steps.push({ date: String(r.created).slice(0, 10), open: r.id, text: cap(r.n.text, 120) });
  steps.sort((a, b) => a.date.localeCompare(b.date));
  return {
    names: [S.phrase, ...S.names.keys()].map((p) => { const h = hitsOf(model, p); return p + ': ' + firstOf(h).slice(0, 10) + ' to ' + (h.map((r) => r.created).filter(Boolean).sort().pop() || '').slice(0, 10); }),
    steps,
    skipped: commits.length > pick.length ? commits.length - pick.length + ' commits in the middle - gitx_graph_chain gives them' : undefined
  };
}

/* why: every kind of thinking about the subject - decided with its reasons
 * and the finding it rests on, rejected and stashed with what held them
 * back, constraints, rules, open questions, and evidence. No code, no dates. */
export function reasonsOf(model, found, { seed = [], caps = {} } = {}) {
  const x = caps.each || 1, up = (n) => Math.max(1, Math.round(n * x));
  const pool = poolOf(model, found, seed);
  const ctxIds = found ? new Set(tie(model, pool, found.context).map((r) => r.id)) : new Set();
  const order = rankWith(model, seed, ctxIds);
  const forces = (id, dir, n) => { const raw = readThought(model.repoDir, id); return ((raw && raw.forces) || []).filter((f) => f.direction === dir).slice(0, n).map((f) => cap(f.text, 160)); };
  const evidenceFor = (id) => {
    for (const e of model.rx.adj.get(id) || []) { const n = model.rx.nodes.get(e.to); if (n && n.kind === 'finding' && /supports/.test(e.type)) return { id: e.to, text: cap(n.text, 130) }; }
    return undefined;
  };
  const sel = (k, n, add) => { const rs = pool.filter((r) => kindOf(r.n) === k).sort(order).slice(0, n); return rs.length ? rs.map((r) => ({ ...item(model, r, 180), ...add(r) })) : undefined; };
  const nz = (a) => (a && a.length ? a : undefined);
  const decided = sel('decided', up(5), (r) => ({ because: nz(forces(r.id, 'forward', 2)), evidence: evidenceFor(r.id) }));
  const used = new Set((decided || []).map((d) => d.evidence && d.evidence.id).filter(Boolean));
  return {
    decided,
    rejected: sel('rejected', up(3), (r) => ({ held_back: nz(forces(r.id, 'backward', 1)) })),
    constraints: sel('constraint', up(3), (r) => ({ because: nz(forces(r.id, 'forward', 1)) })),
    rules: sel('rule', up(3), (r) => ({ because: nz(forces(r.id, 'forward', 1)) })),
    open: sel('open', up(3), () => ({})),
    evidence: nz(pool.filter((r) => kindOf(r.n) === 'finding' && !used.has(r.id)).sort(order).slice(0, up(2)).map((r) => item(model, r, 160)))
  };
}

/* how: the rules, constraints and rejected alternatives on a piece of code -
 * settled by a commit that wrote it, linked to a thought that was, or naming
 * the function or its file. */
export function onCodeOf(model, file, from, { n = 3 } = {}) {
  const g = model.cx.regions.find((x) => x.file === file && x.from <= from && x.to >= from);
  if (!g) return undefined;
  const commits = new Set(Object.keys(g.commits || {}));
  const settledHere = new Set(model.records.filter((r) => r.n && r.n.commit && commits.has(r.n.commit.slice(0, 12))).map((r) => r.id));
  const name = shortName(g), base = path.basename(file).replace(/\.[^.]+$/, '');
  const named = (t) => (name.length >= 5 && new RegExp('\\b' + name.replace(/[^\w$]/g, '') + '\\b').test(t)) || (base.length >= 5 && t.includes(base));
  const hits = model.records.filter((r) => r.n && ['rule', 'constraint', 'rejected'].includes(kindOf(r.n)) &&
    (settledHere.has(r.id) || (model.rx.adj.get(r.id) || []).some((e) => settledHere.has(e.to)) || named(r.text)));
  return hits.length ? hits.sort((a, b) => degree(model, b.id) - degree(model, a.id)).slice(0, n).map((r) => ({ [kindOf(r.n)]: r.id, text: cap(r.n.text, 140) })) : undefined;
}

function readThought(repoDir, id) {
  for (const sub of ['thoughts', path.join('context', 'thoughts')]) {
    const f = path.join(repoDir, '.gitx', sub, id + '.json');
    if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (_) { return null; } }
  }
  return null;
}
