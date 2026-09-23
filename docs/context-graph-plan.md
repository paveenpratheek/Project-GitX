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
- **Stays** (in the thought graph): a thought tied to a commit by something
  stated, never by a guess. Either it has its own `resulted_in`, or a link or
  force citation connects it, in either direction, to a thought that stays.
  This is followed transitively. `parent` is **not** a tie, because it records
  the order thoughts were written in, not what they are about.
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

### 2. Watcher covers the context graph
- `mcp/tools/thought-watch.js`: watch `.gitx/context/thoughts/`. When a
  delete in one store is followed by an add of the same id in the other, log
  it as a **move**, not as a delete and an add.
- **Check:** renaming a test thought between the two stores logs a single move entry.

### 3. `gitx_context` and the catch-up line
- `mcp/server.js`: the new tool, read-only.
- `mcp/tools/thought-query.js`: the counts line; `still_open` and
  `stashed_for_later` read from the context graph.
- **Check:** catch-up in both repos prints the line, and `gitx_context` finds a
  known wanderer by words and by id.

### 4. Migration (runs once, per repo)
- A script classifies every thought by the rule under Definitions and prints a
  dry run: what moves, what stays, and which `parent` pointers are re-pointed.
- **The owner approves the dry run.** Then the thoughts move and the stash
  containers move, and the watcher logs each move with a full copy.
- **Check:** before and after placement snapshots (the method used for
  `881c2a1`). Every thought that stays is filed exactly where it was. The
  number of thoughts leaving the thought graph matches the dry run.

### 5. Promotion by trailer
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
