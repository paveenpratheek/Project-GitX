/*
 * GitX Monitor (t-0156b1d6c5): what agents ask GitX, what GitX does with each
 * question, the layers it arranges the answer in, and the path the agent then
 * takes through them - live, and as a history of paths against prompts
 * (t-50e40ce534).
 *
 *   left    GitX Logs: one card per prompt, newest first. The selected card
 *           shows the log: the prompt, processing, search, results, filtering,
 *           building the layers, then every step the agent takes.
 *   right   the stack: the context graph beside, then L3, L2, L1 as bands; the
 *           answer's nodes in their layers, linked; an agent pointer that moves
 *           from node to node as the agent does, leaving a numbered trail.
 *
 * Events come from the broker (GITX_MONITOR, relayed from the MCP servers'
 * path recorders); the history from /api/monitor/paths. Read-only.
 */
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  /* Code on top, as an agent walks it (t-6a7335ce0a): the code, the commits
   * that wrote it, the thoughts they settled; the context graph beside. */
  const BANDS = [
    { layer: 'code', name: 'L1 · Code', sub: 'where it lives today · read first', cls: 'l1' },
    { layer: 'commit', name: 'L2 · Commits', sub: 'who wrote those lines, and why', cls: 'l2' },
    { layer: 'thought', name: 'L3 · Thoughts', sub: 'what they settled · docs', cls: 'l3' },
    { layer: 'context', name: 'Context graph', sub: 'waiting · beside the stack', cls: 'ctx' }
  ];
  const codeFirst = (rec) => !!(rec.gitx && rec.gitx.mode === 'code');
  const LABELS_PER_BAND = 8;
  const MOVE_WORD = { enter: 'entered at', along: 'along to', up: 'up to', down: 'down to', off: 'off the stack to', open: 'opened' };
  const STEP_MS = 900;
  const reduced = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;

  let opts = {};
  let els = {};
  let records = [];
  let selected = null;
  let follow = true;
  let repo = null;
  let pos = new Map();
  let pointerAt = null;
  let replayTimer = null;
  let shown = false;
  let resizeLater = false;

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const svg = (tag, attrs = {}, parent) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
    if (parent) parent.appendChild(el);
    return el;
  };
  const time = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }); } catch (_) { return ''; } };
  const day = (iso) => { try { const d = new Date(iso); return d.toDateString() === new Date().toDateString() ? 'today' : d.toLocaleDateString([], { day: 'numeric', month: 'short' }); } catch (_) { return ''; } };
  const label = (id) => {
    const s = String(id);
    if (/^t-/.test(s)) return s.slice(0, 8);
    if (s.startsWith('code:') && /:\d+$/.test(s)) return s.slice(5).replace(/:\d+$/, '').split('/').pop();
    if (s.startsWith('doc:')) return s.slice(4).replace(/:\d+$/, '').split('/').pop();
    if (s.startsWith('code:')) return codeName(s.slice(5));
    return s.slice(0, 7);
  };
  /* A region in a few characters: the file's name and the declaration's -
   * "rank.js statusOf", "gitx.css .mon-node". */
  const codeName = (region) => {
    const [file, decl] = region.split('::');
    const base = file.split('/').pop();
    if (!decl || decl === '*') return base;
    const m = decl.match(/([A-Za-z_$][\w$]*)\s*\(/) || decl.match(/[.#]?[A-Za-z_$][\w$-]*/);
    return base + ' ' + (m ? m[1] || m[0] : decl).slice(0, 16);
  };
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const sameRepo = (r) => !repo || !r || norm(r) === norm(repo);
  const ask = (rec) => (rec.question && rec.question.query) || [].concat(rec.question && rec.question.ids || [], rec.question && rec.question.paths || []).join(', ') || (rec.started_by ? tool(rec.started_by) : '(no words)');
  const found = (rec) => (rec.gitx && rec.gitx.results && rec.gitx.results.matched != null ? rec.gitx.results.matched : (rec.stack && rec.stack.nodes ? rec.stack.nodes.length : 0));
  /* A path started by a call rather than a question - gitx_find_related, the
   * record tool, a commit by hash: no search ran, so no stack and no count. */
  const tool = (t) => String(t || '').replace(/^gitx_/, '');
  const answered = (rec) => (rec.started_by ? tool(rec.started_by) + ' · no stack' : found(rec) + ' found');

  /* ------------------------------------------------------------ lifecycle */

  function init(o) {
    opts = o || {};
    els = { feed: $('mon-feed'), svg: $('mon-svg'), title: $('mon-title'), empty: $('mon-empty'), tip: $('mon-tip'),
      follow: $('mon-follow'), replay: $('mon-replay'), sub: $('mon-sub'), canvas: $('mon-canvas'), step: $('mon-stepline') };
    if (!els.feed) return;
    els.follow.addEventListener('click', () => { follow = !follow; paintFollow(); if (follow && records[0]) select(records[0], true); });
    els.replay.addEventListener('click', () => { if (selected) select(selected, true); });
    els.feed.addEventListener('click', (e) => {
      const card = e.target.closest('.mon-card');
      if (!card) return;
      const rec = records.find((r) => r.id === card.dataset.id);
      if (!rec || rec === selected) return;
      follow = false; paintFollow();
      select(rec, true);
    });
    /* A resize while the build or the replay is playing is kept for its end:
     * a stack laid out as the view opened measures the canvas before it has
     * its size, and repainting mid-animation would cut the animation off. */
    if (window.ResizeObserver) new ResizeObserver(() => {
      if (!shown || !selected) return;
      if (replayTimer) resizeLater = true;
      else paint(selected, false);
    }).observe(els.canvas);
    paintFollow();
    repo = opts.repo ? opts.repo() : null;
    load();
  }

  /* The page restores the last view before init has run; init loads then. */
  function show() { shown = true; if (!els.feed) return; if (selected) paint(selected, false); else load(); }
  function hide() { shown = false; stopReplay(); }

  function onState(st) {
    const r = st && st.activeRepo;
    if (r && norm(r) !== norm(repo)) { repo = r; records = []; selected = null; load(); }
  }

  async function load() {
    try {
      const res = await fetch((opts.httpBase || '') + '/api/monitor/paths?limit=60');
      const body = await res.json();
      const have = new Set(records.map((r) => r.id));
      for (const p of body.paths || []) if (!have.has(p.id)) records.push(p);
      records.sort((a, b) => String(b.at).localeCompare(String(a.at)));
    } catch (_) { /* broker away: live events still arrive when it is back */ }
    paintSub();
    renderFeed();
    if (!selected && records[0]) select(records[0], false);
    paintEmpty();
  }

  function onEvent(msg) {
    if (!msg || !sameRepo(msg.repo)) return;
    if (msg.event === 'ask' && msg.record) {
      records = records.filter((r) => r.id !== msg.record.id);
      records.unshift(msg.record);
      if (records.length > 200) records.length = 200;
      paintSub();
      if (follow || !selected) { select(msg.record, true); } else renderFeed();
      paintEmpty();
      return;
    }
    const rec = records.find((r) => r.id === msg.prompt);
    if (!rec) return;
    if (msg.event === 'move' && msg.step) {
      if (!rec.path.some((s) => s.n === msg.step.n)) rec.path.push(msg.step);
      rec.status = msg.status || rec.status;
      if (rec === selected) {
        appendStepLog(rec, msg.step);
        if (!replayTimer) moveTo(rec, msg.step, rec.path.length, true);
        paintStatus(rec);
      }
      updateCard(rec);
    } else if (msg.event === 'status') {
      rec.status = msg.status;
      updateCard(rec);
      if (rec === selected) paintStatus(rec);
    }
  }

  /* ------------------------------------------------------------ the logs */

  function paintFollow() {
    els.follow.setAttribute('aria-pressed', String(follow));
    els.follow.textContent = follow ? 'Following live' : 'Follow live';
  }
  function paintSub() {
    const n = records.length;
    els.sub.textContent = n ? n + ' prompt' + (n === 1 ? '' : 's') + ' · newest first' : 'no prompts yet';
  }
  function paintEmpty() { els.empty.hidden = records.length > 0; }

  function renderFeed() {
    els.feed.innerHTML = records.map((rec) => cardHtml(rec)).join('');
  }
  function updateCard(rec) {
    const old = els.feed.querySelector('.mon-card[data-id="' + CSS.escape(rec.id) + '"]');
    if (!old) return;
    const tmp = document.createElement('div');
    tmp.innerHTML = cardHtml(rec, true);
    old.replaceWith(tmp.firstElementChild);
  }

  function cardHtml(rec, quiet) {
    const sel = rec === selected;
    const steps = (rec.path || []).filter((s) => s.node || s.kind === 'declare' || rec.started_by).length;
    const off = (rec.path || []).filter((s) => s.in_stack === false).length;
    return '<div class="mon-card' + (sel ? ' mon-sel' : '') + '" data-id="' + esc(rec.id) + '">' +
      '<div class="mon-card-top"><span class="mon-dot mon-st-' + esc(rec.status) + '"></span>' +
      '<span class="mon-q">' + esc(ask(rec)) + '</span></div>' +
      '<div class="mon-card-meta">' + esc((rec.agent && rec.agent.name) || 'agent') + ' · ' + esc(day(rec.at)) + ' ' + esc(time(rec.at)) +
      ' · ' + answered(rec) + ' · ' + steps + ' step' + (steps === 1 ? '' : 's') + (off ? ' · ' + off + ' off' : '') +
      ' · <span class="mon-st-word mon-st-' + esc(rec.status) + '">' + esc(statusWord(rec.status)) + '</span></div>' +
      (sel ? '<ol class="mon-log' + (quiet ? ' mon-quiet' : '') + '">' + logHtml(rec) + '</ol>' : '') +
      '</div>';
  }

  function statusWord(s) { return { walking: 'walking', declared: 'declared', 're-asked': 're-asked', left: 'left', ended: 'ended' }[s] || s || ''; }

  function logHtml(rec) {
    if (codeFirst(rec)) return codeLogHtml(rec);
    if (rec.started_by) {
      let html = '<li class="mon-l mon-l-prompt" style="--i:0"><span class="mon-l-h">Call</span><span class="mon-l-main">' + esc(tool(rec.started_by)) + (rec.question && rec.question.query ? ' “' + esc(rec.question.query) + '”' : '') + '</span>' +
        '<span class="mon-l-sub">' + esc(((rec.agent && rec.agent.name) || 'agent') + ' · ' + time(rec.at) + ' · no question asked first, so no stack') + '</span></li>';
      (rec.path || []).forEach((step, i) => { html += stepHtml(step, 1 + i); });
      return html + '<li class="mon-l mon-l-status" style="--i:' + (1 + (rec.path || []).length) + '"><span class="mon-l-h">Status</span><span class="mon-l-main mon-st-word mon-st-' + esc(rec.status) + '" id="mon-status">' + esc(statusWord(rec.status)) + '</span></li>';
    }
    const g = rec.gitx || {};
    const p = g.processing || {}, s = g.search || {}, r = g.results || {}, f = g.filtering || {};
    const by = { context: 0, thought: 0, commit: 0, code: 0 };
    let edgeN = 0;
    for (const n of (rec.stack && rec.stack.nodes) || []) { if (n.role === 'edge') edgeN++; else by[n.layer] = (by[n.layer] || 0) + 1; }
    const scope = esc('layers: ' + (Array.isArray(f.layers) ? f.layers.join(', ') : f.layers || 'all') + (f.outcome ? ' · outcome: ' + f.outcome.join(', ') : '') + (f.kind ? ' · kind: ' + f.kind.join(', ') : ''));
    /* A prompt answered by the pull says where it entered and how far the
     * links went; one from before it, the candidates and the cut. */
    const pulled = r.entries != null;
    const lines = [
      ['prompt', 'Prompt', '“' + esc(ask(rec)) + '”', esc(((rec.agent && rec.agent.name) || 'agent') + ' · ' + time(rec.at))],
      ['proc', 'Processing', (p.nodes || 0) + ' nodes indexed', esc((p.commits || 0) + ' commits · ' + (p.settled || 0) + ' settled · ' + (p.waiting || 0) + ' waiting · ' + (p.ms || 0) + ' ms')],
      ['search', 'Search', esc((s.words || []).join(' ') || '(ids and paths only)'),
        (s.unmatched && s.unmatched.length ? 'not in the graph: ' + esc(s.unmatched.join(' ')) : 'every word found in the graph') + (s.paths && s.paths.length ? ' · paths: ' + esc(s.paths.join(', ')) : '') +
        (s.learned && s.learned.length ? ' · learned from earlier walks: ' + esc(s.learned.join(', ')) : '')],
      pulled
        ? ['results', 'Entered and pulled', 'entered at ' + r.entries + ' · pulled ' + (r.pulled || 0) + ' within ' + (r.hops || 4) + ' hops',
          esc(r.closest != null ? 'no node held 70% of the words - entered at the closest (' + Math.round(r.closest * 100) + '%)' : 'every entry holds 70% or more of the words') + ' · ' + (r.ms || 0) + ' ms']
        : ['results', 'Results', (r.candidates || 0) + ' candidates → ' + (r.matched || 0) + ' matched', esc('signals: ' + (r.signals || []).join(', ') + ' · ' + (r.ms || 0) + ' ms')],
      pulled
        ? ['filter', 'The stack', 'core ' + (f.core || 0) + ' · edge ' + (f.edge || 0) + (f.words_only ? ' · words only ' + f.words_only : ''),
          scope + ' · ' + (f.returned || 0) + ' given in full' + (f.summaries && f.summaries.length ? ' · led by the summary of ' + esc(f.summaries.join(', ')) : '')]
        : ['filter', 'Filtering', 'kept ' + (f.returned || 0) + ' of ' + (r.matched || 0), scope + ' · limit ' + (f.limit || '')],
      ['layers', 'Building the layers', 'context ' + by.context + ' · L3 ' + by.thought + ' · L2 ' + by.commit + ' · L1 ' + by.code,
        ((rec.stack && rec.stack.links) || []).length + ' links between them' + (edgeN ? ' · ' + edgeN + ' on the edge' : '')]
    ];
    let html = lines.map(([k, h, main, sub], i) =>
      '<li class="mon-l mon-l-' + k + '" style="--i:' + i + '"><span class="mon-l-h">' + h + '</span><span class="mon-l-main">' + main + '</span><span class="mon-l-sub">' + sub + '</span></li>').join('');
    (rec.path || []).forEach((step, i) => { html += stepHtml(step, lines.length + i); });
    html += '<li class="mon-l mon-l-status" style="--i:' + (lines.length + (rec.path || []).length) + '"><span class="mon-l-h">Status</span><span class="mon-l-main mon-st-word mon-st-' + esc(rec.status) + '" id="mon-status">' + esc(statusWord(rec.status)) + '</span></li>';
    return html;
  }

  /* A question answered from the code down: where it entered, then the chain. */
  function codeLogHtml(rec) {
    const g = rec.gitx || {}, p = g.processing || {}, s = g.search || {}, r = g.results || {};
    const lines = [
      ['prompt', 'Prompt', '“' + esc(ask(rec)) + '”', esc(((rec.agent && rec.agent.name) || 'agent') + ' · ' + time(rec.at))],
      ['proc', 'Processing', (p.regions || 0) + ' code regions at HEAD', esc((p.commits || 0) + ' commits · ' + (p.settled || 0) + ' settled · ' + (p.waiting || 0) + ' waiting · ' + (p.ms || 0) + ' ms')],
      ['search', 'Search', esc((s.words || []).join(' ') || '(no words)'), esc(s.carried ? 'carried from the last question: ' + s.carried.join(' ') : 'nothing carried')],
      ['results', 'The map', s.no_code ? 'no code about this' : 'core ' + (r.code || 0) + ' · wiring ' + (r.wiring || 0) + ' · surface ' + (r.surface || 0) + (r.docs ? ' · ' + r.docs + ' doc section' + (r.docs === 1 ? '' : 's') : ''),
        esc(s.no_code ? 'the closest region holds ' + (s.best || 0) + '% of the question - answered from the plans' : 'the best holds ' + (s.best || 0) + '% of the question')],
      ['filter', 'The chain', (r.commits || 0) + ' commits wrote it · ' + (r.thoughts || 0) + ' thoughts settled', esc((r.context || 0) + ' waiting beside · ' + (r.ms || 0) + ' ms')]
    ];
    let html = lines.map(([k, h, main, sub], i) =>
      '<li class="mon-l mon-l-' + k + '" style="--i:' + i + '"><span class="mon-l-h">' + h + '</span><span class="mon-l-main">' + main + '</span><span class="mon-l-sub">' + sub + '</span></li>').join('');
    (rec.path || []).forEach((step, i) => { html += stepHtml(step, lines.length + i); });
    return html + '<li class="mon-l mon-l-status" style="--i:' + (lines.length + (rec.path || []).length) + '"><span class="mon-l-h">Status</span><span class="mon-l-main mon-st-word mon-st-' + esc(rec.status) + '" id="mon-status">' + esc(statusWord(rec.status)) + '</span></li>';
  }

  function stepHtml(step, i) {
    const n = step.n || '';
    if (step.kind === 'declare') {
      const c = (step.cited_in_stack || []).length;
      return '<li class="mon-l mon-l-step mon-l-declare" style="--i:' + i + '"><span class="mon-l-h">' + n + ' · Declared</span><span class="mon-l-main">recorded ' + esc((step.recorded || []).map(label).join(', ')) + '</span><span class="mon-l-sub">cites ' + c + ' node' + (c === 1 ? '' : 's') + ' from the stack</span></li>';
    }
    if (!step.node) {
      return '<li class="mon-l mon-l-step mon-l-other" style="--i:' + i + '"><span class="mon-l-h">' + n + ' · ' + esc(tool(step.tool)) + '</span><span class="mon-l-main">' + esc(step.asked ? '“' + step.asked + '”' : step.what || step.kind) + '</span><span class="mon-l-sub">' + esc(got(step) || step.what || '') + '</span></li>';
    }
    const off = step.in_stack === false;
    return '<li class="mon-l mon-l-step' + (off ? ' mon-l-off' : '') + '" style="--i:' + i + '"><span class="mon-l-h">' + n + ' · ' + esc(off ? 'Off the stack' : (step.move || 'move')) + '</span>' +
      '<span class="mon-l-main">' + esc((MOVE_WORD[step.move] || 'to') + ' ' + label(step.node.id)) + ' <span class="mon-layer">' + esc(layerName(step.node.layer)) + '</span></span>' +
      '<span class="mon-l-sub">' + esc([step.node.text || tool(step.tool), got(step)].filter(Boolean).join(' · ')) + '</span></li>';
  }
  /* What a call gave back, said only where it adds to the node it opened. */
  const got = (step) => (step.got && step.got !== 'answered' && !/^read /.test(step.got) ? 'got ' + step.got : '');
  function layerName(l) { return { context: 'context', thought: 'L3', commit: 'L2', code: 'L1' }[l] || l || '?'; }

  function appendStepLog(rec, step) {
    const log = els.feed.querySelector('.mon-sel .mon-log');
    if (!log) return;
    const status = log.querySelector('.mon-l-status');
    const tmp = document.createElement('ol');
    tmp.innerHTML = stepHtml(step, 0);
    const li = tmp.firstElementChild;
    li.style.setProperty('--i', '0');
    log.insertBefore(li, status);
    li.scrollIntoView({ block: 'nearest', behavior: reduced ? 'auto' : 'smooth' });
  }
  function paintStatus(rec) {
    const el = $('mon-status');
    if (el) { el.textContent = statusWord(rec.status); el.className = 'mon-l-main mon-st-word mon-st-' + rec.status; }
  }

  /* ------------------------------------------------------------ the stack */

  function select(rec, animate) {
    stopReplay();
    selected = rec;
    renderFeed();
    const card = els.feed.querySelector('.mon-sel');
    if (card && animate) card.scrollIntoView({ block: 'nearest' });
    if (shown) paint(rec, animate);
  }

  /* Draw the stack, then the path on it: played step by step after the build
   * when animating, laid down at once otherwise (a resize, a return to the view). */
  function paint(rec, animate) {
    stopReplay();
    resizeLater = false;
    drawStack(rec, animate);
    if (!rec.path.length) return;
    if (animate && !reduced) replayTimer = setTimeout(() => replay(rec), buildTime(rec) + 250);
    else rec.path.forEach((s, i) => moveTo(rec, s, i + 1, false));
  }

  function buildTime(rec) {
    const nodes = (rec.stack && rec.stack.nodes) || [];
    return 4 * 90 + nodes.reduce((s, n) => s + nodeStep(n), 0) + 500;
  }
  const nodeStep = (n) => (n.role === 'edge' ? 3 : n.layer === 'code' ? 12 : 70);

  function stopReplay() { if (replayTimer) { clearTimeout(replayTimer); clearInterval(replayTimer); replayTimer = null; } }

  function replay(rec) {
    stopReplay();
    let i = 0;
    const next = () => {
      if (rec !== selected) return stopReplay();
      if (i >= rec.path.length) {
        replayTimer = null;
        if (resizeLater) { resizeLater = false; paint(rec, false); }
        return;
      }
      moveTo(rec, rec.path[i], i + 1, true);
      i++;
      replayTimer = setTimeout(next, STEP_MS);
    };
    next();
  }

  function layout(rec) {
    const box = els.canvas.getBoundingClientRect();
    const W = Math.max(520, box.width), H = Math.max(420, box.height);
    const top = 78, bottom = 54, gap = 10, left = 24, right = 24, offW = 150;
    const bh = (H - top - bottom - gap * (BANDS.length - 1)) / BANDS.length;
    const bands = BANDS.map((b, i) => ({ ...b, x: left, y: top + i * (bh + gap), w: W - left - right, h: bh }));
    const placed = new Map();
    const nodes = (rec.stack && rec.stack.nodes) || [];
    const order = bands.slice().sort((a, b) => (a.layer === 'code') - (b.layer === 'code'));
    for (const band of order) {
      const mine = nodes.filter((n) => n.layer === band.layer);
      const x0 = band.x + 150, x1 = band.x + band.w - offW;
      if (band.layer === 'code' && !codeFirst(rec)) { placeCode(mine, band, placed, x1); continue; }
      /* The core across the middle of the band, only the strongest named
       * when it is crowded; the edge of the pull as a strip of faint dots
       * along the band's floor - on the stack, but not what it is about. */
      const core = mine.filter((n) => n.role !== 'edge'), edge = mine.filter((n) => n.role === 'edge');
      /* As many names as the band's width holds - a name is ~80px - at most
       * LABELS_PER_BAND, the strongest first. */
      const names = Math.max(2, Math.min(LABELS_PER_BAND, Math.floor((x1 - x0) / 80)));
      const crowded = core.length > names;
      const named = new Set(core.slice().sort((a, b) => (a.rank || 1e9) - (b.rank || 1e9)).slice(0, names).map((n) => n.id));
      const y = band.y + band.h / 2 + 4 - (edge.length ? 6 : 0);
      core.forEach((n, i) => placed.set(n.id, {
        x: x0 + (i + 0.5) * ((x1 - x0) / core.length), y, band, node: n,
        small: core.length > 14, labelled: !crowded || named.has(n.id), labelY: crowded && i % 2 ? 41 : 26
      }));
      edge.forEach((n, i) => placed.set(n.id, { x: x0 + (i + 0.5) * ((x1 - x0) / edge.length), y: band.y + band.h - 11, band, node: n, edge: true, labelled: false }));
    }
    return { W, H, bands, placed, offX: W - right - offW / 2 };
  }

  /* The code sits under the commit that changed it - a small grid of chips
   * below each commit, its largest regions full size and the rest small, and
   * only the largest named, since a commit can change thirty regions and the
   * band is one row of commits wide. Every chip names itself on hover. A
   * region two commits changed sits under the first, linked from both. */
  function placeCode(mine, band, placed, x1) {
    const groups = new Map();
    for (const n of mine) {
      const at = (n.commits || []).map((id) => placed.get(id)).filter(Boolean).sort((a, b) => a.x - b.x)[0];
      const key = at ? at.node.id : '';
      if (!groups.has(key)) groups.set(key, { x: at ? at.x : x1 - 20, list: [] });
      groups.get(key).list.push(n);
    }
    const dx = 13, dy = 13;
    const list = [...groups.values()].sort((a, b) => a.x - b.x);
    for (const g of list) {
      g.list.sort((a, b) => (b.major - a.major) || (b.share || 0) - (a.share || 0));
      g.cols = Math.max(4, Math.ceil(g.list.length / 6));
      g.rows = Math.ceil(g.list.length / g.cols);
    }
    /* Every grid hangs from one line and every label sits on one baseline
     * under the tallest; neighbouring commits sit closer than a label is
     * wide in a narrow window, so every other label drops a line. */
    const tallest = Math.max(1, ...list.map((g) => g.rows));
    const y0 = band.y + Math.max(30, band.h / 2 - ((tallest - 1) * dy) / 2 - 8);
    const base = y0 + (tallest - 1) * dy + 18;
    /* As many label rows as the closest pair of commits needs (at most three),
     * and each label cut to the room that leaves it. */
    const gap = list.length > 1 ? Math.min(...list.slice(1).map((g, i) => g.x - list[i].x)) : Infinity;
    const levels = Math.min(3, Math.max(1, Math.ceil(150 / gap)));
    /* Too close even for three rows: name every other commit's code, or every
     * third - the rest name themselves on hover. Grids narrow to their room. */
    const stride = Math.max(1, Math.ceil(90 / (gap * levels)));
    const room = Math.max(6, Math.floor((gap * levels * stride - 10) / 6.4));
    const maxCols = Math.max(...list.map((g) => g.cols));
    const sx = Math.max(6, Math.min(dx, (gap - 4) / maxCols));
    list.forEach((g, gi) => {
      g.list.forEach((n, i) => {
        const c = i % g.cols, r = Math.floor(i / g.cols);
        const x = g.x + (c - (g.cols - 1) / 2) * sx, y = y0 + r * dy;
        placed.set(n.id, {
          x, y, band, node: n, minor: !n.major,
          labelled: i === 0 && gi % stride === 0, labelX: g.x - x, labelY: base + (Math.floor(gi / stride) % levels) * 13 - y, labelMax: room
        });
      });
    });
  }

  function drawStack(rec, animate) {
    const root = els.svg;
    root.innerHTML = '';
    pos = new Map();
    pointerAt = null;
    const L = layout(rec);
    root.setAttribute('viewBox', '0 0 ' + L.W + ' ' + L.H);
    root.classList.toggle('mon-anim', !!animate && !reduced);
    els.title.innerHTML = '<div class="mon-t-q">“' + esc(ask(rec)) + '”</div><div class="mon-t-sub">' +
      esc(((rec.agent && rec.agent.name) || 'agent') + ' · ' + day(rec.at) + ' ' + time(rec.at) + ' · ' + answered(rec) + ' · ' + ((rec.stack && rec.stack.nodes) || []).length + ' in the stack') + '</div>';

    const defs = svg('defs', {}, root);
    const mk = svg('marker', { id: 'mon-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '6', markerHeight: '6', orient: 'auto-start-reverse' }, defs);
    svg('path', { d: 'M0,0 L10,5 L0,10 z', class: 'mon-arrow' }, mk);

    L.bands.forEach((b, i) => {
      const g = svg('g', { class: 'mon-band mon-b-' + b.cls, style: '--d:' + (i * 90) + 'ms' }, root);
      svg('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 16, class: 'mon-band-rect' }, g);
      svg('text', { x: b.x + 16, y: b.y + 24, class: 'mon-band-name' }, g).textContent = b.name;
      svg('text', { x: b.x + 16, y: b.y + 40, class: 'mon-band-sub' }, g).textContent = b.sub;
      svg('line', { x1: b.x + b.w - 150, y1: b.y + 10, x2: b.x + b.w - 150, y2: b.y + b.h - 10, class: 'mon-off-rule' }, g);
      if (i === 0) svg('text', { x: b.x + b.w - 75, y: b.y + 18, class: 'mon-off-label', 'text-anchor': 'middle' }, g).textContent = 'off the stack';
    });

    const linkLayer = svg('g', { class: 'mon-links' }, root);
    const nodeLayer = svg('g', { class: 'mon-nodes' }, root);
    const nodeDelay0 = BANDS.length * 90 + 150;
    let k = 0;
    /* Code chips pop quickly after one another: there can be dozens. */
    let t = nodeDelay0;
    for (const [id, p] of L.placed) { pos.set(id, p); drawNode(nodeLayer, p, false, t); t += nodeStep(p.node); k++; }
    const linkDelay = t;
    ((rec.stack && rec.stack.links) || []).forEach(([a, type, b], i) => {
      const pa = pos.get(a), pb = pos.get(b);
      if (!pa || !pb) return;
      const path = svg('path', { d: curve(pa, pb), class: 'mon-link mon-link-' + type, 'marker-end': 'url(#mon-arrow)' }, linkLayer);
      svg('title', {}, path).textContent = label(a) + ' ' + type + ' ' + label(b);
      if (animate && !reduced) {
        const len = path.getTotalLength ? path.getTotalLength() : 200;
        path.style.strokeDasharray = len;
        path.style.strokeDashoffset = len;
        path.style.animation = 'monDraw 600ms ' + (linkDelay + i * 60) + 'ms ease-out forwards';
      }
    });
    if (!((rec.stack && rec.stack.nodes) || []).length) {
      svg('text', { x: L.W / 2, y: L.H / 2, 'text-anchor': 'middle', class: 'mon-none' }, root).textContent = rec.started_by ? 'Started by ' + tool(rec.started_by) + ' - no question was asked, so there is no stack' : 'Nothing matched this prompt - the stack is empty';
    }
    svg('g', { class: 'mon-trail', id: 'mon-trail' }, root);
    drawPointer(root, L);
    els.step.textContent = rec.path.length ? rec.path.length + ' step' + (rec.path.length === 1 ? '' : 's') + ' on this path' : 'the agent has not moved yet';
    root._layout = L;
  }

  function drawNode(parent, p, off, delay) {
    const n = p.node;
    const g = svg('g', { class: 'mon-node mon-n-' + n.layer + ' ' + statusClass(n) + (off ? ' mon-n-offstack' : '') + (n.role === 'via' ? ' mon-n-via' : '') + (p.minor ? ' mon-n-minor' : '') + (p.edge ? ' mon-n-edge' : ''),
      transform: 'translate(' + p.x + ' ' + p.y + ')', style: delay != null ? '--d:' + delay + 'ms' : null, 'data-id': n.id }, parent);
    const shape = svg('g', { class: 'mon-n-shape' }, g);
    if (p.edge) svg('circle', { r: 2.6, class: 'mon-n-body' }, shape);
    else if (n.layer === 'commit') { const s = p.small ? 6 : 9; svg('rect', { x: -s, y: -s, width: 2 * s, height: 2 * s, rx: p.small ? 3 : 4, class: 'mon-n-body' }, shape); }
    else if (n.layer === 'code') {
      const s = p.minor ? 3 : 5;
      svg('rect', { x: -s, y: -s, width: 2 * s, height: 2 * s, rx: 1.5, class: 'mon-n-body' }, shape);
    } else svg('circle', { r: p.small ? 6 : 9, class: 'mon-n-body' }, shape);
    if (n.rank === 1) svg('circle', { r: 14, class: 'mon-n-entry' }, shape);
    if (p.labelled !== false) {
      const name = label(n.id);
      svg('text', { x: p.labelX || 0, y: p.labelY || 26, 'text-anchor': 'middle', class: 'mon-n-label' }, g).textContent =
        p.labelMax && name.length > p.labelMax ? name.slice(0, p.labelMax - 1) + '…' : name;
    }
    if (n.rank && p.labelled !== false) svg('text', { x: 12, y: -10, class: 'mon-n-rank' }, g).textContent = n.rank;
    g.addEventListener('mouseenter', (e) => tip(e, n, off));
    g.addEventListener('mouseleave', () => { els.tip.hidden = true; });
  }

  function statusClass(n) {
    const s = String(n.status || '');
    if (/^OPEN|^PROPOSED - NOT/.test(s)) return 'mon-s-open';
    if (/^REJECTED/.test(s)) return 'mon-s-rej';
    if (/^SUPERSEDED/.test(s)) return 'mon-s-sup';
    if (/^STASHED/.test(s)) return 'mon-s-stash';
    if (/NOT BUILT/.test(s)) return 'mon-s-wait';
    return 'mon-s-done';
  }

  function tip(e, n, off) {
    const box = els.canvas.getBoundingClientRect();
    els.tip.innerHTML = '<div class="mon-tip-h">' + esc(n.status || layerName(n.layer)) + (off ? ' · off the stack' : '') + '</div>' +
      (n.layer === 'code' ? '' : '<div class="mon-tip-id">' + esc(n.id) + (n.topic ? ' · ' + esc(n.topic) : '') + '</div>') +
      (n.text ? '<div class="mon-tip-t">' + esc(n.text) + '</div>' : '') +
      (n.why ? '<div class="mon-tip-w">' + esc(n.why) + '</div>' : '') +
      (n.commits ? '<div class="mon-tip-w">changed by ' + esc(n.commits.join(', ')) + (n.share ? ' · ' + Math.round(n.share * 100) + '% of its change' : '') + '</div>' : '');
    els.tip.hidden = false;
    els.tip.style.left = Math.min(box.width - 300, e.clientX - box.left + 14) + 'px';
    els.tip.style.top = Math.max(8, e.clientY - box.top - 10) + 'px';
  }

  function curve(a, b) {
    if (Math.abs(a.y - b.y) < 2) {
      const mid = (a.x + b.x) / 2, lift = Math.min(46, Math.abs(b.x - a.x) / 3 + 14);
      return 'M' + a.x + ',' + (a.y - 10) + ' Q' + mid + ',' + (a.y - lift) + ' ' + b.x + ',' + (b.y - 10);
    }
    const dy = (b.y - a.y) / 2;
    return 'M' + a.x + ',' + (a.y + Math.sign(dy) * 10) + ' C' + a.x + ',' + (a.y + dy) + ' ' + b.x + ',' + (b.y - dy) + ' ' + b.x + ',' + (b.y - Math.sign(dy) * 11);
  }

  /* ------------------------------------------------------------ the agent */

  function drawPointer(root, L) {
    /* Moved by the CSS transform property, not the attribute, so the
     * transition in gitx.css can glide it from node to node. */
    const g = svg('g', { class: 'mon-agent', id: 'mon-agent', opacity: '0' }, root);
    g.style.transform = 'translate(' + (L.W / 2) + 'px, 40px)';
    svg('circle', { r: 16, class: 'mon-agent-pulse' }, g);
    svg('circle', { r: 12, class: 'mon-agent-body' }, g);
    svg('rect', { x: -6, y: -5, width: 12, height: 9, rx: 2.5, class: 'mon-agent-face' }, g);
    svg('circle', { cx: -2.5, cy: -0.6, r: 1.2, class: 'mon-agent-eye' }, g);
    svg('circle', { cx: 2.5, cy: -0.6, r: 1.2, class: 'mon-agent-eye' }, g);
    svg('line', { x1: 0, y1: -5, x2: 0, y2: -8, class: 'mon-agent-ant' }, g);
  }

  function offPlace(L, node) {
    const band = L.bands.find((b) => b.layer === (node.layer || 'thought')) || L.bands[1];
    const already = [...pos.values()].filter((p) => p.off && p.band === band).length;
    /* Below the band's "off the stack" label, then down the column. */
    const y = Math.min(band.y + band.h - 22, band.y + Math.max(52, band.h / 2 + 4) + already * 34);
    return { x: L.offX, y, band, off: true, node: { ...node, status: node.layer === 'commit' ? 'COMMIT' : 'opened outside the stack' } };
  }

  function moveTo(rec, step, n, animate) {
    const root = els.svg;
    const L = root._layout;
    if (!L) return;
    if (step.kind === 'declare') { markDeclared(step); return; }
    if (!step.node) return;
    let p = pos.get(step.node.id);
    if (!p) {
      p = offPlace(L, step.node);
      pos.set(step.node.id, p);
      drawNode(root.querySelector('.mon-nodes'), p, true, null);
    }
    const agent = $('mon-agent');
    const trail = $('mon-trail');
    const target = { x: p.x, y: p.y - 30 };
    if (pointerAt) {
      const seg = svg('path', { d: 'M' + pointerAt.x + ',' + (pointerAt.y + 30) + ' L' + p.x + ',' + p.y, class: 'mon-trail-seg' + (step.in_stack === false ? ' mon-trail-off' : '') }, trail);
      if (animate && !reduced) {
        const len = seg.getTotalLength();
        seg.style.strokeDasharray = len; seg.style.strokeDashoffset = len;
        seg.style.animation = 'monDraw 520ms ease-out forwards';
      }
    }
    const badge = svg('g', { class: 'mon-step' + (step.in_stack === false ? ' mon-step-off' : ''), transform: 'translate(' + (p.x - 16) + ' ' + (p.y + 14) + ')' }, trail);
    svg('circle', { r: 8 }, badge);
    svg('text', { y: 3.5, 'text-anchor': 'middle' }, badge).textContent = n;
    const visited = root.querySelector('.mon-node[data-id="' + CSS.escape(step.node.id) + '"]');
    if (visited) visited.classList.add('mon-visited');
    agent.style.transition = animate && !reduced ? '' : 'none';
    agent.setAttribute('opacity', '1');
    agent.style.transform = 'translate(' + target.x + 'px, ' + target.y + 'px)';
    agent.classList.toggle('mon-agent-off', step.in_stack === false);
    pointerAt = target;
    els.step.textContent = 'step ' + n + ' of ' + rec.path.length + (step.in_stack === false ? ' · off the stack' : '');
  }

  function markDeclared(step) {
    for (const c of step.cited_in_stack || []) {
      const el = els.svg.querySelector('.mon-node[data-id="' + CSS.escape(String(c).startsWith('t-') ? c : String(c).slice(0, 8)) + '"]');
      if (el) el.classList.add('mon-cited');
    }
    const agent = $('mon-agent');
    if (agent) agent.classList.add('mon-agent-declared');
  }

  window.GitxMonitor = { init, show, hide, onEvent, onState };
})();
