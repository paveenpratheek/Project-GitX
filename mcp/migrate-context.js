/*
 * Move the wanderers out of the thought graph into the context graph - step 4
 * of docs/context-graph-plan.md. Once per repository: any repository that
 * recorded thoughts before the context graph existed needs it, not only the
 * two it was written against.
 *
 *   node mcp/migrate-context.js <repo>                            dry run, both rules compared
 *   node mcp/migrate-context.js <repo> --rule=directional --apply
 *   node mcp/migrate-context.js <repo> --undo                     put everything back
 *
 * WHAT STAYS. The thought graph holds what made a commit happen, and the
 * rules learned along the way. A thought with its own resulted_in stays, and
 * so does a learned rule - it is read every time. From each of those:
 *
 *   directional  what it came from and what it settled - the evidence its
 *                forces cite, the thoughts it supersedes, refines or derives
 *                from - and what was weighed against it: the alternatives it
 *                beat (lost-to), the costs it accepted (cost-of), what states
 *                it supports it. Then the same again from each of those.
 *                A LATER thought that points back at it - citing it,
 *                refining it, contradicting it - depends on it and did not
 *                make it happen: it is unfinished work, so it moves.
 *   both-ways    any link or citation, in either direction, transitively -
 *                the rule the plan was written with. It keeps a follow-up
 *                with no commit in the thought graph merely because it cites
 *                what a commit rests on.
 *
 * Why "what it supersedes" matters: an open question answered by a committed
 * decision is linked from it by supersedes or refines. Following only
 * citations would move that question into the context graph and count it as
 * open again. parent is never a tie - it is the order thoughts were written.
 *
 * HOW IT MOVES. By rename, never copy-and-delete: the watcher sees a rename
 * as one "moved" entry. A thought whose parent ends up in the other graph is
 * re-pointed to its nearest ancestor in its own graph, keeping the old id in
 * was_parent - staying thoughts and waiting ones alike. The stash
 * containers move to .gitx/context/stash/. Everything done is written to
 * .gitx/context/migration.json first-to-last, so --undo can reverse it
 * exactly; an error part-way reverses what was already done.
 *
 * Nothing is moved on a dry run, and nothing is moved without --rule: the
 * rule is the owner's decision, not a default.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadThoughts, thoughtDirs } from './tools/thoughts.js';

/* commit-only: the owner's rule of 24 September - the thought graph holds only
 * what supports a commit. The directional walk from committed thoughts alone:
 * a learned rule no commit rests on, and the lessons that hang only from it,
 * go to the context graph like everything else not tied to a commit. */
export const RULES = ['directional', 'both-ways', 'commit-only'];
const WEIGHED_AGAINST_IT = ['lost-to', 'cost-of', 'supports'];     // links pointing AT a staying thought
const ITS_OWN_HISTORY = ['supersedes', 'refines', 'derived-from'];  // links FROM a staying thought

const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };

/* id -> how it came to stay. Breadth-first from the committed thoughts, so
 * each "how" is the shortest reason there is. */
export function classify(thoughts, rule) {
  if (!RULES.includes(rule)) throw new Error('unknown rule ' + rule + ' - one of ' + RULES.join(', '));
  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const linkedIn = new Map();     // to -> [{ from, type }]
  const citedBy = new Map();      // cited -> [citer]
  for (const t of thoughts) {
    for (const l of t.links || []) if (byId.has(l.to)) push(linkedIn, l.to, { from: t.id, type: l.type });
    for (const f of t.forces || []) for (const c of f.cites || []) if (byId.has(c)) push(citedBy, c, t.id);
  }
  const reach = (id) => {
    const t = byId.get(id);
    const out = [];
    for (const f of t.forces || []) for (const c of f.cites || []) if (byId.has(c)) out.push([c, 'cited by ' + id]);
    for (const { from, type } of linkedIn.get(id) || []) if (WEIGHED_AGAINST_IT.includes(type)) out.push([from, type + ' ' + id]);
    if (rule === 'directional' || rule === 'commit-only') {
      const said = { supersedes: 'superseded by ', refines: 'refined by ', 'derived-from': 'source of ' };
      for (const l of t.links || []) if (ITS_OWN_HISTORY.includes(l.type) && byId.has(l.to)) out.push([l.to, said[l.type] + id]);
    } else {
      for (const l of t.links || []) if (byId.has(l.to)) out.push([l.to, 'linked from ' + id + ' (' + l.type + ')']);
      for (const { from, type } of linkedIn.get(id) || []) out.push([from, type + ' ' + id]);
      for (const c of citedBy.get(id) || []) out.push([c, 'cites ' + id]);
    }
    return out;
  };
  const stays = new Map();
  const queue = [];
  for (const t of thoughts) if (t.resulted_in && t.resulted_in.commit) { stays.set(t.id, 'its own commit'); queue.push(t.id); }
  /* Directional starts from the rules as well, so the lesson behind a rule
   * stays beside it. both-ways is the plan as written: rules stay, but
   * nothing is reached from them. */
  const rules = thoughts.filter((t) => t.kind === 'learned');
  if (rule === 'directional') for (const t of rules) if (!stays.has(t.id)) { stays.set(t.id, 'a learned rule'); queue.push(t.id); }
  while (queue.length) {
    const id = queue.shift();
    for (const [n, how] of reach(id)) if (!stays.has(n)) { stays.set(n, how); queue.push(n); }
  }
  if (rule !== 'commit-only') for (const t of rules) if (!stays.has(t.id)) stays.set(t.id, 'a learned rule');
  return stays;
}

export function planMigration(repoDir, rule) {
  const dirs = thoughtDirs(repoDir);
  const { thoughts, fileOf, stats } = loadThoughts(repoDir);
  const ctx = loadThoughts(repoDir, { store: 'context' });
  const inContext = new Set(ctx.thoughts.map((t) => t.id));
  const byId = new Map(thoughts.map((t) => [t.id, t]));
  const stays = classify(thoughts, rule);
  const moving = thoughts.filter((t) => !stays.has(t.id));
  const movingIds = new Set(moving.map((t) => t.id));

  /* Every thought keeps a parent in its own graph after the pass: the nearest
   * ancestor in that graph, or none, walked through both graphs.
   *
   * The thought graph's side covers a parent leaving now, and a parent that
   * was already in the context graph - a writer that chained thoughts in the
   * order written put some there. The context graph's side covers a thought
   * moving now and one already waiting, whose parent is in the thought graph.
   * The first two passes did only the first side, and left 94 waiting
   * thoughts across both repositories with a parent in the other graph;
   * another pass repairs them. */
  const inContextById = new Map(ctx.thoughts.map((t) => [t.id, t]));
  const anyGraph = (id) => byId.get(id) || inContextById.get(id);
  const waits = (id) => movingIds.has(id) || inContextById.has(id);
  /* Up the order thoughts were WRITTEN in: was_parent where a thought has one,
   * since an earlier pass re-pointed its parent to stay in its own graph and
   * the current parent would never lead back into the other one. */
  const before = (id) => { const t = anyGraph(id); return t.was_parent && anyGraph(t.was_parent) ? t.was_parent : t.parent || null; };
  const nearest = (from, sameGraph) => {
    let p = from;
    const seen = new Set();
    while (p && !sameGraph(p) && anyGraph(p) && !seen.has(p)) { seen.add(p); p = before(p); }
    return p && sameGraph(p) ? p : null;
  };
  const staying = (id) => stays.has(id);
  const reparent = [];
  for (const t of thoughts) {
    if (!stays.has(t.id) || !t.parent || stays.has(t.parent) || !anyGraph(t.parent)) continue;
    reparent.push({ id: t.id, file: fileOf[t.id], from: t.parent, to: nearest(t.parent, staying) });
  }
  /* A moving thought is re-pointed after its move, so its file is named where
   * it will be by then. */
  const rel = (f) => path.relative(repoDir, f).replace(/\\/g, '/');
  for (const t of [...moving, ...ctx.thoughts]) {
    if (!t.parent || waits(t.parent) || !anyGraph(t.parent)) continue;
    const file = movingIds.has(t.id) ? rel(path.join(dirs.context, t.id + '.json')) : ctx.fileOf[t.id];
    reparent.push({ id: t.id, file, from: t.parent, to: nearest(t.parent, waits) });
  }

  let stashFiles = [];
  try { stashFiles = fs.readdirSync(dirs.stash).filter((f) => f.endsWith('.json')); } catch (_) { /* none */ }

  return {
    rule, total: thoughts.length, stays, moving, reparent, stashFiles, fileOf,
    unreadable: stats.unreadable,
    conflicts: moving.filter((t) => inContext.has(t.id) || fs.existsSync(path.join(dirs.context, t.id + '.json'))).map((t) => t.id),
    crossLinks: thoughts.filter((t) => stays.has(t.id)).reduce((n, t) => n + (t.links || []).filter((l) => movingIds.has(l.to)).length, 0)
  };
}

/* ─────────────────────────────────────────────── apply and undo */

const MANIFEST = (repoDir) => path.join(thoughtDirs(repoDir).context, '..', 'migration.json');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const writeJson = (f, o) => fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n');

export function applyMigration(repoDir, rule) {
  const m = MANIFEST(repoDir);
  /* A second pass under a stricter rule is a new migration. The last one's
   * record is kept beside it, renamed, and --undo reverses the newest pass. */
  if (fs.existsSync(m)) {
    const prev = readJson(m);
    fs.renameSync(m, m.replace(/\.json$/, '-' + String(prev.at).replace(/[:.]/g, '-') + '.json'));
  }
  const p = planMigration(repoDir, rule);
  if (p.conflicts.length) throw new Error('these ids are already in the context graph, nothing moved: ' + p.conflicts.join(', '));
  const dirs = thoughtDirs(repoDir);
  fs.mkdirSync(dirs.context, { recursive: true });
  fs.mkdirSync(dirs.contextStash, { recursive: true });

  const done = [];   // each step, in order, so a failure can be reversed
  const manifest = { at: new Date().toISOString(), rule, moved: [], reparented: [], stashes: [] };
  try {
    for (const t of p.moving) {
      const from = path.join(repoDir, p.fileOf[t.id]);
      const to = path.join(dirs.context, t.id + '.json');
      fs.renameSync(from, to);
      done.push({ kind: 'move', from, to });
      manifest.moved.push({ id: t.id, from: path.relative(repoDir, from).replace(/\\/g, '/'), to: path.relative(repoDir, to).replace(/\\/g, '/') });
    }
    for (const r of p.reparent) {
      const file = path.join(repoDir, r.file);
      const raw = fs.readFileSync(file, 'utf8');
      const t = JSON.parse(raw);
      t.parent = r.to;
      if (!t.was_parent) t.was_parent = r.from;
      writeJson(file, t);
      done.push({ kind: 'edit', file, raw });
      /* The original text, so --undo restores the file byte for byte rather
       * than an equal JSON in a different layout. */
      manifest.reparented.push({ ...r, raw });
    }
    for (const f of p.stashFiles) {
      const from = path.join(dirs.stash, f);
      const to = path.join(dirs.contextStash, f);
      fs.renameSync(from, to);
      done.push({ kind: 'move', from, to });
      manifest.stashes.push({ from: path.relative(repoDir, from).replace(/\\/g, '/'), to: path.relative(repoDir, to).replace(/\\/g, '/') });
    }
    writeJson(MANIFEST(repoDir), manifest);
  } catch (err) {
    for (const d of done.reverse()) {
      try { if (d.kind === 'move') fs.renameSync(d.to, d.from); else fs.writeFileSync(d.file, d.raw); } catch (_) { /* reported below */ }
    }
    throw new Error('stopped part-way and put back what was done: ' + err.message);
  }
  return { plan: p, manifest };
}

export function undoMigration(repoDir) {
  const m = MANIFEST(repoDir);
  if (!fs.existsSync(m)) throw new Error('nothing to undo - no migration.json in .gitx/context/');
  const manifest = readJson(m);
  const abs = (f) => path.join(repoDir, f);
  const problems = [];
  for (const s of manifest.stashes.slice().reverse()) {
    try { fs.renameSync(abs(s.to), abs(s.from)); } catch (e) { problems.push(s.to + ': ' + e.message); }
  }
  for (const r of manifest.reparented.slice().reverse()) {
    try {
      if (typeof r.raw === 'string') fs.writeFileSync(abs(r.file), r.raw);
      else {
        const t = readJson(abs(r.file));
        t.parent = r.from;
        if (t.was_parent === r.from) delete t.was_parent;
        writeJson(abs(r.file), t);
      }
    } catch (e) { problems.push(r.file + ': ' + e.message); }
  }
  for (const mv of manifest.moved.slice().reverse()) {
    try { fs.mkdirSync(path.dirname(abs(mv.from)), { recursive: true }); fs.renameSync(abs(mv.to), abs(mv.from)); } catch (e) { problems.push(mv.to + ': ' + e.message); }
  }
  /* Kept, renamed, as the record that it ran and was undone. */
  fs.renameSync(m, m.replace(/\.json$/, '-undone-' + Date.now() + '.json'));
  return { manifest, problems };
}

/* ─────────────────────────────────────────────── the dry run */

function report(repoDir) {
  const name = path.basename(repoDir);
  const plans = Object.fromEntries(RULES.map((r) => [r, planMigration(repoDir, r)]));
  const d = plans.directional, b = plans['both-ways'];
  const count = (list, key) => list.reduce((m, t) => { const k = key(t); m[k] = (m[k] || 0) + 1; return m; }, {});
  const fmt = (o) => Object.entries(o).sort((x, y) => y[1] - x[1]).map(([k, v]) => k + ' ' + v).join(', ');
  const why = (p) => fmt(count([...p.stays.values()].map((h) => ({ h })), ({ h }) => h === 'its own commit' || h === 'a learned rule' ? h : h.split(' ')[0]));

  const lines = [];
  lines.push('# ' + name + ' - dry run (nothing has moved)');
  lines.push('');
  lines.push(d.total + ' thoughts in the thought graph.' + (d.unreadable.length ? ' ' + d.unreadable.length + ' unreadable file(s) are not thoughts and are left alone.' : ''));
  lines.push('');
  for (const [r, p] of Object.entries(plans)) {
    lines.push('## Rule: ' + r);
    lines.push('- stay: ' + p.stays.size + ' (' + why(p) + ')');
    lines.push('- move to the context graph: ' + p.moving.length + (p.moving.length ? ' (' + fmt(count(p.moving, (t) => t.outcome + ' ' + t.kind)) + ')' : ''));
    lines.push('- parents re-pointed: ' + p.reparent.length + ', of which left with no parent: ' + p.reparent.filter((x) => !x.to).length);
    lines.push('- links from staying thoughts into the context graph afterwards: ' + p.crossLinks);
    lines.push('');
  }
  lines.push('- stash containers moving to .gitx/context/stash/: ' + (d.stashFiles.length || 'none'));
  lines.push('- ids already in the context graph (would stop the apply): ' + (d.conflicts.length ? d.conflicts.join(', ') : 'none'));
  lines.push('');

  const onlyBoth = [...b.stays.keys()].filter((id) => !d.stays.has(id));
  const onlyDir = [...d.stays.keys()].filter((id) => !b.stays.has(id));
  const byId = new Map(b.moving.concat(d.moving).map((t) => [t.id, t]));
  const all = new Map(loadThoughts(repoDir).thoughts.map((t) => [t.id, t]));
  lines.push('## Where the rules differ: ' + onlyBoth.length + ' thought(s) stay only under both-ways');
  lines.push('Each moves under the directional rule. How both-ways keeps it:');
  lines.push('');
  for (const id of onlyBoth) {
    const t = all.get(id) || byId.get(id);
    lines.push('- `' + id + '` ' + t.outcome + ' ' + t.kind + ' - ' + t.text);
    lines.push('  - kept because: ' + b.stays.get(id));
  }
  lines.push('');
  lines.push('## ' + onlyDir.length + ' thought(s) stay only under directional');
  lines.push('Each moves under both-ways. How directional keeps it:');
  lines.push('');
  for (const id of onlyDir) {
    const t = all.get(id);
    lines.push('- `' + id + '` ' + t.outcome + ' ' + t.kind + ' - ' + t.text);
    lines.push('  - kept because: ' + d.stays.get(id));
  }
  lines.push('');
  lines.push('## What moves under the directional rule');
  for (const t of d.moving) lines.push('- `' + t.id + '` ' + t.outcome + ' ' + t.kind + ' - ' + t.text);
  return { text: lines.join('\n') + '\n', plans, onlyBoth };
}

/* ─────────────────────────────────────────────── command line */

/* fileURLToPath, not URL.pathname: the path has a space, which a URL encodes. */
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const repo = args.find((a) => !a.startsWith('--'));
  const flag = (n) => args.find((a) => a === '--' + n || a.startsWith('--' + n + '='));
  const val = (n) => { const f = flag(n); return f && f.includes('=') ? f.split('=').slice(1).join('=') : null; };
  if (!repo) { console.error('usage: node mcp/migrate-context.js <repo> [--rule=directional|both-ways --apply] [--undo] [--report=<file>]'); process.exit(2); }
  const dir = path.resolve(repo);
  try {
    if (flag('undo')) {
      const { manifest, problems } = undoMigration(dir);
      console.log('undone: ' + manifest.moved.length + ' thoughts back in the thought graph, ' + manifest.reparented.length + ' parents restored, ' + manifest.stashes.length + ' stashes back');
      if (problems.length) { console.error('could not put back:\n  ' + problems.join('\n  ')); process.exit(1); }
    } else if (flag('apply')) {
      const rule = val('rule');
      if (!rule) { console.error('--apply needs --rule=directional or --rule=both-ways: which thoughts stay is the owner\'s decision, not a default'); process.exit(2); }
      const { manifest } = applyMigration(dir, rule);
      console.log('moved ' + manifest.moved.length + ' thoughts to the context graph, re-pointed ' + manifest.reparented.length + ' parents, moved ' + manifest.stashes.length + ' stashes (rule: ' + rule + '). Undo with --undo.');
    } else {
      const { text } = report(dir);
      const out = val('report');
      if (out) { fs.writeFileSync(out, text); console.log('dry run written to ' + out); }
      else process.stdout.write(text);
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
