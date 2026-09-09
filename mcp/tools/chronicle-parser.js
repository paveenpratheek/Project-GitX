import { execFileSync } from 'node:child_process';

/**
 * Parses raw git commit body using the GitX 4-Layer Chronicle Grammar.
 * @param {string} fullMessage 
 * @param {string} summary 
 * @returns {object}
 */
export function parseChronicleMessage(fullMessage, summary = '') {
  const startTag = '=== GITX-CHRONICLE:START ===';
  const endTag = '=== GITX-CHRONICLE:END ===';

  const startIndex = fullMessage.indexOf(startTag);
  const endIndex = fullMessage.indexOf(endTag);

  // If no formal chronicle tags, parse as standard fallback commit
  if (startIndex === -1 || endIndex === -1 || endIndex <= startIndex) {
    return {
      isChronicle: false,
      summary: summary || fullMessage.split(/\r?\n/)[0] || 'Commit',
      stream: 'Standard',
      task: 'None',
      agentId: 'Human',
      motive: fullMessage.trim(),
      architecture: '',
      filesManifest: [],
      verification: 'Standard commit (No GitX Chronicle recorded)'
    };
  }

  const chronicleBody = fullMessage.slice(startIndex + startTag.length, endIndex).trim();

  // Extract layers using regex delimiters
  const l1Match = chronicleBody.match(/\[LAYER-1:\s*MOTIVE\]([\s\S]*?)(?=\[LAYER-2|$)/i);
  const l2Match = chronicleBody.match(/\[LAYER-2:\s*ARCHITECTURE\]([\s\S]*?)(?=\[LAYER-3|$)/i);
  const l3Match = chronicleBody.match(/\[LAYER-3:\s*CODE-MANIFEST\]([\s\S]*?)(?=\[LAYER-4|$)/i);
  const l4Match = chronicleBody.match(/\[LAYER-4:\s*VERIFICATION[^\n\]]*\]([\s\S]*?)$/i);

  const l1Text = l1Match ? l1Match[1].trim() : '';
  const l2Text = l2Match ? l2Match[1].trim() : '';
  const l3Text = l3Match ? l3Match[1].trim() : '';
  const l4Text = l4Match ? l4Match[1].trim() : '';

  // Parse Layer 1 metadata (Stream, Task, Agent, Motive text)
  const streamMatch = l1Text.match(/Stream:\s*([^\r\n|]+)/i);
  const taskMatch = l1Text.match(/Task:\s*([^\r\n|]+)/i);
  const agentMatch = l1Text.match(/Agent:\s*([^\r\n|]+)/i);

  const stream = streamMatch ? streamMatch[1].trim() : 'Core';
  const task = taskMatch ? taskMatch[1].trim() : 'Unspecified';
  const agentId = agentMatch ? agentMatch[1].trim() : 'Agent';

  // Extract motive description (everything after Motive:)
  const motiveDescMatch = l1Text.match(/Motive:\s*([\s\S]*)/i);
  const motive = motiveDescMatch ? motiveDescMatch[1].trim() : l1Text;

  // Parse Layer 3 code manifest files
  const filesManifest = [];
  for (const line of l3Text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') || trimmed.startsWith('*')) {
      const fileEntry = trimmed.slice(1).trim().split(/[: ]/)[0].trim();
      if (fileEntry) filesManifest.push(fileEntry);
    }
  }

  return {
    isChronicle: true,
    summary: summary || fullMessage.split(/\r?\n/)[0] || 'Chronicle Commit',
    stream,
    task,
    agentId,
    motive,
    architecture: l2Text,
    filesManifest,
    verification: l4Text
  };
}

/**
 * Scans real git history and reconstructs structured 4-layer chronicles.
 * @param {string} repoDir 
 * @param {number} [limit=50]
 * @returns {Array<object>}
 */
export function scanGitHistory(repoDir, limit = 50) {
  try {
    // Format: Hash%x1fAuthor%x1fEmail%x1fISO-Date%x1fSubject%x1fBody%x1e
    const raw = execFileSync('git', [
      'log',
      `-n`, String(limit),
      `--pretty=format:%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%B%x1e`
    ], {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024
    });

    const records = raw.split('\x1e').map(r => r.trim()).filter(Boolean);
    const chronicles = [];

    for (const rec of records) {
      const parts = rec.split('\x1f');
      if (parts.length < 6) continue;

      const [commitHash, author, email, timestamp, summary, body] = parts;
      const parsed = parseChronicleMessage(body, summary);

      chronicles.push({
        id: 'git-' + commitHash.slice(0, 12),
        commitHash,
        author,
        email,
        timestamp,
        ...parsed
      });
    }

    return chronicles;
  } catch (err) {
    console.error('[GitX Chronicle Parser] Failed to scan git log:', err.message);
    return [];
  }
}
