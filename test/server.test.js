/* The MCP server (mcp/server.js) over stdio, as an agent starts it: it answers
 * and lists its tools. In a throwaway repository, with a data folder of its own
 * and no broker, so it never reaches anything of the user's. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isolatedEnv, tempRepo } from './helpers.js';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'mcp', 'server.js');

function listTools(env) {
  const { dir } = tempRepo();
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [SERVER], { cwd: dir, env });
    const timer = setTimeout(() => { p.kill(); reject(new Error('the server did not answer in 20 s')); }, 20000);
    let buf = '';
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        const m = JSON.parse(line);
        if (m.id === 1) {
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
          p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
        } else if (m.id === 2) {
          clearTimeout(timer); p.kill(); resolve({ init: null, tools: m.result.tools });
        }
      }
    });
    p.on('error', reject);
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'gitx-test', version: '0' } } }) + '\n');
  });
}

const SIXTEEN = ['gitx_commit_chronicle', 'gitx_create_issue_with_branch', 'gitx_find_related', 'gitx_get_assigned_task',
  'gitx_get_swarm_status', 'gitx_graph_area', 'gitx_graph_chain', 'gitx_graph_commit', 'gitx_graph_map', 'gitx_investigate',
  'gitx_mark', 'gitx_search', 'gitx_thought', 'gitx_thought_catch_up', 'gitx_thought_history', 'gitx_thought_record'];

test('the server answers over stdio and serves its 16 tools, each described with a schema', async () => {
  const { tools } = await listTools(isolatedEnv());
  assert.deepEqual(tools.map((t) => t.name).sort(), SIXTEEN);
  for (const t of tools) {
    assert.ok(t.description && t.description.length > 40, t.name + ' says what it does');
    assert.equal(t.inputSchema.type, 'object', t.name + ' has a schema');
  }
});

test('with GITX_SUBJECTS=1 it also serves gitx_find, for exact lookups', async () => {
  const { tools } = await listTools(isolatedEnv({ GITX_SUBJECTS: '1' }));
  assert.ok(tools.some((t) => t.name === 'gitx_find'));
  assert.equal(tools.length, 17);
});
