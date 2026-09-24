/* GitX — Frontend Application: header, the sidebar's views, the agent swarm,
 * and the broker link.
 * The graph and the details panel are js/graph-view.js. */

/* ?broker=<port> points the page at a second broker - the way to try a broker
 * change without stopping the one agents are connected to. */
const BROKER_PORT = /^\d{2,5}$/.test(new URLSearchParams(location.search).get('broker') || '')
  ? new URLSearchParams(location.search).get('broker') : '7771';
const BROKER_URL = 'ws://127.0.0.1:' + BROKER_PORT;
const BROKER_HTTP = 'http://127.0.0.1:' + BROKER_PORT;
let ws = null;
let state = {
  activeRepo: '',
  activeRepoName: 'Loading...',
  activeBranch: 'main',
  agents: {},
  issues: [],
  chronicles: [],
  streams: {}
};

let lastKnownRepo = '';

// -------------------------------------------------- Ter-Manager Session & Theme Sync
function normPath(p) {
  if (!p) return '';
  return String(p).replace(/[\\/]+$/, '').toLowerCase();
}

function resolveActiveRepo() {
  // 1. Direct host function calls on window.parent (Ter-Manager exposes activeSessionPath, repoPath, sessionPath)
  if (window.parent && window.parent !== window) {
    try {
      if (typeof window.parent.activeSessionPath === 'function') {
        const p = window.parent.activeSessionPath();
        if (p) return p;
      }
      if (typeof window.parent.repoPath === 'function') {
        const p = window.parent.repoPath();
        if (p) return p;
      }
      if (typeof window.parent.sessionPath === 'function') {
        const p = window.parent.sessionPath();
        if (p) return p;
      }
      if (typeof window.parent.activeSession === 'function') {
        const s = window.parent.activeSession();
        if (s && s.path) return s.path;
      }
    } catch (_) {}
  }

  // 2. Direct localStorage gitDashboardCwd (set by setGitRepo in Ter-Manager)
  try {
    const cwd = localStorage.getItem('gitDashboardCwd');
    if (cwd) return cwd;
  } catch (_) {}

  // 3. Resolve active session from termanager localStorage
  try {
    const activeId = localStorage.getItem('termanager.session-active');
    const rawSessions = localStorage.getItem('termanager.sessions');
    if (activeId && rawSessions) {
      const list = JSON.parse(rawSessions);
      if (Array.isArray(list)) {
        const found = list.find(s => s.id === activeId);
        if (found && found.path) return found.path;
      }
    }
  } catch (_) {}

  return '';
}

function checkActiveSession() {
  const cwd = resolveActiveRepo();
  if (cwd && normPath(cwd) !== normPath(lastKnownRepo)) {
    lastKnownRepo = cwd;
    console.log('[GitX UI] Active Ter-Manager session repository detected:', cwd);
    
    // Immediate badge feedback
    const badge = document.getElementById('active-project-badge');
    if (badge) {
      const folderName = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || cwd;
      badge.innerHTML = `<span class="proj-icon">📁</span> <b>${escapeHtml(folderName)}</b> <span class="branch-pill" style="opacity:0.75;">[syncing...]</span>`;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'SET_ACTIVE_REPO',
        repoPath: cwd
      }));
    }
  }
}

function initSessionSync() {
  // 1. Initial check
  checkActiveSession();

  // 2. Listen for storage events across same-origin frames
  window.addEventListener('storage', (e) => {
    if (e.key === 'gitDashboardCwd' || e.key === 'termanager.session-active' || e.key === 'termanager.sessions') {
      checkActiveSession();
    }
  });

  // 3. Watch when iframe changes visibility or document focus changes
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkActiveSession();
  });
  window.addEventListener('focus', checkActiveSession);

  // 4. Watch window.frameElement mutations (Ter-Manager sets hidden = false when user switches to GitX)
  try {
    if (window.frameElement) {
      const frameObs = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.attributeName === 'hidden' && !window.frameElement.hidden) {
            checkActiveSession();
          }
        }
      });
      frameObs.observe(window.frameElement, { attributes: true, attributeFilter: ['hidden', 'style', 'class'] });
    }
  } catch (_) {}

  // 5. Watch parent window clicks & interactions (e.g. clicking session or GitX in sidebar)
  if (window.parent && window.parent !== window) {
    try {
      window.parent.document.addEventListener('click', () => {
        setTimeout(checkActiveSession, 30);
        setTimeout(checkActiveSession, 200);
      }, { passive: true });
    } catch (_) {}
  }

  // 6. Fast fallback polling (300ms)
  setInterval(checkActiveSession, 300);
}

function initThemeSync() {
  if (window.TerManager && window.TerManager.theme) {
    window.TerManager.theme.onChange((theme) => {
      applyHostTheme(theme);
      syncHostWallpaper();
    });
    const initial = window.TerManager.theme.get();
    if (initial) applyHostTheme(initial);
  }
  initHostWallpaper();
}

/* The host's wallpaper as this page's ground - the picture Agent Bridge carries
 * in, so the two plugins stand on the same ground as the rest of the window.
 *
 * ter-manager paints it as its own body background, and this page is served
 * from the same origin, so it is read straight off the parent. Nothing behind
 * the frame can show through it (the host paints the frame element itself), so
 * copying the picture in is the only way to see it here. Without a wallpaper,
 * or opened on its own, gitx.css paints a colour mesh from the palette instead.
 * Set only when it changes: the value is a data URL several megabytes long. */
let hostWallpaper = null;
function syncHostWallpaper() {
  let paper = null;
  try {
    if (window.parent && window.parent !== window) {
      const body = window.parent.document.body;
      const img = body.style.backgroundImage || getComputedStyle(body).backgroundImage;
      if (img && img.indexOf('url(') === 0) paper = img;
    }
  } catch (_) { /* another origin, or no host - the mesh stands in */ }
  const root = document.documentElement;
  if (paper !== hostWallpaper) {
    hostWallpaper = paper;
    paperSize = null;
    if (paper) {
      /* Straight onto body, not through a custom property: Chrome silently
       * refuses a custom property longer than about 2MB - setProperty returns
       * and the value reads back empty - and a wallpaper is a data URL well
       * past that once the picture is not 16:9, because the long edge is
       * capped at 1920 and a squarer picture then carries more pixels. The
       * rule read var(--host-wallpaper), so the image resolved to none and the
       * page went white while the host showed the picture perfectly. */
      document.body.style.backgroundImage = paper;
      root.setAttribute('data-wallpaper', '');
      if (getComputedStyle(document.body).backgroundImage === 'none') {
        /* Whatever the reason, the mesh is a better answer than a blank page. */
        document.body.style.backgroundImage = '';
        root.removeAttribute('data-wallpaper');
        hostWallpaper = null;
        console.warn('[GitX] The host wallpaper could not be painted; using the palette mesh.');
      } else {
        measurePaper(paper);
      }
    } else {
      document.body.style.backgroundImage = '';
      root.removeAttribute('data-wallpaper');
    }
  }
  placeHostWallpaper();
}

/* The picture's own size, read once per wallpaper: cover needs the ratio, and
 * a data URL carries no dimensions until it is decoded. */
let paperSize = null;
function measurePaper(paper) {
  const src = /^url\(\s*"?(.*?)"?\s*\)$/.exec(paper);
  if (!src) return;
  const img = new Image();
  img.onload = () => {
    if (hostWallpaper !== paper) return;          // a newer wallpaper won the race
    paperSize = { w: img.naturalWidth, h: img.naturalHeight };
    placeHostWallpaper();
  };
  img.src = src[1];
}

/* Continue the host's wallpaper rather than re-fitting it.
 *
 * ter-manager covers ITS window with the picture, keeping the image's own
 * ratio. A plugin frame is a different size and shape, so running cover again
 * in here crops somewhere else entirely - with a portrait or square wallpaper
 * that means a deep zoom into the middle of the picture, which is what made
 * anything but 16:9 look broken.
 *
 * So the host's geometry is worked out here (the same cover arithmetic against
 * the host's window) and then shifted by where this frame sits in it. The frame
 * shows exactly the part of the picture behind it, as a window onto a desktop
 * does. Opened on its own, with no host to line up with, plain cover is right. */
function placeHostWallpaper() {
  const clear = () => { document.body.style.backgroundSize = ''; document.body.style.backgroundPosition = ''; };
  if (!hostWallpaper || !paperSize) return clear();
  let hostW = 0, hostH = 0, rect = null;
  try {
    if (window.parent && window.parent !== window && window.frameElement) {
      hostW = window.parent.innerWidth;
      hostH = window.parent.innerHeight;
      rect = window.frameElement.getBoundingClientRect();
    }
  } catch (_) { /* not hosted */ }
  if (!rect || !hostW || !hostH) return clear();
  const scale = Math.max(hostW / paperSize.w, hostH / paperSize.h);
  const w = paperSize.w * scale, h = paperSize.h * scale;
  document.body.style.backgroundSize = w.toFixed(1) + 'px ' + h.toFixed(1) + 'px';
  document.body.style.backgroundPosition = ((hostW - w) / 2 - rect.left).toFixed(1) + 'px ' + ((hostH - h) / 2 - rect.top).toFixed(1) + 'px';
}

function initHostWallpaper() {
  syncHostWallpaper();
  /* The frame moves and resizes with the host window and its sidebar, and the
   * picture has to follow, or it drifts out of line with the host's. */
  let frame = null;
  const replace = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(placeHostWallpaper); };
  window.addEventListener('resize', replace);
  /* A hidden window measures zero, and the picture would stay on plain cover
   * until something resized: place it again when the page is shown. */
  window.addEventListener('focus', replace);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) replace(); });
  try { if (window.parent && window.parent !== window) window.parent.addEventListener('resize', replace); } catch (_) { /* not hosted */ }
  if (window.ResizeObserver) new ResizeObserver(replace).observe(document.documentElement);
  /* Changed in Settings: the host rewrites its body's style, and stores the
   * picture, which other same-origin frames hear as a storage event. */
  window.addEventListener('storage', (e) => { if (e.key === 'termanager.wallpaper') syncHostWallpaper(); });
  try {
    if (window.parent && window.parent !== window && window.MutationObserver) {
      new MutationObserver(syncHostWallpaper).observe(window.parent.document.body, { attributes: true, attributeFilter: ['style'] });
    }
  } catch (_) { /* not hosted */ }
}

function applyHostTheme(t) {
  if (!t) return;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.vars || {})) root.style.setProperty(k, v);
  for (const [k, v] of Object.entries(t.attrs || {})) {
    if (v == null) root.removeAttribute(k);
    else root.setAttribute(k, v);
  }
}

// ---------------------------------------------------- WebSocket Broker Connect
function connectBroker() {
  const statusDot = document.getElementById('broker-status-dot');
  const statusText = document.getElementById('broker-status-text');

  try {
    ws = new WebSocket(BROKER_URL);

    ws.onopen = () => {
      if (statusDot) statusDot.classList.add('online');
      if (statusText) statusText.textContent = 'Broker Active (' + BROKER_PORT + ')';
      // Sync current active session immediately upon broker connect
      if (lastKnownRepo) {
        ws.send(JSON.stringify({
          type: 'SET_ACTIVE_REPO',
          repoPath: lastKnownRepo
        }));
      }
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        handleBrokerMessage(msg);
      } catch (err) {
        console.error('[GitX UI] Bad message from broker:', err);
      }
    };

    ws.onclose = () => {
      if (statusDot) statusDot.classList.remove('online');
      if (statusText) statusText.textContent = 'Broker Offline';
      setTimeout(connectBroker, 3000);
    };

    ws.onerror = () => {
      if (statusDot) statusDot.classList.remove('online');
      if (statusText) statusText.textContent = 'Broker Offline';
    };
  } catch (e) {
    console.warn('[GitX UI] Broker connection error:', e.message);
  }
}

function handleBrokerMessage(msg) {
  switch (msg.type) {
    case 'SYNC_STATE':
      state = msg.state || state;
      renderAll();
      break;
    case 'AGENT_REGISTERED':
    case 'AGENT_UPDATED':
      state.agents[msg.agent.id] = msg.agent;
      renderAgents();
      break;
    case 'AGENT_OFFLINE':
      if (state.agents[msg.agentId]) {
        state.agents[msg.agentId].status = 'Offline';
        renderAgents();
      }
      break;
    case 'ISSUE_CREATED':
      state.issues = msg.issues || state.issues;
      if (window.GraphView) window.GraphView.onState(state);
      break;
    case 'CHRONICLE_COMMITTED':
      state.chronicles.unshift(msg.chronicle);
      if (!state.streams[msg.chronicle.stream]) state.streams[msg.chronicle.stream] = [];
      state.streams[msg.chronicle.stream].push(msg.chronicle.commitHash);
      break;
  }
}

function renderAll() {
  renderHeaderBadge();
  renderAgents();
  if (window.GraphView) window.GraphView.onState(state);
}

function renderHeaderBadge() {
  const badge = document.getElementById('active-project-badge');
  if (!badge) return;
  const repoName = state.activeRepoName || 'Workspace';
  const branch = state.activeBranch || 'main';
  badge.innerHTML = `<span class="proj-icon">📁</span> <b>${escapeHtml(repoName)}</b> <span class="branch-pill">[${escapeHtml(branch)}]</span>`;
  badge.title = state.activeRepo || repoName;
}

function renderAgents() {
  const agentsList = Object.values(state.agents);
  /* How many are online, on the sidebar row, so the swarm can be read
   * without opening it. */
  const online = agentsList.filter(a => a.status === 'Online').length;
  const count = document.getElementById('nav-swarm-count');
  if (count) {
    count.hidden = !online;
    count.textContent = String(online);
    count.title = online + ' online';
  }

  const container = document.getElementById('swarm-agents-list');
  if (!container) return;
  container.innerHTML = '';

  if (agentsList.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px;">No agents connected. Open a terminal in Ter-Manager with agy/claude to connect.</div>';
    return;
  }

  agentsList.forEach(agent => {
    const card = document.createElement('div');
    card.className = 'agent-card' + (agent.status === 'Online' ? ' active' : '');

    const head = document.createElement('div');
    head.className = 'agent-head';
    head.innerHTML = `
      <div class="agent-name">
        <span class="status-dot ${agent.status === 'Online' ? 'online' : ''}"></span>
        ${escapeHtml(agent.name)}
      </div>
      <div class="agent-status-badge ${agent.status === 'Online' ? 'online' : 'offline'}">${agent.status}</div>
    `;

    const meta = document.createElement('div');
    meta.className = 'agent-meta';
    meta.textContent = `Model: ${agent.model} • PID: ${agent.pid || 'N/A'}`;

    const branchRow = document.createElement('div');
    branchRow.style.display = 'flex';
    branchRow.style.alignItems = 'center';
    branchRow.style.justifyContent = 'space-between';
    branchRow.style.marginTop = '4px';

    const branchLabel = document.createElement('span');
    branchLabel.style.fontSize = '11px';
    branchLabel.style.color = 'var(--text-dim)';
    branchLabel.textContent = 'Assigned Branch:';

    const select = document.createElement('select');
    select.className = 'agent-branch-select';
    
    const branches = Array.from(new Set([state.activeBranch || 'main', 'main', 'master', ...state.issues.map(i => i.branch)]));
    branches.forEach(b => {
      const opt = document.createElement('option');
      opt.value = b;
      opt.textContent = b;
      if (b === agent.branch) opt.selected = true;
      select.appendChild(opt);
    });

    select.onchange = (e) => {
      const newBranch = e.target.value;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'ASSIGN_BRANCH',
          agentId: agent.id,
          branch: newBranch
        }));
      }
    };

    branchRow.appendChild(branchLabel);
    branchRow.appendChild(select);

    if (agent.currentTask) {
      const taskEl = document.createElement('div');
      taskEl.style.fontSize = '11px';
      taskEl.style.color = 'var(--accent)';
      taskEl.textContent = `Task: ${agent.currentTask}`;
      card.appendChild(taskEl);
    }

    card.appendChild(head);
    card.appendChild(meta);
    card.appendChild(branchRow);
    container.appendChild(card);
  });
}

// ---------------------------------------------------- GitX's own views
/* One view at a time, picked in GitX's sidebar and remembered per viewer.
 * Visuals is graph.html - the page Ctrl+Alt+X opens over ter-manager - in a
 * frame: loaded the first time it is shown, and told to refresh each time
 * after, the way ter-manager's overlay does it. */
const VIEWS = ['timeline', 'swarm', 'visuals'];

function showView(v) {
  if (!VIEWS.includes(v)) v = 'timeline';
  document.documentElement.setAttribute('data-gitx-view', v);
  for (const el of document.querySelectorAll('.gitx-view')) el.hidden = el.dataset.view !== v;
  for (const b of document.querySelectorAll('.gitx-nav-item')) {
    if (b.dataset.view === v) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  try { localStorage.setItem('gitx.view', v); } catch (_) { /* remembered this time only */ }

  if (v === 'visuals') {
    const f = document.getElementById('gitx-visuals-frame');
    if (f && f.getAttribute('src') === 'about:blank') {
      /* graph.html takes a whole broker URL, not a port. */
      f.setAttribute('src', 'graph.html' + (BROKER_PORT !== '7771' ? '?broker=' + encodeURIComponent(BROKER_URL) : ''));
    } else if (f && f.contentWindow) {
      try { f.contentWindow.postMessage({ type: 'GITX_REFRESH' }, location.origin); } catch (_) {}
    }
  }
  /* Hidden, the mode switch measured nothing; place its thumb now. */
  if (v === 'timeline' && window.GraphView && window.GraphView.refit) window.GraphView.refit();
}

function initViews() {
  for (const b of document.querySelectorAll('.gitx-nav-item')) {
    /* The name, for when a narrow window hides the labels. */
    const label = b.querySelector('.gitx-nav-label');
    if (label) b.title = label.textContent.trim();
    b.addEventListener('click', () => showView(b.dataset.view));
  }
  let saved = null;
  try { saved = localStorage.getItem('gitx.view'); } catch (_) { /* no storage: start on the timeline */ }
  showView(saved || 'timeline');
}

/* The repository this page is showing, for the Visuals frame. Without it
 * graph.html asks ter-manager, which can name a different folder - and its
 * request would switch the broker, and this page with it, to that one. */
window.gitxActiveRepo = () => state.activeRepo || lastKnownRepo;

function initModal() {
  const modal = document.getElementById('issue-modal');
  const openBtn = document.getElementById('btn-new-issue');
  const cancelBtn = document.getElementById('modal-cancel-btn');
  const submitBtn = document.getElementById('modal-submit-btn');

  if (openBtn && modal) openBtn.onclick = () => modal.removeAttribute('hidden');
  if (cancelBtn && modal) cancelBtn.onclick = () => modal.setAttribute('hidden', '');

  if (submitBtn) {
    submitBtn.onclick = () => {
      const title = document.getElementById('input-issue-title').value.trim();
      const branch = document.getElementById('input-issue-branch').value.trim();
      const prompt = document.getElementById('input-issue-prompt').value.trim();

      if (!title || !prompt) {
        alert('Please provide a Title and Prompt Specification.');
        return;
      }

      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'CREATE_ISSUE',
          title,
          branch: branch || ('feat/task-' + (state.issues.length + 1)),
          prompt_spec: prompt,
          source_branch: state.activeBranch || 'main'
        }));
      }

      document.getElementById('input-issue-title').value = '';
      document.getElementById('input-issue-branch').value = '';
      document.getElementById('input-issue-prompt').value = '';
      modal.setAttribute('hidden', '');
    };
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/* Liquid Glass light: the glow inside a toolbar follows the pointer, the way
 * iOS 26's highlights answer the device's movement. Off when the reader asks
 * for less motion - the sheen stays, it just stops moving. */
function initLiquidLight() {
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const el of document.querySelectorAll('.lg')) {
    el.addEventListener('pointermove', (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty('--lx', ((e.clientX - r.left) / r.width * 100).toFixed(1) + '%');
      el.style.setProperty('--ly', ((e.clientY - r.top) / r.height * 100).toFixed(1) + '%');
    });
    el.addEventListener('pointerleave', () => {
      el.style.removeProperty('--lx');
      el.style.removeProperty('--ly');
    });
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initThemeSync();
  initViews();
  initSessionSync();
  connectBroker();
  initModal();
  initLiquidLight();
  if (window.GraphView) window.GraphView.init({ httpBase: BROKER_HTTP });
});
