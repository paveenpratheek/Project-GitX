# Context map: plan

**Status:** planned, nothing built. Discussed 2026-09-24 and 2026-09-25 on the
`4th_Dimension` branch. Points marked *(assumed)* were proposed and not yet
confirmed.
**Scope:** one repository. Part of the 4th Dimension. Follows
`docs/context-graph-plan.md`, which is done.

## Goal

The context graph works, but nothing gives it shape. It only grows, it reads
as random, and a stash has no clear purpose. This plan gives it structure,
lets the user see it, and lets the user decide which part of it agents read.

- **Structure.** Every waiting thought belongs to a thread, and every thread
  to a domain.
- **See it.** A map of the context graph in GitX's sidebar, drawn as a
  network, where each domain is its own cluster.
- **Steer it.** The user sets a goal. The part of the map that serves it is
  active, and **the active part is what agents read** *(assumed)*. The rest
  is kept but not handed to agents.
  - *This reverses a rule set on 2026-09-23*: agents read the context graph
    only when they ask for it, never by default (t-e7567325ec). It needs the
    user's word before it is built. The alternative keeps that rule: the goal
    only lights the map and orders what `gitx_context` returns when asked.

The two graphs stay distinct:

| | Thought graph | Context graph |
|---|---|---|
| Answers | Why is the code the way it is? | What are we working on and thinking about now? |
| Unit | A commit | A thread, inside a domain |
| Grows | Only as commits land | Bounded: threads open and close |
| Editing | Settled; changed only by superseding | Working memory; condensed freely |
| Seen in | Graph Timeline, Visuals | The context map |

## Measured (2026-09-24)

| | GitX | ter-manager |
|---|---|---|
| Waiting thoughts | 93 | 138 |
| Linked to no other thought | 59 | 94 |
| Largest linked group | 13 | 5 |
| Grouped by the commit they came after | 15 groups, one of 38 | 62 groups, 29 of one thought |
| Text, as tokens | ~5k | ~4.7k |

Neither links nor anchors give topics. Links give fragments, and anchors pile
unrelated thoughts together because they came after the same commit. That is
why the page's "group by discussion" reads as random.

## Model

```
Domain        a lasting area of the project, a topic the user names
  └ Thread    one piece of ongoing work in it; opens and closes
      └ Thought   what the context graph holds today

Floating domains, one each, with no links until used:
  Open questions · Stashed · Rules
```

- **Domain.** Few and long-lived, about 5–9 per repository, named by the
  user. A topic, not a code folder, because some of the most important
  discussions, such as the 5th dimension, live in no folder *(assumed)*.
- **Thread.** Title, status, what it waits for, a short digest, and the agent
  working on it. Every waiting thought belongs to exactly one thread
  *(assumed)*. When a thread gets long, its digest is rewritten, and agents
  read the digest first *(assumed)*.
- **Floating domains.** Open questions, stashed ideas and learned rules are
  each a domain of their own. They sit on the map unconnected while unused.
  **When an agent uses one, it connects to the thread using it.** See
  "Use connects" below.

## States, and the goal

The user sets a **goal**, for example "Clean up the context graph". GitX
suggests which domains and threads serve it, from their text and how
recently they were worked on, and the user confirms *(assumed)*.

| State | On the map | What agents get |
|---|---|---|
| Active | full colour, thoughts spread out | read by default: `gitx_context`, catch-up *(assumed, see Goal)* |
| Dormant | grey, thoughts folded into the thread | nothing unless asked *(assumed)* |
| Parked | grey, with its wake-up condition | returns when a new goal matches its `revisit_if` |
| Closed | not drawn; archived | nothing |

A parked thread is what a stash was. Its `revisit_if` is what brings it back.

## The map

A force layout: nodes push apart, links pull together, and each domain
settles into its own cluster. Written in GitX with no library; a few hundred
nodes is small for this.

| Element | Drawn as |
|---|---|
| Thread | a large node, sized by how many thoughts it holds |
| Domain | the colour of its threads; one colour per domain |
| Thread to thread, same domain | thick line in the domain's colour |
| Thread to thread, across domains | thick line, where two domains touch |
| Accepted thought | small yellow dot, linked to its thread |
| Link between thoughts (cites, refines, cost-of ...) | thin blue line |
| Rejected thought | small red dot near its thread, **no line**; its `lost-to` line shows on hover or select |
| Open question, stashed idea, rule | a node in its floating domain; unconnected until used |
| Inactive domain | grey, collapsed to its thread nodes |

**Only the context graph is drawn.** Settled thoughts already have Graph
Timeline and Visuals, and mixing them in would bring back the clutter the
context graph removed.

Beside the map: the goal, with a control to change it; what is selected, with
its digest and thoughts; and a monitor strip. The strip shows what agents
read now and its token cost, growth over time, stale threads, and which agent
works on which thread.

It lives in a new **Context Map** view in GitX's sidebar *(assumed)*.

## Use connects

A floating node joins the working graph when an agent uses it:

- **Linked** (the agent records a thought that cites, refines, answers or
  supersedes it): a lasting edge to that thought's thread.
- **Read** (the agent opens it by id through `gitx_context` or
  `gitx_thought_search`): a light edge to the agent's current thread, which
  fades when the session ends.

Reading needs the trails to record `gitx_context` visits, which they do not
yet. That was already an open item.

## Storage

```
.gitx/context/
  domains.json          [{ id, name, colour, status, note }]
  goal.json             { text, set_by, at, active: [domain and thread ids] }
  threads/th-<id>.json  { title, domain, status, waiting_for, revisit_if,
                          digest, owner, opened, updated }
  thoughts/t-<id>.json  as today, plus  "thread": "th-<id>"
  archive/              closed threads and their leftover thoughts
```

A thought names its thread, and a thread names its domain: each link stays on
the side that makes it, as links do now. The reverse directions are built
when read. Everything here stays gitignored.

## Build order

Each step ends with a check, as in the context-graph plan.

1. **Threads and domains on disk.** The files above, the reader loading them,
   the watcher covering them. *Check:* the reader and page still place every
   thought exactly as before.
2. **Move the existing thoughts in.** GitX proposes threads and domains from
   links and word similarity; an agent names them; the user confirms. Dry run
   first, a manifest, and `--undo`, like the migration. *Check:* every
   waiting thought has one thread; nothing moved between graphs.
3. **Tools.** `gitx_thought_record` requires a thread and suggests one.
   `gitx_context` returns active digests by default. Catch-up shows the goal
   and the active domains. A way to set the goal and switch states. *Check:*
   over MCP stdio on a throwaway repository.
4. **Use connects.** Trails record `gitx_context` visits; linking and reading
   create edges. *Check:* a floating open question connects when answered.
5. **The Context Map view.** Designed first as a mockup from real data and
   agreed before it is built. *Check:* against a second broker on real data.
6. **Monitoring.** Token cost of the active part, growth, staleness.

## Not in this plan

- Several repositories on one map. That is the 5th dimension; domains and
  threads should carry nothing that stops it.
- Deleting thoughts. Closing archives them, and the change log keeps every
  version.
- A user-level rulebook shared across repositories.
