#!/usr/bin/env bash
set -euo pipefail

# AgentDB deployment script
# Usage: ./scripts/deploy.sh

REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="AgentDB-Pod01"

echo "=== AgentDB Deploy ==="
echo "Region: $REGION"
echo "Stack:  $STACK_NAME"
echo ""

# 1. Build shared package
echo "1) Building shared package..."
npm run build -w packages/shared

# 2. Build gateway
echo "2) Building gateway..."
npm run build -w packages/gateway

# 3. Get ECR repo URI from stack outputs
echo "3) Getting ECR repo URI..."
ECR_URI=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='EcrRepoUri'].OutputValue" \
  --output text)

if [ -z "$ECR_URI" ]; then
  echo "ERROR: Could not find ECR repo URI. Is the stack deployed?"
  echo "Run: cd infra && npx cdk deploy"
  exit 1
fi

echo "   ECR: $ECR_URI"

# 4. Docker build + push
echo "4) Building Docker image..."
docker build -t agentdb-gateway -f packages/gateway/Dockerfile .

echo "5) Pushing to ECR..."
aws ecr get-login-password --region "$REGION" | docker login --username AWS --password-stdin "$ECR_URI"
docker tag agentdb-gateway:latest "$ECR_URI:latest"
docker push "$ECR_URI:latest"

# 6. Force ECS service update
echo "6) Updating ECS service..."
CLUSTER_ARN=$(aws ecs list-clusters --region "$REGION" --query "clusterArns[?contains(@, 'AgentDB')]" --output text)
SERVICE_ARN=$(aws ecs list-services --cluster "$CLUSTER_ARN" --region "$REGION" --query "serviceArns[0]" --output text)

aws ecs update-service \
  --cluster "$CLUSTER_ARN" \
  --service "$SERVICE_ARN" \
  --force-new-deployment \
  --region "$REGION" \
  --no-cli-pager

echo ""
echo "=== Deployment initiated ==="
echo "ECS will rolling-deploy the new image."
echo "Monitor: aws ecs describe-services --cluster $CLUSTER_ARN --services $SERVICE_ARN --region $REGION"
echo ""

# 7. Wait for deployment stability (optional)
if [ "${WAIT:-false}" = "true" ]; then
  echo "Waiting for service stability..."
  aws ecs wait services-stable \
    --cluster "$CLUSTER_ARN" \
    --services "$SERVICE_ARN" \
    --region "$REGION"
  echo "Service stable!"
fi

# 8. Run E2E test
echo ""
echo "=== Running E2E test ==="
BASE_URL="https://api.run402.com" npm run test:e2e
