import "./style.css";
import {
  PEOPLE,
  PERSON,
  SLOT,
  SLOTS,
  buildBookings,
  clashes,
  sortPeople,
  type Bookings,
  type Op,
  type Session,
} from "@board/shared";
import { Link, type LinkState, type Result } from "./socket.ts";
import { Board } from "./store.ts";

/* ---------------- state ---------------- */

const board = new Board();
let link: Link;
let linkState: LinkState = "connecting";
let loaded = false; // first snapshot arrived
let everOpened = false;
let missingKey = false; // deployed board wants a key and the link has none
let view: "slots" | "people" = "slots";
let openPicker: string | null = null;
let pendingDelete: string | null = null;
const drafts: Record<string, string> = {}; // sessionId -> in-flight topic text
const saveTimers: Record<string, ReturnType<typeof setTimeout>> = {};
let toastTimer: ReturnType<typeof setTimeout> | undefined;

const appEl = document.getElementById("app")!;
const statusEl = document.getElementById("status")!;

/* ---------------- helpers ---------------- */

function esc(s: unknown): string {
  return String(s ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
}

function topicOf(s: Session): string {
  return (drafts[s.id] ?? s.topic ?? "").trim();
}

function labelOf(s: Session): string {
  return topicOf(s) || "Untitled session";
}

/** Sessions in this slot, other than `except`, that already have this person. */
function elsewhere(slot: string, person: string, except: string): Session[] {
  return board.inSlot(slot).filter((o) => o.id !== except && o.people.includes(person));
}

/* Browsers without CSS `field-sizing` need the height set by hand. */
const NEEDS_AUTOSIZE = !(window.CSS && CSS.supports && CSS.supports("field-sizing", "content"));

function autosize(el: HTMLTextAreaElement | null): void {
  if (!NEEDS_AUTOSIZE || !el) return;
  el.style.height = "auto";
  el.style.height = el.scrollHeight + "px";
}

function toast(msg: string): void {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = "toast";
  el.setAttribute("role", "status");
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 3400);
}

/* ---------------- writes ---------------- */

/**
 * Show a change at once, send it, and reconcile when the server answers. On
 * failure the card snaps back to the server's copy and the page says why.
 *
 * Topic saves pass redraw=false: they fire on blur, and redrawing then would
 * replace the button the user is in the middle of clicking.
 */
function commit(id: string, op: Op, optimistic: Session | null, after?: (r: Result) => void, redraw = true): void {
  if (optimistic) board.edit(optimistic);
  else board.remove(id);
  const sent = link.send(op);
  if (redraw) render();
  void sent.then((r) => {
    board.settle(id, r.ok && op.type === "delete" ? null : r.session);
    if (!r.ok) toast(r.message ?? "That change didn't save. Try again.");
    after?.(r);
    render();
  });
}

/* ---------------- actions ---------------- */

function addSession(slot: string): void {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const session: Session = { id, topic: "", slot, people: [], createdAt: now, updatedAt: now, version: 0 };
  openPicker = id;
  pendingDelete = null;
  commit(id, { type: "create", id, slot }, session);
  document.getElementById("topic-" + id)?.focus();
}

function togglePerson(sid: string, pid: string): void {
  const s = board.get(sid);
  if (!s || !PERSON[pid]) return;
  if (s.people.includes(pid)) {
    commit(sid, { type: "removePerson", id: sid, person: pid }, { ...s, people: s.people.filter((p) => p !== pid) });
    return;
  }
  // Clashes are allowed, but say so. Check fresh state, since the roster can be
  // stale if someone else just edited.
  const clash = elsewhere(s.slot, pid, sid);
  commit(sid, { type: "addPerson", id: sid, person: pid }, { ...s, people: sortPeople([...s.people, pid]) });
  if (clash.length) toast(`Heads up: ${PERSON[pid].short} is also in “${labelOf(clash[0])}” in this slot.`);
}

/**
 * Move a session to another slot. Anyone in it who is already busy at the
 * destination comes off the session. The server makes the same call against the
 * latest data, and its answer is what the toast reports.
 */
function moveSession(sid: string, slot: string): void {
  const s = board.get(sid);
  if (!s || !SLOT[slot] || s.slot === slot) {
    render();
    return;
  }
  const people = s.people.filter((p) => !elsewhere(slot, p, sid).length);
  commit(sid, { type: "move", id: sid, slot }, { ...s, slot, people }, (r) => {
    if (!r.ok || !r.bumped?.length) return;
    const who = r.bumped.map((p) => PERSON[p]?.short ?? p).join(", ");
    toast(`${who} ${r.bumped.length === 1 ? "is" : "are"} already booked at ${SLOT[slot].cell}, so they came off this session.`);
  });
}

function saveTopic(sid: string): void {
  clearTimeout(saveTimers[sid]);
  const s = board.get(sid);
  const text = drafts[sid];
  if (s && text != null && text !== s.topic) commit(sid, { type: "setTopic", id: sid, topic: text }, { ...s, topic: text }, undefined, false);
}

function queueTopicSave(sid: string): void {
  clearTimeout(saveTimers[sid]);
  saveTimers[sid] = setTimeout(() => saveTopic(sid), 550);
}

function deleteSession(sid: string): void {
  if (!board.get(sid)) return;
  pendingDelete = null;
  if (openPicker === sid) openPicker = null;
  clearTimeout(saveTimers[sid]);
  delete drafts[sid];
  commit(sid, { type: "delete", id: sid }, null);
}

/* ---------------- rendering ---------------- */

function renderStatus(): void {
  let h = "";
  if (linkState === "offline") {
    if (!everOpened && missingKey) {
      h += '<div class="notice">This link is missing its access key. Open the board from the link you were sent.</div>';
    } else {
      const n = link.unsaved;
      h +=
        '<div class="notice offline">Can’t reach the board right now; reconnecting. ' +
        (n
          ? `${n} change${n === 1 ? "" : "s"} will save when the connection is back.`
          : "You can keep working; changes will save when the connection is back.") +
        (everOpened ? "" : " If this keeps up, reopen the board from the link you were sent.") +
        "</div>";
    }
  }
  statusEl.innerHTML = h;
}

function renderSummary(bookings: Bookings, sessions: Session[]): string {
  const idle = PEOPLE.filter((p) => !bookings[p.id]);
  const found = clashes(bookings);

  let h = '<div class="summary">';
  h += `<span><b>${sessions.length}</b> session${sessions.length === 1 ? "" : "s"}</span>`;
  h += '<span class="sep">/</span>';
  h += `<span><b>${PEOPLE.length - idle.length}</b> of <b>${PEOPLE.length}</b> people booked</span>`;
  if (idle.length) {
    h +=
      '<span class="sep">/</span><span><button type="button" class="linkish" data-act="view" data-view="people">' +
      `<b>${idle.length}</b> with nothing yet</button></span>`;
  }
  h += "</div>";

  if (found.length) {
    const lines = found.map(
      (c) =>
        `${PERSON[c.person].short} at ${SLOT[c.slot].cell}: ` +
        c.sessions.map((s) => `“${labelOf(s)}”`).join(" and "),
    );
    h +=
      '<div class="notice" role="alert">' +
      esc(found.length === 1 ? "Someone is double-booked — " : "Some people are double-booked — ") +
      esc(lines.join("; ")) +
      ". Remove them from one.</div>";
  }
  return h;
}

function renderCard(s: Session, bookings: Bookings): string {
  const people = s.people.filter((pid) => PERSON[pid]);
  const isOpen = openPicker === s.id;
  const clashed = people.filter((pid) => (bookings[pid]?.[s.slot] ?? []).length > 1);
  let h =
    `<article class="card${isOpen ? " picking" : ""}${clashed.length ? " has-clash" : ""}" data-card="${esc(s.id)}">`;

  h += '<div class="card-top">';
  h +=
    `<button type="button" class="grip" draggable="true" data-grip="1" data-sid="${esc(s.id)}"` +
    ` title="Drag to another slot" aria-label="Drag “${esc(labelOf(s))}” to another slot">` +
    '<svg width="12" height="16" viewBox="0 0 12 16" aria-hidden="true" fill="currentColor">' +
    '<circle cx="3" cy="3" r="1.5"/><circle cx="9" cy="3" r="1.5"/>' +
    '<circle cx="3" cy="8" r="1.5"/><circle cx="9" cy="8" r="1.5"/>' +
    '<circle cx="3" cy="13" r="1.5"/><circle cx="9" cy="13" r="1.5"/></svg></button>';
  h += "</div>";

  h += `<label class="vh" for="topic-${esc(s.id)}">Session topic</label>`;
  h +=
    `<textarea class="topic" id="topic-${esc(s.id)}" data-act="topic" data-sid="${esc(s.id)}"` +
    ` rows="1" maxlength="120" placeholder="What's this one about?">` +
    esc(drafts[s.id] ?? s.topic ?? "") +
    "</textarea>";

  if (people.length) {
    h += '<div class="chips">';
    for (const pid of people) {
      const dupe = clashed.includes(pid);
      const other = dupe ? elsewhere(s.slot, pid, s.id)[0] : null;
      const title = other
        ? `${PERSON[pid].name} is also in “${labelOf(other)}” this slot. Click to remove from this one.`
        : `Remove ${PERSON[pid].name}`;
      h +=
        `<button type="button" class="chip${dupe ? " dupe" : ""}" data-act="drop-person" data-sid="${esc(s.id)}"` +
        ` data-pid="${esc(pid)}" title="${esc(title)}">` +
        esc(PERSON[pid].short) +
        (dupe ? '<span aria-hidden="true">⚠</span>' : "") +
        '<span class="x" aria-hidden="true">×</span>' +
        `<span class="vh">${esc(title)}</span></button>`;
    }
    h += "</div>";
  } else {
    h += '<p class="empty-note">Nobody in this one yet.</p>';
  }

  if (isOpen) {
    h += '<div class="picker">';
    for (const p of PEOPLE) {
      const inThis = people.includes(p.id);
      const other = elsewhere(s.slot, p.id, s.id);
      const busy = other.length > 0;
      const where = busy ? `${inThis ? "also " : ""}in “${labelOf(other[0])}”` : "";
      h +=
        `<button type="button" class="pick${busy ? " busy" : ""}" data-act="toggle-person" data-sid="${esc(s.id)}"` +
        ` data-pid="${esc(p.id)}" aria-pressed="${inThis}"` +
        ` title="${esc(busy ? `${p.name} is ${where} this slot` : p.name)}">` +
        `<span>${esc(p.short)}</span>` +
        (busy ? `<span class="where">⚠ ${esc(where)}</span>` : "") +
        "</button>";
    }
    h += "</div>";
  }

  h += '<div class="card-foot">';
  h += `<span class="count">${people.length} attending</span>`;
  h += `<label class="vh" for="slot-${esc(s.id)}">Time slot</label>`;
  h += `<select class="slotpick" id="slot-${esc(s.id)}" data-act="move" data-sid="${esc(s.id)}">`;
  for (const sl of SLOTS) {
    h += `<option value="${esc(sl.id)}"${sl.id === s.slot ? " selected" : ""}>${esc(sl.cell)}</option>`;
  }
  h += "</select>";
  h +=
    `<button type="button" class="btn" data-act="toggle-picker" data-sid="${esc(s.id)}" aria-expanded="${isOpen}">` +
    (isOpen ? "Done" : "Add people") +
    "</button>";
  if (pendingDelete === s.id) {
    h += `<button type="button" class="btn danger" data-act="confirm-delete" data-sid="${esc(s.id)}">Delete</button>`;
    h += '<button type="button" class="btn ghost" data-act="cancel-delete">Keep</button>';
  } else {
    h += `<button type="button" class="btn ghost" data-act="ask-delete" data-sid="${esc(s.id)}" aria-label="Delete this session">Delete</button>`;
  }
  h += "</div></article>";
  return h;
}

function renderSlots(bookings: Bookings): string {
  let h = "";
  for (const slot of SLOTS) {
    const list = board.inSlot(slot.id);
    h += `<section class="slot" data-dropslot="${esc(slot.id)}">`;
    h += '<div class="slot-head">';
    h += `<span class="slot-time">${esc(slot.time)}</span>`;
    h += `<span class="slot-day">${esc(slot.day)}</span>`;
    h += '<span class="spacer"></span>';
    h += `<button type="button" class="btn primary" data-act="add" data-slot="${esc(slot.id)}">Add session</button>`;
    h += "</div>";

    h += list.length
      ? '<div class="cards">' + list.map((s) => renderCard(s, bookings)).join("") + "</div>"
      : '<p class="empty-note">No sessions in this slot.</p>';

    const free = PEOPLE.filter((p) => !(bookings[p.id]?.[slot.id] ?? []).length);
    if (free.length && list.length) {
      h += `<p class="free"><strong>Free this slot:</strong> ${esc(free.map((p) => p.short).join(", "))}</p>`;
    }
    h += "</section>";
  }
  return h;
}

function renderPeople(bookings: Bookings): string {
  let h = '<div class="gridwrap"><table class="grid"><thead><tr><th scope="col">Person</th>';
  for (const s of SLOTS) h += `<th scope="col">${esc(s.cell)}</th>`;
  h += "</tr></thead><tbody>";

  for (const p of PEOPLE) {
    const b = bookings[p.id] ?? {};
    const idle = Object.keys(b).length === 0;
    h += `<tr${idle ? ' class="idle"' : ""}><th scope="row">${esc(p.name)}</th>`;
    for (const slot of SLOTS) {
      const here = b[slot.id] ?? [];
      if (!here.length) {
        h += '<td class="blank">—</td>';
      } else {
        h +=
          `<td class="filled">${esc(labelOf(here[0]))}` +
          here.slice(1).map((o) => `<span class="dupe-note">also in “${esc(labelOf(o))}”</span>`).join("") +
          "</td>";
      }
    }
    h += "</tr>";
  }

  h += "</tbody></table></div>";
  h +=
    '<p class="free">Rows in amber have nothing on the schedule yet. Switch to ' +
    '<button type="button" class="linkish" data-act="view" data-view="slots">by slot</button> to put them somewhere.</p>';
  return h;
}

function render(): void {
  const active = document.activeElement as HTMLTextAreaElement | null;
  const keepId = active?.classList?.contains("topic") ? active.id : null;
  const caret = keepId ? [active!.selectionStart, active!.selectionEnd] : null;

  renderStatus();
  document.getElementById("view-slots")!.setAttribute("aria-pressed", String(view === "slots"));
  document.getElementById("view-people")!.setAttribute("aria-pressed", String(view === "people"));

  if (!loaded) {
    appEl.innerHTML = '<p class="empty-note" style="padding-block:28px">Loading the schedule…</p>';
    return;
  }

  const sessions = board.all();
  const bookings = buildBookings(sessions);
  appEl.innerHTML = renderSummary(bookings, sessions) + (view === "slots" ? renderSlots(bookings) : renderPeople(bookings));
  if (NEEDS_AUTOSIZE) appEl.querySelectorAll<HTMLTextAreaElement>("textarea.topic").forEach(autosize);

  // A teammate's edit re-renders everything; put the cursor back where it was.
  if (keepId) {
    const back = document.getElementById(keepId) as HTMLTextAreaElement | null;
    if (back) {
      back.focus();
      try {
        back.setSelectionRange(caret![0], caret![1]);
      } catch {
        /* not selectable */
      }
    }
  }
}

/* ---------------- events ---------------- */

document.addEventListener("click", (ev) => {
  const el = (ev.target as Element).closest<HTMLElement>("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  const sid = el.dataset.sid ?? "";
  const pid = el.dataset.pid ?? "";

  if (act === "view") {
    view = el.dataset.view === "people" ? "people" : "slots";
    openPicker = null;
    pendingDelete = null;
    render();
  } else if (act === "add") {
    addSession(el.dataset.slot!);
  } else if (act === "toggle-picker") {
    openPicker = openPicker === sid ? null : sid;
    pendingDelete = null;
    render();
  } else if (act === "toggle-person" || act === "drop-person") {
    togglePerson(sid, pid);
  } else if (act === "ask-delete") {
    pendingDelete = sid;
    render();
  } else if (act === "cancel-delete") {
    pendingDelete = null;
    render();
  } else if (act === "confirm-delete") {
    deleteSession(sid);
  }
});

document.addEventListener("change", (ev) => {
  const el = ev.target as HTMLSelectElement;
  if (el.matches?.('[data-act="move"]')) moveSession(el.dataset.sid!, el.value);
});

document.addEventListener("input", (ev) => {
  const el = ev.target as HTMLTextAreaElement;
  if (!el.matches?.('[data-act="topic"]')) return;
  const sid = el.dataset.sid!;
  drafts[sid] = el.value;
  autosize(el);
  queueTopicSave(sid);
});

document.addEventListener("focusout", (ev) => {
  const el = ev.target as HTMLTextAreaElement;
  if (!el.matches?.('[data-act="topic"]')) return;
  const sid = el.dataset.sid!;
  saveTopic(sid);
  delete drafts[sid];
});

document.addEventListener("keydown", (ev) => {
  const el = ev.target as HTMLElement;
  if (ev.key === "Enter" && el.matches?.('[data-act="topic"]')) {
    ev.preventDefault();
    el.blur();
  }
});

/* ---------------- drag a session to another slot ---------------- */

let dragId: string | null = null;
let hinted: Element | null = null;

function upTo(node: EventTarget | null, sel: string): HTMLElement | null {
  const n = node as Node | null;
  const el = n && n.nodeType === 1 ? (n as Element) : n?.parentElement;
  return el ? el.closest<HTMLElement>(sel) : null;
}

function hint(section: Element | null): void {
  if (hinted === section) return;
  hinted?.classList.remove("droptarget");
  hinted = section;
  hinted?.classList.add("droptarget");
}

document.addEventListener("dragstart", (ev) => {
  const grip = upTo(ev.target, "[data-grip]");
  if (!grip) return;
  dragId = grip.dataset.sid!;
  const card = grip.closest<HTMLElement>(".card");
  if (ev.dataTransfer) {
    ev.dataTransfer.effectAllowed = "move";
    ev.dataTransfer.setData("text/plain", dragId);
    if (card) ev.dataTransfer.setDragImage(card, 20, 20);
  }
  card?.classList.add("dragging");
});

document.addEventListener("dragend", () => {
  dragId = null;
  hint(null);
  document.querySelector(".card.dragging")?.classList.remove("dragging");
});

document.addEventListener("dragover", (ev) => {
  if (!dragId) return;
  const section = upTo(ev.target, "[data-dropslot]");
  if (!section) return hint(null);
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "move";
  hint(section);
});

document.addEventListener("drop", (ev) => {
  if (!dragId) return;
  const section = upTo(ev.target, "[data-dropslot]");
  const id = dragId;
  dragId = null;
  hint(null);
  if (!section) return;
  ev.preventDefault();
  moveSession(id, section.dataset.dropslot!);
});

/* ---------------- boot ---------------- */

/** The board key travels in the link's #fragment, so it never reaches server logs. */
function boardKey(): string | null {
  const fromHash = new URLSearchParams(location.hash.slice(1)).get("key");
  try {
    if (fromHash) localStorage.setItem("board-key", fromHash);
    else {
      const saved = localStorage.getItem("board-key");
      if (saved) history.replaceState(null, "", `#key=${encodeURIComponent(saved)}`);
      return saved;
    }
  } catch {
    /* storage blocked; the fragment still works */
  }
  return fromHash;
}

/** Written next to the page at deploy time. Missing in local development. */
async function loadConfig(): Promise<{ wsUrl: string; requiresKey: boolean }> {
  try {
    const res = await fetch("config.json", { cache: "no-store" });
    const cfg = await res.json();
    if (typeof cfg.wsUrl === "string") return { wsUrl: cfg.wsUrl, requiresKey: cfg.requiresKey === true };
  } catch {
    /* no config: local development */
  }
  return { wsUrl: `ws://${location.hostname}:8787`, requiresKey: false };
}

async function boot(): Promise<void> {
  render();
  const key = boardKey();
  const config = await loadConfig();
  missingKey = config.requiresKey && !key;
  const url = new URL(config.wsUrl);
  if (key) url.searchParams.set("key", key);

  link = new Link(url.toString(), {
    onState(state) {
      linkState = state;
      if (state === "open") everOpened = true;
      render();
    },
    onPush(msg) {
      if (msg.type === "snapshot") {
        board.snapshot(msg.sessions);
        loaded = true;
      } else if (msg.type === "upsert") {
        board.accept(msg.session);
      } else {
        board.forget(msg.id);
        if (openPicker === msg.id) openPicker = null;
      }
      render();
    },
  });
  link.connect();
}

void boot();
