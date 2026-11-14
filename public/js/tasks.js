// Tasks pane: Microsoft To Do lists and tasks.

import { graph } from "./graph.js";
import { $, h, toast, attempt, fmtDay, startOfDay, fromGraphUtc, toGraphUtc } from "./util.js";

const state = {
  lists: [],
  listId: null,
  tasks: [],
  proposalMail: null, // the email a Claude suggestion came from
  onSaved: null, // called once the user has confirmed the suggestion
};

export function initTasks() {
  $("task-lists").addEventListener("change", (e) => {
    state.listId = e.target.value;
    attempt("Ülesannete laadimine", loadTasks);
  });
  $("task-add").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("task-new");
    const title = input.value.trim();
    if (!title) return;
    const due = $("task-new-due").value;
    input.value = "";
    $("task-new-due").value = "";
    attempt("Ülesande lisamine", () => createTask({ title, due }));
  });
  $("task-cancel").addEventListener("click", () => $("task-dialog").close());
  $("task-form").addEventListener("submit", (e) => {
    e.preventDefault();
    attempt("Ülesande lisamine", saveProposal);
  });
}

export async function loadTaskLists() {
  const data = await graph("/me/todo/lists");
  state.lists = data.value;
  const fallback = state.lists.find((l) => l.wellknownListName === "defaultList") || state.lists[0];
  if (!state.lists.some((l) => l.id === state.listId)) state.listId = fallback?.id || null;
  $("task-lists").replaceChildren(
    ...state.lists.map((l) => h("option", { value: l.id, selected: l.id === state.listId }, l.displayName))
  );
  await loadTasks();
}

export async function loadTasks() {
  if (!state.listId) {
    state.tasks = [];
    return renderTasks();
  }
  const listId = state.listId;
  const data = await graph(
    `/me/todo/lists/${listId}/tasks?$filter=${encodeURIComponent("status ne 'completed'")}&$top=100`
  );
  if (listId !== state.listId) return; // the user switched lists meanwhile
  state.tasks = data.value;
  renderTasks();
}

const dueOf = (task) => (task.dueDateTime ? fromGraphUtc(task.dueDateTime) : null);

function renderTasks() {
  const today = startOfDay(new Date());
  const sorted = [...state.tasks].sort((a, b) => {
    const da = dueOf(a), db = dueOf(b);
    if (da && db) return da - db;
    if (da || db) return da ? -1 : 1;
    return new Date(b.createdDateTime) - new Date(a.createdDateTime);
  });
  $("task-list").replaceChildren(
    ...sorted.map((task) => {
      const due = dueOf(task);
      const link = task.linkedResources?.[0]?.webUrl;
      return h("li", { class: `task${task.importance === "high" ? " high" : ""}` },
        h("input", {
          type: "checkbox",
          "aria-label": `Märgi tehtuks: ${task.title}`,
          onchange: () => attempt("Ülesande lõpetamine", () => completeTask(task)),
        }),
        h("div", { class: "task-main" },
          h("div", { class: "task-title" }, task.title),
          task.body?.content?.trim() && h("div", { class: "task-notes" }, task.body.content.trim()),
          h("div", { class: "task-tags" },
            due
              ? h("span", { class: `tag${due < today ? " overdue" : ""}`, title: "Tähtaeg" }, `Tähtaeg ${fmtDay(due)}`)
              : task.createdDateTime &&
                h("span", { class: "tag muted", title: "Lisamise kuupäev" }, `Lisatud ${fmtDay(new Date(task.createdDateTime))}`),
            task.importance === "high" && h("span", { class: "tag important" }, "Tähtis"),
            link && h("a", { class: "tag", href: link, target: "_blank", rel: "noopener" }, "Ava kiri")
          )
        )
      );
    })
  );
  if (!sorted.length) $("task-list").append(h("li", { class: "empty" }, "Kõik tehtud."));
}

async function completeTask(task) {
  await graph(`/me/todo/lists/${state.listId}/tasks/${task.id}`, {
    method: "PATCH",
    body: { status: "completed" },
  });
  state.tasks = state.tasks.filter((t) => t.id !== task.id);
  renderTasks();
  toast("Ülesanne tehtud.");
}

async function createTask({ title, notes, due, importance, mail }) {
  if (!state.listId) throw new Error("Microsoft To Do nimekirja ei leitud.");
  const body = { title, importance: importance || "normal" };
  if (notes) body.body = { content: notes, contentType: "text" };
  if (due) {
    const [y, m, d] = due.split("-").map(Number);
    body.dueDateTime = toGraphUtc(new Date(y, m - 1, d));
  }
  if (mail?.webLink) {
    body.linkedResources = [{
      webUrl: mail.webLink,
      applicationName: "Taskmeil",
      displayName: mail.subject || "Kiri",
    }];
  }
  const created = await graph(`/me/todo/lists/${state.listId}/tasks`, { method: "POST", body });
  if (body.linkedResources && !created.linkedResources) created.linkedResources = body.linkedResources;
  state.tasks.push(created);
  renderTasks();
  toast("Ülesanne lisatud.");
}

// Shows Claude's suggestion for the user to edit. It is saved only on "Lisa ülesanne".
export function proposeTask(suggestion, mail, onSaved = null) {
  state.proposalMail = mail;
  state.onSaved = onSaved;
  $("task-title").value = suggestion.title || "";
  $("task-notes").value = suggestion.notes || "";
  $("task-due").value = suggestion.due_date || "";
  $("task-importance").value = ["low", "normal", "high"].includes(suggestion.importance)
    ? suggestion.importance
    : "normal";
  $("task-dialog").showModal();
}

async function saveProposal() {
  const title = $("task-title").value.trim();
  if (!title) return;
  await createTask({
    title,
    notes: $("task-notes").value.trim(),
    due: $("task-due").value,
    importance: $("task-importance").value,
    mail: state.proposalMail,
  });
  $("task-dialog").close();
  state.onSaved?.();
  state.onSaved = null;
}
