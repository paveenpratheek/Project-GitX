/* GitX — the commit graph with the thinking between its commits.
 *
 * Two graphs drawn as one. Code commits come from git; thought commits come
 * from .gitx/thoughts (confirmed) and .gitx/drafts (unconfirmed), served by the
 * broker at /api/thoughts. They share a picture and nothing else: the thought
 * lane sits beside the commit lanes, each group of thoughts hangs between the
 * commit it was ANCHORED at (what HEAD was while the talk happened) and the
 * commit it LED TO, and the commit side never learns that any of it exists.
 *
 * Grouping is by anchor, not by led_to, because a rejected idea leads nowhere:
 * it only has an anchor. The group's led_to is the one its accepted thoughts
 * share, so the alternatives turned down on the way sit with the choice they
 * lost to. A group with no led_to at all is thinking that has not produced a
 * commit yet, and is drawn ABOVE its anchor instead of below the next commit.
 */
(function () {
  'use strict';

  const OUTCOMES = ['accepted', 'rejected', 'stashed', 'open'];
  const LANE_W = 16;
  const GUT_PAD = 18;

  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private window */ } }
  };

  const view = {
    httpBase: '',
    state: null,
    data: null,             // { commits, thoughts, lanes, fallback, error, truncated }
    idx: null,              // derived lookups, rebuilt with data
    fetchedFor: '',
    mode: store.get('gitx.thoughtMode', 'collapsed'),   // code | collapsed | expanded
    open: new Set(),        // groups opened by hand in collapsed mode
    closed: new Set(),      // groups closed by hand in expanded mode
    sel: null,              // { type: 'commit' | 'thought', id }
    outcomes: new Set(OUTCOMES),
    query: ''
  };

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const short = (h) => (h && h !== 'genesis' ? h.slice(0, 7) : h || '');
  const day = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  };
  const stamp = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  };

  /* ───────────────────────────────────────────── data */

  async function fetchData() {
    const st = view.state || {};
    const key = (st.activeRepo || '') + '|' + ((st.thoughtStats && st.thoughtStats.signature) || '');
    view.fetchedFor = key;
    try {
      const res = await fetch(view.httpBase + '/api/thoughts', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      if (view.fetchedFor !== key) return;          // a newer repo switch overtook this one
      view.data = { ...payload, fallback: false };
    } catch (err) {
      /* An older broker has no /api/thoughts. The commits still draw, from the
       * graph payload it already ships - one lane, no thoughts, and a note. */
      const pg = (st.projectGraph && st.projectGraph.commits) || [];
      view.data = {
        commits: pg.slice().reverse().map((c) => ({ h: c.h, p: [], d: c.date, s: c.subject, lane: 0 })),
        thoughts: [], lanes: 1, fallback: true, error: err.message, stats: { count: 0 }
      };
    }
    buildIndex();
    render();
  }

  function buildIndex() {
    const d = view.data;
    const commitAt = new Map(d.commits.map((c, i) => [c.h, i]));
    const thoughtById = new Map(d.thoughts.map((t) => [t.id, t]));

    const byAnchor = new Map();
    for (const t of d.thoughts) {
      if (!byAnchor.has(t.anchor)) byAnchor.set(t.anchor, []);
      byAnchor.get(t.anchor).push(t);
    }
    const groups = new Map();
    for (const [anchor, list] of byAnchor) {
      const votes = new Map();
      for (const t of list) if (t.led_to) votes.set(t.led_to, (votes.get(t.led_to) || 0) + 1);
      const shared = [...votes.entries()].sort((a, b) => b[1] - a[1])[0];
      for (const t of list) {
        const ledTo = t.led_to || (shared && shared[0]) || null;
        const key = anchor + '>' + (ledTo || '-');
        if (!groups.has(key)) groups.set(key, { key, anchor, ledTo, thoughts: [] });
        groups.get(key).thoughts.push(t);
        t.group = key;
      }
    }

    const below = new Map(), above = new Map(), unplaced = [];
    for (const g of groups.values()) {
      if (g.ledTo && commitAt.has(g.ledTo)) push(below, g.ledTo, g);
      else if (!g.ledTo && commitAt.has(g.anchor)) push(above, g.anchor, g);
      else unplaced.push(g);
    }

    const incoming = new Map();
    for (const t of d.thoughts) {
      for (const l of t.links) push(incoming, l.to, { type: l.type, from: t.id });
      if (t.applied_to) push(incoming, t.applied_to, { type: 'applied-from', from: t.id });
    }

    view.idx = { commitAt, thoughtById, groups, below, above, unplaced, incoming };
  }

  function push(map, k, v) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }

  /* Status a thought is IN, as opposed to the outcome it was given: a rejection
   * held back only by a circumstance that can change is not closed for good. */
  function reopenable(t) {
    return t.outcome === 'rejected' && t.forces.some((f) =>
      f.direction === 'backward' && f.kind === 'contingent' && f.revisit_if && !f.superseded_by);
  }

  function matches(t, q) {
    if (!q) return true;
    if ((t.text || '').toLowerCase().includes(q) || t.id.includes(q)) return true;
    return t.forces.some((f) => (f.text || '').toLowerCase().includes(q) || (f.revisit_if || '').toLowerCase().includes(q));
  }
  const shown = (t) => view.outcomes.has(t.outcome) && matches(t, view.query);

  /* ───────────────────────────────────────────── the graph column */

  function isOpen(g) {
    if (view.query) return g.thoughts.some(shown);
    return view.mode === 'expanded' ? !view.closed.has(g.key) : view.open.has(g.key);
  }

  const SHAPES = {
    decision: '<path d="M6 1 L11 6 L6 11 L1 6 Z" fill="currentColor"/>',
    finding: '<circle cx="6" cy="6" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/>',
    cost: '<path d="M6 1.5 L11 10.5 L1 10.5 Z" fill="currentColor"/>',
    learned: '<path d="M6 1 L10.5 3.5 L10.5 8.5 L6 11 L1.5 8.5 L1.5 3.5 Z" fill="currentColor"/>'
  };
  const shape = (t) => `<svg class="tg-shape o-${esc(t.outcome)}" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${SHAPES[t.kind] || SHAPES.decision}</svg>`;

  function counts(list) {
    const c = {};
    for (const t of list) c[t.outcome] = (c[t.outcome] || 0) + 1;
    return OUTCOMES.filter((o) => c[o]).map((o) =>
      `<span class="tg-count"><span class="tg-dot o-${o}"></span>${c[o]}${o === 'open' ? ' open' : ''}</span>`).join('');
  }

  function chip(g) {
    const n = g.thoughts.length;
    return `<button type="button" class="tg-chip" data-toggle="${esc(g.key)}" aria-expanded="false">
      <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>
      ${n} thought${n === 1 ? '' : 's'}${counts(g.thoughts)}</button>`;
  }

  function cardMeta(t) {
    const inc = view.idx.incoming.get(t.id) || [];
    if (t.outcome === 'rejected') {
      if (reopenable(t)) return '<span class="tg-meta tg-accent">reopenable</span>';
      const back = t.forces.find((f) => f.direction === 'backward' && f.kind);
      return back ? `<span class="tg-meta">${esc(back.kind)}</span>` : '';
    }
    if (t.outcome === 'stashed') return `<span class="tg-meta">${t.applied_to ? 'applied' : 'not applied'}</span>`;
    if (inc.some((l) => l.type === 'supersedes')) return '<span class="tg-meta">superseded later</span>';
    if (inc.some((l) => l.type === 'refines')) return '<span class="tg-meta">refined later</span>';
    return t.kind === 'decision' && t.decided_by ? `<span class="tg-meta">${esc(t.decided_by)}</span>` : '';
  }

  function card(t) {
    const sel = view.sel && view.sel.type === 'thought' && view.sel.id === t.id ? ' is-selected' : '';
    const draft = t.confirmed ? '' : ' is-draft';
    return `<button type="button" class="tg-card${sel}${draft}" data-thought="${esc(t.id)}" title="${esc(t.text)}">
      ${shape(t)}<span class="tg-text">${esc(t.text)}</span>${cardMeta(t)}</button>`;
  }

  function box(g) {
    const list = g.thoughts.filter(shown);
    const left = [], right = [];
    const led = g.ledTo ? 'Led to ' + short(g.ledTo) : 'Decided, not committed yet';
    const buckets = {
      led: [], found: [], cost: [], turned: [], learned: [], stashed: [], open: []
    };
    for (const t of list) {
      if (t.outcome === 'rejected') buckets.turned.push(t);
      else if (t.outcome === 'stashed') buckets.stashed.push(t);
      else if (t.outcome === 'open') buckets.open.push(t);
      else if (t.kind === 'finding') buckets.found.push(t);
      else if (t.kind === 'cost') buckets.cost.push(t);
      else if (t.kind === 'learned') buckets.learned.push(t);
      else buckets.led.push(t);
    }
    const section = (title, items) => items.length
      ? `<div class="tg-sec"><span class="tg-label">${esc(title)}</span>${items.map(card).join('')}</div>` : '';
    left.push(section(led, buckets.led), section('Found', buckets.found), section('Costs kept', buckets.cost));
    right.push(section('Turned down', buckets.turned), section('Learned', buckets.learned),
      section('Stashed', buckets.stashed), section('Still open', buckets.open));

    const ats = g.thoughts.map((t) => t.at).filter(Boolean).sort();
    const span = ats.length ? (day(ats[0]) === day(ats[ats.length - 1]) ? day(ats[0]) : day(ats[0]) + ' – ' + day(ats[ats.length - 1])) : '';
    const hidden = g.thoughts.length - list.length;
    return `<section class="tg-box" data-group="${esc(g.key)}">
      <div class="tg-box-head">
        <button type="button" class="tg-fold" data-toggle="${esc(g.key)}" aria-expanded="true" aria-label="Collapse">
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3 L5 7 L8.5 3" stroke="currentColor" stroke-width="1.5" fill="none"/></svg></button>
        <b>${g.ledTo ? 'Thinking behind ' + esc(short(g.ledTo)) : 'Thinking since ' + esc(short(g.anchor))}</b>
        <span class="tg-dim">${g.thoughts.length} thought${g.thoughts.length === 1 ? '' : 's'}${span ? ' · ' + esc(span) : ''}${hidden ? ' · ' + hidden + ' filtered out' : ''}</span>
        <span class="tg-grow"></span>
        <span class="tg-mono tg-dim">anchored at ${esc(short(g.anchor))}${g.ledTo ? '  →  led to ' + esc(short(g.ledTo)) : ''}</span>
      </div>
      <div class="tg-cols"><div class="tg-col">${left.join('')}</div><div class="tg-col">${right.join('')}</div></div>
    </section>`;
  }

  function commitRow(c, groupsHere) {
    const q = view.query;
    const hit = !q || c.s.toLowerCase().includes(q) || c.h.startsWith(q);
    const thoughtHit = groupsHere.some((g) => g.thoughts.some(shown));
    const dim = q && !hit && !thoughtHit ? ' is-dim' : '';
    const sel = view.sel && view.sel.type === 'commit' && view.sel.id === c.h ? ' is-selected' : '';
    let why = '';
    if (view.mode !== 'code') {
      const closed = groupsHere.filter((g) => !isOpen(g));
      if (closed.length) why = closed.map(chip).join('');
      else if (!groupsHere.length && view.data.thoughts.length) why = '<span class="tg-none">Nothing on record</span>';
    }
    return `<div class="tg-row tg-commit${sel}${dim}" data-row="${esc(c.h)}">
      <button type="button" class="tg-commit-btn" data-commit="${esc(c.h)}">
        <span class="tg-mono tg-hash">${esc(short(c.h))}</span><span class="tg-subj">${esc(c.s)}</span></button>
      <span class="tg-why">${why}</span>
      <span class="tg-mono tg-date">${esc(day(c.d))}</span>
    </div>`;
  }

  function pendingRow(g) {
    return `<div class="tg-row tg-pending" data-pending="${esc(g.key)}">
      <span class="tg-dim">Not in a commit yet</span><span class="tg-why">${chip(g)}</span></div>`;
  }

  function renderList() {
    const list = $('tg-list');
    if (!list) return;
    const d = view.data;
    if (!d) { list.innerHTML = '<div class="tg-empty">Loading the graph…</div>'; return; }
    if (!d.commits.length) { list.innerHTML = '<div class="tg-empty">This repository has no commits yet.</div>'; drawGraph(); return; }

    const { below, above, unplaced } = view.idx;
    const code = view.mode === 'code';
    const html = [];
    for (const c of d.commits) {
      if (!code) for (const g of above.get(c.h) || []) html.push(isOpen(g) ? box(g) : pendingRow(g));
      const here = below.get(c.h) || [];
      html.push(commitRow(c, here));
      if (!code) for (const g of here) if (isOpen(g)) html.push(box(g));
    }
    if (!code && unplaced.length) {
      const n = unplaced.reduce((s, g) => s + g.thoughts.length, 0);
      html.push(`<div class="tg-empty">${n} thought${n === 1 ? ' is' : 's are'} anchored before the oldest commit shown.</div>`);
    }
    if (d.truncated) html.push('<div class="tg-empty">Showing the newest 600 commits.</div>');
    list.innerHTML = html.join('') + '<svg class="tg-lines" aria-hidden="true"></svg>';
    list.style.setProperty('--tg-gutter', gutter() + 'px');
    drawGraph();
  }

  const laneX = (l) => GUT_PAD + l * LANE_W;
  const thoughtX = () => GUT_PAD + Math.max(1, view.data.lanes) * LANE_W + 6;
  const gutter = () => view.mode === 'code' ? GUT_PAD + Math.max(1, view.data.lanes) * LANE_W + 4 : thoughtX() + 18;

  /* Drawn after layout, from where the rows actually landed - an opened group
   * is hundreds of pixels tall, so no row height can be assumed. */
  function drawGraph() {
    const list = $('tg-list');
    const svg = list && list.querySelector('.tg-lines');
    if (!svg || !view.data) return;
    const H = list.scrollHeight, W = gutter();
    svg.setAttribute('width', W);
    svg.setAttribute('height', H);
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

    const y = new Map();
    for (const el of list.querySelectorAll('.tg-commit')) y.set(el.dataset.row, el.offsetTop + el.offsetHeight / 2);
    const lane = new Map(view.data.commits.map((c) => [c.h, c.lane]));
    const out = [];

    for (const c of view.data.commits) {
      const x1 = laneX(c.lane), y1 = y.get(c.h);
      c.p.forEach((p, k) => {
        const y2 = y.get(p);
        if (y2 == null) {
          out.push(`<path class="g-edge" d="M${x1} ${y1} V${H}"/>`);
          return;
        }
        const x2 = laneX(lane.get(p));
        if (x1 === x2) out.push(`<path class="g-edge" d="M${x1} ${y1} V${y2}"/>`);
        else if (k === 0) out.push(`<path class="g-edge" d="M${x1} ${y1} V${y2 - 28} C${x1} ${y2 - 10} ${x2} ${y2 - 14} ${x2} ${y2}"/>`);
        else out.push(`<path class="g-edge" d="M${x1} ${y1} C${x1} ${y1 + 16} ${x2} ${y1 + 12} ${x2} ${y1 + 28} V${y2}"/>`);
      });
    }

    if (view.mode !== 'code') {
      const tx = thoughtX();
      const diamond = (cy, filled) => `<path class="g-thought${filled ? ' is-filled' : ''}" d="M${tx - 6} ${cy} L${tx} ${cy - 6} L${tx + 6} ${cy} L${tx} ${cy + 6} Z"/>`;
      for (const el of list.querySelectorAll('.tg-box')) {
        const g = view.idx.groups.get(el.dataset.group);
        const top = el.offsetTop, bottom = top + el.offsetHeight, ny = top + 20;
        out.push(`<path class="g-spine" d="M${tx} ${top + 8} V${bottom - 8}"/>`);
        out.push(`<path class="g-spine" d="M${tx + 6} ${ny} H${W}"/>`);
        if (g.ledTo && y.has(g.ledTo)) {
          const cx = laneX(lane.get(g.ledTo)), cy = y.get(g.ledTo);
          out.push(`<path class="g-led" d="M${tx} ${ny - 6} C${tx} ${cy + 12} ${cx} ${cy + 16} ${cx} ${cy + 6}"/>`);
        }
        if (y.has(g.anchor)) {
          const cx = laneX(lane.get(g.anchor)), cy = y.get(g.anchor);
          out.push(`<path class="g-anchor" d="M${cx} ${cy - 6} C${cx} ${cy - 16} ${tx} ${bottom + 4} ${tx} ${bottom - 8}"/>`);
        }
        out.push(diamond(ny, true));
      }
      for (const el of list.querySelectorAll('.tg-commit .tg-chip')) {
        const row = el.closest('.tg-commit');
        out.push(diamond(row.offsetTop + row.offsetHeight / 2, false));
      }
      for (const el of list.querySelectorAll('.tg-pending')) {
        const g = view.idx.groups.get(el.dataset.pending);
        const cy = el.offsetTop + el.offsetHeight / 2;
        if (y.has(g.anchor)) {
          const cx = laneX(lane.get(g.anchor)), ay = y.get(g.anchor);
          out.push(`<path class="g-anchor" d="M${cx} ${ay - 6} C${cx} ${ay - 16} ${tx} ${cy + 16} ${tx} ${cy + 6}"/>`);
        }
        out.push(diamond(cy, false));
      }
    }

    for (const c of view.data.commits) {
      if (!y.has(c.h)) continue;
      out.push(`<circle class="g-commit${c.p.length > 1 ? ' is-merge' : ''}" cx="${laneX(c.lane)}" cy="${y.get(c.h)}" r="5"/>`);
    }
    svg.innerHTML = out.join('');
  }

  /* ───────────────────────────────────────────── the details panel */

  function pill(text, cls) { return `<span class="tg-pill ${cls || ''}">${esc(text)}</span>`; }

  function thoughtLink(id, label) {
    const t = view.idx.thoughtById.get(id);
    if (!t) return `<span class="tg-dim">${esc(label)} ${esc(id)} (not on record)</span>`;
    return `<button type="button" class="tg-link" data-thought="${esc(id)}">${shape(t)}<span><span class="tg-link-type">${esc(label)}</span>${esc(t.text)}</span></button>`;
  }

  const LINK_WORDS = {
    'lost-to': 'Lost to', 'cost-of': 'Cost of', 'derived-from': 'Learned from', supports: 'Supports',
    refines: 'Refines', supersedes: 'Supersedes', contradicts: 'Contradicts'
  };
  const INCOMING_WORDS = {
    'lost-to': 'Beat', 'cost-of': 'Its cost', 'derived-from': 'Taught', supports: 'Supported by',
    refines: 'Refined by', supersedes: 'Superseded by', contradicts: 'Contradicted by', 'applied-from': 'Applied from stash'
  };

  function detailThought(t) {
    const outcomeCls = 'o-' + t.outcome;
    const pills = [
      `<span class="tg-pill">${shape(t)}${esc(t.kind)}</span>`,
      pill(t.outcome, 'tg-pill-' + t.outcome),
      reopenable(t) ? pill('reopenable', 'tg-pill-open') : '',
      t.decided_by ? pill(t.decided_by === 'user' ? 'decided by the user' : t.decided_by === 'agent-delegated' ? 'agent, delegated' : 'decided by the agent') : '',
      pill(t.confirmed ? 'confirmed' : 'draft · unconfirmed', t.confirmed ? '' : 'tg-pill-draft')
    ].join('');

    const forces = (dir, title) => {
      const list = t.forces.filter((f) => f.direction === dir);
      if (!list.length) return '';
      return `<div class="tg-dsec"><span class="tg-label">${title}</span>${list.map((f) => `
        <div class="tg-force ${dir}">
          ${f.kind ? `<span class="tg-force-kind">${esc(f.kind)}</span>` : ''}
          <span>${esc(f.text)}</span>
          ${f.revisit_if ? `<span class="tg-revisit"><span class="tg-dim">Revisit if</span> ${esc(f.revisit_if)}</span>` : ''}
          ${f.superseded_by ? `<span class="tg-dim">No longer holds - see ${esc(f.superseded_by)}</span>` : ''}
        </div>`).join('')}</div>`;
    };

    const links = t.links.map((l) => thoughtLink(l.to, LINK_WORDS[l.type] || l.type));
    if (t.applied_to) links.push(thoughtLink(t.applied_to, 'Applied to'));
    const incoming = (view.idx.incoming.get(t.id) || []).map((l) => thoughtLink(l.from, INCOMING_WORDS[l.type] || l.type));
    const lostTo = t.outcome === 'rejected' && t.kind === 'decision' && !t.links.some((l) => l.type === 'lost-to')
      ? '<div class="tg-dsec"><span class="tg-label">Lost to</span><span class="tg-dim">Nothing. The whole idea was dropped, not beaten by an alternative.</span></div>' : '';

    const commitBtn = (h) => h === 'genesis' ? 'before the first commit'
      : view.idx.commitAt.has(h) ? `<button type="button" class="tg-inline" data-commit="${esc(h)}">${esc(short(h))}</button>` : esc(short(h));

    return `
      <span class="tg-mono tg-dim">${esc(t.id)}</span>
      <h2 class="tg-title ${outcomeCls}">${esc(t.text)}</h2>
      <div class="tg-pills">${pills}</div>
      ${forces('forward', 'Pushed forward by')}
      ${forces('backward', 'Held back by')}
      ${lostTo}
      ${links.length ? `<div class="tg-dsec"><span class="tg-label">Links</span>${links.join('')}</div>` : ''}
      ${incoming.length ? `<div class="tg-dsec"><span class="tg-label">Linked from</span>${incoming.join('')}</div>` : ''}
      <div class="tg-dsec"><span class="tg-label">Where it sits</span>
        <div class="tg-kv">
          <span>Anchored at</span><span class="tg-mono">${commitBtn(t.anchor)}</span>
          <span>Patch-id</span><span class="tg-mono">${esc((t.patch_id || '-').slice(0, 8))}</span>
          <span>Led to</span><span class="tg-mono">${t.led_to ? commitBtn(t.led_to) : `<span class="tg-dim">no commit${t.outcome === 'rejected' ? ' (rejected)' : ''}</span>`}</span>
          <span>Parent</span><span class="tg-mono">${t.parent ? `<button type="button" class="tg-inline" data-thought="${esc(t.parent)}">${esc(t.parent)}</button>` : '-'}</span>
          <span>Session</span><span class="tg-mono">${esc(t.session || '-')}</span>
          <span>Provenance</span><span>${esc(t.provenance || '-')}</span>
        </div>
      </div>
      <div class="tg-dsec"><span class="tg-label">Source</span>
        <span>${t.sources ? 'Transcript' + (t.sources > 1 ? ` · ${t.sources} messages` : '') + (t.at ? ' · ' + esc(stamp(t.at)) : '') : '<span class="tg-dim">none recorded</span>'}</span>
      </div>`;
  }

  function detailCommit(c) {
    const st = view.state || {};
    const pg = ((st.projectGraph && st.projectGraph.commits) || []).find((x) => c.h.startsWith(x.h));
    const threads = (st.projectGraph && st.projectGraph.threads) || [];
    const groups = view.idx.below.get(c.h) || [];
    const all = groups.flatMap((g) => g.thoughts);
    const body = pg && pg.body ? `<div class="tg-dsec"><span class="tg-label">Message${pg.source === 'gitx' ? ' · from .gitx/commits, written later' : ''}</span><div class="tg-body">${esc(pg.body)}</div></div>` : '';
    const meta = [];
    if (pg && pg.root) meta.push(`<span>Starts a line of work</span><span>${esc(pg.root)}</span>`);
    else if (pg && pg.lines && pg.lines.length) meta.push(`<span>Line of work</span><span>${esc(pg.lines.join(', '))}</span>`);
    if (pg && pg.t >= 0 && threads[pg.t]) meta.push(`<span>Thread</span><span>${esc(threads[pg.t].name)} <span class="tg-dim">(inferred)</span></span>`);
    meta.push(`<span>Parents</span><span class="tg-mono">${c.p.length ? c.p.map((p) => view.idx.commitAt.has(p)
      ? `<button type="button" class="tg-inline" data-commit="${esc(p)}">${esc(short(p))}</button>` : esc(short(p))).join(' ') : 'none - first commit'}</span>`);
    const reasoning = all.length
      ? `<div class="tg-dsec"><span class="tg-label">Reasoning behind it</span>
          <div class="tg-counts">${all.length} thought${all.length === 1 ? '' : 's'}${counts(all)}</div>
          <button type="button" class="tg-btn" data-open-groups="${esc(c.h)}">Show them in the graph</button></div>`
      : `<div class="tg-dsec"><span class="tg-label">Reasoning behind it</span><span class="tg-dim">Nothing on record. No discussion was saved for this commit.</span></div>`;
    return `
      <span class="tg-mono tg-dim">${esc(c.h.slice(0, 12))} · ${esc(stamp(c.d))}</span>
      <h2 class="tg-title">${esc(c.s)}</h2>
      ${reasoning}
      <div class="tg-dsec"><span class="tg-label">In the graph</span><div class="tg-kv">${meta.join('')}</div></div>
      ${body}
      ${pg && pg.files && pg.files.length ? `<div class="tg-dsec"><span class="tg-label">Files it mostly changed</span><span class="tg-mono tg-files">${pg.files.map(esc).join('<br>')}</span></div>` : ''}`;
  }

  function detailOverview() {
    const d = view.data;
    const st = view.state || {};
    const issues = st.issues || [];
    const parts = [`<span class="tg-mono tg-dim">${esc(st.activeRepoName || '')}</span><h2 class="tg-title">Reasoning on record</h2>`];

    if (d && d.fallback) {
      parts.push(`<div class="tg-note">This broker does not serve thoughts yet. Restart it to load <span class="tg-mono">.gitx/thoughts</span> and <span class="tg-mono">.gitx/drafts</span>.</div>`);
    } else if (d && !d.thoughts.length) {
      parts.push(`<div class="tg-note">No thoughts recorded for this repository yet. They are read from <span class="tg-mono">.gitx/thoughts</span> (confirmed) and <span class="tg-mono">.gitx/drafts</span> (unconfirmed).</div>`);
    } else if (d) {
      const th = d.thoughts;
      const withReasoning = new Set([...view.idx.below.keys()]).size;
      parts.push(`<div class="tg-stats">
        <div><b>${th.length}</b><span>thoughts</span></div>
        <div><b>${d.stats.drafts}</b><span>drafts</span></div>
        <div><b>${withReasoning}<small>/${d.commits.length}</small></b><span>commits with reasoning</span></div>
      </div>`);
      const listOf = (title, items, note) => items.length
        ? `<div class="tg-dsec"><span class="tg-label">${title} · ${items.length}</span>${items.slice(0, 8).map((t) =>
          `<button type="button" class="tg-link" data-thought="${esc(t.id)}">${shape(t)}<span>${esc(t.text)}${note ? `<span class="tg-sub">${esc(note(t))}</span>` : ''}</span></button>`).join('')}${items.length > 8 ? `<span class="tg-dim">and ${items.length - 8} more</span>` : ''}</div>` : '';
      parts.push(listOf('Still open', th.filter((t) => t.outcome === 'open')));
      parts.push(listOf('Can come back', th.filter(reopenable), (t) => 'if ' + t.forces.filter((f) => f.revisit_if).map((f) => f.revisit_if.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase())).join(' · ')));
      parts.push(listOf('Stashed', th.filter((t) => t.outcome === 'stashed'), (t) => t.applied_to ? 'applied' : 'not applied yet'));
    }

    parts.push(`<div class="tg-dsec"><span class="tg-label">Tasks · ${issues.length}</span>${issues.length ? issues.map((i) => `
      <div class="issue-card">
        <div class="issue-head"><span class="issue-num">#${esc(i.number)}</span><span class="issue-branch-badge">${esc(i.branch)}</span></div>
        <div class="issue-title">${esc(i.title)}</div>
        <div class="issue-prompt">${esc(i.prompt_spec)}</div>
        <div class="issue-footer"><span>Status: <b>${esc(i.status)}</b></span></div>
      </div>`).join('') : '<span class="tg-dim">No tasks yet. "+ New Task" creates one.</span>'}</div>`);
    return parts.join('');
  }

  function renderDetail() {
    const el = $('tg-detail');
    if (!el) return;
    let html = '';
    if (view.sel && view.data && view.idx) {
      if (view.sel.type === 'thought' && view.idx.thoughtById.has(view.sel.id)) html = detailThought(view.idx.thoughtById.get(view.sel.id));
      else if (view.sel.type === 'commit' && view.idx.commitAt.has(view.sel.id)) html = detailCommit(view.data.commits[view.idx.commitAt.get(view.sel.id)]);
    }
    if (!html) { view.sel = null; html = detailOverview(); }
    else html = `<button type="button" class="tg-back" data-back="1">← Overview</button>` + html;
    el.innerHTML = html;
    const head = $('tg-detail-title');
    if (head) head.textContent = !view.sel ? 'Overview' : view.sel.type === 'thought' ? 'Thought' : 'Commit';
  }

  /* ───────────────────────────────────────────── chrome */

  function renderChrome() {
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === view.mode));
    for (const b of document.querySelectorAll('[data-outcome]')) {
      const on = view.outcomes.has(b.dataset.outcome);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const s = $('tg-summary');
    if (s && view.data) {
      const d = view.data;
      s.textContent = d.fallback ? d.commits.length + ' commits' :
        `${d.commits.length} commits · ${d.thoughts.length} thoughts` + (d.stats.drafts ? ` (${d.stats.drafts} drafts)` : '');
    }
  }

  function render() {
    renderChrome();
    renderList();
    renderDetail();
  }

  function select(sel, scroll) {
    view.sel = sel;
    if (sel && sel.type === 'thought') {
      const t = view.idx.thoughtById.get(sel.id);
      const g = t && view.idx.groups.get(t.group);
      if (g && !isOpen(g)) {
        if (view.mode === 'expanded') view.closed.delete(g.key); else view.open.add(g.key);
      }
      if (t && !view.outcomes.has(t.outcome)) view.outcomes.add(t.outcome);
    }
    render();
    if (scroll && sel) {
      const q = sel.type === 'thought' ? `[data-thought="${CSS.escape(sel.id)}"]` : `[data-row="${CSS.escape(sel.id)}"]`;
      const el = document.querySelector('#tg-list ' + q);
      if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }

  function toggle(key) {
    const g = view.idx.groups.get(key);
    if (!g) return;
    const opening = !isOpen(g);
    if (view.mode === 'expanded') { if (opening) view.closed.delete(key); else view.closed.add(key); }
    else if (opening) view.open.add(key); else view.open.delete(key);
    renderList();
  }

  function onClick(e) {
    const t = e.target.closest('[data-toggle],[data-thought],[data-commit],[data-back],[data-open-groups]');
    if (!t) return;
    const inDetail = !!t.closest('#tg-detail');
    if (t.dataset.toggle) toggle(t.dataset.toggle);
    else if (t.dataset.back) select(null);
    else if (t.dataset.openGroups) {
      for (const g of view.idx.below.get(t.dataset.openGroups) || []) {
        if (view.mode === 'expanded') view.closed.delete(g.key); else view.open.add(g.key);
      }
      if (view.mode === 'code') { view.mode = 'collapsed'; store.set('gitx.thoughtMode', view.mode); }
      select(view.sel, false);
      const el = document.querySelector(`#tg-list [data-row="${CSS.escape(t.dataset.openGroups)}"]`);
      if (el) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
    else if (t.dataset.thought) select({ type: 'thought', id: t.dataset.thought }, inDetail);
    else if (t.dataset.commit) select({ type: 'commit', id: t.dataset.commit }, inDetail);
  }

  function init(opts) {
    view.httpBase = opts.httpBase;
    document.addEventListener('click', (e) => {
      if (e.target.closest('#tg-list, #tg-detail')) onClick(e);
    });
    for (const b of document.querySelectorAll('[data-mode]')) {
      b.addEventListener('click', () => {
        view.mode = b.dataset.mode;
        store.set('gitx.thoughtMode', view.mode);
        render();
      });
    }
    for (const b of document.querySelectorAll('[data-outcome]')) {
      b.addEventListener('click', () => {
        const o = b.dataset.outcome;
        if (view.outcomes.has(o) && view.outcomes.size > 1) view.outcomes.delete(o); else view.outcomes.add(o);
        render();
      });
    }
    const input = $('layer-search-input');
    if (input) {
      let timer = null;
      input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { view.query = input.value.trim().toLowerCase(); renderChrome(); renderList(); }, 120);
      });
    }
    const list = $('tg-list');
    if (list && window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => {
        const w = list.clientWidth;
        if (w !== last) { last = w; drawGraph(); }
      }).observe(list);
    }
    renderList();
    renderDetail();
  }

  /* Called with every state the broker sends. Thoughts are refetched only when
   * the repository or the thought signature moved, so an agent connecting or a
   * task being created does not pull the whole layer again. */
  function onState(state) {
    view.state = state;
    const key = (state.activeRepo || '') + '|' + ((state.thoughtStats && state.thoughtStats.signature) || '');
    if (key !== view.fetchedFor) {
      if (view.data && !key.startsWith(view.fetchedFor.split('|')[0] + '|')) {
        view.open.clear(); view.closed.clear(); view.sel = null;
      }
      fetchData();
    } else if (!view.sel) renderDetail();
  }

  window.GraphView = { init, onState };
})();
