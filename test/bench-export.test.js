/* The benchmark page (mcp/bench-export.js): every run under .gitx/bench/runs,
 * one row per run and arm, summed from the run files as they are. On made-up
 * runs in a temporary folder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPORT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'bench-export.js');

test('each run and arm is one row, summed as the run files hold them', () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-bench-'));
  const runs = path.join(repo, '.gitx', 'bench', 'runs');
  fs.mkdirSync(runs, { recursive: true });
  const arm = (a, hit, tokens, cost, seconds) => ({ arm: a, model: 'claude-haiku-5-5', per: [{}, {}, {}], hit, answered: 3,
    tokens, cost_usd: cost, seconds });
  fs.writeFileSync(path.join(runs, 'one-agent-2026-10-16T00-00-00-000Z.json'), JSON.stringify({
    when: '2026-10-16T00:00:00Z', at: 'abc1234', model: 'claude-haiku-5-5',
    runs: [arm('hand', 2, '1000000', 0.5, 100), arm('lens31', 3, 400000, 0.2, 60)] }));
  fs.writeFileSync(path.join(runs, 'agent-2026-10-17T00-00-00-000Z.json'), JSON.stringify({
    when: '2026-10-17T00:00:00Z', at: 'abc1234', model: 'claude-sonnet-5-5',
    runs: [{ arm: 'gitx', id: 'q1', hit: true, answer: 'x', tokens: 10, cost_usd: 0.01, seconds: 2 },
      { arm: 'gitx', id: 'q2', hit: false, answer: 'y', tokens: 20, cost_usd: 0.02, seconds: 3 }] }));
  fs.writeFileSync(path.join(runs, '2026-10-18T00-00-00-000Z.json'), JSON.stringify({ when: '2026-10-18', variants: {} }));

  const page = execFileSync(process.execPath, [EXPORT, repo], { encoding: 'utf8' });
  assert.match(page, /3 runs in all: 2 with agents, below, and 1 that judge GitX's own answer with no agent\./);
  const rows = page.split('\n').filter((l) => /^\| 2026-/.test(l));
  assert.equal(rows.length, 3);
  const row = (arm) => rows.find((r) => r.includes('| ' + arm + ' |'));
  assert.match(row('hand'), /\| one-agent \| abc1234 \| haiku-5-5 \| hand \| 3 \| 3 \| 2 \| 1\.00M \| \$0\.50 \| 100 s \|/, 'tokens written as text still count');
  assert.match(row('gitx'), /\| agent \| abc1234 \| sonnet-5-5 \| gitx \| 2 \| 2 \| 1 \| 0\.00M \| \$0\.03 \| 5 s \|/, 'a run of one row per question is summed');
  assert.match(page, /3 arm rows, 8 questions asked of agents, 1\.40M tokens, \$0\.73 in all\./);
});
