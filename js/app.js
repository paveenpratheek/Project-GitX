/* GitX — Frontend Application & Lakehouse Controller */

const BROKER_URL = 'ws://127.0.0.1:7771';
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

let activeSearchLayer = 1;
let currentSearchQuery = '';
let selectedStreamFilter = null;
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
    });
    const initial = window.TerManager.theme.get();
    if (initial) applyHostTheme(initial);
  }
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
      if (statusText) statusText.textContent = 'Broker Active (7771)';
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
      renderIssues();
      break;
    case 'CHRONICLE_COMMITTED':
      state.chronicles.unshift(msg.chronicle);
      if (!state.streams[msg.chronicle.stream]) state.streams[msg.chronicle.stream] = [];
      state.streams[msg.chronicle.stream].push(msg.chronicle.commitHash);
      renderLakehouse();
      break;
  }
}

function renderAll() {
  renderHeaderBadge();
  renderAgents();
  renderIssues();
  renderLakehouse();
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
  const container = document.getElementById('swarm-agents-list');
  if (!container) return;
  container.innerHTML = '';

  const agentsList = Object.values(state.agents);
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

function renderIssues() {
  const container = document.getElementById('issues-list');
  if (!container) return;
  container.innerHTML = '';

  if (state.issues.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:var(--text-dim);padding:8px;">No issues yet. Click "+ New Task" to create an issue prompt.</div>';
    return;
  }

  state.issues.forEach(issue => {
    const card = document.createElement('div');
    card.className = 'issue-card';

    card.innerHTML = `
      <div class="issue-head">
        <span class="issue-num">#${issue.number}</span>
        <span class="issue-branch-badge">${escapeHtml(issue.branch)}</span>
      </div>
      <div class="issue-title">${escapeHtml(issue.title)}</div>
      <div class="issue-prompt">${escapeHtml(issue.prompt_spec)}</div>
      <div class="issue-footer">
        <span>Status: <b>${issue.status}</b></span>
        <span>Sandbox: <code>${escapeHtml(issue.worktreePath ? issue.worktreePath.split(/\\|\//).pop() : 'main')}</code></span>
      </div>
    `;

    container.appendChild(card);
  });
}

function renderLakehouse() {
  const goldContainer = document.getElementById('lakehouse-gold');
  const silverContainer = document.getElementById('lakehouse-silver');
  const bronzeContainer = document.getElementById('lakehouse-bronze');

  const chronicles = state.chronicles || [];

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

  if (goldContainer) {
    goldContainer.innerHTML = '';
    if (streamMap.size === 0) {
      goldContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">No curated features yet for this project.</div>';
    } else {
      for (const [name, sObj] of streamMap.entries()) {
        const latest = sObj.commits[0] || {};
        const isStable = sObj.commits.length >= 2 && latest.verification && !latest.verification.includes('No verification');
        
        const card = document.createElement('div');
        card.className = 'gold-card';
        card.style.cursor = 'pointer';
        card.title = 'Click to filter stream in Bronze/Silver';
        
        card.onclick = () => {
          selectedStreamFilter = (selectedStreamFilter === name) ? null : name;
          renderLakehouse();
        };

        if (selectedStreamFilter === name) {
          card.style.borderColor = 'var(--gold)';
          card.style.boxShadow = '0 0 10px rgba(227, 179, 65, 0.3)';
        }

        card.innerHTML = `
          <div>
            <div class="gold-name">${escapeHtml(name)} ${selectedStreamFilter === name ? '★ (Filtered)' : ''}</div>
            <div class="gold-stat">${sObj.commits.length} commits &bull; ${sObj.files.size} active files</div>
          </div>
          <span style="font-size:11px;color:${isStable ? 'var(--success)' : 'var(--gold)'};font-weight:700;">
            ${isStable ? 'STABLE' : 'ACTIVE'}
          </span>
        `;
        goldContainer.appendChild(card);
      }
    }
  }

  if (silverContainer) {
    silverContainer.innerHTML = '';
    if (streamMap.size === 0) {
      silverContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">No active feature threads.</div>';
    } else {
      for (const [name, sObj] of streamMap.entries()) {
        if (selectedStreamFilter && selectedStreamFilter !== name) continue;

        const thread = document.createElement('div');
        thread.className = 'stream-thread';
        thread.style.cursor = 'pointer';

        thread.onclick = () => {
          selectedStreamFilter = (selectedStreamFilter === name) ? null : name;
          renderLakehouse();
        };

        thread.innerHTML = `
          <div class="stream-name">Stream: ${escapeHtml(name)}</div>
          <div style="font-size:11px;color:var(--text-dim);">
            Linked Lineage: <b>${sObj.commits.length}</b> commits bound across time (${sObj.files.size} files)
          </div>
        `;
        silverContainer.appendChild(thread);
      }
    }
  }

  if (bronzeContainer) {
    bronzeContainer.innerHTML = '';
    let filtered = chronicles;

    if (selectedStreamFilter) {
      filtered = filtered.filter(c => (c.stream || 'Core') === selectedStreamFilter);
    }

    if (currentSearchQuery) {
      const q = currentSearchQuery.toLowerCase();
      filtered = filtered.filter(c => {
        if (activeSearchLayer === 1) return (c.motive || '').toLowerCase().includes(q) || (c.stream || '').toLowerCase().includes(q) || (c.summary || '').toLowerCase().includes(q);
        if (activeSearchLayer === 2) return (c.architecture || '').toLowerCase().includes(q);
        if (activeSearchLayer === 3) return (c.filesManifest || []).some(f => f.toLowerCase().includes(q));
        return (c.verification || '').toLowerCase().includes(q);
      });
    }

    if (filtered.length === 0) {
      bronzeContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:8px;">No commits match the active stream/layer filters.</div>';
      return;
    }

    filtered.forEach(c => {
      const card = document.createElement('div');
      card.className = 'commit-chronicle-card';

      const shortSha = (c.commitHash || '').slice(0, 7);
      const isFormal = c.isChronicle !== false;

      card.innerHTML = `
        <div class="commit-summary">
          <span style="color:var(--accent);">${shortSha ? shortSha + ' • ' : ''}</span>
          ${escapeHtml(c.summary)}
        </div>
        <div class="commit-meta">
          <span>Stream: <b>${escapeHtml(c.stream || 'Core')}</b></span>
          <span>Author: ${escapeHtml(c.author || c.agentId || 'Human')}</span>
          <span>Date: ${escapeHtml((c.timestamp || '').slice(0, 10))}</span>
        </div>
        ${isFormal ? `
        <div class="chronicle-layers">
          <div class="layer-box">
            <div class="layer-tag l1">Layer 1: Motive</div>
            <div>${escapeHtml(c.motive || 'No motive recorded')}</div>
          </div>
          <div class="layer-box">
            <div class="layer-tag l2">Layer 2: Architecture</div>
            <div style="white-space:pre-line;">${escapeHtml(c.architecture || 'No architectural notes')}</div>
          </div>
          <div class="layer-box">
            <div class="layer-tag l3">Layer 3: Code Manifest (${(c.filesManifest || []).length} files)</div>
            <div>${escapeHtml((c.filesManifest || []).join(', ') || 'None')}</div>
          </div>
          <div class="layer-box">
            <div class="layer-tag l4">Layer 4: Verification &amp; Lines</div>
            <div style="white-space:pre-line;">${escapeHtml(c.verification || 'No verification proof')}</div>
          </div>
        </div>
        ` : `
        <div style="font-size:11px;color:var(--text-dim);margin-top:4px;">${escapeHtml(c.motive || '')}</div>
        `}
      `;
      bronzeContainer.appendChild(card);
    });
  }
}

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

function initSearch() {
  const input = document.getElementById('layer-search-input');
  const buttons = document.querySelectorAll('.btn-layer-toggle');

  buttons.forEach(btn => {
    btn.onclick = () => {
      buttons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeSearchLayer = parseInt(btn.dataset.layer, 10);
      renderLakehouse();
    };
  });

  if (input) {
    input.oninput = (e) => {
      currentSearchQuery = e.target.value.trim();
      renderLakehouse();
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

window.addEventListener('DOMContentLoaded', () => {
  initThemeSync();
  initSessionSync();
  connectBroker();
  initModal();
  initSearch();
});
