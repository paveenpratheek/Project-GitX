/*
 * The natural bench: an agent given what a user would say, in a folder that
 * looks like the project, measured from outside.
 *
 * The scored benches ask for ids to cite and run in a copy of the repository;
 * that copy was named gitx-bench-<random>, and with the citation rules the
 * prompt read like an exam. Asked "What is GitX? Find out as much as you can"
 * that way, Claude agents checked GitX against git log, fetched repo-wide
 * lists and one dumped every thought file; given the owner's own words in a
 * folder called "Project GitX", the same model used only GitX - the skill, the
 * map, four structured questions - at 62% fewer tokens than by hand.
 *
 * So here the agent gets the words as given, typos and all, and nothing about
 * timing, tokens or citing; the copy sits in a plain temp folder under the
 * project's own name; the GitX arm has v3.1 and thermal on, an empty learning
 * folder, and the GitX skill in the copy (as agy has it globally). Time,
 * tokens, cost and every call are read from Claude's own event stream.
 *
 *   node mcp/bench-natural.js [--arms=hand,gitx] [--model=claude-sonnet-5-5]
 *        [--hand="<prompt>"] [--gitx="<prompt>"] [--skill=<SKILL.md>]
 *
 * Writes temporary folders and <repo>/.gitx/bench/runs/natural-*.json, with
 * each answer beside it as natural-*-<arm>.md.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freeze } from './bench.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..');
const argv = process.argv.slice(2);
const eq = (name, dflt) => { const a = argv.find((x) => x.startsWith('--' + name + '=')); return a ? a.slice(name.length + 3) : dflt; };
const MODEL = eq('model', 'claude-sonnet-5-5');
const ARMS = eq('arms', 'hand,gitx').split(',');
/* The owner's own words to agy, 2026-10-13. */
const PROMPTS = {
  hand: eq('hand', 'i want you to tell me everything you can know about this program Project GitX. search, read and understand the structure of this program and how this works. BUT DO NOT CHANGE OR WRITE ANYTHING IN THIS FOLDER PROJECT GITX'),
  gitx: eq('gitx', 'i want you to tell mw everything you can know about this program Progect GitX. Search, read and understand the structure of this program and how this works. USE ONLY GITX TOOL TO FIND REQUIRED INFORMATION WHEN NECESSARY')
};
const SKILL = eq('skill', path.join(os.homedir(), '.gemini', 'config', 'skills', 'gitx', 'SKILL.md'));

function run(arm) {
  const frozen = freeze('HEAD');
  const dir = frozen.dir;
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-data-'));
  const mcp = arm === 'hand' ? { mcpServers: {} }
    : { mcpServers: { gitx: { command: process.execPath, args: [path.join(HERE, 'server.js')], env: { GITX_DATA_DIR: data, GITX_BROKER_URL: 'ws://127.0.0.1:9', GITX_THERMAL: '1', GITX_LENS: '1', GITX_V31: '1' } } } };
  const mcpFile = path.join(data, 'mcp.json');
  fs.writeFileSync(mcpFile, JSON.stringify(mcp));
  if (arm !== 'hand' && fs.existsSync(SKILL)) {
    fs.mkdirSync(path.join(dir, '.claude', 'skills', 'gitx'), { recursive: true });
    fs.copyFileSync(SKILL, path.join(dir, '.claude', 'skills', 'gitx', 'SKILL.md'));
  }
  const allow = ['Read', 'Grep', 'Glob', 'Bash', 'PowerShell', ...(arm !== 'hand' ? ['mcp__gitx', 'Skill'] : [])];
  const args = ['-p', PROMPTS[arm] || PROMPTS.gitx, '--output-format', 'stream-json', '--verbose', '--model', MODEL,
    '--setting-sources', 'project,local', '--no-session-persistence', '--strict-mcp-config', '--mcp-config', mcpFile,
    '--allowedTools', ...allow, '--disallowedTools', 'Edit', 'Write', 'NotebookEdit', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn('claude', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let buf = '', result = null; const calls = [];
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch (_) { continue; }
        if (m.type === 'assistant') for (const b of (m.message && m.message.content) || []) if (b.type === 'tool_use') calls.push({ tool: b.name, input: b.input });
        if (m.type === 'result') result = m;
      }
    });
    const timer = setTimeout(() => child.kill(), 30 * 60 * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      const u = (result && result.usage) || {};
      const out = { arm, model: MODEL, prompt: PROMPTS[arm] || PROMPTS.gitx, seconds: Math.round((Date.now() - t0) / 1000), cost_usd: result ? result.total_cost_usd : null, turns: result ? result.num_turns : null,
        tokens: { input: u.input_tokens || 0, cache_write: u.cache_creation_input_tokens || 0, cache_read: u.cache_read_input_tokens || 0, output: u.output_tokens || 0 },
        answer: result ? String(result.result || '') : '(no result)', calls: calls.map((c) => c.tool.replace('mcp__gitx__', 'gitx:') + ' ' + JSON.stringify(c.input).slice(0, 220)) };
      out.tokens.total = out.tokens.input + out.tokens.cache_write + out.tokens.cache_read + out.tokens.output;
      for (const d of [frozen.parent, data]) fs.rmSync(d, { recursive: true, force: true });
      resolve(out);
    });
  });
}

const rows = await Promise.all(ARMS.map(run));
const runs = path.join(REPO, '.gitx', 'bench', 'runs');
fs.mkdirSync(runs, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
fs.writeFileSync(path.join(runs, 'natural-' + stamp + '.json'), JSON.stringify({ schema: 'gitx.bench-natural/0', when: new Date().toISOString(), model: MODEL, runs: rows }, null, 2) + '\n');
for (const r of rows) {
  fs.writeFileSync(path.join(runs, 'natural-' + stamp + '-' + r.arm + '.md'), r.answer);
  const tools = {}; for (const c of r.calls) { const t = c.split(' ')[0]; tools[t] = (tools[t] || 0) + 1; }
  console.log('\n=== ' + r.arm + ': ' + r.seconds + ' s, $' + (r.cost_usd || 0).toFixed(2) + ', ' + r.turns + ' turns, ' + r.tokens.total + ' tokens (output ' + r.tokens.output + '), answer ' + r.answer.length + ' chars');
  console.log('tools: ' + JSON.stringify(tools));
  r.calls.forEach((c, i) => console.log('  ' + String(i + 1).padStart(2) + '. ' + c));
}
console.log('\nSaved .gitx/bench/runs/natural-' + stamp + '.json');
