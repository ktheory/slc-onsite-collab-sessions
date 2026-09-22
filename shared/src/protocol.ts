/** Wire format between the page and the WebSocket API. */

export interface Session {
  id: string;
  topic: string;
  slot: string;
  people: string[];
  createdAt: string;
  updatedAt: string;
  /** Bumped on every write. Clients drop anything older than what they hold. */
  version: number;
}

export type Op =
  | { type: "create"; id: string; slot: string; topic?: string }
  | { type: "setTopic"; id: string; topic: string }
  | { type: "addPerson"; id: string; person: string }
  | { type: "removePerson"; id: string; person: string }
  | { type: "move"; id: string; slot: string }
  | { type: "delete"; id: string };

export type ClientMessage =
  | { action: "sync" }
  | { action: "ping" }
  | { action: "op"; reqId: string; op: Op };

export type ErrorCode = "busy" | "not_found" | "invalid" | "conflict" | "internal";

export type ServerMessage =
  | { type: "snapshot"; sessions: Session[] }
  | { type: "upsert"; session: Session }
  | { type: "remove"; id: string }
  | { type: "ack"; reqId: string; session: Session | null; bumped?: string[] }
  | { type: "error"; reqId: string; code: ErrorCode; message: string; session: Session | null }
  | { type: "pong" };
