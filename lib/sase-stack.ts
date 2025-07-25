import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import * as s3n from 'aws-cdk-lib/aws-s3-notifications'; // S3通知用のインポートを追加
import { Construct } from 'constructs';
import * as path from 'path';

export class SaseStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /**
     * @description AWS ベストプラクティスに沿ったVPCを作成します。
     * - `maxAzs`: 高可用性のために、指定された数のアベイラビリティーゾーンにサブネットを分散します。
     * - `subnetConfiguration`: パブリックサブネットとプライベートサブネットを定義し、プライベートサブネットにはNAT Gateway経由のアウトバウンド通信を設定します。
     */
    const vpc = new ec2.Vpc(this, 'SaseVpc', {
      cidr: '10.0.0.0/16', // VPCのCIDRブロック。RFC 1918に準拠したプライベートIPアドレス範囲を使用
      maxAzs: 2,          // VPCをデプロイするアベイラビリティーゾーンの最大数
      flowLogs: {
        // VPC Flow Logsを設定し、ネットワークトラフィックのモニタリングを有効化します。
        // S3バケットへのログ保存はベストプラクティスです。
        's3-flow-logs': {
          destination: ec2.FlowLogDestination.toS3(new s3.Bucket(this, 'VpcFlowLogBucket', {
            bucketName: `sase-vpc-flow-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
            versioned: true,
            encryption: s3.BucketEncryption.S3_MANAGED,
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            removalPolicy: cdk.RemovalPolicy.RETAIN, // 本番環境向け: リソースを誤削除から保護
            autoDeleteObjects: false, // 本番環境向け: オブジェクトの自動削除を無効化
          })),
          trafficType: ec2.FlowLogTrafficType.ALL, // 全てのトラフィックをログに記録
        },
      },
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'PublicSubnet',
          subnetType: ec2.SubnetType.PUBLIC, // インターネットからのインバウンドトラフィックを許可
        },
        {
          cidrMask: 24,
          name: 'PrivateWithEgressSubnet',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, // NAT Gateway経由でインターネットへのアウトバウンドトラフィックを許可
        },
      ],
      // `ipAddresses` プロパティの使用が推奨されています。
      // 現在の`cidr`プロパティは非推奨となり、将来のバージョンで削除される可能性があります。
      // 例: ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
    });

    /**
     * @description Lambda関数用のセキュリティグループを設定します。
     * - `allowAllOutbound`: 現状は全てのアウトバウンドを許可していますが、ベストプラクティスとしては、
     *   必要最低限のIPアドレスやポート(例えば、CognitoやWAFへの通信)のみに制限することが推奨されます。
     */
    const lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc,
      description: 'Lambda関数に適用されるセキュリティグループ',
      allowAllOutbound: true, // ベストプラクティスとしては、必要最低限のIPアドレスやポートに制限すべき
    });

    /**
     * @description クライアント認証のためのCognitoユーザープールを設定します。
     * - `userPoolName`: ユーザープールの論理名
     * - `selfSignUpEnabled`: ユーザー自身でのサインアップを許可するかどうか
     * - `signInAliases`: Eメールでのサインインを許可
     * - `autoVerify`: Eメールの自動検証を有効化
     * - `passwordPolicy`: 強固なパスワードポリシーを適用し、セキュリティを向上させます。
     * - `removalPolicy`: 開発環境ではDESTROYで迅速なリソース削除を、本番環境ではRETAINで誤削除防止を推奨します。
     */
    const userPool = new cognito.UserPool(this, 'SaseUserPool', {
      userPoolName: 'sase-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: true, // Eメールアドレスの自動検証
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireUppercase: true,
        requireDigits: true,
        requireSymbols: true,
        tempPasswordValidity: cdk.Duration.days(7), // 仮パスワードの有効期限
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け
    });

    /**
     * @description Cognitoユーザープールクライアントを設定します。
     * - `generateSecret`: クライアントシークレットを生成しない設定。主にフロントエンドアプリケーションからの利用を想定しています。
     * - `authFlows`: 認証フローの定義。これにより、様々な認証方法をサポートします。
     */
    const userPoolClient = new cognito.UserPoolClient(this, 'SaseUserPoolClient', {
      userPool,
      userPoolClientName: 'sase-client',
      generateSecret: false, // 公開クライアント (SPAなど) の場合はfalseがベストプラクティス
      authFlows: {
        adminUserPassword: true,
        custom: true,
        userPassword: true,
        userSrp: true,
      },
    });

    /**
     * @description Cognitoユーザープール用のドメインを設定します。
     * - `domainPrefix`: Cognitoホスト型UIのURLプレフィックス
     */
    const userPoolDomain = new cognito.UserPoolDomain(this, 'SaseUserPoolDomain', {
      userPool,
      cognitoDomain: {
        domainPrefix: 'sase-project',
      },
    });

    /**
     * @description Lambda関数で使用する外部ライブラリをまとめるレイヤー。
     * - `requests`ライブラリを含めることで、Lambda関数がHTTPリクエストを送信できるようになります。
     */
    const requestsLayer = new lambda.LayerVersion(this, 'RequestsLayer', {
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda', 'layer')), // レイヤーのコードパス
      compatibleRuntimes: [lambda.Runtime.PYTHON_3_9], // 互換性のあるランタイム
      description: 'Contains `requests` library',
    });

    /**
     * @description クライアントの認証処理を行うLambda関数を設定します。
     * - `runtime`: 実行環境の指定。Python 3.9を使用。
     * - `handler`: エントリポイントの関数名。
     * - `code`: Lambda関数のソースコードがあるディレクトリへのパス。
     * - `vpc` & `securityGroups` : LambdaをVPC内に配置することで、ネットワークのセキュリティを強化します。
     * - `environment`: Lambda関数内で利用する環境変数。CognitoのIDを設定。
     * - `timeout`: デフォルトのタイムアウトを設定。処理時間に応じて調整します。
     * - `memorySize`: Lambda関数のメモリサイズを設定。パフォーマンスとコストに影響します。
     * - `logRetention`: CloudWatch Logsのログ保持期間を設定。
     */
    const authFunction = new lambda.Function(this, 'AuthFunction', {
      functionName: 'sase-auth-function',
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'auth_function.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')), // `lambda`ディレクトリ配下のコードをデプロイ
      vpc, // LambdaをVPC内に配置
      securityGroups: [lambdaSecurityGroup], // VPC内のリソースへのアクセスを制御するセキュリティグループ
      layers: [requestsLayer], // requestsライブラリを含むレイヤーをアタッチ
      environment: {
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
        // PROTECTED_API_BASE_URL は protectedApi が定義された後に設定するため、一旦Placeholder
      },
      timeout: cdk.Duration.seconds(15), // 認証機能としては通常15秒で十分
      memorySize: 256, // パフォーマンス向上のためメモリを増量
      logRetention: logs.RetentionDays.ONE_MONTH, // Lambda関数のログ保持期間
    });

    /**
     * @description Lambda関数がCognitoユーザープールにアクセスするためのIAMポリシーを追加します。
     * - 最小権限の原則に従い、`cognito-idp:GetUser`アクションのみを許可します。
     */
    const lambdaCognitoPolicy = new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: [
        'cognito-idp:GetUser', // ユーザー情報を取得するための権限
      ],
      resources: [userPool.userPoolArn], // 特定のCognitoユーザープールに限定
    });

    authFunction.addToRolePolicy(lambdaCognitoPolicy);

    /**
     * @description SASEのセキュアWebゲートウェイ機能を提供するAPI Gateway REST APIを設定します。
     * - `restApiName`: APIの名前。
     * - `description`: APIの説明。
     * - `deployOptions`:
     *   - `stageName`: デプロイステージの名前（例: `prod`）。
     *   - `accessLogDestination`: API GatewayのアクセスログをCloudWatch Logsに送信するように設定します。
     *   - `accessLogFormat`: アクセスログのフォーマットをJSON形式の標準フィールドで定義します。
     */
    const api = new apigateway.RestApi(this, 'SaseApi', {
      restApiName: 'sase-api',
      description: 'SASE Secure Web Gateway API',
      deployOptions: {
        stageName: 'prod',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ApiGatewayLogGroup', {
            logGroupName: `/aws/apigateway/${this.stackName}-SaseApi-AccessLogs`, // 一意のロググループ名
            retention: logs.RetentionDays.ONE_MONTH, // ログ保持期間
            removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け
          })
        ),
        // アクセスログのフォーマットをベストプラクティスに沿って詳細に設定します。
        // これにより、トラブルシューティングや監査が容易になります。
        accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields({
          caller: true,
          httpMethod: true,
          ip: true,
          protocol: true,
          requestTime: true,
          resourcePath: true,
          responseLength: true,
          status: true,
          user: true, // `user`プロパティを追加
        }),
        // API Gatewayのレート制限とバーストを設定し、DoS攻撃や不正なアクセスから保護します。
        // これはSecure Web Gatewayの重要な機能の一部です。
        throttlingBurstLimit: 100, // 短時間で許可されるリクエストの最大数
        throttlingRateLimit: 50,  // 1秒あたりの安定したリクエスト数
      },
    });
    // APIにタグを追加することで、リソースの管理と分類が容易になります。
    cdk.Tags.of(api).add('Project', 'SASE-Project');
    cdk.Tags.of(api).add('ManagedBy', 'CDK');

    /**
     * @description CognitoユーザープールをAPI Gatewayのカスタムオーソライザーとして設定します。
     * - これにより、Cognitoで認証されたユーザーのみがAPI Gatewayにアクセスできるようになります。
     */
    const cognitoAuthorizer = new apigateway.CognitoUserPoolsAuthorizer(this, 'CognitoAuthorizer', {
      cognitoUserPools: [userPool], // 関連付けるCognitoユーザープール
      authorizerName: 'cognito-authorizer',
    });

    /**
     * @description API GatewayのプロキシリソースとANYメソッドを設定します。
     * - `{proxy+}`パスで、全てのリクエストパスをキャッチします。
     * - `LambdaIntegration`でLambda関数をバックエンドとして統合します。
     * - `authorizationType: apigateway.AuthorizationType.COGNITO`でCognito認証を強制します。
     */
    const proxyResource = api.root.addResource('{proxy+}');
    proxyResource.addMethod('ANY', new apigateway.LambdaIntegration(authFunction), {
      authorizationType: apigateway.AuthorizationType.COGNITO, // Cognitoユーザープールによる認証
      authorizer: cognitoAuthorizer,
      // メソッドに応答モデルを設定することで、APIのスキーマを定義し、クライアント側のコード生成を支援します。
      // 現状はシンプルなプロキシのため省略していますが、本番環境では検討推奨。
    });

    /**
     * @description API Gatewayのルートリソース (/) のANYメソッドを設定します。
     * - プロキシリソースと同様に、Cognito認証を必須とします。
     */
    api.root.addMethod('ANY', new apigateway.LambdaIntegration(authFunction), {
      authorizationType: apigateway.AuthorizationType.COGNITO, // Cognitoユーザープールによる認証
      authorizer: cognitoAuthorizer,
    });

    /**
     * @description API GatewayがLambda関数を呼び出すための権限を追加します。
     * - 最小権限の原則に従い、特定のAPI Gatewayのみからの呼び出しを許可します。
     */
    authFunction.addPermission('ApiGatewayPermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'), // API Gatewayからの呼び出しを許可
      sourceArn: api.arnForExecuteApi(), // 特定のAPI Gatewayに限定
    });

    /**
     * @description SASEのログを保存するためのS3バケットを設定します。
     * - `bucketName`: バケット名。一意性を保つためにアカウントIDやリージョンを組み込むことが推奨されます。
     * - `versioned`: オブジェクトのバージョン管理を有効化し、偶発的な削除や上書きからの復旧を可能にします。
     * - `encryption`: S3管理のSSE (Server-Side Encryption) を有効にし、保存時のデータを保護します。
     * - `blockPublicAccess`: 全てのパブリックアクセスをブロックし、意図しないデータ漏洩を防ぎます。
     * - `lifecycleRules`: ライフサイクルルールを設定し、古いログの自動削除を定義します。
     * - `removalPolicy`: 開発環境ではDESTROY、本番環境ではRETAINが推奨されます。
     * - `autoDeleteObjects`: 開発環境向け。本番環境ではfalseが一般的です。
     */
    const logBucket = new s3.Bucket(this, 'LogBucket', {
      bucketName: `sase-access-logs-${cdk.Aws.ACCOUNT_ID}`, // バケット名の一意性を確保
      versioned: true, // バケットのバージョン管理を有効化
      encryption: s3.BucketEncryption.S3_MANAGED, // S3管理のSSE-S3で暗号化
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // 全てのパブリックアクセスをブロック
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(30), // 30日後にオブジェクトを自動削除
          id: 'DeleteLogsAfter30Days',
          enabled: true,
          // 特定のプレフィックスやタグを持つオブジェクトのみにルールを適用することも可能です。
          // prefix: 'my-logs/', // 例: 特定のフォルダ内のログのみ
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN, // 本番環境向け: リソースを誤削除から保護
      autoDeleteObjects: false, // 本番環境向け: オブジェクトの自動削除を無効化
    });

    /**
     * @description Lambda関数のCloudWatchロググループを設定します。
     * - `logGroupName`: ロググループ名
     * - `retention`: ログの保持期間を設定し、コスト管理を支援します。
     */
    new logs.LogGroup(this, 'LambdaLogGroup', {
      logGroupName: `/aws/lambda/${authFunction.functionName}`, // Lambda関数名に基づいたロググループ名
      retention: logs.RetentionDays.ONE_MONTH, // ログ保持期間: 1ヶ月
      removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け
    });

   /**
    * @description DLPスキャン対象のファイルを保存するためのS3バケットを設定します。
    * - `bucketName`: バケット名。一意性を保つためにアカウントIDやリージョンを組み込むことが推奨されます。
    * - `encryption`: S3管理のSSE (Server-Side Encryption) を有効にし、保存時のデータを保護します。
    * - `blockPublicAccess`: 全てのパブリックアクセスをブロックし、意図しないデータ漏洩を防ぎます。
    * - `removalPolicy`: 開発環境ではDESTROY、本番環境ではRETAINが推奨されます。
    * - `autoDeleteObjects`: 開発環境向け。本番環境ではfalseが一般的です。
    */
   const dlpScanBucket = new s3.Bucket(this, 'DlpScanBucket', {
     bucketName: `sase-dlp-scan-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`, // バケット名の一意性を確保
     encryption: s3.BucketEncryption.S3_MANAGED, // S3管理のSSE-S3で暗号化
     blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, // 全てのパブリックアクセスをブロック
     removalPolicy: cdk.RemovalPolicy.RETAIN, // 本番環境向け: リソースを誤削除から保護
     autoDeleteObjects: false, // 本番環境向け: オブジェクトの自動削除を無効化
   });

   // Firewall as a Service (FWaaS) の概念導入：
   // AWS Network Firewall を統合することで、VPC内外のトラフィックに対する
   // 詳細なL3/L4トラフィックフィルタリングと侵入検知/防御 (IDS/IPS) 機能を提供できます。
   // 例: new networkfirewall.CfnFirewall(...) とルールグループ
   // これにより、SASEソリューションのネットワークセキュリティ層が強化されます。

   // 集中ログ管理とデータ保護の強化：
   // CloudFront (CDN) や Route 53 Resolver のログを中央のS3バケットに統合し、
   // Amazon GuardDuty や AWS Security Hub と連携することで、脅威インテリジェンスと
   // セキュリティ状態管理を強化できます。
   // logBucket.addEventNotification や S3へのアクセスログ設定などで実現可能。

    /**
     * @description API Gatewayと連携するAWS WAF Web ACLを設定します。
     * - `scope: 'REGIONAL'` : API Gatewayのようなリージョンリソースに関連付けます。
     * - `defaultAction`: デフォルトで許可（`allow`）とし、明示的にブロックするルールを定義します。
     * - `rules`: AWS マネージドルールグループを適用し、一般的な脅威からの保護を簡単に実装します。
     *   - `AWSManagedRulesCommonRuleSet`: 一般的な脆弱性に対するルール。
     *   - `AWSManagedRulesAmazonIpReputationList`: 悪意のあるIPアドレスからのトラフィックをブロック。
     *   - `AWSManagedRulesKnownBadInputsRuleSet`: 不正な入力パターンを検出。
     */
    const webAcl = new wafv2.CfnWebACL(this, 'SaseWebAcl', {
      name: 'sase-web-acl',
      description: 'SASEプロジェクト用Web ACL',
      scope: 'REGIONAL', // REGIONALスコープはAPI GatewayやALBに適用可能
      defaultAction: {
        allow: {}, // デフォルトは許可し、ルールでブロックするトラフィックを定義
      },
      rules: [
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1, // ルール評価の優先順位
          overrideAction: {
            none: {}, // マネージドルールグループのデフォルトアクションを上書きしない
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
            sampledRequestsEnabled: true, // サンプリングされたリクエストを有効化し、デバッグを支援
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
      // WAFのログをS3バケットにエクスポートするように設定。
      //これにより、詳細な分析が可能になります。
      // LoggingConfigurationを直接CfnWebACLに含めることはできません。
      // 別途 wafv2.CfnLoggingConfiguration リソースを使用します。
    });

    /**
     * @description WAF Web ACLをAPI Gatewayのステージに関連付けます。
     * - これにより、API GatewayへのリクエストがWAFによって評価・フィルタリングされます。
     */
    new wafv2.CfnWebACLAssociation(this, 'WebAclAssociation', {
      resourceArn: api.deploymentStage.stageArn, // API GatewayのデプロイステージのARN
      webAclArn: webAcl.attrArn, // WAF Web ACLのARN
    });

    /**
     * @description WAF Web ACLのログをS3バケットに送信するように設定します。
     * AWS WAFのログはS3バケットまたはCloudWatch Logsに送信できます。
     * ベストプラクティスとしては、長期保存や分析のためにS3を使用することが推奨されます。
     */
    new wafv2.CfnLoggingConfiguration(this, 'WebAclLoggingConfiguration', {
      resourceArn: webAcl.attrArn,
      logDestinationConfigs: [logBucket.bucketArn],
      // `logDestinationConfigs`: ログの送信先（S3バケットのARNやCloudWatch LogsのARN）
      // `redactedFields`: ログから除外するフィールド（例: Authorization ヘッダー）
    });

    /**
     * @description ZTNAで保護されるバックエンドのLambda関数（例: ユーザー情報API）。
     * - この関数はVPC内にデプロイされ、インターネットからは直接アクセスできません。
     * - `memorySize`や`timeout`は、実際の処理内容に合わせて調整が必要です。
     */
    const protectedResourceFunction = new lambda.Function(this, 'ProtectedResourceFunction', {
      functionName: 'sase-protected-resource-function',
      runtime: lambda.Runtime.PYTHON_3_9,
      handler: 'protected_resource.lambda_handler',
      code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')), // `lambda`ディレクトリ配下のコードをデプロイ
      vpc, // VPC内に配置
      securityGroups: [lambdaSecurityGroup], // VPC内のリソースへのアクセスを制御するセキュリティグループ
      timeout: cdk.Duration.seconds(5), // より短いタイムアウトで応答性を確保し、コストを削減
      memorySize: 128, // シンプルなAPIなので最小メモリで十分
      logRetention: logs.RetentionDays.ONE_MONTH, // ログ保持期間
    });

   /**
    * @description DLPスキャンを実行するLambda関数を設定します。
    * - S3バケットにオブジェクトが作成されたときにトリガーされます。
    */
   const dlpScanFunction = new lambda.Function(this, 'DlpScanFunction', {
     functionName: 'sase-dlp-scan-function',
     runtime: lambda.Runtime.PYTHON_3_9,
     handler: 'dlp_scan_function.lambda_handler',
     code: lambda.Code.fromAsset(path.join(__dirname, '..', 'lambda')),
     vpc,
     securityGroups: [lambdaSecurityGroup],
     timeout: cdk.Duration.seconds(60), // DLPスキャンは時間のかかる処理である可能性があるため妥当
     memorySize: 512, // DLPスキャンの処理能力向上のためメモリを増量
     logRetention: logs.RetentionDays.ONE_MONTH,
   });

   /**
    * @description DLPスキャンLambda関数がS3バケットとMacieにアクセスするためのIAMポリシーを追加します。
    * - S3バケットへの読み取り権限とMacie2へのフルアクセスを許可します。
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
     actions: ['macie2:*'], // Macie2サービスへの必要な権限
     resources: ['*'], // 特定のリソースに限定することが推奨されますが、Macieのコンソール設定によっては'*'が必要な場合があります。
     effect: iam.Effect.ALLOW,
   }));

   /**
    * @description DLPスキャンバケットにファイルがアップロードされたときにLambda関数をトリガーするイベント通知を設定します。
    */
   dlpScanBucket.addEventNotification(
     s3.EventType.OBJECT_CREATED,
     new s3n.LambdaDestination(dlpScanFunction), // 修正: s3n.LambdaDestination を使用
   );

    /**
     * @description プライベートAPI Gatewayへのアクセスを制御するためのVPCエンドポイントを作成します。
     * - このVPCエンドポイントは、SASEゲートウェイのLambda関数が保護されたAPIにアクセスするために使用されます。
     */
    const apiGatewayVpcEndpoint = new ec2.InterfaceVpcEndpoint(this, 'ApiGatewayVpcEndpoint', {
      vpc,
      service: ec2.InterfaceVpcEndpointAwsService.APIGATEWAY, // API Gatewayサービスのエンドポイント
      subnets: { subnets: vpc.privateSubnets }, // プライベートサブネットに配置
      securityGroups: [lambdaSecurityGroup], // Lambdaセキュリティグループのルールを適用
    });

    /**
     * @description ZTNAで保護されるバックエンドAPI Gateway。
     * - このAPI Gatewayは社内ネットワークやZTNAゲートウェイからのアクセスのみを許可します。
     * - `endpointTypes: [apigateway.EndpointType.PRIVATE]`を設定することで、VPCエンドポイント経由でのみアクセス可能にします。
     */
    const protectedApi = new apigateway.RestApi(this, 'ProtectedApi', {
      restApiName: 'sase-protected-api',
      description: 'ZTNA Protected Backend API',
      deployOptions: {
        stageName: 'v1',
        accessLogDestination: new apigateway.LogGroupLogDestination(
          new logs.LogGroup(this, 'ProtectedApiLogGroup', {
            logGroupName: `/aws/apigateway/${this.stackName}-ProtectedApi-AccessLogs`, // 一意のロググループ名
            retention: logs.RetentionDays.ONE_MONTH, // ログ保持期間
            removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け
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
      endpointTypes: [apigateway.EndpointType.PRIVATE], // プライベートエンドポイントのみ許可
      policy: new iam.PolicyDocument({
        // ベストプラクティス: リソースベースのポリシーでVPCエンドポイントまたは特定のIPからのアクセスを制限
        statements: [
          new iam.PolicyStatement({
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringNotEquals: {
                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId, // 自身のVPCエンドポイントからのアクセスのみ許可
              },
            },
          }),
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            principals: [new iam.AnyPrincipal()], // Cognito認証済みLambdaから呼び出すため、より厳密なプリンシパルに制限すべきですが、
                                                  // 今回はVPCエンドポイント経由でのアクセスに限定します。
            actions: ['execute-api:Invoke'],
            resources: ['execute-api:/*'],
            conditions: {
              StringEquals: {
                'aws:SourceVpce': apiGatewayVpcEndpoint.vpcEndpointId, // SASEゲートウェイLambdaが使用するVPCエンドポイントからのアクセスのみ許可
              },
            },
          }),
        ],
      }),
    });

    protectedApi.root.addMethod('GET', new apigateway.LambdaIntegration(protectedResourceFunction));

    /**
     * @description 認証Lambda関数に対して、保護対象のAPIへのアクセス権限を追加します。
     * - LambdaがVPC内からプライベートAPI Gatewayを呼び出すために必要です。
     */
    protectedResourceFunction.addPermission('ApiGatewayInvokePermission', {
      principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
      sourceArn: protectedApi.arnForExecuteApi(),
    });

    authFunction.addToRolePolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:Invoke'],
      resources: [protectedApi.arnForExecuteApi('*', '*')], // 保護対象APIのARNにinvokeを許可
    }));

    // ZTNAポリシー評価ロジックをLambdaに追加する必要があるため、
    // `lambda/auth_function.py`も更新します。
  }
}