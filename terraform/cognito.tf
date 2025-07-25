resource "aws_cognito_user_pool" "sase_user_pool" {
  name = "sase-user-pool"

  schema {
    name                = "email"
    attribute_data_type = "String"
    required            = true
    mutable             = true
  }

  password_policy {
    minimum_length                   = 8
    require_lowercase                = true
    require_numbers                  = true
    require_symbols                  = true
    require_uppercase                = true
    temporary_password_validity_days = 7
  }

  admin_create_user_config {
    allow_admin_create_user_only = false
  }

  auto_verified_attributes = ["email"]
}

resource "aws_cognito_user_pool_client" "sase_client" {
  name         = "sase-client"
  user_pool_id = aws_cognito_user_pool.sase_user_pool.id

  generate_secret = false

  explicit_auth_flows = [
    "ADMIN_NO_SRP_AUTH",
    "USER_PASSWORD_AUTH",
  ]

  supported_identity_providers = ["COGNITO"]
}

resource "aws_cognito_user_pool_domain" "sase_domain" {
  domain       = "sase-project"
  user_pool_id = aws_cognito_user_pool.sase_user_pool.id
}