# BUILD REPORT — rubricscore

Clean-room rebuild of `com.jev-agent/jagent` v1.0.0 (remote-only MCP
server at `https://jev-agent.com/api/mcp`), built 2026-10-28 as a
forwarding client. Package: `@reneturcios/rubricscore` 0.1.0,
registry name `io.github.CloudCorpRecords/rubricscore`.

## Surface built

Full surface built: **7/7 tools**, no omissions.

| Tool | Title (as served) | Required fields as served |
|------|-------------------|-----------------------------|
| `check_resume` | Check a resume | `resume` |
| `grade_essay` | Grade an essay | `essay` |
| `grade_with_rubric` | Grade against your own rubric | `criteria`, `submissions` |
| `judge_yes_no` | Yes/no judgment | `text`, `question` |
| `judge_choice` | Multiple-choice judgment | `text`, `question`, `options` |
| `judge_score` | Rubric judgment | `text`, `question`, `levels` |
| `compare_versions` | Compare two versions | `question`, `version_a`, `version_b` |

Tool literals were generated programmatically from
`harness/fixtures/jevagent-tools-original.json` by the script at
`/tmp/b40-rubricscore-gen.py` (parse + re-serialise, placeholder
substitution into `src/forward.ts`) — never retyped — and a
post-generation check confirmed the served literals deep-equal the
fixture's 7 tool objects in order. Tools are registered via the MCP
SDK low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod, per the task
instruction overriding TEMPLATE.md §2 item 12.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names, order,
required fields, titles, and descriptions.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned: `https://jev-agent.com/api/mcp`.
- Env override `JEVAGENT_MCP_URL` — labelled reconstruction.
- Env name `JEVAGENT_API_KEY` — labelled reconstruction (the registry
  record declares a required secret `Authorization` header; the
  capture was taken keyless). When set, `Authorization: Bearer
  <value>` is sent on every upstream request (header name pinned by
  the registry record's remote declaration; Bearer form is a
  reconstruction). When unset, no key header is sent. Both branches
  are tested.
- Error rendering `rubricscore error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) → notifications/initialized
  → tools/call, honouring `Mcp-Session-Id` when issued; plain-JSON and
  SSE replies are both parsed. The forwarding core takes an injectable
  fetch; tests stub the upstream — no live network calls in tests.

## Deviations

- Parity invocation path form: the task's literal rebuild string
  `stdio:node ~/workspace/mcp-rebuild-100/builds/rubricscore/dist/cli.js mcp`
  was run first and returned verdict UNREACHABLE, because the harness
  launches the command via `shlex.split` + `Popen` with no shell, so
  the `~` is never expanded and node resolves it as a relative path
  (error recorded in that first run's output). Parity was therefore
  re-run with the identical command using the expanded absolute path
  (`/home/hatch/workspace/...`), which is the form every prior build's
  `parity-out/parity.json` on disk uses. That run is the recorded
  verdict below, in `parity-out/`. No other deviations.

## Lockfile

- Route: **Route 3** — generated clean from birth in the build dir
  with no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/rubricscore`.
- Package entries: **128**.
- sha256: `da29c693d86cca4dd450b1b423074033a8864795cc0ee9e85d62055895f5f599`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Grade essays and resumes, and judge texts
  with typed yes/no, choice and score questions." — **88 characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/rubricscore:0.1.0`) carries **no**
  `version` field. Dockerfile (node:20-alpine, both stages) carries
  the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/rubricscore"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/rubricscore`
  and its smoke test asserts the server name `rubricscore`.

## Verification (all run 2026-10-28)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`, exit 0; unknown subcommand
   → Usage on stderr, exit 2.
4. `npm test` → **61 tests, 61 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 7
   tools in order, plus session handling/reuse, env override,
   key-header present/absent/blank branches, verbatim argument
   forwarding for all 7 tools and result pass-through including
   upstream isError, SSE parsing, error rendering, MCP-layer
   validation, and CLI behaviour). Fake-fetch only; no live upstream
   calls.
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/jevagent-tools-original.json --rebuild
   "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/rubricscore/dist/cli.js mcp"
   --out builds/rubricscore/parity-out` → **verdict PASS, parity
   100.0** (7/7 identical, 0 missing, 0 extra, no schema diffs).
   Output in `parity-out/`. See Deviations for the path-form note.
