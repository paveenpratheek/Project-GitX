/*
 * Which of an agent's walks are one search, and which walk an event belongs
 * to - shared by path learning (walk-learn.js) and thermal (thermal.js).
 *
 * Both learners used to join an agent's walks by time alone: any two closer
 * than ten minutes were one search, and every read, edit or citation went to
 * the latest question. That was built for an agent that asks, rewords and
 * opens the answer - the bench gave each question a fresh agent - and it is
 * wrong for an agent that works through a list. One agent answered fourteen
 * questions in two minutes, and three such agents four minutes apart under
 * one name: every walk of all three became one search, the words of
 * worktrees, stashes and trailers attached to every node any of them used,
 * and twenty-eight reads went to whichever question came last. Replayed with
 * those walks, GitX found two fewer answers on two wordings, at 12-19% more
 * tokens.
 *
 * So time is necessary and no longer sufficient:
 *
 *   same search   two walks of one agent within the gap are one search only
 *                 when they are about the same thing - a distinctive word in
 *                 common (a rewording keeps some), or answers that landed on
 *                 the same code or thoughts (a rewording lands where the first
 *                 wording did)
 *   an event      a read, edit or citation belongs to the latest walk of that
 *                 agent's repository, within the window, that it relates to:
 *                 the thought was in that walk's answer, the file holds code
 *                 the answer pointed at, or the code read holds the question's
 *                 own distinctive words. An event that relates to none is
 *                 credited to none - a lesson nobody can explain is not taught
 */

export const CHAIN_GAP = 10 * 60 * 1000;
export const NODES_SHARED = 0.2;      // answers sharing this share of their nodes are about the same thing

const jaccard = (a, b) => {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / (a.size + b.size - n);
};

/* Are two walks one search? words: their distinctive question words; nodes:
 * what their answers showed. */
export function sameSearch(a, b) {
  for (const w of a.words) if (b.words.has(w)) return true;
  return jaccard(a.nodes, b.nodes) >= NODES_SHARED;
}

/* An agent's walks, oldest first, cut into searches. Each item is
 * { at, words: Set, nodes: Set }; returns arrays of the same items. A walk
 * joins the current search when it is within the gap of the previous one
 * and about the same thing as any walk already in it. */
export function searches(items, gap = CHAIN_GAP) {
  const out = [];
  let cur = [];
  for (const w of items) {
    const near = cur.length && Date.parse(w.at) - Date.parse(cur[cur.length - 1].at) <= gap;
    if (near && cur.some((x) => sameSearch(x, w))) cur.push(w);
    else { if (cur.length) out.push(cur); cur = [w]; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/* The walk an event belongs to: candidates are the walks before it within
 * `window`, newest first; the first one `relates(walk)` accepts. */
export function walkForEvent(walks, at, window, relates) {
  const t = Date.parse(at);
  const before = walks.filter((w) => { const tw = Date.parse(w.at); return tw <= t && t - tw <= window; })
    .sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  for (const w of before) if (relates(w)) return w;
  return null;
}
