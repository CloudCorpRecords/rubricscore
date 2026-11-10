# rubricscore

Some texts need a judgment, not just a word count: an essay against a rubric, a resume against a posting, a reply against a yes/no question. rubricscore is a small local bridge to the hosted jagent MCP service. You supply the text, and the service grades it, scores it, or places it on a scale you define.

Nothing is graded on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged.

## The tools

All seven tools work on text you supply. Nothing is harvested, submitted anywhere else, or sent to a third party by this surface, and no tool buys anything, starts a checkout, or creates a key.

- **`check_resume`** — Scores a resume, optionally against a job posting: a 0-100 match score, the posting's keywords found and missing (matched literally, as an ATS search would), ATS format checks, the level fit, and the probability a recruiter would move it to interview. Required: `resume`.
- **`grade_essay`** — Grades one essay against a built-in rubric. `kind` `"essay"` gives six criteria and a letter grade at middle school, high school or college level; `"common-app"` handles a Common App personal statement (prompt number 1-7); `"sat"` handles an SAT School Day essay with Reading, Analysis and Writing each 1-4. Required: `essay`.
- **`grade_with_rubric`** — Grades one or more submissions (up to 30, in parallel) against a rubric you supply: each criterion scored on a 3- to 6-point scale, summed per submission, each graded in its own call. Required: `criteria`, `submissions`.
- **`judge_yes_no`** — Asks any yes/no question about a text and returns the probability the answer is yes, for checks and gates such as whether a reply answers a customer's question. Required: `text`, `question`.
- **`judge_choice`** — Picks the option that best fits a text, with a probability for every option and a confidence. Options map an id to a description of when it applies. Required: `text`, `question`, `options`.
- **`judge_score`** — Places a text on an ordered scale you define, lowest level first, and returns the nearest level, the exact position and a probability for each level. Required: `text`, `question`, `levels`.
- **`compare_versions`** — Decides which of two versions is stronger for a stated purpose, asked twice with the order swapped and averaged; if the two orders disagree the result is a tie. Required: `question`, `version_a`, `version_b`.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/rubricscore mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "rubricscore": {
      "command": "npx",
      "args": ["-y", "@reneturcios/rubricscore", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/rubricscore
docker run --rm ghcr.io/cloudcorprecords/rubricscore judge_yes_no '{"text":"...","question":"Does this answer the question?"}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
rubricscore check_resume '{"resume":"..."}'
rubricscore grade_essay '{"essay":"...","kind":"essay","level":"high school"}'
rubricscore grade_with_rubric '{"criteria":[{"name":"Evidence"}],"submissions":[{"text":"..."}]}'
rubricscore judge_score '{"text":"...","question":"How relevant is this?","levels":["Off-topic","Partly relevant","Fully relevant"]}'
rubricscore --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `JEVAGENT_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://jev-agent.com/api/mcp`. (The override variable is a reconstruction added by this rebuild.)
- `JEVAGENT_API_KEY` — When set, its value is sent to the upstream on every request as an `Authorization: Bearer <value>` header. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The variable name and the Bearer form are reconstructions; the hosted service's registry record declares an `Authorization` header as a required secret, while the capture itself was taken keyless.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `rubricscore error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
