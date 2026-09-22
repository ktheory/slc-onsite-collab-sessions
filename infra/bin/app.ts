import { App } from "aws-cdk-lib";
import { BoardStack } from "../lib/board-stack.ts";

const app = new App();
new BoardStack(app, "BreakoutBoard", {
  env: { account: process.env.CDK_DEFAULT_ACCOUNT, region: process.env.CDK_DEFAULT_REGION },
});
