resource "aws_cloudwatch_log_group" "sase_log_group" {
  name              = "/aws/lambda/sase-auth-function"
  retention_in_days = 30
}

resource "aws_cloudwatch_log_group" "api_gateway_log_group" {
  name              = "API-Gateway-Execution-Logs_${aws_api_gateway_rest_api.sase_api.id}/prod"
  retention_in_days = 30
}