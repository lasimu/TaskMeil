// Start-up: sign in, then load the three panes and keep them fresh.

import { initAuth, isConfigured, login, logout } from "./auth.js";
import { $, attempt, busy } from "./util.js";
import { initMail, loadInbox, markInbox } from "./mail.js";
import { initTasks, loadTaskLists, loadTasks } from "./tasks.js";
import { initCalendar, loadCalendar } from "./calendar.js";
import { recordUsage, initUsage } from "./usage.js";

// On a phone one pane is visible at a time; the bottom tabs switch between them.
function showTab(name) {
  document.body.dataset.tab = name;
  for (const button of document.querySelectorAll(".tabs button")) {
    button.classList.toggle("active", button.dataset.tab === name);
  }
}

// On a wide screen the main view shows everything; the other views show one
// thing alone. The choice is remembered in this browser.
const VIEWS = ["all", "mail", "tasks", "cal"];
const VIEW_KEY = "taskmeil.view";

function showView(name) {
  if (!VIEWS.includes(name)) name = "all";
  document.body.dataset.view = name;
  for (const button of document.querySelectorAll(".views button")) {
    const on = button.dataset.view === name;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
  try {
    localStorage.setItem(VIEW_KEY, name);
  } catch {
    /* not remembered */
  }
}

function savedView() {
  try {
    return localStorage.getItem(VIEW_KEY);
  } catch {
    return null;
  }
}

function refreshAll() {
  return Promise.all([
    attempt("Kirjade laadimine", () => loadInbox()),
    attempt("Ülesannete laadimine", loadTaskLists),
    attempt("Kalendri laadimine", loadCalendar),
  ]);
}

function showLogin(message = "") {
  $("login").hidden = false;
  $("app").hidden = true;
  $("login-error").textContent = message;
}

async function start() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch((err) => console.error("Service worker", err));
  }

  $("login-btn").addEventListener("click", () => attempt("Sisselogimine", login));
  if (!isConfigured()) {
    $("login-btn").disabled = true;
    return showLogin("Rakendus on seadistamata: lisa faili config.js Entra clientId ja tenantId.");
  }

  let account;
  try {
    account = await initAuth();
  } catch (err) {
    console.error("Sign-in failed", err);
    return showLogin(`Sisselogimine ebaõnnestus: ${err.message || err}`);
  }
  if (!account) return showLogin();

  $("login").hidden = true;
  $("app").hidden = false;
  $("user-name").textContent = account.name || account.username;
  showTab("inbox");
  showView(savedView());
  for (const button of document.querySelectorAll(".views button")) {
    button.addEventListener("click", () => showView(button.dataset.view));
  }

  for (const button of document.querySelectorAll(".tabs button")) {
    button.addEventListener("click", () => showTab(button.dataset.tab));
  }
  $("logout").addEventListener("click", () => attempt("Väljalogimine", logout));
  $("refresh").addEventListener("click", (e) => busy(e.currentTarget, "Värskendan…", refreshAll));

  window.addEventListener("taskmeil:usage", (e) => recordUsage(e.detail.usage, e.detail.action));
  initUsage({ onLimitChange: markInbox });
  initMail({ showTab });
  initTasks();
  initCalendar();
  await refreshAll();

  // Quiet background refresh while the app is in view.
  setInterval(() => {
    if (document.visibilityState !== "visible") return;
    loadInbox({ quiet: true }).catch(console.error);
    loadCalendar().catch(console.error);
  }, 2 * 60 * 1000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    loadInbox({ quiet: true }).catch(console.error);
    loadTasks().catch(console.error);
    loadCalendar().catch(console.error);
  });
}

start();
