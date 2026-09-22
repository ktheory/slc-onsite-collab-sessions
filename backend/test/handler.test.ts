import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { ServerMessage } from "@board/shared";
import { randomUUID } from "node:crypto";
import { beforeEach, expect, it } from "vitest";
import type { Connections } from "../src/connections.ts";
import { handleMessage, type Deps } from "../src/handler.ts";
import { SessionRepo } from "../src/repo.ts";
import { ensureTable } from "../src/table.ts";

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});

let deps: Deps;
let open: Set<string>;
let inbox: Record<string, ServerMessage[]>;

beforeEach(async () => {
  const table = `test-${randomUUID()}`;
  await ensureTable(client, table);
  open = new Set(["me", "you", "gone"]);
  inbox = {};
  const connections: Connections = {
    add: async (id) => void open.add(id),
    remove: async (id) => void open.delete(id),
    all: async () => [...open],
  };
  deps = {
    repo: new SessionRepo(DynamoDBDocumentClient.from(client), table),
    connections,
    send: async (id, msg) => {
      if (id === "gone") return false;
      (inbox[id] ??= []).push(msg);
      return true;
    },
  };
});

const op = (reqId: string, o: object) => JSON.stringify({ action: "op", reqId, op: o });

it("acks the sender, pushes to everyone else, and drops dead connections", async () => {
  await handleMessage(deps, "me", op("1", { type: "create", id: "a", slot: "s1" }));
  expect(inbox.me).toEqual([expect.objectContaining({ type: "ack", reqId: "1", session: expect.objectContaining({ id: "a" }) })]);
  expect(inbox.you).toEqual([expect.objectContaining({ type: "upsert", session: expect.objectContaining({ id: "a" }) })]);
  expect(open.has("gone")).toBe(false);

  await handleMessage(deps, "you", op("2", { type: "delete", id: "a" }));
  expect(inbox.me.at(-1)).toEqual({ type: "remove", id: "a" });
});

it("returns the current session with an error, and pushes nothing", async () => {
  await handleMessage(deps, "me", op("1", { type: "create", id: "a", slot: "s1" }));
  inbox = {};
  await handleMessage(deps, "me", op("2", { type: "addPerson", id: "a", person: "nobody" }));
  expect(inbox.me).toEqual([expect.objectContaining({ type: "error", reqId: "2", code: "invalid", session: expect.objectContaining({ id: "a" }) })]);
  expect(inbox.you).toBeUndefined();
});

it("reports who was bumped by a move", async () => {
  for (const [id, slot] of [["a", "s1"], ["b", "s2"]]) await handleMessage(deps, "me", op(id, { type: "create", id, slot }));
  await handleMessage(deps, "me", op("3", { type: "addPerson", id: "a", person: "kqiu" }));
  await handleMessage(deps, "me", op("4", { type: "addPerson", id: "b", person: "kqiu" }));
  await handleMessage(deps, "me", op("5", { type: "move", id: "a", slot: "s2" }));
  expect(inbox.me.at(-1)).toMatchObject({ type: "ack", reqId: "5", bumped: ["kqiu"] });
});

it("answers sync with a snapshot and ignores junk", async () => {
  await handleMessage(deps, "me", "not json");
  await handleMessage(deps, "me", JSON.stringify({ action: "sync" }));
  expect(inbox.me).toEqual([{ type: "snapshot", sessions: [] }]);
});
