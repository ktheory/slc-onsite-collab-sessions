/** Print the shareable board link: the site URL with the access key in its #fragment. */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";

const res = await new CloudFormationClient({}).send(new DescribeStacksCommand({ StackName: "BreakoutBoard" }));
const outputs = Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
const secret = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: outputs.BoardKeySecretArn }));
console.log(`${outputs.SiteUrl}/#key=${encodeURIComponent(secret.SecretString!)}`);
