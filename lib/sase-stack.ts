import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications';
import { Construct } from 'constructs';
import * as path from 'path';

export class SaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * @description AWS ベストプラクティスに沿ったVPCを作成します。
     */
    const vpc = new ec2.Vpc(this, 'SaseVpc', {
      maxAzs: 2,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      flowLogs: {
        's3-flow-logs': {
          destination: ec2.FlowLogDestination.toS3(new s3.Bucket(this, 'VpcFlowLogBucket', {
            bucketName: `sase-vpc-flow-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN,
            autoDeleteObjects: false,
          })),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'PrivateWithEgressSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
      ],
    });

    /**
     * @description Lambda関数用のセキュリティグループを設定します。
     * - `allowAllOutbound`: 現状は全てのアウトバウンドを許可していますが、ベストプラクティスとしては、
     *   必要最低限のIPアドレスやポート(例えば、CognitoやWAFへの通信)のみに制限することが推奨されます。
     */
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Lambda関数に適用されるセキュリティグループ',
      allowAllOutbound: false, // 最小特権の原則に従い、明示的にアウトバウンドルールを定義
    });

    /**
     * @description クライアント認証のためのCognitoユーザープールを設定します。
     */
    const userPool = new cognito.UserPool(this, 'SaseUserPool', {
      userPoolName: 'sase-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7),
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * @description Cognitoユーザープールクライアントを設定します。
     */
    const userPoolClient = new cognito.UserPoolClient(this, 'SaseUserPoolClient', {
      userPool,
      userPoolClientName: 'sase-client',
      generateSecret: false,
      authFlows: {
        adminUserPassword: true,
        custom: true,
        userPassword: true,
        userSrp: true,
      },
    });

    /**
     * @description Cognitoユーザープール用のドメインを設定します。
     */
    new cognito.UserPoolDomain(this, 'SaseUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'sase-project',
      },
    });

    /**
     * @description Lambda関数で使用する外部ライブラリをまとめるレイヤー。
     */
    const requestsLayer = new lambda.LayerVersion(this, 'RequestsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'layer')),
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9],
      description: 'Contains `requests` library',
    });

    /**
     * @description ZTNAで保護されるバックエンドのLambda関数（例: ユーザー情報API）。
     */
    const protectedResourceFunction = new lambda.Function(this, 'ProtectedResourceFunction', {
      functionName: 'sase-protected-resource-function',
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'protected_resource.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    /**
     * @description プライベートAPI Gatewayへのアクセスを制御するためのVPCエンドポイントを作成します。
     */
    const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY,
      subnets: { subnets: vpc.privateSubnets },
      securityGroups: [lambdaSecurityGroup],
    });

    // LambdaセキュリティグループにCognito IDPとProtected API VPCエンドポイントへのアウトバウンドルールを追加
    lambdaSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(), // Cognito IDPのエンドポイントは固定IPではないため、anyIpv4とします。
      ec2.Port.tcp(443),
      'Allow outbound to Cognito IDP endpoint'
    );
    lambdaSecurityGroup.addEgressRule(
      apiGatewayVpcEndpoint.connections.securityGroups[0],
      ec2.Port.tcp(443),
      'Allow outbound to Protected API VPC endpoint'
    );


    /**
     * @description ZTNAで保護されるバックエンドAPI Gateway。
     */
    const protectedApi = new apigateway.RestApi(this, 'ProtectedApi', {
      restApiName: 'sase-protected-api',
      description: 'ZTNA Protected Backend API',
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ProtectedApiLogGroup', {
            logGroupName: `/aws/apigateway/${this.stackName}-ProtectedApi-AccessLogs`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
      },
      endpointTypes: [apigateway.EndpointType.PRIVATE],
      policy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringNotEquals: {
                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
              },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringEquals: {
                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId,
              },
            },
          }),
        ],
      }),
    });

    protectedApi.root.addMethod('GET', new apigateway.LambdaIntegration(protectedResourceFunction));

    /**
     * @description 認証Lambda関数に対して、保護対象のAPIへのアクセス権限を追加します。
     */
    protectedResourceFunction.addPermission('ApiGatewayInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: protectedApi.arnForExecuteApi(),
    });

    /**
     * @description クライアントの認証処理を行うLambda関数を設定します。
     */
    const authFunction = new lambda.Function(this, 'AuthFunction', {
      functionName: 'sase-auth-function',
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'auth_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      layers: [requestsLayer],
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        PROTECTED_API_BASE_URL: protectedApi.url, // ここでProtected APIのURLを設定
      },
      timeout: cdk.Duration.seconds(15),
      memorySize: 256,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    /**
     * @description Lambda関数がCognitoユーザープールにアクセスするためのIAMポリシーを追加します。
     */
    const lambdaCognitoPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:GetUser',
        'cognito-idp:AdminListGroupsForUser', // グループ情報を取得するために追加
      ],
      resources: [userPool.userPoolArn],
    });

    authFunction.addToRolePolicy(lambdaCognitoPolicy);

    /**
     * @description SASEのセキュアWebゲートウェイ機能を提供するAPI Gateway REST APIを設定します。
     */
    const api = new apigateway.RestApi(this, 'SaseApi', {
      restApiName: 'sase-api',
      description: 'SASE Secure Web Gateway API',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiGatewayLogGroup', {
            logGroupName: `/aws/apigateway/${this.stackName}-SaseApi-AccessLogs`,
            retention: logs.RetentionDays.ONE_MONTH,
            removalPolicy: cdk.RemovalPolicy.DESTROY,
          })
        ),
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true,
        }),
        throttlingBurstLimit: 100,
        throttlingRateLimit: 50,
      },
    });

    cdk.Tags.of(api).add('Project', 'SASE-Project');
    cdk.Tags.of(api).add('ManagedBy', 'CDK');

    /**
     * @description CognitoユーザープールをAPI Gatewayのカスタムオーソライザーとして設定します。
     */
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool],
      authorizerName: 'cognito-authorizer',
    });

    /**
     * @description API GatewayのプロキシリソースとANYメソッドを設定します。
     */
    const proxyResource = api.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', new apigateway.LambdaIntegration(authFunction), {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer,
    });

    /**
     * @description API Gatewayのルートリソース (/) のANYメソッドを設定します。
     */
    api.root.addMethod('ANY', new apigateway.LambdaIntegration(authFunction), {
      authorizationType: apigateway.AuthorizationType.COGNITO,
      authorizer: cognitoAuthorizer,
    });

    /**
     * @description API GatewayがLambda関数を呼び出すための権限を追加します。
     */
    authFunction.addPermission('ApiGatewayPermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: api.arnForExecuteApi(),
    });

    authFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:Invoke'],
      resources: [protectedApi.arnForExecuteApi('*', '*')],
    }));

    /**
     * @description SASEのログを保存するためのS3バケットを設定します。
     */
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `sase-access-logs-${cdk.Aws.ACCOUNT_ID}`,
      versioned: true,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(30),
          id: 'DeleteLogsAfter30Days',
          enabled: true,
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    /**
     * @description Lambda関数のCloudWatchロググループを設定します。
     */
    new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${authFunction.functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    /**
     * @description DLPスキャン対象のファイルを保存するためのS3バケットを設定します。
     */
    const dlpScanBucket = new s3.Bucket(this, 'DlpScanBucket', {
      bucketName: `sase-dlp-scan-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    /**
     * @description DLPスキャンを実行するLambda関数を設定します。
     */
    const dlpScanFunction = new lambda.Function(this, 'DlpScanFunction', {
      functionName: 'sase-dlp-scan-function',
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'dlp_scan_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
      vpc,
      securityGroups: [lambdaSecurityGroup],
      timeout: cdk.Duration.seconds(60),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    /**
     * @description DLPスキャンLambda関数がS3バケットとMacieにアクセスするためのIAMポリシーを追加します。
     */
    dlpScanFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['s3:GetObject', 's3:ListBucket'],
      resources: [
        dlpScanBucket.bucketArn,
        dlpScanBucket.bucketArn + '/*',
      ],
      effect: iam.Effect.ALLOW,
    }));

    dlpScanFunction.addToRolePolicy(new iam.PolicyStatement({
      actions: ['macie2:*'],
      resources: ['*'],
      effect: iam.Effect.ALLOW,
    }));

    /**
     * @description DLPスキャンバケットにファイルがアップロードされたときにLambda関数をトリガーするイベント通知を設定します。
     */
    dlpScanBucket.addEventNotification(
      s3.EventType.OBJECT_CREATED,
      new s3n.LambdaDestination(dlpScanFunction),
    );

    /**
     * @description API Gatewayと連携するAWS WAF Web ACLを設定します。
     */
    const webAcl = new wafv2.CfnWebACL(this, 'SaseWebAcl', {
      name: 'sase-web-acl',
      description: 'SASEプロジェクト用Web ACL',
      scope: 'REGIONAL',
      defaultAction: {
        allow: {},
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: {
            none: {},
          },
          statement: {
            managedRuleGroupStatement: {
              name: 'AWSManagedRulesCommonRuleSet',
              vendorName: 'AWS',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 2,
          overrideAction: {
            none: {},
          },
          statement: {
            managedRuleGroupStatement: {
              name: 'AWSManagedRulesAmazonIpReputationList',
              vendorName: 'AWS',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesAmazonIpReputationList',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 3,
          overrideAction: {
            none: {},
          },
          statement: {
            managedRuleGroupStatement: {
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
              vendorName: 'AWS',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
            sampledRequestsEnabled: true,
          },
        },
      ],
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'sase-web-acl',
        sampledRequestsEnabled: true,
      },
    });

    /**
     * @description WAF Web ACLをAPI Gatewayのステージに関連付けます。
     */
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn,
      webAclArn: webAcl.attrArn,
    });

    /**
     * @description WAF Web ACLのログをS3バケットに送信するように設定します。
     */
    new wafv2.CfnLoggingConfiguration(this, 'WebAclLoggingConfiguration', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [logBucket.bucketArn],
    });
  }
}