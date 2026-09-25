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
 * A reader only; mcp/assign-topics.js writes.
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
