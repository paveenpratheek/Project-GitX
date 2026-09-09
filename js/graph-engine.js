/* GitX — Zero-Build 60FPS Force-Directed Lakehouse Network Graph Engine */

const BROKER_URL = 'ws://127.0.0.1:7771';
let ws = null;
let state = {
  activeRepo: '',
  activeRepoName: 'Loading...',
  activeBranch: 'main',
  chronicles: [],
  streams: {}
};

let lastKnownRepo = '';
let simulationActive = true;
let simAlpha = 1.0;
let searchQuery = '';
let visibleLayers = { gold: true, silver: true, bronze: true };

// Graph Nodes and Links model
let nodes = [];
let links = [];

// Viewport Transform
let panX = 0;
let panY = 0;
let zoom = 1.0;
let isPanning = false;
let startPanX = 0;
let startPanY = 0;

// Drag & Hover state
let hoveredNode = null;
let selectedNode = null;
let draggedNode = null;

// Canvas DOM
const canvas = document.getElementById('graph-canvas');
const ctx = canvas.getContext('2d');
const viewport = document.getElementById('canvas-viewport');
const tooltip = document.getElementById('graph-tooltip');

// -------------------------------------------------- Canvas Dynamic Resizing
function ensureCanvasDimensions() {
  const rect = viewport.getBoundingClientRect();
  const w = rect.width > 50 ? rect.width : (window.innerWidth || 1000);
  const h = rect.height > 50 ? rect.height : ((window.innerHeight - 52) || 680);

  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
    return true;
  }
  return false;
}

if (window.ResizeObserver) {
  const ro = new ResizeObserver(() => {
    if (ensureCanvasDimensions() && nodes.length > 0) {
      autoFitView();
    }
  });
  ro.observe(viewport);
}

// -------------------------------------------------- Ter-Manager Session Sync
function normPath(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveActiveRepo() {
  if (window.parent && window.parent !== window) {
    try {
      if (typeof window.parent.repoPath === 'function') {
        const p = window.parent.repoPath();
        if (p) return p;
      }
      if (typeof window.parent.activeSessionPath === 'function') {
        const p = window.parent.activeSessionPath();
        if (p) return p;
      }
    } catch (_) {}
  }
  try {
    const cwd = localStorage.getItem('gitDashboardCwd');
    if (cwd) return cwd;
  } catch (_) {}
  return '';
}

function checkActiveSession() {
  const cwd = resolveActiveRepo();
  if (cwd && normPath(cwd) !== normPath(lastKnownRepo)) {
    lastKnownRepo = cwd;
    console.log('[GitX Graph] Switching session repo:', cwd);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'SET_ACTIVE_REPO', repoPath: cwd }));
    }
  }
}

function initSessionSync() {
  checkActiveSession();
  window.addEventListener('storage', (e) => {
    if (e.key === 'gitDashboardCwd') checkActiveSession();
  });
  window.addEventListener('message', (e) => {
    if (e.data && (e.data.__gitx_refresh || e.data.type === 'GITX_REFRESH')) {
      checkActiveSession();
      ensureCanvasDimensions();
      simAlpha = 0.8;
      autoFitView();
    }
  });
  setInterval(checkActiveSession, 1000);
}

// -------------------------------------------------- WebSocket Broker Connect
function connectBroker() {
  try {
    ws = new WebSocket(BROKER_URL);
    ws.onopen = () => {
      console.log('[GitX Graph] Connected to Broker on 7771');
      if (lastKnownRepo) {
        ws.send(JSON.stringify({ type: 'SET_ACTIVE_REPO', repoPath: lastKnownRepo }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        if (msg.type === 'SYNC_STATE') {
          state = msg.state || state;
          updateHeaderBadge();
          buildGraphData();
        } else if (msg.type === 'CHRONICLE_COMMITTED') {
          state.chronicles.unshift(msg.chronicle);
          buildGraphData();
        }
      } catch (err) {
        console.error('[GitX Graph] Malformed broker msg:', err);
      }
    };

    ws.onclose = () => setTimeout(connectBroker, 3000);
  } catch (e) {
    console.warn('[GitX Graph] Broker connect error:', e.message);
  }
}

function updateHeaderBadge() {
  const nameEl = document.getElementById('badge-repo-name');
  const branchEl = document.getElementById('badge-branch-name');
  if (nameEl) nameEl.textContent = state.activeRepoName || 'Workspace';
  if (branchEl) branchEl.textContent = '[' + (state.activeBranch || 'main') + ']';
}

// -------------------------------------------------- Lakehouse Data to Interconnected Network
function buildGraphData() {
  ensureCanvasDimensions();

  const chronicles = state.chronicles || [];
  const newNodes = [];
  const newLinks = [];
  const nodeMap = new Map();

  let goldCount = 0;
  let silverCount = 0;
  let bronzeCount = 0;

  // Group commits by stream
  const streamMap = new Map();
  for (const c of chronicles) {
    const sName = c.stream || 'Core';
    if (!streamMap.has(sName)) {
      streamMap.set(sName, { name: sName, commits: [], files: new Set() });
    }
    const sObj = streamMap.get(sName);
    sObj.commits.push(c);
    (c.filesManifest || []).forEach(f => sObj.files.add(f));
  }

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const streamKeys = Array.from(streamMap.keys());
  const angleStep = (2 * Math.PI) / (streamKeys.length || 1);
  const hubRadius = Math.min(180, Math.max(90, streamKeys.length * 45));

  streamKeys.forEach((sName, sIdx) => {
    const sObj = streamMap.get(sName);
    const latest = sObj.commits[0] || {};
    const isStable = sObj.commits.length >= 2 && latest.verification && !latest.verification.includes('No verification');

    const goldId = 'gold_' + sName;
    const gx = cx + hubRadius * Math.cos(sIdx * angleStep);
    const gy = cy + hubRadius * Math.sin(sIdx * angleStep);

    // 1. Create GOLD Hub Node
    const goldNode = {
      id: goldId,
      name: sName,
      type: 'gold',
      radius: 26,
      color: '#e3b341',
      borderColor: '#ffffff',
      status: isStable ? 'STABLE' : 'ACTIVE',
      commitsCount: sObj.commits.length,
      filesCount: sObj.files.size,
      latestMotive: latest.motive || '',
      latestArch: latest.architecture || '',
      files: Array.from(sObj.files),
      x: gx,
      y: gy,
      vx: 0,
      vy: 0
    };

    newNodes.push(goldNode);
    nodeMap.set(goldId, goldNode);
    goldCount++;

    // 2. Create SILVER Lineage Node
    const silverId = 'silver_' + sName;
    const silverDist = 65;
    const sx = gx + silverDist * Math.cos(sIdx * angleStep + 0.3);
    const sy = gy + silverDist * Math.sin(sIdx * angleStep + 0.3);

    const silverNode = {
      id: silverId,
      name: 'Stream: ' + sName,
      type: 'silver',
      radius: 18,
      color: '#58a6ff',
      borderColor: '#ffffff',
      parentGold: goldId,
      commitsCount: sObj.commits.length,
      filesCount: sObj.files.size,
      x: sx,
      y: sy,
      vx: 0,
      vy: 0
    };

    newNodes.push(silverNode);
    nodeMap.set(silverId, silverNode);
    silverCount++;

    // Hierarchy Link: Gold -> Silver
    newLinks.push({
      source: goldNode,
      target: silverNode,
      type: 'hierarchy',
      length: 80,
      strength: 0.15
    });

    // 3. Create BRONZE Commit Nodes in an expanding golden spiral
    const goldenAngle = 2.39996; // (3 - Math.sqrt(5)) * Math.PI
    sObj.commits.forEach((c, cIdx) => {
      const bId = 'bronze_' + (c.commitHash || cIdx);
      
      // Sunflower spiral coordinates prevent overlapping heaps
      const spiralRadius = 55 + Math.sqrt(cIdx + 1) * 26;
      const bx = sx + spiralRadius * Math.cos(cIdx * goldenAngle);
      const by = sy + spiralRadius * Math.sin(cIdx * goldenAngle);

      const hasProof = c.verification && !c.verification.includes('No verification');

      const bronzeNode = {
        id: bId,
        name: (c.commitHash || '').slice(0, 7) || ('#c' + cIdx),
        type: 'bronze',
        radius: 11,
        color: hasProof ? '#3fb950' : '#8b949e',
        borderColor: '#ffffff',
        chronicle: c,
        summary: c.summary,
        motive: c.motive,
        architecture: c.architecture,
        files: c.filesManifest || [],
        verification: c.verification,
        author: c.author || c.agentId || 'Human',
        date: (c.timestamp || '').slice(0, 10),
        x: bx,
        y: by,
        vx: 0,
        vy: 0
      };

      newNodes.push(bronzeNode);
      nodeMap.set(bId, bronzeNode);
      bronzeCount++;

      // Hierarchy Link: Silver -> Bronze
      newLinks.push({
        source: silverNode,
        target: bronzeNode,
        type: 'hierarchy',
        length: 70 + (cIdx % 3) * 20,
        strength: 0.12
      });
    });
  });

  // 4. Generate Curated SEMANTIC CROSS-LINKS (Overlapping Modified Files in Image 2)
  // We cap cross-links to max 3 per node and ignore trivial root files
  const ignoredFiles = new Set(['package.json', 'package-lock.json', '.gitignore', 'readme.md', 'license']);
  const bronzeNodes = newNodes.filter(n => n.type === 'bronze');
  const nodeLinkCounts = new Map();

  for (let i = 0; i < bronzeNodes.length; i++) {
    for (let j = i + 1; j < bronzeNodes.length; j++) {
      const b1 = bronzeNodes[i];
      const b2 = bronzeNodes[j];

      const c1 = nodeLinkCounts.get(b1.id) || 0;
      const c2 = nodeLinkCounts.get(b2.id) || 0;
      if (c1 >= 3 || c2 >= 3) continue; // limit link density

      const f1 = (b1.files || []).filter(f => !ignoredFiles.has(f.toLowerCase()));
      const f2 = (b2.files || []).filter(f => !ignoredFiles.has(f.toLowerCase()));

      const shared = f1.filter(f => f2.includes(f));
      if (shared.length > 0) {
        newLinks.push({
          source: b1,
          target: b2,
          type: 'semantic',
          length: 120,
          strength: 0.05,
          sharedFiles: shared
        });
        nodeLinkCounts.set(b1.id, c1 + 1);
        nodeLinkCounts.set(b2.id, c2 + 1);
      }
    }
  }

  nodes = newNodes;
  links = newLinks;
  simAlpha = 1.0;

  // Update counter badges
  const cGold = document.getElementById('count-gold');
  const cSilver = document.getElementById('count-silver');
  const cBronze = document.getElementById('count-bronze');
  if (cGold) cGold.textContent = goldCount;
  if (cSilver) cSilver.textContent = silverCount;
  if (cBronze) cBronze.textContent = bronzeCount;

  autoFitView();
}

// -------------------------------------------------- View Auto-fit
function autoFitView() {
  if (nodes.length === 0) return;
  ensureCanvasDimensions();

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const n of nodes) {
    if (n.x < minX) minX = n.x;
    if (n.x > maxX) maxX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.y > maxY) maxY = n.y;
  }

  const graphW = Math.max(200, maxX - minX + 120);
  const graphH = Math.max(200, maxY - minY + 120);

  const scaleX = canvas.width / graphW;
  const scaleY = canvas.height / graphH;

  zoom = Math.min(1.15, Math.max(0.35, Math.min(scaleX, scaleY) * 0.88));
  panX = canvas.width / 2 - ((minX + maxX) / 2) * zoom;
  panY = canvas.height / 2 - ((minY + maxY) / 2) * zoom;
}

// -------------------------------------------------- Stable Force Simulation
function updatePhysics() {
  if (!simulationActive || simAlpha < 0.02) return;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;
  const activeNodes = nodes.filter(isNodeVisible);
  const nLen = activeNodes.length;

  // 1. Coulomb Repulsion (Clamped)
  for (let i = 0; i < nLen; i++) {
    const a = activeNodes[i];
    for (let j = i + 1; j < nLen; j++) {
      const b = activeNodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.max(14, Math.sqrt(dx * dx + dy * dy));

      if (dist < 380) {
        const repForce = Math.min(30, 900 / (dist * dist)) * simAlpha;
        const fx = (dx / dist) * repForce;
        const fy = (dy / dist) * repForce;

        if (a !== draggedNode) { a.vx -= fx; a.vy -= fy; }
        if (b !== draggedNode) { b.vx += fx; b.vy += fy; }
      }

      // Hard collision prevention
      const minDist = a.radius + b.radius + 8;
      if (dist < minDist) {
        const overlap = (minDist - dist) * 0.5;
        const nx = (dx / dist) * overlap;
        const ny = (dy / dist) * overlap;
        if (a !== draggedNode) { a.x -= nx; a.y -= ny; }
        if (b !== draggedNode) { b.x += nx; b.y += ny; }
      }
    }
  }

  // 2. Link Spring Tension
  for (const l of links) {
    if (!isNodeVisible(l.source) || !isNodeVisible(l.target)) continue;

    const dx = l.target.x - l.source.x;
    const dy = l.target.y - l.source.y;
    const dist = Math.max(1, Math.sqrt(dx * dx + dy * dy));
    const displacement = dist - l.length;
    const springForce = displacement * l.strength * simAlpha;

    const fx = (dx / dist) * springForce;
    const fy = (dy / dist) * springForce;

    if (l.source !== draggedNode) { l.source.vx += fx; l.source.vy += fy; }
    if (l.target !== draggedNode) { l.target.vx -= fx; l.target.vy -= fy; }
  }

  // 3. Center Gravity & Damping (With Speed Limit)
  const maxSpeed = 8.0;
  for (const n of activeNodes) {
    if (n === draggedNode) continue;

    n.vx += (cx - n.x) * 0.003 * simAlpha;
    n.vy += (cy - n.y) * 0.003 * simAlpha;

    // Friction
    n.vx *= 0.85;
    n.vy *= 0.85;

    // Velocity clamp
    const speed = Math.sqrt(n.vx * n.vx + n.vy * n.vy);
    if (speed > maxSpeed) {
      n.vx = (n.vx / speed) * maxSpeed;
      n.vy = (n.vy / speed) * maxSpeed;
    }

    n.x += n.vx;
    n.y += n.vy;
  }

  // Decay simulation energy gradually
  simAlpha = Math.max(0.015, simAlpha * 0.988);
}

function isNodeVisible(n) {
  if (!n) return false;
  if (n.type === 'gold' && !visibleLayers.gold) return false;
  if (n.type === 'silver' && !visibleLayers.silver) return false;
  if (n.type === 'bronze' && !visibleLayers.bronze) return false;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const hitName = (n.name || '').toLowerCase().includes(q);
    const hitMotive = (n.motive || n.latestMotive || '').toLowerCase().includes(q);
    const hitFiles = (n.files || []).some(f => f.toLowerCase().includes(q));
    return hitName || hitMotive || hitFiles;
  }
  return true;
}

// -------------------------------------------------- 60FPS High-DPI Canvas Rendering
function render() {
  ensureCanvasDimensions();

  ctx.save();
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // Apply pan and zoom
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  // 1. Draw Links
  for (const l of links) {
    if (!isNodeVisible(l.source) || !isNodeVisible(l.target)) continue;

    const isConnectedToHover = hoveredNode && (l.source === hoveredNode || l.target === hoveredNode);
    const isConnectedToSelect = selectedNode && (l.source === selectedNode || l.target === selectedNode);

    let alpha = 0.22;
    if (hoveredNode || selectedNode) {
      alpha = (isConnectedToHover || isConnectedToSelect) ? 0.85 : 0.05;
    }

    ctx.beginPath();
    ctx.moveTo(l.source.x, l.source.y);
    ctx.lineTo(l.target.x, l.target.y);

    if (l.type === 'semantic') {
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = `rgba(88, 166, 255, ${alpha * 1.3})`;
      ctx.lineWidth = (isConnectedToHover || isConnectedToSelect) ? 2.5 : 1.2;
    } else {
      ctx.setLineDash([]);
      ctx.strokeStyle = `rgba(230, 237, 243, ${alpha})`;
      ctx.lineWidth = (isConnectedToHover || isConnectedToSelect) ? 2.0 : 1.0;
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // 2. Draw Nodes
  for (const n of nodes) {
    if (!isNodeVisible(n)) continue;

    const isHovered = (n === hoveredNode);
    const isSelected = (n === selectedNode);
    const isNeighbor = (hoveredNode && isConnected(n, hoveredNode)) || (selectedNode && isConnected(n, selectedNode));

    let alpha = 1.0;
    if ((hoveredNode || selectedNode) && !isHovered && !isSelected && !isNeighbor) {
      alpha = 0.18;
    }

    ctx.save();
    ctx.globalAlpha = alpha;

    // Outer Glow / Ring for Gold & Selected
    if (n.type === 'gold' || isHovered || isSelected) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.radius + 6, 0, Math.PI * 2);
      ctx.fillStyle = n.type === 'gold' ? 'rgba(227, 179, 65, 0.25)' : 'rgba(88, 166, 255, 0.28)';
      ctx.fill();
    }

    // Node Circle
    ctx.beginPath();
    ctx.arc(n.x, n.y, n.radius, 0, Math.PI * 2);
    ctx.fillStyle = n.color;
    ctx.fill();
    ctx.lineWidth = isHovered ? 2.8 : 1.8;
    ctx.strokeStyle = isHovered ? '#ffffff' : (n.type === 'gold' ? '#fff8db' : 'rgba(255,255,255,0.7)');
    ctx.stroke();

    // Node Center Icon / Text
    ctx.fillStyle = (n.type === 'gold') ? '#000000' : '#ffffff';
    ctx.font = `bold ${n.type === 'gold' ? '12px' : (n.type === 'silver' ? '10px' : '9px')} var(--font-sans)`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (n.type === 'gold') {
      ctx.fillText('★', n.x, n.y);
    } else if (n.type === 'silver') {
      ctx.fillText('⚡', n.x, n.y);
    } else {
      ctx.fillText(n.name, n.x, n.y);
    }

    // Node Label underneath (only for Gold & Silver by default, or hovered/selected Bronze to prevent clutter)
    if (n.type !== 'bronze' || isHovered || isSelected || zoom > 0.9) {
      ctx.font = `${n.type === 'gold' ? 'bold 11.5px' : '10px'} var(--font-sans)`;
      ctx.fillStyle = (n.type === 'gold') ? '#e3b341' : (n.type === 'silver' ? '#58a6ff' : '#e6edf3');
      ctx.fillText(n.name, n.x, n.y + n.radius + 12);
    }

    ctx.restore();
  }

  ctx.restore();

  updatePhysics();
  requestAnimationFrame(render);
}

function isConnected(a, b) {
  return links.some(l => (l.source === a && l.target === b) || (l.source === b && l.target === a));
}

// -------------------------------------------------- User Interactions (Drag, Zoom, Pan, Hover)
function getNodeAt(x, y) {
  const wx = (x - panX) / zoom;
  const wy = (y - panY) / zoom;

  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (!isNodeVisible(n)) continue;
    const dx = wx - n.x;
    const dy = wy - n.y;
    if (dx * dx + dy * dy <= (n.radius + 4) * (n.radius + 4)) {
      return n;
    }
  }
  return null;
}

canvas.addEventListener('mousedown', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const hit = getNodeAt(mx, my);
  if (hit) {
    draggedNode = hit;
    selectedNode = hit;
    simAlpha = 0.6; // revive simulation on drag
  } else {
    isPanning = true;
    startPanX = e.clientX - panX;
    startPanY = e.clientY - panY;
    selectedNode = null;
    viewport.classList.add('dragging');
  }
});

window.addEventListener('mousemove', (e) => {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  if (draggedNode) {
    draggedNode.x = (mx - panX) / zoom;
    draggedNode.y = (my - panY) / zoom;
    draggedNode.vx = 0;
    draggedNode.vy = 0;
    hideTooltip();
    return;
  }

  if (isPanning) {
    panX = e.clientX - startPanX;
    panY = e.clientY - startPanY;
    hideTooltip();
    return;
  }

  // Hover detection
  const hit = getNodeAt(mx, my);
  if (hit !== hoveredNode) {
    hoveredNode = hit;
    if (hit) {
      showTooltip(hit, e.clientX, e.clientY);
    } else {
      hideTooltip();
    }
  } else if (hit) {
    positionTooltip(e.clientX, e.clientY);
  }
});

window.addEventListener('mouseup', () => {
  draggedNode = null;
  isPanning = false;
  viewport.classList.remove('dragging');
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const my = e.clientY - rect.top;

  const zoomFactor = e.deltaY < 0 ? 1.12 : 0.89;
  const newZoom = Math.max(0.2, Math.min(3.5, zoom * zoomFactor));

  panX = mx - (mx - panX) * (newZoom / zoom);
  panY = my - (my - panY) * (newZoom / zoom);
  zoom = newZoom;
}, { passive: false });

// -------------------------------------------------- Rich Chronicle Tooltip
function showTooltip(n, clientX, clientY) {
  let html = '';

  if (n.type === 'gold') {
    html = `
      <div class="tooltip-header">
        <div class="tooltip-title">★ ${escapeHtml(n.name)}</div>
        <span class="tooltip-badge gold">${n.status}</span>
      </div>
      <div class="tooltip-body">
        <div><b>${n.commitsCount}</b> commits across <b>${n.filesCount}</b> active files</div>
        ${n.latestMotive ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l1">Core Motive</div>
            <div>${escapeHtml(n.latestMotive)}</div>
          </div>
        ` : ''}
        ${n.latestArch ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l2">Architecture Pattern</div>
            <div>${escapeHtml(n.latestArch)}</div>
          </div>
        ` : ''}
        <div class="tooltip-files"><b>Files:</b> ${(n.files || []).slice(0, 5).join(', ')}${n.files.length > 5 ? '…' : ''}</div>
      </div>
    `;
  } else if (n.type === 'silver') {
    html = `
      <div class="tooltip-header">
        <div class="tooltip-title">⚡ ${escapeHtml(n.name)}</div>
        <span class="tooltip-badge silver">Lineage Thread</span>
      </div>
      <div class="tooltip-body">
        <div>Binds <b>${n.commitsCount}</b> sequential commits into feature continuity.</div>
        <div class="tooltip-files">Tracks ${n.filesCount} touched files across time.</div>
      </div>
    `;
  } else {
    const c = n.chronicle || {};
    html = `
      <div class="tooltip-header">
        <div class="tooltip-title">● Commit: ${escapeHtml(n.name)}</div>
        <span class="tooltip-badge bronze">Bronze</span>
      </div>
      <div class="tooltip-body">
        <div style="font-weight:600;color:var(--text);">${escapeHtml(n.summary || '')}</div>
        <div style="font-size:10.5px;color:var(--text-dim);">By ${escapeHtml(n.author || 'Human')} &bull; ${escapeHtml(n.date || '')}</div>
        ${n.motive ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l1">Layer 1: Motive</div>
            <div>${escapeHtml(n.motive)}</div>
          </div>
        ` : ''}
        ${n.architecture ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l2">Layer 2: Architecture</div>
            <div>${escapeHtml(n.architecture)}</div>
          </div>
        ` : ''}
        ${(n.files || []).length ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l3">Layer 3: Code Manifest (${n.files.length} files)</div>
            <div class="tooltip-files">${escapeHtml(n.files.join(', '))}</div>
          </div>
        ` : ''}
        ${n.verification ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l4">Layer 4: Verification Proof</div>
            <div>${escapeHtml(n.verification)}</div>
          </div>
        ` : ''}
      </div>
    `;
  }

  tooltip.innerHTML = html;
  tooltip.removeAttribute('hidden');
  positionTooltip(clientX, clientY);
}

function positionTooltip(clientX, clientY) {
  const pad = 16;
  let tx = clientX + pad;
  let ty = clientY + pad;

  const tw = tooltip.offsetWidth || 320;
  const th = tooltip.offsetHeight || 200;

  if (tx + tw > window.innerWidth) tx = clientX - tw - pad;
  if (ty + th > window.innerHeight) ty = clientY - th - pad;

  tooltip.style.left = Math.max(10, tx) + 'px';
  tooltip.style.top = Math.max(10, ty) + 'px';
}

function hideTooltip() {
  if (tooltip) tooltip.setAttribute('hidden', '');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// -------------------------------------------------- UI Controls
document.addEventListener('DOMContentLoaded', () => {
  ensureCanvasDimensions();

  // Button handlers
  document.getElementById('btn-zoom-in').onclick = () => {
    zoom = Math.min(3.5, zoom * 1.25);
  };
  document.getElementById('btn-zoom-out').onclick = () => {
    zoom = Math.max(0.2, zoom / 1.25);
  };
  document.getElementById('btn-reset-view').onclick = () => {
    autoFitView();
    simAlpha = 0.7;
  };
  document.getElementById('btn-toggle-sim').onclick = () => {
    simulationActive = !simulationActive;
    if (simulationActive) simAlpha = 0.5;
    document.getElementById('btn-toggle-sim').textContent = simulationActive ? '⏸' : '▶';
  };

  // Search input
  const searchInput = document.getElementById('graph-search');
  if (searchInput) {
    searchInput.oninput = (e) => {
      searchQuery = e.target.value.trim();
    };
  }

  // Layer toggles
  ['gold', 'silver', 'bronze'].forEach(layer => {
    const btn = document.getElementById('toggle-' + layer);
    if (btn) {
      btn.onclick = () => {
        visibleLayers[layer] = !visibleLayers[layer];
        btn.classList.toggle('on', visibleLayers[layer]);
      };
    }
  });

  initSessionSync();
  connectBroker();
  requestAnimationFrame(render);
});
