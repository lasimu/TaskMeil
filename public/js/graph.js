// Thin wrapper around Microsoft Graph. All mail, calendar and task data
// goes directly between the browser and Microsoft.

import { getGraphToken } from "./auth.js";

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

export function localDate(d) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
