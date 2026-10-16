/*
 * A status that may have fallen behind the code. A thought marked ACCEPTED -
 * NOT BUILT or PROPOSED that names code existing at HEAD - a function, an
 * identifier, a file - may have been built since, or may be about changing
 * that code: either way the agent should look before taking the status as
 * current. Debriefed agents (15 October) treated every such status as a claim
 * to check by hand, which cancelled much of the time GitX saves; one met
 * "ACCEPTED - NOT BUILT" on a tool it was calling.
 *
 * Only a hint, never a change of status: the thought graph is not rewritten.
 */

import path from 'node:path';
import { buildCodeIndex } from './code-find.js';

const ID = /\b(?:[a-z][a-z0-9]*_[a-z0-9_]+|[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+)\b/g;
const FILE = /\b[\w-]+\.(?:js|mjs|cjs|ts|py|css|html|json|md)\b/g;
const cache = new Map();          // repoDir -> { cx, names, files }

function namesAt(repoDir) {
  const cx = buildCodeIndex(repoDir);
  const hit = cache.get(repoDir);
  if (hit && hit.cx === cx) return hit;
  const names = new Set(), files = new Set();
  for (const r of cx.regions) {
    if (r.kind === 'doc') continue;
    files.add(path.basename(r.file));
    for (const m of String(r.text || '').matchAll(ID)) names.add(m[0]);
  }
  const out = { cx, names, files };
  cache.set(repoDir, out);
  return out;
}

export function staleOf(repoDir, status, text) {
  const s = String(status || '');
  if (!/^(ACCEPTED - NOT BUILT|PROPOSED)/.test(s)) return {};
  try {
    const { names, files } = namesAt(repoDir);
    const t = String(text || '');
    const found = new Set();
    for (const m of t.matchAll(ID)) if (names.has(m[0])) found.add(m[0]);
    for (const m of t.matchAll(FILE)) if (files.has(m[0])) found.add(m[0]);
    for (const m of t.matchAll(/`([^`]+)`/g)) { const w = m[1].trim(); if (names.has(w) || files.has(w)) found.add(w); }
    if (!found.size) return {};
    return { check_status: 'names code that exists at HEAD (' + [...found].slice(0, 4).join(', ') + ') - it may be built since, or be about changing it: check before taking "' + s.split(' - ').slice(0, 2).join(' - ') + '" as current' };
  } catch (_) { return {}; }
}
