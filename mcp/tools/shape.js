/*
 * What the agent asked to receive: a gitx_related answer cut to a focus and
 * a size, by the agent's own choice (t-ef96bfc909).
 *
 * GitX is System 1 for the agent's System 2: it lowers the agent's load, and
 * every token it sends is a token the agent reads. On the 14 held-out
 * questions an agent that knew the project answered all of them in 1.4 calls
 * each, but the calls averaged 2,570 tokens - and the two cheapest, 770 and
 * 870 tokens of thinking only, were complete. Most of the rest was code trees
 * and maps a "what did we decide" question did not need. One fixed shape
 * charges every question for the largest one, so the agent chooses:
 *
 *   focus   "thinking"  decided and waiting thoughts, the topic summary, doc
 *                       pointers, and what each tree's commits settled - no
 *                       code lines; where the code is stays as one line each
 *           "code"      the map and the trees with their commits; the thinking
 *                       is counted, not given
 *           "both"      the whole answer (the default)
 *   budget  a ceiling in tokens. The answer is cut best-first until it fits,
 *           the least useful parts first - the order depends on whether the
 *           thinking or the code leads - and `cut` says what went and how to
 *           get it back, so a small budget loses nothing for good.
 *
 * Tokens are counted as the bench counts them: compact JSON over four.
 */

const tokensOf = (x) => Math.round(JSON.stringify(x).length / 4);
const cap = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const where = (t) => t.function + (t.ref ? ' (' + t.ref + ')' : '');

/* A tree's thinking without its code: the commits and what they settled. */
const thinkingOfTree = (t) => ({
  function: where(t),
  written_by: (t.written_by || []).map((w) => w.see ? { commit: w.commit, see: w.see } : { commit: w.commit, subject: w.subject, settled: w.settled }),
  open: t.open
});

export function shapeAnswer(body, { focus = 'both', budget = 0 } = {}) {
  const a = { ...body };
  const cut = [];
  if (focus === 'thinking') {
    if (a.map) {
      a.code_at = a.map.core;
      cut.push('the map and code lines - focus "code", or expand a name from code_at');
    }
    if (a.trees) a.settled_by_code = a.trees.map(thinkingOfTree);
    delete a.map; delete a.trees; delete a.lead;
  } else if (focus === 'code') {
    const held = (a.decided || []).length + (a.context || []).length;
    for (const k of ['decided', 'context', 'more_context', 'summaries', 'thinking', 'lead']) delete a[k];
    if (held) cut.push(held + ' thoughts about it - focus "thinking" gives them');
  }

  if (budget > 0) {
    const thinkingLeads = !!a.lead || focus === 'thinking';
    /* Least useful first. Each step cuts one thing and says how to get it. */
    const steps = [
      ['more_context', () => { delete a.more_context; }],
      ['summaries', () => { if (a.summaries) { a.summaries = a.summaries.map((s) => ({ topic: s.topic, title: s.title, read: s.read })); return 'topic summaries cut to their names - gitx_thought topic gives one in full'; } }],
      ['thinking', () => { if (a.thinking) { a.thinking = a.thinking.map((d) => ({ doc: d.doc, lines: d.lines })); return 'doc sections cut to where they are'; } }],
      ['wiring', () => { if (a.map && (a.map.wiring || a.map.surface)) { const n = (a.map.wiring || []).length + (a.map.surface || []).length; delete a.map.wiring; delete a.map.surface; delete a.map.open_any; return n + ' wiring and surface entries - ask with a larger budget'; } }],
      ...(thinkingLeads ? [
        /* The code goes; what its commits settled stays - that is thinking. */
        ['trees', () => { if (a.trees && a.trees.length) { a.settled_by_code = a.trees.map(thinkingOfTree); a.code_at = [...(a.code_at || []), ...a.trees.map(where)]; delete a.trees; return 'code lines of the trees - expand a name from code_at'; } }],
        ['settled_by_code', () => { if (a.settled_by_code && a.settled_by_code.length > 1) { a.settled_by_code = a.settled_by_code.slice(0, 1); return 'thinking of the second tree'; } }]
      ] : [
        ['second tree', () => { if (a.trees && a.trees.length > 1) { a.code_at = [...(a.code_at || []), ...a.trees.slice(1).map(where)]; a.trees = a.trees.slice(0, 1); return 'the second tree - expand its name'; } }],
        ['thoughts', () => { const n = (a.context || []).length + (a.decided || []).length; if (n > 2) { a.decided = (a.decided || []).slice(0, 1); a.context = (a.context || []).slice(0, 1); return (n - 2) + ' thoughts - focus "thinking" gives them'; } }]
      ]),
      ['reasons', () => { let n = 0; for (const t of a.trees || []) for (const w of t.written_by || []) if (w.why) { delete w.why; n++; } if (n) return 'why of ' + n + ' commits - git show gives the message'; }],
      ['code lines', () => { let n = 0; for (const t of a.trees || []) { const lines = String(t.code || '').split('\n'); if (lines.length > 12) { t.code = lines.slice(0, 12).join('\n') + '\n  …'; n++; } } if (n) return 'code lines past the first 12 - expand gives them'; }],
      ['core', () => { if (a.map && a.map.core && a.map.core.length > 4) { const n = a.map.core.length - 4; a.map.core = a.map.core.slice(0, 4); return n + ' core entries'; } }],
      ['texts', () => { let n = 0; for (const k of ['decided', 'context']) for (const t of a[k] || []) if (t.text && t.text.length > 160) { t.text = cap(t.text, 160); n++; } if (n) return n + ' thought texts cut to 160 characters - gitx_thought id gives one whole'; }],
      ['last thoughts', () => { const n = (a.context || []).length; if (n > 2) { a.context = a.context.slice(0, 2); return (n - 2) + ' waiting thoughts'; } }],
      ['trees', () => { if (a.trees && a.trees.length) { a.code_at = [...(a.code_at || []), ...a.trees.map(where)]; delete a.trees; return 'code trees - expand a name from code_at'; } }]
    ];
    for (const [, step] of steps) {
      if (tokensOf({ ...a, cut }) <= budget) break;
      const said = step();
      if (said) cut.push(said);
    }
  }
  if (cut.length) a.cut = cut;
  return a;
}
