// Calendar pane: one day as an hour grid. Click an empty time to add an
// event, click an event to change or delete it.

import { graph, localDate } from "./graph.js";
import { $, h, toast, attempt, fmtTime, fmtDayTitle, startOfDay, sameDay, fromGraphUtc, toGraphUtc } from "./util.js";

const HOUR_PX = 48;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIELDS = "id,subject,start,end,isAllDay,location,webLink,showAs,isCancelled";

const state = {
  day: startOfDay(new Date()),
  events: [],
  editing: null, // event being edited, or null for a new one
};

export function initCalendar() {
  $("cal-prev").addEventListener("click", () => moveDay(-1));
  $("cal-next").addEventListener("click", () => moveDay(1));
  $("cal-today").addEventListener("click", () => {
    state.day = startOfDay(new Date());
    attempt("Kalendri laadimine", loadCalendar);
  });
  $("cal-grid").addEventListener("click", (e) => {
    if (e.target.closest(".event")) return;
    const y = e.clientY - $("cal-grid").getBoundingClientRect().top;
    const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor(y / HOUR_PX * 2) * 30));
    openEventDialog(null, new Date(state.day.getTime() + minutes * 60000));
  });
  $("event-cancel").addEventListener("click", () => $("event-dialog").close());
  $("event-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt("Sündmuse salvestamine", saveEvent);
  });
  $("event-delete").addEventListener("click", () => attempt("Sündmuse kustutamine", deleteEvent));
}

function moveDay(step) {
  const d = state.day;
  state.day = new Date(d.getFullYear(), d.getMonth(), d.getDate() + step);
  attempt("Kalendri laadimine", loadCalendar);
}

export async function loadCalendar() {
  const day = state.day;
  const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
  const data = await graph(
    `/me/calendarView?startDateTime=${day.toISOString()}&endDateTime=${end.toISOString()}` +
    `&$select=${FIELDS}&$orderby=start/dateTime&$top=100`
  );
  if (day !== state.day) return; // the user moved to another day meanwhile
  state.events = data.value
    .filter((ev) => !ev.isCancelled)
    .map((ev) => ({ ...ev, from: fromGraphUtc(ev.start), to: fromGraphUtc(ev.end) }));
  render();
}

function render() {
  const day = state.day;
  const isToday = sameDay(day, new Date());
  $("cal-title").textContent = isToday ? `Täna, ${fmtDayTitle(day)}` : fmtDayTitle(day);

  const allDay = state.events.filter((ev) => ev.isAllDay);
  $("cal-allday").replaceChildren(
    ...allDay.map((ev) =>
      h("a", { class: "allday", href: ev.webLink, target: "_blank", rel: "noopener", title: "Ava Outlookis" },
        ev.subject || "(pealkirjata)")
    )
  );

  const grid = $("cal-grid");
  grid.style.height = `${24 * HOUR_PX}px`;
  const nodes = [];
  for (let hour = 0; hour < 24; hour++) {
    nodes.push(h("div", { class: "hour", style: `top:${hour * HOUR_PX}px` },
      h("span", {}, `${String(hour).padStart(2, "0")}:00`)));
  }

  // Events that overlap share the width side by side.
  const timed = state.events.filter((ev) => !ev.isAllDay).sort((a, b) => a.from - b.from || b.to - a.to);
  let group = [], groupEnd = 0;
  const flush = () => {
    const columns = [];
    for (const ev of group) {
      let col = columns.findIndex((end) => end <= ev.from);
      if (col === -1) col = columns.push(0) - 1;
      columns[col] = ev.to;
      ev.col = col;
    }
    for (const ev of group) ev.cols = columns.length;
    group = [];
  };
  for (const ev of timed) {
    if (group.length && ev.from >= groupEnd) flush();
    group.push(ev);
    groupEnd = Math.max(groupEnd, ev.to.getTime());
  }
  flush();

  for (const ev of timed) {
    const startMin = Math.max(0, (ev.from - day) / 60000);
    const endMin = Math.min(24 * 60, (ev.to - day) / 60000);
    const height = Math.max(22, (endMin - startMin) / 60 * HOUR_PX - 2);
    nodes.push(h("button", {
      class: `event${ev.showAs === "tentative" ? " tentative" : ""}`,
      style: `top:${startMin / 60 * HOUR_PX}px;height:${height}px;` +
        `left:calc(52px + (100% - 58px) * ${ev.col / ev.cols});width:calc((100% - 58px) / ${ev.cols} - 2px)`,
      onclick: () => openEventDialog(ev),
    },
      h("strong", {}, ev.subject || "(pealkirjata)"),
      h("span", {}, ` ${fmtTime(ev.from)}–${fmtTime(ev.to)}`),
      ev.location?.displayName && h("span", {}, ` · ${ev.location.displayName}`)
    ));
  }

  if (isToday) {
    const now = new Date();
    nodes.push(h("div", { class: "now", style: `top:${(now - day) / 3600000 * HOUR_PX}px` }));
  }
  grid.replaceChildren(...nodes);

  if (!grid.dataset.scrolled) {
    const from = isToday ? Math.max(0, new Date().getHours() - 1) : 7;
    $("cal-scroll").scrollTop = from * HOUR_PX;
    grid.dataset.scrolled = "1";
  }
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function openEventDialog(ev, start) {
  state.editing = ev;
  const from = ev ? ev.from : start;
  const to = ev ? ev.to : new Date(start.getTime() + 30 * 60000);
  $("event-heading").textContent = ev ? "Sündmus" : "Uus sündmus";
  $("event-title").value = ev?.subject || "";
  $("event-date").value = localDate(from);
  $("event-start").value = hhmm(from);
  $("event-end").value = to - startOfDay(from) >= DAY_MS ? "23:59" : hhmm(to);
  $("event-location").value = ev?.location?.displayName || "";
  $("event-delete").hidden = !ev;
  $("event-outlook").hidden = !ev?.webLink;
  if (ev?.webLink) $("event-outlook").href = ev.webLink;
  $("event-dialog").showModal();
  $("event-title").focus();
}

async function saveEvent() {
  const [y, m, d] = $("event-date").value.split("-").map(Number);
  const at = (value) => {
    const [hh, mm] = value.split(":").map(Number);
    return new Date(y, m - 1, d, hh, mm);
  };
  const from = at($("event-start").value);
  const to = at($("event-end").value);
  if (!(to > from)) throw new Error("Lõpp peab olema pärast algust.");

  const body = {
    subject: $("event-title").value.trim(),
    start: toGraphUtc(from),
    end: toGraphUtc(to),
    location: { displayName: $("event-location").value.trim() },
  };
  const ev = state.editing;
  if (ev) await graph(`/me/events/${ev.id}`, { method: "PATCH", body });
  else await graph("/me/events", { method: "POST", body });
  $("event-dialog").close();
  toast(ev ? "Sündmus muudetud." : "Sündmus lisatud.");
  state.day = startOfDay(from);
  await loadCalendar();
}

async function deleteEvent() {
  const ev = state.editing;
  if (!confirm(`Kas kustutada sündmus „${ev.subject || "(pealkirjata)"}“?`)) return;
  await graph(`/me/events/${ev.id}`, { method: "DELETE" });
  $("event-dialog").close();
  toast("Sündmus kustutatud.");
  await loadCalendar();
}
