// Thin wrapper around Microsoft Graph. All mail, calendar and task data
// goes directly between the browser and Microsoft.

import { getGraphToken, getIdToken } from "./auth.js";

const ROOT = "https://graph.microsoft.com/v1.0";

export class GraphError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function graph(path, { method = "GET", body, headers = {} } = {}) {
  const url = path.startsWith("https://") ? path : ROOT + path;
  for (let attempt = 0; ; attempt++) {
    const token = await getGraphToken();
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 429 && attempt < 2) {
      const wait = Math.min(Number(res.headers.get("Retry-After")) || 2, 10);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      let message = `Microsoft Graph vastas veaga ${res.status}`;
      try {
        const data = await res.json();
        if (data?.error?.message) message = data.error.message;
      } catch {
        /* no JSON body */
      }
      throw new GraphError(res.status, message);
    }
    if (res.status === 204 || res.status === 202) return null;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }
}

const CLAUDE_ERRORS = {
  401: "Sisselogimine aegus. Laadi leht uuesti.",
  403: "Sul ei ole õigust Claude'i siin kasutada.",
  413: "Kiri on Claude'i jaoks liiga pikk.",
  422: "Claude keeldus selle kirjaga aitamast.",
  429: "Claude on praegu hõivatud. Proovi mõne hetke pärast uuesti.",
  504: "Claude ei vastanud õigel ajal. Proovi uuesti.",
};

// Asks our server function for a suggestion. It returns text only.
export async function askClaude(action, email, instructions = "") {
  const res = await fetch("/api/claude", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Taskmeil-Token": await getIdToken(),
    },
    body: JSON.stringify({
      action,
      email,
      instructions,
      today: `${new Date().toLocaleDateString("en-GB", { weekday: "long" })} ${localDate(new Date())}`,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok || !data?.result) {
    throw new Error(CLAUDE_ERRORS[res.status] || "Claude'i vastust ei saadud kätte. Proovi uuesti.");
  }
  return data.result;
}

export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
