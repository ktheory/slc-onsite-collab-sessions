/** Table shape, shared by the CDK stack's intent and the local dev/test setup. */
import { CreateTableCommand, DescribeTableCommand, type DynamoDBClient } from "@aws-sdk/client-dynamodb";

export async function ensureTable(client: DynamoDBClient, table: string): Promise<void> {
  try {
    await client.send(new DescribeTableCommand({ TableName: table }));
    return;
  } catch (err) {
    if (!(err instanceof Error) || err.name !== "ResourceNotFoundException") throw err;
  }
  await client.send(
    new CreateTableCommand({
      TableName: table,
      BillingMode: "PAY_PER_REQUEST",
      AttributeDefinitions: [
        { AttributeName: "pk", AttributeType: "S" },
        { AttributeName: "sk", AttributeType: "S" },
      ],
      KeySchema: [
        { AttributeName: "pk", KeyType: "HASH" },
        { AttributeName: "sk", KeyType: "RANGE" },
      ],
    }),
  );
}
