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
  active, and **the active part is what agents read**. The rest is kept but
  not handed to agents. The goal is how new information reaches agents.
  - *Decided 2026-09-25, and it replaces a rule of 2026-09-23* that agents
    read the context graph only when they ask for it (t-e7567325ec). A
    context graph read only on request never reaches the agent that needs it.

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
Domain        a KIND of content - the same set in every repository
  └ Topic     one subject of ongoing work, as a hub node in that domain
      └ Thought   what the context graph holds today

Working domains:   Goals & requirements · Thoughts & discussion ·
                   Information · Constraints · Criteria ·
                   Implementation & planning (added 2026-09-25: what is
                   to be built and in what order - by placement only)
Floating domains:  Rules · Bugs & open questions · Stashed
                   (no links until used)
```

- **Domain.** A kind of content, as the owner decided on 2026-09-23
  (t-6b0a5fa325) and confirmed on 2026-09-25. A thought's domain follows
  from its kind and outcome - a decision is discussion, a finding is
  information, a cost is a constraint, a learned rule is a rule, an open
  question is a question, a stashed idea is stashed - except where a thought
  is plainly something else: a requirement the user set is a goal, a finding
  that is a defect is a bug, a finding that limits what can be done is a
  constraint.
- **Topic.** One subject of work, named, e.g. "Context graph & map". It is
  the thread of the earlier proposal: title, status, what it waits for, a
  short digest, and the agent working on it. A topic appears as a hub in
  every domain that holds its thoughts, and **the same topic's hubs in two
  domains are joined** - that is the line between clusters in the owner's
  sketch. Every waiting thought belongs to exactly one topic *(assumed)*.
  When a topic gets long, its digest is rewritten, and agents read the
  digest first *(assumed)*.
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
| Active | full colour, thoughts spread out | read by default: `gitx_context`, catch-up |
| Dormant | grey, thoughts folded into the thread | nothing unless asked |
| Parked | grey, with its wake-up condition | returns when a new goal matches its `revisit_if` |
| Closed | not drawn; archived | nothing |

A parked thread is what a stash was. Its `revisit_if` is what brings it back.

## The map

A force layout: nodes push apart, links pull together, and each domain
settles into its own cluster. Written in GitX with no library; a few hundred
nodes is small for this.

| Element | Drawn as |
|---|---|
| Topic hub | a large node in its domain, sized by how many thoughts it holds there |
| Domain | the colour of its hubs, and a soft area around them; one colour per domain |
| Two topics in one domain whose thoughts link | thick line in the domain's colour |
| The same topic in two domains | thick line between the clusters |
| The goal | a node in Goals & requirements, holding that domain's hubs |
| Accepted thought | small yellow dot, linked to its thread |
| Link between thoughts (cites, refines, cost-of ...) | thin blue line |
| Rejected thought | small red dot near its thread, **no line**; its `lost-to` line shows on hover or select |
| Open question, stashed idea, rule | a node in its floating domain; unconnected until used |
| Dormant topic or domain | grey and smaller, its thoughts folded, no lines |

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

*As built in step 2* (`mcp/tools/topics.js`):

```
.gitx/context/
  goal.json               gitx.goal/0  { text, set_by, at,
                                         topics: [active topic ids],
                                         domains_off: [domain ids] }
  topics/tp-<key>.json    gitx.topic/0 { id, title, status, waiting_for,
                                         revisit_if, digest, owner,
                                         created, updated }
  thoughts/t-<id>.json    as before, plus "topic": "tp-<key>", and
                          "domain" only where placed by hand
  topics-manifest.json    the last assignment, for --undo
  archive/                (later) closed topics and their leftover thoughts
```

- **Domains are fixed in code,** not on disk: they are the same kinds of
  content in every repository. A thought's domain follows from its kind and
  outcome, so an open question that gets answered leaves the questions
  domain by itself. A `domain` field on the thought overrides that, only for
  what is plainly something else.
- **Domains are stored when switched off,** so one added later starts on.
- **A thought names its topic;** the topic does not list its thoughts. Each
  link stays on the side that makes it, as links do now, and the reverse is
  built when read. Everything here stays gitignored.

## Build order

Each step ends with a check, as in the context-graph plan. **The visual comes
first** (the owner, 2026-09-25): see the context graph as a map, then see how
agents use it, and let that shape the tools.

1. **The map, as a mockup from real data.** GitX's waiting thoughts grouped
   into proposed topics and domains, and drawn. It is the first look at the
   visual and the first proposal of the grouping, judged together. Nothing
   on disk changes.
   - *Built 2026-09-25, awaiting the owner's verdict:*
     `project gitx_TM/context-map-mockup/` - `build.cjs` groups the 100
     waiting thoughts into 11 topics across the 8 domains and writes
     `data.js`; `index.html` draws it with a force layout written for it;
     `serve.cjs` serves it. The goal "Build the context map" makes two topics
     active: agents would read 33 thoughts, about 1.7k tokens.
   - *Second version, the same day, from the owner's reference:* drawn like
     the Neo4j browser - labelled circles, edges with arrows and relationship
     names, draggable nodes that stay put - under iOS 26 Liquid Glass
     controls floating over the map, light and dark. A thought is grey and
     its outcome is its ring (yellow accepted, red rejected, hollow orange
     open), so the map stays mostly grey as in the reference.
2. **Topics, domains and the goal on disk.** The files above, the reader
   loading them, and the agreed grouping moved in: dry run first, a
   manifest, and `--undo`, like the migration. *Check:* every waiting thought
   has one topic; the reader and page still place every thought as before;
   nothing moved between graphs.
   - *Done 2026-09-25, GitX only.* `mcp/tools/topics.js` holds the domains
     and reads topics and the goal; the page's payload carries each waiting
     thought's topic and domain and the map; the broker's refetch signature
     covers topics and the goal. `mcp/assign-topics.js` writes a grouping
     spec - the same `grouping-gitx.json` the mockup is drawn from, so the
     two cannot drift. Applied to GitX: 11 topics, the goal, 106 thoughts
     (13 placed by hand), none left out. On a copy first: 13 checks, undo
     byte for byte. On the real repository the page and reader still file
     all 924 thoughts alike and no thought changed graphs.
   - *Not yet:* ter-manager's 138 waiting thoughts need a grouping of their
     own, proposed and agreed the same way. The watcher logs a thought
     gaining its topic, since that is a thought edit; the topic and goal
     files themselves get history in step 3, when the view starts writing
     them. A newly recorded thought has no topic until step 4 makes the
     record tool ask for one; the map shows it as unsorted.
3. **The Context Map view,** as the mockup was agreed, reading the files.
   Switching a domain or thread on and off, and setting the goal, from the
   map. *Check:* against a second broker on real data.
   - *Done 2026-09-25.* "Context Map" in GitX's sidebar (`js/context-map.js`),
     drawn from the same `/api/thoughts` payload the timeline fetches.
     Switches and the goal editor save through `POST /api/context/goal`,
     which checks a change whole and writes `goal.json` (`writeGoal` in
     `mcp/tools/topics.js`); `GET /api/context/suggest` is "GitX suggests" -
     topics ranked by the goal's words in their titles and thoughts, and by
     recent work - and the user confirms. The watcher now records topic and
     goal changes with their old values (`goal-changed`, `topic-changed` ...)
     and tells the broker after every sweep, so a recorded thought or a
     changed goal reaches the page without waiting for a commit. A
     repository with no grouping shows "Unsorted" hubs, and agents read none
     of it. Checked on a throwaway clone of GitX behind a second broker:
     switching a topic and a domain moved what agents read (39 → 40 → 32
     thoughts), the goal editor suggested Branches & anchors for "Fix branch
     anchors after a rebase" and saved it, both goal changes were logged
     live, bad changes were refused with each problem named, the timeline
     still worked beside it, and the real goal was untouched. The earlier
     watcher, promotion and broker checks still pass. The mockup in
     `project gitx_TM` is superseded.
4. **Agents read the active part.** `gitx_context` returns active digests by
   default, catch-up shows the goal and the active domains, and
   `gitx_thought_record` requires a thread and suggests one. *Check:* over
   MCP stdio on a throwaway repository.
5. **Use connects.** Trails record `gitx_context` visits; linking and reading
   create edges, and the map shows them. *Check:* a floating open question
   connects when answered.
6. **Monitoring.** Token cost of the active part, growth, staleness.

## Not in this plan

- Several repositories on one map. That is the 5th dimension; domains and
  threads should carry nothing that stops it.
- Deleting thoughts. Closing archives them, and the change log keeps every
  version.
- A user-level rulebook shared across repositories.
