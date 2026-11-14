// Calendar pane: a day or a week as an hour grid, or a month as a grid of
// days. Click an empty time to add an event, click an event to change or
// delete it, click a day in the month to open that day.

import { graph, localDate } from "./graph.js";
import { $, h, toast, attempt, fmtTime, fmtDayTitle, startOfDay, sameDay, fromGraphUtc, toGraphUtc, htmlToText, who, addr } from "./util.js";

const HOUR_PX = 48;
const DAY_MS = 24 * 60 * 60 * 1000;
const FIELDS = "id,subject,start,end,isAllDay,location,webLink,showAs,isCancelled";
const MODES = ["day", "week", "month"];
const MODE_KEY = "taskmeil.calMode";
const WEEKDAYS = ["E", "T", "K", "N", "R", "L", "P"];

function savedMode() {
  try {
    const mode = localStorage.getItem(MODE_KEY);
    return MODES.includes(mode) ? mode : "day";
  } catch {
    return "day";
  }
}

const state = {
  day: startOfDay(new Date()), // the day shown, or a day inside the week or month shown
  mode: savedMode(),
  events: [],
  editing: null, // event being edited, or null for a new one
};
let loadSeq = 0;

const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7)); // weeks start on Monday
const overlaps = (ev, from, to) => ev.from < to && ev.to > from;

// The days on screen: [first day, day after the last].
function visibleRange() {
  const d = state.day;
  if (state.mode === "day") return [d, addDays(d, 1)];
  if (state.mode === "week") return [weekStart(d), addDays(weekStart(d), 7)];
  const first = weekStart(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [first, addDays(weekStart(last), 7)];
}

function visibleDays() {
  const [from, to] = visibleRange();
  const days = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  return days;
}

export function initCalendar() {
  $("cal-prev").addEventListener("click", () => move(-1));
  $("cal-next").addEventListener("click", () => move(1));
  $("cal-today").addEventListener("click", () => {
    state.day = startOfDay(new Date());
    attempt("Kalendri laadimine", loadCalendar);
  });
  for (const button of document.querySelectorAll("#cal-modes button")) {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  }
  $("cal-grid").addEventListener("click", (e) => {
    if (e.target.closest(".event")) return;
    const days = visibleDays();
    const box = $("cal-grid").getBoundingClientRect();
    const minutes = Math.max(0, Math.min(23.5 * 60, Math.floor((e.clientY - box.top) / HOUR_PX * 2) * 30));
    const column = Math.floor((e.clientX - box.left - 52) / ((box.width - 58) / days.length));
    const day = days[Math.max(0, Math.min(days.length - 1, column || 0))];
    openEventDialog(null, new Date(day.getTime() + minutes * 60000));
  });
  $("event-cancel").addEventListener("click", () => $("event-dialog").close());
  $("event-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt("Sündmuse salvestamine", saveEvent);
  });
  $("event-delete").addEventListener("click", () => attempt("Sündmuse kustutamine", deleteEvent));
}

function setMode(mode, day = state.day) {
  state.mode = MODES.includes(mode) ? mode : "day";
  state.day = day;
  try {
    localStorage.setItem(MODE_KEY, state.mode);
  } catch {
    /* not remembered */
  }
  delete $("cal-grid").dataset.scrolled;
  attempt("Kalendri laadimine", loadCalendar);
}

// One step back or forward: a day, a week or a month.
function move(step) {
  const d = state.day;
  state.day =
    state.mode === "month" ? new Date(d.getFullYear(), d.getMonth() + step, 1)
    : addDays(d, step * (state.mode === "week" ? 7 : 1));
  attempt("Kalendri laadimine", loadCalendar);
}

// All-day events come as plain dates (midnight to midnight); read them as
// local days, whatever the time zone.
function allDayDate(value) {
  const [y, m, d] = value.dateTime.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

export async function loadCalendar() {
  const seq = ++loadSeq;
  const [from, to] = visibleRange();
  let url =
    `/me/calendarView?startDateTime=${from.toISOString()}&endDateTime=${to.toISOString()}` +
    `&$select=${FIELDS}&$orderby=start/dateTime&$top=100`;
  const found = [];
  for (let page = 0; url && page < 10; page++) {
    const data = await graph(url);
    if (seq !== loadSeq) return; // the user moved on meanwhile
    found.push(...data.value);
    url = data["@odata.nextLink"] || null;
  }
  state.events = found
    .filter((ev) => !ev.isCancelled)
    .map((ev) => ev.isAllDay
      ? { ...ev, from: allDayDate(ev.start), to: allDayDate(ev.end) }
      : { ...ev, from: fromGraphUtc(ev.start), to: fromGraphUtc(ev.end) })
    .filter((ev) => overlaps(ev, from, to));
  render();
}

const monthFmt = new Intl.DateTimeFormat("et-EE", { month: "long", year: "numeric" });
const shortFmt = new Intl.DateTimeFormat("et-EE", { day: "numeric", month: "short" });

function title() {
  const day = state.day;
  if (state.mode === "month") return monthFmt.format(day);
  if (state.mode === "week") {
    const [from, to] = visibleRange();
    return `${shortFmt.format(from)} – ${shortFmt.format(addDays(to, -1))} ${addDays(to, -1).getFullYear()}`;
  }
  return sameDay(day, new Date()) ? `Täna, ${fmtDayTitle(day)}` : fmtDayTitle(day);
}

const allDayChip = (ev) =>
  h("a", { class: "allday", href: ev.webLink, target: "_blank", rel: "noopener", title: "Ava Outlookis" },
    ev.subject || "(pealkirjata)");

function render() {
  $("cal-title").textContent = title();
  for (const button of document.querySelectorAll("#cal-modes button")) {
    const on = button.dataset.mode === state.mode;
    button.classList.toggle("active", on);
    button.setAttribute("aria-pressed", String(on));
  }
  const step = { day: "päev", week: "nädal", month: "kuu" }[state.mode];
  $("cal-prev").setAttribute("aria-label", `Eelmine ${step}`);
  $("cal-next").setAttribute("aria-label", `Järgmine ${step}`);

  const month = state.mode === "month";
  $("cal-month").hidden = !month;
  $("cal-scroll").hidden = month;
  $("cal-allday").hidden = state.mode !== "day";
  $("cal-days").hidden = state.mode !== "week";
  if (month) renderMonth();
  else renderHours();
}

// Day and week: an hour grid with one column per day.
function renderHours() {
  const days = visibleDays();
  const n = days.length;
  const today = new Date();

  if (n === 1) {
    $("cal-allday").replaceChildren(...state.events.filter((ev) => ev.isAllDay).map(allDayChip));
  } else {
    $("cal-days").replaceChildren(
      ...days.map((day, i) =>
        h("div", { class: `cal-day${sameDay(day, today) ? " today" : ""}` },
          h("button", {
            class: "cal-day-name",
            type: "button",
            title: "Ava päev",
            onclick: () => setMode("day", day),
          }, `${WEEKDAYS[i]} ${day.getDate()}`),
          ...state.events.filter((ev) => ev.isAllDay && overlaps(ev, day, addDays(day, 1))).map(allDayChip)
        )
      )
    );
  }

  const grid = $("cal-grid");
  grid.style.height = `${24 * HOUR_PX}px`;
  const nodes = [];
  for (let hour = 0; hour < 24; hour++) {
    nodes.push(h("div", { class: "hour", style: `top:${hour * HOUR_PX}px` },
      h("span", {}, `${String(hour).padStart(2, "0")}:00`)));
  }
  for (let i = 1; i < n; i++) {
    nodes.push(h("div", { class: "day-line", style: `left:calc(52px + (100% - 58px) * ${i / n})` }));
  }

  days.forEach((day, dayIndex) => {
    const dayEnd = addDays(day, 1);
    // The part of each event that falls on this day.
    const items = state.events
      .filter((ev) => !ev.isAllDay && overlaps(ev, day, dayEnd))
      .map((ev) => ({ ev, from: ev.from < day ? day : ev.from, to: ev.to > dayEnd ? dayEnd : ev.to }))
      .sort((a, b) => a.from - b.from || b.to - a.to);

    // Events that overlap share the width side by side.
    let group = [], groupEnd = 0;
    const flush = () => {
      const columns = [];
      for (const item of group) {
        let col = columns.findIndex((end) => end <= item.from);
        if (col === -1) col = columns.push(0) - 1;
        columns[col] = item.to;
        item.col = col;
      }
      for (const item of group) item.cols = columns.length;
      group = [];
    };
    for (const item of items) {
      if (group.length && item.from >= groupEnd) flush();
      group.push(item);
      groupEnd = Math.max(groupEnd, item.to.getTime());
    }
    flush();

    for (const { ev, from, to, col, cols } of items) {
      const startMin = (from - day) / 60000;
      const endMin = (to - day) / 60000;
      const height = Math.max(22, (endMin - startMin) / 60 * HOUR_PX - 2);
      nodes.push(h("button", {
        class: `event${ev.showAs === "tentative" ? " tentative" : ""}`,
        title: `${ev.subject || "(pealkirjata)"} ${fmtTime(ev.from)}–${fmtTime(ev.to)}`,
        style: `top:${startMin / 60 * HOUR_PX}px;height:${height}px;` +
          `left:calc(52px + (100% - 58px) * ${(dayIndex + col / cols) / n});width:calc((100% - 58px) / ${cols * n} - 2px)`,
        onclick: () => openEventDialog(ev),
      },
        h("strong", {}, ev.subject || "(pealkirjata)"),
        h("span", {}, ` ${fmtTime(ev.from)}–${fmtTime(ev.to)}`),
        ev.location?.displayName && h("span", {}, ` · ${ev.location.displayName}`)
      ));
    }

    if (sameDay(day, today)) {
      const top = (today - day) / 3600000 * HOUR_PX;
      nodes.push(h("div", {
        class: "now",
        style: n === 1 ? `top:${top}px` : `top:${top}px;left:calc(52px + (100% - 58px) * ${dayIndex / n});width:calc((100% - 58px) / ${n})`,
      }));
    }
  });
  grid.replaceChildren(...nodes);

  if (!grid.dataset.scrolled) {
    const showsToday = days.some((day) => sameDay(day, today));
    $("cal-scroll").scrollTop = (showsToday ? Math.max(0, today.getHours() - 1) : 7) * HOUR_PX;
    grid.dataset.scrolled = "1";
  }
}

// Month: a grid of days with the first few events of each.
const MONTH_CHIPS = 3;

function renderMonth() {
  const today = new Date();
  const cells = visibleDays().map((day) => {
    const events = state.events
      .filter((ev) => overlaps(ev, day, addDays(day, 1)))
      .sort((a, b) => Number(b.isAllDay) - Number(a.isAllDay) || a.from - b.from);
    const openDay = () => setMode("day", day);
    return h("div", {
      class: `mcell${day.getMonth() === state.day.getMonth() ? "" : " other"}${sameDay(day, today) ? " today" : ""}`,
      title: "Ava päev",
      onclick: openDay,
    },
      h("button", { class: "mday", type: "button", "aria-label": fmtDayTitle(day), onclick: openDay }, String(day.getDate())),
      ...events.slice(0, MONTH_CHIPS).map((ev) =>
        h("button", {
          class: `mchip${ev.isAllDay ? " full" : ""}`,
          type: "button",
          title: ev.subject || "(pealkirjata)",
          onclick: (e) => {
            e.stopPropagation();
            if (ev.isAllDay && ev.webLink) window.open(ev.webLink, "_blank", "noopener");
            else openEventDialog(ev);
          },
        }, `${ev.isAllDay ? "" : fmtTime(ev.from) + " "}${ev.subject || "(pealkirjata)"}`)
      ),
      events.length > MONTH_CHIPS && h("span", { class: "mmore" }, `+${events.length - MONTH_CHIPS} veel`)
    );
  });
  $("cal-month").replaceChildren(
    ...WEEKDAYS.map((name) => h("div", { class: "mhead" }, name)),
    ...cells
  );
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
  // A new event gets a description field; an existing one shows its content,
  // which is changed in Outlook so that invitation formatting is not lost.
  $("event-notes").value = "";
  $("event-notes-label").hidden = !!ev;
  $("event-details").hidden = true;
  $("event-dialog").showModal();
  $("event-title").focus();
  if (ev) showEventDetails(ev).catch((err) => console.warn("Event details not loaded:", err.message));
}

const RESPONSES = { accepted: "tuleb", declined: "ei tule", tentativelyAccepted: "võib-olla" };

// Organizer, attendees, meeting link and description of an existing event.
async function showEventDetails(ev) {
  const full = await graph(
    `/me/events/${ev.id}?$select=body,attendees,organizer,isOrganizer,onlineMeeting`
  );
  if (state.editing !== ev || !$("event-dialog").hasAttribute("open")) return; // closed or another event opened meanwhile
  const row = (id, shown) => {
    $(id).hidden = !shown;
    $(id).previousElementSibling.hidden = !shown;
  };

  const attendees = full.attendees || [];
  $("event-organizer").textContent = who(full.organizer);
  row("event-organizer", !!full.organizer && (!full.isOrganizer || attendees.length > 0));

  $("event-attendees").textContent = attendees
    .map((a) => {
      const answer = RESPONSES[a.status?.response];
      return who(a) + (answer ? ` (${answer})` : "");
    })
    .join(", ");
  row("event-attendees", attendees.length > 0);

  const join = full.onlineMeeting?.joinUrl;
  if (join) $("event-join").href = join;
  $("event-join").parentElement.hidden = !join;
  $("event-join").parentElement.previousElementSibling.hidden = !join;

  const text = (full.body?.contentType === "html" ? htmlToText(full.body.content || "") : full.body?.content || "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  $("event-body").textContent = text;
  row("event-body", !!text);

  $("event-details").hidden = !(text || join || attendees.length);
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
  const notes = $("event-notes").value.trim();
  if (!ev && notes) body.body = { contentType: "text", content: notes };
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
