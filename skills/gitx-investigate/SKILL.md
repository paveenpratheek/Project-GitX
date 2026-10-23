---
name: gitx-investigate
description: >-
  Use this skill when you start work on a repository with the GitX MCP tools available, when the user asks
  what a project or a part of it is ("tell me about this project", "how does this work", "what does this
  code do"), and whenever you investigate code to understand it. It says whether the repository is
  GitX-ready, how to ask GitX, when your own tools are faster, and - in a repository that is not GitX-ready
  yet - how what you understand is left on the code for the next agent.
---

# Investigating a repository with GitX

Call **`gitx_investigate`** once when you arrive. It says which of two kinds of repository this is, and
whether it has a GitX map.

## GitX-ready (`"ready": true`)

Its commits carry their reasoning, and its thoughts and topics are linked: that is the record. Ask it with
`gitx_search`. There is nothing to mark.

## Not GitX-ready yet (`"ready": false`)

A bare repository, or one whose notes are not linked. You build its record as you work - what you
understand about the code is left on it, so the next agent starts from it.

1. **Ask with `gitx_search`** - `{ "query": "<the subject>", "lens": ["what","why"] }`. Its answers carry,
   under `marks`, the notes earlier agents and the repository's own agent files left on the code the answer
   lands on, and what earlier agents said the project is. A note is inferred, never decided: check it
   against the code before you rely on it, then `gitx_mark { "confirm": "m-..." }` - or
   `{ "contradict": "m-...", "note": "what is actually so" }` if it is wrong.
2. **Read the code** the answer points at, and the agent files and README (`CLAUDE.md`, `.claude/`,
   `AGENTS.md`, `.agent/`, notes the repository keeps).
3. **Answer, naming the code each statement is about**: `script.js::drawLinks`, `server.js:321`. Your next
   answer after `gitx_investigate` is read as your notes: each statement that says more than the names it
   is on becomes a mark on that code, and an opening paragraph on what the project is becomes the
   project's note. "`scanStaged` scans staged changes" is not a note; why it is so, what it depends on,
   what goes wrong - those are.
4. `marked_so_far` says what earlier agents marked and the biggest parts nobody has: add to the gaps.
5. **When you change code**, say in your answer what you changed and why, naming the code: "the culling
   margin in `script.js::drawLinks` is now 1.25x the viewport, because links whose ends were off screen were
   clipped". With no GitX record yet, that is the thought behind the code, and it is read as a note on the
   code you changed. Something you worked out that the next agent would otherwise have to work out again -
   a trap, a reason, a dependency - leave with `gitx_mark` as you go.

To leave notes yourself, in one call:

```json
{ "about": "File Fabric is an infinite canvas of files and notes...",
  "marks": [ { "to": ["script.js::drawLinks", "script.js::getRenderBBox"], "note": "links are culled against the viewport each frame..." } ] }
```

- A feature that lives in several places - functions, files - is **one** mark on all of them:
  `{ "to": ["app.js::applyWallpaper", "app.css:2495", "index.html:52"], "note": "..." }`. When one of them is
  rewritten the mark says which, so the next agent checks the rest.
- If marks are already on that code, or one elsewhere says the same, you get them back instead
  (`already_here`, `says_the_same`): confirm one, add your code to it with
  `{ "join": "m-...", "to": ["notes.js::render"] }`, or pass `"new": true`.

A statement that names no code - a rule of work, a convention - is not a mark; record it with
`gitx_thought_record` (kind `learned`) if it matters.

## A repository with a GitX map (`"map": "GitX.md"`)

`GitX.md` (at the root, or `.gitx/GitX.md`) is a map a setup agent wrote after reading the code. For each
feature it lists the words to grep, what the agent **found** when it read the code, and the **open leads** it
saw only as names or did not reach. **It is where to start, not the answer: the code is.** Grep its words,
read the code they lead to, check what you rely on, and look past its words - they are not all the words
there are. Where the map is wrong, say so in your answer.

## Setup mode: assigned to set a repository up

When you are asked to set a repository up for GitX, call `gitx_investigate { "mode": "setup" }` (add
`"where": "gitx"` if the user wants the map private, in `.gitx/`). It works on a folder with no git.

GitX writes the code's own words to `.gitx/words.md`: the names it defines, grouped by a shared name part, each
with its near words and the other places it appears. **They are clues, not answers** - a name says what someone
meant when they wrote it, not what the code does now - and they are not all the words there are.

1. Grep the words and **read the code with Read** - only what you open with Read counts as read.
2. Write `GitX.md` early and keep it up to date as you go. For each feature: the words to grep, what you found
   when you read its code, and the open leads. **State as found only what you read.** Anything you saw only as
   a name, or did not reach, is an open lead and says it is unread. Say how the parts connect, where you read it.
3. Read all of the code. Setup is done at 90% of the code's lines read; until then, when you stop, GitX sends
   you back with the biggest parts still unread, and with any name in the map that is not in the code.
4. GitX writes a few lines on top of the map saying what it is and how much of the code was read. Change no
   file but the map. `CLAUDE.md`, `AGENTS.md`, READMEs and notes may be out of date: the map is about the code.

### Setup with marks (`"mode": "setup-marks"`)

The older setup, on a git repository: you go through the code feature by feature, and for each one mark the
code range it lives in with a note on what it does.

1. Find the features: the repository's own notes (`CLAUDE.md`, README, docs) and the structure. Check the notes
   against the code - they can be out of date.
2. For each feature, read its code until you understand it, then mark every part of it:

   ```json
   { "marks": [ { "to": ["script.js:7090-7140", "style.css:1195-1260"], "feature": "totem-indicators", "note": "..." } ] }
   ```

   - `to`: the code range (`file:from-to`) or function (`file::name`) of each part.
   - `feature`: a short name, the same for every part of one feature (`features_so_far` lists the names used).
   - `note`: what you understood about this feature, written the way you want - whatever the next agent needs to
     understand this code. The mark keeps its own place as the code moves.
   - A mark counts once you have read the code it is on: a mark on code you have not opened is shown as
     marked without reading the code, and does not count toward the setup's coverage.
3. Another part of a feature already marked: give the same `feature`, and your mark follows the feature's last
   mark (`follows: m-...` in the reply). To see a feature's marks first: `gitx_mark { "feature": "totem-indicators" }`.
4. Cover the repository: `files` says how much of each file is marked, `not_marked_yet` the biggest unmarked
   parts. Call `gitx_investigate { "mode": "setup-marks" }` again to see what is marked now.

## Walk or take the transport

| Use GitX | Use your own tools (Grep, Read) |
|---|---|
| why something is the way it is | where a named function, file or setting is |
| what was decided, rejected or is still open | a name you already know: grep for it |
| what a part of the project is, and its pieces | a list of every function, handler or selector |
| how something changed over time | |

GitX's answer says `walk` when your own tools are the faster way. A name in the code is one Grep away;
the reasoning behind it is not.
