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

Call **`gitx_investigate`** once when you arrive. It says which of two kinds of repository this is.

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

## Setup mode: assigned to set a repository up

When you are asked to set a repository up for GitX, call `gitx_investigate { "mode": "setup" }`. You go
through the code feature by feature, and for each one mark the code range it lives in with a note on what it
does - so any agent after you understands the code from your marks.

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
   parts. Call `gitx_investigate { "mode": "setup" }` again to see the map as it is now.

## Walk or take the transport

| Use GitX | Use your own tools (Grep, Read) |
|---|---|
| why something is the way it is | where a named function, file or setting is |
| what was decided, rejected or is still open | a name you already know: grep for it |
| what a part of the project is, and its pieces | a list of every function, handler or selector |
| how something changed over time | |

GitX's answer says `walk` when your own tools are the faster way. A name in the code is one Grep away;
the reasoning behind it is not.
