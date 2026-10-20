# Setup by words: the word graph and GitX.md

How GitX helps an agent learn a repository it has no record of. GitX hands out
clues; the agent does the finding. Written 19 October 2026, after the setup-marks
benches in `agent-marks-plan.md`, and with the results that decided it.

## The idea

**GitX is a riddle, not an answer.** It gives the agent the codebase's own rare
words, the way a map marks points, some of them unknown. Reaching those points
and saying what is there is the agent's work. A result GitX hands over as
finished is a result the agent stops at, and that is the failure every earlier
bench found: readers given notes answered from the notes and read less code
(t-0eca3e6e4a).

1. **GitX extracts the words** (t-953ac5c019). These are the names the code
   defines: functions, variables, state fields, object keys, element ids,
   storage keys, file names and mode strings. The platform's words
   (`addEventListener`, `clientX`) are every app's, so they are left out.
2. **The words carry no addresses** (t-b463142089). An agent greps anyway, and
   a grep is cheap: it shows matching lines, not the files.
3. **A node is a word in a place**, meaning a word within one function
   (t-9fc1d697b9). Distance and similarity are separate values:
   - **Near words** share the word's place.
   - **A far relative** is the same word used somewhere else. It is near by
     similarity, but similarity does not carry over to that place's
     neighbours. They stay strangers to the word.
4. **Words that share a name part are grouped and labelled "related by
   name".** For example, `toggleConstellationMode` and
   `drawConstellationLinks` sit together. A shared name is not proof that the
   words are one feature, and generic names come through too. GitX favours
   recall, and the agent judges what the words mean (t-087cdebc2f).
5. **The setup agent writes GitX.md as a map** (t-f3f6112124). For each
   feature it gives the words to grep, what it found when it read the code,
   and its open leads. It states as found only what it read. Anything it saw
   only as a name stays an open lead marked unread.
6. **GitX ignores CLAUDE.md, GEMINI.md and AGENTS.md** (t-eae87feddc). Those
   files are the user's, and agents read them directly. GitX gives the code
   level.
7. **A GitX-ready repository needs no setup** (t-8a8c5db999).
   `gitx_search` reads its record.
8. **Where GitX.md lives is the user's choice:** committed, or private under
   `.gitx`.

## Built so far

| Part | Where | State |
|---|---|---|
| the word graph | `mcp/tools/word-graph.js` (`wordGraph`, `wordGraphText`, CLI) | built |
| `gitx_investigate { mode: "setup" }`: writes `.gitx/words.md`, gives the brief (the round-2 prompt), the map's path and coverage | `mcp/server.js`, `mcp/tools/gitx-map.js` | built |
| where the map goes: `GitX.md` at the root, or `.gitx/GitX.md` with `where: "gitx"` - the user's choice | `gitx-map.js` mapPath | built |
| coverage: code lines the agent opened with Read, over every code line; the Stop hook sends it back with the biggest unread parts until 90% is read, ten rounds at most, and says when a round added nothing to the map | `gitx-map.js` mapCoverage, mapNext; `mcp/hook.js` | built |
| every backticked name in the map checked against the code; one not in it sends the agent back | `gitx-map.js` checkMap | built |
| a few lines GitX writes on top of the map: what it is, how much was read, names not in the code - for a reader who finds it unprompted | `gitx-map.js` stampMap | built |
| a reader arriving is told where the map is and what it is | `gitx_investigate`, the skill | built |
| a folder with no git: code read from disk, reads recorded once it has a `.gitx`, state kept by its path | `code-find.js` diskRegions, `hook.js`, `path-recorder.js` repoKey | built |
| the older setup with marks | `mode: "setup-marks"` | kept |
| link reasons beyond name and place (same value, calls) (t-dae10242a7) | - | not built |
| seeding from agent files | - | off in map setup; still on in the marks path (t-eae87feddc) |

Checked by `map-test` (19 checks): on a copy with no git and on a git clone, from
the brief to a finished setup that never holds a later agent back.

On file-fabric the graph has 90 groups and 454 words in 85 KB. Its body is the
same as the prototype's that was tested. It can also be run alone:

```bash
node mcp/tools/word-graph.js <repo> [out]
```

`out` defaults to `<repo>/.gitx/words.md`.

## Results

Both benches ran on a bare copy of file-fabric: no git history and no `.gitx`.
- **Readers:** headless `claude -p` with Sonnet, read-only tools, two runs per
  question per arm, three answering in parallel.
- **Judge:** a blind agent with the code. It saw the answers shuffled as A/B/C
  and checked every claim against the code.

### Round 1: GitX.md written as answers (lost)

The setup agent was told to check what it wrote against the code. It didn't:
3 reads, 4 shell greps, and an 11 KB GitX.md in 64 s for $0.54. It worked out
what the code does from the names and from the repo's old knowledge notes. So
GitX.md said off-screen totems "show edge indicators", when that code had been
removed and only an empty stub of the same name remains. Readers were told
GitX.md was "GitX's map of it - features, architecture".

The questions were the three the earlier benches were tuned on: canvas
rendering, save and open, and totems.

| | GitX.md + words | by hand |
|---|---|---|
| judged best | 0 of 6 | **6 of 6** |
| accuracy | 7.8 | **8.7** |
| coverage | 7.0 | **9.0** |
| wrong claims | 12 | **6** |
| cost (6 runs) | $1.02 | **$0.92** |

The map sent readers straight to a few functions, and they stopped there
(t-f4d351663e).

### Round 2: words as clues, GitX.md as a map (won)

Setup prompt:

> The words are clues, not answers. A name says what someone meant when they
> wrote it, not what the code does now, and these are not all the words there
> are. Grep them, read the code, and follow what you find past them. [...]
> State as found only what you read in the code. Anything you saw only as a
> name, or did not get to, goes in as an open lead and says it is unread.

The setup agent made 19 reads in 123 s for $0.81 and wrote 16.7 KB. Each part
is marked "Found" or "Open lead - unread". Readers were told GitX.md "is where
to start, not the answer - the code is. Check it and look past its words."

The questions were fresh, written after round 1 and not tuned on: links
between areas, calendar sync, and lasso selection.

| | map (GitX.md + words) | words only | by hand |
|---|---|---|---|
| judged best | **4 of 6** | 0 | 2 |
| accuracy | **9.0** | 8.8 | 8.8 |
| coverage | **8.8** | 7.7 | 8.0 |
| wrong claims | 7 | 10 | 7 |
| code reads (total) | **45** | 35 | 35 |
| time per question | 39 s | 35 s | **33 s** |
| first code read | 12.8 s | 13.3 s | **10.2 s** |
| cost per question | $0.14 | $0.16 | **$0.11** |

- **Map readers read more code than readers by hand**, and two of them added a
  "Corrections to GitX.md" section where the map was wrong.
- **Setup is a one-time cost** of 123 s and $0.81.
- **The map costs about 6 s and $0.03 more per question.** What it buys is
  coverage, not speed.
- **The word graph alone helped nobody.** It had the lowest coverage, the most
  wrong claims and the highest cost (t-97639e67b0).

### What it says

- **The framing decides the result, not the content.** The same kind of map
  lost when it read as an answer and won when it read as a riddle.
- **The setup agent must be told what not to state.** "Check against the code"
  was not enough. "State as found only what you read; everything else is an
  unread lead" was.
- **The sample is small.** Six runs per arm on one repository, and the margin
  is 4 to 2. Run another repository before wiring this into setup mode.

### The real setup of file-fabric (19 October)

The real setup ran through GitX's setup mode on `E:/antigravity V1/file-fabric`, which has no git.

- **The agent:** one Sonnet agent with Read, Grep, Glob, Write and Edit, and Bash
  off. The folder's own settings allow `pip install` and `python -c`.
- **The run:** it read 94% of the 15,760 code lines in 211 s for $1.90, with 25
  reads, and wrote a 24 KB `GitX.md`. The Stop hook sent it back once, because
  of the name check.
- **What it left unread:** the last third of `style.css`, and it says so.
- **Nothing else changed:** the folder, diffed against the 17 October
  snapshot, differs only by `GitX.md` and `.gitx/`.

Six fresh checkers each took a group of sections and checked every claim the
map states as found against the code:

| Found claims | Correct | Partly | Wrong | Cost |
|---|---|---|---|---|
| 158 | 154 | 4 | **0** | $1.99 |

The four partly right lines were corrected from what the checkers found in the
code. The map also names five probable bugs, two of them confirmed by the
checkers:
- a vertical line or arrow is never created, because `dist` drops the y term;
- `moveFileOutOfFolder` is called but defined nowhere;
- fixed-month calendars look up the wrong month's schedules;
- `renderFileItem` adds a `document` listener on every render;
- the dashboard editor's tool buttons have no click handlers.

Two GitX bugs surfaced during the run and were fixed:
- **The name check split file names into pieces.** It flagged five real files,
  such as `find_braces.py` and `.claude/`, and the agent dropped their
  backticks to satisfy it. A span that names a file in the folder is now
  checked as that file, and the backticks were restored.
- **A Read with a limit but no offset was counted as 2,000 lines.** It is now
  counted from line 1 to the limit.

### Sorted by kinds, loaded in parts (19 October)

GitX.md now opens with four sections in fixed kinds: `## Goal`, `## Rules`,
`## Criteria` and `## Known bugs` (t-95806b1f1d). The features follow as
`### ` sections.
- **What GitX writes on top:** an index with the exact lines of every section.
- **What a session gets:** the SessionStart hook (or `gitx_investigate`'s
  `map_top`) hands each session the four kinds plus the index, capped at 9,000
  characters. Features are read on demand.
- **How the shape is enforced:** setup sends the agent back until the map has
  this shape.

The fresh setup through this brief read 98% of file-fabric in 393 s for $2.63.
Checkers found 179 of 188 found claims correct, 8 partly, 1 wrong; those were
corrected from the checkers' findings. The session block is about 2.2k tokens,
against about 7k for the whole map.

On the same five questions:

| | kinds + index at start, features on demand | whole map, told in the prompt | by hand |
|---|---|---|---|
| judged best | 1 | **9** | 0 |
| accuracy / coverage | 8.30 / 8.10 | **8.85 / 9.05** | 8.15 / 7.80 |
| wrong claims | 14 | **7** | 19 |
| tokens / cost per question | **168k / $0.141** | 232k / $0.179 | 210k / $0.153 |
| time / turns | **35.8 s / 8.0** | 36.6 s / 9.1 | 40.8 s / 10.1 |

**Tokens: the goal was met.** Loading in parts costs less than reading by hand,
and the reader still beats hand on accuracy.

**Accuracy: it fell short of the whole map,** and three things differ between
those two arms:
- **The map:** the new one was checked only after the bench. At least one
  answer repeated its wrong lock-heartbeat line.
- **How the reader learned of the map:** from the hook, or from the prompt.
- **How much was read:** one section, or the whole file.

Readers also opened only one section, even for questions that span several.
On the links question, no reader opened a section at all.

**Next:** run the corrected map whole and sectioned on the same questions, to
separate those three causes. Put each feature's grep words in its index line,
and tell the reader to open every section its question touches.

### The map as interconnected nodes (20 October)

`mcp/tools/map-graph.js` makes each section of GitX.md a node. GitX links the
nodes from the code, and every link says why:

| Link | Meaning |
|---|---|
| **same code** | both sections own the same function |
| **uses** | a function one section owns calls a name another owns |
| **shared state** | both sections name the same state field |
| **mentioned** | one section's text names a function the other owns |

Two kinds of name never make links:
- **The app's spine:** names more than a quarter of the sections touch, such
  as `state`, `render` and `scheduleRender`. As links they tied all 19
  sections together (143 links); without them there are 77.
- **List sections** such as Open leads are entered by their words, never
  pulled in by links.

A question's stack is the sections its words land on (at most 4) plus up to 4
sections strongly linked to them, within about 3.3k tokens. It arrives with
each prompt (a UserPromptSubmit hook) and in `gitx_search`. On a folder with no
git, `gitx_search` answers with the stack.

The same five questions, with the corrected new map:

| | stack per prompt | the same map whole | by hand |
|---|---|---|---|
| judged best | 2 | **6** | 2 |
| accuracy / coverage | **8.70** / 7.90 | 8.60 / **8.90** | 8.20 / 8.20 |
| wrong claims | **13** | **13** | 24 |
| tokens / cost per question | **180k / $0.148** | 242k / $0.196 | 210k / $0.153 |

- **Map quality wasn't the problem.** The corrected new map read whole scored
  like the earlier map read whole (8.60 / 8.90 against 8.85 / 9.05). So the
  one-section arm lost because it read less.
- **The stack closed most of that gap:** the same accuracy and wrong claims as
  the whole map, at by-hand cost.
- **Coverage still trails the whole map,** because a stack gives a question its
  sections, not the breadth of every feature.
- **Times aren't comparable across days.** Both map arms took 43 s on a slower
  day than the by-hand runs.

## Next

- Stop seeding from agent files in the marks path too (t-eae87feddc).
- `gitx_investigate` already checks the map's names for a reader
  (`map_check`). The stamp on top is only rewritten during setup; rewrite it
  when the code changes, so a map that has fallen behind says so to a reader
  who never calls GitX.
- Run round 2 on a second repository.

The bench scripts were throwaway and are not in the repository. The setup prompt
and the reader framing that mattered are quoted above.
