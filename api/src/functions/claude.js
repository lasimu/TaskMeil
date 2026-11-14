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
// Bedrock offers different models per account and region, so without an
// explicit CLAUDE_MODEL the function takes the first of these that exists
// there and remembers it.
const BEDROCK_MODELS = [
  "anthropic.claude-opus-5-5",
  "anthropic.claude-opus-4-8",
  "anthropic.claude-sonnet-5",
  "anthropic.claude-haiku-4-5",
];
let MODEL = process.env.CLAUDE_MODEL || (BEDROCK ? BEDROCK_MODELS[0] : "claude-opus-5-5");

let offered = null; // model ids the Bedrock region lists for this key, once asked

// Asks the Bedrock region which models this key can use.
async function listBedrockModels() {
  const res = await fetch(`https://bedrock-mantle.${process.env.AWS_REGION}.api.aws/v1/models`, {
    headers: { Authorization: `Bearer ${process.env.AWS_BEARER_TOKEN_BEDROCK}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`model list HTTP ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((m) => m.id).filter((id) => typeof id === "string");
}

const isMissing = (err) =>
  err instanceof Anthropic.NotFoundError || err instanceof Anthropic.PermissionDeniedError;

async function createOnBedrock(params) {
  // A model set by hand or already found by asking the region is used as it is.
  const candidates = BEDROCK_MODELS.includes(MODEL) && !process.env.CLAUDE_MODEL
    ? BEDROCK_MODELS.slice(BEDROCK_MODELS.indexOf(MODEL))
    : [MODEL];
  let lastError;
  const attempt = async (model) => {
    try {
      const response = await getClient().messages.create({ ...params, model });
      MODEL = model;
      return response;
    } catch (err) {
      if (!isMissing(err)) throw err;
      lastError = err;
      return null;
    }
  };
  for (const model of candidates) {
    const response = await attempt(model);
    if (response) return response;
  }
  // None of the usual names exist here: ask the region what it does offer and
  // take its strongest Claude model (ids may carry a prefix such as "eu.").
  try {
    offered = await listBedrockModels();
  } catch (err) {
    offered = [`(${err.message})`];
  }
  const rank = (id) => ["haiku", "sonnet", "opus"].findIndex((tier) => id.includes(tier));
  const claude = offered
    .filter((id) => id.includes("claude") && !candidates.includes(id))
    .sort((a, b) => rank(b) - rank(a) || b.localeCompare(a));
  for (const model of claude.slice(0, 4)) {
    const response = await attempt(model);
    if (response) return response;
  }
  throw lastError;
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
  const list = offered ? ` Models offered here: ${offered.join(", ").slice(0, 900) || "none"}.` : "";
  return `${BEDROCK ? "Bedrock " + process.env.AWS_REGION : "Anthropic"}, model ${MODEL}, HTTP ${err?.status}: ${message}${list}`;
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
    if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
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
    if (err instanceof Anthropic.APIError) {
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
  context.log(
    `claude ${action} for ${who.user}: in=${response.usage.input_tokens} out=${response.usage.output_tokens}`
  );
  return json(200, { result });
}

app.http("claude", {
  methods: ["POST"],
  authLevel: "anonymous",
  route: "claude",
  handler,
});

module.exports = { handler };
