import type { Session } from "@board/shared";
import { describe, expect, it } from "vitest";
import { Board } from "./store.ts";

const s = (id: string, version: number, patch: Partial<Session> = {}): Session => ({
  id,
  topic: "",
  slot: "s1",
  people: [],
  createdAt: "2026-09-21T00:00:00Z",
  updatedAt: "2026-09-21T00:00:00Z",
  version,
  ...patch,
});

describe("Board", () => {
  it("ignores pushes older than what it holds", () => {
    const b = new Board();
    b.snapshot([s("a", 3, { topic: "new" })]);
    b.accept(s("a", 2, { topic: "old" }));
    expect(b.get("a")!.topic).toBe("new");
  });

  it("holds a local edit through echoes until it settles", () => {
    const b = new Board();
    b.snapshot([s("a", 1)]);
    b.edit(s("a", 1, { people: ["ahmad"] }));
    b.edit(s("a", 1, { people: ["ahmad", "kqiu"] }));
    b.settle("a", s("a", 2, { people: ["ahmad"] })); // first ack arrives
    expect(b.get("a")!.people).toEqual(["ahmad", "kqiu"]);
    b.settle("a", s("a", 3, { people: ["ahmad", "kqiu"] }));
    expect(b.get("a")!.version).toBe(3);
  });

  it("snaps back to the server copy when an edit fails", () => {
    const b = new Board();
    b.snapshot([s("a", 1, { topic: "server" })]);
    b.edit(s("a", 1, { topic: "mine" }));
    b.settle("a", s("a", 1, { topic: "server" }));
    expect(b.get("a")!.topic).toBe("server");
  });

  it("does not resurrect a deleted session from a late push", () => {
    const b = new Board();
    b.snapshot([s("a", 1)]);
    b.forget("a");
    b.accept(s("a", 2));
    expect(b.get("a")).toBeUndefined();
  });

  it("restores a session whose delete failed", () => {
    const b = new Board();
    b.snapshot([s("a", 1)]);
    b.remove("a");
    expect(b.get("a")).toBeUndefined();
    b.settle("a", s("a", 1));
    expect(b.get("a")).toBeDefined();
  });

  it("keeps unsaved local sessions across a reconnect snapshot", () => {
    const b = new Board();
    b.snapshot([s("a", 1)]);
    b.edit(s("new", 0));
    b.snapshot([s("b", 1)]);
    expect(b.all().map((x) => x.id)).toEqual(["b", "new"].sort((x, y) => (x < y ? -1 : 1)));
  });
});
