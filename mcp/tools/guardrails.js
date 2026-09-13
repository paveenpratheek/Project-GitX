import { execFileSync } from 'node:child_process';

// File patterns that must never be staged or committed
const BLOCKED_FILE_PATTERNS = [
  /\.env(?:\.[a-zA-Z0-9_-]+)?$/i,         // .env, .env.local, .env.production
  /\.(?:pem|key|pfx|p12)$/i,                // Certificate and private key files
  /(?:^|[\\/])id_(?:rsa|ecdsa|ed25519|dsa)(?:\.pub)?$/i, // SSH keys
  /(?:^|[\\/])credentials(?:\.[a-zA-Z0-9]+)?\.json$/i,  // Cloud credentials
  /(?:^|[\\/])service-account(?:-[a-zA-Z0-9_-]+)?\.json$/i // GCP service accounts
];

// Token regex signatures for sensitive credentials
const SECRET_SIGNATURES = [
  { name: 'OpenAI API Key', regex: /sk-[a-zA-Z0-9_-]{24,}/ },
  { name: 'Anthropic API Key', regex: /sk-ant-[a-zA-Z0-9_-]{24,}/ },
  { name: 'GitHub Personal Access Token', regex: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'GitHub Fine-grained PAT', regex: /github_pat_[a-zA-Z0-9_]{82}/ },
  { name: 'Google API Key', regex: /AIza[0-9A-Za-z-_]{35}/ },
  { name: 'AWS Access Key ID', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'Private Key Header', regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ }
];

/**
 * Validates a list of file paths against the secret file blocklist.
 * @param {string[]} files List of file paths to check
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function validateFilePaths(files) {
  for (const file of files) {
    const normalized = file.replace(/\\/g, '/');
    for (const pattern of BLOCKED_FILE_PATTERNS) {
      if (pattern.test(normalized)) {
        return {
          allowed: false,
          reason: `File '${file}' matches prohibited security pattern (${pattern.toString()}). Secrets must never be committed.`
        };
      }
    }
  }
  return { allowed: true };
}

/**
 * Scans raw content string for known secret token signatures.
 * @param {string} content
 * @param {string} [fileName]
 * @returns {{ allowed: boolean, reason?: string, matchType?: string }}
 */
export function scanContent(content, fileName = 'unspecified') {
  if (!content || typeof content !== 'string') return { allowed: true };

  for (const sig of SECRET_SIGNATURES) {
    if (sig.regex.test(content)) {
      return {
        allowed: false,
        reason: `Potential secret detected in '${fileName}': matches pattern for ${sig.name}.`,
        matchType: sig.name
      };
    }
  }
  return { allowed: true };
}

/**
 * Scans what is actually STAGED - the bytes the commit will contain.
 *
 * This replaces a scan of the files on disk, which is not the same thing twice
 * over: a secret staged and then deleted from the working copy passed a disk
 * scan and still landed in the commit, and only the paths a caller happened to
 * list were checked, while `git commit` takes everything that is staged.
 * @param {string} repoDir Directory of the git repository or worktree
 * @returns {{ allowed: boolean, reason?: string, files?: string[] }}
 */
export function scanStaged(repoDir) {
  const git = (args) => execFileSync('git', args,
    { cwd: repoDir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

  let files;
  try {
    // Added, copied, modified or renamed - a deletion has no content left to leak.
    files = git(['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR']).split('\0').filter(Boolean);
  } catch (err) {
    return { allowed: false, reason: 'Could not list the staged files, so nothing was scanned: ' + String(err.stderr || err.message).trim() };
  }

  const pathCheck = validateFilePaths(files);
  if (!pathCheck.allowed) return pathCheck;

  for (const rel of files) {
    let size = 0;
    try { size = Number(git(['cat-file', '-s', ':' + rel]).trim()); } catch (_) { continue; }
    // Skip large blobs (> 1MB) for text scanning - almost always binary
    if (size > 1024 * 1024) continue;

    let content = '';
    try { content = git(['show', ':' + rel]); } catch (_) { continue; }
    const contentCheck = scanContent(content, rel);
    if (!contentCheck.allowed) return contentCheck;
  }

  return { allowed: true, files };
}
