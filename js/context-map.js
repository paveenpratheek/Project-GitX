/* GitX - the Context Map: the context graph drawn as a network, and the goal
 * that decides which part of it agents read. docs/context-map-plan.md.
 *
 * Minimal, in iOS 26's language (the owner's design of 25 September, the
 * "GitX Context Map" canvas): the map runs edge to edge under Liquid Glass
 * controls; one accent marks what is active and everything else is ink and
 * greys; shape, not colour, tells kinds of thought apart.
 *
 *   Domain   a kind of content: a hairline circle around its nodes, a label
 *   Topic    a hub in every domain holding its thoughts. Active: a blue pin
 *            with its name. Dormant: a quiet ring with its name and a count,
 *            its thoughts folded away. The same topic's active hubs are joined
 *            across domains by a faint accent line.
 *   Thought  a dot - ink accepted, red rejected - tied to its hub by a
 *            hairline. Links between thoughts show only for the topic or
 *            thought selected.
 *
 * Rules (diamonds), Bugs & open questions (open: hollow rings) and Stashed
 * (dashed rings) float: unconnected until used.
 *
 * Data is the broker's /api/thoughts payload, which graph-view.js fetches and
 * hands over (onData). Changes go to /api/context/goal; the broker writes
 * goal.json, the watcher records it, and the new payload arrives the same way
 * as any other. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /* Where each domain settles. World units; the floating ones at the edges. */
  const ANCHOR = {
    goals: [250, 270], stashed: [520, 170], information: [790, 340], discussion: [470, 500],
    rules: [140, 540], criteria: [290, 740], constraints: [650, 730], questions: [920, 640],
    planning: [470, 930]
  };
  const UNSORTED = 'unsorted';
  const ringOf = (n) => 30 + Math.min(34, n * 3.2);        // how far a hub's thoughts sit from it

  const S = {
    httpBase: '', visible: false, dirty: true,
    data: null, domains: [], dom: {}, topics: {}, goal: null,
    nodes: [], byId: new Map(), edges: [], tById: new Map(),
    selTopic: null, selThought: null, hover: null, view: null, alpha: 0, scene: null,
    pos: new Map(),            // id -> {x, y, fx, fy}, kept across refreshes
    editing: null, error: null
  };

  const floating = (d) => !!(S.dom[d] && S.dom[d].floating);
  const hubId = (topic, domain) => 'h:' + topic + ':' + domain;
  const tokensOf = (t) => Math.round((String(t.text || '').length + (t.forces || []).reduce((n, f) => n + String(f.text || '').length, 0)) / 4);
  const title = (topic) => topic === UNSORTED ? 'Unsorted' : (S.topics[topic] ? S.topics[topic].title : topic);
  /* While the goal is being edited, the map previews the topics chosen. */
  const activeTopics = () => S.editing ? S.editing.chosen : S.goal ? S.goal.topics : [];
  const topicActive = (topic, domain) => topic !== UNSORTED && !floating(domain) && activeTopics().includes(topic) && !(S.goal && S.goal.domains_off.includes(domain));
  const hubState = (n) => n.topic === UNSORTED ? 'unsorted' : topicActive(n.topic, n.domain) ? 'active' : 'dormant';
  const shown = (n) => n.type !== 'thought' || floating(n.domain) || n.topic === UNSORTED || topicActive(n.topic, n.domain);

  /* ============================================================ data */
  function onData(payload) {
    const ctx = payload && payload.context;
    if (!ctx || !ctx.map) { S.data = { missing: true }; S.dirty = true; if (S.visible) render(); return; }
    S.data = ctx;
    S.repo = payload.repo || '';
    S.domains = ctx.map.domains;
    S.dom = Object.fromEntries(S.domains.map((d) => [d.id, d]));
    S.topics = Object.fromEntries(ctx.map.topics.map((t) => [t.id, t]));
    S.goal = ctx.map.goal ? { ...ctx.map.goal, topics: ctx.map.goal.topics.slice(), domains_off: ctx.map.goal.domains_off.slice() } : null;
    S.dirty = true;
    if (S.visible) render();
  }

  function graph() {
    const T = S.data.thoughts.map((t) => ({ ...t, topic: t.topic || UNSORTED }));
    S.tById = new Map(T.map((t) => [t.id, t]));
    const nodes = [], byId = new Map();
    const add = (n) => {
      const was = S.pos.get(n.id);
      const [ax, ay] = ANCHOR[n.domain] || [600, 500];
      Object.assign(n, was ? { x: was.x, y: was.y, fx: was.fx, fy: was.fy } : { x: ax + (Math.random() - 0.5) * 160, y: ay + (Math.random() - 0.5) * 160 }, { vx: 0, vy: 0 });
      nodes.push(n); byId.set(n.id, n);
    };
    const count = new Map();
    for (const t of T) if (!floating(t.domain)) count.set(hubId(t.topic, t.domain), (count.get(hubId(t.topic, t.domain)) || 0) + 1);
    for (const [h, n] of count) {
      const [, topic, domain] = h.split(':');
      add({ id: h, type: 'hub', topic, domain, n, r: 10 });
    }
    for (const t of T) add({ id: t.id, type: 'thought', t, topic: t.topic, domain: t.domain, r: 4 });

    const edges = [];
    const edge = (a, b, kind, len, k) => { if (byId.get(a) && byId.get(b)) edges.push({ a: byId.get(a), b: byId.get(b), kind, len, k }); };
    for (const t of T) if (!floating(t.domain)) {
      const h = hubId(t.topic, t.domain);
      edge(t.id, h, t.outcome === 'rejected' ? 'member-rejected' : 'member', ringOf(count.get(h)), 0.12);
    }
    const byTopic = {};
    for (const n of nodes) if (n.type === 'hub' && n.topic !== UNSORTED) (byTopic[n.topic] = byTopic[n.topic] || []).push(n);
    for (const list of Object.values(byTopic)) for (let i = 0; i < list.length - 1; i++) edge(list[i].id, list[i + 1].id, 'cross', 280, 0.008);
    const linksOf = (t) => [...(t.links || []).map((l) => ({ type: l.type, to: l.to })), ...(t.forces || []).flatMap((f) => f.cites || []).map((c) => ({ type: 'cites', to: c }))];
    for (const t of T) for (const l of linksOf(t)) if (S.tById.has(l.to) && l.to !== t.id) {
      const fl = floating(t.domain) || floating(S.tById.get(l.to).domain);
      edge(t.id, l.to, l.type === 'lost-to' ? 'lost' : 'link', 70, fl ? 0 : 0.004);
    }
    S.nodes = nodes; S.byId = byId; S.edges = edges;
  }

  /* ============================================================ layout */
  const pull = (n) => n.type === 'hub' ? 0.03 : floating(n.domain) ? 0.045 : 0.003;
  function tick() {
    const act = S.nodes.filter(shown), a = S.alpha;
    for (let i = 0; i < act.length; i++) {
      const p = act[i];
      for (let j = i + 1; j < act.length; j++) {
        const q = act[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const hubs = (p.type === 'hub') + (q.type === 'hub');
        /* Hubs keep well apart - their labels run to the right of them. */
        let f = (hubs === 2 ? 16000 : hubs === 1 ? 700 : 80) / d2 * a;
        const min = p.r + q.r + (hubs === 2 ? 46 : hubs ? 16 : 7);
        if (d < min) f += (min - d) * 0.4;
        dx /= d; dy /= d;
        p.vx += dx * f; p.vy += dy * f; q.vx -= dx * f; q.vy -= dy * f;
      }
    }
    for (const e of S.edges) {
      if (!e.k || !shown(e.a) || !shown(e.b)) continue;
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y, d = Math.hypot(dx, dy) || 0.01;
      const f = (d - e.len) * e.k * a;
      e.a.vx += dx / d * f; e.a.vy += dy / d * f; e.b.vx -= dx / d * f; e.b.vy -= dy / d * f;
    }
    for (const n of act) {
      const [x, y] = ANCHOR[n.domain] || [600, 500], k = pull(n) * a;
      n.vx += (x - n.x) * k; n.vy += (y - n.y) * k;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.58; n.vy *= 0.58;
      n.x += n.vx; n.y += n.vy;
    }
    S.alpha *= 0.985;
  }
  function settle(from, ticks) { S.alpha = Math.max(S.alpha, from); for (let i = 0; i < ticks; i++) tick(); remember(); }
  function remember() { for (const n of S.nodes) S.pos.set(n.id, { x: n.x, y: n.y, fx: n.fx, fy: n.fy }); }

  /* ============================================================ scene */
  const mk = (tag, attrs, parent) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
  const svg = () => $('cm-svg');
  function setView(v) {
    S.view = v;
    svg().setAttribute('viewBox', [v.x, v.y, v.w, v.h].map((x) => x.toFixed(1)).join(' '));
  }
  /* Fit what is shown, leaving room for what floats over the map: the title
   * and goal above, the capsules below, the sheet on the right. */
  function fit() {
    const vis = S.nodes.filter(shown), el = svg();
    if (!vis.length || !el.clientWidth) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of vis) { x0 = Math.min(x0, n.x - 30); y0 = Math.min(y0, n.y - 40); x1 = Math.max(x1, n.x + (n.type === 'hub' ? 110 : 20)); y1 = Math.max(y1, n.y + 20); }
    const W = el.clientWidth, H = el.clientHeight;
    const right = W > 1100 ? 396 : 336, top = 118, bottom = 84, left = 24;
    const s = Math.min((W - left - right) / Math.max(1, x1 - x0), (H - top - bottom) / Math.max(1, y1 - y0), 1.6);
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, vw = W / s, vh = H / s;
    setView({ x: cx - (left + (W - left - right) / 2) / s, y: cy - (top + (H - top - bottom) / 2) / s, w: vw, h: vh });
  }

  function build() {
    const el = svg();
    el.textContent = '';
    const sc = { areas: [], edges: [], nodes: new Map() };
    const gA = mk('g', {}, el), gE = mk('g', {}, el), gN = mk('g', {}, el), gL = mk('g', {}, el);

    for (const d of S.domains) {
      const circle = mk('circle', { class: 'cm-area' + (d.floating ? ' cm-area-float' : '') + (S.goal && S.goal.domains_off.includes(d.id) ? ' cm-area-off' : ''), fill: 'none' }, gA);
      const label = mk('text', { class: 'cm-area-label', 'text-anchor': 'middle' }, gA);
      label.textContent = d.name + (d.floating ? ' · floating' : S.goal && S.goal.domains_off.includes(d.id) ? ' · off' : '');
      sc.areas.push({ d, circle, label });
    }
    for (const e of S.edges) {
      if (!shown(e.a) || !shown(e.b)) continue;
      let cls = null;
      if (e.kind === 'member') cls = 'cm-e-member';
      else if (e.kind === 'cross') { if (hubState(e.a) !== 'active' || hubState(e.b) !== 'active') continue; cls = 'cm-e-cross'; }
      else if (e.kind === 'link') cls = 'cm-e-link cm-hidden';
      else if (e.kind === 'lost') cls = 'cm-e-lost cm-hidden';
      else continue;                                   // a rejected thought's tie to its hub is not drawn
      sc.edges.push({ e, line: mk('line', { class: cls }, gE) });
    }
    for (const n of S.nodes) {
      if (!shown(n)) continue;
      const g = mk('g', { class: 'cm-node', 'data-id': n.id }, gN);
      let label = null;
      if (n.type === 'hub') {
        const st = hubState(n);
        if (st === 'active') {
          mk('circle', { r: 13, class: 'cm-hub-halo' }, g);
          mk('circle', { r: 7.5, class: 'cm-hub' }, g);
        } else mk('circle', { r: 4.5, class: st === 'unsorted' ? 'cm-hub-dormant cm-hub-unsorted' : 'cm-hub-dormant' }, g);
        mk('circle', { r: 17, class: 'cm-sel-ring' }, g);
        label = mk('text', { class: st === 'active' ? 'cm-hub-label' : 'cm-hub-label cm-quiet', x: st === 'active' ? 16 : 10, y: st === 'active' ? 4 : 3.5 }, gL);
        label.textContent = title(n.topic);
        if (st !== 'active') { const c = mk('tspan', { class: 'cm-count' }, label); c.textContent = '  ' + n.n; }
      } else {
        const t = n.t, fl = floating(n.domain);
        if (fl && n.domain === 'rules') mk('rect', { x: -3, y: -3, width: 6, height: 6, transform: 'rotate(45)', class: 'cm-t-rule' }, g);
        else if (fl && t.outcome === 'open') mk('circle', { r: 3.6, class: 'cm-t-open' }, g);
        else if (fl && n.domain === 'stashed') mk('circle', { r: 3.6, class: 'cm-t-stashed' }, g);
        else if (fl) mk('circle', { r: 3, class: 'cm-t-bug' }, g);
        /* An open question placed in a working domain (the plan's, say) is
         * still a hollow ring: open, not accepted. */
        else if (t.outcome === 'open') mk('circle', { r: 3.6, class: 'cm-t-open' }, g);
        else mk('circle', { r: 3.4, class: t.outcome === 'rejected' ? 'cm-t-rejected' : n.topic === UNSORTED ? 'cm-t-unsorted' : 'cm-t' }, g);
        mk('circle', { r: 9, class: 'cm-sel-ring cm-sel-small' }, g);
        mk('circle', { r: 8, class: 'cm-hit' }, g);         // a bigger target than the dot
      }
      sc.nodes.set(n.id, { n, g, label });
    }
    S.scene = sc;
    place();
    focus();
  }

  function place() {
    const sc = S.scene;
    if (!sc) return;
    for (const a of sc.areas) {
      const ns = S.nodes.filter((n) => n.domain === a.d.id && shown(n));
      if (!ns.length) { a.circle.setAttribute('r', 0); a.label.textContent = ''; continue; }
      const cx = ns.reduce((s, n) => s + n.x, 0) / ns.length, cy = ns.reduce((s, n) => s + n.y, 0) / ns.length;
      const r = Math.max(42, ...ns.map((n) => Math.hypot(n.x - cx, n.y - cy) + (n.type === 'hub' ? 26 : 16)));
      a.circle.setAttribute('cx', cx.toFixed(1)); a.circle.setAttribute('cy', cy.toFixed(1)); a.circle.setAttribute('r', r.toFixed(1));
      a.label.setAttribute('x', cx.toFixed(1)); a.label.setAttribute('y', (cy - r - 9).toFixed(1));
    }
    for (const s of sc.edges) {
      const { a, b } = s.e;
      s.line.setAttribute('x1', a.x.toFixed(1)); s.line.setAttribute('y1', a.y.toFixed(1));
      s.line.setAttribute('x2', b.x.toFixed(1)); s.line.setAttribute('y2', b.y.toFixed(1));
    }
    for (const { n, g, label } of sc.nodes.values()) {
      const tr = 'translate(' + n.x.toFixed(1) + ' ' + n.y.toFixed(1) + ')';
      g.setAttribute('transform', tr);
      if (label) label.setAttribute('transform', tr);
    }
  }

  /* What is in focus: a selected topic, a selected or hovered thought. The
   * rest fades, and links show for what is in focus only. */
  function focus() {
    if (!S.scene) return;
    const f = S.hover || S.selThought;
    let near = null;
    if (f) {
      near = new Set([f]);
      for (const x of S.scene.edges) { if (x.e.a.id === f) near.add(x.e.b.id); if (x.e.b.id === f) near.add(x.e.a.id); }
    } else if (S.selTopic) {
      near = new Set(S.nodes.filter((n) => n.topic === S.selTopic).map((n) => n.id));
    }
    for (const { n, g, label } of S.scene.nodes.values()) {
      const off = !!near && !near.has(n.id);
      g.classList.toggle('cm-dim', off);
      if (label) label.classList.toggle('cm-dim', off);
      g.classList.toggle('cm-selected', n.id === S.selThought || (n.type === 'hub' && n.topic === S.selTopic && hubState(n) === 'active'));
    }
    for (const s of S.scene.edges) {
      const { a, b, kind } = s.e;
      const inFocus = f ? (a.id === f || b.id === f) : S.selTopic ? (a.topic === S.selTopic && b.topic === S.selTopic) : false;
      if (kind === 'link' || kind === 'lost') s.line.classList.toggle('cm-hidden', !inFocus);
      s.line.classList.toggle('cm-dim', !!near && !inFocus && !(near.has(a.id) && near.has(b.id)));
    }
    for (const a of S.scene.areas) a.circle.classList.toggle('cm-dim-soft', !!near);
  }

  /* ============================================================ writing */
  /* Optimistic: the switch moves at once; the broker's answer confirms it, or
   * the change is taken back and the reason shown. */
  async function saveGoal(patch, undo) {
    S.error = null;
    try {
      const res = await fetch(S.httpBase + '/api/context/goal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
      const r = await res.json();
      if (!r.ok) throw new Error((r.problems || ['not saved']).join('; '));
      S.goal = { ...r.goal, topics: r.goal.topics.slice(), domains_off: r.goal.domains_off.slice() };
    } catch (err) {
      if (undo) undo();
      S.error = 'Not saved: ' + err.message;
    }
    rebuild();
  }
  function toggleTopic(id) {
    if (!S.goal) return;
    const before = S.goal.topics.slice();
    S.goal.topics = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
    rebuild();
    saveGoal({ topics: S.goal.topics }, () => { S.goal.topics = before; });
  }
  function toggleDomain(id) {
    if (!S.goal) return;
    const before = S.goal.domains_off.slice();
    S.goal.domains_off = before.includes(id) ? before.filter((x) => x !== id) : [...before, id];
    rebuild();
    saveGoal({ domains_off: S.goal.domains_off }, () => { S.goal.domains_off = before; });
  }

  /* ============================================================ the sheet */
  const kindOf = (t) => (t.outcome[0].toUpperCase() + t.outcome.slice(1)) + ' ' + t.kind;
  const sw = (on, attr, key, label, disabled) => '<button type="button" class="cm-switch' + (on ? ' on' : '') + '" ' + attr + '="' + esc(key) + '" aria-pressed="' + on + '" aria-label="' + esc(label) + '"' + (disabled ? ' disabled' : '') + '></button>';
  const chevron = '<svg class="cm-chev" width="8" height="13" viewBox="0 0 8 13" aria-hidden="true"><path d="M1.5 1.5 L6.5 6.5 L1.5 11.5"/></svg>';
  const backIcon = '<svg width="10" height="17" viewBox="0 0 10 17" aria-hidden="true"><path d="M8.5 1.5 L1.8 8.5 L8.5 15.5"/></svg>';
  const tick_ = '<svg width="15" height="12" viewBox="0 0 15 12" aria-hidden="true"><path d="M1.5 6.5 L5.5 10.3 L13.5 1.7"/></svg>';
  const thoughtsIn = (topic) => S.data.thoughts.filter((t) => (t.topic || UNSORTED) === topic);
  const clip = (s, n) => s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
  const dotFor = (t) => '<span class="cm-dot-k ' + (t.outcome === 'rejected' ? 'rej' : t.outcome === 'open' ? 'open' : '') + '"></span>';

  function panel() {
    const p = $('cm-panel');
    if (!p) return;
    const err = S.error ? '<div class="cm-error">' + esc(S.error) + '</div>' : '';
    if (S.editing) { p.innerHTML = goalSheet() + err; wire(p); return; }
    const th = S.selThought && S.tById.get(S.selThought);
    if (th) { p.innerHTML = thoughtSheet(th) + err; wire(p); return; }
    if (S.selTopic) { p.innerHTML = topicSheet(S.selTopic) + err; wire(p); return; }

    const ids = Object.keys(S.topics).sort((a, b) => thoughtsIn(b).length - thoughtsIn(a).length);
    const unsorted = thoughtsIn(UNSORTED).length;
    const working = S.domains.filter((d) => !d.floating);
    p.innerHTML = '<h2 class="cm-large">Overview</h2>' + err
      + '<div><div class="cm-sec">Goal</div><div class="cm-group"><button type="button" class="cm-row cm-row-tap" data-goal-edit>'
      + '<span class="cm-grow"><span class="cm-goal-text">' + esc(S.goal ? S.goal.text : 'No goal set') + '</span><span class="cm-sub">' + (S.goal ? 'Set by ' + esc(S.goal.set_by || 'you') + ' · ' + S.goal.topics.length + ' topic' + (S.goal.topics.length === 1 ? '' : 's') + ' active' : 'Set one to decide what agents read') + '</span></span>' + chevron + '</button></div></div>'
      + (ids.length ? '<div><div class="cm-sec">Topics</div><div class="cm-group">' + ids.map((k) => '<div class="cm-row"><button type="button" class="cm-grow cm-link-btn" data-topic-open="' + esc(k) + '">' + esc(title(k)) + '</button><span class="cm-n">' + thoughtsIn(k).length + '</span>' + sw(!!S.goal && S.goal.topics.includes(k), 'data-topic', k, title(k), !S.goal) + '</div>').join('') + '</div>'
        + '<div class="cm-foot">What is active is what agents read. Rules, bugs &amp; open questions and stashed ideas float until an agent uses them.</div></div>' : '')
      + (unsorted ? '<div class="cm-foot">' + unsorted + ' waiting thought' + (unsorted === 1 ? ' has' : 's have') + ' no topic yet' + (ids.length ? '' : ' - this repository has not been grouped') + '. Agents do not read them by default.</div>' : '')
      + '<div><div class="cm-sec">Domains</div><div class="cm-group">' + working.map((d) => '<div class="cm-row"><span class="cm-grow">' + esc(d.name) + '</span><span class="cm-n">' + S.data.thoughts.filter((t) => t.domain === d.id).length + '</span>' + sw(!(S.goal && S.goal.domains_off.includes(d.id)), 'data-domain', d.id, d.name, !S.goal) + '</div>').join('') + '</div></div>';
    wire(p);
  }

  function topicSheet(topic) {
    const list = thoughtsIn(topic), on = !!S.goal && S.goal.topics.includes(topic);
    const read = list.filter((t) => topicActive(topic, t.domain));
    const tp = S.topics[topic];
    const order = ['planning', 'discussion', 'information', 'goals', 'constraints', 'criteria', 'questions', 'rules', 'stashed'];
    return '<button type="button" class="cm-back" data-back>' + backIcon + 'Overview</button>'
      + '<h2 class="cm-large">' + esc(title(topic)) + '</h2>'
      + (topic === UNSORTED ? '<div class="cm-foot">Thoughts with no topic. A topic is given when a grouping is applied, and - soon - when a thought is recorded.</div>'
        : '<div class="cm-group"><div class="cm-row"><span class="cm-grow"><span>Active</span><span class="cm-sub">' + (on ? 'Agents read ' + read.length + ' thought' + (read.length === 1 ? '' : 's') + ' · ~' + read.reduce((s, t) => s + tokensOf(t), 0).toLocaleString() + ' tokens' : 'Kept, and hidden from agents unless asked') + '</span></span>' + sw(on, 'data-topic', topic, title(topic), !S.goal) + '</div></div>')
      + (tp && (tp.digest || tp.waiting_for) ? '<div class="cm-group cm-pad">' + (tp.digest ? '<div>' + esc(tp.digest) + '</div>' : '') + (tp.waiting_for ? '<div class="cm-sub">Waiting for: ' + esc(tp.waiting_for) + '</div>' : '') + '</div>' : '')
      + order.map((d) => ({ d, items: list.filter((t) => t.domain === d) })).filter((g) => g.items.length).map((g) =>
        '<div><div class="cm-sec">' + esc(S.dom[g.d].name) + ' · ' + g.items.length + '</div><div class="cm-group">'
        + g.items.map((t) => '<button type="button" class="cm-row cm-row-tap cm-row-text" data-thought="' + esc(t.id) + '">' + dotFor(t) + '<span class="cm-grow">' + esc(clip(t.text, 120)) + '</span></button>').join('')
        + '</div></div>').join('');
  }

  function thoughtSheet(t) {
    const out = (t.links || []).filter((l) => S.tById.has(l.to)).map((l) => ({ rel: l.type, u: S.tById.get(l.to) }));
    const inn = S.data.thoughts.filter((x) => (x.links || []).some((l) => l.to === t.id)).map((x) => ({ rel: 'from · ' + (x.links.find((l) => l.to === t.id) || {}).type, u: x }));
    return '<button type="button" class="cm-back" data-back-topic>' + backIcon + esc(S.selTopic ? title(S.selTopic) : 'Overview') + '</button>'
      + '<div class="cm-tags"><span>' + esc(S.dom[t.domain].name) + '</span><span>' + esc(title(t.topic || UNSORTED)) + '</span><span>' + esc(kindOf(t)) + (t.decided_by ? ' · ' + esc(t.decided_by) : '') + '</span></div>'
      + '<div class="cm-text">' + esc(t.text) + '</div>'
      + (floating(t.domain) ? '<div class="cm-foot">Floating - no agent has used it yet.</div>' : '')
      + ((t.forces || []).length ? '<div><div class="cm-sec">Forces</div><div class="cm-group">' + t.forces.map((f) => '<div class="cm-row cm-row-text"><span class="cm-force ' + f.direction + '">' + (f.direction === 'forward' ? 'For' : 'Against') + '</span><span class="cm-grow">' + esc(f.text) + '</span></div>').join('') + '</div></div>' : '')
      + (out.length + inn.length ? '<div><div class="cm-sec">Links</div><div class="cm-group">' + out.concat(inn).map((x) => '<button type="button" class="cm-row cm-row-tap cm-row-text" data-thought="' + esc(x.u.id) + '"><span class="cm-grow"><span class="cm-sub cm-upper">' + esc(x.rel) + '</span>' + esc(clip(x.u.text, 110)) + '</span>' + chevron + '</button>').join('') + '</div></div>' : '')
      + '<div class="cm-mono">' + esc(t.id) + ' · ~' + tokensOf(t) + ' tokens</div>';
  }

  /* The goal, edited in a sheet: new words, GitX's suggested topics for them
   * as checkmark rows, saved together. The map previews the choice. */
  function goalSheet() {
    const e = S.editing;
    return '<div class="cm-navbar"><button type="button" class="cm-plain" data-goal-cancel>Cancel</button><span>Goal</span><button type="button" class="cm-save" data-goal-save>Save</button></div>'
      + '<div><label class="cm-sec" for="cm-goal-input">What are you working toward?</label><div class="cm-group cm-pad"><input id="cm-goal-input" class="cm-input" data-goal-input maxlength="200" value="' + esc(e.text) + '" placeholder="A goal in your words"></div></div>'
      + '<div><div class="cm-sec">' + (e.loading ? 'Finding the topics it points at…' : 'GitX suggests') + '</div><div class="cm-group">'
      + (e.ranked || []).map((r) => '<button type="button" class="cm-row cm-row-tap" data-goal-topic="' + esc(r.id) + '" aria-pressed="' + e.chosen.includes(r.id) + '"><span class="cm-grow"><span>' + esc(r.title) + '</span><span class="cm-sub">' + (r.matched && r.matched.length ? 'Matches ' + esc(r.matched.join(', ')) : 'No words matched') + '</span></span><span class="cm-check">' + (e.chosen.includes(r.id) ? tick_ : '') + '</span></button>').join('')
      + '</div><div class="cm-foot">GitX ranks topics by your words and recent work, and ticks the best. You decide.</div></div>';
  }

  let suggestTimer = 0;
  async function suggest(text) {
    const e = S.editing;
    if (!e) return;
    e.loading = true;
    try {
      const res = await fetch(S.httpBase + '/api/context/suggest?text=' + encodeURIComponent(text), { cache: 'no-store' });
      const r = await res.json();
      if (S.editing !== e || e.text !== text) return;
      e.ranked = r.ranked || [];
      if (!e.touched) e.chosen = (r.suggested || []).slice();
    } catch (_) { /* suggestions are a help, not a requirement */ }
    e.loading = false;
    rebuild();
    const input = document.querySelector('[data-goal-input]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }

  function startEditing() {
    S.selTopic = null; S.selThought = null;
    S.editing = { text: S.goal ? S.goal.text : '', chosen: S.goal ? S.goal.topics.slice() : [], ranked: Object.values(S.topics).map((t) => ({ id: t.id, title: t.title, score: 0, matched: [] })), touched: true };
    rebuild();
    if (S.editing.text) suggest(S.editing.text);
  }

  function wire(p) {
    p.querySelectorAll('[data-topic]').forEach((b) => b.onclick = () => toggleTopic(b.dataset.topic));
    p.querySelectorAll('[data-domain]').forEach((b) => b.onclick = () => toggleDomain(b.dataset.domain));
    p.querySelectorAll('[data-topic-open]').forEach((b) => b.onclick = () => selectTopic(b.dataset.topicOpen));
    p.querySelectorAll('[data-thought]').forEach((b) => b.onclick = () => selectThought(b.dataset.thought));
    p.querySelectorAll('[data-back]').forEach((b) => b.onclick = () => { S.selTopic = null; S.selThought = null; panel(); focus(); });
    p.querySelectorAll('[data-back-topic]').forEach((b) => b.onclick = () => { S.selThought = null; panel(); focus(); });
    const edit = p.querySelector('[data-goal-edit]');
    if (edit) edit.onclick = startEditing;
    const input = p.querySelector('[data-goal-input]');
    if (input) input.oninput = () => {
      S.editing.text = input.value;
      S.editing.touched = false;
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => suggest(input.value), 300);
    };
    p.querySelectorAll('[data-goal-topic]').forEach((b) => b.onclick = () => {
      const e = S.editing, id = b.dataset.goalTopic;
      e.touched = true;
      e.chosen = e.chosen.includes(id) ? e.chosen.filter((x) => x !== id) : [...e.chosen, id];
      rebuild();
    });
    const cancel = p.querySelector('[data-goal-cancel]');
    if (cancel) cancel.onclick = () => { S.editing = null; rebuild(); };
    const save = p.querySelector('[data-goal-save]');
    if (save) save.onclick = () => {
      const e = S.editing;
      const before = S.goal ? { ...S.goal } : null;
      S.goal = { ...(S.goal || { domains_off: [] }), text: e.text.trim(), topics: e.chosen.slice(), domains_off: (S.goal ? S.goal.domains_off : []).slice(), set_by: 'user' };
      S.editing = null;
      rebuild();
      saveGoal({ text: e.text, topics: e.chosen }, () => { S.goal = before; });
    };
  }

  /* The chrome over the map: title, goal capsule, monitor. */
  function chrome() {
    const reads = S.data.thoughts.filter((t) => !floating(t.domain) && topicActive(t.topic || UNSORTED, t.domain));
    const tk = reads.reduce((s, t) => s + tokensOf(t), 0);
    const fl = S.data.thoughts.filter((t) => floating(t.domain)).length;
    const unsorted = S.data.thoughts.filter((t) => !t.topic).length;
    const folded = S.data.thoughts.filter((t) => !floating(t.domain) && t.topic && !topicActive(t.topic, t.domain)).length;
    const b = (n) => '<b>' + n.toLocaleString() + '</b>';
    $('cm-monitor').innerHTML = '<span class="cm-reads">Agents ' + (S.editing ? 'would read' : 'read') + ' ' + b(reads.length) + ' thought' + (reads.length === 1 ? '' : 's') + ' · ~' + tk.toLocaleString() + ' tokens</span><span class="cm-sep"></span>'
      + (S.editing ? '<span>Not saved yet</span>' : '<span>Waiting ' + b(S.data.thoughts.length) + '</span><span class="cm-opt">Floating ' + b(fl) + '</span><span class="cm-opt">Folded ' + b(folded) + '</span>' + (unsorted ? '<span>Unsorted ' + b(unsorted) + '</span>' : ''));
    const text = S.editing ? (S.editing.text || 'A new goal') : S.goal ? S.goal.text : 'No goal set';
    $('cm-goal').innerHTML = '<span class="cm-goal-cap"><small>Goal</small><b>' + esc(text) + '</b></span>' + (S.editing ? '<span class="cm-preview">Preview</span>' : '') + chevron;
    $('cm-sub').textContent = (S.repo || 'This repository') + ' · ' + S.data.thoughts.length + ' waiting';
  }

  /* ============================================================ render */
  function render() {
    if (!$('cm-stage')) return;
    const empty = $('cm-empty');
    if (!S.data || S.data.missing) {
      empty.hidden = false;
      empty.textContent = !S.data ? 'Reading the context graph…' : 'This broker sends no context map. Restart the GitX broker to pick up the new code.';
      return;
    }
    empty.hidden = true;
    if (S.dirty) {
      graph();
      settle(S.pos.size ? 0.4 : 1, S.pos.size ? 160 : 380);
      S.dirty = false;
      build();
      if (!S.view) fit(); else setView(S.view);
    }
    panel();
    chrome();
  }
  function rebuild() { settle(0.45, 120); build(); panel(); chrome(); }
  function selectTopic(topic) { S.selTopic = topic; S.selThought = null; S.editing = null; panel(); focus(); chrome(); }
  function selectThought(id) {
    const n = S.byId.get(id);
    if (!n) return;
    S.selThought = id;
    if (!S.selTopic || n.topic !== S.selTopic) S.selTopic = n.topic;
    S.editing = null;
    panel(); focus(); chrome();
  }

  /* ============================================================ input */
  const nodeAt = (t) => { const g = t && t.closest && t.closest('.cm-node'); return g ? S.byId.get(g.dataset.id) : null; };
  function toWorld(cx, cy) {
    const el = svg(), r = el.getBoundingClientRect(), v = S.view, s = Math.max(v.w / r.width, v.h / r.height);
    return [v.x + (cx - r.left - (r.width - v.w / s) / 2) * s, v.y + (cy - r.top - (r.height - v.h / s) / 2) * s];
  }
  let drag = null, moved = false, running = false;
  function run() {
    if (running) return;
    running = true;
    const step = () => { tick(); place(); if (S.alpha > 0.02 || drag) requestAnimationFrame(step); else { running = false; remember(); } };
    requestAnimationFrame(step);
  }
  function zoomBy(f, cx, cy) {
    const v = S.view, x = cx != null ? cx : v.x + v.w / 2, y = cy != null ? cy : v.y + v.h / 2;
    setView({ x: x - (x - v.x) * f, y: y - (y - v.y) * f, w: v.w * f, h: v.h * f });
  }
  function init(opts) {
    S.httpBase = opts.httpBase || '';
    const el = svg(), tip = $('cm-tip');
    if (!el) return;
    el.addEventListener('pointerdown', (e) => {
      const n = nodeAt(e.target);
      try { el.setPointerCapture(e.pointerId); } catch (_) { /* no live pointer to capture */ }
      moved = false;
      drag = n ? { node: n, x: e.clientX, y: e.clientY } : { pan: true, x: e.clientX, y: e.clientY, v: { ...S.view } };
    });
    el.addEventListener('pointermove', (e) => {
      if (drag) {
        if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) moved = true;
        if (!moved) return;
        tip.hidden = true;
        if (drag.pan) {
          const s = S.view.w / el.clientWidth;
          el.classList.add('cm-panning');
          setView({ ...drag.v, x: drag.v.x - (e.clientX - drag.x) * s, y: drag.v.y - (e.clientY - drag.y) * s });
        } else {
          /* A dragged node stays where it is put. */
          const [x, y] = toWorld(e.clientX, e.clientY);
          drag.node.fx = x; drag.node.fy = y;
          S.alpha = Math.max(S.alpha, 0.25);
          run();
        }
        return;
      }
      const n = nodeAt(e.target), id = n && n.type === 'thought' ? n.id : null;
      if (id !== S.hover) { S.hover = id; focus(); }
      if (!n) { tip.hidden = true; return; }
      tip.innerHTML = n.type === 'thought' ? '<div class="cm-meta">' + esc(S.dom[n.domain].name) + ' · ' + esc(kindOf(n.t)) + '</div>' + esc(clip(n.t.text, 180))
        : '<div class="cm-meta">' + esc(S.dom[n.domain].name) + ' · ' + hubState(n) + '</div>' + esc(title(n.topic)) + ' · ' + n.n + ' thought' + (n.n === 1 ? '' : 's');
      const r = $('cm-stage').getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX - r.left + 16, r.width - 320) + 'px';
      tip.style.top = (e.clientY - r.top + 16) + 'px';
    });
    el.addEventListener('pointerup', (e) => {
      const was = drag; drag = null; el.classList.remove('cm-panning');
      if (!moved) {
        const n = nodeAt(e.target);
        if (!n) { S.selTopic = null; S.selThought = null; if (!S.editing) { panel(); focus(); } }
        else if (n.type === 'hub') selectTopic(n.topic);
        else selectThought(n.id);
      } else if (was && was.node) run();
    });
    el.addEventListener('pointerleave', () => { tip.hidden = true; if (S.hover && !drag) { S.hover = null; focus(); } });
    el.addEventListener('wheel', (e) => { if (!S.view) return; e.preventDefault(); const [x, y] = toWorld(e.clientX, e.clientY); zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12, x, y); }, { passive: false });
    $('cm-zin').onclick = () => zoomBy(1 / 1.25);
    $('cm-zout').onclick = () => zoomBy(1.25);
    $('cm-zfit').onclick = fit;
    $('cm-goal').onclick = () => { if (S.data && !S.data.missing && !S.editing) startEditing(); };
    addEventListener('keydown', (e) => {
      if (!S.visible || e.key !== 'Escape') return;
      if (S.editing) { S.editing = null; rebuild(); }
      else if (S.selThought) { S.selThought = null; panel(); focus(); }
      else if (S.selTopic) { S.selTopic = null; panel(); focus(); }
    });
    addEventListener('resize', () => { if (S.visible && S.scene) fit(); });
  }

  /* Shown and hidden by GitX's sidebar. Measured only while shown: a hidden
   * view is zero pixels wide and would fit the map to nothing. */
  function show() {
    S.visible = true;
    const first = !S.view;
    render();
    if (first && S.scene) fit();
  }
  function hide() { S.visible = false; }

  window.ContextMap = { init, onData, show, hide };
})();
