/*
 * The context map's structure: domains, topics and the goal - step 2 of
 * docs/context-map-plan.md.
 *
 *   .gitx/context/topics/tp-<slug>.json   one topic of work
 *   .gitx/context/goal.json               what the user is working toward, and
 *                                         which topics and domains are active
 *   .gitx/context/thoughts/t-<id>.json    as before, plus "topic": "tp-<slug>",
 *                                         and "domain" only when placed by hand
 *
 * DOMAINS are kinds of content - the owner's sectioning of 23 September
 * (t-6b0a5fa325) - and the same in every repository, so they live here, not
 * on disk. A thought's domain follows from its kind and outcome, which keeps
 * it right as the thought changes: an open question that gets answered stops
 * being a question without anyone moving it. A "domain" field on the thought
 * overrides the rule, for what is plainly something else - a requirement the
 * user set is a goal, a finding that is a defect is a bug.
 *
 * A TOPIC is one subject of work. It appears as a hub in every domain holding
 * its thoughts. Its file holds what is about the topic itself; which thoughts
 * belong to it is said by each thought, the side that makes the link, as
 * links are everywhere else here.
 *
 * The GOAL decides what is active: its topics, in every domain not switched
 * off. The active part is what agents read (t-3decb21a95). Domains are listed
 * when OFF, so a domain added later starts on.
 *
 * mcp/assign-topics.js writes topics; writeGoal below is the one write here,
 * for the context map's own controls.
 */

import fs from 'node:fs';
import path from 'node:path';

export const TOPIC_SCHEMA = 'gitx.topic/0';
export const GOAL_SCHEMA = 'gitx.goal/0';

export const DOMAINS = [
  { id: 'goals',       name: 'Goals & requirements' },
  { id: 'discussion',  name: 'Thoughts & discussion' },
  { id: 'information', name: 'Information' },
  { id: 'constraints', name: 'Constraints' },
  { id: 'criteria',    name: 'Criteria' },
  /* What is to be built and in what order: decisions that make up the plan.
   * Only by placement - no kind of thought lands here by itself. */
  { id: 'planning',    name: 'Implementation & planning' },
  /* Floating: unconnected on the map until an agent uses a node in them. */
  { id: 'rules',       name: 'Rules', floating: true },
  { id: 'questions',   name: 'Bugs & open questions', floating: true },
  { id: 'stashed',     name: 'Stashed', floating: true }
];
const DOMAIN_IDS = new Set(DOMAINS.map((d) => d.id));
export const isDomain = (id) => DOMAIN_IDS.has(id);
export const isFloating = (id) => DOMAINS.some((d) => d.id === id && d.floating);

/* The domain a thought's kind and outcome put it in. */
export function domainByKind(t) {
  if (t.outcome === 'open') return 'questions';
  if (t.outcome === 'stashed') return 'stashed';
  if (t.kind === 'learned') return 'rules';
  if (t.kind === 'cost') return 'constraints';
  if (t.kind === 'finding') return 'information';
  return 'discussion';
}
export function domainOf(t) {
  return t.domain && isDomain(t.domain) ? t.domain : domainByKind(t);
}

export function mapPaths(repoDir) {
  const base = path.join(repoDir, '.gitx', 'context');
  return { topics: path.join(base, 'topics'), goal: path.join(base, 'goal.json') };
}

/* Every topic on disk. A file that is not one is skipped and said, as a bad
 * thought file is. */
export function loadTopics(repoDir) {
  const dir = mapPaths(repoDir).topics;
  const topics = [], unreadable = [];
  let newest = 0, names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch (_) { /* none yet */ }
  for (const f of names) {
    const file = path.join(dir, f);
    try {
      newest = Math.max(newest, fs.statSync(file).mtimeMs);
      const t = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!t || t.schema !== TOPIC_SCHEMA || !t.id || !t.title) { unreadable.push({ file: f, why: 'not a topic: needs schema "' + TOPIC_SCHEMA + '", id and title' }); continue; }
      topics.push(t);
    } catch (err) { unreadable.push({ file: f, why: 'not valid JSON: ' + err.message }); }
  }
  return { topics, unreadable, newest };
}

export function loadGoal(repoDir) {
  const file = mapPaths(repoDir).goal;
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch (_) { return { goal: null, newest: 0 }; }
  let newest = 0;
  try { newest = fs.statSync(file).mtimeMs; } catch (_) { /* gone meanwhile */ }
  try {
    const g = JSON.parse(raw);
    if (g && g.schema === GOAL_SCHEMA) return { goal: { text: g.text || '', set_by: g.set_by || null, at: g.at || null, topics: Array.isArray(g.topics) ? g.topics : [], domains_off: Array.isArray(g.domains_off) ? g.domains_off : [] }, newest };
  } catch (_) { /* unreadable: no goal */ }
  return { goal: null, newest, unreadable: 'goal.json is not a goal (schema "' + GOAL_SCHEMA + '")' };
}

/* What is active: a topic the goal names, in a domain not switched off.
 * Floating domains are never active or dormant - they float. */
export function isActive(goal, topicId, domainId) {
  if (!goal || isFloating(domainId)) return false;
  return goal.topics.includes(topicId) && !goal.domains_off.includes(domainId);
}

/* Change the goal: its text, its active topics, the domains switched off.
 * Only what is passed changes. Everything is checked before anything is
 * written - a topic that does not exist, a domain that is not one, a floating
 * domain (it cannot be switched), a text too long to be a goal - and written
 * through a temporary name. Returns the goal as it now is. */
export const GOAL_TEXT_MAX = 200;
export function writeGoal(repoDir, patch, { by = 'user' } = {}) {
  const { goal: old } = loadGoal(repoDir);
  const known = new Set(loadTopics(repoDir).topics.map((t) => t.id));
  const problems = [];
  const next = {
    text: old ? old.text : '', topics: old ? old.topics.slice() : [], domains_off: old ? old.domains_off.slice() : []
  };
  if (patch.text !== undefined) {
    const text = String(patch.text).replace(/\s+/g, ' ').trim();
    if (!text) problems.push('a goal needs some text');
    else if (text.length > GOAL_TEXT_MAX) problems.push('a goal is at most ' + GOAL_TEXT_MAX + ' characters');
    else next.text = text;
  }
  if (patch.topics !== undefined) {
    if (!Array.isArray(patch.topics)) problems.push('topics must be a list of topic ids');
    else {
      for (const id of patch.topics) if (!known.has(id)) problems.push('no topic "' + id + '"');
      next.topics = [...new Set(patch.topics)];
    }
  }
  if (patch.domains_off !== undefined) {
    if (!Array.isArray(patch.domains_off)) problems.push('domains_off must be a list of domain ids');
    else {
      for (const id of patch.domains_off) {
        if (!isDomain(id)) problems.push('"' + id + '" is not a domain');
        else if (isFloating(id)) problems.push(id + ' floats: it is never switched on or off');
      }
      next.domains_off = [...new Set(patch.domains_off)];
    }
  }
  if (problems.length) return { ok: false, problems };
  const goal = { schema: GOAL_SCHEMA, text: next.text, set_by: by, at: new Date().toISOString(), topics: next.topics, domains_off: next.domains_off };
  const file = mapPaths(repoDir).goal;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(goal, null, 2) + '\n');
  fs.renameSync(tmp, file);
  return { ok: true, goal: loadGoal(repoDir).goal };
}

/* "GitX suggests": the topics a goal's words point at. A topic scores for
 * each of the goal's words in its title (strongly) and in its thoughts' text
 * (by how many of them carry it), and a little for being worked on lately.
 * Suggested are the ones near the best; the rest are ranked, never hidden -
 * the user decides. `thoughts` are the context graph's, with their topics. */
const STOP = new Set('the a an and or of to in on for with from by at is are be it this that as into about what how our its their we you i build make work'.split(' '));
const wordsOf = (s) => (String(s || '').toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((w) => !STOP.has(w));
const stem = (w) => w.replace(/(ings|ing|ies|es|s|ed)$/, '');
export function suggestTopics(goalText, thoughts, topics, { now = Date.now() } = {}) {
  const goal = [...new Set(wordsOf(goalText).map(stem))];
  const out = topics.map((tp) => {
    const own = thoughts.filter((t) => t.topic === tp.id);
    const title = new Set(wordsOf(tp.title).map(stem));
    const texts = own.map((t) => new Set(wordsOf(t.text).map(stem)));
    let score = 0;
    const why = [];
    for (const w of goal) {
      if (title.has(w)) { score += 3; why.push(w); }
      const n = texts.filter((s) => s.has(w)).length;
      if (n) { score += Math.min(2, n / Math.max(3, own.length) * 4); if (!title.has(w)) why.push(w); }
    }
    const newest = Math.max(0, ...own.map((t) => Date.parse(t.created || '') || 0));
    if (score > 0 && now - newest < 3 * 86400000) score += 0.5;
    return { id: tp.id, title: tp.title, score: Math.round(score * 100) / 100, matched: [...new Set(why)] };
  }).sort((a, b) => b.score - a.score);
  const best = out.length ? out[0].score : 0;
  return { ranked: out, suggested: best > 0 ? out.filter((t) => t.score >= best * 0.45).slice(0, 4).map((t) => t.id) : [] };
}

/* The map in one piece, for the page and, later, for what agents read.
 * `thoughts` are the context graph's, as loadThoughts returns them. */
export function contextMap(repoDir, thoughts) {
  const { topics, unreadable, newest: tNewest } = loadTopics(repoDir);
  const { goal, newest: gNewest } = loadGoal(repoDir);
  const known = new Set(topics.map((t) => t.id));
  const placed = thoughts.map((t) => ({ id: t.id, topic: known.has(t.topic) ? t.topic : null, domain: domainOf(t) }));
  return {
    domains: DOMAINS,
    topics: topics.map((t) => ({
      id: t.id, title: t.title, status: t.status || 'open', waiting_for: t.waiting_for || null,
      revisit_if: t.revisit_if || null, digest: t.digest || null, owner: t.owner || null,
      thoughts: placed.filter((p) => p.topic === t.id).length
    })),
    goal,
    placed,
    unsorted: placed.filter((p) => !p.topic).map((p) => p.id),
    unreadable,
    /* For the page's refetch signature: a topic or the goal changing moves it. */
    newest: Math.max(tNewest, gNewest)
  };
}
