/*
 * The code under a commit (t-4f0de6c907): the lines it added and removed,
 * exactly as git has them, grouped by the regions the commit index names - so
 * an agent that pinpointed the commit where a feature was added or updated
 * opens its code there, one layer down.
 *
 * A READER, like everything in this folder: one `git show`, nothing written.
 *
 * Same flags as the index's patch pass (-U0, --no-renames) and the same
 * parser (parseHunkBlocks), so every region here is a key the index scored.
 * With context lines git cuts the hunks differently and names other
 * declarations, and the code an agent opened would sit under a region no
 * search ever ranked.
 *
 * Where that code is today is a second, optional step (today: true): the
 * region's declaration looked up in the working tree's file by the same
 * normalisation the key was made with. A name, not a coordinate - found
 * wherever the file has grown since, and said to be missing when it was
 * renamed, moved or removed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseHunkBlocks, normalizeContext } from './git-extract.js';

/* Lines across one answer before it stops and says how to read the rest. A
 * commit that rewrote a stylesheet would otherwise arrive as thousands of
 * lines nobody asked for; one region at a time is always whole. */
const LINE_CAP = 400;

/**
 * @param repoDir
 * @param hash     a full commit hash (graphCommit resolves prefixes)
 * @param opts
 *   region    a region, a file or a directory: only the code under it
 *   today     also say where each region's declaration is now
 *   maxLines  the line budget (default LINE_CAP; a region asked for by name
 *             is never cut)
 */
export function commitCode(repoDir, hash, { region = null, today = false, maxLines = LINE_CAP } = {}) {
  const git = (args) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });

  let parents;
  try { parents = git(['rev-list', '--parents', '-n', '1', hash]).trim().split(/\s+/).slice(1); } catch (_) {
    return { error: 'git does not know ' + hash + ' in this repository.' };
  }
  /* The index reads `git log -p`, which shows a merge no diff of its own; a
   * merge's code is in the commits it joined. Said rather than shown empty. */
  if (parents.length > 1) {
    return { regions_changed: 0, lines_changed: 0, code: [], note: 'A merge: its changes are in the commits it joins (' + parents.map((p) => p.slice(0, 8)).join(', ') + ') - read those.' };
  }

  /* --no-textconv: git for Windows ships `*.pdf diff=astextplain`, which
   * shows a PDF as its extracted text - 851 "lines" for a design record that
   * is one binary file. The commit stored the file, so a binary file is said
   * to be one, and the code shown is only ever what the commit holds. Its
   * region is the same key either way: a file with no declaration is '::*'. */
  let patch;
  try { patch = git(['show', '-U0', '--patch', '--no-renames', '--no-color', '--no-textconv', '--no-ext-diff', '--format=', hash]); } catch (_) {
    return { error: 'git could not show the changes of ' + hash + '.' };
  }

  const groups = new Map();
  for (const b of parseHunkBlocks(patch)) {
    if (!groups.has(b.region)) groups.set(b.region, { region: b.region, file: b.file, hunks: [], changed: 0, binary: false, file_status: b.file_status });
    const g = groups.get(b.region);
    if (b.binary) g.binary = true;
    else { g.hunks.push(b); g.changed += b.lines.length; }
  }
  const total = [...groups.values()].reduce((s, g) => s + g.changed, 0);
  let list = [...groups.values()].sort((a, b) => b.changed - a.changed || a.region.localeCompare(b.region));

  const all = list.map((g) => g.region);
  if (region) {
    const q = String(region).trim().replace(/\\/g, '/');
    list = list.filter((g) => g.region === q || g.region.startsWith(q) || g.file === q ||
      (q.endsWith('/') && g.file.startsWith(q)) || (!q.includes('/') && declOf(g.region).includes(q)));
    if (!list.length) return { error: 'This commit changed nothing under "' + region + '".', regions: all };
  }
  /* Asked for by name, the code comes whole; otherwise the budget holds. */
  const budget = region ? Infinity : maxLines;

  const fileCache = new Map();
  let shown = 0, cut = 0;
  const code = list.map((g) => {
    const added = g.hunks.reduce((s, h) => s + h.lines.filter((l) => l[0] === '+').length, 0);
    const out = {
      region: g.region,
      share: total ? +(g.changed / total).toFixed(2) : undefined,
      added, removed: g.changed - added,
      file_status: g.file_status || undefined,
      binary: g.binary || undefined,
      today: today ? whereToday(repoDir, g.file, declOf(g.region), fileCache) : undefined,
      hunks: []
    };
    for (const h of g.hunks) {
      const room = budget - shown;
      if (room <= 0) { cut += h.lines.length; continue; }
      const lines = h.lines.length > room ? h.lines.slice(0, room) : h.lines;
      shown += lines.length;
      if (lines.length < h.lines.length) cut += h.lines.length - lines.length;
      out.hunks.push(prune({
        at: h.new.lines > 0 ? 'lines ' + h.new.start + '-' + (h.new.start + h.new.lines - 1) : 'removed after line ' + h.new.start,
        lines,
        not_shown: lines.length < h.lines.length ? h.lines.length - lines.length : undefined
      }));
    }
    if (!out.hunks.length) delete out.hunks;
    return prune(out);
  });

  return prune({
    regions_changed: all.length,
    lines_changed: total,
    lines_shown: shown,
    code,
    more: cut ? cut + ' changed line(s) not shown - pass region with one of the regions above to read it whole.' : undefined
  });
}

/* The declaration half of a region key; '*' is a whole-file change. */
function declOf(region) {
  const i = region.indexOf('::');
  return i < 0 ? '*' : region.slice(i + 2);
}

function whereToday(repoDir, file, decl, cache) {
  if (!cache.has(file)) {
    let text = null;
    try { text = fs.readFileSync(path.join(repoDir, file), 'utf8'); } catch (_) {}
    cache.set(file, text === null ? null : text.split(/\r?\n/));
  }
  const lines = cache.get(file);
  if (!lines) return 'the file is not in the working tree now - moved, renamed or deleted since';
  if (decl === '*') return 'whole-file change, no declaration to find - ' + file + ' is still there';
  const at = [];
  for (let i = 0; i < lines.length; i++) if (normalizeContext(lines[i]) === decl) at.push(i + 1);
  if (!at.length) return 'not in ' + file + ' now - the declaration was renamed or removed since';
  return file + ' line ' + at[0] + (at.length > 1 ? ' (also ' + at.slice(1, 4).join(', ') + ')' : '');
}

function prune(o) {
  for (const k of Object.keys(o)) if (o[k] === undefined) delete o[k];
  return o;
}
