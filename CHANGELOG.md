# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted jagent MCP server. The seven captured tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `check_resume`, `grade_essay`, `grade_with_rubric`, `judge_yes_no`, `judge_choice`, `judge_score` and `compare_versions`. Every tool works on text the caller supplies; no tool buys, subscribes, checks out or mints a key.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `rubricscore error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `JEVAGENT_MCP_URL`; when `JEVAGENT_API_KEY` is set it is sent as an `Authorization: Bearer` header on every upstream request.
