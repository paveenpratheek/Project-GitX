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
| the word graph | `mcp/tools/word-graph.js` (`wordGraph`, `wordGraphText`, CLI) | built, run by hand |
| setup prompt and reader framing | the bench, quoted below | not yet in `gitx_investigate` |
| link reasons beyond name and place (same value, calls) (t-dae10242a7) | - | not built |
| seeding from agent files removed (t-eae87feddc) | - | not built: `gitx_investigate` still seeds |

On file-fabric the graph has 90 groups and 454 words in 85 KB. Its body is the
same as the prototype's that was tested.

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

## Next

- Wire the word graph and the map prompt into `gitx_investigate` setup mode,
  in place of setup marks.
- Stop seeding from agent files (t-eae87feddc).
- Have GitX check the words GitX.md names still exist in the code.
- Run round 2 on a second repository.

The bench scripts were throwaway and are not in the repository. The setup prompt
and the reader framing that mattered are quoted above.
