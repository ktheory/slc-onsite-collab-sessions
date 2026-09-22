/**
 * Client copy of the board.
 *
 * Two layers: `server` is the latest version the server has confirmed, and
 * `shown` is what the page renders. Local edits change `shown` at once. While a
 * session has edits in flight, pushes from other editors update `server` but
 * leave `shown` alone, so an echo of an older write can't flicker the card back.
 * When the last in-flight edit settles, `shown` snaps to the server's copy.
 */
import { slotIndex, type Session } from "@board/shared";

export class Board {
  private server = new Map<string, Session>();
  private shown = new Map<string, Session>();
  private pending = new Map<string, number>();
  /** Deleted ids, so a late push from before the delete can't resurrect a card. */
  private deleted = new Set<string>();

  get(id: string): Session | undefined {
    return this.shown.get(id);
  }

  /** Sessions in slot order, then creation order. */
  all(): Session[] {
    return [...this.shown.values()].sort(
      (a, b) =>
        slotIndex(a.slot) - slotIndex(b.slot) ||
        (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0) ||
        (a.id < b.id ? -1 : 1),
    );
  }

  inSlot(slot: string): Session[] {
    return this.all().filter((s) => s.slot === slot);
  }

  /* ---------------- local edits ---------------- */

  /** Apply a local change now and mark the session as having an edit in flight. */
  edit(session: Session): void {
    this.shown.set(session.id, session);
    this.pending.set(session.id, (this.pending.get(session.id) ?? 0) + 1);
  }

  remove(id: string): void {
    this.shown.delete(id);
    this.deleted.add(id);
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1);
  }

  /** An in-flight edit finished, successfully or not. `truth` is the server's copy, or null if it's gone. */
  settle(id: string, truth: Session | null): void {
    const left = (this.pending.get(id) ?? 1) - 1;
    if (left > 0) this.pending.set(id, left);
    else this.pending.delete(id);
    if (truth) {
      this.deleted.delete(id); // a failed delete hands back the live session
      this.accept(truth);
    } else {
      this.forget(id);
    }
    if (left <= 0) this.reveal(id);
  }

  /* ---------------- server pushes ---------------- */

  /** A newer copy of a session from the server. */
  accept(s: Session): void {
    if (this.deleted.has(s.id)) return;
    const have = this.server.get(s.id);
    if (have && have.version > s.version) return;
    this.server.set(s.id, s);
    if (!this.pending.has(s.id)) this.shown.set(s.id, s);
  }

  forget(id: string): void {
    this.deleted.add(id);
    this.server.delete(id);
    if (!this.pending.has(id)) this.shown.delete(id);
  }

  /** The full board, on connect or reconnect. Sessions with edits in flight keep their local copy. */
  snapshot(list: Session[]): void {
    this.server = new Map(list.map((s) => [s.id, s]));
    this.deleted.clear();
    for (const id of [...this.shown.keys()]) if (!this.pending.has(id)) this.shown.delete(id);
    for (const s of list) if (!this.pending.has(s.id)) this.shown.set(s.id, s);
  }

  private reveal(id: string): void {
    const s = this.server.get(id);
    if (s && !this.deleted.has(id)) this.shown.set(id, s);
    else this.shown.delete(id);
  }
}
