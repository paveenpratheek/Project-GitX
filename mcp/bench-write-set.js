/*
 * Writes a held-out question set without the agent that works on GitX ever
 * reading it: a fresh Claude agent reads a frozen copy of the repository with
 * plain file tools (no GitX) and writes the questions with the evidence that
 * answers them; a second fresh agent, seeing only the questions, rewords each
 * twice. This script prints counts and checks only.
 *
 * heldout-para was studied question by question while GitX was changed, so its
 * scores flatter GitX (t-e7b1163639). heldout2, written this way, was easy for
 * everyone - 89-96% - because each question had one clearly recorded answer
 * (t-d89f7bd5a2). --hard asks for answers that need several records of
 * different kinds combined, in a newcomer's words, scored on recall.
 *
 *   node mcp/bench-write-set.js --name=heldout3 [--hard] [--model=claude-sonnet-5-5] [--at=HEAD]
 *
 * Writes <repo>/.gitx/bench/<name>.json. Never reuses an id any existing set uses.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeze } from './bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const BENCH = path.join(REPO, '.gitx', 'bench');
const argv = process.argv.slice(2);
const eq = (name, dflt) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const NAME = eq('name', null);
const HARD = argv.includes('--hard');
const MODEL = eq('model', 'claude-sonnet-5-5');
const AT = eq('at', 'HEAD');
if (!NAME || !/^[\w-]+$/.test(NAME)) { console.error('give --name=<set name>'); process.exit(1); }
if (fs.existsSync(path.join(BENCH, NAME + '.json'))) { console.error(NAME + '.json exists - choose another name'); process.exit(1); }

/* Every id any existing set uses: a new set must not reuse one. */
const used = new Set();
for (const f of fs.readdirSync(BENCH).filter((x) => x.endsWith('.json'))) {
  let s; try { s = JSON.parse(fs.readFileSync(path.join(BENCH, f), 'utf8')); } catch (_) { continue; }
  for (const c of s.cases || []) for (const k of ['thoughts', 'commits', 'code']) for (const id of (c.expect || {})[k] || []) used.add(k === 'commits' ? String(id).slice(0, 7) : String(id));
}
console.log('ids already used by existing sets:', used.size);

const frozen = freeze(AT);
const dir = frozen.dir;
const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: dir, encoding: 'utf8' }).trim();
console.log('frozen copy at', head);

const strip = (t) => String(t || '').replace(/^[\s\S]*?```(?:json)?\s*/i, '').replace(/```[\s\S]*$/, '').trim() || String(t || '').trim();
const parseJson = (t) => { try { return JSON.parse(strip(t)); } catch (_) { const m = String(t || '').match(/\{[\s\S]*\}/); try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; } } };
function ask(prompt, cwd, tools) {
  const args = ['-p', prompt, '--output-format', 'json', '--model', MODEL, '--effort', 'high', '--setting-sources', 'project,local', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', JSON.stringify({ mcpServers: {} }),
    ...(tools.length ? ['--allowedTools', ...tools] : []), '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent', ...(tools.length ? [] : ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell'])];
  const r = spawnSync('claude', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true, timeout: 50 * 60 * 1000 });
  try { const j = JSON.parse(r.stdout); return { text: j.result, cost: j.total_cost_usd }; } catch (_) { return { text: '', cost: 0 }; }
}

const RECORD = 'The record: the code in the working tree; the git history (git log, git show); and the recorded design reasoning in .gitx/thoughts/ (settled) and .gitx/context/thoughts/ (waiting) - one JSON file per thought, with an id t-..., a kind, an outcome (accepted, rejected, stashed, open), forces and links to other thoughts. .gitx is git-ignored: give it as a path when you search it.';
const EASY = [
  'Mix: 4 questions about why something was decided; 3 about ideas that were rejected or set aside and what held them back; 3 about history - when or in what order something changed; 3 about where or how something works in the code; 2 about questions still open or unsettled.',
  'Write each question in plain words, as a person would ask it - do not copy phrases from the thought or commit text, and put no ids, hashes or file names in the question.',
  'For each question give the evidence that answers it: 1 to 3 thought ids, and/or commit hashes (at least 7 characters), and/or exact code names (a function or constant name that exists in the code).'
];
const HARDER = [
  'Every question must need SEVERAL records combined for a complete answer - no question answerable from one thought, one commit or one function. Mix:',
  '- 5 questions about a decision AND what it replaced, beat or rejected, with the reason (e.g. a decision and the rejected alternative linked to it);',
  '- 4 questions about how some behaviour works in the code AND why it was built that way (the code, plus the commit or thought that explains it);',
  '- 3 questions about how something evolved over time through two or more changes (several commits, and the reasoning that moved it);',
  '- 3 questions about something still open or unsettled AND what it depends on or what blocks it.',
  'Word each question the way a newcomer would ask it: describe the behaviour or the purpose instead of using the project\'s own names for its features, and put no ids, hashes, file names or function names in the question. Do not copy phrases from the record.',
  'For each question give ALL the evidence a complete answer needs: 2 to 4 items, of at least two different kinds where the question allows - thought ids, commit hashes (at least 7 characters), exact code names (a function or constant name that exists in the code).'
];
const WRITE = [
  'You are writing an exam about the software project in the current folder, to test how well a search tool helps newcomers understand it. Write 15 questions that a developer joining this project would genuinely ask, each answerable from the project\'s own record.',
  '', RECORD, '',
  ...(HARD ? HARDER : EASY),
  'Spread the questions across different parts of the project: no more than 3 about the same part. Every id you give must exist - check each one.',
  'Do not use any of these ids as evidence, they belong to other exams: ' + [...used].join(', '),
  '',
  'Reply with JSON only, no other text: {"cases": [{"id": "q<number>", "kind": "<kind>", "q": "<question>", "expect": {"thoughts": [], "commits": [], "code": []}}]}'
].join('\n');

console.log('writer agent working (several minutes)...');
const w = ask(WRITE, dir, ['Read', 'Grep', 'Glob', 'Bash(git log:*)', 'Bash(git show:*)', 'Bash(ls:*)']);
const spec = parseJson(w.text);
if (!spec || !Array.isArray(spec.cases)) { console.log('writer gave no usable JSON | $' + (w.cost || 0).toFixed(2)); fs.rmSync(frozen.parent, { recursive: true, force: true }); process.exit(1); }

const thoughtExists = (id) => ['.gitx/thoughts', '.gitx/context/thoughts'].some((d) => fs.existsSync(path.join(dir, d, id + '.json')));
const commitExists = (h) => { try { execFileSync('git', ['cat-file', '-e', h + '^{commit}'], { cwd: dir, stdio: 'ignore' }); return true; } catch (_) { return false; } };
const codeExists = (n) => { try { return execFileSync('git', ['grep', '-l', '-F', n], { cwd: dir, encoding: 'utf8' }).trim().length > 0; } catch (_) { return false; } };
const kept = [];
const dropped = { reused_id: 0, too_little_evidence: 0 };
let removedIds = 0, multiKind = 0;
spec.cases.forEach((c, i) => {
  const e = c.expect || {};
  const t = (e.thoughts || []).filter(thoughtExists), cm = (e.commits || []).filter(commitExists), cd = (e.code || []).filter(codeExists);
  removedIds += (e.thoughts || []).length + (e.commits || []).length + (e.code || []).length - t.length - cm.length - cd.length;
  if ([...t, ...cm.map((h) => h.slice(0, 7)), ...cd].some((x) => used.has(x))) { dropped.reused_id++; return; }
  const n = t.length + cm.length + cd.length;
  if (n < (HARD ? 2 : 1)) { dropped.too_little_evidence++; return; }
  if ([t, cm, cd].filter((x) => x.length).length >= 2) multiKind++;
  /* Ids carry no hint of the question: a slug would tell the reader what it is about. */
  kept.push({ id: NAME + '-' + String(kept.length + 1).padStart(2, '0'), kind: c.kind, q: c.q, expect: { ...(t.length ? { thoughts: t } : {}), ...(cm.length ? { commits: cm } : {}), ...(cd.length ? { code: cd } : {}) } });
});
const kinds = {}; for (const c of kept) kinds[c.kind] = (kinds[c.kind] || 0) + 1;
const ev = kept.map((c) => Object.values(c.expect).flat().length);
console.log('writer: ' + spec.cases.length + ' questions, kept ' + kept.length + ' | dropped ' + JSON.stringify(dropped) + ' | ids removed as missing: ' + removedIds + ' | evidence per question ' + Math.min(...ev) + '-' + Math.max(...ev) + ', with two or more kinds: ' + multiKind + ' | kinds ' + JSON.stringify(kinds) + ' | $' + (w.cost || 0).toFixed(2));

const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'w'));
const PARA = 'Here are questions about a software project you have never seen. Reword each one twice, as two different people who do not know the project\'s vocabulary would ask it: keep the meaning, add no details, and use your own words. Reply with JSON only: {"<id>": ["<rewording 1>", "<rewording 2>"]}.\n\n' + JSON.stringify(Object.fromEntries(kept.map((c) => [c.id, c.q])), null, 1);
const p = ask(PARA, empty, []);
const paras = parseJson(p.text) || {};
let reworded = 0;
for (const c of kept) { const r = paras[c.id]; if (Array.isArray(r) && r.length >= 2) { c.qs = [c.q, r[0], r[1]]; reworded++; } }
console.log('rewordings for ' + reworded + ' of ' + kept.length + ' | $' + (p.cost || 0).toFixed(2));

fs.writeFileSync(path.join(BENCH, NAME + '.json'), JSON.stringify({
  schema: 'gitx.bench-cases/0',
  note: 'HELD OUT - never tune on this set, and never read it while working on GitX. Written ' + new Date().toISOString().slice(0, 10) + ' by a fresh ' + MODEL + ' agent from the record at ' + head + ' with plain file tools (no GitX)' + (HARD ? ', each answer needing several records combined, worded as a newcomer would ask - score on recall as well as a first hit' : '') + '; no id reused from the other sets; each question reworded twice (qs 2, 3) by a second fresh agent that saw only the questions. The agent working on GitX saw counts only.',
  at: head,
  hard: HARD || undefined,
  cases: kept
}, null, 2) + '\n');
console.log('written .gitx/bench/' + NAME + '.json - ' + kept.length + ' questions');
fs.rmSync(frozen.parent, { recursive: true, force: true });
fs.rmSync(empty, { recursive: true, force: true });
