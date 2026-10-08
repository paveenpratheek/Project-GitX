/*
 * Recording thoughts - gitx_thought_record. Until this, the only way to write
 * a thought was to hand-author its JSON, with nothing checking it at the
 * moment it was written; a malformed file was only found afterwards, by the
 * watcher, and linking to an earlier thought meant knowing its id.
 *
 * WHERE. Always the context graph (.gitx/context/thoughts/). New thinking
 * waits there until a commit settles it: named in that commit's GitX-Thoughts
 * trailer, it is promoted into the thought graph with the evidence,
 * alternatives and costs that made it happen (promote.js). Nothing recorded
 * here goes to the thought graph directly - the thought graph holds only what
 * supports a commit, and at the moment of recording nothing does yet.
 *
 * WHAT THE AGENT GIVES: kind, text, outcome, who decided, the forces behind
 * it, and links. WHAT THE TOOL STAMPS: the id, the anchor (HEAD, its patch-id,
 * the branch), who recorded it, when, and the parent - the previous thought
 * this server recorded in this repository. An agent should not have to know
 * any of that, and a stamped value cannot be mistyped.
 *
 * SEVERAL AT ONCE. A batch shares keys, so a decision, the alternatives it
 * beat (lost-to) and the cost it accepted (cost-of) link to each other in one
 * call. A link may also name any thought on record, in either graph, by id.
 *
 * ALL OR NOTHING. Every rule is checked before anything is written; one
 * problem writes nothing and every problem is reported at once. The rules are
 * the session writer's: lost-to runs from a rejection to an accepted thought,
 * cost-of from a cost to an accepted decision, a contingent force needs its
 * revisit_if. An exact duplicate of a thought already on record is refused -
 * the context graph is read by agents gathering context, and a repeat is
 * tokens spent on nothing.
 *
 * Each file is written to a temporary name and renamed into place, so the
 * watcher never reads half a thought.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { loadThoughts, thoughtDirs } from './thoughts.js';
import { similarThoughts } from './thought-query.js';
import { buildRankIndex, relatedToDraft, summaryOf } from './rank.js';
import { loadTopics, writeDigest, DIGEST_MIN, DIGEST_MAX } from './topics.js';

const SCHEMA = 'gitx.thought/0';
const KINDS = ['decision', 'finding', 'cost', 'learned'];
const OUTCOMES = ['accepted', 'rejected', 'open', 'stashed'];
const DECIDERS = ['user', 'agent', 'agent-delegated'];
const LINKS = ['lost-to', 'cost-of', 'supports', 'refines', 'derived-from', 'supersedes', 'contradicts'];
const MAX_BATCH = 20;
const MIN_WORDS = 5;
const MAX_TEXT = 600;

/* The previous thought each repository was given by this process, so a batch
 * or a run of calls reads as a thread. It starts empty with each server. */
const lastRecorded = new Map();

const git = (repoDir, args, input) => execFileSync('git', args, { windowsHide: true, cwd: repoDir, encoding: 'utf8', input, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'ignore'] }).trim();
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const idFor = (repoDir, anchor, text) => 't-' + crypto.createHash('sha1').update(path.basename(repoDir) + ':' + String(anchor).slice(0, 12) + ':' + norm(text).toLowerCase()).digest('hex').slice(0, 10);

export function recordThoughts(repoDir, args = {}, who = {}) {
  const input = Array.isArray(args.thoughts) ? args.thoughts : [];
  const problems = [];
  const summary = args.summary && typeof args.summary === 'object' ? args.summary : null;
  if (!input.length && !summary) problems.push('thoughts is empty - give at least one thought to record, or a summary to write.');
  const topicIds = new Set(loadTopics(repoDir).topics.map((t) => t.id));
  if (summary && !topicIds.has(String(summary.topic))) problems.push('summary.topic "' + summary.topic + '" is no topic here - one of ' + [...topicIds].join(', ') + '.');
  if (input.length > MAX_BATCH) problems.push('at most ' + MAX_BATCH + ' thoughts in one call; this has ' + input.length + '.');

  let head, branch, patchId = null;
  try {
    head = git(repoDir, ['rev-parse', 'HEAD']);
    branch = git(repoDir, ['rev-parse', '--abbrev-ref', 'HEAD']);
    try { patchId = git(repoDir, ['patch-id', '--stable'], git(repoDir, ['show', '--format=', head]) + '\n').split(' ')[0] || null; } catch (_) { /* a merge or empty commit */ }
  } catch (_) {
    return { ok: false, recorded: false, problems: ['this repository has no commits yet - a thought is anchored at the commit it was thought at.'] };
  }

  /* Everything on record, both graphs: link targets and duplicates. */
  const onRecord = new Map();
  for (const t of loadThoughts(repoDir).thoughts) onRecord.set(t.id, t);
  for (const t of loadThoughts(repoDir, { store: 'context' }).thoughts) onRecord.set(t.id, t);
  const byText = new Map([...onRecord.values()].map((t) => [norm(t.text).toLowerCase(), t.id]));

  /* Keys first, so links and citations inside the batch resolve in any order. */
  const keyToId = new Map();
  input.forEach((t, i) => {
    const key = t && t.key != null ? String(t.key) : String(i + 1);
    if (keyToId.has(key)) problems.push('key "' + key + '" is used twice in this batch.');
    keyToId.set(key, idFor(repoDir, head, t && t.text));
  });
  const resolve = (ref) => keyToId.get(String(ref)) || (onRecord.has(String(ref)) ? String(ref) : null);
  const inBatch = new Map(input.map((t, i) => [keyToId.get(t && t.key != null ? String(t.key) : String(i + 1)), t]));

  const built = [];
  input.forEach((t, i) => {
    const key = t && t.key != null ? String(t.key) : String(i + 1);
    const where = 'thought "' + key + '": ';
    const err = (m) => problems.push(where + m);
    if (!t || typeof t !== 'object') { err('not an object.'); return; }
    const text = norm(t.text);
    if (!KINDS.includes(t.kind)) err('kind must be one of ' + KINDS.join(', ') + '.');
    if (!OUTCOMES.includes(t.outcome)) err('outcome must be one of ' + OUTCOMES.join(', ') + '.');
    if (text.split(' ').filter(Boolean).length < MIN_WORDS) err('text needs at least ' + MIN_WORDS + ' words - one sentence that stands on its own.');
    if (text.length > MAX_TEXT) err('text is ' + text.length + ' characters; keep it under ' + MAX_TEXT + ' and put the reasoning in forces.');
    if (t.decided_by != null && t.kind !== 'decision') err('decided_by belongs only on a decision.');
    if (t.kind === 'decision' && t.decided_by != null && !DECIDERS.includes(t.decided_by)) err('decided_by must be one of ' + DECIDERS.join(', ') + '.');
    const id = keyToId.get(key);
    const dup = byText.get(text.toLowerCase());
    if (dup) err('this exact text is already on record as ' + dup + ' - link to it, or say something new.');
    if (onRecord.has(id)) err('already on record as ' + id + '.');

    const links = (Array.isArray(t.links) ? t.links : []).map((l) => {
      if (!l || !LINKS.includes(l.type)) { err('link type must be one of ' + LINKS.join(', ') + '.'); return null; }
      const to = resolve(l.to);
      if (!to) { err('link to "' + l.to + '" names no key in this batch and no thought on record.'); return null; }
      const target = inBatch.get(to) || onRecord.get(to);
      if (l.type === 'lost-to' && !(t.outcome === 'rejected' && target && target.outcome === 'accepted')) err('lost-to runs from a rejected thought to an accepted one.');
      if (l.type === 'cost-of' && !(t.kind === 'cost' && target && target.kind === 'decision' && target.outcome === 'accepted')) err('cost-of runs from a cost to an accepted decision.');
      return { type: l.type, to };
    }).filter(Boolean);

    const forces = (Array.isArray(t.forces) ? t.forces : []).map((f) => {
      if (!f || !['forward', 'backward'].includes(f.direction)) { err('a force needs direction forward or backward.'); return null; }
      if (norm(f.text).split(' ').filter(Boolean).length < 3) err('a force needs text saying what pushed or held back.');
      if (f.direction === 'backward' && !['contingent', 'structural'].includes(f.kind)) err('a backward force is contingent (can change) or structural (cannot).');
      if (f.kind === 'contingent' && !norm(f.revisit_if)) err('a contingent force needs revisit_if - what would have to change.');
      const cites = (Array.isArray(f.cites) ? f.cites : []).map((c) => {
        const r = resolve(c);
        if (!r) err('cites "' + c + '", which names no key in this batch and no thought on record.');
        return r;
      }).filter(Boolean);
      return { direction: f.direction, kind: f.kind || null, text: norm(f.text), revisit_if: norm(f.revisit_if) || null, cites, superseded_by: null };
    }).filter(Boolean);

    if (t.topic != null && !topicIds.has(String(t.topic))) err('topic "' + t.topic + '" is no topic here - one of ' + [...topicIds].join(', ') + '.');

    built.push({ key, id, t, text, links, forces });
  });

  /* The topic each thought is filed under: the one it names, or else the one
   * most of what it links to and cites is filed under - a thought continues
   * the subject of what it continues. Inside the batch too, in order, so a
   * rejection linked to a filed decision follows it. Unfiled, a thought is in
   * no topic summary and no topic tie (t-4d9004674e: 26 of the stack's design
   * thoughts were outside every topic). */
  const topicOf = new Map();
  for (let pass = 0; pass < 2; pass++) {
    for (const b of built) {
      if (topicOf.has(b.id)) continue;
      if (b.t.topic != null) { topicOf.set(b.id, { topic: String(b.t.topic), how: 'given' }); continue; }
      const votes = new Map();
      for (const to of [...b.links.map((l) => l.to), ...b.forces.flatMap((f) => f.cites)]) {
        const tp = topicOf.has(to) ? topicOf.get(to).topic : onRecord.has(to) ? onRecord.get(to).topic : null;
        if (tp && topicIds.has(tp)) votes.set(tp, (votes.get(tp) || 0) + 1);
      }
      const best = [...votes].sort((a, c) => c[1] - a[1])[0];
      if (best) topicOf.set(b.id, { topic: best[0], how: 'from what it links to' });
    }
  }

  if (summary) {
    const n = String(summary.text || '').trim().length;
    if (n < DIGEST_MIN || n > DIGEST_MAX) problems.push('summary.text is ' + n + ' characters; a summary is ' + DIGEST_MIN + '-' + DIGEST_MAX + ' - what the topic does today, in a few lines.');
  }
  if (problems.length) return { ok: false, recorded: false, problems, note: 'Nothing was recorded. Fix these and send the whole batch again.' };

  /* Write: temp name, then rename, so the watcher never reads half a file. */
  const dir = thoughtDirs(repoDir).context;
  fs.mkdirSync(dir, { recursive: true });
  const now = new Date().toISOString();
  let parent = lastRecorded.get(repoDir) || null;
  const results = [];
  const batchIds = built.map((x) => x.id);
  for (const b of built) {
    const json = {
      schema: SCHEMA, id: b.id, kind: b.t.kind, text: b.text, outcome: b.t.outcome,
      decided_by: b.t.kind === 'decision' ? (b.t.decided_by || 'agent') : null,
      ...(b.t.outcome === 'stashed' ? { applied_to: null } : {}),
      anchor: { commit: head, patch_id: patchId, branch },
      ...(topicOf.has(b.id) ? { topic: topicOf.get(b.id).topic } : {}),
      resulted_in: null, parent, session: who.session || null,
      links: b.links, forces: b.forces,
      sources: [{ type: 'tool', tool: 'gitx_thought_record', agent: who.agent || null, at: now }],
      provenance: 'recorded',
      by: { role: 'agent', agent: who.name || who.agent || null, model: who.model || null },
      created: now
    };
    const file = path.join(dir, b.id + '.json');
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(json, null, 2) + '\n');
    fs.renameSync(tmp, file);
    parent = b.id;
  }
  lastRecorded.set(repoDir, parent);

  /* A topic's summary, rewritten in place (t-aca34dc7d9), stamped with the
   * commit it was written at so a reader can tell what came after. */
  let wrote = null;
  if (summary) wrote = writeDigest(repoDir, String(summary.topic), { text: summary.text, by: who.name || who.agent || 'agent', head });

  /* What each new thought may continue, repeat, answer or contradict, from the
   * ranking engine (t-d69e5f5910) - its sentence, its reasons and what it links
   * to, so a thought said in other words than one on record can still be
   * found. Offered, never enforced: a score does not get to refuse a thought.
   * Asked after the write, so it can never stop one; if the engine cannot run
   * here, the word-overlap check it replaced answers instead. */
  let related;
  let ix = null;
  try {
    ix = buildRankIndex(repoDir);
    related = (b) => relatedToDraft(ix, {
      text: b.text,
      also: b.forces.map((f) => f.text + ' ' + (f.revisit_if || '')).join(' '),
      ids: [...b.links.map((l) => l.to), ...b.forces.flatMap((f) => f.cites)].filter((id) => !batchIds.includes(id)),
      exclude: batchIds
    }).map((r) => ({
      id: r.id, in: r.layer === 'thought' ? 'thought graph' : 'context graph',
      outcome: r.outcome, kind: r.kind, topic: r.topic, text: r.text, why: r.why.join(' · ')
    }));
  } catch (_) {
    related = (b) => similarThoughts(repoDir, b.text, { exclude: batchIds });
  }

  for (const b of built) {
    const settles = b.t.outcome === 'accepted' && (b.t.kind === 'decision' || b.t.kind === 'cost');
    const near = related(b);
    const filed = topicOf.get(b.id);
    results.push({
      key: b.key, id: b.id, kind: b.t.kind, outcome: b.t.outcome,
      topic: filed ? filed.topic + (filed.how === 'given' ? '' : ' (' + filed.how + ')') : 'none - name one with topic, or link it to a filed thought',
      settle_with: settles ? 'GitX-Thoughts: ' + b.id : undefined,
      maybe_related: near.length ? near : undefined
    });
  }

  /* The summaries of the topics just written into that are missing or have
   * fallen behind - the step that keeps them true (t-656813fd70). Not for the
   * one this call rewrote. */
  const touched = [...new Set([...topicOf.values()].map((x) => x.topic))].filter((t) => !(wrote && wrote.ok && wrote.topic === t));
  const toUpdate = ix ? touched.map((t) => summaryOf(ix, t)).filter((s) => s && (s.no_summary || (s.since_written && !/^Nothing/.test(s.since_written))))
    .map((s) => s.title + ' (' + s.topic + '): ' + (s.no_summary ? 'no summary yet' : 'written ' + s.written + '; ' + s.since_written.split(' - ')[0])) : [];

  const settle = results.filter((r) => r.settle_with).map((r) => r.id);
  return {
    ok: true,
    recorded: results.length,
    graph: 'context',
    anchored_at: head.slice(0, 7) + ' on ' + branch,
    summary: wrote ? (wrote.ok ? 'Rewrote the summary of ' + wrote.title + ' (edit ' + wrote.edits + ').' : wrote.problems.join('; ')) : undefined,
    summaries_to_update: toUpdate.length ? toUpdate.concat(['Rewrite one with gitx_thought_record summary: { topic, text } - what the topic does today, in a few lines.']) : undefined,
    thoughts: results.length ? results : undefined,
    next: !results.length ? undefined : settle.length
      ? 'When the commit that carries these out is made, name them in its message - GitX-Thoughts: ' + settle.join(', ') + ' - or pass them as thoughts to gitx_commit_chronicle. They then move to the thought graph with what supports them.'
      : 'Nothing here settles a commit on its own: findings, rejections and open questions move with the decision that rests on them.',
    how_to_use: !results.length ? undefined : 'maybe_related lists the thoughts on record this most likely continues, repeats, answers or contradicts, each with why it came up - shared words, the same topic, a link to what you linked. If one is what this continues, answers or contradicts, record a link to it (refines, supersedes, supports, contradicts, derived-from) rather than leaving the two unconnected; if it says the same thing, this is a repeat.'
  };
}
