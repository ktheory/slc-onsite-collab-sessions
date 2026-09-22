import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, Token, type StackProps } from "aws-cdk-lib";
import * as acm from "aws-cdk-lib/aws-certificatemanager";
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
import type { Construct } from "constructs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

export interface BoardStackProps extends StackProps {
  /**
   * Custom domain for the page, e.g. slc.sug.gs. DNS lives outside AWS: point a
   * CNAME at the `CloudFrontDomain` output.
   */
  domainName?: string;
  /** ACM certificate for `domainName`. CloudFront only accepts certificates in us-east-1. */
  certificateArn?: string;
}

/**
 * The breakout board: a static page on CloudFront, a WebSocket API that pushes
 * every change to every open page, and one DynamoDB table behind it.
 *
 * There is no access control: anyone who can load the page can edit the board.
 */
export class BoardStack extends Stack {
  constructor(scope: Construct, id: string, props: BoardStackProps = {}) {
    super(scope, id, props);
    const domain = this.customDomain(props);

    // Sessions and open connections. Kept on stack deletion: the schedule is the point.
    const table = new dynamodb.TableV2(this, "Table", {
      partitionKey: { name: "pk", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "sk", type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      timeToLiveAttribute: "ttl",
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      removalPolicy: RemovalPolicy.RETAIN,
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
      },
      bundling: { minify: true, sourceMap: true, target: "node22" },
    });
    table.grantReadWriteData(fn);

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
      ...(domain && {
        domainNames: [domain.name],
        certificate: acm.Certificate.fromCertificateArn(this, "Certificate", domain.certificateArn),
      }),
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
        Source.jsonData("config.json", { wsUrl: stage.url }),
      ],
    });

    new CfnOutput(this, "SiteUrl", { value: `https://${domain?.name ?? cdn.distributionDomainName}` });
    new CfnOutput(this, "CloudFrontDomain", {
      value: cdn.distributionDomainName,
      description: "CNAME target for the custom domain",
    });
    new CfnOutput(this, "SocketUrl", { value: stage.url });
    new CfnOutput(this, "TableName", { value: table.tableName });
  }

  /** The custom domain, if one is configured and has a usable certificate. */
  private customDomain(props: BoardStackProps): { name: string; certificateArn: string } | undefined {
    const { domainName: name, certificateArn } = props;
    if (!name) return undefined;
    if (!certificateArn) {
      Annotations.of(this).addWarning(
        `No certificateArn for ${name}, so the board is only at its CloudFront URL. ` +
          "Request a certificate in ACM in us-east-1 and set certificateArn in infra/cdk.json.",
      );
      return undefined;
    }
    if (!Token.isUnresolved(certificateArn) && certificateArn.split(":")[3] !== "us-east-1") {
      throw new Error(`CloudFront needs its certificate in us-east-1; ${certificateArn} is not.`);
    }
    return { name, certificateArn };
  }
}
