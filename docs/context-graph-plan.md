# Context graph: plan

**Status:** planned, nothing built. Agreed 2026-09-23 on the `4th_Dimension` branch.
**Scope:** one repository, one agent. Part of the 4th Dimension.

## Goal

Take the wanderer thoughts out of the thought graph so that it holds only
reasoning that produced a commit. Wanderers go to a new store, the
**context graph**. It keeps them until they are needed and moves each one into
the thought graph when a commit settles it.

A commit speaks for the code. The thought graph speaks for the commit. The
discussion that got there lives in the context graph.

## Definitions

- **Thought graph**: `.gitx/thoughts/`. What made each commit happen. Read by
  every thought tool, as today.
- **Context graph**: `.gitx/context/`. Thoughts not settled by a commit yet,
  plus stashes. Read **only when an agent asks for it**.
- **Stays** (in the thought graph): what made a commit happen, by something
  stated, never by a guess. It starts from a thought with its own
  `resulted_in`, and from every learned rule. From each of those it follows:
  the evidence it cites; what it supersedes, refines or derives from; and
  what was weighed against it (`lost-to`, `cost-of` and `supports` pointing
  at it). Then the same again from each thought reached. A *later* thought
  that only points back at a staying one, by citing, refining or
  contradicting it, is unfinished work and does not stay. `parent` is
  **not** a tie, because it records the order thoughts were written in, not
  what they are about.
  - *This is the "directional" rule, and it replaced the first version.* The
    first version followed every link in both directions. On ter-manager it
    kept four unfinished follow-ups, among them the open question about the
    GitHub token. It also would have moved 15 lessons away from the eight
    learned rules they explain. The numbers under Measured were taken with
    that first version.
- **Learned rule**: `kind: "learned"`. A standing instruction.
- **Wanderer**: anything that neither stays nor is a learned rule.

## Measured (2026-09-23)

| | ter-manager (890) | GitX (115) |
|---|---|---|
| Stays: its own commit | 591 | 40 |
| Stays: tied to a commit by a link | 180 | 15 |
| Learned rules tied to nothing | 8 | 1 |
| **Wanderers** | **111 (12%)** | **59 (51%)** |

- **ter-manager wanderers:** 83 accepted findings, 15 rejected decisions, 7 open, 5 stashed, 1 rejected finding.
- **GitX wanderers:** 19 accepted decisions, 16 accepted findings, 8 open, 7 stashed, 6 rejected decisions, 3 accepted costs.

Moving them affects:

- **`parent` pointers:** 73 staying thoughts in ter-manager and 3 in GitX have a parent that moves.
- **Links:** 8 links in ter-manager point from untied rules to wanderers.
- **Linked wanderers:** 25 wanderers in each repo are linked to another wanderer. They move together, so those links are kept.

## Decisions

1. The context graph lives in `.gitx/context/`, apart from the thought graph,
   and is git-ignored.
2. It uses the **same schema, one file per thought**. Promotion is a rename plus
   setting `resulted_in`. One file per cluster was considered and dropped: a
   single thought could not be moved out of a cluster file when its commit lands.
3. It holds the stashes. `.gitx/stash/` moves to `.gitx/context/stash/`.
4. Agents do **not** read it by default, only when they ask.
5. Thoughts are written to the context graph first and move to the thought
   graph when a commit settles them.
6. **Learned rules stay in the thought graph**, tied or not, because a rule
   has to be read every time.
7. **Open questions move**, and catch-up shows how many there are (see Reading)
   so they stay in sight.
8. **`parent` pointers are re-pointed** to the nearest ancestor that stays. The
   original id is kept in `was_parent`, so the thread can still be rebuilt.
9. **Findings with no commit move** (83 in ter-manager). They come back when
   a need matches them.
10. **Nothing is promoted by guessing.** A commit without a trailer promotes
    nothing on its own.

## Storage

```
.gitx/
  commits/                  shared with the repo (unchanged)
  thoughts/t-*.json         thought graph
  context/
    thoughts/t-*.json       wanderers, thoughts in flight, stashed thoughts
    stash/s-*.json          stash containers (moved from .gitx/stash/)
  thought-log/  worktrees/  local.json  state.json
```

`.gitignore` in each repo changes from a list of private folders to:

```
.gitx/*
!.gitx/commits/
```

Anything added under `.gitx/` from now on is private by default. This also
settles two loose ends:
- GitX currently tracks `.gitx/state.json` and ter-manager ignores it. With
  this rule both ignore it, and GitX needs `git rm --cached .gitx/state.json`.
- `.gitx/drafts/` stays. It is empty, but it is not a leftover: `#37 fa6ebdb`
  kept it on purpose as somewhere a batch can be written before it is done,
  `loadThoughts` still reads it, and the watcher recreates it at startup.
  Whether the context graph takes over that job is a later decision.

## Lifecycle

1. **Write.** A new thought is written to `.gitx/context/thoughts/`. Its
   `anchor` is HEAD at the time of writing, so it records which commit the
   discussion came after.
2. **Settle by trailer.** The commit message names the thoughts it settles:
   ```
   GitX-Thoughts: t-2be9f7be8d, t-85e4de1676
   ```
   When HEAD moves, from any source (Source Control, the command line or
   `gitx_commit_chronicle`), the broker reads the new commits' trailers. It
   moves each named thought into `.gitx/thoughts/` and sets `resulted_in` to
   that commit.
3. **No trailer.** Nothing moves. Catch-up reports: "commit X landed; N context
   thoughts were written since the commit before it". The agent decides and
   promotes them explicitly, or leaves them where they are.
4. **Revival.** An agent that wants earlier thinking on a topic asks
   `gitx_context`. A wanderer that matches can be linked to current work, and it
   moves with the commit that settles that work.

## Reading

- `gitx_thought_search`, `gitx_thought_catch_up` and the graph page read the
  thought graph only.
- **New tool `gitx_context`** reads the context graph by words, by id, or as a
  list of stashes.
- **Catch-up adds one line and nothing more:**
  `context: 44 wanderers · 8 open · 7 stashed — gitx_context to read`.
  Its `still_open` and `stashed_for_later` sections now come from the context
  graph as counts, not contents.

## Build order

Every step works on its own, and each has a check that must pass before the
next one starts.

### 1. Storage and ignore rule — done
- `mcp/tools/thoughts.js`: `thoughtDirs()` gains `context` and `contextStash`.
- `.gitignore` in both repos: the inverted rule. `git rm --cached .gitx/state.json` in GitX.
- `mcp/server.js`: `ensureGitignored()` writes the inverted rule into any repo
  GitX works in, so the rule does not depend on hand edits.
- **Check:** `git status` shows nothing new after a file is created in `.gitx/context/`.
- **Found while doing it:** GitX's `.gitx/state.json` had the skip-worktree bit
  set, a hand-made way of hiding the churn of a private file that had been
  committed. Git reports that bit as "outside your sparse-checkout", which is
  misleading. The bit was cleared so the file could be untracked.

### 2. Watcher covers the context graph — done
- `mcp/tools/thought-watch.js`: watch `.gitx/context/thoughts/`. When a
  delete in one store is followed by an add of the same id in the other, log
  it as a **move**, not as a delete and an add.
- **Check:** renaming a test thought between the two stores logs a single move entry.
- **As built:** `loadThoughts(repo, { store })` reads one graph at a time, and
  its default is unchanged (1005 placements before and after, 0 moved). The
  watcher reads both and keeps `where` beside the thoughts in its index. A
  move carries any fields changed with it, so a promotion is one entry that
  includes `resulted_in`. The same id in both graphs is reported as an
  unreadable file, and the thought-graph copy is the one read. An index saved
  before this step has no `where`, which means "all in the thought graph", so
  a restart logs no false moves.
- **Limit:** a move is recognised when both halves land in the same sweep.
  A rename does, because it is atomic. A copy followed by a delete more than
  400 ms later would still be logged as an add and a removal. The migration
  and promotion therefore rename.

### 3. `gitx_context` and the catch-up line — done
- `mcp/server.js`: the new tool, read-only.
- `mcp/tools/thought-query.js`: the counts line; `still_open` and
  `stashed_for_later` read from the context graph.
- **Check:** catch-up in both repos prints the line, and `gitx_context` finds a
  known wanderer by words and by id.
- **As built:** `context()` takes a `store`. Filing under commits happens
  within one graph, and links are looked up in both, so a crossing link reads
  as its thought and says which graph it is in. `loadStashes` takes the same
  option. The catch-up line counts what is waiting, open, stashed and written
  since HEAD. It also appears when the thought graph is empty.
- **Changed from the plan:** `still_open` and `stashed_for_later` still show
  what remains in the thought graph, in full. After step 4 moves those items
  they empty on their own. Switching them to counts now would have hidden 7
  open questions and 2 stashes in the gap between the steps.
- Asking for an id in the wrong graph names the graph that holds it.
- Checked over MCP stdio with an isolated server: 13 cases, and 1040
  placements unchanged.
- **Open:** `gitx_context` visits are not recorded in the trails. The context
  graph has no layer in the recorder yet.

### 4. Migration (runs once, per repo)
- A script classifies every thought by the rule under Definitions and prints a
  dry run: what moves, what stays, and which `parent` pointers are re-pointed.
- **The owner approves the dry run.** Then the thoughts and the stash
  containers move, by rename. The watcher logs each thought as one `moved`
  entry (step 2). A re-pointed `parent` belongs to a thought that stays, so
  it is logged as a `changed` entry on that thought, `was_parent` included.
  Undoing it is renaming back: a move loses nothing, so no copy is needed.
- **Check:** before and after placement snapshots (the method used for
  `881c2a1`). Every thought that stays is filed exactly where it was. The
  number of thoughts leaving the thought graph matches the dry run.
- **As built:** `mcp/migrate-context.js`, shipped in GitX so that every
  repository that recorded thoughts before the context graph can run it.
  - With no flags it does a dry run and compares both rules. `--apply`
    refuses to run unless the rule is named, as in `--rule=directional`.
  - Moves are renames, recorded in `.gitx/context/migration.json`. If it
    fails part-way it puts back what it had done, and `--undo` restores
    every re-pointed file from its original text.
  - A staying thought's parent is re-pointed whenever the parent does not
    stay, including a parent already in the context graph. The session
    writer had chained four thoughts that way.
- **Dry run, directional rule:** GitX keeps 98 and moves 59, with 7 parents
  re-pointed and 2 stashes moved. ter-manager keeps 790 and moves 100,
  with 67 parents re-pointed. In GitX both rules move the same set.
- **Proven on clones of both repositories, 24 checks.** Moves matched the
  dry run, and every staying thought stayed filed where it was. The watcher
  logged one move per thought and no removals. Undo restored 1070 files
  byte for byte.
- **Applied on 24 September with the directional rule, on the owner's word.**
  - GitX: 59 thoughts and both stashes moved, 137 stay.
  - ter-manager: 100 thoughts moved, 790 stay.
  - All 927 staying thoughts are filed under the same commit as before. No
    parent points outside its graph, and no id is in both graphs.
  - The broker watching GitX logged the 59 moves live. ter-manager's moves
    are recorded when a broker next opens that repo.
  - `--undo` still reverses each repo from its
    `.gitx/context/migration.json`.
- **Found afterwards:** catch-up still lists a question as open when a
  committed decision *refines* it. Only a question that is *superseded*
  counts as answered. This is picked up in step 6.
- **Second pass, same day: the owner's commit-only rule.** The thought graph
  holds only thoughts that support a commit, and everything else is in the
  context graph. That replaces decision 6 above: a learned rule that no
  commit rests on now moves too, and so do the lessons behind it.
  - `--rule=commit-only` moved 5 rules out of GitX and 37 thoughts out of
    ter-manager: 16 rules, 12 rejected approaches and 9 incidents. That
    leaves 132 and 753 in the thought graphs.
  - All 885 thoughts that stayed are filed where they were.
  - Catch-up now reads rules from both graphs, so every agent still sees
    all 21.
  - The first pass's record is kept as `migration-<time>.json`, and
    `--undo` reverses the newest pass.
- **Still open:** the vote decides where 11 ter-manager thoughts are shown.
  All 11 support a commit, but they sit beyond the reader's two-step,
  one-conversation follow. Filing them with the directional rule is step 6.
  How the context graph itself is managed is decided later.

### 5. Promotion by trailer
- **Promotion follows the same directional rule.** A thought that moves
  into the thought graph brings with it the context-graph thoughts it
  cites, supersedes, refines or derives from.
- `mcp/tools/git-extract.js`: register `thoughts` as a known trailer key.
  **Trap:** unknown trailer keys are removed from the message without any
  warning today. `GitX-Root` was once lost exactly this way. If the key is not
  registered, promotion never runs and nothing reports it.
- `mcp/broker.js`: after `watchHead()` sees a new commit, read its trailers and
  promote the named thoughts. A named id that is not in the context graph is
  logged, never ignored silently.
- `gitx_commit_chronicle`: a `thoughts` parameter that writes the trailer.
  Both routes share one code path.
- **Check:** a throwaway repo, one context thought, a commit with the trailer
  made from the command line. The thought moves and `resulted_in` names the commit.
- **As built — done:** `mcp/tools/promote.js` does the promoting, and the
  broker and `gitx_commit_chronicle` both use it.
  - **When it runs:** whenever the broker re-reads git (at start, on a repo
    switch, and when HEAD moves). It scans the last 50 commits for the
    trailer instead of reacting to one commit, so a commit made while the
    broker was down still gets promoted, and a second run changes nothing.
  - **What moves:** a named accepted decision or cost gets `resulted_in`.
    What made it happen comes along by the directional rule: the evidence it
    cites, what it supersedes, refines or derives from, and the alternatives
    and costs weighed against it. A brought decision or cost gets the same
    `resulted_in`.
  - **What stays:** a later thought that only points back at a promoted one
    stays in the context graph. A named finding that nothing promoted
    reaches stays waiting and is reported. An id that isn't on record
    anywhere is reported too.
  - **Order of operations:** content is written first, then the file is
    renamed. A crash between the two leaves a waiting thought that already
    knows its commit, never a thought-graph thought with no commit.
  - **The commit tool's side:** `gitx_commit_chronicle` refuses a `thoughts`
    entry that isn't a waiting decision or cost. It writes the trailer,
    checks the parser reads it back, and promotes as soon as the commit
    exists, because the broker may not be running.
  - **No trailer:** catch-up's `not_named_by_head` names the decisions that
    were waiting just before the commit, and gives the command
    `node mcp/tools/promote.js <repo> <commit> <t-id> ...`. It never moves
    anything on a guess.
- **Checked on a throwaway repo, 17 checks,** with a real broker on a spare
  port watching a command-line commit, and the chronicle over MCP stdio.

### 5b. The graph page reads the context graph (found after step 4)
- The broker's `/api/thoughts` payload reads only the thought graph and
  `.gitx/stash/`. After the migration, the page's "Thoughts stashed" view
  would be empty, the thinking not yet in a commit would disappear from the
  graph, and nothing in the UI would show the context graph.
- **This has to be done before the migration is applied.** Give the page the
  context graph's stashes, plus a view of what is waiting.
- **Done. Designed as a mockup first, and the owner approved it.**
  - "Context graph" takes the place of "Thoughts stashed" in the mode bar,
    and the stashes become a section inside it.
  - Filter chips sort thoughts by what they wait for: open, decided but not
    built, finding, turned down, stashed.
  - Two groupings, one click apart: by the discussion a thought came from
    (the commit it was written after), or by what it waits for.
  - The details panel shows what a thought waits for. For a decision made
    but not built, it shows the `GitX-Thoughts` line with a copy button.
  - The graph modes show one line pointing to the context graph, and never
    draw the waiting thoughts themselves.
  - `/api/thoughts` has a `context` section, and the refetch signature
    covers both graphs.
  - An older broker that sends no context graph is named as the cause
    instead of being shown as an empty view.
  - This view is interim. A proper context graph gets designed once its
    use cases are worked out.
- **Checked against a second broker on 7787, running on GitX's real data.**
  Not verified: a real click copying to the clipboard (the handler and its
  fallback were), and the light theme, which comes from ter-manager's
  palette.

### 6. Remove the guess
- With wanderers gone, every thought in the thought graph that has no
  `resulted_in` is tied to a commit by a stated link. The majority vote per
  anchor and the `talk` field then have nothing left to do.
- **Check first:** the placement probe shows the fallback places **zero**
  thoughts in both repos. Only then remove it, from
  `mcp/tools/thought-query.js` and `js/graph-view.js` together.

### 7. Write path
- The writer (`project gitx_TM/thought-backfill/session.cjs` for now) writes to
  the context graph. A proper record tool comes later and is not part of this plan.

## Not in this plan

- More than one agent: activation per agent, concurrent writes, domain ownership.
- Topic clusters and named sets.
- Content matching beyond word search in `gitx_context`.
- Anything across repositories (the 5th Dimension).
