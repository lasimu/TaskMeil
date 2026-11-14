// Small DOM and formatting helpers shared by the panes.

export const $ = (id) => document.getElementById(id);

// h("li", { class: "x", onclick: fn }, "text", childNode)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else if (key === "class") el.className = value;
    else if (key === "dataset") Object.assign(el.dataset, value);
    else if (key in el && key !== "list") el[key] = value;
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

let toastTimer;
export function toast(message, isError = false) {
  const el = $("toast");
  el.textContent = message;
  el.classList.toggle("error", isError);
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), isError ? 7000 : 3500);
}

// Runs an action and shows a readable message if it fails.
export async function attempt(what, fn) {
  try {
    return await fn();
  } catch (err) {
    console.error(what, err);
    toast(`${what}: ${err.message || err}`, true);
    return undefined;
  }
}

// Disables a button and swaps its label while a request is running.
export async function busy(button, label, fn) {
  const original = button.textContent;
  button.disabled = true;
  button.textContent = label;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

const LOCALE = "et-EE";
const timeFmt = new Intl.DateTimeFormat(LOCALE, { hour: "2-digit", minute: "2-digit" });
const dayFmt = new Intl.DateTimeFormat(LOCALE, { day: "numeric", month: "short" });
const fullFmt = new Intl.DateTimeFormat(LOCALE, {
  weekday: "short", day: "numeric", month: "short", year: "numeric",
  hour: "2-digit", minute: "2-digit",
});
const titleFmt = new Intl.DateTimeFormat(LOCALE, { weekday: "long", day: "numeric", month: "long" });

export const fmtTime = (d) => timeFmt.format(d);
export const fmtDay = (d) => dayFmt.format(d);
export const fmtFull = (d) => fullFmt.format(d);
export const fmtDayTitle = (d) => titleFmt.format(d);

export function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

export function sameDay(a, b) {
  return startOfDay(a).getTime() === startOfDay(b).getTime();
}

// Time today, otherwise the date.
export function fmtShort(d) {
  return sameDay(d, new Date()) ? fmtTime(d) : fmtDay(d);
}

// Graph returns { dateTime: "2026-11-14T08:00:00.0000000", timeZone: "UTC" }.
export function fromGraphUtc(value) {
  return new Date(value.dateTime.slice(0, 23) + "Z");
}

export function toGraphUtc(date) {
  return { dateTime: date.toISOString().slice(0, 19), timeZone: "UTC" };
}

export const addr = (r) => r?.emailAddress?.address || "";
export const who = (r) => r?.emailAddress?.name || addr(r) || "(tundmatu)";

// Plain text of an HTML email, with line breaks kept at block boundaries.
export function htmlToText(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script,style,head,title").forEach((n) => n.remove());
  const blocks = new Set(["P", "DIV", "TR", "LI", "H1", "H2", "H3", "H4", "BLOCKQUOTE", "TABLE", "UL", "OL"]);
  let out = "";
  (function walk(node) {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) out += child.nodeValue.replace(/\s+/g, " ");
      else if (child.nodeType === 1) {
        if (child.tagName === "BR") out += "\n";
        walk(child);
        if (blocks.has(child.tagName)) out += "\n";
      }
    }
  })(doc.body);
  return out.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
