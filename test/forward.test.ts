import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  RubricscoreClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real jagent endpoint is never
 * contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/jevagent-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const RESUME_TOOL = "check_resume";
const ESSAY_TOOL = "grade_essay";
const RUBRIC_TOOL = "grade_with_rubric";
const YESNO_TOOL = "judge_yes_no";
const CHOICE_TOOL = "judge_choice";
const SCORE_TOOL = "judge_score";
const COMPARE_TOOL = "compare_versions";
const ALL_TOOLS = [
  RESUME_TOOL,
  ESSAY_TOOL,
  RUBRIC_TOOL,
  YESNO_TOOL,
  CHOICE_TOOL,
  SCORE_TOOL,
  COMPARE_TOOL,
];

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"score\":91,\"verdict\":\"strong\"}" }],
  structuredContent: { score: 91, verdict: "strong" },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "jagent", version: "1.0.0" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new RubricscoreClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 7 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 7);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 7 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on each tool", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
        "title",
      ]);
    }
  });

  it("carries the fixture's tool titles verbatim", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => t.title),
      [
        "Check a resume",
        "Grade an essay",
        "Grade against your own rubric",
        "Yes/no judgment",
        "Multiple-choice judgment",
        "Rubric judgment",
        "Compare two versions",
      ],
    );
  });

  it("carries the fixture's required fields for every tool", () => {
    assert.deepEqual(
      TOOL_DEFS.map((t) => schemaOf(t).required),
      [
        ["resume"],
        ["essay"],
        ["criteria", "submissions"],
        ["text", "question"],
        ["text", "question", "options"],
        ["text", "question", "levels"],
        ["question", "version_a", "version_b"],
      ],
    );
  });

  it("carries every fixture property, in order, for all seven tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 7; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), [
      "resume",
      "job_description",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[6]).properties), [
      "question",
      "version_a",
      "version_b",
      "context",
    ]);
  });

  it("carries check_resume's resume bounds verbatim", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(props.resume.type, "string");
    assert.equal(props.resume.minLength, 150);
    assert.equal(props.resume.maxLength, 12000);
    assert.equal(props.job_description.maxLength, 8000);
    assert.equal(schemaOf(TOOL_DEFS[0]).type, "object");
  });

  it("carries grade_essay's kind and level enums verbatim", () => {
    const props = schemaOf(TOOL_DEFS[1]).properties;
    assert.deepEqual(props.kind.enum, ["essay", "common-app", "sat"]);
    assert.equal(props.kind.default, "essay");
    assert.deepEqual(props.level.enum, [
      "middle school",
      "high school",
      "college",
    ]);
    assert.equal(props.prompt.minimum, 1);
    assert.equal(props.prompt.maximum, 7);
    assert.equal(props.essay.minLength, 100);
  });

  it("carries grade_with_rubric's criteria and submissions shapes verbatim", () => {
    const props = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(props.criteria.minItems, 1);
    assert.equal(props.criteria.maxItems, 8);
    assert.deepEqual(props.criteria.items.required, ["name"]);
    assert.equal(props.points.default, 4);
    assert.equal(props.points.minimum, 3);
    assert.equal(props.points.maximum, 6);
    assert.equal(props.submissions.minItems, 1);
    assert.equal(props.submissions.maxItems, 30);
    assert.deepEqual(props.submissions.items.required, ["text"]);
  });

  it("carries judge_choice's options shape verbatim", () => {
    const props = schemaOf(TOOL_DEFS[4]).properties;
    assert.equal(props.options.type, "object");
    assert.equal(props.options.propertyNames.minLength, 1);
    assert.equal(props.options.propertyNames.maxLength, 60);
    assert.equal(props.options.additionalProperties.maxLength, 500);
  });

  it("carries judge_score's levels bounds verbatim", () => {
    const props = schemaOf(TOOL_DEFS[5]).properties;
    assert.equal(props.levels.minItems, 2);
    assert.equal(props.levels.maxItems, 10);
    assert.equal(props.levels.items.maxLength, 300);
  });

  it("carries the shared text/question bounds on the judge tools verbatim", () => {
    for (const idx of [3, 4, 5]) {
      const props = schemaOf(TOOL_DEFS[idx]).properties;
      assert.equal(props.text.maxLength, 60000);
      assert.equal(props.question.minLength, 3);
      assert.equal(props.question.maxLength, 1000);
    }
  });

  it("isKnownTool recognises the 7 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("grade"), false);
    assert.equal(isKnownTool("check-resume"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(RESUME_TOOL, { resume: "x".repeat(200) });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(DEFAULT_ENDPOINT_URL, "https://jev-agent.com/api/mcp");
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("sends clientInfo name rubricscore and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(YESNO_TOOL, { text: "hi", question: "Is this a greeting?" });
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "rubricscore", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(ESSAY_TOOL, { essay: "x".repeat(150) });
    await c.callTool(SCORE_TOOL, {
      text: "t",
      question: "How relevant?",
      levels: ["Low", "High"],
    });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the JEVAGENT_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new RubricscoreClient({
      fetchFn: upstream.fetchFn,
      env: { JEVAGENT_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { JEVAGENT_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new RubricscoreClient({
      fetchFn: upstream.fetchFn,
      env: { JEVAGENT_MCP_URL: "   " },
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends Authorization: Bearer on every request when JEVAGENT_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new RubricscoreClient({
      fetchFn: upstream.fetchFn,
      env: { JEVAGENT_API_KEY: "jev-key-42" },
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every(
        (call) => call.headers["Authorization"] === "Bearer jev-key-42",
      ),
    );
  });

  it("sends no Authorization header when JEVAGENT_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });

  it("sends no Authorization header when JEVAGENT_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new RubricscoreClient({
      fetchFn: upstream.fetchFn,
      env: { JEVAGENT_API_KEY: "   " },
    });
    await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(
      upstream.calls.every((call) => call.headers["Authorization"] === undefined),
    );
  });

  it("never sends an X-API-Key header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new RubricscoreClient({
      fetchFn: withKey.fetchFn,
      env: { JEVAGENT_API_KEY: "jev-key-42" },
    });
    await c1.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(withKey.calls.every((call) => call.headers["X-API-Key"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.ok(calls.every((call) => call.headers["X-API-Key"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a check_resume call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { resume: "x".repeat(200), job_description: " posting " };
    await c.callTool(RESUME_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RESUME_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a grade_essay call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { essay: "x".repeat(150), kind: "common-app", prompt: 3 };
    await c.callTool(ESSAY_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ESSAY_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a grade_with_rubric call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      criteria: [{ name: "Evidence", description: "Supports the claim" }],
      points: 5,
      submissions: [{ name: "Ana", text: "x".repeat(150) }],
    };
    await c.callTool(RUBRIC_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, RUBRIC_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a judge_yes_no call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { text: "The reply explains the refund.", question: "Does it answer?" };
    await c.callTool(YESNO_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, YESNO_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a judge_choice call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      text: "My card was charged twice.",
      question: "Which queue?",
      options: { billing: "Payments, refunds, invoices", technical: "Bugs and errors" },
    };
    await c.callTool(CHOICE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHOICE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a judge_score call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      text: "A paragraph about sorting.",
      question: "How relevant?",
      levels: ["Off-topic", "Partly relevant", "Fully relevant"],
    };
    await c.callTool(SCORE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, SCORE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a compare_versions call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = {
      question: "Which opening is stronger?",
      version_a: "First opening.",
      version_b: "Second opening.",
      context: "The whole essay.",
    };
    await c.callTool(COMPARE_TOOL, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COMPARE_TOOL);
    assert.deepEqual(params.arguments, args);
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "could not judge text" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      COMPARE_TOOL,
      { question: "Which?", version_a: "a", version_b: "b" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COMPARE_TOOL);
    assert.deepEqual(params.arguments, {
      question: "Which?",
      version_a: "a",
      version_b: "b",
    });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as rubricscore error text", () => {
  it("maps a JSON-RPC error to `rubricscore error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "grading failed upstream" },
    });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: grading failed upstream");
  });

  it("maps an initialize JSON-RPC error to rubricscore error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: malformed response");
  });

  it("maps a non-2xx upstream status to rubricscore error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: HTTP 500");
  });

  it("maps a throwing fetch to rubricscore error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rubricscore error: /);
  });

  it("maps a throwing initialize fetch to rubricscore error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rubricscore error: socket hang up");
  });

  it("maps a timed-out call to rubricscore error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(YESNO_TOOL, { text: "t", question: "Is it?" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rubricscore error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, YESNO_TOOL, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, YESNO_TOOL, "text=hi"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid judge_yes_no call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, YESNO_TOOL, {
      text: "t",
      question: "Is it?",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { text: "t", question: "Is it?" });
  });

  it("forwards a valid compare_versions call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, COMPARE_TOOL, {
      question: "Which?",
      version_a: "a",
      version_b: "b",
    });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COMPARE_TOOL);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, YESNO_TOOL, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([YESNO_TOOL, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([YESNO_TOOL, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
