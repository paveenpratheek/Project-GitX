# Agent marks: plan

**Status:** built on the `GitX-investigate` branch, 17 October 2026, except
where marked *not built* below. Agreed with the owner 2026-10-17 on `master`
(d9ec6c5); `gitx_mark` came from the `gitx-mark` branch (53cbac4).
**Scope:** one repository at a time; any number of agents. Cross-repository
marks belong to the 5th Dimension and are out of scope.

## Goal

Let GitX be useful on a repository that has no GitX record yet, and let that
record grow from the work agents already do. An agent investigating code
leaves a **mark** - a short note on the code region it learned something
about - and links marks across files when it finds that they belong together.
GitX stores, finds, checks and fades marks the way it handles commits and
thoughts, so the next agent - or the owner investigating the repository -
starts from what earlier agents worked out.

## Why

Measured between 9 and 17 October:

- GitX's value is the recorded reasoning, not the search. Where the reasoning
  exists, GitX wins on cost and holds or improves accuracy: ter-manager's
  why-questions 75% recall against 55% by hand at 0.31x the cost; heldout3
  within 3-4 points of a hard-working hand search at a third to a sixth of the
  tokens (t-454c4c4232, t-aecd0f7a5a).
- Where it does not, an agent with Grep is as good and cheaper (t-06de59f577,
  t-45f4d12f4e). A repository that has never been recorded the GitX way has
  nothing for GitX to serve.
- Learning from agents' walks moved results by one or two answers at most
  (t-ccb7f41c59, t-f517951476): a walk records where an agent went, not what
  it understood.
- Agents do not use an option they are not shown: 0 of 5 used `feature`, 0 of
  30 used `gitx_mark`, even with a hint under every answer (t-ac4ecf0495,
  t-5dd03954f9).

## Three kinds of repository

| State | Example | What GitX serves | Who adds knowledge |
|---|---|---|---|
| Recorded the GitX way | Project GitX | code, commits, thoughts, topics | the owner and agents, with each commit |
| Recorded but unlinked | ter-manager | what is there; an arrival step links it | a mostly mechanical linking pass |
| Bare | a new repository | marks, as they accumulate | agents, while they investigate - starting from any `CLAUDE.md`, `.claude/`, `AGENTS.md` or `.agent/` it has |

The owner uses the same entry point on all three: investigate a repository
through GitX, whatever state it is in.

## Definitions

- **Mark**: a note an agent leaves on code it investigated: what it learned
  there, in one or two sentences, with the evidence (the lines it read, the
  commit it read) and links to other marks.
- **Inferred**: a mark's standing. A mark is an agent's understanding, not a
  decision anyone made, and every reader shows it as such:
  `INFERRED by an agent from <lines> - confirmed by n, contradicted by m`.
  Decisions and rules stay in the thought graph; a mark never becomes one by
  itself.
- **Anchor**: where a mark is attached. A line's identity is the commit that
  wrote it and its line in that commit - the identity thermal vision already
  uses - so a mark follows code that moves and is retired when the lines it
  describes are rewritten. The region key (`file::function`) is kept beside it
  for display.
- **Confirm / contradict**: a later agent that reads a mark and finds it holds
  confirms it; one that finds it wrong contradicts it, with its own evidence.

## Design

### 1. The mark

```
{ id: "m-<10 hex>", repo, at: [{ commit, line, to }], region: "file::function",
  note: "...", evidence: { read: ["file:a-b"], commits: ["<hash>"] },
  links: [{ to: "m-..." | "t-..." | "<hash>", as: "same-feature" | "calls" |
            "styles" | "explains" | "contradicts" }],
  by: agent, at_time, confirmed: [...], contradicted: [...], status }
```

Stored in the GitX data folder, `<data>/marks/<repo key>/`, one file per mark,
beside walks and heat - owner-only like every thought, never inside a
repository, and the same for every clone, since a repository is known by its
first commit. *Changed while building:* the plan said `.gitx/marks/`, but the
bench gives every agent a fresh copy of the repository and the owner works
across clones, so marks kept inside one would vanish between rounds. Without a
data folder they fall back to `.gitx/marks/`, git-ignored with the rest of
`.gitx`. Nothing writes into the code.

### 2. Making marks

Marking must cost the agent almost nothing, or it eats the efficiency that is
GitX's main advantage. Two paths:

- **Automatic** (default): hook.js already reads the final answer's citations
  at Stop (`file::function`, `file:line`, thought ids). A citation of code the
  agent reached with its own tools, after a GitX search that did not show it,
  becomes a mark with no note - "this code answered: <the question>". Zero
  tokens for the agent.
- **Explicit**: `gitx_mark { to, note, link }` when the agent learned something
  not obvious from the code itself - about 30 tokens out and a line back. The
  tool exists on the `gitx-mark` branch; it gains `link` and the duplicate
  check below.

The GitX skill (Claude Code and Antigravity) states when to mark: after
working something out that took reading several places or that the code does
not say plainly; never to restate what a function's name already says.

### 2b. Seeding from what the repository already says

Many repositories already carry knowledge written for agents: `CLAUDE.md` and
`.claude/` (instructions, skills, launch settings), `AGENTS.md` and
`.agent/` / `.agents/` (Antigravity and others), and READMEs. An agent arriving
at a repository with no GitX record reads these first - they are the cheapest
way to learn the code - and turns what they say about specific code into
marks:

- a statement that names code (a function, a constant, a file, a CSS rule)
  becomes a mark on that code, its note the statement in a sentence;
- the mark's source is the file and section, and its standing is
  `FROM CLAUDE.md, "Things that will look like they need simplifying" 2` -
  written on purpose by whoever wrote the file, so above an agent's inference
  and below a recorded decision;
- a statement that names no code (a rule of work, a convention) is left to the
  agent, which the skill tells to record it with `gitx_thought_record` (kind
  `learned`) if it matters - *changed while building:* writing them as thoughts
  automatically would put hundreds of unreviewed thoughts in the record
  (ter-manager: 208 such statements);
- when the file changes, its marks are checked again: a statement that is
  gone retires its mark, as rewritten lines do.

ter-manager shows the value: its `CLAUDE.md` lists eleven things that "look
like they need simplifying" - divider elements keyed to their node, insertLeaf
never splitting a node with itself, nothing fitted below 60 px, connect()
called from add() - each naming code and saying why it is so. Read once and
marked, they reach every later agent through GitX at the code they concern,
instead of only an agent that reads the whole file.

### 2c. A scan: one agent, the way it already works

In practice one agent works (owner, 18 October). Investigating is what an
agent already does when asked "tell me about this project": read the agent
files and README, look at the structure, open the main pieces, write an
overview. The scan is that, leaving its notes on the code as it goes.

- `gitx_investigate` stamps a scan and returns `understood_before` - what
  earlier scans said the project is, and where agents marked most.
- The **first final answer after it** is read as the agent's notes (hook.js
  at Stop): every statement naming code becomes one mark on all the code it
  names, its heading kept as context; the first paragraph naming none
  becomes the project's note (a mark on `project`). The stamp is spent on
  that answer, so the same session's later "I fixed X" reports are not notes.
- Or in one call: `gitx_mark { "about": "...", "marks": [{ "to": [...], "note": "..." }] }`.

Agents did not mark when a tool reply asked them to (0 of 30); an overview
already says, place by place, what each part does, so the answer is the
notes and no extra call is needed.

### 3. Finding marks

*Built:* marks are found by `tools/marks.js` beside each answer - on the code
the answer lands on, then by the words of their notes - rather than as a layer
inside rank.js. *Not built:* a rank.js layer, following a mark's links while
finding, and marks in `gitx_thought_record`'s maybe-related check.

The planned shape - marks as a fourth layer in the ranking engine (rank.js),
beside commits, settled thoughts and waiting thoughts:

- **by code**: a mark's regions count like a commit's touched regions, so
  `gitx_search` and `gitx_find_related` bring the marks on the code they land
  on - before editing a function the agent sees what earlier agents noted;
- **by words**: the note is searched like a thought's text;
- **by links**: linked marks pull each other in, as linked thoughts do.

**No duplicates:** before a mark is written, the marks already on that code
come back - as `gitx_thought_record` offers "maybe related" today - and the
agent confirms or extends one instead of writing a second.

### 4. Trust

A mark's weight is Beta evidence, as learned use already is:

```
a = 1 (its maker) + confirmations      b = contradictions
mean = (a + 1) / (a + b + 2)           each counted x 0.98 per day of age
```

A mark below the learned-use bar (a >= 0.9, mean >= 0.6) is shown only on
request; a contradicted mark shows the contradiction beside it; a mark whose
lines were rewritten is retired with what replaced them. The owner can turn
a mark into a thought (a finding or a learned rule) by recording one that
cites it - the only way inferred knowledge becomes part of the decided record.

### 5. A feature in several places, and stacks

A feature often lives in several functions and files - file-fabric writes its
`#` heading sizes four times over (`getLineFontSize`, `syncNotesDOM`,
`renderNotesWidgetDisplay`, `openCodePreview`); ter-manager stamps
`data-wallpaper` in `index.html` and `applyWallpaper()` and reads it in
`app.css`. What holds them together is one thing learned, so **a mark has
anchors, not an anchor** (`gitx.mark/1`): one note, every place, each place
following its own lines. Reading any place shows the mark. When one place is
rewritten the mark lives on the rest and says which changed - "these are the
same" goes wrong exactly when one of them changes.

Two ways related marks come together (owner, 18 October):

- **The agent.** `gitx_mark` with several `to` writes one mark. Before writing,
  the reply shows marks already on that code (`already_here`) and marks
  elsewhere whose note holds most of the agent's (`says_the_same`, overlap
  >= 0.6 of the shorter note); the agent confirms one, or `join`s it - its
  code becomes more places of that mark.
- **GitX, when the agent did not.** On reading, marks are stacked and shown as
  one: written from the same statement, cited by one answer, linked by an
  agent, or nearly the same note on other code (jaccard >= 0.8). A stack is
  worked out and never written, so a wrong one costs nothing to undo. Words
  two *different* notes share are not a reason - that is what put
  service-worker notes on file-fabric's render loop.

Seeding writes one mark per statement on every piece of code it names, and a
final answer's citations become one cited mark on all of them. Explicit
`link` stays for code that relates but is not the same thing (`calls`,
`styles`, `explains`). Co-change from commits (files changed together) is the
next source of stacks, after a non-git folder has a history to read it from.

### 6. When to use GitX and when to walk

The skill also carries the rule the measurements give (17 October, the
owner's transport analogy): use GitX for why something is so, what was
decided or rejected, what a part is and how it changed; use your own tools
for where a named function or file is, or a list of every handler or
selector. GitX's own answer says "walk" when a question is a name lookup or
it finds no code.

## Reused, not rebuilt

| Need | Already there |
|---|---|
| a checked note on code, a thought or a commit | `gitx_mark`, `tools/mark.js` (gitx-mark, 53cbac4) |
| final-answer citations | `hook.js` Stop event |
| line identity that follows moved code | `thermal/thermal.js` |
| one ranking over every kind of record | `tools/rank.js` |
| "maybe related" before writing | `gitx_thought_record` |
| cross-file link candidates | `features/features.js` (4th_Dimension_v4.0) |
| fading evidence | `tools/walk-learn.js` |

## Test

The claim to test: on a repository that started bare, later agents spend
less and find more because earlier agents marked.

- **Repository:** a copy of ter-manager with `.gitx` stripped, and one
  open-source repository GitX has never seen.
- **Questions:** a set written by a fresh agent (`bench-write-set.js`, never
  read by the agent working on GitX), split into areas; round 1 asks some
  questions per area, rounds 2-3 ask *different* questions in the same areas,
  so an answer cannot simply be replayed.
- **Arms:** marks on, marks off (GitX with only the bare record), by hand.
- **Measures:** recall, tokens, turns, cost, time per round; marks made, found,
  confirmed and contradicted; wrong marks found by a later agent.
- **Noise:** at least two independent chains per arm - one run moved the same
  code from 78% to 75% (t-aecd0f7a5a).
- **Success:** marks-on rounds 2-3 beat marks-off on tokens at equal or better
  recall in both chains, with no answer made wrong by a mark.

## Risks

- **Wrong marks spread.** Guarded by the inferred status, evidence on every
  mark, contradictions shown beside it, and fading without confirmation.
- **Agents do not mark.** Guarded by the automatic path; the explicit path is
  a bonus, not the mechanism.
- **Noise.** Duplicate check before writing; a cap per session; marks with no
  note only from cited answers.
- **Stale marks.** Line identity retires a mark when its lines are rewritten.

## Open

- Should marks ever be shared with collaborators, or stay owner-only like
  thoughts?
- Does a confirmed mark become a thought automatically after enough agents
  confirm it, or only when the owner records one?
- Marks across repositories - the 5th Dimension.

## Built, and how it was checked

| Part | Where |
|---|---|
| marks store, line-identity anchors, retirement, trust | `mcp/tools/marks.js` |
| `gitx_mark`: notes, confirm, contradict, link, marks already here | `mcp/server.js` |
| `gitx_investigate`: the record's state, agent files seeded | `mcp/server.js`, `marks.js` |
| marks beside `gitx_search`, `expand` and `gitx_find_related` | `mcp/server.js`, `marks.js` |
| the walk hint | `marks.js` walkHint |
| cited marks from a final answer | `mcp/hook.js` at Stop, `marks.js` |
| the skill | `skills/gitx-investigate/SKILL.md` |

Checked end to end through the MCP server on a throwaway clone of ter-manager:
`gitx_investigate` made 61 marks from the 41 statements in CLAUDE.md and
README that name code (208 name none; about 15 s the first time, mostly git
blame of two large files); a why-search about divider elements brought the
`dividerEls` mark; a where-search for `discoverShells` said to grep; a second
mark on the same function came back as already there and wrote nothing;
confirm, contradict and link counted; `gitx_find_related` and `expand` showed
the marks on their code; the Stop hook left a cited mark on `wslDistros` for
the question asked; rewriting a function's lines retired its mark, and
removing a gotcha from CLAUDE.md retired that statement's mark while 60 others
stayed. The agent test under Test is not run yet.


### Setup mode, and what the benches showed (17-19 October)

| Part | Where |
|---|---|
| `gitx_investigate { mode: "setup" }`: the setup map (coverage, files, what is not marked yet, features so far) | `mcp/server.js`, `marks.js` setupMap |
| feature marks: each part of a feature follows the feature's last mark; ranges `file:from-to` | `gitx_mark`, `marks.js` featureMarks |
| coverage counts only code the setup agent read, by at least half (the reads log) | `marks.js` setupCoverage, wasRead |
| the Stop hook sends the setup agent back until 60% is covered, four rounds at most; a finished setup never blocks a later agent | `mcp/hook.js`, `marks.js` setupNext |
| notes from an answer: a scan's first answer, and change notes for code the session edited | `mcp/hook.js`, `marks.js` marksFromAnswer |
| marks off entirely | `GITX_MARKS=0` |

- **Agents never mark unless assigned to:** 0 of 64 reader runs called
  `gitx_mark`. Setup agents called it 2 to 24 times.
- **Setup notes got more correct as the rules changed:**

  | Version | What changed | Correct |
  |---|---|---|
  | v1 | | 11 of 18 |
  | v2 | coverage target added; the agent gamed it | 21 of 39 (17 partly) |
  | v3 | reads counted only when the code was opened; notes written freely, with no rule to be brief | 25 of 33 |
  | bare copy of GitX | | 83 of 90, none wrong |

- **The notes did not make readers better.**
  - On the bare copy of GitX:

    | Readers | Accuracy | Coverage | Wrong claims |
    |---|---|---|---|
    | with setup marks | 7.8 | 7.2 | 11 |
    | with GitX's own record | 8.3 | 7.8 | 8 |
    | by hand | **8.8** | **8.7** | **4** |

  - Readers with notes answered from them and read about one file.
  - The file-fabric win for setup marks (8.8 / 8.7 / 6 wrong against hand's
    8.0 / 8.2 / 12) came on the questions the retrieval fixes were tuned on.

The next step drops notes as answers: GitX hands out the code's words as
clues, and the setup agent writes a map that states only what it read. That
is `docs/word-graph-plan.md`. On fresh questions it beat reading by hand 4 to 2.
