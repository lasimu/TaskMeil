// Claude usage counter: tokens and estimated cost of the calls made from this
// browser, and the monthly limit for automatic task marking. The cost is an
// estimate for orientation; the real bill is in the Anthropic console.

import { $ } from "./util.js";
import { localDate } from "./graph.js";
import { claudeKey, setClaudeKey } from "./claude.js";

const KEY = "taskmeil.usage";
const LIMIT_KEY = "taskmeil.markLimit";
const DEFAULT_LIMIT = 0.5; // euros per month for automatic marking
// Claude is priced in dollars; the app shows euros at this fixed rate
// (ECB reference rate of 13 Nov 2026). Update it if the rate moves a lot.
const EUR_PER_USD = 0.905;
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

// Monthly limit in euros for automatic marking; 0 switches marking off.
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
  return thisMonth().markCost * EUR_PER_USD < markLimit();
}

// usage: { model, input_tokens, output_tokens, cost_usd } from claude.js;
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
// Euro amount as written in Estonia: 0,07 €. Takes euros.
const eur = (n) => `${n.toFixed(2).replace(".", ",")} €`;
// Takes a cost in dollars, as counted.
const cost = (dollars) => eur(dollars * EUR_PER_USD);
const line = (row) =>
  `${num(row.calls)} päringut, ${num(row.input)} sisend- ja ${num(row.output)} väljundtokenit, hinnanguliselt ${cost(row.cost)}`;

export function renderUsage() {
  const el = $("claude-usage");
  if (!el) return;
  const month = thisMonth();
  const limit = markLimit();
  const stopped = month.markCost * EUR_PER_USD >= limit;
  if (!claudeKey()) {
    el.textContent = "Claude on välja lülitatud: lisa API võti nupu „Kulu ja limiit“ alt.";
    el.classList.remove("over");
    return;
  }
  el.textContent =
    `Claude sel kuul: ${num(month.calls)} päringut · ${num(month.input + month.output)} tokenit · kokku hinnanguliselt ${cost(month.cost)}` +
    (!limit
      ? " · märgistamine on välja lülitatud"
      : ` · märgistamine ${cost(month.markCost)} / ${eur(limit)} kuus${stopped ? " (limiit täis)" : ""}`);
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
      `${num(month.markCalls)} päringut, hinnanguliselt ${cost(month.markCost)} / ${eur(markLimit())} kuus`;
    $("usage-model").textContent = month.model || "veel kasutamata";
    $("usage-limit").value = markLimit();
    $("claude-key").value = claudeKey();
    dialog.showModal();
  };
  $("usage-open").addEventListener("click", open);
  $("usage-edit").addEventListener("click", open);
  $("usage-cancel").addEventListener("click", () => dialog.close());
  $("usage-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const value = Number(String($("usage-limit").value).replace(",", "."));
    if (!Number.isFinite(value) || value < 0) return;
    setClaudeKey($("claude-key").value);
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
