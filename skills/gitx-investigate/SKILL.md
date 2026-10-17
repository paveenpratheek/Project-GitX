---
name: gitx-investigate
description: >-
  Use this skill when you start work on a repository with the GitX MCP tools available, and whenever you
  investigate code to understand it. It says when GitX is the faster way to an answer and when your own
  tools are, how to read what GitX and earlier agents already know about the code, and how to leave what
  you learn on the code so the next agent starts from it.
---

# Investigating a repository with GitX

## Start here

Call `gitx_investigate` once when you arrive. It tells you what GitX holds about the repository - commits
that carry their reasoning, recorded thoughts, topics, and marks earlier agents left - and turns the
statements its `CLAUDE.md`, `.claude/`, `AGENTS.md`, `.agent/` and README make about specific code into
marks on that code. Read those agent files yourself too: they are the cheapest way to learn the code.

## Walk or take the transport

| Use GitX | Use your own tools (Grep, Read) |
|---|---|
| why something is the way it is | where a named function, file or setting is |
| what was decided, rejected or is still open | a name you already know: grep for it |
| what a part of the project is, and its pieces | a list of every function, handler or selector |
| how something changed over time | |

GitX's answer says `walk` when your own tools are the faster way. A name in the code is one Grep away;
the reasoning behind it is not.

## Marks

A **mark** is what someone learned about specific code, left on that code. Marks come back with
`gitx_search` (under `marks`), `gitx_search { expand }` and `gitx_find_related` (under `marks_here`) on the
code they sit on. Their status says where they came from:

- `FROM CLAUDE.md, "<section>"` - written on purpose in the repository's agent files;
- `INFERRED by an agent` - another agent worked it out;
- `INFERRED - cited in an answer to "<question>"` - an agent's answer cited this code for that question.

A mark is never a decision. Check it before you rely on it, then:

- it holds: `gitx_mark { "confirm": "m-..." }`
- it is wrong: `gitx_mark { "contradict": "m-...", "note": "what is actually so, and where you saw it" }`

## Leave what you learn

When you work out something the code does not say plainly - it took reading several places, or the reason
is not visible in the lines - leave it on that code in one call:

```json
{ "to": "server.js:321", "note": "the shell list is built once at startup; WSL distros come from wslDistros" }
```

- `to`: `file:line` or a function (`app.js::fontChoice`).
- `note`: one or two sentences for the next agent. Never restate what a name already says.
- If marks are already on that code you get them back instead: confirm or contradict one, or pass
  `"new": true` to add yours.
- Code that belongs together across files: `{ "to": "m-...", "link": ["public/app.css:40"], "as": "styles" }`
  (`as`: same-feature, calls, styles, explains).

A statement in the agent files that names no code - a rule of work, a convention - is not a mark; record it
with `gitx_thought_record` (kind `learned`) if it matters.

Your final answer's citations (`file::function`, `file:line`) are read when you finish: code you cited that
your GitX search had not shown becomes a mark for that question on its own. Cite the code you used.
