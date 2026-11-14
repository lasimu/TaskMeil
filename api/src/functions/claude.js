// POST /api/claude
// Body: { action: "task" | "reply", email: { subject, from, to, received, body },
//         instructions?, today, timezone }
//   or: { action: "triage", emails: [{ id, from, subject, received, preview }],
//         today, timezone }
// Returns { result } where result is { title, notes, due_date, importance }
// for "task", { body } for "reply", and { tasks: [{ id, title, due_date,
// importance }] } for "triage" (only the emails worth a to-do item).
//
// Claude is reached either through Amazon Bedrock (app settings
// AWS_BEARER_TOKEN_BEDROCK + AWS_REGION) or through the Anthropic API
// (ANTHROPIC_API_KEY). Bedrock wins when both are set. The key is read from
// the app settings and never leaves this function. Nothing here can send mail: the function only
// returns a suggestion and the user sends from the browser with their own click.

const { app } = require("@azure/functions");
const Anthropic = require("@anthropic-ai/sdk");
const { verifyUser, AuthError } = require("../lib/auth");
const { SYSTEM, ACTIONS, buildUserMessage, buildTriageMessage } = require("../lib/prompts");

// With Bedrock the email text is processed inside AWS, in the chosen region.
const BEDROCK = Boolean(process.env.AWS_BEARER_TOKEN_BEDROCK);
// Amazon Bedrock serves Claude at two addresses, and which models an account
// gets differs per account and region:
//   "mantle"  - bedrock-mantle, the current Messages API (Claude 4.7 and newer)
//   "runtime" - bedrock-runtime, the older InvokeModel API (Claude 4.6 and older)
// Without an explicit CLAUDE_MODEL the function finds the first model that
// works and remembers it together with its address.
const REGION = process.env.AWS_REGION || "";
// Geographic prefix keeps processing inside that geography (eu-central-1 -> "eu.").
const GEO = REGION.startsWith("eu-") ? "eu." : REGION.startsWith("us-") ? "us." : "global.";
const MANTLE_MODEL = "anthropic.claude-opus-5-5";
const RUNTIME_MODELS = [
  `${GEO}anthropic.claude-opus-4-6-v1`,
  `${GEO}anthropic.claude-sonnet-4-6`,
  `${GEO}anthropic.claude-haiku-4-5-20251001-v1:0`,
];
let MODEL = process.env.CLAUDE_MODEL || (BEDROCK ? MANTLE_MODEL : "claude-opus-5-5");
let route = null; // "mantle" | "runtime", once a model has answered
let offered = null; // what the mantle address lists for this key, once asked

let runtimeClient;
function getRuntimeClient() {
  if (!runtimeClient) {
    const { AnthropicBedrock } = require("@anthropic-ai/bedrock-sdk");
    runtimeClient = new AnthropicBedrock({
      apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
      awsRegion: REGION,
      timeout: 40000,
      maxRetries: 1,
    });
  }
  return runtimeClient;
}

// The model or address is wrong for this account, as opposed to a real failure.
const isMissing = (err) => [400, 403, 404].includes(err?.status);

async function viaMantle(params, model) {
  return getClient().messages.create({ ...params, model });
}

// The older models take the JSON shape as a tool they are required to call.
async function viaRuntime(params, model) {
  const { output_config: config, ...rest } = params;
  const response = await getRuntimeClient().messages.create({
    ...rest,
    model,
    tools: [{ name: "result", description: "Return the result.", input_schema: config.format.schema }],
    tool_choice: { type: "tool", name: "result" },
  });
  const call = response.content.find((block) => block.type === "tool_use");
  return {
    stop_reason: response.stop_reason === "tool_use" ? "end_turn" : response.stop_reason,
    usage: response.usage,
    content: call ? [{ type: "text", text: JSON.stringify(call.input) }] : [],
  };
}

async function listMantleModels() {
  const res = await fetch(`https://bedrock-mantle.${REGION}.api.aws/v1/models`, {
    headers: { Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`model list HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).filter((id) => typeof id === "string");
}

async function createOnBedrock(params) {
  if (route) return route === "mantle" ? viaMantle(params, MODEL) : viaRuntime(params, MODEL);

  let lastError;
  const attempt = async (via, name, model) => {
    try {
      const response = await via(params, model);
      MODEL = model;
      route = name;
      return response;
    } catch (err) {
      if (!isMissing(err)) throw err;
      MODEL = model;
      lastError = err;
      return null;
    }
  };

  const chosen = process.env.CLAUDE_MODEL;
  const mantle = [chosen || MANTLE_MODEL];
  let response = await attempt(viaMantle, "mantle", mantle[0]);
  if (response) return response;
  if (!chosen) {
    // Ask what this address does offer and take its strongest Claude models.
    try {
      offered = await listMantleModels();
    } catch (err) {
      offered = [`(${err.message})`];
    }
    const rank = (id) => ["haiku", "sonnet", "opus"].findIndex((tier) => id.includes(tier));
    const claude = offered
      .filter((id) => id.includes("claude") && id !== MANTLE_MODEL)
      .sort((a, b) => rank(b) - rank(a) || b.localeCompare(a));
    for (const model of claude.slice(0, 3)) {
      response = await attempt(viaMantle, "mantle", model);
      if (response) return response;
    }
  }
  for (const model of chosen ? [chosen] : RUNTIME_MODELS) {
    response = await attempt(viaRuntime, "runtime", model);
    if (response) return response;
  }
  throw lastError;
}

// USD per million tokens (input, output), for the cost estimate shown in the
// app. Bedrock's geographic routing ("eu.", "us.") costs 10 percent more.
const PRICES = [
  ["opus-5-5", 4, 20],
  ["sonnet-5", 2, 10],
  ["haiku-5-5", 0.1, 0.5],
  ["opus", 5, 25],
  ["sonnet", 3, 15],
  ["haiku", 1, 5],
];
function usageOf(response) {
  const input =
    (response.usage.input_tokens || 0) +
    (response.usage.cache_creation_input_tokens || 0) +
    (response.usage.cache_read_input_tokens || 0);
  const output = response.usage.output_tokens || 0;
  const price = PRICES.find(([name]) => MODEL.includes(name));
  const premium = /^(eu|us|jp|au|apac)\./.test(MODEL) ? 1.1 : 1;
  const cost = price ? ((input * price[1] + output * price[2]) / 1e6) * premium : 0;
  return { model: MODEL, input_tokens: input, output_tokens: output, cost_usd: Number(cost.toFixed(6)) };
}

const MAX_EMAIL_CHARS = 120000;
const MAX_TRIAGE_EMAILS = 40;

let client;
function getClient() {
  if (!client) {
    // Static Web Apps cuts API calls off at about 45 seconds.
    const options = { timeout: 40000, maxRetries: 1 };
    client = BEDROCK
      ? new Anthropic({
          ...options,
          apiKey: process.env.AWS_BEARER_TOKEN_BEDROCK,
          baseURL: `https://bedrock-mantle.${process.env.AWS_REGION}.api.aws/anthropic`,
        })
      : new Anthropic(options);
  }
  return client;
}

// What the Claude service answered, for the signed-in user to pass on when
// something is misconfigured. It holds no key and no email text.
function upstreamDetail(err) {
  const message = String(err?.error?.error?.message || err?.error?.message || err?.message || "").slice(0, 300);
  const claude = offered ? offered.filter((id) => id.includes("claude")) : null;
  const list = claude ? ` Claude models listed at the newer address: ${claude.join(", ").slice(0, 400) || "none"}.` : "";
  return `${BEDROCK ? "Bedrock " + REGION : "Anthropic"}, last tried ${MODEL}, HTTP ${err?.status}: ${message}${list}`;
}

const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

function json(status, body) {
  return { status, jsonBody: body, headers: { "Cache-Control": "no-store" } };
}

async function handler(request, context) {
  let who;
  try {
    who = await verifyUser(request.headers.get("x-taskmeil-token"));
  } catch (err) {
    if (err instanceof AuthError) return json(err.status, { error: err.message });
    context.error("Auth check failed", err);
    return json(500, { error: "Sign-in check failed." });
  }

  if (BEDROCK && !/^[a-z]{2}(-[a-z]+)+-\d$/.test(process.env.AWS_REGION || "")) {
    return json(500, { error: "Server is missing AWS_REGION (for example eu-north-1)." });
  }
  if (!BEDROCK && !process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "Server is missing AWS_BEARER_TOKEN_BEDROCK or ANTHROPIC_API_KEY." });
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }

  const action = input?.action;
  if (!Object.hasOwn(ACTIONS, action)) {
    return json(400, { error: 'action must be "task", "reply" or "triage".' });
  }
  const common = { userName: who.name, today: str(input.today, 60), timezone: str(input.timezone, 60) };

  let userMessage;
  let triageIds;
  if (action === "triage") {
    const emails = Array.isArray(input.emails) ? input.emails.filter((e) => typeof e?.id === "string") : [];
    if (!emails.length) return json(400, { error: "No emails to look through." });
    if (emails.length > MAX_TRIAGE_EMAILS) {
      return json(413, { error: `At most ${MAX_TRIAGE_EMAILS} emails at a time.` });
    }
    triageIds = emails.map((e) => e.id);
    userMessage = buildTriageMessage({
      ...common,
      emails: emails.map((e) => ({
        from: str(e.from, 300),
        subject: str(e.subject, 300),
        received: str(e.received, 100),
        preview: str(e.preview, 600),
      })),
    });
  } else {
    const body = typeof input.email?.body === "string" ? input.email.body : "";
    if (!body.trim() && !str(input.email?.subject, 10)) {
      return json(400, { error: "The email is empty." });
    }
    if (body.length > MAX_EMAIL_CHARS) {
      return json(413, { error: "The email is too long for Claude to read here." });
    }
    userMessage = buildUserMessage({
      ...common,
      action,
      email: {
        subject: str(input.email.subject, 500),
        from: str(input.email.from, 500),
        to: str(input.email.to, 2000),
        received: str(input.email.received, 100),
        body,
      },
      instructions: str(input.instructions, 2000).trim(),
    });
  }

  const params = {
    model: MODEL,
    max_tokens: 8000,
    system: ACTIONS[action].system || SYSTEM,
    messages: [{ role: "user", content: userMessage }],
    output_config: {
      effort: ACTIONS[action].effort,
      format: { type: "json_schema", schema: ACTIONS[action].schema },
    },
  };
  let response;
  try {
    response = BEDROCK
      ? await createOnBedrock(params)
      : // If the model declines a request, the Anthropic API retries it on a
        // fallback model. Bedrock does not offer this.
        await getClient().beta.messages.create({
          ...params,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        });
  } catch (err) {
    // The older Bedrock client has its own error classes, so go by status too.
    const timedOut = /timed? ?out|connection error/i.test(err?.message || "") && !err?.status;
    if (err?.status === 429) {
      return json(429, { error: "Claude is busy right now. Try again in a moment." });
    }
    if (timedOut) return json(504, { error: "Claude did not answer in time. Try again." });
    if ([401, 403].includes(err?.status)) {
      context.error(`Claude API key rejected or model not allowed (${err.status}): ${err.message}`);
      return json(500, {
        error: "The Claude API key was rejected, or it has no access to the model.",
        detail: upstreamDetail(err),
      });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { error: "Claude is busy right now. Try again in a moment." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return json(504, { error: "Claude did not answer in time. Try again." });
    }
    if (err instanceof Anthropic.APIError || err?.status) {
      context.error(`Anthropic API error ${err.status}: ${err.message}`);
      return json(502, { error: "Claude returned an error. Try again.", detail: upstreamDetail(err) });
    }
    throw err;
  }

  if (response.stop_reason === "refusal") {
    return json(422, { error: "Claude declined to help with this email." });
  }
  if (response.stop_reason === "max_tokens") {
    return json(502, { error: "Claude's answer was cut off. Try again." });
  }

  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  let result;
  try {
    result = JSON.parse(text);
  } catch {
    context.error("Claude returned text that is not JSON");
    return json(502, { error: "Claude's answer could not be read. Try again." });
  }

  const isDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(v || "");
  if (action === "task" && !isDate(result.due_date)) result.due_date = null;
  if (action === "triage") {
    // Swap the numbers Claude saw back to message ids; drop anything out of range.
    const seen = new Set();
    result = {
      tasks: (Array.isArray(result.tasks) ? result.tasks : [])
        .filter((t) => Number.isInteger(t?.n) && triageIds[t.n - 1] && !seen.has(t.n) && seen.add(t.n))
        .map((t) => ({
          id: triageIds[t.n - 1],
          title: str(t.title, 255),
          due_date: isDate(t.due_date) ? t.due_date : null,
          importance: t.importance === "high" ? "high" : "normal",
        })),
    };
  }
  const usage = usageOf(response);
  context.log(`claude ${action} for ${who.user}: ${usage.model} in=${usage.input_tokens} out=${usage.output_tokens}`);
  return json(200, { result, usage });
}

app.http("claude", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "claude",
  handler,
});

module.exports = { handler };
