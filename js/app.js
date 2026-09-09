/* GitX — Frontend Application & Lakehouse Controller */

const BROKER_URL = 'ws://127.0.0.1:7771';
let ws = null;
let state = {
  agents: {},
  issues: [],
  chronicles: [],
  streams: {}
};

let activeSearchLayer = 1;
let currentSearchQuery = '';
let selectedStreamFilter = null; // null = all streams, or specific streamName

// -------------------------------------------------- Ter-Manager Host Handshake
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
  renderAgents();
  renderIssues();
  renderLakehouse();
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
      <div class="agent-status-badge">${agent.status}</div>
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
    
    const branches = Array.from(new Set(['main', 'master', ...state.issues.map(i => i.branch)]));
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

  // Group into streams
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

  // 1. GOLD LAYER: Curated Features
  if (goldContainer) {
    goldContainer.innerHTML = '';
    if (streamMap.size === 0) {
      goldContainer.innerHTML = '<div style="font-size:11px;color:var(--text-dim);">No curated features yet.</div>';
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

  // 2. SILVER LAYER: Semantic Feature Lineage Streams
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

  // 3. BRONZE LAYER: Raw Chronological Commits (Filtered by Stream & Search Layer)
  if (bronzeContainer) {
    bronzeContainer.innerHTML = '';
    let filtered = chronicles;

    // Filter by selected stream if any
    if (selectedStreamFilter) {
      filtered = filtered.filter(c => (c.stream || 'Core') === selectedStreamFilter);
    }

    // Filter by layer search query if any
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
          source_branch: 'main'
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
  connectBroker();
  initModal();
  initSearch();
});
