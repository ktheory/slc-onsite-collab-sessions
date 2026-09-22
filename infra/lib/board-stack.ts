import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { WebSocketApi, WebSocketStage } from "aws-cdk-lib/aws-apigatewayv2";
import { WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import { Architecture, Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * The breakout board: a static page on CloudFront, a WebSocket API that pushes
 * every change to every open page, and one DynamoDB table behind it.
 */
export class BoardStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // Sessions and open connections. Kept on stack deletion: the schedule is the point.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Anyone with the link can edit; the link carries this key. Stands in for the
    // artifact sharing the prototype relied on.
    const boardKey = new secretsmanager.Secret(this, "BoardKey", {
      description: "Access key embedded in the breakout board link",
      generateSecretString: { passwordLength: 32, excludePunctuation: true },
    });

    const fn = new NodejsFunction(this, "Socket", {
      entry: path.join(root, "backend/src/lambda.ts"),
      projectRoot: root,
      depsLockFilePath: path.join(root, "package-lock.json"),
      runtime: Runtime.NODEJS_22_X,
      architecture: Architecture.ARM_64,
      memorySize: 512,
      timeout: Duration.seconds(10),
      logGroup: new LogGroup(this, "SocketLogs", { retention: RetentionDays.ONE_MONTH, removalPolicy: RemovalPolicy.DESTROY }),
      environment: {
        TABLE_NAME: table.tableName,
        BOARD_KEY_SECRET_ARN: boardKey.secretArn,
      },
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });
    table.grantReadWriteData(fn);
    boardKey.grantRead(fn);

    const integration = (name: string) => ({ integration: new WebSocketLambdaIntegration(`${name}Integration`, fn) });
    const api = new WebSocketApi(this, "Api", {
      connectRouteOptions: integration("Connect"),
      disconnectRouteOptions: integration("Disconnect"),
      defaultRouteOptions: integration("Default"),
    });
    const stage = new WebSocketStage(this, "Live", {
      webSocketApi: api,
      stageName: "live",
      autoDeploy: true,
      throttle: { rateLimit: 50, burstLimit: 100 },
    });
    api.grantManageConnections(fn);

    const site = new s3.Bucket(this, "Site", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const cdn = new cloudfront.Distribution(this, "Cdn", {
      defaultRootObject: "index.html",
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(site),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
    });
    new BucketDeployment(this, "Deploy", {
      destinationBucket: site,
      distribution: cdn,
      sources: [
        Source.asset(path.join(root, "web/dist")),
        Source.jsonData("config.json", { wsUrl: stage.url, requiresKey: true }),
      ],
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${cdn.distributionDomainName}` });
    new CfnOutput(this, "SocketUrl", { value: stage.url });
    new CfnOutput(this, "BoardKeySecretArn", { value: boardKey.secretArn });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }
}
