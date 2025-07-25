# SASE (Secure Access Service Edge) 環境

このプロジェクトは、AWSを活用したサーバーレスアーキテクチャによるSASE環境の構築を目指しています。セキュアWebゲートウェイ機能を提供し、インターネットへの全トラフィックをフィルタリングします。

## アーキテクチャ概要

```mermaid
graph TD
    A[クライアント] -->|HTTPS| B(API Gateway: SASE Gateway)
    B -->|認証/ポリシー評価| C{Lambda: 認証 & ZTNAポリシー評価<br>(UEBA連携)}
    C -->|アクセス許可| D(ZTNA保護対象サービス / 外部インターネット)
    C -->|アクセス拒否| E[エラーレスポンス]

    D -->|インターネットトラフィック| K(AWS Network Firewall: FWaaS)
    K -->|フィルタリング| F[AWS WAF]
    F -->|ログ| G[S3バケット: 集中ログ & データ保護]

    H[Cognito] --> C
    I[外部インターネット] --> K
    J[ZTNA保護対象サービス] --> D
    C --> L[脅威インテリジェンス/UEBAシステム]
```

### 主要コンポーネント

このSASEアーキテクチャは、以下の主要コンポーネントで構成されています。

1.  **API Gateway (SASE Gateway)**: クライアントからのリクエストをセキュアに受信し、認証Lambda関数に処理を委譲します。レート制限機能によりDoS攻撃などから保護します。
2.  **Lambda (認証処理 & ZTNAポリシー評価)**: Cognitoと連携してクライアントの認証を行い、ユーザーの属性、デバイスの状態、リクエストのコンテキスト（パス、ヘッダーなど）に基づいてZTNAポリシーを評価します。脅威インテリジェンスやユーザー行動分析 (UEBA) システムと連携し、異常な振る舞いを検知した場合はアクセスを拒否します。ポリシー違反のリクエストは拒否し、許可されたリクエストのみをZTNA保護対象サービスまたはインターネットに転送します。
3.  **Cognito**: ユーザー認証とID管理を一元的に行います。
4.  **AWS Network Firewall (FWaaS)**: インターネットへの全トラフィックに対してネットワークレベルのL3/L4トラフィックフィルタリングとIDS/IPS機能を提供し、サービスとしてのファイアウォール（FWaaS）の役割を担います。
5.  **AWS WAF**: Webアプリケーションレベルの脅威（SQLインジェクション、XSSなど）から保護します。
6.  **S3バケット (集中ログ & データ保護)**: API Gateway, Lambda, WAF, VPCフローログ、さらにはDLPスキャン対象ファイルなどの全てのセキュリティログを集中して保存します。データ保護のため、バージョニング、暗号化、パブリックアクセスのブロック、およびライフサイクルルールが設定されています。CISB機能として、アップロードされるコンテンツの検査も可能です。
7.  **ZTNA保護対象サービス**: アクセス制御の対象となるバックエンドサービス（例: VPC内のLambda関数とプライベートAPI Gateway）。SASEゲートウェイおよびZTNAポリシー評価Lambda関数経由でのみセキュアにアクセス可能です。
8.  **DLPスキャン**: S3にアップロードされるファイルに対して、機密情報検出（AWS Macie）やマルウェアスキャンを実行し、データ損失防止を支援します。
9.  **脅威インテリジェンス/UEBAシステム**: 認証Lambda関数と連携し、ユーザーの行動パターンを分析。異常なアクセス試行や疑わしい行動をリアルタイムで検知し、API Gatewayレベルでのブロックや追加の認証要求など、自動的な防御アクションをトリガーします。

### ネットワーク構成

*   VPC: セキュリティグループ、パブリック/プライベートサブネットを管理します。フローログが有効化されています。
*   セキュリティグループ: Lambda関数、API Gateway、ZTNA保護対象サービスへのアクセスを制御します。
*   VPCエンドポイント: プライベートAPI Gatewayへのセキュアな接続を提供します。

### 認証・ZTNAフロー

1.  クライアントがSASE Gateway (API Gateway) にリクエストを送信します。
2.  API Gatewayが認証Lambda関数（認証処理 & ZTNAポリシー評価）を呼び出します。
3.  Lambda関数がCognitoに認証リクエストを送信し、ユーザーを認証します。
4.  認証成功後、Lambda関数はリクエストのコンテキスト（ユーザー属性、リソースパスなど）に基づき、ZTNAポリシーを評価します。
    *   **例**: `/protectedPath` へのアクセスは特定のCognitoグループ（例: `admin`）に属するユーザーのみに許可されます。
5.  ポリシーがアクセスを許可した場合、Lambda関数は以下のいずれかの方法でリクエストを転送します。
    *   **ZTNA保護対象サービス**: 私用なAPI Gatewayエンドポイントを介して、VPC内のLambda関数など安全なバックエンドサービスへ転送します。
    *   **外部インターネット**: HTTPbinのような外部サービスへ転送します。このトラフィックは引き続きAWS WAFでフィルタリングされます。
6.  ポリシーがアクセスを拒否した場合、Lambda関数は適切なエラーレスポンス（例: 403 Forbidden）を返します。
7.  API Gateway、Lambda、WAFからのログがS3バケットおよびCloudWatch Logsに保存されます。

## ディレクトリ構成

*   `cdk/`: AWS CDK設定ファイル
*   `lambda/`: Lambda関数のソースコード (認証Lambda, 保護されたリソースLambda, 共有レイヤー)

## 前提条件

*   AWSアカウント
*   Node.js & npm (またはYarn)
*   AWS CLI (認証済み)
*   AWS CDK CLI (`npm install -g aws-cdk`)

## デプロイ手順 (AWS CDK)

1.  **依存関係のインストール**:
    ```bash
    npm install
    ```

2.  **Lambdaレイヤーの準備**: `requests`ライブラリをLambdaレイヤーとしてパッケージ化します。
    ```bash
    mkdir -p lambda/layer/python
    pip install -t lambda/layer/python -r lambda/requirements.txt
    cd lambda/layer && zip -r ../requests_layer.zip . && cd ../..
    ```

3.  **AWS CDK環境のブートストラップ**:
    初回デプロイ時のみ必要です。`ACCOUNT_ID`と`AWS_REGION`を実際のAWSアカウントIDとリージョンに置き換えてください。
    ```bash
    npx cdk bootstrap aws://ACCOUNT_ID/AWS_REGION
    ```

4.  **CDKスタックの合成 (CloudFormationテンプレートの生成)**:
    ```bash
    npx cdk synth
    ```

5.  **CDKスタックのデプロイ**:
    ```bash
    npx cdk deploy
    ```
    承認プロンプトが表示された場合は 'y' を入力してください。承認なしでデプロイする場合は `--require-approval never` を追加します。

## 使用方法

1.  **Cognitoユーザーの作成とグループへの追加**:
    *   AWSマネジメントコンソールでCognitoユーザープール `sase-user-pool` に移動します。
    *   テストユーザーを作成します。
    *   オプション: `admin`という名前のグループを作成し、テストユーザーをこのグループに追加すると、`/protectedPath`へのアクセスをテストできます。
2.  **API Gatewayエンドポイントの取得**:
    *   CDKデプロイ後、出力されるAPI GatewayのURL（例: `https://xxxxxxx.execute-api.ap-northeast-1.amazonaws.com/prod/`）をメモします。
3.  **認証とアクセストークンの取得**:
    *   Postmanやcurlなどのツールを使用して、Cognitoユーザープールに対して認証を行い、IDトークンまたはアクセストークンを取得します。
認証フローは、Cognitoのホスト型UI、またはAWS Amplify SDKなどを利用できます。
4.  **SASEゲートウェイ経由のアクセス**:
    *   取得したアクセストークンを`Authorization: Bearer <アクセストークン>`ヘッダーに含めて、API Gatewayのエンドポイントにリクエストを送信します。
    *   **インターネットへのアクセス例**:
        ```bash
        curl -H "Authorization: Bearer <アクセストークン>" <API Gateway URL>/get
        ```
        (これはhttpbin.orgの`/get`エンドポイントに転送されます)
    *   **保護されたリソースへのアクセス例 (権限がない場合)**:
        ```bash
        curl -H "Authorization: Bearer <アクセストークン>" <API Gateway URL>/protectedPath/users
        ```
    *   **保護されたリソースへのアクセス例 (adminグループのユーザー)**:
        ```bash
        curl -H "Authorization: Bearer <admin_アクセストークン>" <API Gateway URL>/protectedPath/users
        ```
5.  **ログの確認**:
    *   CloudWatch Logsの`/aws/lambda/sase-auth-function`、`/aws/apigateway/SaseStack-SaseApi-AccessLogs`、`/aws/apigateway/SaseStack-ProtectedApi-AccessLogs`ロググループで、認証とZTNAポリシー評価の結果を確認できます。
    *   S3バケット (`sase-access-logs-<ACCOUNT_ID>`) で、WAFやVPCフローログのログを確認できます。