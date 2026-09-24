/* GitX — the commit graph with the thinking between its commits.
 *
 * Two graphs drawn as one. Code commits come from git; thought commits come
 * from .gitx/thoughts and .gitx/drafts, served by the
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
 *
 * Absence is drawn, not left blank. A commit with no thinking on record says
 * so in both thought modes, because "nobody recorded why" is an answer an
 * agent needs to be able to give - and a blank row cannot be told apart from a
 * row that failed to load.
 */
(function () {
  'use strict';

  const OUTCOMES = ['accepted', 'rejected', 'stashed', 'open'];
  const LANE_W = 16;
  const GUT_PAD = 20;
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const store = {
    get(k, d) { try { return localStorage.getItem(k) || d; } catch (_) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { /* private window */ } }
  };

  const view = {
    httpBase: '',
    state: null,
    /* The change log, read beside the thoughts: what one used to say, and
     * whether the log still verifies. Fetched per thought, once. */
    history: {},
    logStatus: null,
    data: null,             // { commits, thoughts, lanes, total, fallback, error, truncated }
    idx: null,              // derived lookups, rebuilt with data
    fetchedFor: '',
    mode: store.get('gitx.thoughtMode', 'collapsed'),   // code | collapsed | expanded | context
    open: new Set(),        // groups opened by hand in collapsed mode
    closed: new Set(),      // groups closed by hand in expanded mode
    sel: null,              // { type: 'commit' | 'thought', id }
    outcomes: new Set(OUTCOMES),
    query: '',
    /* The context graph view: what it is filtered to, how it is grouped, and
     * which groups are open. Grouping is remembered - it is a way of reading,
     * and whichever someone prefers they prefer every time. */
    ctxFilter: 'all',
    ctxGroup: store.get('gitx.contextGroup', 'discussion'),   // discussion | waiting
    ctxOpen: null           // Set of open group keys; null until the first draw picks one
  };
  /* "Thoughts stashed" became the context graph, which holds the stashes. */
  if (view.mode === 'stashed') view.mode = 'context';

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  const short = (h) => (h && h !== 'genesis' ? h.slice(0, 7) : h || '');
  const cap = (s, n) => (!s || s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, '') + '…');
  const day = (iso) => {
    const d = new Date(iso);
    return isNaN(d) ? '' : d.getDate() + ' ' + MONTHS[d.getMonth()];
  };
  const stamp = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return day(iso) + ' ' + d.getFullYear() + ', ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  };

  /* ───────────────────────────────────────────── data */

  /* One key for 'what this page was drawn from', used by fetchData and onState
   * alike - built two ways, every state message would look like a change. */
  const keyOf = (st) => (st.activeRepo || '') + '|' + (st.head || '') + '|' + ((st.thoughtStats && st.thoughtStats.signature) || '');

  async function fetchData() {
    const st = view.state || {};
    const key = keyOf(st);
    view.fetchedFor = key;
    try {
      const res = await fetch(view.httpBase + '/api/thoughts', { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const payload = await res.json();
      if (view.fetchedFor !== key) return;          // a newer repo switch overtook this one
      /* A broker from before the context graph sends none - said in the view,
       * rather than drawn as an empty graph that looks like nothing waits. */
      view.data = { ...payload, fallback: false, context: payload.context || { thoughts: [], stashes: [], stats: { count: 0 }, missing: true } };
    } catch (err) {
      /* An older broker has no /api/thoughts. The commits still draw, from the
       * graph payload it already ships - one lane, no thoughts, and a note. */
      const pg = (st.projectGraph && st.projectGraph.commits) || [];
      view.data = {
        commits: pg.slice().reverse().map((c) => ({ h: c.h, p: [], d: c.date, s: c.subject, lane: 0 })),
        thoughts: [], stashes: [], lanes: 1, total: pg.length, fallback: true, error: err.message, stats: { count: 0 },
        context: { thoughts: [], stashes: [], stats: { count: 0 }, missing: true }
      };
    }
    buildIndex();
    render();
    checkLog();
  }

  /* One read on load: how much has been recorded, and whether the chain holds.
   * A log that does not verify is worth saying loudly - it means an entry was
   * changed or removed after it was written. */
  async function checkLog() {
    view.history = {};
    view.logStatus = null;
    try {
      const res = await fetch(view.httpBase + '/api/thoughts/log?limit=1', { cache: 'no-store' });
      if (!res.ok) return;
      const log = await res.json();
      view.logStatus = { recorded: log.recorded || 0, tampered: log.tampered || null };
    } catch (_) { /* an older broker has no log; the page simply does not show one */ }
    renderDetail();
  }

  async function loadHistory(id) {
    if (view.history[id]) return;
    view.history[id] = { loading: true };
    try {
      const res = await fetch(view.httpBase + '/api/thoughts/log?limit=20&id=' + encodeURIComponent(id), { cache: 'no-store' });
      view.history[id] = res.ok ? await res.json() : { entries: [] };
    } catch (_) { view.history[id] = { entries: [] }; }
    if (view.sel && view.sel.type === 'thought' && view.sel.id === id) renderDetail();
  }

  function buildIndex() {
    const d = view.data;
    const commitAt = new Map(d.commits.map((c, i) => [c.h, i]));
    const total = d.total || d.commits.length;
    const ordinal = new Map(d.commits.map((c, i) => [c.h, total - i]));
    /* Context-graph thoughts can be looked up - a link, a stash or the details
     * panel may name one - but are never filed under a commit below: they are
     * waiting for one. */
    const ctx = d.context || { thoughts: [], stashes: [] };
    for (const t of ctx.thoughts) t.inContext = true;
    const thoughtById = new Map([...d.thoughts, ...ctx.thoughts].map((t) => [t.id, t]));

    /* Pooled by anchor AND talk, exactly as the reader pools them - see
     * thought-query.js. A thought without a talk (the backfill) pools by its
     * anchor alone, as before. */
    const byAnchor = new Map();
    for (const t of d.thoughts) push(byAnchor, t.anchor + '|' + (t.talk || ''), t);
    const groups = new Map();
    for (const list of byAnchor.values()) {
      const anchor = list[0].anchor;
      const votes = new Map();
      for (const t of list) if (t.led_to) votes.set(t.led_to, (votes.get(t.led_to) || 0) + 1);
      /* A tie goes to the earliest commit (the first thing the talk produced),
       * so the fallback cannot flip between runs. */
      const shared = [...votes.entries()].sort((a, b) => (b[1] - a[1]) || ((commitAt.get(b[0]) ?? -1) - (commitAt.get(a[0]) ?? -1)))[0];
      /* A thought with no commit of its own follows the one it is tied to -
       * the choice a rejection lost to, the decision a cost belongs to, the
       * rejection a rule was learned from - within the same talk, so it sits
       * beside it even when that choice led to a later commit than the rest. */
      /* Then by citation: a finding goes with the decision whose force cites
       * it, and a thought with neither follows what its own forces cite. */
      const local = new Map(list.map((x) => [x.id, x]));
      const citedBy = new Map();
      for (const x of list) for (const f of x.forces) for (const c of f.cites || []) push(citedBy, c, x);
      /* An accepted decision or cost with no commit is decided but not yet
       * committed - it, and whatever is tied to it, stays "not in a commit
       * yet" rather than being filed under a commit that did not carry it. */
      const PENDING = '-';
      const follow = (x, depth) => {
        if (x.led_to) return x.led_to;
        if (x.outcome === 'accepted' && (x.kind === 'decision' || x.kind === 'cost')) return PENDING;
        if (depth > 2) return null;
        const next = [
          ...x.links.filter((l) => l.type === 'lost-to' || l.type === 'cost-of' || l.type === 'derived-from').map((l) => local.get(l.to)),
          ...(citedBy.get(x.id) || []),
          ...x.forces.flatMap((f) => (f.cites || []).map((c) => local.get(c)))
        ];
        for (const y of next) {
          const r = y && y !== x && follow(y, depth + 1);
          if (r) return r;
        }
        return null;
      };
      for (const t of list) {
        const found = follow(t, 0);
        const ledTo = found === PENDING ? null : (found || (shared && shared[0]) || null);
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
    for (const t of [...d.thoughts, ...ctx.thoughts]) {
      for (const l of t.links) push(incoming, l.to, { type: l.type, from: t.id });
      if (t.applied_to) push(incoming, t.applied_to, { type: 'applied-from', from: t.id });
    }

    /* Stashes from both places: the context graph holds them now, and
     * .gitx/stash/ until the migration moves what is still there. */
    const stashes = [...(ctx.stashes || []), ...(d.stashes || [])];
    const stashOf = new Map();
    for (const s of stashes) for (const id of s.thoughts) stashOf.set(id, s);

    view.idx = { commitAt, ordinal, thoughtById, groups, below, above, unplaced, incoming, stashes, stashOf, context: ctx.thoughts };
  }

  function push(map, k, v) {
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(v);
  }

  const ord = (h) => (view.idx.ordinal.has(h) ? '#' + view.idx.ordinal.get(h) : '');
  /* The number a group is known by: the commit it led to, or failing that the
   * one it was anchored at. */
  function groupOrd(key) {
    const g = view.idx.groups.get(key);
    if (!g) return '';
    return ord(g.ledTo) || ord(g.anchor);
  }

  /* Status a thought is IN, as opposed to the outcome it was given: a rejection
   * held back only by a circumstance that can change is not closed for good. */
  function reopenable(t) {
    return t.outcome === 'rejected' && t.forces.some((f) =>
      f.direction === 'backward' && f.kind === 'contingent' && f.revisit_if && !f.superseded_by);
  }

  /* A thought is never rewritten - a later one supersedes it - so a question
   * answered that way stops counting as open. */
  function superseded(t) {
    return (view.idx.incoming.get(t.id) || []).some((l) => l.type === 'supersedes');
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
  const CHEVRON_RIGHT = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M3 1.5 L7 5 L3 8.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';
  const CHEVRON_DOWN = '<svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 3 L5 7 L8.5 3" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>';

  function counts(list) {
    const c = {};
    for (const t of list) c[t.outcome] = (c[t.outcome] || 0) + 1;
    return OUTCOMES.filter((o) => c[o]).map((o) =>
      `<span class="tg-count"><span class="tg-dot o-${o}"></span>${c[o]}${o === 'open' ? ' open' : ''}</span>`).join('');
  }

  /* What a group says about OTHER commits' thinking - "1 refines a thought in
   * #119" - read off its outgoing links. It is the part of the thought graph
   * that crosses commit boundaries, so it is shown even while the group is shut. */
  function crossNotes(g) {
    const tally = new Map();
    for (const t of g.thoughts) {
      for (const l of t.links) {
        if (l.type !== 'refines' && l.type !== 'supersedes') continue;
        const target = view.idx.thoughtById.get(l.to);
        if (!target || target.group === g.key) continue;
        const k = l.type + ' ' + groupOrd(target.group);
        tally.set(k, (tally.get(k) || 0) + 1);
      }
    }
    return [...tally.entries()].map(([k, n]) => {
      const [type, where] = k.split(' ');
      return `${n} ${type} a thought in ${where || 'an earlier commit'}`;
    });
  }

  function chipRow(g, pending) {
    const n = g.thoughts.length;
    const notes = crossNotes(g);
    if (pending) notes.unshift('not in a commit yet');
    return `<div class="tg-row tg-chiprow" data-chip="${esc(g.key)}">
      <span class="tg-ord"></span>
      <button type="button" class="tg-chip" data-toggle="${esc(g.key)}" aria-expanded="false">${CHEVRON_RIGHT}
        ${n} thought${n === 1 ? '' : 's'}${counts(g.thoughts)}</button>
      ${notes.map((x) => `<span class="tg-crossnote">${esc(x)}</span>`).join('')}
    </div>`;
  }

  function absentRow(c) {
    return `<div class="tg-row tg-absent" data-absent="${esc(c.h)}">
      <span class="tg-ord"></span><span class="tg-none">Nothing on record</span>
      <span class="tg-crossnote">no thinking was saved for ${esc(ord(c.h) || short(c.h))}</span></div>`;
  }

  function cardMeta(t) {
    const inc = view.idx.incoming.get(t.id) || [];
    if (t.outcome === 'rejected') {
      if (reopenable(t)) return '<span class="tg-meta tg-accent">reopenable</span>';
      const back = t.forces.find((f) => f.direction === 'backward' && f.kind);
      return back ? `<span class="tg-meta">${esc(back.kind)}</span>` : '';
    }
    if (t.outcome === 'stashed') return `<span class="tg-meta">${t.applied_to ? 'applied' : 'not applied'}</span>`;
    for (const type of ['supersedes', 'refines']) {
      const later = inc.find((l) => l.type === type);
      if (later) {
        const from = view.idx.thoughtById.get(later.from);
        const where = from ? groupOrd(from.group) : '';
        return `<span class="tg-meta">${type === 'supersedes' ? 'superseded' : 'refined'} by ${esc(where || 'a later thought')}</span>`;
      }
    }
    return t.kind === 'decision' && t.decided_by ? `<span class="tg-meta">${esc(t.decided_by === 'agent-delegated' ? 'delegated' : t.decided_by)}</span>` : '';
  }

  function card(t, extraCls) {
    const sel = view.sel && view.sel.type === 'thought' && view.sel.id === t.id ? ' is-selected' : '';
    return `<button type="button" class="tg-card${sel}${extraCls ? ' ' + extraCls : ''}" data-thought="${esc(t.id)}" title="${esc(t.text)}">
      ${shape(t)}<span class="tg-text">${esc(t.text)}</span>${cardMeta(t)}</button>`;
  }

  function box(g) {
    const list = g.thoughts.filter(shown);
    const buckets = { led: [], found: [], cost: [], turned: [], learned: [], stashed: [], open: [] };
    for (const t of list) {
      if (t.outcome === 'rejected') buckets.turned.push(t);
      else if (t.outcome === 'stashed') buckets.stashed.push(t);
      else if (t.outcome === 'open') buckets.open.push(t);
      else if (t.kind === 'finding') buckets.found.push(t);
      else if (t.kind === 'cost') buckets.cost.push(t);
      else if (t.kind === 'learned') buckets.learned.push(t);
      else buckets.led.push(t);
    }

    /* A rule learned from a rejection sits under that rejection, joined by the
     * derived-from edge, rather than in a list of its own away from its cause. */
    const learnedFrom = new Map();
    for (const t of buckets.learned) {
      const src = t.links.find((l) => l.type === 'derived-from' && buckets.turned.some((r) => r.id === l.to));
      if (src) push(learnedFrom, src.to, t);
    }
    const placed = new Set([...learnedFrom.values()].flat().map((t) => t.id));
    const turnedHtml = buckets.turned.map((r) => card(r) + (learnedFrom.get(r.id) || []).map((t) =>
      `<div class="tg-derived"><span>derived-from</span></div>${card(t, 'is-derived')}`).join('')).join('');
    const looseLearned = buckets.learned.filter((t) => !placed.has(t.id));

    const section = (title, items, html) => (items.length || html)
      ? `<div class="tg-sec"><span class="tg-label">${esc(title)}</span>${html || items.map((t) => card(t)).join('')}</div>` : '';
    const ledTitle = g.ledTo ? 'Led to ' + (ord(g.ledTo) || short(g.ledTo)) : 'Decided, not committed yet';
    const left = [section(ledTitle, buckets.led), section('Found', buckets.found), section('Costs kept', buckets.cost)];
    const right = [section('Turned down', buckets.turned, turnedHtml), section('Learned', looseLearned),
      section('Stashed', buckets.stashed), section('Still open', buckets.open)];

    const back = list.filter(reopenable);
    if (back.length) {
      const conds = back.flatMap((t) => t.forces.filter((f) => f.revisit_if && !f.superseded_by).map((f) => 'if ' + f.revisit_if.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase())));
      right.push(`<div class="tg-callout"><b>${back.length} turned-down idea${back.length === 1 ? '' : 's'} can come back</b><span>${esc([...new Set(conds)].join(' · '))}</span></div>`);
    }

    const ats = g.thoughts.map((t) => t.at).filter(Boolean).sort();
    const span = ats.length ? (day(ats[0]) === day(ats[ats.length - 1]) ? day(ats[0]) : day(ats[0]) + '–' + day(ats[ats.length - 1])) : '';
    const hidden = g.thoughts.length - list.length;
    const title = g.ledTo ? 'Thinking behind ' + (ord(g.ledTo) || short(g.ledTo)) : 'Thinking since ' + (ord(g.anchor) || short(g.anchor));
    const anchorTxt = g.anchor === 'genesis' ? 'before the first commit' : `${short(g.anchor)} <b>${esc(ord(g.anchor))}</b>`;
    return `<section class="tg-box" data-group="${esc(g.key)}">
      <div class="tg-box-head">
        <button type="button" class="tg-fold" data-toggle="${esc(g.key)}" aria-expanded="true" aria-label="Collapse">${CHEVRON_DOWN}</button>
        <b>${esc(title)}</b>
        <span class="tg-dim">${g.thoughts.length} thought${g.thoughts.length === 1 ? '' : 's'}${span ? ' · ' + esc(span) : ''}${hidden ? ' · ' + hidden + ' filtered out' : ''}</span>
        <span class="tg-grow"></span>
        <span class="tg-mono tg-dim tg-anchorline">anchored at ${anchorTxt}${g.ledTo ? ` → led to ${esc(short(g.ledTo))} <b>${esc(ord(g.ledTo))}</b>` : ''}</span>
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
    const strong = groupsHere.some(isOpen) && view.mode !== 'code' ? ' is-open' : '';
    /* Collapsed, an empty commit says so in its own row; expanded, the gap
     * below it gets a row of its own on the thought lane instead. */
    const none = view.mode === 'collapsed' && !groupsHere.length ? '<span class="tg-none">Nothing on record</span>' : '';
    return `<div class="tg-row tg-commit${sel}${dim}${strong}" data-row="${esc(c.h)}">
      <span class="tg-ord tg-mono">${esc(ord(c.h))}</span>
      <button type="button" class="tg-commit-btn" data-commit="${esc(c.h)}">
        <span class="tg-mono tg-hash">${esc(short(c.h))}</span><span class="tg-subj">${esc(c.s)}</span></button>
      ${none}
      <span class="tg-mono tg-date">${esc(day(c.d))}</span>
    </div>`;
  }

  /* The stash, for getting an idea back. Stashes first - the ones someone made
   * on purpose, kept before applied - then stashed thoughts no stash holds,
   * which is how a backfill records one. A reference is shown as written: it
   * may name another repository, and nothing here follows or checks it. */
  function stashSection() {
    const d = view.data;
    const { stashes, stashOf, thoughtById } = view.idx;
    const q = view.query;
    const refLine = (r) => {
      const here = r.thought && (!r.repo || r.repo === d.repo) && thoughtById.has(r.thought);
      const what = [r.repo ? `<span class="tg-ref-repo">${esc(r.repo)}</span>` : '',
        r.thought ? (here ? `<button type="button" class="tg-inline tg-mono" data-thought="${esc(r.thought)}">${esc(r.thought)}</button>` : `<span class="tg-mono">${esc(r.thought)}</span>`) : '',
        r.commit ? `<span class="tg-mono">${esc(short(r.commit))}${!r.repo || r.repo === d.repo ? ' ' + esc(ord(r.commit)) : ''}</span>` : ''].filter(Boolean).join(' · ');
      return `<div class="tg-ref"><div class="tg-ref-what">${what}</div>${r.why ? `<div class="tg-ref-why">${esc(r.why)}</div>` : ''}</div>`;
    };
    const stashCard = (s) => {
      const own = s.thoughts.map((id) => thoughtById.get(id)).filter(Boolean).filter((t) => !q || matches(t, q));
      const refs = s.references || [];
      if (q && !own.length && !(s.title + ' ' + s.note).toLowerCase().includes(q)) return '';
      return `<section class="tg-stash is-${esc(s.state)}">
        <div class="tg-stash-head">
          <svg class="o-stashed" width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">${SHAPES.decision}</svg>
          <b>${esc(s.title)}</b>
          <span class="tg-pill ${s.state === 'applied' ? 'tg-pill-accepted' : 'tg-pill-stashed'}">${s.state === 'applied' ? 'applied' : 'kept for later'}</span>
          <span class="tg-grow"></span>
          <span class="tg-dim tg-mono">${esc(s.id)}${s.created ? ' · ' + esc(day(s.created)) : ''}</span>
        </div>
        ${s.note ? `<p class="tg-stash-note">${esc(s.note)}</p>` : ''}
        ${s.applied_to ? `<div class="tg-dim">Applied to ${thoughtById.has(s.applied_to) ? `<button type="button" class="tg-inline" data-thought="${esc(s.applied_to)}">${esc(s.applied_to)}</button>` : esc(s.applied_to)}</div>` : ''}
        ${own.length ? `<div class="tg-sec"><span class="tg-label">Its thoughts</span>${own.map((t) => card(t)).join('')}</div>` : ''}
        ${refs.length ? `<div class="tg-sec"><span class="tg-label">Noted for later · ${refs.length} reference${refs.length === 1 ? '' : 's'}, not followed</span>${refs.map(refLine).join('')}</div>` : ''}
      </section>`;
    };
    const ordered = stashes.slice().sort((a, b) => (a.state === b.state ? 0 : a.state === 'kept' ? -1 : 1));
    const loose = [...d.thoughts, ...view.idx.context].filter((t) => t.outcome === 'stashed' && !stashOf.has(t.id) && (!q || matches(t, q)));
    loose.sort((a, b) => (view.idx.commitAt.get(a.led_to || a.anchor) ?? 1e9) - (view.idx.commitAt.get(b.led_to || b.anchor) ?? 1e9));

    const parts = [];
    const cards = ordered.map(stashCard).filter(Boolean);
    if (cards.length) parts.push(cards.join(''));
    if (loose.length) {
      parts.push(`<div class="tg-sec tg-loose"><span class="tg-label">Stashed thoughts not in a stash</span>${loose.map((t) => {
        const where = ord(t.group && view.idx.groups.get(t.group) ? (view.idx.groups.get(t.group).ledTo || t.anchor) : t.anchor);
        return `<div class="tg-loose-row">${card(t)}<span class="tg-crossnote">${t.applied_to ? 'applied' : 'not applied'}${where ? ' · raised at ' + esc(where) : ''}</span></div>`;
      }).join('')}</div>`);
    }
    if (!cards.length && !loose.length) {
      parts.push(`<div class="tg-empty">${q ? 'Nothing stashed matches this search.' : 'Nothing is stashed in this repository. A stash keeps an idea that was set aside on purpose, so it can be picked up later instead of rediscovered.'}</div>`);
    }
    return parts.join('');
  }

  /* ───────────────────────────────────────────── the context graph */

  /* What a waiting thought is waiting FOR - the question the view is sorted by.
   * A decided decision or cost has been settled in talk and waits for the
   * commit that builds it; an open one waits for someone to decide it. */
  const WAITING = [
    ['open', 'Open', 'Still open'],
    ['built', 'Decided, not built', 'Decided, not built'],
    ['found', 'Findings', 'Found'],
    ['turned', 'Turned down', 'Turned down'],
    ['stashed', 'Stashed', 'Stashed']
  ];
  const waitingFor = (t) => t.outcome === 'open' ? 'open' : t.outcome === 'rejected' ? 'turned' : t.outcome === 'stashed' ? 'stashed'
    : (t.kind === 'decision' || t.kind === 'cost') ? 'built' : 'found';
  const inContextView = (t) => t.inContext || view.idx.stashOf.has(t.id);

  /* The context graph: thinking no commit has settled yet, and the stashes.
   * Read here and never drawn on the commit graph - the thought graph speaks
   * for commits, and this is what is still waiting to become one. An interim
   * view: the context graph gets its own design once its uses are worked out. */
  function contextView() {
    const d = view.data;
    const all = view.idx.context;
    const shownHere = (t) => shown(t) && (view.ctxFilter === 'all' || waitingFor(t) === view.ctxFilter);
    const sinceHead = all.filter((t) => d.commits[0] && t.anchor === d.commits[0].h).length;
    const stashCount = view.idx.stashes.length;
    /* Stashed counts what the stashes section holds - a stash's own thoughts
     * and stashed thoughts outside one, in either graph - so the chip and the
     * section below it never disagree while older stashes wait to be moved. */
    const stashedIds = new Set([
      ...view.idx.stashes.flatMap((s) => s.thoughts),
      ...[...d.thoughts, ...all].filter((t) => t.outcome === 'stashed').map((t) => t.id)
    ]);
    const count = (k) => k === 'stashed' ? stashedIds.size : all.filter((t) => waitingFor(t) === k).length;
    const waitingN = all.filter((t) => t.outcome !== 'stashed').length;

    const parts = [];
    parts.push(`<div class="tg-stash-title"><b>Context graph</b><span class="tg-dim">${waitingN} thought${waitingN === 1 ? '' : 's'} waiting for a commit`
      + (sinceHead ? ` · ${sinceHead} written since HEAD` : '') + (stashCount ? ` · ${stashCount} stash${stashCount === 1 ? '' : 'es'}` : '') + '</span>'
      + (d.context && d.context.missing ? '' : `<span class="tg-grow"></span><span class="tg-ctx-by"><span class="tg-dim">Group by</span>${[['discussion', 'Discussion'], ['waiting', 'What it waits for']].map(([k, label]) =>
        `<button type="button" class="tg-ctx-f${view.ctxGroup === k ? ' is-on' : ''}" data-ctx-group="${k}" aria-pressed="${view.ctxGroup === k}">${label}</button>`).join('')}</span>`)
      + '</div>');
    if (d.context && d.context.missing) {
      parts.push('<div class="tg-empty">This broker was started before the context graph existed, so it sends none. Restart it to see what is waiting.</div>');
      return parts.join('');
    }
    const filters = [['all', 'All', waitingN + stashedIds.size], ...WAITING.map(([k, label]) => [k, label, count(k)])];
    parts.push(`<div class="tg-ctx-bar">${filters.map(([k, label, n]) =>
      `<button type="button" class="tg-ctx-f${view.ctxFilter === k ? ' is-on' : ''}" data-ctx-filter="${k}" aria-pressed="${view.ctxFilter === k}">${esc(label)} <span class="tg-dim">${n}</span></button>`).join('')}
    </div>`);

    /* Groups: by the discussion a thought came out of - the commit it was
     * written after, the nearest thing to a topic until sets are named - or by
     * what it waits for. Stashed thoughts live in the stashes at the bottom. */
    const groups = [];
    const pool = all.filter((t) => t.outcome !== 'stashed');
    if (view.ctxGroup === 'waiting') {
      for (const [k, label] of WAITING) {
        if (k === 'stashed') continue;
        groups.push({ key: 'w:' + k, head: `<b>${esc(label)}</b>`, thoughts: pool.filter((t) => waitingFor(t) === k) });
      }
    } else {
      const byAnchor = new Map();
      for (const t of pool) push(byAnchor, t.anchor, t);
      const at = (h) => view.idx.commitAt.has(h) ? view.idx.commitAt.get(h) : 1e9;
      for (const [anchor, list] of [...byAnchor].sort((a, b) => at(a[0]) - at(b[0]))) {
        const c = view.idx.commitAt.has(anchor) ? d.commits[view.idx.commitAt.get(anchor)] : null;
        groups.push({
          key: 'a:' + anchor,
          head: `<span class="tg-dim">after</span><b>${esc(ord(anchor) || short(anchor))}</b><span class="tg-mono tg-dim">${esc(short(anchor))}</span>`
            + `<span class="tg-ctx-subject">${c ? esc(c.s) : 'not in the history shown'}</span>`,
          date: c ? day(c.d) : '',
          thoughts: list
        });
      }
    }
    if (!view.ctxOpen) view.ctxOpen = new Set(groups.length ? [groups[0].key] : []);

    const section = (label, list) => list.length ? `<div class="tg-sec"><span class="tg-label">${esc(label)}</span>${list.map((t) => card(t)).join('')}</div>` : '';
    let drawn = 0;
    for (const g of groups) {
      const list = g.thoughts.filter(shownHere);
      if (!list.length) continue;
      drawn += list.length;
      const open = view.query || view.ctxFilter !== 'all' || view.ctxOpen.has(g.key);
      parts.push(`<section class="tg-ctx-group${open ? ' is-open' : ''}">
        <button type="button" class="tg-ctx-head" data-ctx-toggle="${esc(g.key)}" aria-expanded="${open}">${open ? CHEVRON_DOWN : CHEVRON_RIGHT}${g.head}
          <span class="tg-grow"></span><span class="tg-dim">${list.length}${g.date ? ' · ' + esc(g.date) : ''}</span></button>
        ${open ? `<div class="tg-ctx-body">${view.ctxGroup === 'waiting'
          ? list.map((t) => card(t)).join('')
          : WAITING.filter(([k]) => k !== 'stashed').map(([k, , label]) => section(label, list.filter((t) => waitingFor(t) === k))).join('')}</div>` : ''}
      </section>`);
    }
    if (view.ctxFilter === 'all' || view.ctxFilter === 'stashed') {
      parts.push(`<div class="tg-stash-title tg-ctx-stashes"><b>Stashes</b><span class="tg-dim">set aside on purpose</span></div>`);
      parts.push(stashSection());
    } else if (!drawn) {
      parts.push(`<div class="tg-empty">${view.query ? 'Nothing waiting matches this search.' : 'Nothing is waiting in this group.'}</div>`);
    }
    if (!all.length && !stashCount) {
      parts.push('<div class="tg-empty">Nothing is waiting: every thought on record is in the thought graph, settled by a commit or tied to one.</div>');
    }
    return parts.join('');
  }

  /* In the graph modes, one line instead of drawing any of it. */
  function contextPointer() {
    const d = view.data;
    const all = view.idx.context;
    if (!all.length) return '';
    const open = all.filter((t) => t.outcome === 'open').length;
    const sinceHead = all.filter((t) => d.commits[0] && t.anchor === d.commits[0].h).length;
    return `<button type="button" class="tg-ctx-pointer" data-ctx-open="1">
      <span>${all.length} thought${all.length === 1 ? '' : 's'} waiting in the context graph</span>
      <span class="tg-dim">${open ? `· ${open} open` : ''}${sinceHead ? ` · ${sinceHead} since HEAD` : ''}</span>
      <span class="tg-grow"></span><span class="tg-ctx-go">Open context graph →</span></button>`;
  }

  function renderList() {
    const list = $('tg-list');
    if (!list) return;
    const d = view.data;
    if (!d) { list.innerHTML = '<div class="tg-empty">Loading the graph…</div>'; return; }
    if (view.mode === 'context') {
      list.innerHTML = contextView();
      list.dataset.mode = 'context';
      list.style.setProperty('--tg-gutter', '16px');
      return;
    }
    if (!d.commits.length) { list.innerHTML = '<div class="tg-empty">This repository has no commits yet.</div>'; return; }

    const { below, above, unplaced } = view.idx;
    const code = view.mode === 'code';
    const html = [];
    if (!code) html.push(contextPointer());
    for (const c of d.commits) {
      if (!code) for (const g of above.get(c.h) || []) html.push(isOpen(g) ? box(g) : chipRow(g, true));
      const here = below.get(c.h) || [];
      html.push(commitRow(c, here));
      if (code) continue;
      if (!here.length) { if (view.mode === 'expanded' && !view.query) html.push(absentRow(c)); continue; }
      for (const g of here) {
        if (view.query && !g.thoughts.some(shown)) continue;
        html.push(isOpen(g) ? box(g) : chipRow(g, false));
      }
    }
    if (!code && unplaced.length) {
      const n = unplaced.reduce((s, g) => s + g.thoughts.length, 0);
      html.push(`<div class="tg-empty">${n} thought${n === 1 ? ' is' : 's are'} anchored before the oldest commit shown.</div>`);
    }
    if (d.truncated) html.push(`<div class="tg-empty">Showing the newest ${d.commits.length} of ${d.total} commits.</div>`);
    list.innerHTML = html.join('') + '<svg class="tg-lines" aria-hidden="true"></svg>';
    list.dataset.mode = view.mode;
    const colhead = $('tg-colhead');
    for (const el of [list, colhead]) if (el) el.style.setProperty('--tg-gutter', gutter() + 'px');
    drawGraph();
  }

  const laneX = (l) => GUT_PAD + l * LANE_W;
  const thoughtX = () => GUT_PAD + Math.max(1, view.data.lanes) * LANE_W + 20;
  const gutter = () => view.mode === 'code' ? GUT_PAD + Math.max(1, view.data.lanes) * LANE_W + 8 : thoughtX() + 20;

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

    const mid = (el) => el.offsetTop + el.offsetHeight / 2;
    const y = new Map();
    for (const el of list.querySelectorAll('.tg-commit')) y.set(el.dataset.row, mid(el));
    const lane = new Map(view.data.commits.map((c) => [c.h, c.lane]));
    const out = [];

    for (const c of view.data.commits) {
      const x1 = laneX(c.lane), y1 = y.get(c.h);
      c.p.forEach((p, k) => {
        const y2 = y.get(p);
        if (y2 == null) { out.push(`<path class="g-edge" d="M${x1} ${y1} V${H}"/>`); return; }
        const x2 = laneX(lane.get(p));
        if (x1 === x2) out.push(`<path class="g-edge" d="M${x1} ${y1} V${y2}"/>`);
        else if (k === 0) out.push(`<path class="g-edge" d="M${x1} ${y1} V${y2 - 28} C${x1} ${y2 - 10} ${x2} ${y2 - 14} ${x2} ${y2}"/>`);
        else out.push(`<path class="g-edge" d="M${x1} ${y1} C${x1} ${y1 + 16} ${x2} ${y1 + 12} ${x2} ${y1 + 28} V${y2}"/>`);
      });
    }

    if (view.mode !== 'code') {
      const tx = thoughtX();
      const diamond = (cy, cls) => `<path class="g-thought ${cls}" d="M${tx - 6} ${cy} L${tx} ${cy - 6} L${tx + 6} ${cy} L${tx} ${cy + 6} Z"/>`;
      /* led to: from the thinking UP to the commit it produced, solid.
       * anchored at: from the commit it started on UP to the thinking, dotted. */
      const ledTo = (h, top) => {
        if (!h || !y.has(h)) return;
        const cx = laneX(lane.get(h)), cy = y.get(h);
        out.push(`<path class="g-led" d="M${tx} ${top} C${tx} ${cy + 14} ${cx} ${cy + 16} ${cx} ${cy + 7}"/>`);
      };
      const anchoredAt = (h, bottom) => {
        if (!h || !y.has(h)) return;
        const cx = laneX(lane.get(h)), cy = y.get(h);
        out.push(`<path class="g-anchor" d="M${cx} ${cy - 7} C${cx} ${cy - 18} ${tx} ${bottom + 14} ${tx} ${bottom}"/>`);
      };

      for (const el of list.querySelectorAll('.tg-box')) {
        const g = view.idx.groups.get(el.dataset.group);
        const top = el.offsetTop, bottom = top + el.offsetHeight, ny = top + 23;
        out.push(`<path class="g-spine" d="M${tx} ${ny + 6} V${bottom - 6}"/>`);
        out.push(`<path class="g-tick" d="M${tx + 6} ${ny} H${W + 12}"/>`);
        ledTo(g.ledTo, ny - 6);
        anchoredAt(g.anchor, bottom - 6);
        out.push(diamond(ny, 'is-filled'));
      }
      for (const el of list.querySelectorAll('.tg-chiprow')) {
        const g = view.idx.groups.get(el.dataset.chip);
        const cy = mid(el);
        ledTo(g.ledTo, cy - 6);
        anchoredAt(g.anchor, cy + 6);
        out.push(diamond(cy, ''));
      }
      for (const el of list.querySelectorAll('.tg-absent')) out.push(diamond(mid(el), 'is-empty'));
    }

    for (const c of view.data.commits) {
      if (!y.has(c.h)) continue;
      out.push(`<circle class="g-commit${c.p.length > 1 ? ' is-merge' : ''}" cx="${laneX(c.lane)}" cy="${y.get(c.h)}" r="6"/>`);
    }
    svg.innerHTML = out.join('');
  }

  /* ───────────────────────────────────────────── the details panel */

  function pill(text, cls, icon) { return `<span class="tg-pill ${cls || ''}">${icon || ''}${esc(text)}</span>`; }

  function thoughtLink(id, label) {
    const t = view.idx.thoughtById.get(id);
    if (!t) return `<span class="tg-dim">${esc(label)} ${esc(id)} (not on record)</span>`;
    return `<button type="button" class="tg-link" data-thought="${esc(id)}">${shape(t)}<span><span class="tg-link-type">${esc(label)}${t.group ? ' · ' + esc(groupOrd(t.group)) : ''}</span>${esc(t.text)}</span></button>`;
  }

  const LINK_WORDS = {
    'lost-to': 'Lost to', 'cost-of': 'Cost of', 'derived-from': 'Learned from', supports: 'Supports',
    refines: 'Refines', supersedes: 'Supersedes', contradicts: 'Contradicts'
  };
  const INCOMING_WORDS = {
    'lost-to': 'Beat', 'cost-of': 'Its cost', 'derived-from': 'Taught', supports: 'Supported by',
    refines: 'Refined by', supersedes: 'Superseded by', contradicts: 'Contradicted by', 'applied-from': 'Applied from stash'
  };
  const ARROW_BACK = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M12 7 H2.5 M6 3.5 L2.5 7 L6 10.5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';
  const ARROW_FWD = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M2 7 H11.5 M8 3.5 L11.5 7 L8 10.5" stroke="currentColor" stroke-width="1.6" fill="none"/></svg>';

  function detailThought(t) {
    const who = { user: 'Decided by you', agent: 'Decided by the agent', 'agent-delegated': 'Agent, delegated by you' }[t.decided_by];
    const pills = [
      pill(t.kind[0].toUpperCase() + t.kind.slice(1), '', shape(t)),
      pill(t.outcome[0].toUpperCase() + t.outcome.slice(1), 'tg-pill-' + t.outcome),
      reopenable(t) ? pill('Reopenable', 'tg-pill-open') : '',
      who ? pill(who) : ''
    ].join('');

    const forces = (dir, title) => {
      const list = t.forces.filter((f) => f.direction === dir);
      if (!list.length) return '';
      return `<div class="tg-dsec"><span class="tg-label">${title}</span>${list.map((f) => `
        <div class="tg-force ${dir}">
          <span class="tg-force-kind">${dir === 'backward' ? ARROW_BACK : ARROW_FWD}${dir === 'backward' ? 'Backward' : 'Forward'} force${f.kind ? ' · ' + esc(f.kind) : ''}</span>
          <span class="tg-force-text">${esc(f.text)}</span>
          ${f.revisit_if ? `<span class="tg-revisit"><span class="tg-dim">Revisit if</span><span>${esc(f.revisit_if.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase()))}</span></span>` : ''}
          ${f.superseded_by ? `<span class="tg-dim">No longer holds - see ${esc(f.superseded_by)}</span>` : ''}
        </div>`).join('')}</div>`;
    };

    const links = t.links.map((l) => thoughtLink(l.to, LINK_WORDS[l.type] || l.type));
    if (t.applied_to) links.push(thoughtLink(t.applied_to, 'Applied to'));
    const incoming = (view.idx.incoming.get(t.id) || []).map((l) => thoughtLink(l.from, INCOMING_WORDS[l.type] || l.type));
    const lostTo = t.outcome === 'rejected' && t.kind === 'decision' && !t.links.some((l) => l.type === 'lost-to')
      ? '<div class="tg-dsec"><span class="tg-label">Lost to</span><span class="tg-dim">Nothing. The whole idea was dropped, not beaten by an alternative.</span></div>' : '';

    const commitBtn = (h) => h === 'genesis' ? 'before the first commit'
      : view.idx.commitAt.has(h) ? `<button type="button" class="tg-inline" data-commit="${esc(h)}">${esc(short(h))}</button> · ${esc(ord(h))}` : esc(short(h));

    /* What it waits for, and for a decision made but not built, the line that
     * settles it: named in the commit that carries it out, it moves to the
     * thought graph when that commit lands. */
    const WAITING_WORDS = {
      open: 'An open question: nobody has settled it. Decide it before building on it.',
      built: 'Decided, not built: it waits for the commit that carries it out.',
      found: 'A finding no commit rests on yet.',
      turned: 'Turned down, and kept so it is not proposed again.',
      stashed: 'Set aside on purpose, to pick up later.'
    };
    const waiting = !t.inContext ? '' : `<div class="tg-dsec tg-waiting"><span class="tg-label">Waiting in the context graph</span>
      <span>${esc(WAITING_WORDS[waitingFor(t)])}</span>
      <span class="tg-dim">Written after ${commitBtn(t.anchor)} · not drawn on the commit graph</span>
      ${waitingFor(t) === 'built' ? `<span class="tg-dim">Settle it with the commit that builds it:</span>
        <span class="tg-trailer"><code>GitX-Thoughts: ${esc(t.id)}</code><button type="button" class="tg-copy" data-copy="GitX-Thoughts: ${esc(t.id)}">Copy</button></span>` : ''}
    </div>`;

    return `
      <span class="tg-mono tg-dim">${esc(t.id)}${t.provenance === 'inferred' ? ' · inferred later from a transcript' : ''}</span>
      <h2 class="tg-title">${esc(t.text)}</h2>
      <div class="tg-pills">${pills}</div>
      ${waiting}
      ${forces('backward', 'Held back by')}
      ${forces('forward', 'Pushed forward by')}
      ${lostTo}
      ${links.length ? `<div class="tg-dsec"><span class="tg-label">Links</span>${links.join('')}</div>` : ''}
      ${incoming.length ? `<div class="tg-dsec"><span class="tg-label">Linked from</span>${incoming.join('')}</div>` : ''}
      ${view.idx.stashOf.has(t.id) ? (() => {
        const s = view.idx.stashOf.get(t.id);
        return `<div class="tg-dsec"><span class="tg-label">In a stash</span><span><b>${esc(s.title)}</b> <span class="tg-dim">· ${s.state === 'applied' ? 'applied' : 'kept for later'} · ${esc(s.id)}</span></span>${s.note ? `<span class="tg-dim">${esc(s.note)}</span>` : ''}${(s.references || []).length ? `<span class="tg-dim">${s.references.length} reference${s.references.length === 1 ? '' : 's'} noted - open the context graph to read them.</span>` : ''}</div>`;
      })() : ''}
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
      </div>
      ${historySection(t)}`;
  }

  /* What this thought used to say. Nothing guards these files, so the log is
   * the only record that an edit happened at all - and the only copy of what
   * was there before. */
  const FIELD_WORDS = { text: 'what it says', outcome: 'outcome', decided_by: 'decided by', links: 'links', forces: 'forces', anchor: 'anchor', resulted_in: 'the commit it led to', applied_to: 'applied to', provenance: 'provenance', sources: 'sources', kind: 'kind', parent: 'parent', session: 'session' };
  const asText = (v) => {
    if (v === null || v === undefined) return 'nothing';
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.length + (v.length === 1 ? ' entry' : ' entries');
    if (typeof v === 'object') return v.commit ? short(v.commit) : 'a value';
    return String(v);
  };

  function historySection(t) {
    const log = view.history[t.id];
    if (!log) { loadHistory(t.id); return ''; }
    if (log.loading) return '';
    const entries = log.entries || [];
    const warn = log.tampered || (view.logStatus && view.logStatus.tampered);
    if (!entries.length && !warn) return '';
    const rows = entries.slice(0, 6).map((e) => {
      const when = `<span class="tg-hist-when">${esc(stamp(e.at))}${e.seen === 'while-unwatched' ? ' · noticed later' : ''}</span>`;
      if (e.event === 'removed') return `<div class="tg-hist"><b>deleted</b> ${when}<span class="tg-dim">a full copy is kept in the log, so it can be put back</span></div>`;
      if (e.event === 'added') return `<div class="tg-hist"><b>recorded</b> ${when}</div>`;
      const fields = Object.entries(e.fields || {}).map(([f, v]) =>
        `<div class="tg-hist-field"><span class="tg-dim">${esc(FIELD_WORDS[f] || f)}</span> <s>${esc(cap(asText(v.was), 90))}</s> → ${esc(cap(asText(v.now), 90))}</div>`).join('');
      return `<div class="tg-hist"><b>changed</b> ${when}${fields}</div>`;
    }).join('');
    return `<div class="tg-dsec"><span class="tg-label">History${entries.length > 6 ? ' · newest 6 of ' + entries.length : ''}</span>
      ${warn ? `<div class="tg-note tg-warn">The change log does not verify: ${esc(warn)}. An entry has been changed or removed since it was written, so this history may be incomplete.</div>` : ''}
      ${rows || '<span class="tg-dim">No change recorded since the watcher first saw it.</span>'}</div>`;
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
      ? `<button type="button" class="tg-inline" data-commit="${esc(p)}">${esc(short(p))}</button> ${esc(ord(p))}` : esc(short(p))).join(' · ') : 'none - first commit'}</span>`);
    const reasoning = all.length
      ? `<div class="tg-dsec"><span class="tg-label">Reasoning behind it</span>
          <div class="tg-counts">${all.length} thought${all.length === 1 ? '' : 's'}${counts(all)}</div>
          <button type="button" class="tg-btn" data-open-groups="${esc(c.h)}">Show them in the graph</button></div>`
      : `<div class="tg-dsec"><span class="tg-label">Reasoning behind it</span><span class="tg-dim">Nothing on record. No discussion was saved for this commit.</span></div>`;
    return `
      <span class="tg-mono tg-dim">${esc(ord(c.h))} · ${esc(c.h.slice(0, 12))} · ${esc(stamp(c.d))}</span>
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
    if (view.logStatus && view.logStatus.tampered) {
      parts.push(`<div class="tg-note tg-warn"><b>The change log does not verify.</b> ${esc(view.logStatus.tampered)}. Every change to a thought is logged with what it used to say; an entry has been changed or removed since it was written.</div>`);
    }

    if (d && d.fallback) {
      parts.push(`<div class="tg-note">This broker does not serve thoughts yet. Restart it to load <span class="tg-mono">.gitx/thoughts</span>.</div>`);
    } else if (d && !d.thoughts.length) {
      parts.push(`<div class="tg-note">No thoughts recorded for this repository yet, so every commit reads "Nothing on record". Thoughts are read from <span class="tg-mono">.gitx/thoughts</span>.</div>`);
    } else if (d) {
      const th = d.thoughts;
      const withReasoning = view.idx.below.size;
      parts.push(`<div class="tg-stats">
        <div><b>${th.length}</b><span>thoughts</span></div>
        ${typeof d.stats.inferred === 'number' ? `<div><b>${d.stats.inferred}</b><span>inferred later</span></div>` : ''}
        <div><b>${withReasoning}<small>/${d.commits.length}</small></b><span>commits with reasoning</span></div>
      </div>`);
      const listOf = (title, items, note) => items.length
        ? `<div class="tg-dsec"><span class="tg-label">${title} · ${items.length}</span>${items.slice(0, 8).map((t) =>
          `<button type="button" class="tg-link" data-thought="${esc(t.id)}">${shape(t)}<span>${esc(t.text)}${note ? `<span class="tg-sub">${esc(note(t))}</span>` : ''}</span></button>`).join('')}${items.length > 8 ? `<span class="tg-dim">and ${items.length - 8} more</span>` : ''}</div>` : '';
      parts.push(listOf('Still open', th.filter((t) => t.outcome === 'open' && !superseded(t))));
      parts.push(listOf('Can come back', th.filter((t) => reopenable(t) && !superseded(t)), (t) => 'if ' + t.forces.filter((f) => f.revisit_if).map((f) => f.revisit_if.replace(/\.$/, '').replace(/^./, (m) => m.toLowerCase())).join(' · ')));
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

  /* The glass thumb under the chosen mode. Placed without its spring the first
   * time, so the page does not open with the thumb sliding in from the left. */
  function placeThumb() {
    const modes = document.querySelector('.tg-modes');
    const thumb = modes && modes.querySelector('.tg-thumb');
    const on = modes && modes.querySelector('[data-mode][aria-pressed="true"]');
    if (!thumb || !on || !on.offsetWidth) return;
    const first = !thumb.dataset.placed;
    if (first) thumb.style.transition = 'none';
    thumb.style.setProperty('--tx', on.offsetLeft + 'px');
    thumb.style.setProperty('--tw', on.offsetWidth + 'px');
    if (first) { void thumb.offsetWidth; thumb.style.transition = ''; thumb.dataset.placed = '1'; }
  }

  function renderChrome() {
    for (const b of document.querySelectorAll('[data-mode]')) b.setAttribute('aria-pressed', String(b.dataset.mode === view.mode));
    placeThumb();
    for (const b of document.querySelectorAll('[data-outcome]')) {
      const on = view.outcomes.has(b.dataset.outcome);
      b.classList.toggle('active', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const s = $('tg-summary');
    if (s && view.data) {
      const d = view.data;
      const waitingN = (view.idx && view.idx.context.length) || 0;
      s.textContent = d.fallback ? d.commits.length + ' commits' :
        `${d.commits.length} commits · ${d.thoughts.length} thoughts` + (waitingN ? ` · ${waitingN} waiting` : '') + (d.stats.inferred ? ` · ${d.stats.inferred} inferred` : '');
    }
    const legend = $('tg-legend');
    if (legend) legend.hidden = view.mode === 'code' || view.mode === 'context';
    const colhead = $('tg-colhead');
    if (colhead) colhead.hidden = view.mode === 'context';
  }

  function render() {
    renderChrome();
    renderList();
    renderDetail();
  }

  const toGraph = () => { view.mode = 'collapsed'; store.set('gitx.thoughtMode', view.mode); };

  function select(sel, scroll) {
    view.sel = sel;
    /* Going TO something the current view cannot show switches to one that
     * can: a commit is on the graph; a waiting thought is only in the context
     * graph; a settled one is on the graph unless it sits in a stash, which
     * the context view shows. */
    if (sel && sel.type === 'commit' && scroll && view.mode === 'context') toGraph();
    if (sel && sel.type === 'thought') {
      const t = view.idx.thoughtById.get(sel.id);
      if (t && t.inContext) {
        if (view.mode !== 'context') { view.mode = 'context'; store.set('gitx.thoughtMode', view.mode); }
        if (view.ctxFilter !== 'all' && waitingFor(t) !== view.ctxFilter) view.ctxFilter = 'all';
        const key = view.ctxGroup === 'waiting' ? 'w:' + waitingFor(t) : 'a:' + t.anchor;
        if (view.ctxOpen) view.ctxOpen.add(key);
      } else if (t) {
        const g = view.idx.groups.get(t.group);
        if (view.mode === 'code' || (view.mode === 'context' && !inContextView(t))) toGraph();
        if (g && !isOpen(g)) {
          if (view.mode === 'expanded') view.closed.delete(g.key); else view.open.add(g.key);
        }
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
    const t = e.target.closest('[data-toggle],[data-thought],[data-commit],[data-back],[data-open-groups],[data-ctx-filter],[data-ctx-group],[data-ctx-toggle],[data-ctx-open],[data-copy]');
    if (!t) return;
    const inDetail = !!t.closest('#tg-detail');
    if (t.dataset.ctxFilter) { view.ctxFilter = t.dataset.ctxFilter; renderList(); return; }
    if (t.dataset.ctxGroup) {
      view.ctxGroup = t.dataset.ctxGroup;
      store.set('gitx.contextGroup', view.ctxGroup);
      view.ctxOpen = null;                         // the new grouping opens its first group
      renderList();
      return;
    }
    if (t.dataset.ctxToggle) {
      const k = t.dataset.ctxToggle;
      if (view.ctxOpen.has(k)) view.ctxOpen.delete(k); else view.ctxOpen.add(k);
      renderList();
      return;
    }
    if (t.dataset.ctxOpen) { view.mode = 'context'; store.set('gitx.thoughtMode', view.mode); render(); return; }
    if (t.dataset.copy) {
      const text = t.dataset.copy;
      const done = (ok) => { t.textContent = ok ? 'Copied' : 'Select and copy'; setTimeout(() => { t.textContent = 'Copy'; }, 1600); };
      if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => done(true), () => done(false)); else done(false);
      return;
    }
    if (t.dataset.toggle) toggle(t.dataset.toggle);
    else if (t.dataset.back) select(null);
    else if (t.dataset.openGroups) {
      for (const g of view.idx.below.get(t.dataset.openGroups) || []) {
        if (view.mode === 'expanded') view.closed.delete(g.key); else view.open.add(g.key);
      }
      if (view.mode === 'code' || view.mode === 'context') toGraph();
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
    window.addEventListener('resize', placeThumb);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeThumb);
    const list = $('tg-list');
    if (list && window.ResizeObserver) {
      let last = 0;
      new ResizeObserver(() => {
        const w = list.clientWidth;
        if (w !== last) { last = w; drawGraph(); }
      }).observe(list);
    }
    renderChrome();
    renderList();
    renderDetail();
  }

  /* Called with every state the broker sends. Refetched only when the
   * repository, the commit HEAD is on, or the thought signature moved - so an
   * agent connecting or a task being created does not pull everything again,
   * but a commit or a branch switch does. HEAD was missing from this key, and
   * a new commit left the page drawing the history it had, under a header
   * that already named the new branch. */
  function onState(state) {
    view.state = state;
    const key = keyOf(state);
    if (key !== view.fetchedFor) {
      if (view.data && !key.startsWith(view.fetchedFor.split('|')[0] + '|')) {
        view.open.clear(); view.closed.clear(); view.sel = null;
      }
      fetchData();
    } else if (!view.sel) renderDetail();
  }

  window.GraphView = { init, onState };
})();
