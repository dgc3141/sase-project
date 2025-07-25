import json
import boto3
import os
import requests
import base64

def lambda_handler(event, context):
    # Cognito User Pool ID and Client ID from environment variables
    user_pool_id = os.environ['COGNITO_USER_POOL_ID']
    client_id = os.environ['COGNITO_CLIENT_ID']
    
    # Get the Authorization header from the request
    auth_header = event['headers'].get('Authorization')
    if not auth_header:
        print("Authorization header is missing")
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Authorization header is missing'})
        }
    
    # Extract the token from the Authorization header (Bearer <token>)
    try:
        token = auth_header.split(' ')[1]
    except IndexError:
        print("Invalid Authorization header format")
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Invalid Authorization header format'})
        }
    
    # Initialize Cognito client
    client = boto3.client('cognito-idp')
    
    try:
        # Validate the token and get user groups
        response = client.get_user(
            AccessToken=token
        )
        username = response['Username']
        
        # Get user groups
        user_groups_response = client.admin_list_groups_for_user(
            Username=username,
            UserPoolId=user_pool_id
        )
        user_groups = [group['GroupName'] for group in user_groups_response['Groups']]
        print(f"User {username} belongs to groups: {user_groups}")

        # ZTNA Policy Enforcement
        # ユーザーの属性やリクエストのパスに基づいてアクセスを制御します
        request_path = event.get('path', '/')
        print(f"Requested path: {request_path}")

        protected_api_base_url = os.environ.get('PROTECTED_API_BASE_URL')
        if not protected_api_base_url:
            print("PROTECTED_API_BASE_URL environment variable is not set")
            return {
                'statusCode': 500,
                'body': json.dumps({'message': 'Configuration error: Protected API URL not set'})
            }

        # 例: /protectedPath へのアクセスは 'admin' グループに属するユーザーのみ許可
        # 例: /admin-panel へのアクセスは 'admin' グループに属し、かつ特定のデバイスIDからのみ許可
        device_id = event['headers'].get('x-device-id') # ヘッダーからX-Device-Idを取得

        if request_path.startswith('/protectedPath'):
            if 'admin' not in user_groups:
                print(f"Access denied for user {username} to {request_path}. Not in 'admin' group.")
                return {
                    'statusCode': 403,
                    'body': json.dumps({'message': 'Access denied: Not authorized for this resource (requires admin group)'})
                }
            print(f"Access granted for user {username} to {request_path}. Redirecting to protected API.")
        elif request_path.startswith('/admin-panel'):
            if 'admin' not in user_groups or device_id != 'trusted-device-123':
                print(f"Access denied for user {username} to {request_path}. Missing 'admin' group or invalid device ID.")
                return {
                    'statusCode': 403,
                    'body': json.dumps({'message': 'Access denied: Not authorized for this resource (requires admin group and trusted device)'})
                }
            print(f"Access granted for user {username} to {request_path}. Redirecting to protected API.")
        # CASBのようなSaaSアプリケーションアクセス制御の概念を導入。
        # 特定のSaaSアプリへのアクセスをZTNAポリシーで制御する例を示唆。
        # 例: if request_path.startswith('/salesforce') and 'sales_team' not in user_groups:
        #        return {'statusCode': 403, 'body': json.dumps({'message': 'Access denied: Not authorized for Salesforce'})}

        # 脅威インテリジェンスとUEBA (User and Entity Behavior Analytics) の概念導入：
        # ユーザーの行動パターン（例: 通常と異なる時間帯からのアクセス、頻繁なポリシー違反試行）を分析し、
        # 異常な振る舞いを検出した場合にはアクセスを自動的に制限またはブロックするロジックをここに統合できます。
        # 例えば、Lambda内で過去のアクセスログやユーザープロファイル情報と比較し、
        # AWS Machine Learning サービス (SageMaker, Amazon Fraud Detector) を活用してリアルタイムで異常を検知することも可能です。
        # if detect_anomalous_behavior(username, request_path, auth_header):
        #    print(f"Anomalous behavior detected for user {username}. Access denied.")
        #    return {'statusCode': 403, 'body': json.dumps({'message': 'Access denied: Anomalous behavior detected'})}
            # 保護されたAPIにリクエストを転送
            # API Gatewayのプロキシ+統合では、元のパスがそのまま渡されます。
            # 例: /protectedPath/resource -> protected_api_base_url/protectedPath/resource
            proxy_url = f"{protected_api_base_url}{request_path}"
            
            # リクエストヘッダー（ホストヘッダーなど）を適切に転送
            # X-Forwarded-For, X-Forwarded-Proto, X-Forwarded-Port はAPI Gatewayによって自動的に追加されます。
            headers_to_forward = {k: v for k, v in event['headers'].items() if k.lower() not in ['host', 'authorization']}
            
            try:
                # HTTPメソッドの取得
                method = event['httpMethod']
                # リクエストボディの取得
                body = event.get('body')
                if event.get('isBase64Encoded'):
                    body = base64.b64decode(body).decode('utf-8')
                
                # requestsライブラリを使用してバックエンドにリクエストを転送
                # VPC内部からのプライベートAPI Gatewayへのアクセスはrequestsライブラリで可能です
                response_from_protected_api = requests.request(
                    method=method,
                    url=proxy_url,
                    headers=headers_to_forward,
                    data=body,
                    timeout=5 # タイムアウト設定
                )

                # バックエンドからのレスポンスをそのまま返す
                return {
                    'statusCode': response_from_protected_api.status_code,
                    'headers': dict(response_from_protected_api.headers),
                    'body': response_from_protected_api.text
                }
            except requests.exceptions.RequestException as req_e:
                print(f"Error forwarding request to protected API: {req_e}")
                return {
                    'statusCode': 502,
                    'body': json.dumps({'message': f'Bad Gateway: {str(req_e)}'})
                }
            except Exception as forward_e:
                print(f"Unexpected error during forwarding: {forward_e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps({'message': f'Internal Server Error during forwarding: {str(forward_e)}'})
                }
        else:
            print(f"Default access granted for user {username} to {request_path}. Forwarding request...")
            # ここでは、保護されていないパスへのリクエストを外部サービス（インターネット）や他のリソースに転送する
            # 例として、HTTPbinのような外部サービスに転送します。
            # 実際には、セキュアWebゲートウェイの機能として、このトラフィックをフィルタリングするWAFなどにルーティングされます。
            external_service_url = "http://httpbin.org" #または別の外部サービス
            proxy_url_external = f"{external_service_url}{request_path}"
             
            headers_to_forward = {k: v for k, v in event['headers'].items() if k.lower() not in ['host', 'authorization']}

            try:
                method = event['httpMethod']
                body = event.get('body')
                if event.get('isBase64Encoded'):
                    body = base64.b64decode(body).decode('utf-8')

                response_from_external = requests.request(
                    method=method,
                    url=proxy_url_external,
                    headers=headers_to_forward,
                    data=body,
                    timeout=10 # タイムアウト設定
                )
                return {
                    'statusCode': response_from_external.status_code,
                    'headers': dict(response_from_external.headers),
                    'body': response_from_external.text
                }
            except requests.exceptions.RequestException as req_e:
                print(f"Error forwarding request to external service: {req_e}")
                return {
                    'statusCode': 502,
                    'body': json.dumps({'message': f'Bad Gateway: {str(req_e)}'})
                }
            except Exception as forward_e:
                print(f"Unexpected error during external forwarding: {forward_e}")
                return {
                    'statusCode': 500,
                    'body': json.dumps({'message': f'Internal Server Error during external forwarding: {str(forward_e)}'})
                }

    except client.exceptions.NotAuthorizedException:
        print("Invalid token or authentication failed")
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Invalid token or authentication failed'})
        }
    except Exception as e:
        print(f"Internal server error: {str(e)}")
        return {
            'statusCode': 500,
            'body': json.dumps({'message': f'Internal server error: {str(e)}'})
        }