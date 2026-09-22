/** Open WebSocket connections, so a change can be pushed to every viewer. */
import { DeleteCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";

export interface Connections {
  add(id: string): Promise<void>;
  remove(id: string): Promise<void>;
  all(): Promise<string[]>;
}

const CONNS = "CONNS";
/** API Gateway drops a WebSocket after two hours; expire the record a bit after that. */
const TTL_SECONDS = 3 * 60 * 60;

export class DynamoConnections implements Connections {
  constructor(
    private readonly db: DynamoDBDocumentClient,
    private readonly table: string,
  ) {}

  async add(id: string): Promise<void> {
    const ttl = Math.floor(Date.now() / 1000) + TTL_SECONDS;
    await this.db.send(new PutCommand({ TableName: this.table, Item: { pk: CONNS, sk: id, ttl } }));
  }

  async remove(id: string): Promise<void> {
    await this.db.send(new DeleteCommand({ TableName: this.table, Key: { pk: CONNS, sk: id } }));
  }

  async all(): Promise<string[]> {
    const ids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const res = await this.db.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: "pk = :pk",
          ExpressionAttributeValues: { ":pk": CONNS },
          ProjectionExpression: "sk",
          ExclusiveStartKey: start,
        }),
      );
      for (const item of res.Items ?? []) ids.push(item.sk as string);
      start = res.LastEvaluatedKey;
    } while (start);
    return ids;
  }
}
