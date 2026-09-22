/** API Gateway WebSocket entry point: $connect, $disconnect and $default. */
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { timingSafeEqual } from "node:crypto";
import { DynamoConnections } from "./connections.ts";
import { handleMessage, type Deps } from "./handler.ts";
import { SessionRepo } from "./repo.ts";

const TABLE = process.env.TABLE_NAME!;
const SECRET_ARN = process.env.BOARD_KEY_SECRET_ARN;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new SessionRepo(db, TABLE);
const connections = new DynamoConnections(db, TABLE);
const managers = new Map<string, ApiGatewayManagementApiClient>();

let boardKey: Promise<string | null> | undefined;
function getBoardKey(): Promise<string | null> {
  if (!SECRET_ARN) return Promise.resolve(null);
  boardKey ??= new SecretsManagerClient({})
    .send(new GetSecretValueCommand({ SecretId: SECRET_ARN }))
    .then((r) => r.SecretString ?? null)
    .catch((err) => {
      boardKey = undefined;
      throw err;
    });
  return boardKey;
}

function keyMatches(given: string | undefined, expected: string): boolean {
  if (!given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// $connect events carry query parameters, which the WebSocket event type omits.
type Event = APIGatewayProxyWebsocketEventV2 & { queryStringParameters?: Record<string, string | undefined> };

export async function handler(event: Event): Promise<APIGatewayProxyResult> {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;

  if (routeKey === "$connect") {
    const expected = await getBoardKey();
    if (expected && !keyMatches(event.queryStringParameters?.key, expected)) {
      return { statusCode: 401, body: "Missing or wrong board key." };
    }
    await connections.add(connectionId);
    return { statusCode: 200, body: "" };
  }

  if (routeKey === "$disconnect") {
    await connections.remove(connectionId);
    return { statusCode: 200, body: "" };
  }

  const endpoint = `https://${domainName}/${stage}`;
  let manager = managers.get(endpoint);
  if (!manager) managers.set(endpoint, (manager = new ApiGatewayManagementApiClient({ endpoint })));

  const deps: Deps = {
    repo,
    connections,
    send: async (id, msg) => {
      try {
        await manager.send(new PostToConnectionCommand({ ConnectionId: id, Data: JSON.stringify(msg) }));
        return true;
      } catch (err) {
        if (err instanceof GoneException) return false;
        throw err;
      }
    },
    log: (msg, err) => console.error(msg, err),
  };
  await handleMessage(deps, connectionId, event.body ?? "");
  return { statusCode: 200, body: "" };
}
