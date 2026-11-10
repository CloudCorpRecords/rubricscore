/**
 * rubricscore core: a forwarding client for the hosted
 * jagent MCP server.
 *
 * No text is graded on this machine. tools/list is
 * answered from the literal definitions below, which
 * reproduce a live capture of the upstream server
 * word for word (name, title, description and
 * inputSchema exactly as captured). A tools/call travels
 * upstream over a streamable-HTTP JSON-RPC session: an
 * initialize POST, a notifications/initialized POST, then
 * the tools/call POST, carrying the Mcp-Session-Id
 * response header on later requests when the upstream
 * issues one. The session opens lazily on the first
 * forwarded call and is reused for the client's lifetime.
 *
 * The endpoint is pinned to
 * https://jev-agent.com/api/mcp and may be replaced with
 * the JEVAGENT_MCP_URL environment variable (that
 * override is a labelled reconstruction). When
 * JEVAGENT_API_KEY is set, every upstream request carries
 * an `Authorization: Bearer <key>` header (the header
 * name is pinned by the registry record's own remote
 * declaration, which marks it a required secret; the
 * Bearer form and forwarding the key from this env var
 * are labelled reconstructions, as the capture was taken
 * keyless). When it is unset, no key header goes out.
 *
 * A successful upstream result is returned exactly as
 * received, isError flag and extra fields included.
 * Failures — an upstream JSON-RPC error, a non-2xx
 * status, a body that cannot be parsed, or a fetch that
 * throws or times out — become an isError result whose
 * text begins with `rubricscore error:` (that rendering
 * is a labelled reconstruction). Replies may be plain JSON
 * or SSE (`data:` lines); the JSON-RPC message whose id
 * matches the request wins.
 */
import type {
  FetchFn,
  FetchResponseLike,
  ForwardDeps,
  ToolArgs,
  ToolDef,
  ToolResult,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_ENDPOINT_URL = "https://jev-agent.com/api/mcp";

export const DEFAULT_TIMEOUT_MS = 30000;

export const PROTOCOL_VERSION = "2025-03-26";

/* ------------------------------------------------------------------ */
/* Tool definitions (tools/list literals, verbatim from the live       */
/* capture in harness/fixtures/jevagent-tools-original.json;           */
/* generated programmatically by parsing and re-serialising the        */
/* fixture JSON, never retyped)                                        */
/* ------------------------------------------------------------------ */

export const TOOL_DEFS: ToolDef[] = [
  {
    "name": "check_resume",
    "title": "Check a resume",
    "description": "Score a resume, optionally against a job posting: a 0-100 match score, the posting's keywords found and missing (matched literally, as an ATS search would), ATS format checks, the level fit, and the probability a recruiter would move it to interview.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "resume": {
          "type": "string",
          "minLength": 150,
          "maxLength": 12000,
          "description": "The resume as plain text."
        },
        "job_description": {
          "description": "The job posting to match against. Omit for a general resume check.",
          "type": "string",
          "maxLength": 8000
        }
      },
      "required": [
        "resume"
      ]
    }
  },
  {
    "name": "grade_essay",
    "title": "Grade an essay",
    "description": "Grade one essay against a built-in rubric. kind \"essay\": six criteria and a letter grade, for class essays at middle school, high school or college level. kind \"common-app\": a Common App personal statement (pass the prompt number, 1-7). kind \"sat\": an SAT School Day essay, Reading/Analysis/Writing each 1-4 (pass the source passage to check quotations).",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "essay": {
          "type": "string",
          "minLength": 100,
          "maxLength": 20000,
          "description": "The essay text."
        },
        "kind": {
          "default": "essay",
          "type": "string",
          "enum": [
            "essay",
            "common-app",
            "sat"
          ]
        },
        "level": {
          "description": "kind \"essay\" only. Default high school.",
          "type": "string",
          "enum": [
            "middle school",
            "high school",
            "college"
          ]
        },
        "assignment": {
          "description": "kind \"essay\": the assignment prompt.",
          "type": "string",
          "maxLength": 2000
        },
        "prompt": {
          "description": "kind \"common-app\": which of the seven prompts. Default 7, topic of your choice.",
          "type": "integer",
          "minimum": 1,
          "maximum": 7
        },
        "passage": {
          "description": "kind \"sat\": the source passage.",
          "type": "string",
          "maxLength": 8000
        }
      },
      "required": [
        "essay"
      ]
    }
  },
  {
    "name": "grade_with_rubric",
    "title": "Grade against your own rubric",
    "description": "Grade one or more submissions (up to 30, in parallel) against a rubric you supply: each criterion scored on a 3- to 6-point scale, summed per submission. Each submission is graded in its own call, so its score never depends on the others.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "criteria": {
          "minItems": 1,
          "maxItems": 8,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "minLength": 1,
                "maxLength": 60
              },
              "description": {
                "type": "string",
                "maxLength": 300
              }
            },
            "required": [
              "name"
            ]
          },
          "description": "Rubric rows, e.g. { \"name\": \"Evidence\", \"description\": \"Supports the claim with specific evidence\" }."
        },
        "points": {
          "default": 4,
          "type": "integer",
          "minimum": 3,
          "maximum": 6
        },
        "submissions": {
          "minItems": 1,
          "maxItems": 30,
          "type": "array",
          "items": {
            "type": "object",
            "properties": {
              "name": {
                "type": "string",
                "maxLength": 80
              },
              "text": {
                "type": "string",
                "minLength": 100,
                "maxLength": 20000
              }
            },
            "required": [
              "text"
            ]
          }
        },
        "assignment": {
          "type": "string",
          "maxLength": 2000
        }
      },
      "required": [
        "criteria",
        "submissions"
      ]
    }
  },
  {
    "name": "judge_yes_no",
    "title": "Yes/no judgment",
    "description": "Ask any yes/no question about a text and get the probability that the answer is yes. Use for checks and gates, e.g. 'Does this reply answer the customer's question?'.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 60000,
          "description": "The text to judge."
        },
        "question": {
          "type": "string",
          "minLength": 3,
          "maxLength": 1000
        },
        "yes_means": {
          "description": "What a yes looks like, if it helps to spell out.",
          "type": "string",
          "maxLength": 300
        },
        "no_means": {
          "type": "string",
          "maxLength": 300
        }
      },
      "required": [
        "text",
        "question"
      ]
    }
  },
  {
    "name": "judge_choice",
    "title": "Multiple-choice judgment",
    "description": "Pick the option that best fits a text, with a probability for every option and a confidence. Options map an id to a description of when it applies.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 60000
        },
        "question": {
          "type": "string",
          "minLength": 3,
          "maxLength": 1000
        },
        "options": {
          "type": "object",
          "propertyNames": {
            "type": "string",
            "minLength": 1,
            "maxLength": 60
          },
          "additionalProperties": {
            "type": "string",
            "minLength": 1,
            "maxLength": 500
          },
          "description": "e.g. { \"billing\": \"Payments, refunds, invoices\", \"technical\": \"Bugs and errors\" }"
        }
      },
      "required": [
        "text",
        "question",
        "options"
      ]
    }
  },
  {
    "name": "judge_score",
    "title": "Rubric judgment",
    "description": "Place a text on an ordered scale you define (lowest level first) and get the nearest level, the exact position and a probability for each level.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "text": {
          "type": "string",
          "minLength": 1,
          "maxLength": 60000
        },
        "question": {
          "type": "string",
          "minLength": 3,
          "maxLength": 1000
        },
        "levels": {
          "minItems": 2,
          "maxItems": 10,
          "type": "array",
          "items": {
            "type": "string",
            "minLength": 1,
            "maxLength": 300
          },
          "description": "Lowest first, e.g. [\"Off-topic\", \"Partly relevant\", \"Fully relevant\"]."
        }
      },
      "required": [
        "text",
        "question",
        "levels"
      ]
    }
  },
  {
    "name": "compare_versions",
    "title": "Compare two versions",
    "description": "Which of two versions is stronger for a stated purpose. Asked twice with the order swapped and averaged, because the model favors the second option on close calls; if the two orders disagree the result is a tie.",
    "inputSchema": {
      "type": "object",
      "$schema": "https://json-schema.org/draft/2020-12/schema",
      "properties": {
        "question": {
          "type": "string",
          "minLength": 3,
          "maxLength": 1000,
          "description": "e.g. 'Which opening line would an admissions reader find more compelling?'"
        },
        "version_a": {
          "type": "string",
          "minLength": 1,
          "maxLength": 5000
        },
        "version_b": {
          "type": "string",
          "minLength": 1,
          "maxLength": 5000
        },
        "context": {
          "description": "The surrounding text, such as the whole essay or the job posting.",
          "type": "string",
          "maxLength": 60000
        }
      },
      "required": [
        "question",
        "version_a",
        "version_b"
      ]
    }
  }
];

export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

/** Whether `name` belongs to the captured surface. */
export function isKnownTool(name: string): boolean {
  return TOOL_NAMES.includes(name);
}

/* ------------------------------------------------------------------ */
/* Forwarding client                                                   */
/* ------------------------------------------------------------------ */

function errorResult(detail: string): ToolResult {
  return {
    content: [{ type: "text", text: `rubricscore error: ${detail}` }],
    isError: true,
  };
}

function rpcErrorMessage(error: unknown): string {
  if (error !== null && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message !== "") return message;
    return JSON.stringify(error);
  }
  return String(error);
}

/**
 * Read a JSON-RPC response body, tolerating SSE framing.
 * Returns the message whose id matches `expectedId` when
 * present, otherwise the last parseable message, otherwise
 * null when nothing in the body parses.
 */
export function parseRpcBody(
  text: string,
  expectedId?: number,
): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed === "") return null;
  const candidates: Record<string, unknown>[] = [];
  const tryPush = (payload: string): void => {
    try {
      const parsed: unknown = JSON.parse(payload);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        candidates.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Not a JSON payload; skip this candidate.
    }
  };
  if (trimmed.includes("data:")) {
    for (const line of trimmed.split("\n")) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice("data:".length).trim();
      if (payload !== "" && payload !== "[DONE]") tryPush(payload);
    }
  } else {
    tryPush(trimmed);
  }
  if (candidates.length === 0) return null;
  if (expectedId !== undefined) {
    const match = candidates.find((c) => c.id === expectedId);
    if (match !== undefined) return match;
  }
  return candidates[candidates.length - 1];
}

async function defaultFetch(
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  },
): Promise<FetchResponseLike> {
  return fetch(url, init) as unknown as FetchResponseLike;
}

/**
 * A forwarding client holding a single upstream session,
 * opened lazily on first use and reused from then on
 * (for the process lifetime in the MCP server, or for a
 * single invocation in the CLI).
 */
export class RubricscoreClient {
  private readonly deps: ForwardDeps;
  private sessionId: string | null = null;
  private ready = false;
  private sessionPromise: Promise<void> | null = null;
  private idCounter = 0;

  constructor(deps: ForwardDeps = {}) {
    this.deps = deps;
  }

  private fetchFn(): FetchFn {
    return this.deps.fetchFn ?? defaultFetch;
  }

  private endpointUrl(): string {
    if (this.deps.url && this.deps.url.trim() !== "") return this.deps.url.trim();
    const raw = (this.deps.env ?? process.env).JEVAGENT_MCP_URL;
    if (raw && raw.trim() !== "") return raw.trim();
    return DEFAULT_ENDPOINT_URL;
  }

  private apiKey(): string | null {
    const raw = (this.deps.env ?? process.env).JEVAGENT_API_KEY;
    if (raw && raw.trim() !== "") return raw.trim();
    return null;
  }

  private timeoutMs(): number {
    if (typeof this.deps.timeoutMs === "number" && this.deps.timeoutMs > 0) {
      return this.deps.timeoutMs;
    }
    return DEFAULT_TIMEOUT_MS;
  }

  private nextId(): number {
    this.idCounter += 1;
    return this.idCounter;
  }

  private async post(
    body: unknown,
    withSession: boolean,
  ): Promise<FetchResponseLike> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    };
    const key = this.apiKey();
    if (key !== null) headers["Authorization"] = `Bearer ${key}`;
    if (withSession && this.sessionId !== null) {
      headers["Mcp-Session-Id"] = this.sessionId;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs());
    try {
      return await this.fetchFn()(this.endpointUrl(), {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ensureSession(): Promise<void> {
    if (this.ready) return;
    if (this.sessionPromise === null) {
      this.sessionPromise = (async () => {
        const initId = this.nextId();
        const initRes = await this.post(
          {
            jsonrpc: "2.0",
            id: initId,
            method: "initialize",
            params: {
              protocolVersion: PROTOCOL_VERSION,
              capabilities: {},
              clientInfo: { name: "rubricscore", version: VERSION },
            },
          },
          false,
        );
        const sessionId = initRes.headers.get("mcp-session-id");
        if (sessionId) this.sessionId = sessionId;
        const initText = await initRes.text();
        const initParsed = parseRpcBody(initText, initId);
        if (initParsed !== null && initParsed.error) {
          throw new Error(rpcErrorMessage(initParsed.error));
        }
        if (initRes.status < 200 || initRes.status >= 300) {
          throw new Error(`HTTP ${initRes.status}`);
        }
        if (initParsed === null && initText.trim() !== "") {
          throw new Error("malformed response");
        }
        const initializedRes = await this.post(
          { jsonrpc: "2.0", method: "notifications/initialized" },
          true,
        );
        try {
          await initializedRes.text();
        } catch {
          // Nothing needed from the notification response body.
        }
        this.ready = true;
      })();
    }
    try {
      await this.sessionPromise;
    } catch (err) {
      this.sessionPromise = null;
      this.sessionId = null;
      throw err;
    }
  }

  /** Forward one tool call; upstream failures come back as isError results. */
  async callTool(name: string, args: ToolArgs): Promise<ToolResult> {
    try {
      await this.ensureSession();
    } catch (err) {
      return errorResult(err instanceof Error ? err.message : String(err));
    }

    const callId = this.nextId();
    let callRes: FetchResponseLike;
    try {
      callRes = await this.post(
        {
          jsonrpc: "2.0",
          id: callId,
          method: "tools/call",
          params: { name, arguments: args ?? {} },
        },
        true,
      );
    } catch (err) {
      return errorResult(
        `request failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const parsed = parseRpcBody(await callRes.text(), callId);
    if (parsed !== null && parsed.error) {
      return errorResult(rpcErrorMessage(parsed.error));
    }
    if (callRes.status < 200 || callRes.status >= 300) {
      return errorResult(`HTTP ${callRes.status}`);
    }
    if (parsed === null) return errorResult("malformed response");
    const result = parsed.result as ToolResult | undefined;
    if (result === undefined || result === null || typeof result !== "object") {
      return errorResult("malformed response");
    }
    // Hand the upstream result back exactly as received.
    return result;
  }
}

/** Build a forwarding client; tests inject a fake fetch and env through deps. */
export function createClient(deps: ForwardDeps = {}): RubricscoreClient {
  return new RubricscoreClient(deps);
}

/** One-shot helper: a fresh client for a single call (the CLI path). */
export async function callTool(
  name: string,
  args: ToolArgs,
  deps: ForwardDeps = {},
): Promise<ToolResult> {
  return new RubricscoreClient(deps).callTool(name, args);
}
