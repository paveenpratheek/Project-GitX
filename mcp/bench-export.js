#!/usr/bin/env node
/*
 * The benchmark record as one readable page: every agent run kept under
 * .gitx/bench/runs, one row per run and arm, summed from the run files as they
 * are - questions answered, found, tokens, cost and time. The run files stay
 * private to the clone that made them (.gitignore); this page is what can be
 * shared, so the numbers a README quotes can be checked against every run.
 *
 *   node mcp/bench-export.js [repo ...] > docs/benchmarks.md
 *
 * Each repo is a folder whose .gitx/bench/runs holds GitX bench runs; with
 * none given, this repository. bench.js runs, which judge GitX's own answer
 * with no agent, are counted but have no tokens or cost to show.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repos = process.argv.slice(2).length ? process.argv.slice(2) : [here];

const kindOf = (file) => (/^(one-agent|agent|task|natural)-/.exec(file) || [null, 'gitx-only'])[1];
const money = (n) => '$' + n.toFixed(2);
const mtok = (n) => (n / 1e6).toFixed(2) + 'M';

const rows = [];
const counted = { runs: 0, gitxOnly: 0 };
for (const repo of repos) {
  const dir = path.join(repo, '.gitx', 'bench', 'runs');
  if (!fs.existsSync(dir)) continue;
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
    counted.runs++;
    const kind = kindOf(file);
    if (kind === 'gitx-only' || !Array.isArray(d.runs)) { counted.gitxOnly++; continue; }
    const arms = new Map();
    for (const r of d.runs) {
      if (!r || typeof r !== 'object' || !r.arm) continue;
      const a = arms.get(r.arm) || { model: r.model || d.model || '', n: 0, answered: 0, hit: 0, tokens: 0, cost: 0, seconds: 0, hasHit: false };
      // one-agent runs give one row per arm with its counts; the others one row per question
      const asked = Array.isArray(r.per) ? r.per.length : 1;
      a.n += asked;
      a.answered += typeof r.answered === 'number' ? r.answered : (r.answer ? 1 : 0);
      if (typeof r.hit === 'number' || typeof r.hit === 'boolean') { a.hit += Number(r.hit); a.hasHit = true; }
      a.tokens += Number(r.tokens) || 0;
      a.cost += Number(r.cost_usd) || 0;
      a.seconds += Number(r.seconds) || 0;
      arms.set(r.arm, a);
    }
    for (const [arm, a] of arms) {
      rows.push({ when: String(d.when || '').slice(0, 10), repo: path.basename(repo), kind, at: d.at || '', arm, ...a });
    }
  }
}

const out = [];
out.push('# GitX benchmark runs', '');
out.push('Every agent run kept under `.gitx/bench/runs`, one row per run and arm, summed from the run files by');
out.push('`node mcp/bench-export.js`. Questions come from the sets in `.gitx/bench`: held-out sets written by a');
out.push("fresh agent and never used for tuning, and tuning sets of the owner's own questions. \"Found\" is the");
out.push('questions whose expected answer the arm found. "hand" arms read files with git,');
out.push('Grep and Read; the others work through GitX. Costs are what each agent run reported.', '');
out.push(`${counted.runs} runs in all: ${counted.runs - counted.gitxOnly} with agents, below, and ${counted.gitxOnly} that judge GitX's own answer with no agent.`, '');
out.push('| Date | Repository | Bench | At | Model | Arm | Asked | Answered | Found | Tokens | Cost | Time |');
out.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const r of rows) {
  out.push(`| ${r.when} | ${r.repo} | ${r.kind} | ${r.at} | ${r.model.replace(/^claude-/, '')} | ${r.arm} | ${r.n} | ${r.answered} | ${r.hasHit ? r.hit : '-'} | ${mtok(r.tokens)} | ${money(r.cost)} | ${r.seconds} s |`);
}
const sum = rows.reduce((s, r) => ({ n: s.n + r.n, tokens: s.tokens + r.tokens, cost: s.cost + r.cost }), { n: 0, tokens: 0, cost: 0 });
out.push('', `${rows.length} arm rows, ${sum.n} questions asked of agents, ${mtok(sum.tokens)} tokens, ${money(sum.cost)} in all.`);
process.stdout.write(out.join('\n') + '\n');
