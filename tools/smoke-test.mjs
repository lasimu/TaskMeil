// Headless smoke test: runs the browser code in jsdom against a fake
// Microsoft Graph and a fake /api/claude, and checks the main flows.
// Run with: npm test
// It does not prove the real sign-in or the real Graph calls work.

import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const dom = new JSDOM(readFileSync(path.join(root, "index.html"), "utf8"), {
  url: "https://taskmeil.example/",
  pretendToBeVisual: true,
});
const { window } = dom;

for (const key of ["document", "DOMParser", "Node", "location", "HTMLElement"]) {
  globalThis[key] = window[key];
}
globalThis.window = window;
globalThis.localStorage = window.localStorage;
globalThis.confirm = window.confirm = () => true;
const proto = window.HTMLDialogElement.prototype;
if (!proto.showModal) {
  proto.showModal = function () { this.setAttribute("open", ""); };
  proto.close = function () { this.removeAttribute("open"); };
}

class InteractionRequiredAuthError extends Error {}
const account = { username: "mina@uusmaa.ee", name: "Mina Ise" };
window.TASKMEIL_CONFIG = {
  clientId: "11111111-1111-1111-1111-111111111111",
  tenantId: "22222222-2222-2222-2222-222222222222",
};
window.msal = {
  InteractionRequiredAuthError,
  PublicClientApplication: class {
    async initialize() {}
    async handleRedirectPromise() { return null; }
    getActiveAccount() { return account; }
    getAllAccounts() { return [account]; }
    setActiveAccount() {}
    async acquireTokenSilent() {
      return { accessToken: "graph-token", idToken: "id-token", idTokenClaims: { exp: Date.now() / 1000 + 3600 } };
    }
  },
};

const today = new Date();
const at = (h, m = 0) => new Date(today.getFullYear(), today.getMonth(), today.getDate(), h, m);
const utc = (d) => ({ dateTime: d.toISOString().replace("Z", "0000"), timeZone: "UTC" });
const person = (name, address) => ({ emailAddress: { name, address } });

const mails = [
  {
    id: "m1", subject: "Pakkumine Tamme 5 korterile", isRead: false, hasAttachments: true,
    from: person("Mari Maasikas", "mari@klient.ee"),
    toRecipients: [person("Mina Ise", "mina@uusmaa.ee"), person("Kolleeg", "kolleeg@uusmaa.ee")],
    ccRecipients: [], receivedDateTime: at(9).toISOString(), bodyPreview: "Tere, palun saatke...",
    webLink: "https://outlook.office.com/mail/m1",
    body: {
      contentType: "html",
      content: `<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><style>p{color:red}</style></head>
        <body onload="alert(1)"><p>Tere,</p><p>palun saatke pakkumine <b>reedeks</b>.</p>
        <script>alert(2)</script><img src="https://tracker.example/p.gif"><img src="cid:logo.png@01DB"><a href="javascript:alert(3)">x</a></body></html>`,
    },
  },
  {
    id: "m2", subject: "Uudiskiri", isRead: true, hasAttachments: false,
    from: person("Uudised", "news@example.com"), toRecipients: [], ccRecipients: [],
    receivedDateTime: at(7).toISOString(), bodyPreview: "Selle nädala uudised",
    webLink: "https://outlook.office.com/mail/m2", body: { contentType: "text", content: "Lihttekst <b>" },
  },
];

const calls = [];
const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "Content-Type": "application/json" },
});

globalThis.fetch = window.fetch = async (url, options = {}) => {
  const method = options.method || "GET";
  const u = new URL(url, "https://taskmeil.example");
  const body = options.body ? JSON.parse(options.body) : undefined;
  calls.push({ method, path: u.pathname, body, headers: options.headers || {} });
  const p = u.pathname.replace("/v1.0", "");

  if (u.pathname === "/api/claude") {
    assert.equal(options.headers["X-Taskmeil-Token"], "id-token");
    if (body.action === "triage") {
      assert.deepEqual(body.emails.map((e) => e.id), ["m1", "m2"]);
      assert.match(body.emails[0].from, /Mari Maasikas <mari@klient.ee>/);
      return json({
        result: { tasks: [{ id: "m1", title: "Saada Marile pakkumine", due_date: "2026-11-20", importance: "high" }] },
        usage: { model: "eu.anthropic.claude-opus-4-6-v1", input_tokens: 1200, output_tokens: 300, cost_usd: 0.0149 },
      });
    }
    assert.match(body.email.body, /palun saatke pakkumine reedeks/);
    assert.doesNotMatch(body.email.body, /alert|color:red/);
    return body.action === "task"
      ? json({ result: { title: "Saada Marile pakkumine Tamme 5 kohta", notes: "Mari Maasikas soovib pakkumist.", due_date: "2026-11-20", importance: "high" } })
      : json({ result: { body: "Tere, Mari!\n\nSaadan pakkumise reedeks.\n\nMina Ise" } });
  }
  assert.equal(options.headers.Authorization, "Bearer graph-token");

  if (p === "/me/mailFolders/inbox/messages") return json({ value: mails });
  if (p === "/me/messages/m1" && method === "GET") return json(mails[0]);
  if (p === "/me/messages/m1" && method === "PATCH") return json({});
  if (p === "/me/messages/m1/attachments") {
    return json({ value: [
      { id: "a1", name: "logo.png", contentType: "image/png", size: 120, isInline: true },
      { id: "a2", name: "leping.pdf", contentType: "application/pdf", size: 5000, isInline: false },
    ] });
  }
  if (p === "/me/messages/m1/attachments/a1") {
    return json({ id: "a1", name: "logo.png", contentType: "image/png", contentId: "<logo.png@01DB>", contentBytes: "iVBORw0KGgo=" });
  }
  if (p === "/me/messages/m1/createReply") {
    return json({ id: "d1", body: { contentType: "html", content: "<html><body><div>QUOTED</div></body></html>" } }, 201);
  }
  if (p === "/me/messages/d1" && method === "PATCH") return json({});
  if (p === "/me/messages/d1/send") return new Response(null, { status: 202 });
  if (p === "/me/messages/m2/move") return json({ id: "m2-deleted" }, 201);
  if (p === "/me/messages/m2-deleted/move") return json({ id: "m2-back" }, 201);
  if (p === "/me/todo/lists") return json({ value: [{ id: "L1", displayName: "Ülesanded", wellknownListName: "defaultList" }] });
  if (p === "/me/todo/lists/L1/tasks" && method === "GET") {
    return json({ value: [
      { id: "t1", title: "Helista notarile", importance: "normal", createdDateTime: at(8).toISOString(), dueDateTime: utc(at(0)) },
      { id: "t2", title: "Vana ülesanne", importance: "high", createdDateTime: at(6).toISOString() },
    ] });
  }
  if (p === "/me/todo/lists/L1/tasks" && method === "POST") return json({ id: "t3", ...body, createdDateTime: new Date().toISOString() }, 201);
  if (p === "/me/todo/lists/L1/tasks/t1" && method === "PATCH") return json({});
  if (p === "/me/calendarView") {
    return json({ value: [
      { id: "e1", subject: "Koosolek", start: utc(at(10)), end: utc(at(11)), isAllDay: false, location: { displayName: "Kontor" } },
      { id: "e2", subject: "Kattuv", start: utc(at(10, 30)), end: utc(at(11, 30)), isAllDay: false },
      { id: "e3", subject: "Sünnipäev", start: utc(at(0)), end: utc(at(24)), isAllDay: true, webLink: "https://outlook.office.com/e3" },
    ] });
  }
  if (p === "/me/events" && method === "POST") return json({ id: "e4" }, 201);
  throw new Error(`Unexpected request: ${method} ${u.pathname}`);
};

const $ = (id) => document.getElementById(id);
const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const click = (el) => el.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
const submit = (el) => el.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
const sent = (method, suffix) => calls.filter((c) => c.method === method && c.path.endsWith(suffix));

await import(pathToFileURL(path.join(root, "js", "app.js")).href);
await tick(100);

// Start-up
assert.equal($("app").hidden, false, "app is shown after sign-in");
assert.equal($("user-name").textContent, "Mina Ise");
assert.equal(document.querySelectorAll(".mail-item").length, 2);
assert.equal(document.querySelectorAll(".mail-item.unread").length, 1);
assert.equal(document.querySelectorAll("#task-list .task").length, 2);
assert.equal(document.querySelector("#task-list .task-title").textContent, "Helista notarile", "task with a due date comes first");
{
  const tags = [...document.querySelectorAll("#task-list .task")].map((t) => t.querySelector(".tag").textContent);
  assert.match(tags[0], /^Tähtaeg /, "a task with a due date shows it");
  assert.match(tags[1], /^Lisatud /, "a task without a due date shows when it was added");
}
assert.equal(document.querySelectorAll("#cal-grid .event").length, 2);
assert.equal(document.querySelectorAll("#cal-allday .allday").length, 1);
assert.match(document.querySelectorAll("#cal-grid .event")[1].getAttribute("style"), /width: calc\(50% - 31px\)/, "overlapping events share the width");

// Claude marks inbox mail worth a task; nothing is added until the user confirms
assert.equal(calls.filter((c) => c.path === "/api/claude").length, 1, "one triage call for the new mail");
assert.equal(document.querySelectorAll(".mail-suggest").length, 1);
assert.match(document.querySelector(".mail-item .mail-suggest-title").textContent, /Saada Marile pakkumine/);
assert.equal(sent("POST", "/tasks").length, 0, "marking a mail adds no task");
click(document.querySelector(".mail-suggest .btn"));
assert.equal($("task-dialog").hasAttribute("open"), true);
assert.equal($("task-title").value, "Saada Marile pakkumine");
assert.equal($("read-view").hidden, true, "the suggestion button does not open the mail");
submit($("task-form"));
await tick();
{
  const added = sent("POST", "/tasks");
  assert.equal(added.length, 1);
  assert.equal(added[0].body.linkedResources[0].webUrl, "https://outlook.office.com/mail/m1");
  assert.equal(document.querySelectorAll(".mail-suggest").length, 0, "the mark goes away once the task is added");
  assert.match($("claude-usage").textContent, /1 päringut · 1[\s\u00a0]?500 tokenit · hinnanguliselt \$0\.015/);
  calls.splice(calls.indexOf(added[0]), 1); // keep the later checks counting from zero
}
assert.equal(document.querySelectorAll("#task-list .task").length, 3);

// Reading a message
click(document.querySelector(".mail-item"));
await tick();
assert.equal($("read-view").hidden, false);
assert.equal(document.body.dataset.tab, "read");
const srcdoc = $("read-body").srcdoc;
assert.doesNotMatch(srcdoc, /<script|onload|javascript:|http-equiv="refresh"/i, "active content is removed");
assert.match(srcdoc, /img-src data: https:"/, "images are shown");
assert.match(srcdoc, /palun saatke pakkumine/);
assert.match($("read-body").srcdoc, /src="data:image\/png;base64,iVBORw0KGgo="/, "pictures inside the email are shown");
assert.doesNotMatch($("read-body").srcdoc, /cid:/);
assert.equal(sent("PATCH", "/me/messages/m1")[0].body.isRead, true);
assert.equal(document.querySelectorAll(".mail-item.unread").length, 0);

// Claude: email -> task suggestion -> saved only after the user confirms
click($("act-task"));
await tick();
assert.equal($("task-dialog").hasAttribute("open"), true);
assert.equal($("task-title").value, "Saada Marile pakkumine Tamme 5 kohta");
assert.equal($("task-due").value, "2026-11-20");
assert.equal(sent("POST", "/tasks").length, 0, "nothing is saved before the user confirms");
submit($("task-form"));
await tick();
const newTask = sent("POST", "/tasks")[0].body;
assert.equal(newTask.importance, "high");
assert.equal(newTask.linkedResources[0].webUrl, "https://outlook.office.com/mail/m1");
assert.equal(new Date(newTask.dueDateTime.dateTime + "Z").getTime(), new Date(2026, 10, 20).getTime());
assert.equal(document.querySelectorAll("#task-list .task").length, 4);

// Claude: reply draft -> nothing is sent until "Saada"
click($("act-draft"));
await tick();
assert.equal($("compose-to").value, "mari@klient.ee");
assert.equal($("compose-subject").value, "RE: Pakkumine Tamme 5 korterile");
assert.match($("compose-body").value, /Saadan pakkumise reedeks/);
assert.equal(sent("POST", "/createReply").length + sent("POST", "/send").length, 0, "Claude's draft sends nothing");
click($("compose-send"));
await tick();
assert.equal(sent("POST", "/createReply").length, 1);
const patched = sent("PATCH", "/me/messages/d1")[0].body.body.content;
assert.match(patched, /<body><div[^>]*>Tere, Mari!<br><br>Saadan pakkumise reedeks\.<br><br>Mina Ise<\/div><br><div>QUOTED/);
assert.equal(sent("POST", "/me/messages/d1/send").length, 1);
assert.equal($("compose").hasAttribute("open"), false);

// Reply all leaves the user's own address out
click($("act-reply-all"));
assert.equal($("compose-to").value, "mari@klient.ee, kolleeg@uusmaa.ee");
click($("compose-cancel"));

// Completing a task
const box = document.querySelector("#task-list input[type=checkbox]");
box.checked = true;
box.dispatchEvent(new window.Event("change", { bubbles: true }));
await tick();
assert.equal(sent("PATCH", "/tasks/t1")[0].body.status, "completed");
assert.equal(document.querySelectorAll("#task-list .task").length, 3);

// Calendar: click an empty time -> dialog -> save
$("cal-grid").dispatchEvent(new window.MouseEvent("click", { bubbles: true, clientY: 14 * 48 + 5 }));
assert.equal($("event-dialog").hasAttribute("open"), true);
assert.equal($("event-start").value, "14:00");
assert.equal($("event-end").value, "14:30");
$("event-title").value = "Objekti näitamine";
submit($("event-form"));
await tick();
const ev = sent("POST", "/me/events")[0].body;
assert.equal(ev.subject, "Objekti näitamine");
assert.equal(new Date(ev.start.dateTime + "Z").getTime(), at(14).getTime());
assert.equal(ev.start.timeZone, "UTC");

// Clicking an existing event opens it for editing
click(document.querySelector("#cal-grid .event"));
assert.equal($("event-title").value, "Koosolek");
assert.equal($("event-delete").hidden, false);

// Usage dialog: the monthly limit for automatic marking can be changed
click($("claude-usage"));
assert.equal($("usage-dialog").hasAttribute("open"), true);
assert.equal($("usage-limit").value, "0.5", "the limit starts at 50 cents");
assert.match($("usage-mark").textContent, /1 päringut, hinnanguliselt \$0\.015 \(limiit \$0\.50\)/);
$("usage-limit").value = "0.01";
submit($("usage-form"));
assert.equal($("usage-dialog").hasAttribute("open"), false);
assert.match($("claude-usage").textContent, /märgistamise limiit on täis/);
assert.equal(localStorage.getItem("taskmeil.markLimit"), "0.01");

// Sliding a mail left on a touchscreen deletes it, with undo; the mouse does not
{
  const pointer = (el, type, x, pointerType) => {
    const e = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 });
    Object.defineProperty(e, "pointerType", { value: pointerType });
    Object.defineProperty(e, "pointerId", { value: 1 });
    el.dispatchEvent(e);
  };
  const slide = (pointerType) => {
    const item = document.querySelectorAll(".mail-item")[1];
    pointer(item, "pointerdown", 300, pointerType);
    pointer(item, "pointermove", 260, pointerType);
    pointer(item, "pointermove", 150, pointerType);
    pointer(item, "pointerup", 150, pointerType);
  };
  slide("mouse");
  await tick();
  assert.equal(sent("POST", "/move").length, 0, "dragging with the mouse deletes nothing");
  slide("touch");
  await tick();
  assert.equal(sent("POST", "/me/messages/m2/move")[0].body.destinationId, "deleteditems");
  assert.equal(document.querySelectorAll(".mail-item").length, 1);
  click(document.querySelector("#toast .toast-action"));
  await tick();
  assert.equal(sent("POST", "/me/messages/m2-deleted/move")[0].body.destinationId, "inbox");
  assert.equal(document.querySelectorAll(".mail-item").length, 2, "undo puts the mail back");
}

console.log(`Smoke test passed (${calls.length} requests checked).`);
process.exit(0);
