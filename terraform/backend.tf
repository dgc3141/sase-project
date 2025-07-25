# terraform {
#   backend "s3" {
#     bucket = "my-terraform-state-bucket"
#     key    = "sase-project/terraform.tfstate"
#     region = "ap-northeast-1"
#     dynamodb_table = "terraform-state-lock"
#   }
# }

# For local development, use local backend
terraform {
  backend "local" {
    path = "terraform.tfstate"
  }
}