/* What the tests share: a throwaway git repository, and the server pointed
 * away from anything of the user's - its own data folder, no broker. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export function tempRepo(files = {}, message = 'feat(a): a start') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-test-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'GitX test');
  git('config', 'core.autocrlf', 'false');
  write(dir, files);
  if (Object.keys(files).length) { git('add', '-A'); git('commit', '-q', '-m', message); }
  return { dir, git };
}

export function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
    fs.writeFileSync(path.join(dir, name), text);
  }
}

/* Nothing of the user's: a data folder of its own, no local.json, and a broker
 * address where nothing listens, so the server never reaches a running one. */
export function isolatedEnv(extra = {}) {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'gitx-data-'));
  return {
    ...process.env, GITX_DATA_DIR: data, GITX_LOCAL_FILE: path.join(data, 'none.json'),
    GITX_BROKER_URL: 'ws://127.0.0.1:9', GITX_BROKER_AUTOSTART: '0', GITX_NO_CONSOLE: '1', ...extra,
  };
}
