# GitX

**A memory and retrieval layer for AI coding agents.** GitX links a codebase,
its git history and a graph of the design decisions behind it, and serves all
three to agents over MCP - so an agent asks *why the code is the way it is*
instead of re-reading whole files to guess.

## The problem

An AI coding agent starts every session blind. To learn why code is written
the way it is, it re-reads files, spending tokens, and still misses the
decisions behind them: the alternative that was turned down, the constraint
that forced a shape, the bug a line exists to prevent. Git keeps what changed;
nothing keeps why, in a form an agent can ask.

## How it works

GitX reads a repository as three layers, from the code down:

```
Code     declaration-level regions of every file at HEAD
  |      each region attributed to the commits that wrote its lines (git blame)
Commit   commits grouped into lines of work (roots) and threads of code that change together
  |      each commit names what it builds on and the thoughts it carried out
Thought  decisions, findings, costs and rules, with their reasons and links
```

- **Thoughts are recorded as the work happens.** An agent records a decision
  with the alternatives it beat, a finding, a cost accepted, or a rule learned
  from a correction (`gitx_thought_record`). It waits in the *context graph*.
- **A commit settles them.** When the commit that carries a decision out names
  it in a trailer, the thought moves to the *thought graph*, anchored to that
  commit, with what supports it:

  ```
  GitX-Builds-On: 101d686
  GitX-Thoughts: t-e02af0ac56, t-3400eea91e
  ```

  `GitX-Root` starts a line of work and `GitX-Relates-To` links work in
  another place.
- **Search answers from the code down.** `gitx_search` takes a question in
  words and returns the code regions it is about, the lines worth reading, the
  commits that wrote them and why, and each thought with its status first -
  settled in a commit, accepted but not built, rejected and what held it back,
  open, or superseded. Statuses keep a turned-down idea from coming back as if
  it were current.
- **It learns from how agents read.** A hook records what each agent opened,
  edited and cited (`mcp/hook.js`, for Claude Code and Antigravity), and a
  later agent asking something alike starts nearer the answer. Agents can mark
  where an answer was (`gitx_mark`) so the next one starts there.
- **A repository without a record is built up as agents work.** On a
  repository never recorded the GitX way, `gitx_investigate` says so, and the
  agent builds the record as it goes: what its CLAUDE.md, AGENTS.md and README
  say about specific code becomes marks on that code. A map, `GitX.md`, written
  by a setup agent and kept honest by GitX, says where to start.

The index is rebuilt only for files that changed.

## Tools

GitX is one MCP server (`mcp/server.js`, Node) with 16 tools:

| For | Tools |
|---|---|
| Starting a session | `gitx_thought_catch_up` (what changed since the last session), `gitx_graph_map` (every line of work), `gitx_investigate` (is this repository GitX-ready, or does it need a map) |
| Asking | `gitx_search` (a question in words), `gitx_find_related` (earlier commits like the work at hand), `gitx_thought` (one thought by id), `gitx_thought_history` (what a thought used to say) |
| Following history | `gitx_graph_area` (one line of work in depth), `gitx_graph_chain` (a commit's reasoning back to its root), `gitx_graph_commit` (one commit in full) |
| Recording | `gitx_thought_record`, `gitx_commit_chronicle` (a commit with its links), `gitx_mark` |
| Several agents at once | `gitx_create_issue_with_branch` (a task with its own branch and worktree), `gitx_get_assigned_task`, `gitx_get_swarm_status` |

With `GITX_SUBJECTS=1`, `gitx_search` takes subjects instead of a question and a 17th tool, `gitx_find`, does exact
lookups of a name or a value.

## Results

GitX is measured against agents working without it, on frozen repository
snapshots, with held-out questions written by a fresh agent and never used for
tuning; every run records its tokens and cost. The finding ids are the records
in GitX's own thought graph.

**Held-out questions, Sonnet 5.5** (15 questions, each needing several records,
3 rounds, 16 Oct 2026 - t-aecd0f7a5a):

| | Recall | Tokens | Cost | Time |
|---|---|---|---|---|
| With GitX | 75% | 4.45M | $2.16 | 650 s |
| Reading files by hand | 78% | 16.26M | $3.72 | 1,002 s |

Near-equal recall with **73% fewer tokens** and **42% lower cost**. Reading by
hand gave more complete answers (21 of 45 against 14), and an earlier 78%-each
tie was not reproduced.

**Ranking against a keyword baseline** (14 held-out questions, 3 rounds -
t-c7d8793aa2): GitX found 18 of 42, a standalone BM25 retriever over the same
code, commits and thoughts 11 of 42, and an agent by hand 13 of 42. BM25 used
about half GitX's tokens (1.03M against 1.80M) at nearly the same cost ($0.89
against $0.93); by hand cost 7.6M tokens and $2.21. The BM25 arm lives apart
from GitX (`bench-bm25.js`), so the gap is what GitX's structure is worth.

**A second codebase** (file-fabric, five questions, judged by Sonnet):
Haiku 5.5 with GitX's map scored accuracy 8.10 of 10 at $0.016 a question
(t-752771a05f); Sonnet 5.5 reading files by hand scored 8.20 at $0.153 a
question (t-56c26c4d0f) - about the same accuracy at **90% lower cost**, from
two runs on the same questions. The Haiku arm made more wrong claims (21
against 17).

**Where it does not help.** On a repository with almost no recorded reasoning
(ter-manager: 2 of 138 commits linked to thoughts), GitX did not beat an agent
searching by hand on code-location questions (t-06de59f577). GitX's value is
the reasoning it holds; on a repository without it, `gitx_investigate` and `GitX.md` build it up.

Every run is listed in [docs/benchmarks.md](docs/benchmarks.md) - 190 runs, made from the run files by
`mcp/bench-export.js`, one row per run and arm. The held-out Sonnet result above is three of its rounds
added up.

## Tests

`npm test` runs the tests in `test/` with Node's own test runner, and GitHub Actions runs them on every push to
`master` and every pull request (`.github/workflows/ci.yml`):

- **Reading commits** - the GitX trailers become links, thoughts and a root; a paragraph of GitX lines above the
  trailer block is read too; other trailers and the subject leave the commit's words (`parse-message`)
- **The code layer** - a file splits at its declarations, each with the comment above it, and each region is
  attributed by git blame to the commits whose lines it still holds, on a throwaway repository (`code-regions`)
- **The server** - started over stdio as an agent starts it, it answers and serves its 16 tools, each with a
  schema, and `gitx_find` with `GITX_SUBJECTS=1` (`server`)
- **The guardrails** - secrets in what is committed and files that hold them are caught (`guardrails`)
- **The benchmark page** - every run and arm summed as the run files hold them (`bench-export`)

Each test makes its own repository and data folder and points the server at no broker, so nothing of yours is
read or written. GitX's search quality is measured by its benchmarks, not by these tests: see Results.

## Setup

Needs Node.js (developed on Node 24) and git.

```
npm install
```

Add the server to your agent's MCP configuration, for example in Claude Code's
`.mcp.json` or Antigravity's `~/.gemini/config/mcp_config.json`
(`mcp/config-example.json`):

```json
{ "mcpServers": { "gitx": { "command": "node", "args": ["<GitX folder>/mcp/server.js"] } } }
```

Optionally, add `mcp/hook.js` as a `PostToolUse`, `Stop` and `SessionStart`
hook so GitX learns from what agents read; its header shows the settings for
Claude Code and for Antigravity. The `gitx-investigate` skill in `skills/`
teaches an agent to work through GitX.

Each repository keeps its record in `.gitx/`. Only `.gitx/commits` is shared
through git; thoughts, the context graph and benchmark runs stay private to
the clone that made them, and GitX adds the `.gitignore` lines itself.

GitX also runs as a panel in [ter-manager](https://github.com/paveenpratheek/Ter-Manager)
(`plugin.json`, `index.html`).

## Layout

```
mcp/server.js      the MCP server and its tools
mcp/tools/         indexing, ranking, the thought graphs, walks and marks
mcp/lens/          how an answer is shaped: what, how, where, when, why
mcp/hook.js        the agent hook that records reads
mcp/bench*.js      the benchmarks: agent arms, BM25 baseline, task bench, the export
docs/benchmarks.md every benchmark run, one row per run and arm
docs/              design records
skills/            the gitx-investigate skill
```

## License

GNU Affero General Public License v3.0 or later - see [LICENSE](LICENSE).
