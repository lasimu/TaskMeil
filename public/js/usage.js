// Claude usage counter: tokens and estimated cost of the calls made from this
// browser, and the monthly limit for automatic task marking. The cost is an
// estimate for orientation; the real bill is in AWS.

import { $ } from "./util.js";
import { localDate } from "./graph.js";

const KEY = "taskmeil.usage";
const LIMIT_KEY = "taskmeil.markLimit";
const DEFAULT_LIMIT = 0.5; // USD per month for automatic marking
const EMPTY = () => ({ calls: 0, input: 0, output: 0, cost: 0, markCalls: 0, markCost: 0 });

function load() {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || "{}");
    return { days: data.days || {}, months: data.months || {} };
  } catch {
    return { days: {}, months: {} };
  }
}

const thisMonth = () => ({ ...EMPTY(), ...load().months[localDate(new Date()).slice(0, 7)] });

// Monthly limit in USD for automatic marking; 0 switches marking off.
export function markLimit() {
  try {
    const saved = localStorage.getItem(LIMIT_KEY);
    const value = saved === null ? NaN : Number(saved);
    return Number.isFinite(value) && value >= 0 ? value : DEFAULT_LIMIT;
  } catch {
    return DEFAULT_LIMIT;
  }
}

// True while this month's automatic marking is still under its limit.
export function markingAllowed() {
  return thisMonth().markCost < markLimit();
}

// usage: { model, input_tokens, output_tokens, cost_usd } from /api/claude;
// action: "triage" is the automatic marking, the others are the user's clicks.
export function recordUsage(usage, action) {
  if (!usage) return;
  const data = load();
  const today = localDate(new Date());
  const month = today.slice(0, 7);
  for (const [group, key] of [[data.days, today], [data.months, month]]) {
    const row = (group[key] = { ...EMPTY(), ...group[key] });
    row.calls += 1;
    row.input += usage.input_tokens || 0;
    row.output += usage.output_tokens || 0;
    row.cost += usage.cost_usd || 0;
    if (action === "triage") {
      row.markCalls += 1;
      row.markCost += usage.cost_usd || 0;
    }
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
const usd = (n) => `$${n > 0 && n < 0.1 ? n.toFixed(3) : n.toFixed(2)}`;
const line = (row) =>
  `${num(row.calls)} päringut, ${num(row.input)} sisend- ja ${num(row.output)} väljundtokenit, hinnanguliselt ${usd(row.cost)}`;

export function renderUsage() {
  const el = $("claude-usage");
  if (!el) return;
  const month = thisMonth();
  const limit = markLimit();
  const stopped = month.markCost >= limit;
  el.textContent =
    `Claude sel kuul: ${num(month.calls)} päringut · ${num(month.input + month.output)} tokenit · hinnanguliselt ${usd(month.cost)}` +
    (!limit
      ? " · märgistamine on välja lülitatud"
      : ` · märgistamise limiit ${usd(limit)} kuus${stopped ? " on täis" : `, kulunud ${usd(month.markCost)}`}`);
  el.classList.toggle("over", stopped);
}

export function initUsage({ onLimitChange }) {
  const dialog = $("usage-dialog");
  const open = () => {
    const data = load();
    const today = localDate(new Date());
    const month = thisMonth();
    $("usage-today").textContent = line({ ...EMPTY(), ...data.days[today] });
    $("usage-month").textContent = line(month);
    $("usage-mark").textContent =
      `${num(month.markCalls)} päringut, hinnanguliselt ${usd(month.markCost)} (limiit ${usd(markLimit())})`;
    $("usage-model").textContent = month.model || "veel kasutamata";
    $("usage-limit").value = markLimit();
    dialog.showModal();
  };
  $("usage-open").addEventListener("click", open);
  $("usage-edit").addEventListener("click", open);
  $("usage-cancel").addEventListener("click", () => dialog.close());
  $("usage-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = Number(String($("usage-limit").value).replace(",", "."));
    if (!Number.isFinite(value) || value < 0) return;
    try {
      localStorage.setItem(LIMIT_KEY, String(value));
    } catch {
      /* storage unavailable: the default limit stays */
    }
    dialog.close();
    renderUsage();
    onLimitChange?.();
  });
  renderUsage();
}
