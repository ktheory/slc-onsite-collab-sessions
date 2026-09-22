import { App } from "aws-cdk-lib";
import { BoardStack } from "../lib/board-stack.ts";
import { REGION, STACK_NAME } from "../lib/config.ts";

const app = new App();
new BoardStack(app, STACK_NAME, {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION },
});
