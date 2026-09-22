import { PERSON } from "./roster.ts";
import type { Session } from "./protocol.ts";

/** person id -> slot id -> sessions they're in during that slot. */
export type Bookings = Record<string, Record<string, Session[]>>;

export function buildBookings(sessions: readonly Session[]): Bookings {
  const map: Bookings = {};
  for (const s of sessions) {
    for (const pid of s.people) {
      if (!PERSON[pid]) continue;
      ((map[pid] ??= {})[s.slot] ??= []).push(s);
    }
  }
  return map;
}

/**
 * People in more than one session in the same slot. The rule is soft, so the
 * database allows this; the page flags it for a human to sort out.
 */
export function clashes(bookings: Bookings): { person: string; slot: string; sessions: Session[] }[] {
  const out: { person: string; slot: string; sessions: Session[] }[] = [];
  for (const [person, slots] of Object.entries(bookings)) {
    for (const [slot, list] of Object.entries(slots)) {
      if (list.length > 1) out.push({ person, slot, sessions: list });
    }
  }
  return out;
}
