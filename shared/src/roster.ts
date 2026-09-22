/**
 * The roster and slot list are fixed for this on-site. Both the server and the
 * page import them from here, so validation and rendering can't disagree.
 */

export interface Person {
  id: string;
  name: string;
  short: string;
}

export interface Slot {
  id: string;
  day: string;
  time: string;
  cell: string;
}

export const PEOPLE: readonly Person[] = [
  { id: "aaron.suggs", name: "Aaron Suggs", short: "Aaron" },
  { id: "ahmad", name: "Ahmad", short: "Ahmad" },
  { id: "ciara.montes", name: "Ciara Montes", short: "Ciara" },
  { id: "dnehring", name: "Daniel Nehring", short: "Daniel" },
  { id: "emily.stupar", name: "Emily Stupar", short: "Emily" },
  { id: "jackson.howe", name: "Jackson Howe", short: "Jackson" },
  { id: "jenny.thai", name: "Jenny Thai", short: "Jenny" },
  { id: "kqiu", name: "Kevin Qiu", short: "Kevin" },
  { id: "kyle.cayemittes", name: "Kyle Cayemittes", short: "Kyle" },
  { id: "michelle.trame", name: "Michelle Trame", short: "Michelle" },
  { id: "ryan.dontas", name: "Ryan Dontas", short: "Ryan" },
  { id: "terran.jendro", name: "Terran Jendro", short: "Terran" },
];

export const SLOTS: readonly Slot[] = [
  { id: "s1", day: "Tuesday", time: "2:15 PM", cell: "Tue 2:15" },
  { id: "s2", day: "Wednesday", time: "9:45 AM", cell: "Wed 9:45" },
  { id: "s3", day: "Wednesday", time: "2:00 PM", cell: "Wed 2:00" },
  { id: "s4", day: "Wednesday", time: "3:30 PM", cell: "Wed 3:30" },
  { id: "s5", day: "Thursday", time: "1:00 PM", cell: "Thu 1:00" },
];

export const PERSON: Readonly<Record<string, Person>> = Object.fromEntries(PEOPLE.map((p) => [p.id, p]));
export const SLOT: Readonly<Record<string, Slot>> = Object.fromEntries(SLOTS.map((s) => [s.id, s]));

const personOrder = new Map(PEOPLE.map((p, i) => [p.id, i]));
const slotOrder = new Map(SLOTS.map((s, i) => [s.id, i]));

/** Roster order, so chips read the same on every card. */
export function sortPeople(ids: readonly string[]): string[] {
  return [...ids].sort((a, b) => (personOrder.get(a) ?? 99) - (personOrder.get(b) ?? 99));
}

export function slotIndex(slotId: string): number {
  return slotOrder.get(slotId) ?? 99;
}

export const TOPIC_MAX = 120;
