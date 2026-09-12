/* GitX — Zero-Build 60FPS Force-Directed Lakehouse Network Graph Engine */

/* ?broker=ws://127.0.0.1:7799 points this page at a second broker, so a change
 * can be tried without stopping the one someone is using. */
const BROKER_URL = new URLSearchParams(location.search).get('broker') || 'ws://127.0.0.1:7771';
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

// -------------------------------------------------- Threads to Interconnected Network
/* Nodes come from state.threads, which the broker derives from code regions,
 * declared scope and stated trailers - so EVERY commit is eligible, not only
 * those carrying a chronicle tag. The previous version grouped on `c.stream`,
 * which meant any repository without GitX's own commit format collapsed into a
 * single "Standard" bucket that is not a topic, just a bin for "unparsed".
 *
 * The three tiers now each say something different:
 *
 *   GOLD    a thread - a line of work
 *   SILVER  a code region that thread spans - WHERE the work actually lives
 *   BRONZE  a commit
 *
 * Silver previously held the same stream as its gold parent with 'Stream: '
 * prefixed, carrying identical counts and adding no information at all. */
function buildGraphData() {
  ensureCanvasDimensions();

  const threads = state.threads || [];
  const chronicles = state.chronicles || [];
  const byHash = new Map(chronicles.map((c) => [c.commitHash, c]));

  const newNodes = [];
  const newLinks = [];
  let goldCount = 0, silverCount = 0, bronzeCount = 0;

  const cx = canvas.width / 2;
  const cy = canvas.height / 2;

  const REGIONS_PER_THREAD = 3;   // enough to say where the work lives, few enough to read
  const goldenAngle = 2.39996;    // sunflower spiral - keeps commits from heaping

  /* Ring size is derived from what has to fit on it, not from a constant. A
   * fixed radius works for three threads and collapses into an unreadable knot
   * at twenty-five, because each thread brings a cluster of its own whose size
   * grows with its commit count. Sum the space the clusters need, and the
   * circle that holds them follows. Each thread also gets arc PROPORTIONAL to
   * its size, so a 25-commit thread is not allotted the same wedge as a
   * 2-commit one. autoFitView zooms to whatever this produces. */
  const clusterRadius = (t) => 78 + Math.sqrt(t.commits.length + 1) * 32;
  const spans = threads.map((t) => 2.3 * clusterRadius(t));
  const totalSpan = spans.reduce((a, b) => a + b, 0) || 1;
  const hubRadius = Math.max(160, totalSpan / (2 * Math.PI));

  const placed = new Set();
  const goldByThread = new Map();
  const bronzeByHash = new Map();
  let angleCursor = 0;

  threads.forEach((t, ti) => {
    const share = (spans[ti] / totalSpan) * 2 * Math.PI;
    const ga = angleCursor + share / 2;
    angleCursor += share;
    const gx = cx + hubRadius * Math.cos(ga);
    const gy = cy + hubRadius * Math.sin(ga);

    const goldNode = {
      id: 'thread_' + t.id,
      name: t.name,
      type: 'gold',
      tone: 'thread',
      radius: 20 + Math.min(14, t.commits.length),
      color: '#e3b341',
      borderColor: '#ffffff',
      /* Whether the name was declared by the author or inferred from the prose
       * is worth showing: one is a fact, the other is this tool's guess. */
      status: t.namedBy === 'scope' ? 'DECLARED' : (t.namedBy === 'file' ? 'BY FILE' : 'INFERRED'),
      commitsCount: t.commits.length,
      filesCount: (t.regions || []).length,
      keywords: t.keywords || [],
      regions: t.regions || [],
      files: (t.regions || []).map((r) => r.split('::')[0]),
      namedBy: t.namedBy,
      x: gx, y: gy, vx: 0, vy: 0
    };
    newNodes.push(goldNode);
    goldByThread.set(t.id, goldNode);
    goldCount++;

    const regions = (t.regions || []).slice(0, REGIONS_PER_THREAD);
    const silverByRegion = new Map();
    regions.forEach((r, ri) => {
      const sa = ga + (ri - (regions.length - 1) / 2) * 0.44;
      const sx = gx + 88 * Math.cos(sa);
      const sy = gy + 88 * Math.sin(sa);
      const decl = r.includes('::') ? r.split('::').pop() : r;
      const silverNode = {
        id: 'region_' + t.id + '_' + ri,
        /* '*' means git found no declaration above the hunk, so the region is
         * the whole file - show the path rather than a bare asterisk. */
        name: (decl === '*') ? r.split('::')[0] : decl,
        type: 'silver',
        tone: 'region',
        radius: 13,
        color: '#58a6ff',
        borderColor: '#ffffff',
        fullRegion: r,
        file: r.split('::')[0],
        parentThread: t.name,
        files: [r.split('::')[0]],
        x: sx, y: sy, vx: 0, vy: 0
      };
      newNodes.push(silverNode);
      silverByRegion.set(r, silverNode);
      silverCount++;
      newLinks.push({ source: goldNode, target: silverNode, type: 'hierarchy', length: 98, strength: 0.16 });
    });

    t.commits.forEach((hash, ci) => {
      const c = byHash.get(hash) || {};
      placed.add(hash);
      const spiral = 72 + Math.sqrt(ci + 1) * 30;
      const bx = gx + spiral * Math.cos(ci * goldenAngle);
      const by = gy + spiral * Math.sin(ci * goldenAngle);
      const hasProof = c.verification && !c.verification.includes('No verification');

      const bronzeNode = {
        id: 'bronze_' + hash,
        name: (hash || '').slice(0, 7),
        type: 'bronze',
        tone: hasProof ? 'commit-verified' : 'commit',
        radius: 10,
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
        threadName: t.name,
        x: bx, y: by, vx: 0, vy: 0
      };
      newNodes.push(bronzeNode);
      bronzeByHash.set(hash, bronzeNode);
      bronzeCount++;

      /* Hang the commit off a region it actually touched when one is on screen,
       * otherwise straight off the thread. A commit linked through the code it
       * edited says more than one linked to the group it was sorted into. */
      let attached = false;
      for (const [r, sn] of silverByRegion) {
        const f = r.split('::')[0];
        if ((c.filesManifest || []).some((x) => x === f || f.endsWith(x) || x.endsWith(f))) {
          newLinks.push({ source: sn, target: bronzeNode, type: 'hierarchy', length: 76, strength: 0.13 });
          attached = true;
          break;
        }
      }
      if (!attached) {
        newLinks.push({ source: goldNode, target: bronzeNode, type: 'hierarchy', length: 112, strength: 0.09 });
      }
    });
  });

  /* Commits belonging to no thread. Left unattached on purpose: drifting to the
   * edge is an honest picture of "nothing groups this yet", and hiding them
   * would make the graph claim more structure than was actually found. */
  let looseIdx = 0;
  for (const c of chronicles) {
    if (placed.has(c.commitHash)) continue;
    const a = looseIdx * goldenAngle;
    const rr = hubRadius + 210 + (looseIdx % 6) * 20;
    looseIdx++;
    newNodes.push({
      id: 'bronze_' + c.commitHash,
      name: (c.commitHash || '').slice(0, 7),
      type: 'bronze',
      tone: 'loose',
      radius: 9,
      color: '#6e7681',
      borderColor: 'rgba(255,255,255,0.4)',
      chronicle: c,
      summary: c.summary,
      motive: c.motive,
      architecture: c.architecture,
      files: c.filesManifest || [],
      verification: c.verification,
      author: c.author || c.agentId || 'Human',
      date: (c.timestamp || '').slice(0, 10),
      threadName: null,
      x: cx + rr * Math.cos(a), y: cy + rr * Math.sin(a), vx: 0, vy: 0
    });
    bronzeCount++;
  }

  /* Cross-links, replacing the previous commit-to-commit file-overlap rule.
   *
   * That rule linked any two commits sharing one file, against a hardcoded list
   * of five filenames to ignore - a list that guessed wrong. On ter-manager the
   * real noise is app.js (71% of commits), server.js and app.css, none of which
   * were on it. So most pairs qualified, a cap of three admitted an arbitrary
   * subset, and which three survived came down to loop order.
   *
   * Two honest link types now:
   *
   *   INFERRED  thread <-> thread, weighted by the same idf-scored evidence the
   *             clustering used, normalised by thread size. Drawn between GOLD
   *             nodes because two commits inside one thread are already visibly
   *             together - a line between them says nothing.
   *   STATED    commit <-> commit, from a GitX trailer. Ground truth where
   *             everything else here is a guess, so it is drawn separately. */
  for (const l of (state.threadLinks || [])) {
    const a = goldByThread.get(l.a);
    const b = goldByThread.get(l.b);
    if (!a || !b) continue;
    newLinks.push({
      source: a,
      target: b,
      type: 'semantic',
      length: 240,
      /* Pulled from the measured strength so a strong relation visibly draws
       * two threads together, rather than every link tugging equally. */
      strength: Math.min(0.06, 0.012 + l.strength * 0.05),
      relStrength: l.strength,
      sources: l.sources
    });
  }

  for (const r of (state.statedRelations || [])) {
    const a = bronzeByHash.get(r.from);
    const b = bronzeByHash.get(r.to);
    if (!a || !b) continue;
    newLinks.push({
      source: a,
      target: b,
      type: 'stated',
      kind: r.kind,
      length: 150,
      strength: 0.09
    });
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

/* -------------------------------------------------- Host theme
 *
 * This page previously read no theme at all, so every --pal-* fell through to
 * the GitHub-dark fallbacks in graph.css and the graph stayed blue no matter
 * which of ter-manager's palettes was active. The chrome and the canvas were
 * both wrong, just in different ways - the CSS at least had the right variables
 * to inherit, while the canvas had colours typed in as literals.
 *
 * Two ways the theme arrives, because neither alone is enough:
 *   - postMessage, which the host broadcasts on every palette change
 *   - reading the parent directly on load, since a broadcast that happened
 *     before this frame existed was never received */
const THEME_VARS = ['--pal-bg', '--pal-raise', '--pal-fg', '--pal-accent',
  '--pal-red', '--pal-green', '--pal-yellow', '--on-accent', '--mono'];
const THEME_ATTRS = ['data-theme', 'data-scene', 'data-surface'];

function applyHostTheme(theme) {
  if (!theme) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(theme.vars || {})) {
    if (THEME_VARS.includes(k) && v) root.style.setProperty(k, v);
  }
  for (const [k, v] of Object.entries(theme.attrs || {})) {
    if (!THEME_ATTRS.includes(k)) continue;
    if (v) root.setAttribute(k, v); else root.removeAttribute(k);
  }
  PAL = null;          // palette changed - the canvas must re-read it
  GRAD.clear();        // and every cached gradient is now the wrong colour
}

function adoptParentTheme() {
  try {
    if (window.parent === window) return;          // standalone, nothing to adopt
    const host = window.parent.document.documentElement;   // same origin or it throws
    const vars = {};
    for (const v of THEME_VARS) {
      const val = host.style.getPropertyValue(v);
      if (val) vars[v] = val;
    }
    const attrs = {};
    for (const a of THEME_ATTRS) attrs[a] = host.getAttribute(a);
    applyHostTheme({ vars, attrs });
  } catch (_) { /* cross-origin or no parent - the CSS fallbacks still hold */ }
}

window.addEventListener('message', (e) => {
  if (e.data && e.data.__tm && e.data.event === 'theme') applyHostTheme(e.data.theme);
});

/* -------------------------------------------------- Canvas palette
 *
 * Read from the same CSS custom properties the chrome uses, so the graph and
 * the interface around it can never disagree about what colour this theme is.
 * Cached, because getComputedStyle on every node of every frame is not free -
 * and cleared whenever the theme changes. */
let PAL = null;
const GRAD = new Map();

function pal() {
  if (PAL) return PAL;
  const s = getComputedStyle(document.documentElement);
  const get = (v, fb) => (s.getPropertyValue(v) || '').trim() || fb;
  const fg = get('--pal-fg', '#e6edf3');
  PAL = {
    bg: get('--pal-bg', '#0d1117'),
    fg,
    accent: get('--pal-accent', '#58a6ff'),
    green: get('--pal-green', '#3fb950'),
    yellow: get('--pal-yellow', '#d29922'),
    /* Gold is the one hue held apart from the palette. It marks a THREAD, and
     * a thread must stay visually distinct from the accent that marks a region
     * - if both followed --pal-accent they would collide in any palette whose
     * accent happens to be warm. */
    gold: '#e3b341',
    dim: mix(fg, get('--pal-bg', '#0d1117'), 0.45),
    dimmer: mix(fg, get('--pal-bg', '#0d1117'), 0.68),
    sans: (getComputedStyle(document.body).fontFamily) ||
          '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif'
  };
  return PAL;
}

/* canvas cannot resolve var(--x), so colours have to be mixed here rather than
 * handed to color-mix() the way the stylesheet does it */
function rgbOf(c) {
  c = (c || '').trim();
  const h = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
  if (h) {
    let v = h[1];
    if (v.length === 3) v = v[0] + v[0] + v[1] + v[1] + v[2] + v[2];
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }
  const m = c.match(/(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)[,\s]+(\d+(?:\.\d+)?)/);
  if (m) return [+m[1], +m[2], +m[3]];
  return [136, 148, 158];
}
function mix(a, b, t) {
  const x = rgbOf(a), y = rgbOf(b);
  return `rgb(${Math.round(x[0] + (y[0] - x[0]) * t)}, ${Math.round(x[1] + (y[1] - x[1]) * t)}, ${Math.round(x[2] + (y[2] - x[2]) * t)})`;
}
function withAlpha(c, a) {
  const [r, g, b] = rgbOf(c);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/* Gradients are built in LOCAL coordinates and the context is translated to the
 * node, so one gradient serves every node of the same colour and size instead
 * of being rebuilt per node per frame. */
function fillGrad(color, r) {
  const k = 'f|' + color + '|' + r;
  let g = GRAD.get(k);
  if (!g) {
    g = ctx.createLinearGradient(0, -r, 0, r);
    g.addColorStop(0, mix(color, '#ffffff', 0.26));
    g.addColorStop(0.55, color);
    g.addColorStop(1, mix(color, '#000000', 0.17));
    GRAD.set(k, g);
  }
  return g;
}

function glowGrad(color, r) {
  const k = 'g|' + color + '|' + r;
  let g = GRAD.get(k);
  if (!g) {
    g = ctx.createRadialGradient(0, 0, r * 0.72, 0, 0, r * 2.5);
    g.addColorStop(0, withAlpha(color, 0.34));
    g.addColorStop(0.45, withAlpha(color, 0.13));
    g.addColorStop(1, withAlpha(color, 0));
    GRAD.set(k, g);
  }
  return g;
}

/* The tone a node was built with, resolved to a colour at DRAW time rather than
 * build time - otherwise a palette change would need the whole graph rebuilt to
 * take effect. */
function toneColor(n) {
  const p = pal();
  switch (n.tone) {
    case 'thread': return p.gold;
    case 'region': return p.accent;
    case 'commit-verified': return p.green;
    case 'commit': return p.dim;
    case 'loose': return p.dimmer;
    default: return n.color || p.dim;
  }
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

    const LP = pal();
    if (l.type === 'stated') {
      /* Solid amber, and thicker: someone WROTE this relation in a trailer.
       * Drawn unlike anything inferred, because confusing a stated fact with a
       * guess is the one mistake this graph should never invite. */
      ctx.setLineDash([]);
      ctx.strokeStyle = withAlpha(LP.gold, Math.min(1, alpha * 2.4));
      ctx.lineWidth = (isConnectedToHover || isConnectedToSelect) ? 3 : 1.8;
    } else if (l.type === 'semantic') {
      /* Weight carries through to the line: a strong inter-thread relation is
       * visibly heavier than a marginal one, rather than every dash looking
       * equally confident. */
      const s = Math.max(0, Math.min(1, (l.relStrength || 0) / 2));
      ctx.setLineDash([4, 4]);
      ctx.strokeStyle = withAlpha(LP.accent, alpha * (0.9 + s * 0.9));
      ctx.lineWidth = (isConnectedToHover || isConnectedToSelect) ? 2.5 : (0.9 + s * 1.6);
    } else {
      ctx.setLineDash([]);
      ctx.strokeStyle = withAlpha(LP.fg, alpha * 0.8);
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

    const P = pal();
    const color = toneColor(n);
    const r = n.radius;

    ctx.save();
    ctx.globalAlpha = alpha;
    /* Translated to the node so the cached gradients, built in local
     * coordinates, can serve every node of the same colour and size instead of
     * being rebuilt per node per frame. */
    ctx.translate(n.x, n.y);

    /* Soft falloff, replacing the hard-edged disc the old version drew at
     * radius+6 - which read as a second ring rather than a glow. */
    if (n.tone === 'thread' || isHovered || isSelected) {
      ctx.beginPath();
      ctx.arc(0, 0, r * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = glowGrad((isHovered || isSelected) ? P.accent : color, r);
      ctx.fill();
    }

    // Body, lit from above - one constant light direction for every object
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = fillGrad(color, r);
    ctx.fill();

    // A thin rim instead of the old 1.8px white outline
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, 0, Math.PI * 2);
    ctx.lineWidth = 1;
    ctx.strokeStyle = withAlpha('#ffffff', isHovered ? 0.5 : 0.2);
    ctx.stroke();

    // Specular highlight across the top arc only, consistent with the fill
    ctx.beginPath();
    ctx.arc(0, 0, r - 0.5, Math.PI * 1.15, Math.PI * 1.85);
    ctx.lineWidth = 1.4;
    ctx.strokeStyle = withAlpha('#ffffff', 0.32);
    ctx.stroke();

    // Focus ring sits OFF the node rather than thickening its edge
    if (isSelected || isHovered) {
      ctx.beginPath();
      ctx.arc(0, 0, r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 2;
      ctx.strokeStyle = withAlpha(P.accent, isSelected ? 0.9 : 0.45);
      ctx.stroke();
    }

    // Centre glyph
    ctx.fillStyle = (n.tone === 'thread') ? withAlpha('#000000', 0.7) : withAlpha('#ffffff', 0.92);
    ctx.font = `600 ${n.type === 'gold' ? 13 : (n.type === 'silver' ? 10 : 9)}px ${P.sans}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    if (n.type === 'gold') {
      ctx.fillText('★', 0, 0);
    } else if (n.type === 'silver') {
      ctx.fillText('⚡', 0, 0);
    } else {
      ctx.fillText(n.name, 0, 0);
    }

    /* Label underneath - bronze only when hovered, selected or zoomed in.
     *
     * For a commit this is the SUBJECT, not the name: the name is the short
     * hash and it is already drawn in the centre, so repeating it underneath
     * printed every commit twice. Which it did, invisibly, until the nodes got
     * large enough to read. */
    if (n.type !== 'bronze' || isHovered || isSelected || zoom > 0.9) {
      /* Kept short deliberately. Commit subjects run long, and at any zoom
       * where they are all legible they are also all overlapping - a truncated
       * label you can read beats a full one buried under its neighbour. */
      const raw = (n.type === 'bronze') ? (n.summary || '') : n.name;
      const label = raw.length > 26 ? raw.slice(0, 25).trimEnd() + '…' : raw;
      if (label) {
        ctx.font = `${n.type === 'gold' ? '600 12px' : '500 10.5px'} ${P.sans}`;
        /* Haloed in the PAGE colour, not black. The label has to stay readable
         * over the links running beneath it, and on a light palette a dark halo
         * would look worse than none at all. */
        ctx.shadowColor = P.bg;
        ctx.shadowBlur = 6;
        ctx.fillStyle = (n.tone === 'thread') ? P.gold : (n.tone === 'region' ? P.accent : P.dim);
        ctx.fillText(label, 0, r + 13);
        ctx.shadowBlur = 0;
      }
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
        <div><b>${n.commitsCount}</b> commits spanning <b>${n.filesCount}</b> code regions</div>
        ${n.namedBy === 'scope' ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l1">Declared scope</div>
            <div>The author wrote this scope into the commit subject - a fact, not a guess.</div>
          </div>
        ` : n.namedBy === 'file' ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l1">Named by file</div>
            <div>Nothing distinctive in the wording of these commits, so the name is the file the work lives in.</div>
          </div>
        ` : ''}
        ${(n.keywords || []).length ? `
          <div class="tooltip-layer">
            <div class="tooltip-layer-tag l2">Distinctive words</div>
            <div>${escapeHtml(n.keywords.slice(0, 8).join(', '))}</div>
          </div>
        ` : ''}
        <div class="tooltip-files"><b>Regions:</b><br>${(n.regions || []).slice(0, 4).map(escapeHtml).join('<br>')}</div>
      </div>
    `;
  } else if (n.type === 'silver') {
    html = `
      <div class="tooltip-header">
        <div class="tooltip-title">⚡ ${escapeHtml(n.name)}</div>
        <span class="tooltip-badge silver">Code Region</span>
      </div>
      <div class="tooltip-body">
        <div>${escapeHtml(n.fullRegion || '')}</div>
        <div class="tooltip-files">Part of <b>${escapeHtml(n.parentThread || '')}</b>. Read from git's own hunk header, so this is a declaration NAME rather than a line number - it survives the file growing above it.</div>
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

  /* Before the first frame: the host broadcasts theme on every palette change,
   * but any broadcast that happened before this frame existed was never heard.
   * Reading the parent once on load covers that gap. */
  adoptParentTheme();

  initSessionSync();
  connectBroker();
  requestAnimationFrame(render);
});
