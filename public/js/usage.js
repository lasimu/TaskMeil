// Claude usage counter: tokens and estimated cost of the calls made from this
// browser. It is an estimate for orientation; the real bill is in AWS.

import { $ } from "./util.js";
import { localDate } from "./graph.js";

const KEY = "taskmeil.usage";
const EMPTY = () => ({ calls: 0, input: 0, output: 0, cost: 0 });

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { days: data.days || {}, months: data.months || {} };
  } catch {
    return { days: {}, months: {} };
  }
}

// usage: { model, input_tokens, output_tokens, cost_usd } from /api/claude
export function recordUsage(usage) {
  if (!usage) return;
  const data = load();
  const today = localDate(new Date());
  const month = today.slice(0, 7);
  for (const [group, key] of [[data.days, today], [data.months, month]]) {
    const row = (group[key] ||= EMPTY());
    row.calls += 1;
    row.input += usage.input_tokens || 0;
    row.output += usage.output_tokens || 0;
    row.cost += usage.cost_usd || 0;
    row.model = usage.model;
  }
  // Keep the last 60 days and 24 months.
  for (const [group, keep] of [[data.days, 60], [data.months, 24]]) {
    for (const key of Object.keys(group).sort().slice(0, -keep)) delete group[key];
  }
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable: nothing is counted */
  }
  renderUsage();
}

const num = (n) => new Intl.NumberFormat("et-EE").format(n);
const usd = (n) => `$${n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const line = (label, row) =>
  `${label}: ${num(row.calls)} päringut, ${num(row.input)} sisend- ja ${num(row.output)} väljundtokenit, hinnanguliselt ${usd(row.cost)}`;

export function renderUsage() {
  const el = $("claude-usage");
  if (!el) return;
  const data = load();
  const today = localDate(new Date());
  const month = data.months[today.slice(0, 7)] || EMPTY();
  const day = data.days[today] || EMPTY();
  el.textContent = `Claude sel kuul: ${num(month.calls)} päringut · ${num(month.input + month.output)} tokenit · hinnanguliselt ${usd(month.cost)}`;
  el.title = [
    line("Täna", day),
    line("Sel kuul", month),
    month.model ? `Mudel: ${month.model}` : "",
    "Hinnang selles brauseris tehtud päringute põhjal; täpne arve on AWS-is.",
  ].filter(Boolean).join("\n");
}
