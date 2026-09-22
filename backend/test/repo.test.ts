import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { buildBookings, clashes } from "@board/shared";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { DomainError, SessionRepo } from "../src/repo.ts";
import { ensureTable } from "../src/table.ts";

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
const db = DynamoDBDocumentClient.from(client);

let repo: SessionRepo;

beforeEach(async () => {
  const table = `test-${randomUUID()}`;
  await ensureTable(client, table);
  repo = new SessionRepo(db, table);
});

async function rejects(p: Promise<unknown>, code: string) {
  const err = await p.then(() => null, (e) => e);
  expect(err).toBeInstanceOf(DomainError);
  expect(err.code).toBe(code);
}

describe("SessionRepo", () => {
  it("creates idempotently and validates input", async () => {
    const a = await repo.create("a", "s1", "Retro");
    expect(a).toMatchObject({ id: "a", slot: "s1", topic: "Retro", people: [], version: 1 });
    expect((await repo.create("a", "s2")).slot).toBe("s1");
    await rejects(repo.create("b", "s9"), "invalid");
    await rejects(repo.create("bad id!", "s1"), "invalid");
    expect((await repo.setTopic("a", "x".repeat(200))).topic).toHaveLength(120);
  });

  it("adds and removes people, idempotently, in roster order", async () => {
    await repo.create("a", "s1");
    await repo.addPerson("a", "terran.jendro");
    await repo.addPerson("a", "aaron.suggs");
    const s = await repo.addPerson("a", "aaron.suggs");
    expect(s.people).toEqual(["aaron.suggs", "terran.jendro"]);
    expect((await repo.removePerson("a", "terran.jendro")).people).toEqual(["aaron.suggs"]);
    expect((await repo.removePerson("a", "aaron.suggs")).people).toEqual([]);
    expect((await repo.removePerson("a", "aaron.suggs")).people).toEqual([]);
    await rejects(repo.addPerson("a", "nobody"), "invalid");
  });

  it("bumps version on every write", async () => {
    await repo.create("a", "s1");
    const v = (await repo.setTopic("a", "x")).version;
    expect((await repo.addPerson("a", "kqiu")).version).toBe(v + 1);
    expect((await repo.move("a", "s2")).session.version).toBe(v + 2);
  });

  it("reports writes to a deleted session as not_found", async () => {
    await repo.create("a", "s1");
    await repo.delete("a");
    await repo.delete("a");
    expect(await repo.get("a")).toBeNull();
    await rejects(repo.addPerson("a", "kqiu"), "not_found");
    await rejects(repo.setTopic("a", "x"), "not_found");
    await rejects(repo.move("a", "s2"), "not_found");
  });

  it("allows a clash in storage, and the clash is detectable", async () => {
    await repo.create("a", "s1");
    await repo.create("b", "s1");
    await repo.addPerson("a", "ahmad");
    await repo.addPerson("b", "ahmad");
    const found = clashes(buildBookings(await repo.list()));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ person: "ahmad", slot: "s1" });
  });

  it("moves a session and bumps anyone already busy at the destination", async () => {
    await repo.create("a", "s1");
    await repo.create("b", "s2");
    for (const p of ["ahmad", "kqiu", "jenny.thai"]) await repo.addPerson("a", p);
    await repo.addPerson("b", "kqiu");

    const { session, bumped } = await repo.move("a", "s2");
    expect(bumped).toEqual(["kqiu"]);
    expect(session).toMatchObject({ slot: "s2", people: ["ahmad", "jenny.thai"] });
    expect(await repo.get("a")).toEqual(session);
    expect(clashes(buildBookings(await repo.list()))).toEqual([]);
  });

  it("keeps every concurrent add and remove on the same session", async () => {
    await repo.create("a", "s1");
    await repo.addPerson("a", "terran.jendro");
    const people = ["ahmad", "kqiu", "jenny.thai", "dnehring", "ryan.dontas", "emily.stupar"];
    await Promise.all([...people.map((p) => repo.addPerson("a", p)), repo.removePerson("a", "terran.jendro")]);
    expect((await repo.get("a"))!.people.sort()).toEqual([...people].sort());
  });
});
