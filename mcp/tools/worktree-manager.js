import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/**
 * Ensures an isolated Git Worktree exists for a given feature branch.
 * @param {string} repoRoot The primary git repository root
 * @param {string} branch The feature branch name (e.g. feat/customizable-ui)
 * @param {string} [sourceBranch='main'] The base branch to branch off from
 * @returns {{ worktreePath: string, branch: string, created: boolean, error?: string }}
 */
export function ensureWorktree(repoRoot, branch, sourceBranch = 'main') {
  const safeFolderName = branch.replace(/[^a-zA-Z0-9._-]/g, '-');
  const worktreesDir = path.join(repoRoot, '.gitx', 'worktrees');
  const targetWorktreePath = path.join(worktreesDir, safeFolderName);

  // Ensure parent .gitx/worktrees exists
  if (!fs.existsSync(worktreesDir)) {
    fs.mkdirSync(worktreesDir, { recursive: true });
  }

  // Check if worktree directory already exists on disk
  if (fs.existsSync(targetWorktreePath)) {
    return {
      worktreePath: targetWorktreePath,
      branch,
      created: false,
      note: 'Existing worktree re-used.'
    };
  }

  try {
    // Check if the branch already exists in git
    let branchExists = false;
    try {
      execFileSync('git', ['rev-parse', '--verify', branch], {
        cwd: repoRoot,
        stdio: 'ignore'
      });
      branchExists = true;
    } catch (_) {
      branchExists = false;
    }

    if (branchExists) {
      // Branch exists: attach worktree to existing branch
      execFileSync('git', ['worktree', 'add', targetWorktreePath, branch], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
    } else {
      // Branch does not exist: create branch from sourceBranch and mount worktree
      execFileSync('git', ['worktree', 'add', '-b', branch, targetWorktreePath, sourceBranch], {
        cwd: repoRoot,
        encoding: 'utf8'
      });
    }

    return {
      worktreePath: targetWorktreePath,
      branch,
      created: true
    };
  } catch (err) {
    return {
      worktreePath: repoRoot,
      branch,
      created: false,
      error: `Failed to provision Git Worktree: ${err.message}`
    };
  }
}

/**
 * Lists all active git worktrees in the repository.
 * @param {string} repoRoot 
 * @returns {Array<{ path: string, head: string, branch: string }>}
 */
export function listWorktrees(repoRoot) {
  try {
    const raw = execFileSync('git', ['worktree', 'list', '--porcelain'], {
      cwd: repoRoot,
      encoding: 'utf8'
    });

    const worktrees = [];
    let current = {};

    for (const line of raw.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        if (current.path) worktrees.push(current);
        current = { path: line.slice('worktree '.length).trim() };
      } else if (line.startsWith('HEAD ')) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ')) {
        current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
      } else if (line.trim() === '') {
        if (current.path) {
          worktrees.push(current);
          current = {};
        }
      }
    }
    if (current.path) worktrees.push(current);

    return worktrees;
  } catch (_) {
    return [];
  }
}

/**
 * Safely removes a worktree when an issue/task is completed or pruned.
 * @param {string} repoRoot 
 * @param {string} worktreePath 
 */
export function removeWorktree(repoRoot, worktreePath) {
  try {
    execFileSync('git', ['worktree', 'remove', worktreePath, '--force'], {
      cwd: repoRoot,
      stdio: 'ignore'
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
