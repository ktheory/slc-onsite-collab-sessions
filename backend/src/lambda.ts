/** API Gateway WebSocket entry point: $connect, $disconnect and $default. */
import { ApiGatewayManagementApiClient, GoneException, PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyResult, APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import { DynamoConnections } from "./connections.ts";
import { handleMessage, type Deps } from "./handler.ts";
import { SessionRepo } from "./repo.ts";

const TABLE = process.env.TABLE_NAME!;

const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const repo = new SessionRepo(db, TABLE);
const connections = new DynamoConnections(db, TABLE);
const managers = new Map<string, ApiGatewayManagementApiClient>();

export async function handler(event: APIGatewayProxyWebsocketEventV2): Promise<APIGatewayProxyResult> {
  const { routeKey, connectionId, domainName, stage } = event.requestContext;

  if (routeKey === "$connect") {
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
