/* The guardrails (mcp/tools/guardrails.js): files that must never be staged,
 * and secrets in what is about to be committed. The fake secrets are built at
 * run time, so no file here looks like a real one. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scanContent, validateFilePaths } from '../mcp/tools/guardrails.js';

const fake = {
  anthropic: 'sk-' + 'ant-' + 'x'.repeat(30),
  github: 'gh' + 'p_' + 'A'.repeat(36),
  google: 'AI' + 'za' + 'B'.repeat(35),
  aws: 'AK' + 'IA' + 'C'.repeat(16),
  key: '-----BEGIN ' + 'PRIVATE KEY-----',
};

test('a secret in what is committed is caught, and named', () => {
  for (const [kind, secret] of Object.entries(fake)) {
    const r = scanContent('const k = "' + secret + '";', 'config.js');
    assert.equal(r.allowed, false, kind);
    assert.match(r.reason, /config\.js/);
  }
});

test('ordinary code passes', () => {
  assert.deepEqual(scanContent('export function add(a, b) { return a + b; }', 'add.js'), { allowed: true });
  assert.deepEqual(scanContent(''), { allowed: true });
});

test('files that hold secrets are never staged', () => {
  for (const f of ['.env', 'app/.env.local', 'certs/server.pem', 'keys/id_rsa', 'gcp/credentials.json', 'service-account-prod.json'])
    assert.equal(validateFilePaths([f]).allowed, false, f);
  assert.equal(validateFilePaths(['src\\.env']).allowed, false, 'Windows paths too');
  assert.equal(validateFilePaths(['README.md', 'mcp/server.js', 'docs/environment.md']).allowed, true);
});
