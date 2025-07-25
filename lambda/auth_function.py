import json
import boto3
import os

def lambda_handler(event, context):
    # Cognito User Pool ID and Client ID from environment variables
    user_pool_id = os.environ['COGNITO_USER_POOL_ID']
    client_id = os.environ['COGNITO_CLIENT_ID']
    
    # Get the Authorization header from the request
    auth_header = event['headers'].get('Authorization')
    if not auth_header:
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Authorization header is missing'})
        }
    
    # Extract the token from the Authorization header (Bearer <token>)
    try:
        token = auth_header.split(' ')[1]
    except IndexError:
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Invalid Authorization header format'})
        }
    
    # Initialize Cognito client
    client = boto3.client('cognito-idp')
    
    try:
        # Validate the token
        response = client.get_user(
            AccessToken=token
        )
        
        # If successful, forward the request to the firewall
        # In a real implementation, you would forward the request to your firewall/proxy
        # For now, we'll just return a success response
        return {
            'statusCode': 200,
            'body': json.dumps({
                'message': 'Authentication successful',
                'user': response['Username']
            })
        }
    except client.exceptions.NotAuthorizedException:
        return {
            'statusCode': 401,
            'body': json.dumps({'message': 'Invalid token'})
        }
    except Exception as e:
        return {
            'statusCode': 500,
            'body': json.dumps({'message': f'Internal server error: {str(e)}'})
        }