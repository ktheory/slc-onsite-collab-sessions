/**
 * Local stand-in for API Gateway + Lambda: a plain WebSocket server running the
 * same handler against DynamoDB Local. `npm run dev:db` starts the database.
 */
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Connections } from "./connections.ts";
import { handleMessage, type Deps } from "./handler.ts";
import { SessionRepo } from "./repo.ts";
import { ensureTable } from "./table.ts";

const PORT = Number(process.env.PORT ?? 8787);
const TABLE = process.env.TABLE_NAME ?? "breakout-board-dev";

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT ?? "http://localhost:8000",
  region: "local",
  credentials: { accessKeyId: "local", secretAccessKey: "local" },
});
await ensureTable(client, TABLE);

const sockets = new Map<string, WebSocket>();
const connections: Connections = {
  add: async (id) => void id,
  remove: async (id) => void sockets.delete(id),
  all: async () => [...sockets.keys()],
};
const deps: Deps = {
  repo: new SessionRepo(DynamoDBDocumentClient.from(client), TABLE),
  connections,
  send: async (id, msg) => {
    const ws = sockets.get(id);
    if (!ws || ws.readyState !== ws.OPEN) return false;
    ws.send(JSON.stringify(msg));
    return true;
  },
  log: (msg, err) => console.error(msg, err),
};

const wss = new WebSocketServer({ port: PORT });
wss.on("connection", (ws) => {
  const id = randomUUID();
  sockets.set(id, ws);
  ws.on("message", (data) => void handleMessage(deps, id, data.toString()).catch((e) => console.error(e)));
  ws.on("close", () => sockets.delete(id));
});
console.log(`board dev server on ws://localhost:${PORT} (table ${TABLE})`);
