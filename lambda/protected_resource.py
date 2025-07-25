import json

def lambda_handler(event, context):
    print(f"Protected Resource Function received event: {json.dumps(event)}")
    return {
        'statusCode': 200,
        'headers': {
            'Content-Type': 'application/json'
        },
        'body': json.dumps({
            'message': 'Welcome to the Protected Resource!',
            'request_path': event.get('path'),
            'http_method': event.get('httpMethod')
        })
    }