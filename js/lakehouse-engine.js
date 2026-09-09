/**
 * GitX Lakehouse Clustering Engine (Medallion Architecture: Bronze -> Silver -> Gold)
 */

/**
 * Clusters a chronological array of parsed commits into Bronze, Silver, and Gold views.
 * @param {Array<object>} chronicles 
 * @returns {{ gold: Array<object>, silver: Array<object>, bronze: Array<object> }}
 */
export function clusterLakehouse(chronicles = []) {
  // 1. BRONZE LAYER: Raw Chronological Stream (Newest first)
  const bronze = [...chronicles].sort((a, b) => {
    return new Date(b.timestamp || 0).getTime() - new Date(a.timestamp || 0).getTime();
  });

  // 2. SILVER LAYER: Semantic Feature Streams (Lineage Threads)
  const streamMap = new Map();

  for (const c of bronze) {
    const streamName = c.stream || 'Core';
    if (!streamMap.has(streamName)) {
      streamMap.set(streamName, {
        streamName,
        commits: [],
        uniqueFiles: new Set(),
        agents: new Set(),
        latestTimestamp: c.timestamp,
        earliestTimestamp: c.timestamp
      });
    }

    const streamObj = streamMap.get(streamName);
    streamObj.commits.push(c);
    (c.filesManifest || []).forEach(f => streamObj.uniqueFiles.add(f));
    if (c.agentId) streamObj.agents.add(c.agentId);
    if (c.author) streamObj.agents.add(c.author);
  }

  const silver = Array.from(streamMap.values()).map(s => ({
    streamName: s.streamName,
    commitCount: s.commits.length,
    commits: s.commits, // Sorted from newest to oldest in that stream
    filesList: Array.from(s.uniqueFiles),
    agentsList: Array.from(s.agents),
    latestTimestamp: s.latestTimestamp
  }));

  // 3. GOLD LAYER: Curated High-Level Feature State Overview
  const gold = silver.map(s => {
    const latestCommit = s.commits[0] || {};
    const hasVerification = latestCommit.verification && !latestCommit.verification.includes('No verification');
    
    // Status heuristic: Stable if verified & multiple commits, else Active
    let status = 'ACTIVE';
    if (hasVerification && s.commitCount >= 2) {
      status = 'STABLE';
    }

    return {
      streamName: s.streamName,
      status,
      commitCount: s.commitCount,
      filesCount: s.filesList.length,
      leadAgent: s.agentsList[0] || 'Unknown',
      latestSummary: latestCommit.summary || 'Initial feature setup',
      latestMotive: latestCommit.motive || '',
      latestVerification: latestCommit.verification || 'Pending verification'
    };
  });

  return { gold, silver, bronze };
}
