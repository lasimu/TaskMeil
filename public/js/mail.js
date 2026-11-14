// Inbox list, reading pane and the compose/reply dialog.

import { graph, askClaude, askClaudeTriage } from "./graph.js";
import { getAccount } from "./auth.js";
import { $, h, toast, attempt, busy, escapeHtml, fmtShort, fmtFull, addr, who, htmlToText } from "./util.js";
import { proposeTask } from "./tasks.js";

const LIST_FIELDS = "id,subject,from,receivedDateTime,isRead,bodyPreview,hasAttachments,webLink";
const READ_FIELDS = "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,hasAttachments,webLink,isRead";

const state = {
  messages: [],
  nextLink: null,
  current: null, // the message open in the reading pane
  showImages: false,
  compose: null, // { mode: "new" | "reply" | "replyAll", source }
};

let showTab = () => {};
export function initMail(options) {
  showTab = options.showTab;

  $("mail-more").addEventListener("click", () => attempt("Kirjade laadimine", loadMore));
  let searchTimer;
  $("mail-search").addEventListener("input", () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => attempt("Otsing", () => loadInbox()), 400);
  });

  $("act-reply").addEventListener("click", () => openCompose("reply"));
  $("act-reply-all").addEventListener("click", () => openCompose("replyAll"));
  $("act-draft").addEventListener("click", () => {
    openCompose("reply");
    generateDraft();
  });
  $("act-task").addEventListener("click", (e) =>
    busy(e.currentTarget, "Claude mõtleb…", () =>
      attempt("Ülesande koostamine", async () => {
        const mail = state.current;
        const suggestion = await askClaude("task", mailForClaude(mail));
        proposeTask(suggestion, mail);
      })
    )
  );
  $("act-unread").addEventListener("click", () => attempt("Märkimine", markUnread));
  $("act-delete").addEventListener("click", () => attempt("Kustutamine", deleteCurrent));

  $("new-mail").addEventListener("click", () => openCompose("new"));
  $("compose-cancel").addEventListener("click", () => $("compose").close());
  $("compose-generate").addEventListener("click", generateDraft);
  $("compose-send").addEventListener("click", (e) =>
    busy(e.currentTarget, "Saadan…", () => attempt("Saatmine", () => deliver(true)))
  );
  $("compose-save").addEventListener("click", (e) =>
    busy(e.currentTarget, "Salvestan…", () => attempt("Salvestamine", () => deliver(false)))
  );
  $("compose-to").addEventListener("input", suggestPeople);
}

// ---------- inbox ----------

// quiet = background refresh: skipped while the user is searching or has
// loaded older pages, so the list does not jump under them.
export async function loadInbox({ quiet = false } = {}) {
  const query = $("mail-search").value.trim();
  if (quiet && (query || state.messages.length > 30)) return;
  const path = query
    ? `/me/messages?$search=${encodeURIComponent(`"${query.replace(/"/g, "")}"`)}&$top=30&$select=${LIST_FIELDS}`
    : `/me/mailFolders/inbox/messages?$top=30&$select=${LIST_FIELDS}&$orderby=receivedDateTime desc`;
  const data = await graph(path);
  state.messages = data.value;
  state.nextLink = data["@odata.nextLink"] || null;
  renderList();
  if (!query) triage();
}

async function loadMore() {
  if (!state.nextLink) return;
  const data = await graph(state.nextLink);
  state.messages.push(...data.value);
  state.nextLink = data["@odata.nextLink"] || null;
  renderList();
  if (!$("mail-search").value.trim()) triage();
}

// ---------- Claude's task suggestions ----------
// Claude looks at the sender, subject and first lines of inbox mail it has not
// seen yet and marks the ones worth a to-do item. Each verdict is remembered in
// this browser, so a message is sent to Claude once. Marking adds nothing by
// itself: the user confirms each task in the task dialog.

const TRIAGE_BATCH = 30;
const TRIAGE_KEEP = 500;
const triageKey = () => `taskmeil.triage.${getAccount()?.username || ""}`;
let verdicts = null; // message id -> { title, due_date, importance } | 0 (no task, added or dismissed)
let triageBusy = false;
let triagePausedUntil = 0;

function loadVerdicts() {
  if (verdicts) return verdicts;
  verdicts = new Map();
  try {
    for (const [id, v] of JSON.parse(localStorage.getItem(triageKey()) || "[]")) verdicts.set(id, v);
  } catch {
    /* no storage, or nothing saved yet */
  }
  return verdicts;
}

function saveVerdicts() {
  try {
    localStorage.setItem(triageKey(), JSON.stringify([...verdicts].slice(-TRIAGE_KEEP)));
  } catch {
    /* storage unavailable: verdicts last until the page is closed */
  }
}

function setVerdict(id, value) {
  loadVerdicts().delete(id); // re-insert so the newest stay when old ones are trimmed
  verdicts.set(id, value);
  saveVerdicts();
}

async function triage() {
  if (triageBusy || Date.now() < triagePausedUntil) return;
  const known = loadVerdicts();
  const fresh = state.messages.filter((m) => !known.has(m.id)).slice(0, TRIAGE_BATCH);
  if (!fresh.length) return;
  triageBusy = true;
  try {
    const picks = await askClaudeTriage(
      fresh.map((m) => ({
        id: m.id,
        from: `${who(m.from)} <${addr(m.from)}>`,
        subject: m.subject || "",
        received: m.receivedDateTime,
        preview: m.bodyPreview || "",
      }))
    );
    for (const m of fresh) known.set(m.id, 0);
    for (const p of picks) known.set(p.id, { title: p.title, due_date: p.due_date, importance: p.importance });
    saveVerdicts();
    renderList();
  } catch (err) {
    // Suggestions are an extra: stay quiet and try again later.
    console.warn("Claude task suggestions unavailable:", err.message);
    triagePausedUntil = Date.now() + 10 * 60 * 1000;
  } finally {
    triageBusy = false;
  }
  if (state.messages.some((m) => !known.has(m.id)) && Date.now() >= triagePausedUntil) triage();
}

function suggestionRow(m) {
  const pick = loadVerdicts().get(m.id);
  if (!pick) return null;
  const stop = (fn) => (e) => {
    e.stopPropagation();
    fn();
  };
  return h("div", { class: "mail-suggest", onclick: (e) => e.stopPropagation() },
    h("span", { class: "mail-suggest-title", title: "Claude'i soovitus" }, `✓ ${pick.title}`),
    h("button", {
      class: "btn small",
      type: "button",
      onclick: stop(() =>
        proposeTask(
          { ...pick, notes: `Kiri: ${who(m.from)} – ${m.subject || "(teemata)"}` },
          m,
          () => {
            setVerdict(m.id, 0);
            renderList();
          }
        )
      ),
    }, "Lisa ülesanne"),
    h("button", {
      class: "btn small ghost",
      type: "button",
      "aria-label": "Ei ole ülesanne",
      title: "Ei ole ülesanne",
      onclick: stop(() => {
        setVerdict(m.id, 0);
        renderList();
      }),
    }, "✕")
  );
}

function renderList() {
  const list = $("mail-list");
  list.replaceChildren(
    ...state.messages.map((m) =>
      h("li", {
        class: `mail-item${m.isRead ? "" : " unread"}${state.current?.id === m.id ? " selected" : ""}`,
        tabIndex: 0,
        onclick: () => attempt("Kirja avamine", () => openMessage(m.id)),
        onkeydown: (e) => {
          if (e.key === "Enter") attempt("Kirja avamine", () => openMessage(m.id));
        },
      },
        h("div", { class: "mail-top" },
          h("span", { class: "mail-from" }, who(m.from)),
          h("time", {}, fmtShort(new Date(m.receivedDateTime)))
        ),
        h("div", { class: "mail-subject" }, (m.hasAttachments ? "📎 " : "") + (m.subject || "(teemata)")),
        h("div", { class: "mail-preview" }, m.bodyPreview || ""),
        suggestionRow(m)
      )
    )
  );
  if (!state.messages.length) list.append(h("li", { class: "empty" }, "Kirju ei ole."));
  $("mail-more").hidden = !state.nextLink;
}

// ---------- reading pane ----------

async function openMessage(id) {
  const mail = await graph(`/me/messages/${id}?$select=${READ_FIELDS}`);
  state.current = mail;
  state.showImages = false;
  renderMessage();
  showTab("read");

  if (!mail.isRead) {
    mail.isRead = true;
    const inList = state.messages.find((m) => m.id === id);
    if (inList) inList.isRead = true;
    graph(`/me/messages/${id}`, { method: "PATCH", body: { isRead: true } }).catch(console.error);
  }
  renderList();
}

function renderMessage() {
  const mail = state.current;
  $("read-empty").hidden = !!mail;
  $("read-view").hidden = !mail;
  if (!mail) return;

  $("read-subject").textContent = mail.subject || "(teemata)";
  const to = (mail.toRecipients || []).map(who).join(", ");
  const cc = (mail.ccRecipients || []).map(who).join(", ");
  $("read-meta").textContent =
    `${who(mail.from)} <${addr(mail.from)}> · ${fmtFull(new Date(mail.receivedDateTime))}` +
    (to ? ` · Kellele: ${to}` : "") + (cc ? ` · Koopia: ${cc}` : "");
  $("act-outlook").href = mail.webLink || "#";

  const { html, hasRemoteImages } = sanitize(mail.body);
  const notice = $("read-notice");
  const notes = [];
  if (mail.hasAttachments) notes.push("Kirjal on manuseid. Nende avamiseks vali „Ava Outlookis“.");
  notice.replaceChildren(...notes.map((n) => h("span", {}, n + " ")));
  if (hasRemoteImages && !state.showImages) {
    notice.append(
      h("span", {}, "Pildid on privaatsuse kaitseks peidetud. "),
      h("button", {
        class: "link",
        onclick: () => {
          state.showImages = true;
          renderMessage();
        },
      }, "Näita pilte")
    );
  }
  notice.hidden = !notice.childNodes.length;

  // The email is shown in a sandboxed frame: no scripts, and remote content
  // only when the user asks for images.
  const csp = `default-src 'none'; style-src 'unsafe-inline'; font-src data:; img-src data:${state.showImages ? " https:" : ""}`;
  $("read-body").srcdoc =
    `<!doctype html><html><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${csp}">` +
    `<base target="_blank">` +
    `<style>body{font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:16px;color:#1c1c1c;background:#fff;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap;font:inherit}</style>` +
    `</head><body>${html}</body></html>`;
}

// Removes the parts of an HTML email that could run code or navigate the frame.
function sanitize(body) {
  if (!body?.content) return { html: "", hasRemoteImages: false };
  if (body.contentType !== "html") {
    return { html: `<pre>${escapeHtml(body.content)}</pre>`, hasRemoteImages: false };
  }
  const doc = new DOMParser().parseFromString(body.content, "text/html");
  doc.querySelectorAll("script,meta,link,base,iframe,frame,object,embed,form,noscript").forEach((n) => n.remove());
  for (const el of doc.querySelectorAll("*")) {
    for (const attr of [...el.attributes]) {
      const value = attr.value.trim().toLowerCase();
      if (attr.name.startsWith("on") || value.startsWith("javascript:")) el.removeAttribute(attr.name);
    }
  }
  const styles = [...doc.head.querySelectorAll("style")].map((s) => s.outerHTML).join("");
  return {
    html: styles + doc.body.innerHTML,
    hasRemoteImages: !!doc.querySelector('img[src^="http"]'),
  };
}

function mailForClaude(mail) {
  const text = mail.body?.contentType === "html" ? htmlToText(mail.body.content) : mail.body?.content || "";
  return {
    subject: mail.subject || "",
    from: `${who(mail.from)} <${addr(mail.from)}>`,
    to: (mail.toRecipients || []).map((r) => `${who(r)} <${addr(r)}>`).join(", "),
    received: mail.receivedDateTime,
    body: text,
  };
}

async function markUnread() {
  const mail = state.current;
  await graph(`/me/messages/${mail.id}`, { method: "PATCH", body: { isRead: false } });
  const inList = state.messages.find((m) => m.id === mail.id);
  if (inList) inList.isRead = false;
  closeMessage();
}

async function deleteCurrent() {
  const mail = state.current;
  if (!confirm(`Kas kustutada kiri „${mail.subject || "(teemata)"}“? See liigub kausta „Kustutatud“.`)) return;
  await graph(`/me/messages/${mail.id}/move`, { method: "POST", body: { destinationId: "deleteditems" } });
  state.messages = state.messages.filter((m) => m.id !== mail.id);
  closeMessage();
  toast("Kiri viidi kausta „Kustutatud“.");
}

function closeMessage() {
  state.current = null;
  renderMessage();
  renderList();
  showTab("inbox");
}

// ---------- compose and reply ----------

function openCompose(mode) {
  const source = mode === "new" ? null : state.current;
  state.compose = { mode, source };
  const isReply = mode !== "new";

  $("compose-title").textContent =
    mode === "new" ? "Uus kiri" : mode === "reply" ? "Vastus" : "Vastus kõigile";
  const to = $("compose-to");
  const subject = $("compose-subject");
  to.readOnly = subject.readOnly = isReply;
  if (isReply) {
    const me = (getAccount()?.username || "").toLowerCase();
    const people = mode === "reply"
      ? [source.from]
      : [source.from, ...(source.toRecipients || []), ...(source.ccRecipients || [])]
          .filter((r) => addr(r).toLowerCase() !== me);
    to.value = [...new Set(people.map(addr).filter(Boolean))].join(", ");
    subject.value = /^(re|vs):/i.test(source.subject || "") ? source.subject : `RE: ${source.subject || ""}`;
  } else {
    to.value = "";
    subject.value = "";
  }
  $("compose-ai").hidden = !isReply;
  $("compose-instruction").value = "";
  $("compose-body").value = "";
  $("compose-people").hidden = true;
  $("compose").showModal();
  (isReply ? $("compose-body") : to).focus();
}

// Claude writes a draft into the text box. Nothing is sent.
async function generateDraft() {
  const { source } = state.compose;
  const button = $("compose-generate");
  const box = $("compose-body");
  if (box.value.trim() && !confirm("Kas asendada praegune tekst Claude'i mustandiga?")) return;
  await busy(button, "Claude kirjutab…", () =>
    attempt("Mustandi koostamine", async () => {
      const result = await askClaude("reply", mailForClaude(source), $("compose-instruction").value);
      if (state.compose?.source !== source || !$("compose").open) return;
      box.value = result.body;
      box.focus();
    })
  );
}

function parseRecipients(text) {
  return text
    .split(/[,;]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((address) => ({ emailAddress: { address } }));
}

// send = true sends the message; false only saves it to the Drafts folder.
async function deliver(send) {
  const { mode, source } = state.compose;
  const text = $("compose-body").value;
  if (send && !text.trim()) throw new Error("Kiri on tühi.");
  let draft;

  if (mode === "new") {
    const toRecipients = parseRecipients($("compose-to").value);
    const bad = toRecipients.find((r) => !/^\S+@\S+\.\S+$/.test(r.emailAddress.address));
    if (send && !toRecipients.length) throw new Error("Lisa vähemalt üks saaja.");
    if (bad) throw new Error(`Vigane aadress: ${bad.emailAddress.address}`);
    draft = await graph("/me/messages", {
      method: "POST",
      body: {
        subject: $("compose-subject").value,
        body: { contentType: "Text", content: text },
        toRecipients,
      },
    });
  } else {
    // Outlook builds the reply (recipients, subject, quoted original); we add the text on top.
    draft = await graph(`/me/messages/${source.id}/${mode === "reply" ? "createReply" : "createReplyAll"}`, {
      method: "POST",
    });
    const mine = `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt">${escapeHtml(text).replace(/\n/g, "<br>")}</div><br>`;
    const quoted = draft.body?.content || "";
    const merged = /<body[^>]*>/i.test(quoted)
      ? quoted.replace(/<body[^>]*>/i, (tag) => tag + mine)
      : mine + quoted;
    await graph(`/me/messages/${draft.id}`, {
      method: "PATCH",
      body: { body: { contentType: "HTML", content: merged } },
    });
  }

  if (send) {
    await graph(`/me/messages/${draft.id}/send`, { method: "POST" });
    toast("Kiri saadetud.");
  } else {
    toast("Mustand salvestatud Outlooki kausta „Mustandid“.");
  }
  $("compose").close();
}

// Suggests recipients from the people the user writes to most (People.Read).
let peopleTimer;
function suggestPeople() {
  const input = $("compose-to");
  const list = $("compose-people");
  clearTimeout(peopleTimer);
  if (input.readOnly) return;
  const parts = input.value.split(/[,;]/);
  const term = parts[parts.length - 1].trim();
  if (term.length < 2) {
    list.hidden = true;
    return;
  }
  peopleTimer = setTimeout(async () => {
    try {
      const data = await graph(
        `/me/people?$search=${encodeURIComponent(`"${term.replace(/"/g, "")}"`)}&$top=6&$select=displayName,scoredEmailAddresses`
      );
      const people = data.value
        .map((p) => ({ name: p.displayName, address: p.scoredEmailAddresses?.[0]?.address }))
        .filter((p) => p.address);
      list.replaceChildren(
        ...people.map((p) =>
          h("li", {
            tabIndex: 0,
            onclick: () => {
              parts[parts.length - 1] = ` ${p.address}`;
              input.value = parts.join(",").trim() + ", ";
              list.hidden = true;
              input.focus();
            },
          }, `${p.name} <${p.address}>`)
        )
      );
      list.hidden = !people.length;
    } catch (err) {
      console.error("People search failed", err);
      list.hidden = true;
    }
  }, 300);
}
