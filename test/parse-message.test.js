/* How GitX reads a commit message (mcp/tools/git-extract.js parseMessage): the
 * prose is the why; the GitX trailers are the links between commits and the
 * thoughts they settle. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage } from '../mcp/tools/git-extract.js';

test('a conventional header gives the type and scope', () => {
  const m = parseMessage('feat(map-view): a hex map', 'feat(map-view): a hex map\n\nWhy it exists.');
  assert.equal(m.type, 'feat');
  assert.equal(m.scope, 'map-view');
  assert.equal(m.body, 'Why it exists.', 'the subject is not counted twice');
});

test('GitX trailers become links, thoughts and a root; other trailers leave the body', () => {
  const body = ['fix(index): read trailers above the last paragraph', '', 'The why, in prose.', '',
    'GitX-Root: graph-caching', 'GitX-Builds-On: 2517a21', 'GitX-Relates-To: e634277, d3e753a',
    'GitX-Thoughts: t-b4e063ced0, t-945f7c4003', 'Co-Authored-By: Someone <someone@example.invalid>'].join('\n');
  const m = parseMessage('fix(index): read trailers above the last paragraph', body);
  assert.equal(m.root, 'graph-caching');
  assert.deepEqual(m.thoughts, ['t-b4e063ced0', 't-945f7c4003']);
  assert.deepEqual(m.trailers.map((t) => t.kind + ' ' + t.ref),
    ['builds-on 2517a21', 'relates-to e634277', 'relates-to d3e753a']);
  assert.equal(m.body, 'The why, in prose.', 'Co-Authored-By and the GitX lines are not words of the commit');
});

test('a paragraph of GitX lines above the trailer block is read too; one with prose stays body', () => {
  const split = parseMessage('feat: x', ['feat: x', '', 'Why.', '', 'GitX-Builds-On: 101d686', '',
    'GitX-Thoughts: t-0123456789', 'Co-Authored-By: A <a@example.invalid>'].join('\n'));
  assert.deepEqual(split.trailers, [{ kind: 'builds-on', ref: '101d686' }]);
  assert.deepEqual(split.thoughts, ['t-0123456789']);
  const prose = parseMessage('feat: x', ['feat: x', '', 'Note: this paragraph is prose', 'GitX-Builds-On: 101d686', '',
    'GitX-Thoughts: t-0123456789'].join('\n'));
  assert.deepEqual(prose.trailers, []);
  assert.match(prose.body, /Note: this paragraph is prose/);
});

test('a message with no trailers is kept whole', () => {
  const m = parseMessage('chore: tidy', 'chore: tidy\n\nOne paragraph.\n\nAnother.');
  assert.equal(m.body, 'One paragraph.\n\nAnother.');
  assert.deepEqual([m.trailers, m.thoughts, m.root], [[], [], null]);
});
