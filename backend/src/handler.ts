/**
 * Transport-agnostic message handling. The Lambda and the local dev server both
 * feed messages in here and supply a way to send to a connection.
 */
import type { ClientMessage, ServerMessage, Session } from "@board/shared";
import type { Connections } from "./connections.ts";
import { DomainError, type SessionRepo } from "./repo.ts";

/** Send to one connection. Resolves false if the connection is gone. */
export type Send = (connectionId: string, msg: ServerMessage) => Promise<boolean>;

export interface Deps {
  repo: SessionRepo;
  connections: Connections;
  send: Send;
  log?: (msg: string, err?: unknown) => void;
}

export async function handleMessage(deps: Deps, connectionId: string, raw: string): Promise<void> {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }

  if (msg.action === "ping") {
    await deps.send(connectionId, { type: "pong" });
  } else if (msg.action === "sync") {
    await deps.send(connectionId, { type: "snapshot", sessions: await deps.repo.list() });
  } else if (msg.action === "op" && msg.op && typeof msg.reqId === "string") {
    await handleOp(deps, connectionId, msg.reqId, msg.op);
  }
}

async function handleOp(
  deps: Deps,
  connectionId: string,
  reqId: string,
  op: Extract<ClientMessage, { action: "op" }>["op"],
): Promise<void> {
  const { repo } = deps;
  let session: Session | null = null;
  let bumped: string[] | undefined;
  try {
    switch (op.type) {
      case "create":
        session = await repo.create(op.id, op.slot, op.topic);
        break;
      case "setTopic":
        session = await repo.setTopic(op.id, op.topic);
        break;
      case "addPerson":
        session = await repo.addPerson(op.id, op.person);
        break;
      case "removePerson":
        session = await repo.removePerson(op.id, op.person);
        break;
      case "move":
        ({ session, bumped } = await repo.move(op.id, op.slot));
        break;
      case "delete":
        await repo.delete(op.id);
        break;
      default:
        throw new DomainError("invalid", "Unknown change.");
    }
  } catch (err) {
    const known = err instanceof DomainError;
    if (!known) deps.log?.("op failed", err);
    // Send back the current truth so the page can undo its optimistic change.
    const current = typeof op.id === "string" ? await repo.get(op.id).catch(() => null) : null;
    await deps.send(connectionId, {
      type: "error",
      reqId,
      code: known ? err.code : "internal",
      message: known ? err.message : "That change didn't save. Try again.",
      session: current,
    });
    return;
  }

  await deps.send(connectionId, { type: "ack", reqId, session, bumped });
  await broadcast(
    deps,
    session ? { type: "upsert", session } : { type: "remove", id: op.id },
    connectionId,
  );
}

async function broadcast(deps: Deps, msg: ServerMessage, except: string): Promise<void> {
  const ids = (await deps.connections.all()).filter((id) => id !== except);
  await Promise.all(
    ids.map(async (id) => {
      try {
        if (!(await deps.send(id, msg))) await deps.connections.remove(id);
      } catch (err) {
        deps.log?.(`push to ${id} failed`, err);
      }
    }),
  );
}
