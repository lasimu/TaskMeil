// POST /api/claude
// Body: { action: "task" | "reply", email: { subject, from, to, received, body },
//         instructions?, today, timezone }
// Returns { result } where result is { title, notes, due_date, importance }
// for "task" or { body } for "reply".
//
// The Anthropic API key is read from the ANTHROPIC_API_KEY app setting and
// never leaves this function. Nothing here can send mail: the function only
// returns a suggestion and the user sends from the browser with their own click.

const { app } = require("@azure/functions");
const Anthropic = require("@anthropic-ai/sdk");
const { verifyUser, AuthError } = require("../lib/auth");
const { SYSTEM, ACTIONS, buildUserMessage } = require("../lib/prompts");

const MODEL = process.env.CLAUDE_MODEL || "claude-opus-5-5";
const MAX_EMAIL_CHARS = 120000;

let client;
function getClient() {
  if (!client) {
    // Static Web Apps cuts API calls off at about 45 seconds.
    client = new Anthropic({ timeout: 40000, maxRetries: 1 });
  }
  return client;
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

  if (!process.env.ANTHROPIC_API_KEY) {
    return json(500, { error: "Server is missing ANTHROPIC_API_KEY." });
  }

  let input;
  try {
    input = await request.json();
  } catch {
    return json(400, { error: "Request body must be JSON." });
  }

  const action = input?.action;
  if (!Object.hasOwn(ACTIONS, action)) {
    return json(400, { error: 'action must be "task" or "reply".' });
  }
  const body = typeof input.email?.body === "string" ? input.email.body : "";
  if (!body.trim() && !str(input.email?.subject, 10)) {
    return json(400, { error: "The email is empty." });
  }
  if (body.length > MAX_EMAIL_CHARS) {
    return json(413, { error: "The email is too long for Claude to read here." });
  }

  const userMessage = buildUserMessage({
    action,
    email: {
      subject: str(input.email.subject, 500),
      from: str(input.email.from, 500),
      to: str(input.email.to, 2000),
      received: str(input.email.received, 100),
      body,
    },
    instructions: str(input.instructions, 2000).trim(),
    userName: who.name,
    today: str(input.today, 60),
    timezone: str(input.timezone, 60),
  });

  let response;
  try {
    response = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      // If the model declines a request, the API retries it on a fallback model.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: SYSTEM,
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        effort: ACTIONS[action].effort,
        format: { type: "json_schema", schema: ACTIONS[action].schema },
      },
    });
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) {
      context.error("Anthropic API key rejected");
      return json(500, { error: "The Anthropic API key was rejected." });
    }
    if (err instanceof Anthropic.RateLimitError) {
      return json(429, { error: "Claude is busy right now. Try again in a moment." });
    }
    if (err instanceof Anthropic.APIConnectionError) {
      return json(504, { error: "Claude did not answer in time. Try again." });
    }
    if (err instanceof Anthropic.APIError) {
      context.error(`Anthropic API error ${err.status}: ${err.message}`);
      return json(502, { error: "Claude returned an error. Try again." });
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

  if (action === "task" && !/^\d{4}-\d{2}-\d{2}$/.test(result.due_date || "")) {
    result.due_date = null;
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
