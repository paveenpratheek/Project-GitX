/*
 * Boredom (t-8154fa00ab): keeps GitX.md current while nobody is working.
 * The map is the stack's code layer only while it describes the code as it
 * is; the agent that changed the code updates the map at Stop, but commits by
 * the user, other tools and other agents go unseen without this.
 *
 * After a commit (the broker calls tick) or on its timer, once the code has
 * been quiet a while and no agent is working in the repository: if the map
 * has stale sections or changed code no section covers (tools/map-index.js),
 * Boredom runs a small model in strict mode on just those - read the changed
 * functions, update what each section says, add what nothing covered - with
 * edit rights on GitX.md and nothing else. The Stop hook holds it to the
 * changed functions (tools/boredom.js boredomNext). It then restamps only
 * the sections it fixed and logs the run with its cost. Off unless the user
 * turns it on; a daily spending cap bounds it.
 *
 *   node mcp/tools/boredom.js <repo> on|off|status|tick [--data <dir>] [--force]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapPath, stampMap, checkMap, bodyOf, sectionsOf } from './gitx-map.js';
import { ensureIndex, staleness, stampIndex, functionsOf } from './map-index.js';
import { readSpans } from './marks.js';
import { repoKey } from './path-recorder.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOK = path.join(HERE, '..', 'hook.js');
export const DEFAULTS = { enabled: false, model: 'haiku', effort: 'high', daily_cap_usd: 0.5, quiet_minutes: 2, max_minutes: 15 };
const cfgFile = (dir) => path.join(dir, '.gitx', 'boredom.json');
const logFile = (dir) => path.join(dir, '.gitx', 'boredom.jsonl');
const stateFile = (dir, data) => path.join(data, 'boredom', repoKey(dir) + '.json');
export const UPDATE_ROUNDS = 3;

export function config(dir) {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(cfgFile(dir), 'utf8')) }; } catch (_) { return { ...DEFAULTS }; }
}
export function setConfig(dir, patch) {
  const next = { ...config(dir), ...patch };
  fs.mkdirSync(path.dirname(cfgFile(dir)), { recursive: true });
  fs.writeFileSync(cfgFile(dir), JSON.stringify(next, null, 2) + '\n');
  return next;
}
const log = (dir, entry) => { fs.mkdirSync(path.dirname(logFile(dir)), { recursive: true }); fs.appendFileSync(logFile(dir), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n'); };
export function history(dir, n = 20) {
  try { return fs.readFileSync(logFile(dir), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).slice(-n); } catch (_) { return []; }
}
export const spentToday = (dir) => history(dir, 1000).filter((e) => String(e.at).slice(0, 10) === new Date().toISOString().slice(0, 10)).reduce((s, e) => s + (e.cost_usd || 0), 0);

/* Is the code still moving, or an agent at work? The newest change to a
 * code file, and the newest read any agent made in this repository. */
function lastActivity(dir, data) {
  let newest = 0;
  for (const f of new Set([...functionsOf(dir).values()].map((x) => x.file))) { try { newest = Math.max(newest, fs.statSync(path.join(dir, f)).mtimeMs); } catch (_) {} }
  let read = 0;
  if (data) { try { const lines = fs.readFileSync(path.join(data, 'reads', repoKey(dir) + '.jsonl'), 'utf8').trim().split('\n'); const x = JSON.parse(lines[lines.length - 1]); read = Date.parse(x.at) || 0; } catch (_) {} }
  return { code: newest, agent: read };
}
let running = null;

/* One look: what Boredom would do now, and - unless dry - doing it. */
/* Where GitX keeps reads and setup state - the folder the hook writes to. */
export function defaultData() {
  if (process.env.GITX_DATA_DIR) return process.env.GITX_DATA_DIR;
  try { return JSON.parse(fs.readFileSync(path.join(HERE, '..', '..', '.gitx', 'local.json'), 'utf8')).dataDir || null; } catch (_) { return null; }
}

export async function tick(dir, { data = defaultData(), dry = false, force = false } = {}) {
  const cfg = config(dir);
  if (!cfg.enabled && !force) return { did: 'off' };
  const file = mapPath(dir);
  if (!file) return { did: 'no map' };
  if (running) return { did: 'busy', with: running };
  ensureIndex(dir, file);
  const st = staleness(dir, file);
  if (!st.stale.length && !st.uncovered.length) return { did: 'nothing to do' };
  const act = lastActivity(dir, data), quiet = cfg.quiet_minutes * 60000, now = Date.now();
  if (!force && (now - act.code < quiet || now - act.agent < quiet)) return { did: 'waiting - code or an agent active', stale: st.stale.length, uncovered: st.uncovered.length };
  if (!force && spentToday(dir) >= cfg.daily_cap_usd) { log(dir, { did: 'capped', spent: spentToday(dir) }); return { did: 'capped' }; }
  if (dry) return { did: 'would update', stale: st.stale.map((s) => s.title), uncovered: st.uncovered.map((u) => u.name) };
  running = new Date().toISOString();
  try { return await update(dir, file, st, cfg, data); } finally { running = null; }
}

/* The brief: exactly which sections, which functions, where. */
export function briefOf(dir, file, st) {
  const fns = functionsOf(dir);
  const rel = path.relative(dir, file).replace(/\\/g, '/');
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const at = (title) => { const i = lines.findIndex((l) => /^#{2,3}\s/.test(l) && l.replace(/^#{2,3}\s+/, '').trim() === title); return i + 1; };
  const where = (n) => { const f = fns.get(n); return f ? f.file + ':' + f.from + '-' + f.to : 'gone'; };
  const out = ['GitX Boredom: the code changed since ' + rel + ' was last brought up to date. Update the map so it matches the code again - only the parts below.', ''];
  if (st.stale.length) {
    out.push('Sections whose code changed:');
    for (const s of st.stale) out.push('- "' + s.title + '" (' + rel + ' line ' + at(s.title) + '): changed ' + (s.changed.map((n) => n + ' at ' + where(n)).join(', ') || '-') + (s.missing.length ? '; gone: ' + s.missing.join(', ') : ''));
    out.push('');
  }
  if (st.uncovered.length) {
    out.push('Changed or new code no section covers:');
    for (const u of st.uncovered.slice(0, 25)) out.push('- ' + u.name + ' at ' + u.at + (u.isNew ? ' (new)' : ' (changed)'));
    out.push('');
  }
  out.push('Open each changed function with Read before you write about it. In each listed section keep what is still true, correct what changed, and remove what is gone. Put uncovered code into the section it belongs to - its Grep: line and what it does - or, if it fits nowhere, under ## Open leads as unread. State as found only what you read. Edit only ' + rel + ', and only these sections; leave the lines between the gitx:map markers on top alone, and do not touch sections that are not listed.');
  return out.join('\n');
}

const sectionHashes = (file) => {
  const body = bodyOf(fs.readFileSync(file, 'utf8')), lines = body.split('\n');
  return Object.fromEntries(sectionsOf(body).map((s) => [s.title, crypto.createHash('sha1').update(lines.slice(s.from - 1, s.to).join('\n')).digest('hex')]));
};
const othersOf = (dir, file) => {
  const out = {};
  for (const f of new Set([...functionsOf(dir).values()].map((x) => x.file))) { try { out[f] = fs.statSync(path.join(dir, f)).mtimeMs; } catch (_) {} }
  return out;
};

async function update(dir, file, st, cfg, data) {
  const t0 = Date.now();
  const before = sectionHashes(file), others = othersOf(dir, file);
  const rel = path.relative(dir, file).replace(/\\/g, '/');
  if (data) {
    fs.mkdirSync(path.dirname(stateFile(dir, data)), { recursive: true });
    fs.writeFileSync(stateFile(dir, data), JSON.stringify({ at: new Date().toISOString(), sections: st.stale.map((s) => s.title), fns: [...new Set(st.stale.flatMap((s) => s.changed))], uncovered: st.uncovered.map((u) => u.name), rounds: 0 }) + '\n');
  }
  const settings = path.join(data || path.join(dir, '.gitx'), 'boredom', 'settings.json');
  const h = [{ type: 'command', command: 'node "' + HOOK + '"' + (data ? ' --data "' + data + '"' : '') + ' --strict' }];
  fs.mkdirSync(path.dirname(settings), { recursive: true });
  fs.writeFileSync(settings, JSON.stringify({ hooks: { PostToolUse: [{ matcher: 'Read', hooks: h }], Stop: [{ hooks: h }] } }));
  const args = ['-p', '--output-format', 'json', '--model', cfg.model, '--effort', cfg.effort, '--setting-sources', 'local', '--disable-slash-commands', '--no-session-persistence',
    '--settings', settings, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--allowedTools', 'Read', 'Grep', 'Glob', 'Edit(' + rel + ')', '--disallowedTools', 'Write', 'MultiEdit', 'NotebookEdit', 'Bash', 'PowerShell', 'WebFetch', 'WebSearch', 'Task', 'Agent'];
  const result = await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: { ...process.env, GITX_STRICT: '1' } });
    child.stdin.end(briefOf(dir, file, st));
    let out = ''; child.stdout.on('data', (d) => { out += d; });
    const timer = setTimeout(() => child.kill(), cfg.max_minutes * 60000);
    child.on('close', () => { clearTimeout(timer); let r = {}; try { r = JSON.parse(out); } catch (_) {} resolve(r); });
  });
  if (data) { try { fs.unlinkSync(stateFile(dir, data)); } catch (_) {} }
  /* Only the map may change: any other file touched is reported, never kept quiet. */
  const touched = Object.entries(othersOf(dir, file)).filter(([f, m]) => others[f] !== undefined && others[f] !== m).map(([f]) => f);
  const after = sectionHashes(file);
  const updated = st.stale.map((s) => s.title).filter((t) => after[t] && after[t] !== before[t]);
  const chk = checkMap(dir, file);
  /* A section counts as fixed once rewritten; the uncovered names are handled
   * once the map names them, or the run tried and gave up (logged either way). */
  const named = new Set(); for (const m of fs.readFileSync(file, 'utf8').matchAll(/`([^`\n]+)`/g)) for (const n of m[1].matchAll(/[A-Za-z_$][\w$]*/g)) named.add(n[0]);
  const handled = st.uncovered.map((u) => u.name).filter((n) => named.has(n));
  stampIndex(dir, { file, only: updated, handled });
  const now = staleness(dir, file);
  stampMap(dir, file, { stale: now });
  const entry = { did: result.is_error || result.subtype !== 'success' ? 'failed' : 'updated', sections: updated, missed: st.stale.map((s) => s.title).filter((t) => !updated.includes(t)), handled, unhandled: st.uncovered.map((u) => u.name).filter((n) => !handled.includes(n)),
    names_not_in_code: chk ? chk.missing : [], touched_other_files: touched, cost_usd: result.total_cost_usd || 0, seconds: Math.round((Date.now() - t0) / 1000), turns: result.num_turns || 0, model: cfg.model };
  log(dir, entry);
  return entry;
}

/* At Stop (hook.js), while a Boredom update runs: the agent goes back if it
 * wrote without opening the changed functions, or named code that is not
 * there - at most UPDATE_ROUNDS times. */
export function boredomNext(dir, data) {
  let s; try { s = JSON.parse(fs.readFileSync(stateFile(dir, data), 'utf8')); } catch (_) { return null; }
  if (s.rounds >= UPDATE_ROUNDS) return null;
  const fns = functionsOf(dir), spans = readSpans(dir, data, Date.parse(s.at));
  const unopened = [...s.fns, ...s.uncovered].filter((n) => { const f = fns.get(n); return f && !(spans.get(f.file) || []).some(([a, b]) => a <= f.to && b >= f.from); });
  const chk = checkMap(dir);
  const why = [];
  if (unopened.length) why.push('You have not opened these changed functions: ' + unopened.slice(0, 15).join(', ') + '. Read each before the map says anything about it.');
  if (chk && chk.missing.length) why.push('These names in the map are not in the code: ' + chk.missing.slice(0, 15).join(', ') + '. Fix or remove them.');
  if (!why.length) return null;
  s.rounds++;
  fs.writeFileSync(stateFile(dir, data), JSON.stringify(s) + '\n');
  return 'GitX Boredom (strict): ' + why.join(' ') + ' Round ' + s.rounds + ' of ' + UPDATE_ROUNDS + '.';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2), i = argv.indexOf('--data');
  const data = i >= 0 ? argv[i + 1] : defaultData();
  const [repo, cmd = 'status'] = argv.filter((a, k) => !a.startsWith('--') && !(i >= 0 && k === i + 1));
  if (!repo) { console.error('usage: node mcp/tools/boredom.js <repo> on|off|status|tick [--data <dir>] [--force]'); process.exit(1); }
  if (cmd === 'on' || cmd === 'off') console.log(JSON.stringify(setConfig(repo, { enabled: cmd === 'on' })));
  else if (cmd === 'tick') console.log(JSON.stringify(await tick(repo, { data, force: process.argv.includes('--force') }), null, 1));
  else { console.log(JSON.stringify({ config: config(repo), spent_today: spentToday(repo), would: await tick(repo, { data, dry: true, force: true }), last: history(repo, 5) }, null, 1)); }
}
