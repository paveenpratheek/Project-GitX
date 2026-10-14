/*
 * One gitx_related call by subject (lens/subjects.js): each named subject
 * resolved, its record asked for through the session's pool with the subject
 * fixed - not read again out of words - and, for several, where they meet.
 *
 * Each subject keeps a question pool of its own, found by name, so asking a
 * subject again is a follow-up of that subject (only what changed, nothing
 * twice) and two subjects that share a word - the 4th and the 5th Dimension -
 * are never taken for one question's follow-up.
 */

import { askPooled } from './session-pool.js';
import { lensModel } from '../lens/lens.js';
import { resolve, meetsOf, menuOf } from '../lens/subjects.js';
import { findText } from './code-find.js';

/* Lines of a text search shown for a name that is not a subject. */
const TEXT_LINES = 12;

/* What a subject's part of the answer does not need to repeat. */
const NOISE = ['asked', 'why', 'round', 'words', 'dropped', 'carried', 'lens', 'asked_first', 'next_words'];
/* Several subjects at once are brief unless the agent says otherwise. */
const SEVERAL = 2;

/* next and cover_all speak in the old question form; here they are calls by subject. */
const asCall = (c) => {
  if (!c || typeof c !== 'object') return c;
  const { query, topics, ...rest } = c;
  return { subjects: [query || (topics || []).join(' ')].filter(Boolean), ...rest };
};

function poolFor(sessions, repoDir, phrase) {
  const s = sessions.get(repoDir);
  if (!s) return false;
  const same = [s.pool, ...s.kept].find((p) => p && p.first === phrase);
  if (!same) return false;
  if (s.pool !== same) { s.kept = [...s.kept.filter((k) => k !== same), s.pool].filter(Boolean).slice(-8); s.pool = same; }
  return true;
}

export function askSubjects(sessions, repoDir, { subjects = [], lens = null, include = null, effort = null, dataDir = null, thermal } = {}) {
  const model = lensModel(repoDir);
  const asked = [...new Set([].concat(subjects).map((x) => String(x || '').trim()).filter(Boolean))];
  /* A name written like code - RELATION_KEYS, askPooled, path-recorder.js - is
   * an exact thing to find, not a subject: read as one it resolved to a loose
   * concept of its parts ("relation", "keys"). */
  const codeLike = (n) => /_|[a-z][A-Z]|\.[a-z]{1,4}$|^[A-Z0-9_]{4,}$/.test(n) && !menuOf(model).some((e) => e.name.toLowerCase() === n.toLowerCase());
  const resolved = asked.map((n) => (codeLike(n) ? { asked: n, unknown: true, closest: [] } : resolve(model, n)));
  const known = resolved.filter((r) => !r.unknown);
  const lenses = Array.isArray(lens) && lens.length ? lens : lens ? [lens] : ['what'];
  const eff = effort || (known.length > SEVERAL ? 'brief' : 'normal');
  let monitor = null;
  const parts = known.map((r) => {
    const phrase = r.found.subject.phrase;
    const again = poolFor(sessions, repoDir, phrase);
    const out = askPooled(sessions, repoDir, { query: phrase, fresh: !again, lensAs: lenses, include, effort: eff, dataDir, thermal, lens: true, asSubject: r.found });
    monitor = monitor || out.monitor;
    const a = { ...out.answer };
    for (const k of NOISE) delete a[k];
    const next = (a.next || []).map(asCall);
    delete a.next;
    if (a.cover_all) a.cover_all = { ...a.cover_all, calls: a.cover_all.calls.map(asCall) };
    return { head: { asked: r.asked, read_as: r.read_as, also_called: r.also_called }, body: a, next };
  });
  /* A name that is not a subject is searched as text over the code and the
   * thoughts, and said to be a text search. Refused outright, it sent agents
   * to grep for every code-only area - worktrees, issues, commit trailers,
   * limits - which has no subject because nothing about it was ever recorded
   * as thinking (debriefs, 15 October). */
  const unknown = resolved.filter((r) => r.unknown).map((r) => {
    let hit = null;
    try { hit = findText(repoDir, r.asked); } catch (_) { hit = null; }
    const lines = hit && Array.isArray(hit.lines) ? hit.lines.slice(0, TEXT_LINES) : [];
    const thoughts = hit && Array.isArray(hit.thoughts) ? hit.thoughts : [];
    return lines.length || thoughts.length
      ? { asked: r.asked, not_a_subject: 'searched as text instead', lines, more_lines: hit.more_lines, thoughts: thoughts.length ? thoughts : undefined, closest_subjects: r.closest.length ? r.closest : undefined }
      : { asked: r.asked, not_a_subject: 'and nothing in the code or the record says it', closest_subjects: r.closest.length ? r.closest : undefined };
  });
  const answer = {};
  if (parts.length === 1) Object.assign(answer, { subject: parts[0].head }, parts[0].body);
  else if (parts.length) answer.subjects = parts.map((p) => ({ ...p.head, ...p.body }));
  const meets = meetsOf(model, known, { effort: eff });
  if (meets) answer.meets = meets;
  if (unknown.length) {
    answer.not_subjects = unknown;
    if (unknown.some((u) => !u.lines || !u.lines.length)) answer.subjects_here = menuOf(model).map((e) => e.name);
  }
  const next = parts.flatMap((p) => p.next);
  if (next.length) answer.next = next.slice(0, 6);
  return { answer, monitor };
}
