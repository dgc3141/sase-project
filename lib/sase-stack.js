"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SaseStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const cognito = require("aws-cdk-lib/aws-cognito");
const apigateway = require("aws-cdk-lib/aws-apigateway");
const lambda = require("aws-cdk-lib/aws-lambda");
const iam = require("aws-cdk-lib/aws-iam");
const s3 = require("aws-cdk-lib/aws-s3");
const logs = require("aws-cdk-lib/aws-logs");
const wafv2 = require("aws-cdk-lib/aws-wafv2");
const path = require("path");
class SaseStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        /**
         * @description AWS ベストプラクティスに沿ったVPCを作成します。
         * - `maxAzs`: 高可用性のために、指定された数のアベイラビリティーゾーンにサブネットを分散します。
         * - `subnetConfiguration`: パブリックサブネットとプライベートサブネットを定義し、プライベートサブネットにはNAT Gateway経由のアウトバウンド通信を設定します。
         */
        const vpc = new ec2.Vpc(this, 'SaseVpc', {
            cidr: '10.0.0.0/16', // VPCのCIDRブロック。RFC 1918に準拠したプライベートIPアドレス範囲を使用
            maxAzs: 2, // VPCをデプロイするアベイラビリティーゾーンの最大数
            flowLogs: {
                // VPC Flow Logsを設定し、ネットワークトラフィックのモニタリングを有効化します。
                // S3バケットへのログ保存はベストプラクティスです。
                's3-flow-logs': {
                    destination: ec2.FlowLogDestination.toS3(new s3.Bucket(this, 'VpcFlowLogBucket', {
                        bucketName: `sase-vpc-flow-logs-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}`,
                        versioned: true,
                        encryption: s3.BucketEncryption.S3_MANAGED,
                        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
                        removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け。本番環境ではRETAIN推奨
                        autoDeleteObjects: true, // 開発環境向け。本番環境では注意
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
            environment: {
                COGNITO_USER_POOL_ID: userPool.userPoolId,
                COGNITO_CLIENT_ID: userPoolClient.userPoolClientId,
            },
            timeout: cdk.Duration.seconds(30), // タイムアウト設定 (必要に応じて調整)
            memorySize: 128, // メモリサイズ設定 (必要に応じて調整)
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
                accessLogDestination: new apigateway.LogGroupLogDestination(new logs.LogGroup(this, 'ApiGatewayLogGroup', {
                    logGroupName: `/aws/apigateway/${this.stackName}-SaseApi-AccessLogs`, // 一意のロググループ名
                    retention: logs.RetentionDays.ONE_MONTH, // ログ保持期間
                    removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境向け
                })),
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
            removalPolicy: cdk.RemovalPolicy.DESTROY, // 開発環境ではDESTROYで迅速なリソース削除を、本番環境ではRETAINで誤削除防止を推奨
            autoDeleteObjects: true, // 開発環境向け。本番環境では手動削除かRETAIN
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
    }
}
exports.SaseStack = SaseStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2FzZS1zdGFjay5qcyIsInNvdXJjZVJvb3QiOiIiLCJzb3VyY2VzIjpbInNhc2Utc3RhY2sudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBQUEsbUNBQW1DO0FBQ25DLDJDQUEyQztBQUMzQyxtREFBbUQ7QUFDbkQseURBQXlEO0FBQ3pELGlEQUFpRDtBQUNqRCwyQ0FBMkM7QUFDM0MseUNBQXlDO0FBQ3pDLDZDQUE2QztBQUM3QywrQ0FBK0M7QUFFL0MsNkJBQTZCO0FBRTdCLE1BQWEsU0FBVSxTQUFRLEdBQUcsQ0FBQyxLQUFLO0lBQ3RDLFlBQVksS0FBZ0IsRUFBRSxFQUFVLEVBQUUsS0FBc0I7UUFDOUQsS0FBSyxDQUFDLEtBQUssRUFBRSxFQUFFLEVBQUUsS0FBSyxDQUFDLENBQUM7UUFFeEI7Ozs7V0FJRztRQUNILE1BQU0sR0FBRyxHQUFHLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxJQUFJLEVBQUUsU0FBUyxFQUFFO1lBQ3ZDLElBQUksRUFBRSxhQUFhLEVBQUUsOENBQThDO1lBQ25FLE1BQU0sRUFBRSxDQUFDLEVBQVcsNkJBQTZCO1lBQ2pELFFBQVEsRUFBRTtnQkFDUixnREFBZ0Q7Z0JBQ2hELDRCQUE0QjtnQkFDNUIsY0FBYyxFQUFFO29CQUNkLFdBQVcsRUFBRSxHQUFHLENBQUMsa0JBQWtCLENBQUMsSUFBSSxDQUFDLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsa0JBQWtCLEVBQUU7d0JBQy9FLFVBQVUsRUFBRSxzQkFBc0IsR0FBRyxDQUFDLEdBQUcsQ0FBQyxVQUFVLElBQUksR0FBRyxDQUFDLEdBQUcsQ0FBQyxNQUFNLEVBQUU7d0JBQ3hFLFNBQVMsRUFBRSxJQUFJO3dCQUNmLFVBQVUsRUFBRSxFQUFFLENBQUMsZ0JBQWdCLENBQUMsVUFBVTt3QkFDMUMsaUJBQWlCLEVBQUUsRUFBRSxDQUFDLGlCQUFpQixDQUFDLFNBQVM7d0JBQ2pELGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU8sRUFB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WUFDeEQsV0FBVyxFQUFFLEdBQUcsQ0FBQyxlQUFlLENBQUMsUUFBUSxFQUFFLDJCQUEyQjtZQUN0RSxTQUFTLEVBQUUsTUFBTSxDQUFDLE9BQU8sRUFBRSxrQkFBa0I7U0FDOUMsQ0FBQyxDQUFDO1FBRUg7Ozs7V0FJRztRQUNILElBQUksS0FBSyxDQUFDLHVCQUF1QixDQUFDLElBQUksRUFBRSw0QkFBNEIsRUFBRTtZQUNwRSxXQUFXLEVBQUUsTUFBTSxDQUFDLE9BQU87WUFDM0IscUJBQXFCLEVBQUUsQ0FBQyxTQUFTLENBQUMsU0FBUyxDQUFDO1lBQzVDLGtFQUFrRTtZQUNsRSx5REFBeUQ7U0FDMUQsQ0FBQyxDQUFDO0lBQ0wsQ0FBQztDQUNGO0FBelhELDhCQXlYQyIsInNvdXJjZXNDb250ZW50IjpbImltcG9ydCAqIGFzIGNkayBmcm9tICdhd3MtY2RrLWxpYic7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBjb2duaXRvIGZyb20gJ2F3cy1jZGstbGliL2F3cy1jb2duaXRvJztcbmltcG9ydCAqIGFzIGFwaWdhdGV3YXkgZnJvbSAnYXdzLWNkay1saWIvYXdzLWFwaWdhdGV3YXknO1xuaW1wb3J0ICogYXMgbGFtYmRhIGZyb20gJ2F3cy1jZGstbGliL2F3cy1sYW1iZGEnO1xuaW1wb3J0ICogYXMgaWFtIGZyb20gJ2F3cy1jZGstbGliL2F3cy1pYW0nO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgd2FmdjIgZnJvbSAnYXdzLWNkay1saWIvYXdzLXdhZnYyJztcbmltcG9ydCB7IENvbnN0cnVjdCB9IGZyb20gJ2NvbnN0cnVjdHMnO1xuaW1wb3J0ICogYXMgcGF0aCBmcm9tICdwYXRoJztcblxuZXhwb3J0IGNsYXNzIFNhc2VTdGFjayBleHRlbmRzIGNkay5TdGFjayB7XG4gIGNvbnN0cnVjdG9yKHNjb3BlOiBDb25zdHJ1Y3QsIGlkOiBzdHJpbmcsIHByb3BzPzogY2RrLlN0YWNrUHJvcHMpIHtcbiAgICBzdXBlcihzY29wZSwgaWQsIHByb3BzKTtcblxuICAgIC8qKlxuICAgICAqIEBkZXNjcmlwdGlvbiBBV1Mg44OZ44K544OI44OX44Op44Kv44OG44Kj44K544Gr5rK/44Gj44GfVlBD44KS5L2c5oiQ44GX44G+44GZ44CCXG4gICAgICogLSBgbWF4QXpzYDog6auY5Y+v55So5oCn44Gu44Gf44KB44Gr44CB5oyH5a6a44GV44KM44Gf5pWw44Gu44Ki44OZ44Kk44Op44OT44Oq44OG44Kj44O844K+44O844Oz44Gr44K144OW44ON44OD44OI44KS5YiG5pWj44GX44G+44GZ44CCXG4gICAgICogLSBgc3VibmV0Q29uZmlndXJhdGlvbmA6IOODkeODluODquODg+OCr+OCteODluODjeODg+ODiOOBqOODl+ODqeOCpOODmeODvOODiOOCteODluODjeODg+ODiOOCkuWumue+qeOBl+OAgeODl+ODqeOCpOODmeODvOODiOOCteODluODjeODg+ODiOOBq+OBr05BVCBHYXRld2F557WM55Sx44Gu44Ki44Km44OI44OQ44Km44Oz44OJ6YCa5L+h44KS6Kit5a6a44GX44G+44GZ44CCXG4gICAgICovXG4gICAgY29uc3QgdnBjID0gbmV3IGVjMi5WcGModGhpcywgJ1Nhc2VWcGMnLCB7XG4gICAgICBjaWRyOiAnMTAuMC4wLjAvMTYnLCAvLyBWUEPjga5DSURS44OW44Ot44OD44Kv44CCUkZDIDE5MTjjgavmupbmi6DjgZfjgZ/jg5fjg6njgqTjg5njg7zjg4hJUOOCouODieODrOOCueevhOWbsuOCkuS9v+eUqFxuICAgICAgbWF4QXpzOiAyLCAgICAgICAgICAvLyBWUEPjgpLjg4fjg5fjg63jgqTjgZnjgovjgqLjg5njgqTjg6njg5Pjg6rjg4bjgqPjg7zjgr7jg7zjg7Pjga7mnIDlpKfmlbBcbiAgICAgIGZsb3dMb2dzOiB7XG4gICAgICAgIC8vIFZQQyBGbG93IExvZ3PjgpLoqK3lrprjgZfjgIHjg43jg4Pjg4jjg6/jg7zjgq/jg4jjg6njg5XjgqPjg4Pjgq/jga7jg6Ljg4vjgr/jg6rjg7PjgrDjgpLmnInlirnljJbjgZfjgb7jgZnjgIJcbiAgICAgICAgLy8gUzPjg5DjgrHjg4Pjg4jjgbjjga7jg63jgrDkv53lrZjjga/jg5njgrnjg4jjg5fjg6njgq/jg4bjgqPjgrnjgafjgZnjgIJcbiAgICAgICAgJ3MzLWZsb3ctbG9ncyc6IHtcbiAgICAgICAgICBkZXN0aW5hdGlvbjogZWMyLkZsb3dMb2dEZXN0aW5hdGlvbi50b1MzKG5ldyBzMy5CdWNrZXQodGhpcywgJ1ZwY0Zsb3dMb2dCdWNrZXQnLCB7XG4gICAgICAgICAgICBidWNrZXROYW1lOiBgc2FzZS12cGMtZmxvdy1sb2dzLSR7Y2RrLkF3cy5BQ0NPVU5UX0lEfS0ke2Nkay5Bd3MuUkVHSU9OfWAsXG4gICAgICAgICAgICB2ZXJzaW9uZWQ6IHRydWUsXG4gICAgICAgICAgICBlbmNyeXB0aW9uOiBzMy5CdWNrZXRFbmNyeXB0aW9uLlMzX01BTkFHRUQsXG4gICAgICAgICAgICBibG9ja1B1YmxpY0FjY2VzczogczMuQmxvY2tQdWJsaWNBY2Nlc3MuQkxPQ0tfQUxMLFxuICAgICAgICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8g6ZaL55m655Kw5aKD5ZCR44GR44CC5pys55Wq55Kw5aKD44Gn44GvUkVUQUlO5o6o5aWoXG4gICAgICAgICAgICBhdXRvRGVsZXRlT2JqZWN0czogdHJ1ZSwgLy8g6ZaL55m655Kw5aKD5ZCR44GR44CC5pys55Wq55Kw5aKD44Gn44Gv5rOo5oSPXG4gICAgICAgICAgfSkpLFxuICAgICAgICAgIHRyYWZmaWNUeXBlOiBlYzIuRmxvd0xvZ1RyYWZmaWNUeXBlLkFMTCwgLy8g5YWo44Gm44Gu44OI44Op44OV44Kj44OD44Kv44KS44Ot44Kw44Gr6KiY6YyyXG4gICAgICAgIH0sXG4gICAgICB9LFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgY2lkck1hc2s6IDI0LFxuICAgICAgICAgIG5hbWU6ICdQdWJsaWNTdWJuZXQnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBVQkxJQywgLy8g44Kk44Oz44K/44O844ON44OD44OI44GL44KJ44Gu44Kk44Oz44OQ44Km44Oz44OJ44OI44Op44OV44Kj44OD44Kv44KS6Kix5Y+vXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBjaWRyTWFzazogMjQsXG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGVXaXRoRWdyZXNzU3VibmV0JyxcbiAgICAgICAgICBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTLCAvLyBOQVQgR2F0ZXdheee1jOeUseOBp+OCpOODs+OCv+ODvOODjeODg+ODiOOBuOOBruOCouOCpuODiOODkOOCpuODs+ODieODiOODqeODleOCo+ODg+OCr+OCkuioseWPr1xuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIC8vIGBpcEFkZHJlc3Nlc2Ag44OX44Ot44OR44OG44Kj44Gu5L2/55So44GM5o6o5aWo44GV44KM44Gm44GE44G+44GZ44CCXG4gICAgICAvLyDnj77lnKjjga5gY2lkcmDjg5fjg63jg5Hjg4bjgqPjga/pnZ7mjqjlpajjgajjgarjgorjgIHlsIbmnaXjga7jg5Djg7zjgrjjg6fjg7PjgafliYrpmaTjgZXjgozjgovlj6/og73mgKfjgYzjgYLjgorjgb7jgZnjgIJcbiAgICAgIC8vIOS+izogaXBBZGRyZXNzZXM6IGVjMi5JcEFkZHJlc3Nlcy5jaWRyKCcxMC4wLjAuMC8xNicpLFxuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICogQGRlc2NyaXB0aW9uIExhbWJkYemWouaVsOeUqOOBruOCu+OCreODpeODquODhuOCo+OCsOODq+ODvOODl+OCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0gYGFsbG93QWxsT3V0Ym91bmRgOiDnj77nirbjga/lhajjgabjga7jgqLjgqbjg4jjg5Djgqbjg7Pjg4njgpLoqLHlj6/jgZfjgabjgYTjgb7jgZnjgYzjgIHjg5njgrnjg4jjg5fjg6njgq/jg4bjgqPjgrnjgajjgZfjgabjga/jgIFcbiAgICAgKiAgIOW/heimgeacgOS9jumZkOOBrklQ44Ki44OJ44Os44K544KE44Od44O844OIKOS+i+OBiOOBsOOAgUNvZ25pdG/jgoRXQUbjgbjjga7pgJrkv6Ep44Gu44G/44Gr5Yi26ZmQ44GZ44KL44GT44Go44GM5o6o5aWo44GV44KM44G+44GZ44CCXG4gICAgICovXG4gICAgY29uc3QgbGFtYmRhU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnTGFtYmRhU2VjdXJpdHlHcm91cCcsIHtcbiAgICAgIHZwYyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnTGFtYmRh6Zai5pWw44Gr6YGp55So44GV44KM44KL44K744Kt44Ol44Oq44OG44Kj44Kw44Or44O844OXJyxcbiAgICAgIGFsbG93QWxsT3V0Ym91bmQ6IHRydWUsIC8vIOODmeOCueODiOODl+ODqeOCr+ODhuOCo+OCueOBqOOBl+OBpuOBr+OAgeW/heimgeacgOS9jumZkOOBrklQ44Ki44OJ44Os44K544KE44Od44O844OI44Gr5Yi26ZmQ44GZ44G544GNXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24g44Kv44Op44Kk44Ki44Oz44OI6KqN6Ki844Gu44Gf44KB44GuQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq+OCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0gYHVzZXJQb29sTmFtZWA6IOODpuODvOOCtuODvOODl+ODvOODq+OBruirlueQhuWQjVxuICAgICAqIC0gYHNlbGZTaWduVXBFbmFibGVkYDog44Om44O844K244O86Ieq6Lqr44Gn44Gu44K144Kk44Oz44Ki44OD44OX44KS6Kix5Y+v44GZ44KL44GL44Gp44GG44GLXG4gICAgICogLSBgc2lnbkluQWxpYXNlc2A6IEXjg6Hjg7zjg6vjgafjga7jgrXjgqTjg7PjgqTjg7PjgpLoqLHlj69cbiAgICAgKiAtIGBhdXRvVmVyaWZ5YDogReODoeODvOODq+OBruiHquWLleaknOiovOOCkuacieWKueWMllxuICAgICAqIC0gYHBhc3N3b3JkUG9saWN5YDog5by35Zu644Gq44OR44K544Ov44O844OJ44Od44Oq44K344O844KS6YGp55So44GX44CB44K744Kt44Ol44Oq44OG44Kj44KS5ZCR5LiK44GV44Gb44G+44GZ44CCXG4gICAgICogLSBgcmVtb3ZhbFBvbGljeWA6IOmWi+eZuueSsOWig+OBp+OBr0RFU1RST1njgafov4XpgJ/jgarjg6rjgr3jg7zjgrnliYrpmaTjgpLjgIHmnKznlarnkrDlooPjgafjga9SRVRBSU7jgafoqqTliYrpmaTpmLLmraLjgpLmjqjlpajjgZfjgb7jgZnjgIJcbiAgICAgKi9cbiAgICBjb25zdCB1c2VyUG9vbCA9IG5ldyBjb2duaXRvLlVzZXJQb29sKHRoaXMsICdTYXNlVXNlclBvb2wnLCB7XG4gICAgICB1c2VyUG9vbE5hbWU6ICdzYXNlLXVzZXItcG9vbCcsXG4gICAgICBzZWxmU2lnblVwRW5hYmxlZDogdHJ1ZSxcbiAgICAgIHNpZ25JbkFsaWFzZXM6IHtcbiAgICAgICAgZW1haWw6IHRydWUsXG4gICAgICB9LFxuICAgICAgYXV0b1ZlcmlmeToge1xuICAgICAgICBlbWFpbDogdHJ1ZSwgLy8gReODoeODvOODq+OCouODieODrOOCueOBruiHquWLleaknOiovFxuICAgICAgfSxcbiAgICAgIHBhc3N3b3JkUG9saWN5OiB7XG4gICAgICAgIG1pbkxlbmd0aDogOCxcbiAgICAgICAgcmVxdWlyZUxvd2VyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVVwcGVyY2FzZTogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZURpZ2l0czogdHJ1ZSxcbiAgICAgICAgcmVxdWlyZVN5bWJvbHM6IHRydWUsXG4gICAgICAgIHRlbXBQYXNzd29yZFZhbGlkaXR5OiBjZGsuRHVyYXRpb24uZGF5cyg3KSwgLy8g5Luu44OR44K544Ov44O844OJ44Gu5pyJ5Yq55pyf6ZmQXG4gICAgICB9LFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8g6ZaL55m655Kw5aKD5ZCR44GRXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq+OCr+ODqeOCpOOCouODs+ODiOOCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0gYGdlbmVyYXRlU2VjcmV0YDog44Kv44Op44Kk44Ki44Oz44OI44K344O844Kv44Os44OD44OI44KS55Sf5oiQ44GX44Gq44GE6Kit5a6a44CC5Li744Gr44OV44Ot44Oz44OI44Ko44Oz44OJ44Ki44OX44Oq44Kx44O844K344On44Oz44GL44KJ44Gu5Yip55So44KS5oOz5a6a44GX44Gm44GE44G+44GZ44CCXG4gICAgICogLSBgYXV0aEZsb3dzYDog6KqN6Ki844OV44Ot44O844Gu5a6a576p44CC44GT44KM44Gr44KI44KK44CB5qeY44CF44Gq6KqN6Ki85pa55rOV44KS44K144Od44O844OI44GX44G+44GZ44CCXG4gICAgICovXG4gICAgY29uc3QgdXNlclBvb2xDbGllbnQgPSBuZXcgY29nbml0by5Vc2VyUG9vbENsaWVudCh0aGlzLCAnU2FzZVVzZXJQb29sQ2xpZW50Jywge1xuICAgICAgdXNlclBvb2wsXG4gICAgICB1c2VyUG9vbENsaWVudE5hbWU6ICdzYXNlLWNsaWVudCcsXG4gICAgICBnZW5lcmF0ZVNlY3JldDogZmFsc2UsIC8vIOWFrOmWi+OCr+ODqeOCpOOCouODs+ODiCAoU1BB44Gq44GpKSDjga7loLTlkIjjga9mYWxzZeOBjOODmeOCueODiOODl+ODqeOCr+ODhuOCo+OCuVxuICAgICAgYXV0aEZsb3dzOiB7XG4gICAgICAgIGFkbWluVXNlclBhc3N3b3JkOiB0cnVlLFxuICAgICAgICBjdXN0b206IHRydWUsXG4gICAgICAgIHVzZXJQYXNzd29yZDogdHJ1ZSxcbiAgICAgICAgdXNlclNycDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq+eUqOOBruODieODoeOCpOODs+OCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0gYGRvbWFpblByZWZpeGA6IENvZ25pdG/jg5vjgrnjg4jlnotVSeOBrlVSTOODl+ODrOODleOCo+ODg+OCr+OCuVxuICAgICAqL1xuICAgIGNvbnN0IHVzZXJQb29sRG9tYWluID0gbmV3IGNvZ25pdG8uVXNlclBvb2xEb21haW4odGhpcywgJ1Nhc2VVc2VyUG9vbERvbWFpbicsIHtcbiAgICAgIHVzZXJQb29sLFxuICAgICAgY29nbml0b0RvbWFpbjoge1xuICAgICAgICBkb21haW5QcmVmaXg6ICdzYXNlLXByb2plY3QnLFxuICAgICAgfSxcbiAgICB9KTtcblxuICAgIC8qKlxuICAgICAqIEBkZXNjcmlwdGlvbiDjgq/jg6njgqTjgqLjg7Pjg4jjga7oqo3oqLzlh6bnkIbjgpLooYzjgYZMYW1iZGHplqLmlbDjgpLoqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiAtIGBydW50aW1lYDog5a6f6KGM55Kw5aKD44Gu5oyH5a6a44CCUHl0aG9uIDMuOeOCkuS9v+eUqOOAglxuICAgICAqIC0gYGhhbmRsZXJgOiDjgqjjg7Pjg4jjg6rjg53jgqTjg7Pjg4jjga7plqLmlbDlkI3jgIJcbiAgICAgKiAtIGBjb2RlYDogTGFtYmRh6Zai5pWw44Gu44K944O844K544Kz44O844OJ44GM44GC44KL44OH44Kj44Os44Kv44OI44Oq44G444Gu44OR44K544CCXG4gICAgICogLSBgdnBjYCAmIGBzZWN1cml0eUdyb3Vwc2AgOiBMYW1iZGHjgpJWUEPlhoXjgavphY3nva7jgZnjgovjgZPjgajjgafjgIHjg43jg4Pjg4jjg6/jg7zjgq/jga7jgrvjgq3jg6Xjg6rjg4bjgqPjgpLlvLfljJbjgZfjgb7jgZnjgIJcbiAgICAgKiAtIGBlbnZpcm9ubWVudGA6IExhbWJkYemWouaVsOWGheOBp+WIqeeUqOOBmeOCi+eSsOWig+WkieaVsOOAgkNvZ25pdG/jga5JROOCkuioreWumuOAglxuICAgICAqIC0gYHRpbWVvdXRgOiDjg4fjg5Xjgqnjg6vjg4jjga7jgr/jgqTjg6DjgqLjgqbjg4jjgpLoqK3lrprjgILlh6bnkIbmmYLplpPjgavlv5zjgZjjgaboqr/mlbTjgZfjgb7jgZnjgIJcbiAgICAgKiAtIGBtZW1vcnlTaXplYDogTGFtYmRh6Zai5pWw44Gu44Oh44Oi44Oq44K144Kk44K644KS6Kit5a6a44CC44OR44OV44Kp44O844Oe44Oz44K544Go44Kz44K544OI44Gr5b2x6Z+/44GX44G+44GZ44CCXG4gICAgICogLSBgbG9nUmV0ZW50aW9uYDogQ2xvdWRXYXRjaCBMb2dz44Gu44Ot44Kw5L+d5oyB5pyf6ZaT44KS6Kit5a6a44CCXG4gICAgICovXG4gICAgY29uc3QgYXV0aEZ1bmN0aW9uID0gbmV3IGxhbWJkYS5GdW5jdGlvbih0aGlzLCAnQXV0aEZ1bmN0aW9uJywge1xuICAgICAgZnVuY3Rpb25OYW1lOiAnc2FzZS1hdXRoLWZ1bmN0aW9uJyxcbiAgICAgIHJ1bnRpbWU6IGxhbWJkYS5SdW50aW1lLlBZVEhPTl8zXzksXG4gICAgICBoYW5kbGVyOiAnYXV0aF9mdW5jdGlvbi5sYW1iZGFfaGFuZGxlcicsXG4gICAgICBjb2RlOiBsYW1iZGEuQ29kZS5mcm9tQXNzZXQocGF0aC5qb2luKF9fZGlybmFtZSwgJy4uJywgJ2xhbWJkYScpKSwgLy8gYGxhbWJkYWDjg4fjgqPjg6zjgq/jg4jjg6rphY3kuIvjga7jgrPjg7zjg4njgpLjg4fjg5fjg63jgqRcbiAgICAgIHZwYywgLy8gTGFtYmRh44KSVlBD5YaF44Gr6YWN572uXG4gICAgICBzZWN1cml0eUdyb3VwczogW2xhbWJkYVNlY3VyaXR5R3JvdXBdLCAvLyBWUEPlhoXjga7jg6rjgr3jg7zjgrnjgbjjga7jgqLjgq/jgrvjgrnjgpLliLblvqHjgZnjgovjgrvjgq3jg6Xjg6rjg4bjgqPjgrDjg6vjg7zjg5dcbiAgICAgIGVudmlyb25tZW50OiB7XG4gICAgICAgIENPR05JVE9fVVNFUl9QT09MX0lEOiB1c2VyUG9vbC51c2VyUG9vbElkLFxuICAgICAgICBDT0dOSVRPX0NMSUVOVF9JRDogdXNlclBvb2xDbGllbnQudXNlclBvb2xDbGllbnRJZCxcbiAgICAgIH0sXG4gICAgICB0aW1lb3V0OiBjZGsuRHVyYXRpb24uc2Vjb25kcygzMCksIC8vIOOCv+OCpOODoOOCouOCpuODiOioreWumiAo5b+F6KaB44Gr5b+c44GY44Gm6Kq/5pW0KVxuICAgICAgbWVtb3J5U2l6ZTogMTI4LCAvLyDjg6Hjg6Ljg6rjgrXjgqTjgrroqK3lrpogKOW/heimgeOBq+W/nOOBmOOBpuiqv+aVtClcbiAgICAgIGxvZ1JldGVudGlvbjogbG9ncy5SZXRlbnRpb25EYXlzLk9ORV9NT05USCwgLy8gTGFtYmRh6Zai5pWw44Gu44Ot44Kw5L+d5oyB5pyf6ZaTXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gTGFtYmRh6Zai5pWw44GMQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq+OBq+OCouOCr+OCu+OCueOBmeOCi+OBn+OCgeOBrklBTeODneODquOCt+ODvOOCkui/veWKoOOBl+OBvuOBmeOAglxuICAgICAqIC0g5pyA5bCP5qip6ZmQ44Gu5Y6f5YmH44Gr5b6T44GE44CBYGNvZ25pdG8taWRwOkdldFVzZXJg44Ki44Kv44K344On44Oz44Gu44G/44KS6Kix5Y+v44GX44G+44GZ44CCXG4gICAgICovXG4gICAgY29uc3QgbGFtYmRhQ29nbml0b1BvbGljeSA9IG5ldyBpYW0uUG9saWN5U3RhdGVtZW50KHtcbiAgICAgIGVmZmVjdDogaWFtLkVmZmVjdC5BTExPVyxcbiAgICAgIGFjdGlvbnM6IFtcbiAgICAgICAgJ2NvZ25pdG8taWRwOkdldFVzZXInLCAvLyDjg6bjg7zjgrbjg7zmg4XloLHjgpLlj5blvpfjgZnjgovjgZ/jgoHjga7mqKnpmZBcbiAgICAgIF0sXG4gICAgICByZXNvdXJjZXM6IFt1c2VyUG9vbC51c2VyUG9vbEFybl0sIC8vIOeJueWumuOBrkNvZ25pdG/jg6bjg7zjgrbjg7zjg5fjg7zjg6vjgavpmZDlrppcbiAgICB9KTtcblxuICAgIGF1dGhGdW5jdGlvbi5hZGRUb1JvbGVQb2xpY3kobGFtYmRhQ29nbml0b1BvbGljeSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gU0FTReOBruOCu+OCreODpeOColdlYuOCsuODvOODiOOCpuOCp+OCpOapn+iDveOCkuaPkOS+m+OBmeOCi0FQSSBHYXRld2F5IFJFU1QgQVBJ44KS6Kit5a6a44GX44G+44GZ44CCXG4gICAgICogLSBgcmVzdEFwaU5hbWVgOiBBUEnjga7lkI3liY3jgIJcbiAgICAgKiAtIGBkZXNjcmlwdGlvbmA6IEFQSeOBruiqrOaYjuOAglxuICAgICAqIC0gYGRlcGxveU9wdGlvbnNgOlxuICAgICAqICAgLSBgc3RhZ2VOYW1lYDog44OH44OX44Ot44Kk44K544OG44O844K444Gu5ZCN5YmN77yI5L6LOiBgcHJvZGDvvInjgIJcbiAgICAgKiAgIC0gYGFjY2Vzc0xvZ0Rlc3RpbmF0aW9uYDogQVBJIEdhdGV3YXnjga7jgqLjgq/jgrvjgrnjg63jgrDjgpJDbG91ZFdhdGNoIExvZ3PjgavpgIHkv6HjgZnjgovjgojjgYbjgavoqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiAgIC0gYGFjY2Vzc0xvZ0Zvcm1hdGA6IOOCouOCr+OCu+OCueODreOCsOOBruODleOCqeODvOODnuODg+ODiOOCkkpTT07lvaLlvI/jga7mqJnmupbjg5XjgqPjg7zjg6vjg4njgaflrprnvqnjgZfjgb7jgZnjgIJcbiAgICAgKi9cbiAgICBjb25zdCBhcGkgPSBuZXcgYXBpZ2F0ZXdheS5SZXN0QXBpKHRoaXMsICdTYXNlQXBpJywge1xuICAgICAgcmVzdEFwaU5hbWU6ICdzYXNlLWFwaScsXG4gICAgICBkZXNjcmlwdGlvbjogJ1NBU0UgU2VjdXJlIFdlYiBHYXRld2F5IEFQSScsXG4gICAgICBkZXBsb3lPcHRpb25zOiB7XG4gICAgICAgIHN0YWdlTmFtZTogJ3Byb2QnLFxuICAgICAgICBhY2Nlc3NMb2dEZXN0aW5hdGlvbjogbmV3IGFwaWdhdGV3YXkuTG9nR3JvdXBMb2dEZXN0aW5hdGlvbihcbiAgICAgICAgICBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnQXBpR2F0ZXdheUxvZ0dyb3VwJywge1xuICAgICAgICAgICAgbG9nR3JvdXBOYW1lOiBgL2F3cy9hcGlnYXRld2F5LyR7dGhpcy5zdGFja05hbWV9LVNhc2VBcGktQWNjZXNzTG9nc2AsIC8vIOS4gOaEj+OBruODreOCsOOCsOODq+ODvOODl+WQjVxuICAgICAgICAgICAgcmV0ZW50aW9uOiBsb2dzLlJldGVudGlvbkRheXMuT05FX01PTlRILCAvLyDjg63jgrDkv53mjIHmnJ/plpNcbiAgICAgICAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1ksIC8vIOmWi+eZuueSsOWig+WQkeOBkVxuICAgICAgICAgIH0pXG4gICAgICAgICksXG4gICAgICAgIC8vIOOCouOCr+OCu+OCueODreOCsOOBruODleOCqeODvOODnuODg+ODiOOCkuODmeOCueODiOODl+ODqeOCr+ODhuOCo+OCueOBq+ayv+OBo+OBpuips+e0sOOBq+ioreWumuOBl+OBvuOBmeOAglxuICAgICAgICAvLyDjgZPjgozjgavjgojjgorjgIHjg4jjg6njg5bjg6vjgrfjg6Xjg7zjg4bjgqPjg7PjgrDjgoTnm6Pmn7vjgYzlrrnmmJPjgavjgarjgorjgb7jgZnjgIJcbiAgICAgICAgYWNjZXNzTG9nRm9ybWF0OiBhcGlnYXRld2F5LkFjY2Vzc0xvZ0Zvcm1hdC5qc29uV2l0aFN0YW5kYXJkRmllbGRzKHtcbiAgICAgICAgICBjYWxsZXI6IHRydWUsXG4gICAgICAgICAgaHR0cE1ldGhvZDogdHJ1ZSxcbiAgICAgICAgICBpcDogdHJ1ZSxcbiAgICAgICAgICBwcm90b2NvbDogdHJ1ZSxcbiAgICAgICAgICByZXF1ZXN0VGltZTogdHJ1ZSxcbiAgICAgICAgICByZXNvdXJjZVBhdGg6IHRydWUsXG4gICAgICAgICAgcmVzcG9uc2VMZW5ndGg6IHRydWUsXG4gICAgICAgICAgc3RhdHVzOiB0cnVlLFxuICAgICAgICAgIHVzZXI6IHRydWUsIC8vIGB1c2VyYOODl+ODreODkeODhuOCo+OCkui/veWKoFxuICAgICAgICB9KSxcbiAgICAgIH0sXG4gICAgfSk7XG4gICAgLy8gQVBJ44Gr44K/44Kw44KS6L+95Yqg44GZ44KL44GT44Go44Gn44CB44Oq44K944O844K544Gu566h55CG44Go5YiG6aGe44GM5a655piT44Gr44Gq44KK44G+44GZ44CCXG4gICAgY2RrLlRhZ3Mub2YoYXBpKS5hZGQoJ1Byb2plY3QnLCAnU0FTRS1Qcm9qZWN0Jyk7XG4gICAgY2RrLlRhZ3Mub2YoYXBpKS5hZGQoJ01hbmFnZWRCeScsICdDREsnKTtcblxuICAgIC8qKlxuICAgICAqIEBkZXNjcmlwdGlvbiBDb2duaXRv44Om44O844K244O844OX44O844Or44KSQVBJIEdhdGV3YXnjga7jgqvjgrnjgr/jg6Djgqrjg7zjgr3jg6njgqTjgrbjg7zjgajjgZfjgaboqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiAtIOOBk+OCjOOBq+OCiOOCiuOAgUNvZ25pdG/jgafoqo3oqLzjgZXjgozjgZ/jg6bjg7zjgrbjg7zjga7jgb/jgYxBUEkgR2F0ZXdheeOBq+OCouOCr+OCu+OCueOBp+OBjeOCi+OCiOOBhuOBq+OBquOCiuOBvuOBmeOAglxuICAgICAqL1xuICAgIGNvbnN0IGNvZ25pdG9BdXRob3JpemVyID0gbmV3IGFwaWdhdGV3YXkuQ29nbml0b1VzZXJQb29sc0F1dGhvcml6ZXIodGhpcywgJ0NvZ25pdG9BdXRob3JpemVyJywge1xuICAgICAgY29nbml0b1VzZXJQb29sczogW3VzZXJQb29sXSwgLy8g6Zai6YCj5LuY44GR44KLQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq1xuICAgICAgYXV0aG9yaXplck5hbWU6ICdjb2duaXRvLWF1dGhvcml6ZXInLFxuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICogQGRlc2NyaXB0aW9uIEFQSSBHYXRld2F544Gu44OX44Ot44Kt44K344Oq44K944O844K544GoQU5Z44Oh44K944OD44OJ44KS6Kit5a6a44GX44G+44GZ44CCXG4gICAgICogLSBge3Byb3h5K31g44OR44K544Gn44CB5YWo44Gm44Gu44Oq44Kv44Ko44K544OI44OR44K544KS44Kt44Oj44OD44OB44GX44G+44GZ44CCXG4gICAgICogLSBgTGFtYmRhSW50ZWdyYXRpb25g44GnTGFtYmRh6Zai5pWw44KS44OQ44OD44Kv44Ko44Oz44OJ44Go44GX44Gm57Wx5ZCI44GX44G+44GZ44CCXG4gICAgICogLSBgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUT2DjgadDb2duaXRv6KqN6Ki844KS5by35Yi244GX44G+44GZ44CCXG4gICAgICovXG4gICAgY29uc3QgcHJveHlSZXNvdXJjZSA9IGFwaS5yb290LmFkZFJlc291cmNlKCd7cHJveHkrfScpO1xuICAgIHByb3h5UmVzb3VyY2UuYWRkTWV0aG9kKCdBTlknLCBuZXcgYXBpZ2F0ZXdheS5MYW1iZGFJbnRlZ3JhdGlvbihhdXRoRnVuY3Rpb24pLCB7XG4gICAgICBhdXRob3JpemF0aW9uVHlwZTogYXBpZ2F0ZXdheS5BdXRob3JpemF0aW9uVHlwZS5DT0dOSVRPLCAvLyBDb2duaXRv44Om44O844K244O844OX44O844Or44Gr44KI44KL6KqN6Ki8XG4gICAgICBhdXRob3JpemVyOiBjb2duaXRvQXV0aG9yaXplcixcbiAgICAgIC8vIOODoeOCveODg+ODieOBq+W/nOetlOODouODh+ODq+OCkuioreWumuOBmeOCi+OBk+OBqOOBp+OAgUFQSeOBruOCueOCreODvOODnuOCkuWumue+qeOBl+OAgeOCr+ODqeOCpOOCouODs+ODiOWBtOOBruOCs+ODvOODieeUn+aIkOOCkuaUr+aPtOOBl+OBvuOBmeOAglxuICAgICAgLy8g54++54q244Gv44K344Oz44OX44Or44Gq44OX44Ot44Kt44K344Gu44Gf44KB55yB55Wl44GX44Gm44GE44G+44GZ44GM44CB5pys55Wq55Kw5aKD44Gn44Gv5qSc6KiO5o6o5aWo44CCXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gQVBJIEdhdGV3YXnjga7jg6vjg7zjg4jjg6rjgr3jg7zjgrkgKC8pIOOBrkFOWeODoeOCveODg+ODieOCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0g44OX44Ot44Kt44K344Oq44K944O844K544Go5ZCM5qeY44Gr44CBQ29nbml0b+iqjeiovOOCkuW/hemgiOOBqOOBl+OBvuOBmeOAglxuICAgICAqL1xuICAgIGFwaS5yb290LmFkZE1ldGhvZCgnQU5ZJywgbmV3IGFwaWdhdGV3YXkuTGFtYmRhSW50ZWdyYXRpb24oYXV0aEZ1bmN0aW9uKSwge1xuICAgICAgYXV0aG9yaXphdGlvblR5cGU6IGFwaWdhdGV3YXkuQXV0aG9yaXphdGlvblR5cGUuQ09HTklUTywgLy8gQ29nbml0b+ODpuODvOOCtuODvOODl+ODvOODq+OBq+OCiOOCi+iqjeiovFxuICAgICAgYXV0aG9yaXplcjogY29nbml0b0F1dGhvcml6ZXIsXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gQVBJIEdhdGV3YXnjgYxMYW1iZGHplqLmlbDjgpLlkbzjgbPlh7rjgZnjgZ/jgoHjga7mqKnpmZDjgpLov73liqDjgZfjgb7jgZnjgIJcbiAgICAgKiAtIOacgOWwj+aoqemZkOOBruWOn+WJh+OBq+W+k+OBhOOAgeeJueWumuOBrkFQSSBHYXRld2F544Gu44G/44GL44KJ44Gu5ZG844Gz5Ye644GX44KS6Kix5Y+v44GX44G+44GZ44CCXG4gICAgICovXG4gICAgYXV0aEZ1bmN0aW9uLmFkZFBlcm1pc3Npb24oJ0FwaUdhdGV3YXlQZXJtaXNzaW9uJywge1xuICAgICAgcHJpbmNpcGFsOiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2FwaWdhdGV3YXkuYW1hem9uYXdzLmNvbScpLCAvLyBBUEkgR2F0ZXdheeOBi+OCieOBruWRvOOBs+WHuuOBl+OCkuioseWPr1xuICAgICAgc291cmNlQXJuOiBhcGkuYXJuRm9yRXhlY3V0ZUFwaSgpLCAvLyDnibnlrprjga5BUEkgR2F0ZXdheeOBq+mZkOWumlxuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICogQGRlc2NyaXB0aW9uIFNBU0Xjga7jg63jgrDjgpLkv53lrZjjgZnjgovjgZ/jgoHjga5TM+ODkOOCseODg+ODiOOCkuioreWumuOBl+OBvuOBmeOAglxuICAgICAqIC0gYGJ1Y2tldE5hbWVgOiDjg5DjgrHjg4Pjg4jlkI3jgILkuIDmhI/mgKfjgpLkv53jgaTjgZ/jgoHjgavjgqLjgqvjgqbjg7Pjg4hJROOChOODquODvOOCuOODp+ODs+OCkue1hOOBv+i+vOOCgOOBk+OBqOOBjOaOqOWlqOOBleOCjOOBvuOBmeOAglxuICAgICAqIC0gYHZlcnNpb25lZGA6IOOCquODluOCuOOCp+OCr+ODiOOBruODkOODvOOCuOODp+ODs+euoeeQhuOCkuacieWKueWMluOBl+OAgeWBtueZuueahOOBquWJiumZpOOChOS4iuabuOOBjeOBi+OCieOBruW+qeaXp+OCkuWPr+iDveOBq+OBl+OBvuOBmeOAglxuICAgICAqIC0gYGVuY3J5cHRpb25gOiBTM+euoeeQhuOBrlNTRSAoU2VydmVyLVNpZGUgRW5jcnlwdGlvbikg44KS5pyJ5Yq544Gr44GX44CB5L+d5a2Y5pmC44Gu44OH44O844K/44KS5L+d6K2344GX44G+44GZ44CCXG4gICAgICogLSBgYmxvY2tQdWJsaWNBY2Nlc3NgOiDlhajjgabjga7jg5Hjg5bjg6rjg4Pjgq/jgqLjgq/jgrvjgrnjgpLjg5bjg63jg4Pjgq/jgZfjgIHmhI/lm7PjgZfjgarjgYTjg4fjg7zjgr/mvI/mtKnjgpLpmLLjgY7jgb7jgZnjgIJcbiAgICAgKiAtIGBsaWZlY3ljbGVSdWxlc2A6IOODqeOCpOODleOCteOCpOOCr+ODq+ODq+ODvOODq+OCkuioreWumuOBl+OAgeWPpOOBhOODreOCsOOBruiHquWLleWJiumZpOOCkuWumue+qeOBl+OBvuOBmeOAglxuICAgICAqIC0gYHJlbW92YWxQb2xpY3lgOiDplovnmbrnkrDlooPjgafjga9ERVNUUk9Z44CB5pys55Wq55Kw5aKD44Gn44GvUkVUQUlO44GM5o6o5aWo44GV44KM44G+44GZ44CCXG4gICAgICogLSBgYXV0b0RlbGV0ZU9iamVjdHNgOiDplovnmbrnkrDlooPlkJHjgZHjgILmnKznlarnkrDlooPjgafjga9mYWxzZeOBjOS4gOiIrOeahOOBp+OBmeOAglxuICAgICAqL1xuICAgIGNvbnN0IGxvZ0J1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ0xvZ0J1Y2tldCcsIHtcbiAgICAgIGJ1Y2tldE5hbWU6IGBzYXNlLWFjY2Vzcy1sb2dzLSR7Y2RrLkF3cy5BQ0NPVU5UX0lEfWAsIC8vIOODkOOCseODg+ODiOWQjeOBruS4gOaEj+aAp+OCkueiuuS/nVxuICAgICAgdmVyc2lvbmVkOiB0cnVlLCAvLyDjg5DjgrHjg4Pjg4jjga7jg5Djg7zjgrjjg6fjg7PnrqHnkIbjgpLmnInlirnljJZcbiAgICAgIGVuY3J5cHRpb246IHMzLkJ1Y2tldEVuY3J5cHRpb24uUzNfTUFOQUdFRCwgLy8gUzPnrqHnkIbjga5TU0UtUzPjgafmmpflj7fljJZcbiAgICAgIGJsb2NrUHVibGljQWNjZXNzOiBzMy5CbG9ja1B1YmxpY0FjY2Vzcy5CTE9DS19BTEwsIC8vIOWFqOOBpuOBruODkeODluODquODg+OCr+OCouOCr+OCu+OCueOCkuODluODreODg+OCr1xuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAge1xuICAgICAgICAgIGV4cGlyYXRpb246IGNkay5EdXJhdGlvbi5kYXlzKDMwKSwgLy8gMzDml6Xlvozjgavjgqrjg5bjgrjjgqfjgq/jg4jjgpLoh6rli5XliYrpmaRcbiAgICAgICAgICBpZDogJ0RlbGV0ZUxvZ3NBZnRlcjMwRGF5cycsXG4gICAgICAgICAgZW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAvLyDnibnlrprjga7jg5fjg6zjg5XjgqPjg4Pjgq/jgrnjgoTjgr/jgrDjgpLmjIHjgaTjgqrjg5bjgrjjgqfjgq/jg4jjga7jgb/jgavjg6vjg7zjg6vjgpLpgannlKjjgZnjgovjgZPjgajjgoLlj6/og73jgafjgZnjgIJcbiAgICAgICAgICAvLyBwcmVmaXg6ICdteS1sb2dzLycsIC8vIOS+izog54m55a6a44Gu44OV44Kp44Or44OA5YaF44Gu44Ot44Kw44Gu44G/XG4gICAgICAgIH0sXG4gICAgICBdLFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8g6ZaL55m655Kw5aKD44Gn44GvREVTVFJPWeOBp+i/hemAn+OBquODquOCveODvOOCueWJiumZpOOCkuOAgeacrOeVqueSsOWig+OBp+OBr1JFVEFJTuOBp+iqpOWJiumZpOmYsuatouOCkuaOqOWlqFxuICAgICAgYXV0b0RlbGV0ZU9iamVjdHM6IHRydWUsIC8vIOmWi+eZuueSsOWig+WQkeOBkeOAguacrOeVqueSsOWig+OBp+OBr+aJi+WLleWJiumZpOOBi1JFVEFJTlxuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICogQGRlc2NyaXB0aW9uIExhbWJkYemWouaVsOOBrkNsb3VkV2F0Y2jjg63jgrDjgrDjg6vjg7zjg5fjgpLoqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiAtIGBsb2dHcm91cE5hbWVgOiDjg63jgrDjgrDjg6vjg7zjg5flkI1cbiAgICAgKiAtIGByZXRlbnRpb25gOiDjg63jgrDjga7kv53mjIHmnJ/plpPjgpLoqK3lrprjgZfjgIHjgrPjgrnjg4jnrqHnkIbjgpLmlK/mj7TjgZfjgb7jgZnjgIJcbiAgICAgKi9cbiAgICBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnTGFtYmRhTG9nR3JvdXAnLCB7XG4gICAgICBsb2dHcm91cE5hbWU6IGAvYXdzL2xhbWJkYS8ke2F1dGhGdW5jdGlvbi5mdW5jdGlvbk5hbWV9YCwgLy8gTGFtYmRh6Zai5pWw5ZCN44Gr5Z+644Gl44GE44Gf44Ot44Kw44Kw44Or44O844OX5ZCNXG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfTU9OVEgsIC8vIOODreOCsOS/neaMgeacn+mWkzogMeODtuaciFxuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSwgLy8g6ZaL55m655Kw5aKD5ZCR44GRXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gQVBJIEdhdGV3YXnjgajpgKPmkLrjgZnjgotBV1MgV0FGIFdlYiBBQ0zjgpLoqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiAtIGBzY29wZTogJ1JFR0lPTkFMJ2AgOiBBUEkgR2F0ZXdheeOBruOCiOOBhuOBquODquODvOOCuOODp+ODs+ODquOCveODvOOCueOBq+mWoumAo+S7mOOBkeOBvuOBmeOAglxuICAgICAqIC0gYGRlZmF1bHRBY3Rpb25gOiDjg4fjg5Xjgqnjg6vjg4jjgafoqLHlj6/vvIhgYWxsb3dg77yJ44Go44GX44CB5piO56S655qE44Gr44OW44Ot44OD44Kv44GZ44KL44Or44O844Or44KS5a6a576p44GX44G+44GZ44CCXG4gICAgICogLSBgcnVsZXNgOiBBV1Mg44Oe44ON44O844K444OJ44Or44O844Or44Kw44Or44O844OX44KS6YGp55So44GX44CB5LiA6Iis55qE44Gq6ISF5aiB44GL44KJ44Gu5L+d6K2344KS57Ch5Y2Y44Gr5a6f6KOF44GX44G+44GZ44CCXG4gICAgICogICAtIGBBV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0YDog5LiA6Iis55qE44Gq6ISG5byx5oCn44Gr5a++44GZ44KL44Or44O844Or44CCXG4gICAgICogICAtIGBBV1NNYW5hZ2VkUnVsZXNBbWF6b25JcFJlcHV0YXRpb25MaXN0YDog5oKq5oSP44Gu44GC44KLSVDjgqLjg4njg6zjgrnjgYvjgonjga7jg4jjg6njg5XjgqPjg4Pjgq/jgpLjg5bjg63jg4Pjgq/jgIJcbiAgICAgKiAgIC0gYEFXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldGA6IOS4jeato+OBquWFpeWKm+ODkeOCv+ODvOODs+OCkuaknOWHuuOAglxuICAgICAqL1xuICAgIGNvbnN0IHdlYkFjbCA9IG5ldyB3YWZ2Mi5DZm5XZWJBQ0wodGhpcywgJ1Nhc2VXZWJBY2wnLCB7XG4gICAgICBuYW1lOiAnc2FzZS13ZWItYWNsJyxcbiAgICAgIGRlc2NyaXB0aW9uOiAnU0FTReODl+ODreOCuOOCp+OCr+ODiOeUqFdlYiBBQ0wnLFxuICAgICAgc2NvcGU6ICdSRUdJT05BTCcsIC8vIFJFR0lPTkFM44K544Kz44O844OX44GvQVBJIEdhdGV3YXnjgoRBTELjgavpgannlKjlj6/og71cbiAgICAgIGRlZmF1bHRBY3Rpb246IHtcbiAgICAgICAgYWxsb3c6IHt9LCAvLyDjg4fjg5Xjgqnjg6vjg4jjga/oqLHlj6/jgZfjgIHjg6vjg7zjg6vjgafjg5bjg63jg4Pjgq/jgZnjgovjg4jjg6njg5XjgqPjg4Pjgq/jgpLlrprnvqlcbiAgICAgIH0sXG4gICAgICBydWxlczogW1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgIHByaW9yaXR5OiAxLCAvLyDjg6vjg7zjg6voqZXkvqHjga7lhKrlhYjpoIbkvY1cbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjoge1xuICAgICAgICAgICAgbm9uZToge30sIC8vIOODnuODjeODvOOCuOODieODq+ODvOODq+OCsOODq+ODvOODl+OBruODh+ODleOCqeODq+ODiOOCouOCr+OCt+ODp+ODs+OCkuS4iuabuOOBjeOBl+OBquOBhFxuICAgICAgICAgIH0sXG4gICAgICAgICAgc3RhdGVtZW50OiB7XG4gICAgICAgICAgICBtYW5hZ2VkUnVsZUdyb3VwU3RhdGVtZW50OiB7XG4gICAgICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNDb21tb25SdWxlU2V0JyxcbiAgICAgICAgICAgICAgdmVuZG9yTmFtZTogJ0FXUycsXG4gICAgICAgICAgICB9LFxuICAgICAgICAgIH0sXG4gICAgICAgICAgdmlzaWJpbGl0eUNvbmZpZzoge1xuICAgICAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICAgICAgbWV0cmljTmFtZTogJ0FXU01hbmFnZWRSdWxlc0NvbW1vblJ1bGVTZXQnLFxuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSwgLy8g44K144Oz44OX44Oq44Oz44Kw44GV44KM44Gf44Oq44Kv44Ko44K544OI44KS5pyJ5Yq55YyW44GX44CB44OH44OQ44OD44Kw44KS5pSv5o+0XG4gICAgICAgICAgfSxcbiAgICAgICAgfSxcbiAgICAgICAge1xuICAgICAgICAgIG5hbWU6ICdBV1NNYW5hZ2VkUnVsZXNBbWF6b25JcFJlcHV0YXRpb25MaXN0JyxcbiAgICAgICAgICBwcmlvcml0eTogMixcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjoge1xuICAgICAgICAgICAgbm9uZToge30sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0FtYXpvbklwUmVwdXRhdGlvbkxpc3QnLFxuICAgICAgICAgICAgICB2ZW5kb3JOYW1lOiAnQVdTJyxcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgfSxcbiAgICAgICAgICB2aXNpYmlsaXR5Q29uZmlnOiB7XG4gICAgICAgICAgICBjbG91ZFdhdGNoTWV0cmljc0VuYWJsZWQ6IHRydWUsXG4gICAgICAgICAgICBtZXRyaWNOYW1lOiAnQVdTTWFuYWdlZFJ1bGVzQW1hem9uSXBSZXB1dGF0aW9uTGlzdCcsXG4gICAgICAgICAgICBzYW1wbGVkUmVxdWVzdHNFbmFibGVkOiB0cnVlLFxuICAgICAgICAgIH0sXG4gICAgICAgIH0sXG4gICAgICAgIHtcbiAgICAgICAgICBuYW1lOiAnQVdTTWFuYWdlZFJ1bGVzS25vd25CYWRJbnB1dHNSdWxlU2V0JyxcbiAgICAgICAgICBwcmlvcml0eTogMyxcbiAgICAgICAgICBvdmVycmlkZUFjdGlvbjoge1xuICAgICAgICAgICAgbm9uZToge30sXG4gICAgICAgICAgfSxcbiAgICAgICAgICBzdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgIG1hbmFnZWRSdWxlR3JvdXBTdGF0ZW1lbnQ6IHtcbiAgICAgICAgICAgICAgbmFtZTogJ0FXU01hbmFnZWRSdWxlc0tub3duQmFkSW5wdXRzUnVsZVNldCcsXG4gICAgICAgICAgICAgIHZlbmRvck5hbWU6ICdBV1MnLFxuICAgICAgICAgICAgfSxcbiAgICAgICAgICB9LFxuICAgICAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgICAgIGNsb3VkV2F0Y2hNZXRyaWNzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICAgIG1ldHJpY05hbWU6ICdBV1NNYW5hZ2VkUnVsZXNLbm93bkJhZElucHV0c1J1bGVTZXQnLFxuICAgICAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgICAgICB9LFxuICAgICAgICB9LFxuICAgICAgXSxcbiAgICAgIHZpc2liaWxpdHlDb25maWc6IHtcbiAgICAgICAgY2xvdWRXYXRjaE1ldHJpY3NFbmFibGVkOiB0cnVlLFxuICAgICAgICBtZXRyaWNOYW1lOiAnc2FzZS13ZWItYWNsJyxcbiAgICAgICAgc2FtcGxlZFJlcXVlc3RzRW5hYmxlZDogdHJ1ZSxcbiAgICAgIH0sXG4gICAgICAvLyBXQUbjga7jg63jgrDjgpJTM+ODkOOCseODg+ODiOOBq+OCqOOCr+OCueODneODvOODiOOBmeOCi+OCiOOBhuOBq+ioreWumuOAglxuICAgICAgLy/jgZPjgozjgavjgojjgorjgIHoqbPntLDjgarliIbmnpDjgYzlj6/og73jgavjgarjgorjgb7jgZnjgIJcbiAgICAgIC8vIExvZ2dpbmdDb25maWd1cmF0aW9u44KS55u05o6lQ2ZuV2ViQUNM44Gr5ZCr44KB44KL44GT44Go44Gv44Gn44GN44G+44Gb44KT44CCXG4gICAgICAvLyDliKXpgJQgd2FmdjIuQ2ZuTG9nZ2luZ0NvbmZpZ3VyYXRpb24g44Oq44K944O844K544KS5L2/55So44GX44G+44GZ44CCXG4gICAgfSk7XG5cbiAgICAvKipcbiAgICAgKiBAZGVzY3JpcHRpb24gV0FGIFdlYiBBQ0zjgpJBUEkgR2F0ZXdheeOBruOCueODhuODvOOCuOOBq+mWoumAo+S7mOOBkeOBvuOBmeOAglxuICAgICAqIC0g44GT44KM44Gr44KI44KK44CBQVBJIEdhdGV3YXnjgbjjga7jg6rjgq/jgqjjgrnjg4jjgYxXQUbjgavjgojjgaPjgaboqZXkvqHjg7vjg5XjgqPjg6vjgr/jg6rjg7PjgrDjgZXjgozjgb7jgZnjgIJcbiAgICAgKi9cbiAgICBuZXcgd2FmdjIuQ2ZuV2ViQUNMQXNzb2NpYXRpb24odGhpcywgJ1dlYkFjbEFzc29jaWF0aW9uJywge1xuICAgICAgcmVzb3VyY2VBcm46IGFwaS5kZXBsb3ltZW50U3RhZ2Uuc3RhZ2VBcm4sIC8vIEFQSSBHYXRld2F544Gu44OH44OX44Ot44Kk44K544OG44O844K444GuQVJOXG4gICAgICB3ZWJBY2xBcm46IHdlYkFjbC5hdHRyQXJuLCAvLyBXQUYgV2ViIEFDTOOBrkFSTlxuICAgIH0pO1xuXG4gICAgLyoqXG4gICAgICogQGRlc2NyaXB0aW9uIFdBRiBXZWIgQUNM44Gu44Ot44Kw44KSUzPjg5DjgrHjg4Pjg4jjgavpgIHkv6HjgZnjgovjgojjgYbjgavoqK3lrprjgZfjgb7jgZnjgIJcbiAgICAgKiBBV1MgV0FG44Gu44Ot44Kw44GvUzPjg5DjgrHjg4Pjg4jjgb7jgZ/jga9DbG91ZFdhdGNoIExvZ3PjgavpgIHkv6HjgafjgY3jgb7jgZnjgIJcbiAgICAgKiDjg5njgrnjg4jjg5fjg6njgq/jg4bjgqPjgrnjgajjgZfjgabjga/jgIHplbfmnJ/kv53lrZjjgoTliIbmnpDjga7jgZ/jgoHjgatTM+OCkuS9v+eUqOOBmeOCi+OBk+OBqOOBjOaOqOWlqOOBleOCjOOBvuOBmeOAglxuICAgICAqL1xuICAgIG5ldyB3YWZ2Mi5DZm5Mb2dnaW5nQ29uZmlndXJhdGlvbih0aGlzLCAnV2ViQWNsTG9nZ2luZ0NvbmZpZ3VyYXRpb24nLCB7XG4gICAgICByZXNvdXJjZUFybjogd2ViQWNsLmF0dHJBcm4sXG4gICAgICBsb2dEZXN0aW5hdGlvbkNvbmZpZ3M6IFtsb2dCdWNrZXQuYnVja2V0QXJuXSxcbiAgICAgIC8vIGBsb2dEZXN0aW5hdGlvbkNvbmZpZ3NgOiDjg63jgrDjga7pgIHkv6HlhYjvvIhTM+ODkOOCseODg+ODiOOBrkFSTuOChENsb3VkV2F0Y2ggTG9nc+OBrkFSTu+8iVxuICAgICAgLy8gYHJlZGFjdGVkRmllbGRzYDog44Ot44Kw44GL44KJ6Zmk5aSW44GZ44KL44OV44Kj44O844Or44OJ77yI5L6LOiBBdXRob3JpemF0aW9uIOODmOODg+ODgOODvO+8iVxuICAgIH0pO1xuICB9XG59Il19