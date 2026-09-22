/**
 * Session storage.
 *
 * "One session per person per slot" is a soft rule: the table allows a clash and
 * the page flags it. The server still helps keep it — a move bumps anyone already
 * busy at the destination — but a race between two editors can produce a clash,
 * and that's fine.
 *
 * Items, all in one table:
 *   pk=SESSIONS  sk=<sessionId>     the session; `people` is a string set
 *   pk=CONNS     sk=<connectionId>  an open WebSocket (see connections.ts)
 *
 * `people` is a DynamoDB string set so adding and removing are single atomic
 * ADD/DELETE updates: two people editing the same card never lose each other's
 * changes. Sessions live in one partition, which keeps the full-board read a
 * strongly consistent query and is far below any partition limit at this size.
 */
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { PERSON, SLOT, TOPIC_MAX, sortPeople, type ErrorCode, type Session } from "@board/shared";

export class DomainError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const SESSIONS = "SESSIONS";
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const sessionKey = (id: string) => ({ pk: SESSIONS, sk: id });

function toSession(item: Record<string, unknown>): Session {
  const people = item.people instanceof Set ? [...(item.people as Set<string>)] : [];
  return {
    id: item.sk as string,
    topic: (item.topic as string) ?? "",
    slot: item.slot as string,
    people: sortPeople(people.filter((p) => PERSON[p])),
    createdAt: item.createdAt as string,
    updatedAt: item.updatedAt as string,
    version: item.version as number,
  };
}

function checkId(id: unknown): asserts id is string {
  if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new DomainError("invalid", "Bad session id.");
}
function checkSlot(slot: unknown): asserts slot is string {
  if (typeof slot !== "string" || !SLOT[slot]) throw new DomainError("invalid", "Unknown slot.");
}
function checkPerson(person: unknown): asserts person is string {
  if (typeof person !== "string" || !PERSON[person]) throw new DomainError("invalid", "Unknown person.");
}
function cleanTopic(topic: unknown): string {
  if (topic == null) return "";
  if (typeof topic !== "string") throw new DomainError("invalid", "Topic must be text.");
  return topic.slice(0, TOPIC_MAX);
}

const isConditionFailure = (err: unknown) => err instanceof Error && err.name === "ConditionalCheckFailedException";

export class SessionRepo {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async list(): Promise<Session[]> {
    const out: Session[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": SESSIONS },
          ConsistentRead: true,
          ExclusiveStartKey: start,
        }),
      );
      for (const item of res.Items ?? []) out.push(toSession(item));
      start = res.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async get(id: string): Promise<Session | null> {
    const res = await this.db.send(new GetCommand({ TableName: this.table, Key: sessionKey(id), ConsistentRead: true }));
    return res.Item ? toSession(res.Item) : null;
  }

  /** Creating twice with the same id is a no-op, so a retried request is harmless. */
  async create(id: unknown, slot: unknown, topic?: unknown): Promise<Session> {
    checkId(id);
    checkSlot(slot);
    const now = this.now();
    const item = { ...sessionKey(id), topic: cleanTopic(topic), slot, createdAt: now, updatedAt: now, version: 1 };
    try {
      await this.db.send(new PutCommand({ TableName: this.table, Item: item, ConditionExpression: "attribute_not_exists(pk)" }));
      return toSession(item);
    } catch (err) {
      if (!isConditionFailure(err)) throw err;
      const existing = await this.get(id);
      if (!existing) throw new DomainError("not_found", "That session was deleted.");
      return existing;
    }
  }

  async setTopic(id: unknown, topic: unknown): Promise<Session> {
    checkId(id);
    return this.update(id, { set: ["topic = :t"] }, { ":t": cleanTopic(topic) });
  }

  async addPerson(id: unknown, person: unknown): Promise<Session> {
    checkId(id);
    checkPerson(person);
    return this.update(id, { add: ["people :p"] }, { ":p": new Set([person]) });
  }

  async removePerson(id: unknown, person: unknown): Promise<Session> {
    checkId(id);
    checkPerson(person);
    return this.update(id, { remove: ["people :p"] }, { ":p": new Set([person]) });
  }

  /**
   * Move a session to another slot. Anyone already booked at the destination
   * comes off the session, and the caller hears who. The move itself never fails
   * for a clash.
   */
  async move(id: unknown, slot: unknown): Promise<{ session: Session; bumped: string[] }> {
    checkId(id);
    checkSlot(slot);
    const [s, all] = await Promise.all([this.get(id), this.list()]);
    if (!s) throw new DomainError("not_found", "That session was deleted.");
    if (s.slot === slot) return { session: s, bumped: [] };

    const busy = new Set(all.filter((o) => o.slot === slot && o.id !== id).flatMap((o) => o.people));
    const bumped = s.people.filter((p) => busy.has(p));
    const session = bumped.length
      ? await this.update(id, { set: ["slot = :slot"], remove: ["people :bumped"] }, { ":slot": slot, ":bumped": new Set(bumped) })
      : await this.update(id, { set: ["slot = :slot"] }, { ":slot": slot });
    return { session, bumped };
  }

  async delete(id: unknown): Promise<void> {
    checkId(id);
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: sessionKey(id) }));
  }

  /** Apply an update to an existing session, stamping updatedAt and bumping version. */
  private async update(id: string, clauses: Clauses, values: Record<string, unknown>): Promise<Session> {
    const set = ["updatedAt = :now", ...(clauses.set ?? [])];
    const add = ["version :one", ...(clauses.add ?? [])];
    let expression = `SET ${set.join(", ")} ADD ${add.join(", ")}`;
    if (clauses.remove?.length) expression += ` DELETE ${clauses.remove.join(", ")}`;
    try {
      const res = await this.db.send(
        new UpdateCommand({
          TableName: this.table,
          Key: sessionKey(id),
          UpdateExpression: expression,
          ConditionExpression: "attribute_exists(pk)",
          ExpressionAttributeValues: { ...values, ":now": this.now(), ":one": 1 },
          ReturnValues: "ALL_NEW",
        }),
      );
      return toSession(res.Attributes!);
    } catch (err) {
      if (isConditionFailure(err)) throw new DomainError("not_found", "That session was deleted.");
      throw err;
    }
  }
}

interface Clauses {
  set?: string[];
  add?: string[];
  remove?: string[];
}
