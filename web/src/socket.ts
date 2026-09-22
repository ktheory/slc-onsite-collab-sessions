/**
 * The page's one connection to the board.
 *
 * Changes go out one at a time: API Gateway runs each WebSocket message as its
 * own Lambda invocation, so two messages sent back to back can be applied out of
 * order. Waiting for each ack keeps "add Ahmad, remove Ahmad" in that order.
 *
 * If the connection drops, changes queue up and go out after reconnecting.
 * Every operation is idempotent, so resending one that did land is harmless.
 */
import type { ClientMessage, Op, ServerMessage, Session } from "@board/shared";

export type LinkState = "connecting" | "open" | "offline";

export interface Result {
  ok: boolean;
  session: Session | null;
  bumped?: string[];
  message?: string;
}

interface Queued {
  reqId: string;
  op: Op;
  done: (r: Result) => void;
}

export interface LinkHandlers {
  onState(state: LinkState): void;
  onPush(msg: Extract<ServerMessage, { type: "snapshot" | "upsert" | "remove" }>): void;
}

const PING_MS = 4 * 60 * 1000; // API Gateway closes idle sockets after 10 minutes
const ACK_TIMEOUT_MS = 15_000;

export class Link {
  state: LinkState = "connecting";
  private ws: WebSocket | null = null;
  private queue: Queued[] = [];
  private inFlight: Queued | null = null;
  private ackTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private attempts = 0;
  private seq = 0;

  constructor(
    private readonly url: string,
    private readonly handlers: LinkHandlers,
  ) {
    window.addEventListener("online", () => this.reconnectNow());
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") this.reconnectNow();
    });
  }

  /** Number of changes not yet confirmed by the server. */
  get unsaved(): number {
    return this.queue.length + (this.inFlight ? 1 : 0);
  }

  connect(): void {
    clearTimeout(this.retryTimer);
    this.setState("connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.attempts = 0;
      this.setState("open");
      this.raw({ action: "sync" });
      clearInterval(this.pingTimer);
      this.pingTimer = setInterval(() => this.raw({ action: "ping" }), PING_MS);
      // Anything that was in flight when the last socket died goes out again first.
      if (this.inFlight) {
        this.queue.unshift(this.inFlight);
        this.inFlight = null;
      }
      this.pump();
    };

    ws.onmessage = (ev) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.type === "ack" || msg.type === "error") this.settle(msg);
      else if (msg.type !== "pong") this.handlers.onPush(msg);
    };

    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      clearInterval(this.pingTimer);
      clearTimeout(this.ackTimer);
      this.setState("offline");
      const delay = Math.min(15_000, 1000 * 2 ** this.attempts++) * (0.75 + Math.random() / 2);
      this.retryTimer = setTimeout(() => this.connect(), delay);
    };
  }

  send(op: Op): Promise<Result> {
    return new Promise((done) => {
      this.queue.push({ reqId: `r${++this.seq}`, op, done });
      this.pump();
    });
  }

  private pump(): void {
    if (this.inFlight || !this.queue.length || this.ws?.readyState !== WebSocket.OPEN) return;
    this.inFlight = this.queue.shift()!;
    this.raw({ action: "op", reqId: this.inFlight.reqId, op: this.inFlight.op });
    // An ack that never comes means the socket is dead without saying so.
    this.ackTimer = setTimeout(() => this.ws?.close(), ACK_TIMEOUT_MS);
  }

  private settle(msg: Extract<ServerMessage, { type: "ack" | "error" }>): void {
    const q = this.inFlight;
    if (!q || q.reqId !== msg.reqId) return;
    clearTimeout(this.ackTimer);
    this.inFlight = null;
    q.done(
      msg.type === "ack"
        ? { ok: true, session: msg.session, bumped: msg.bumped }
        : { ok: false, session: msg.session, message: msg.message },
    );
    this.pump();
  }

  private raw(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private reconnectNow(): void {
    if (this.state !== "offline") return;
    this.attempts = 0;
    this.connect();
  }

  private setState(state: LinkState): void {
    this.state = state;
    this.handlers.onState(state);
  }
}
