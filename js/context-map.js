/* GitX - the Context Map: the context graph drawn as a network, and the goal
 * that decides which part of it agents read. docs/context-map-plan.md, step 3.
 *
 * Drawn like the Neo4j browser (the owner's reference): labelled circles,
 * edges with arrows that carry their relationship's name, nodes that can be
 * dragged and stay where they are put. Its controls float over it as glass.
 *
 *   Domain   a kind of content; each has an area and a colour
 *   Topic    a hub in every domain holding its thoughts; the same topic's hubs
 *            are joined across domains
 *   Thought  a grey circle whose ring is its outcome
 *
 * Rules, Bugs & open questions and Stashed float: unconnected until used.
 * A topic is active when the goal names it and its domain is not switched off;
 * the active part is what agents read. A dormant topic is folded to its hub.
 *
 * Data is the broker's /api/thoughts payload, which graph-view.js already
 * fetches and hands over (onData). Changes go to /api/context/goal; the
 * broker writes goal.json, the watcher records it, and the new payload
 * arrives the same way as any other. */
(() => {
  const NS = 'http://www.w3.org/2000/svg';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  /* Each domain's colour is a theme token (gitx.css): pastel on dark, vivid
   * on light, where pastel washes out against a pale ground. */
  const COLOUR = Object.fromEntries(['goals', 'discussion', 'information', 'constraints', 'criteria', 'rules', 'questions', 'stashed'].map((d) => [d, 'var(--cm-d-' + d + ')']));
  /* Where each domain settles; floating ones at the edges. World units. */
  const ANCHOR = {
    goals: [520, 240], discussion: [900, 700], information: [1560, 640], constraints: [1240, 1180],
    criteria: [520, 1130], stashed: [1180, 200], rules: [1780, 230], questions: [1840, 1160]
  };
  const UNSORTED = 'unsorted';

  const S = {
    httpBase: '', visible: false, dirty: true,
    data: null, domains: [], dom: {}, topics: {}, goal: null,
    nodes: [], byId: new Map(), edges: [], tById: new Map(),
    sel: null, hover: null, view: null, alpha: 0, scene: null,
    pos: new Map(),            // id -> {x, y, fx, fy}, kept across refreshes
    editing: null, error: null
  };

  const floating = (d) => !!(S.dom[d] && S.dom[d].floating);
  const hubId = (topic, domain) => 'h:' + topic + ':' + domain;
  const tokensOf = (t) => Math.round((String(t.text || '').length + (t.forces || []).reduce((n, f) => n + String(f.text || '').length, 0)) / 4);
  const topicActive = (topic, domain) => !!S.goal && topic !== UNSORTED && S.goal.topics.includes(topic) && !S.goal.domains_off.includes(domain) && !floating(domain);
  const hubState = (n) => n.topic === UNSORTED ? 'unsorted' : topicActive(n.topic, n.domain) ? 'active' : 'dormant';
  const shown = (n) => n.type !== 'thought' || floating(n.domain) || n.topic === UNSORTED || topicActive(n.topic, n.domain);

  /* ============================================================ data */
  function onData(payload) {
    const ctx = payload && payload.context;
    if (!ctx || !ctx.map) { S.data = { missing: true }; S.dirty = true; if (S.visible) render(); return; }
    S.data = ctx;
    S.domains = ctx.map.domains.map((d) => ({ ...d, colour: COLOUR[d.id] || '#999' }));
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
      const [ax, ay] = ANCHOR[n.domain] || [1000, 700];
      Object.assign(n, was ? { x: was.x, y: was.y, fx: was.fx, fy: was.fy } : { x: ax + (Math.random() - 0.5) * 300, y: ay + (Math.random() - 0.5) * 300 }, { vx: 0, vy: 0 });
      nodes.push(n); byId.set(n.id, n);
    };
    if (S.goal) add({ id: 'goal', type: 'goal', domain: 'goals', r: 38, label: S.goal.text });
    const count = new Map();
    for (const t of T) if (!floating(t.domain)) count.set(hubId(t.topic, t.domain), (count.get(hubId(t.topic, t.domain)) || 0) + 1);
    for (const [h, n] of count) {
      const [, topic, domain] = h.split(':');
      add({ id: h, type: 'hub', topic, domain, n, r: Math.min(40, 24 + 2.6 * Math.sqrt(n)), label: topic === UNSORTED ? 'Unsorted' : (S.topics[topic] ? S.topics[topic].title : topic) });
    }
    for (const t of T) add({ id: t.id, type: 'thought', t, topic: t.topic, domain: t.domain, r: 17 });

    const edges = [];
    const edge = (a, b, rel, kind, len, k) => { if (byId.get(a) && byId.get(b)) edges.push({ a: byId.get(a), b: byId.get(b), rel, kind, len, k }); };
    for (const t of T) if (!floating(t.domain)) edge(t.id, hubId(t.topic, t.domain), 'IN', t.outcome === 'rejected' ? 'member-rejected' : 'member', 95, 0.07);
    const byTopic = {};
    for (const n of nodes) if (n.type === 'hub' && n.topic !== UNSORTED) (byTopic[n.topic] = byTopic[n.topic] || []).push(n);
    for (const list of Object.values(byTopic)) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) edge(list[i].id, list[j].id, 'SAME_TOPIC', 'cross', 330, 0.012);
    const pairs = new Set();
    const linksOf = (t) => [...(t.links || []).map((l) => ({ type: l.type, to: l.to })), ...(t.forces || []).flatMap((f) => f.cites || []).map((c) => ({ type: 'cites', to: c }))];
    for (const t of T) for (const l of linksOf(t)) {
      const u = S.tById.get(l.to);
      if (!u || floating(t.domain) || floating(u.domain) || t.topic === u.topic || t.domain !== u.domain || t.topic === UNSORTED || u.topic === UNSORTED) continue;
      const a = hubId(t.topic, t.domain), b = hubId(u.topic, u.domain), key = [a, b].sort().join('|');
      if (pairs.has(key)) continue;
      pairs.add(key);
      edge(a, b, 'RELATES_TO', 'domain', 240, 0.012);
    }
    for (const n of nodes) if (n.type === 'hub' && n.domain === 'goals' && n.topic !== UNSORTED) edge('goal', n.id, 'REQUIRES', 'goal', 150, 0.04);
    for (const t of T) for (const l of linksOf(t)) if (S.tById.has(l.to)) {
      const fl = floating(t.domain) || floating(S.tById.get(l.to).domain);
      edge(t.id, l.to, l.type.toUpperCase().replace(/-/g, '_'), l.type === 'lost-to' ? 'lost' : fl ? 'float-link' : 'link', 150, fl ? 0 : 0.012);
    }
    S.nodes = nodes; S.byId = byId; S.edges = edges;
  }

  /* ============================================================ layout */
  const pull = (n) => n.type === 'goal' ? 0.05 : n.type === 'hub' ? 0.02 : floating(n.domain) ? 0.03 : 0.004;
  function tick() {
    const act = S.nodes.filter(shown), a = S.alpha;
    for (let i = 0; i < act.length; i++) {
      const p = act[i];
      for (let j = i + 1; j < act.length; j++) {
        const q = act[j];
        let dx = p.x - q.x, dy = p.y - q.y;
        const d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        let f = 5200 / d2 * a;
        const min = p.r + q.r + 10;
        if (d < min) f += (min - d) * 0.35;
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
      const [x, y] = ANCHOR[n.domain] || [1000, 700], k = pull(n) * a;
      n.vx += (x - n.x) * k; n.vy += (y - n.y) * k;
      if (n.fx != null) { n.x = n.fx; n.y = n.fy; n.vx = n.vy = 0; continue; }
      n.vx *= 0.6; n.vy *= 0.6;
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
    const el = svg();
    el.setAttribute('viewBox', [v.x, v.y, v.w, v.h].map((x) => x.toFixed(1)).join(' '));
    el.classList.toggle('cm-far', el.clientWidth / v.w < 0.55);
  }
  function fit() {
    const vis = S.nodes.filter(shown), el = svg();
    if (!vis.length || !el.clientWidth) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of vis) { x0 = Math.min(x0, n.x - n.r); y0 = Math.min(y0, n.y - n.r); x1 = Math.max(x1, n.x + n.r); y1 = Math.max(y1, n.y + n.r); }
    const W = el.clientWidth, H = el.clientHeight;
    /* Leave room for what floats over the map: the inspector, the bars. */
    const right = W > 1100 ? 352 : 306, top = 76, bottom = 70, left = 16;
    const s = Math.min((W - left - right) / Math.max(1, x1 - x0), (H - top - bottom) / Math.max(1, y1 - y0));
    setView({ x: x0 - left / s, y: y0 - top / s, w: W / s, h: H / s });
  }

  function hull(pts) {
    const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
    const lo = [], up = [];
    for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
    for (const q of p.reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
    return lo.slice(0, -1).concat(up.slice(0, -1));
  }
  function blob(ns, pad) {
    const pts = [];
    for (const n of ns) for (let a = 0; a < 10; a++) pts.push([n.x + Math.cos(a * Math.PI / 5) * (n.r + pad), n.y + Math.sin(a * Math.PI / 5) * (n.r + pad)]);
    const h = hull(pts);
    if (h.length < 3) return '';
    let d = 'M' + h[0][0].toFixed(1) + ' ' + h[0][1].toFixed(1);
    for (let i = 0; i < h.length; i++) {
      const p0 = h[(i - 1 + h.length) % h.length], p1 = h[i], p2 = h[(i + 1) % h.length], p3 = h[(i + 2) % h.length];
      d += ' C' + (p1[0] + (p2[0] - p0[0]) / 6).toFixed(1) + ' ' + (p1[1] + (p2[1] - p0[1]) / 6).toFixed(1) + ' ' + (p2[0] - (p3[0] - p1[0]) / 6).toFixed(1) + ' ' + (p2[1] - (p3[1] - p1[1]) / 6).toFixed(1) + ' ' + p2[0].toFixed(1) + ' ' + p2[1].toFixed(1);
    }
    return d + 'Z';
  }
  /* Two lines inside a circle, the way Neo4j captions a node. */
  function caption(text, max) {
    const words = String(text).replace(/[`'"]/g, '').split(/\s+/);
    const lines = [''];
    for (const w of words) {
      const cur = lines[lines.length - 1];
      if ((cur + ' ' + w).trim().length <= max) lines[lines.length - 1] = (cur + ' ' + w).trim();
      else if (lines.length < 2) lines.push(w.length > max ? w.slice(0, max - 1) + '…' : w);
      else { lines[1] = (lines[1].length > max - 1 ? lines[1].slice(0, max - 1) : lines[1]) + '…'; break; }
    }
    if (lines[0].length > max) lines[0] = lines[0].slice(0, max - 1) + '…';
    return lines.filter(Boolean);
  }

  function build() {
    const el = svg();
    el.textContent = '';
    const sc = { areas: [], edges: [], nodes: new Map() };
    const defs = mk('defs', {}, el);
    const arrow = (id, c) => { const m = mk('marker', { id, viewBox: '0 0 10 10', refX: 10, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs); mk('path', { d: 'M0 1 L10 5 L0 9 Z', fill: c }, m); };
    arrow('cm-ar-edge', 'var(--cm-edge)'); arrow('cm-ar-link', 'var(--cm-link)'); arrow('cm-ar-lost', 'var(--cm-rejected)');
    const gA = mk('g', {}, el), gE = mk('g', {}, el), gL = mk('g', {}, el), gN = mk('g', {}, el);

    for (const d of S.domains) {
      const on = d.floating || !(S.goal && S.goal.domains_off.includes(d.id)), c = on ? d.colour : 'var(--cm-ink-3)';
      /* How strongly an area is tinted is the theme's to say (gitx.css). */
      const path = mk('path', { fill: c, stroke: c, 'stroke-width': 1.4, 'stroke-dasharray': d.floating ? '6 6' : '', class: 'cm-area' + (d.floating ? ' cm-area-float' : '') }, gA);
      const label = mk('text', { 'text-anchor': 'middle', fill: c, 'font-size': 17, class: 'cm-area-label' }, gA);
      label.textContent = d.name + (d.floating ? ' · floating' : on ? '' : ' · off');
      sc.areas.push({ d, path, label });
    }
    for (const e of S.edges) {
      if (!shown(e.a) || !shown(e.b)) continue;
      const lit = (x) => x.type !== 'hub' || hubState(x) === 'active';
      if ((e.kind === 'cross' || e.kind === 'domain' || e.kind === 'goal') && !(lit(e.a) && lit(e.b))) continue;
      const hide = e.kind === 'lost' || e.kind === 'float-link' || e.kind === 'member-rejected';
      const colour = e.kind === 'link' || e.kind === 'float-link' ? 'var(--cm-link)' : e.kind === 'lost' ? 'var(--cm-rejected)'
        : e.kind === 'cross' ? S.dom[e.b.domain === 'discussion' ? e.a.domain : e.b.domain].colour : 'var(--cm-edge)';
      const heavy = e.kind === 'cross' || e.kind === 'domain' || e.kind === 'goal';
      const line = mk('line', {
        stroke: colour, 'stroke-width': heavy ? 2.4 : e.kind === 'member' ? 1 : 1.3, 'stroke-opacity': heavy ? 0.75 : 0.9,
        'stroke-dasharray': e.kind === 'lost' ? '5 4' : '',
        'marker-end': e.kind === 'lost' ? 'url(#cm-ar-lost)' : e.kind === 'link' || e.kind === 'float-link' ? 'url(#cm-ar-link)' : 'url(#cm-ar-edge)',
        class: hide ? 'cm-hidden' : ''
      }, gE);
      const label = mk('text', { class: 'cm-e-label' + (hide ? ' cm-hidden' : ''), 'text-anchor': 'middle', dy: -3 }, gL);
      label.textContent = e.rel;
      sc.edges.push({ e, line, label, hide });
    }
    for (const n of S.nodes) {
      if (!shown(n)) continue;
      const g = mk('g', { class: 'cm-node', 'data-id': n.id }, gN);
      let fill, ring = null, ringW = 0, dash = '', ink = '#fff', lines, fs = 9.5, r = n.r;
      if (n.type === 'goal') { fill = S.dom.goals.colour; ring = 'color-mix(in srgb, var(--cm-d-goals) 35%, transparent)'; ringW = 7; lines = caption(n.label, 12); fs = 11; }
      else if (n.type === 'hub') {
        const st = hubState(n);
        fill = st === 'active' ? S.dom[n.domain].colour : 'var(--cm-ink-3)';
        if (st === 'unsorted') { fill = 'var(--cm-bg)'; ring = 'var(--cm-ink-3)'; ringW = 2; dash = '4 3'; ink = 'var(--cm-ink-2)'; }
        if (st === 'dormant') r = n.r * 0.72;
        lines = caption(n.label, 11); fs = 10;
      } else {
        const t = n.t, fl = floating(n.domain);
        lines = caption(t.text, 9); fs = 8;
        if (fl && t.outcome === 'open') { fill = 'var(--cm-bg)'; ring = S.dom.questions.colour; ringW = 2.2; ink = 'var(--cm-ink)'; }
        else if (fl && n.domain === 'questions') fill = S.dom.questions.colour;
        else if (fl && n.domain === 'stashed') { fill = 'var(--cm-bg)'; ring = S.dom.stashed.colour; ringW = 2; dash = '3 3'; ink = 'var(--cm-ink)'; }
        else if (fl && n.domain === 'rules') fill = S.dom.rules.colour;
        else if (t.outcome === 'rejected') { fill = 'var(--cm-rejected-fill)'; ring = 'var(--cm-rejected)'; ringW = 2.4; }
        else { fill = 'var(--cm-thought)'; ring = 'var(--cm-accepted)'; ringW = 2.4; }
      }
      if (ring) mk('circle', { r: r + (n.type === 'goal' ? 4 : 0), fill: 'none', stroke: ring, 'stroke-width': ringW, 'stroke-dasharray': dash }, g);
      mk('circle', { r: n.type === 'thought' && ring ? r - ringW / 2 : r, fill }, g);
      const sel = mk('circle', { r: r + 5, fill: 'none', stroke: 'var(--accent)', 'stroke-width': 2.5, opacity: 0 }, g);
      const lh = fs * 1.15;
      const onFill = ink === '#fff';            // white text on a filled circle takes a dark halo
      lines.forEach((ln, i) => { const tx = mk('text', { y: (i - (lines.length - 1) / 2) * lh + fs * 0.35, 'text-anchor': 'middle', fill: ink, 'font-size': fs, class: 'cm-n-label' + (onFill ? ' cm-on-fill' : '') }, g); tx.textContent = ln; });
      sc.nodes.set(n.id, { n, g, sel });
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
      if (!ns.length) { a.path.setAttribute('d', ''); a.label.setAttribute('opacity', 0); continue; }
      a.label.setAttribute('opacity', 0.9);
      a.path.setAttribute('d', blob(ns, a.d.floating ? 18 : 28));
      const top = ns.reduce((m, n) => n.y - n.r < m.y - m.r ? n : m, ns[0]);
      a.label.setAttribute('x', (ns.reduce((s, n) => s + n.x, 0) / ns.length).toFixed(1));
      a.label.setAttribute('y', (top.y - top.r - 40).toFixed(1));
    }
    for (const s of sc.edges) {
      const { a, b } = s.e;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1;
      const x1 = a.x + dx / d * a.r, y1 = a.y + dy / d * a.r, x2 = b.x - dx / d * (b.r + 3), y2 = b.y - dy / d * (b.r + 3);
      s.line.setAttribute('x1', x1.toFixed(1)); s.line.setAttribute('y1', y1.toFixed(1)); s.line.setAttribute('x2', x2.toFixed(1)); s.line.setAttribute('y2', y2.toFixed(1));
      let ang = Math.atan2(dy, dx) * 180 / Math.PI;
      if (ang > 90) ang -= 180; if (ang < -90) ang += 180;
      s.label.setAttribute('transform', 'translate(' + ((x1 + x2) / 2).toFixed(1) + ' ' + ((y1 + y2) / 2).toFixed(1) + ') rotate(' + ang.toFixed(1) + ')');
    }
    for (const { n, g } of sc.nodes.values()) g.setAttribute('transform', 'translate(' + n.x.toFixed(1) + ' ' + n.y.toFixed(1) + ')');
  }

  function around(id) {
    const s = new Set([id]);
    for (const x of S.scene.edges) { if (x.e.a.id === id) s.add(x.e.b.id); if (x.e.b.id === id) s.add(x.e.a.id); }
    return s;
  }
  function focus() {
    if (!S.scene) return;
    const f = S.hover || S.sel, near = f ? around(f) : null;
    for (const { n, g, sel } of S.scene.nodes.values()) {
      g.classList.toggle('cm-dim', !!near && !near.has(n.id));
      sel.setAttribute('opacity', S.sel === n.id ? 1 : 0);
    }
    for (const s of S.scene.edges) {
      const touches = f && (s.e.a.id === f || s.e.b.id === f);
      const hidden = s.hide && !touches;
      s.line.classList.toggle('cm-hidden', hidden); s.label.classList.toggle('cm-hidden', hidden);
      s.line.classList.toggle('cm-dim', !!near && !touches); s.label.classList.toggle('cm-dim', !!near && !touches);
    }
    for (const a of S.scene.areas) a.path.classList.toggle('cm-dim', !!near);
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

  /* ============================================================ panels */
  const kindOf = (t) => (t.outcome[0].toUpperCase() + t.outcome.slice(1)) + ' ' + t.kind;
  const sw = (on, attr, key, disabled) => '<button type="button" class="cm-switch' + (on ? ' on' : '') + '" ' + attr + '="' + esc(key) + '" aria-pressed="' + on + '"' + (disabled ? ' disabled' : '') + '></button>';
  const thoughtsIn = (topic) => S.data.thoughts.filter((t) => (t.topic || UNSORTED) === topic);

  function panel() {
    const p = $('cm-panel');
    if (!p) return;
    const n = S.sel && S.byId.get(S.sel);
    const err = S.error ? '<div class="cm-error">' + esc(S.error) + '</div>' : '';
    if (!n) {
      const ids = Object.keys(S.topics).sort((a, b) => thoughtsIn(b).length - thoughtsIn(a).length);
      const unsorted = thoughtsIn(UNSORTED).length;
      p.innerHTML = '<div><h2>Overview</h2><div class="cm-sub">The goal decides what is active. What is active is what agents read.</div></div>' + err
        + '<div><div class="cm-sec">Goal</div>' + goalCard() + '</div>'
        + (ids.length ? '<div><div class="cm-sec">Topics</div><div class="cm-list">' + ids.map((k) => '<div class="cm-item"><span class="cm-grow cm-tap" data-hubtopic="' + esc(k) + '">' + esc(S.topics[k].title) + '</span><span class="cm-n">' + thoughtsIn(k).length + '</span>' + sw(!!S.goal && S.goal.topics.includes(k), 'data-topic', k, !S.goal) + '</div>').join('') + '</div></div>' : '')
        + (unsorted ? '<div class="cm-note">' + unsorted + ' waiting thought' + (unsorted === 1 ? ' has' : 's have') + ' no topic yet' + (ids.length ? '' : ' - this repository has not been grouped') + '. They show under Unsorted, and agents do not read them by default.</div>' : '')
        + '<div><div class="cm-sec">Domains</div><div class="cm-list">' + S.domains.map((d) => '<div class="cm-item"><span class="cm-swatch" style="background:' + d.colour + '"></span><span class="cm-grow">' + esc(d.name) + '</span><span class="cm-n">' + S.data.thoughts.filter((t) => t.domain === d.id).length + '</span>'
          + (d.floating ? '<span class="cm-tag">floating</span>' : sw(!(S.goal && S.goal.domains_off.includes(d.id)), 'data-domain', d.id, !S.goal)) + '</div>').join('') + '</div></div>';
    } else if (n.type === 'goal') {
      p.innerHTML = '<button class="cm-back" data-back>‹ Overview</button><h2>' + esc(n.label) + '</h2><div class="cm-sub">Your goal. It decides which topics are active, and so what agents read. Set ' + (S.goal && S.goal.at ? new Date(S.goal.at).toLocaleString() : '') + '.</div>' + err + goalCard();
    } else if (n.type === 'hub') {
      const list = S.data.thoughts.filter((t) => (t.topic || UNSORTED) === n.topic && t.domain === n.domain), st = hubState(n), tp = S.topics[n.topic];
      p.innerHTML = '<button class="cm-back" data-back>‹ Overview</button>' + err
        + '<div><span class="cm-tag" style="color:' + S.dom[n.domain].colour + '">' + esc(S.dom[n.domain].name) + '</span><h2>' + esc(n.label) + '</h2></div>'
        + (st === 'unsorted' ? '<div class="cm-note">Thoughts with no topic. A topic is given when a grouping is applied, and - soon - when a thought is recorded.</div>'
          : '<div class="cm-list"><div class="cm-item"><span class="cm-grow">Active<div class="cm-sub">' + (st === 'active' ? 'Agents read these ' + list.length + ' thoughts · ~' + list.reduce((s, t) => s + tokensOf(t), 0) + ' tokens' : 'Kept, and hidden from agents unless asked') + '</div></span>' + sw(!!S.goal && S.goal.topics.includes(n.topic), 'data-topic', n.topic, !S.goal) + '</div></div>')
        + (tp && (tp.digest || tp.waiting_for) ? '<div class="cm-card">' + (tp.digest ? '<div>' + esc(tp.digest) + '</div>' : '') + (tp.waiting_for ? '<div class="cm-sub">Waiting for: ' + esc(tp.waiting_for) + '</div>' : '') + '</div>' : '')
        + '<div><div class="cm-sec">Thoughts</div><div class="cm-list">' + list.map((t) => '<div class="cm-item cm-tap" data-sel="' + esc(t.id) + '"><span class="cm-grow"><small>' + esc(kindOf(t)) + '</small>' + esc(t.text) + '</span></div>').join('') + '</div></div>';
    } else {
      const t = n.t;
      const out = (t.links || []).filter((l) => S.tById.has(l.to)).map((l) => ({ rel: l.type + ' →', u: S.tById.get(l.to) }));
      const inn = S.data.thoughts.flatMap((x) => (x.links || []).filter((l) => l.to === t.id).map((l) => ({ rel: '← ' + l.type, u: x })));
      p.innerHTML = '<button class="cm-back" data-back>‹ Overview</button>' + err
        + '<div><span class="cm-tag" style="color:' + S.dom[t.domain].colour + '">' + esc(S.dom[t.domain].name) + '</span><span class="cm-tag">' + esc(t.topic === UNSORTED ? 'Unsorted' : (S.topics[t.topic] || {}).title || t.topic) + '</span><span class="cm-tag">' + esc(kindOf(t)) + (t.decided_by ? ' · ' + esc(t.decided_by) : '') + '</span></div>'
        + '<div class="cm-text">' + esc(t.text) + '</div>'
        + (floating(t.domain) ? '<div class="cm-sub">Floating - no agent has used it yet.</div>' : '')
        + ((t.forces || []).length ? '<div><div class="cm-sec">Forces</div><div class="cm-list">' + t.forces.map((f) => '<div class="cm-force ' + f.direction + '"><b>' + (f.direction === 'forward' ? 'For' : 'Against') + '</b>' + esc(f.text) + '</div>').join('') + '</div></div>' : '')
        + (out.length + inn.length ? '<div><div class="cm-sec">Links</div><div class="cm-list">' + out.concat(inn).map((x) => '<div class="cm-item cm-tap" data-sel="' + esc(x.u.id) + '"><span class="cm-grow"><small>' + esc(x.rel) + '</small>' + esc(x.u.text) + '</span></div>').join('') + '</div></div>' : '')
        + '<div class="cm-mono">' + esc(t.id) + ' · ~' + tokensOf(t) + ' tokens</div>';
    }
    p.querySelectorAll('[data-topic]').forEach((b) => b.onclick = () => toggleTopic(b.dataset.topic));
    p.querySelectorAll('[data-domain]').forEach((b) => b.onclick = () => toggleDomain(b.dataset.domain));
    p.querySelectorAll('[data-sel]').forEach((b) => b.onclick = () => select(b.dataset.sel));
    p.querySelectorAll('[data-hubtopic]').forEach((b) => b.onclick = () => { const h = S.nodes.find((x) => x.type === 'hub' && x.topic === b.dataset.hubtopic && x.domain === 'discussion') || S.nodes.find((x) => x.type === 'hub' && x.topic === b.dataset.hubtopic); if (h) select(h.id); });
    p.querySelectorAll('[data-back]').forEach((b) => b.onclick = () => select(null));
    wireGoal(p);
  }

  /* The goal card, and editing it: new words, GitX's suggested topics for
   * them, and the user's choice saved together. */
  function goalCard() {
    if (!S.editing) {
      return '<div class="cm-card">' + (S.goal ? '<b class="cm-goal-text">' + esc(S.goal.text) + '</b><div class="cm-sub">' + S.goal.topics.length + ' active topic' + (S.goal.topics.length === 1 ? '' : 's') + (S.goal.set_by ? ' · set by ' + esc(S.goal.set_by) : '') + '</div>' : '<b>No goal set</b><div class="cm-sub">Without one, nothing is active and agents read no part of the map by default.</div>')
        + '<button type="button" class="cm-btn" data-goal-edit>' + (S.goal ? 'Change goal' : 'Set a goal') + '</button></div>';
    }
    const e = S.editing;
    return '<div class="cm-card"><input class="cm-input" data-goal-input maxlength="200" value="' + esc(e.text) + '" placeholder="What are you working toward?">'
      + '<div class="cm-sub" style="margin:8px 0 4px">' + (e.loading ? 'Finding the topics it points at…' : 'GitX suggests these topics - change them if you like:') + '</div>'
      + '<div class="cm-list">' + (e.ranked || []).map((r) => '<label class="cm-item cm-check"><input type="checkbox" data-goal-topic="' + esc(r.id) + '"' + (e.chosen.includes(r.id) ? ' checked' : '') + '><span class="cm-grow">' + esc(r.title) + (r.matched.length ? '<small>' + esc(r.matched.join(', ')) + '</small>' : '') + '</span><span class="cm-n">' + r.score + '</span></label>').join('') + '</div>'
      + '<div class="cm-row"><button type="button" class="cm-btn" data-goal-cancel>Cancel</button><button type="button" class="cm-btn cm-primary" data-goal-save>Save goal</button></div></div>';
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
    panel();
    const input = document.querySelector('[data-goal-input]');
    if (input) { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
  }
  function wireGoal(p) {
    const edit = p.querySelector('[data-goal-edit]');
    if (edit) edit.onclick = () => {
      S.editing = { text: S.goal ? S.goal.text : '', chosen: S.goal ? S.goal.topics.slice() : [], ranked: Object.values(S.topics).map((t) => ({ id: t.id, title: t.title, score: 0, matched: [] })), touched: true };
      panel();
      if (S.editing.text) suggest(S.editing.text);
    };
    const input = p.querySelector('[data-goal-input]');
    if (input) input.oninput = () => {
      S.editing.text = input.value;
      S.editing.touched = false;
      clearTimeout(suggestTimer);
      suggestTimer = setTimeout(() => suggest(input.value), 300);
    };
    p.querySelectorAll('[data-goal-topic]').forEach((c) => c.onchange = () => {
      const e = S.editing;
      e.touched = true;
      e.chosen = c.checked ? [...new Set([...e.chosen, c.dataset.goalTopic])] : e.chosen.filter((x) => x !== c.dataset.goalTopic);
    });
    const cancel = p.querySelector('[data-goal-cancel]');
    if (cancel) cancel.onclick = () => { S.editing = null; panel(); };
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

  function chrome() {
    const reads = S.data.thoughts.filter((t) => !floating(t.domain) && topicActive(t.topic || UNSORTED, t.domain));
    const fl = S.data.thoughts.filter((t) => floating(t.domain)).length;
    const unsorted = S.data.thoughts.filter((t) => !t.topic).length;
    const folded = S.data.thoughts.filter((t) => !floating(t.domain) && t.topic && !topicActive(t.topic, t.domain)).length;
    $('cm-monitor').innerHTML = '<span class="cm-reads">Agents read <b>' + reads.length + ' thought' + (reads.length === 1 ? '' : 's') + ' · ~' + reads.reduce((s, t) => s + tokensOf(t), 0).toLocaleString() + ' tokens</b></span><span class="cm-sep"></span>'
      + '<span>Waiting <b>' + S.data.thoughts.length + '</b></span><span class="cm-sep cm-opt"></span>'
      + '<span class="cm-opt">Floating <b>' + fl + '</b></span><span class="cm-sep cm-opt"></span>'
      + '<span class="cm-opt">Folded <b>' + folded + '</b></span>'
      + (unsorted ? '<span class="cm-sep"></span><span>Unsorted <b>' + unsorted + '</b></span>' : '');
    $('cm-goal').innerHTML = '<span class="cm-dot' + (S.goal ? '' : ' off') + '"></span><div><small>Goal</small><b>' + esc(S.goal ? S.goal.text : 'No goal set') + '</b></div>';
  }

  /* ============================================================ render */
  function render() {
    const stage = $('cm-stage');
    if (!stage) return;
    const empty = $('cm-empty');
    if (!S.data || S.data.missing) {
      empty.hidden = false;
      empty.textContent = !S.data ? 'Reading the context graph…' : 'This broker sends no context map. Restart the GitX broker to pick up the new code.';
      return;
    }
    empty.hidden = true;
    if (S.dirty) {
      graph();
      settle(S.pos.size ? 0.4 : 1, S.pos.size ? 160 : 360);
      S.dirty = false;
      build();
      if (!S.view) fit(); else setView(S.view);
    }
    panel();
    chrome();
  }
  function rebuild() { settle(0.5, 140); build(); panel(); chrome(); }
  function select(id) { S.sel = id; S.editing = null; panel(); focus(); }

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
          /* Like Neo4j: a dragged node stays where it is put. */
          const [x, y] = toWorld(e.clientX, e.clientY);
          drag.node.fx = x; drag.node.fy = y;
          S.alpha = Math.max(S.alpha, 0.25);
          run();
        }
        return;
      }
      const n = nodeAt(e.target), id = n ? n.id : null;
      if (id !== S.hover) { S.hover = id; focus(); }
      if (!n) { tip.hidden = true; return; }
      tip.innerHTML = n.type === 'thought' ? '<div class="cm-meta">' + esc(S.dom[n.domain].name) + ' · ' + esc(kindOf(n.t)) + '</div>' + esc(n.t.text.length > 170 ? n.t.text.slice(0, 170) + '…' : n.t.text)
        : n.type === 'hub' ? '<div class="cm-meta">' + esc(S.dom[n.domain].name) + ' · ' + hubState(n) + '</div>' + esc(n.label) + ' · ' + n.n + ' thought' + (n.n === 1 ? '' : 's')
        : '<div class="cm-meta">Goal</div>' + esc(n.label);
      const r = $('cm-stage').getBoundingClientRect();
      tip.hidden = false;
      tip.style.left = Math.min(e.clientX - r.left + 16, r.width - 320) + 'px';
      tip.style.top = (e.clientY - r.top + 16) + 'px';
    });
    el.addEventListener('pointerup', (e) => {
      const was = drag; drag = null; el.classList.remove('cm-panning');
      if (!moved) { const n = nodeAt(e.target); select(n ? n.id : null); }
      else if (was && was.node) run();
    });
    el.addEventListener('pointerleave', () => { tip.hidden = true; if (S.hover && !drag) { S.hover = null; focus(); } });
    el.addEventListener('wheel', (e) => { if (!S.view) return; e.preventDefault(); const [x, y] = toWorld(e.clientX, e.clientY); zoomBy(e.deltaY > 0 ? 1.12 : 1 / 1.12, x, y); }, { passive: false });
    $('cm-zin').onclick = () => zoomBy(1 / 1.25);
    $('cm-zout').onclick = () => zoomBy(1.25);
    $('cm-zfit').onclick = fit;
    addEventListener('keydown', (e) => { if (S.visible && e.key === 'Escape' && !S.editing) select(null); });
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
