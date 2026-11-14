/* The code layer (mcp/tools/code-find.js): files split into declaration-level
 * regions, each attributed by git blame to the commits whose lines it holds.
 * On a throwaway repository; the regions' cache is in the system temp folder. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codeRegions, splitFile } from '../mcp/tools/code-find.js';
import { tempRepo, write } from './helpers.js';

const A = '// says hello, so the greeting has one home\nexport function hello(name) {\n  return "hi " + name;\n}\n\n'
  + 'export function bye() {\n  return "bye";\n}\n';

test('a file splits at its declarations, each with the comment above it', () => {
  const named = splitFile('a.js', A.split('\n')).filter((r) => r.name.includes('function'));
  assert.deepEqual(named.map((r) => [r.name, r.from, r.to]),
    [['export function hello(name)', 1, 5], ['export function bye()', 6, 9]]);
});

test('each region is attributed to the commits whose lines it still holds', () => {
  const { dir, git } = tempRepo({ 'a.js': A }, 'feat(a): hello and bye');
  const first = git('rev-parse', '--short=12', 'HEAD').trim();
  const before = codeRegions(dir).regions.filter((r) => r.file === 'a.js');
  assert.deepEqual(before.map((r) => Object.keys(r.commits)), [[first], [first]]);

  write(dir, { 'a.js': A.replace('"bye"', '"goodbye"') });
  git('commit', '-q', '-am', 'fix(a): say goodbye');
  const second = git('rev-parse', '--short=12', 'HEAD').trim();
  const after = codeRegions(dir).regions.filter((r) => r.file === 'a.js');
  assert.deepEqual(Object.keys(after[0].commits), [first], 'hello untouched');
  assert.deepEqual(Object.keys(after[1].commits).sort(), [first, second].sort(), 'bye holds a line of each');
  assert.equal(after[1].commits[second], 1, 'one line changed');
});
