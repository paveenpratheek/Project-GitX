import fs from 'node:fs';
import path from 'node:path';
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
 * Inspects files staged or to be staged in a repository before committing.
 * @param {string} repoDir Directory of the git repository or worktree
 * @param {string[]} filesToStage Array of files requested to be committed
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function scanPreCommit(repoDir, filesToStage = []) {
  // 1. File path validation
  const pathCheck = validateFilePaths(filesToStage);
  if (!pathCheck.allowed) return pathCheck;

  // 2. File content scan on disk
  for (const relPath of filesToStage) {
    const fullPath = path.resolve(repoDir, relPath);
    if (fs.existsSync(fullPath)) {
      const stats = fs.statSync(fullPath);
      // Skip large binary files (> 1MB) for text scanning
      if (stats.size > 1024 * 1024) continue;

      try {
        const content = fs.readFileSync(fullPath, 'utf8');
        const contentCheck = scanContent(content, relPath);
        if (!contentCheck.allowed) return contentCheck;
      } catch (_) {
        // Binary or unreadable, skip content scan
      }
    }
  }

  return { allowed: true };
}
