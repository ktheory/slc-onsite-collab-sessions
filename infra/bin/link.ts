/** Print the shareable board link: the site URL with the access key in its #fragment. */
import { CloudFormationClient, DescribeStacksCommand } from "@aws-sdk/client-cloudformation";
import { GetSecretValueCommand, SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { REGION, STACK_NAME } from "../lib/config.ts";

const res = await new CloudFormationClient({ region: REGION }).send(new DescribeStacksCommand({ StackName: STACK_NAME }));
const outputs = Object.fromEntries((res.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
const secret = await new SecretsManagerClient({ region: REGION }).send(new GetSecretValueCommand({ SecretId: outputs.BoardKeySecretArn }));
console.log(`${outputs.SiteUrl}/#key=${encodeURIComponent(secret.SecretString!)}`);
