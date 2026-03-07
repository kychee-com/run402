#!/usr/bin/env bash
set -euo pipefail

# AgentDB manual deployment script
# Usage: ./scripts/deploy.sh [-y]
# Uses docker buildx for cross-platform (ARM → amd64) builds
#
# NOTE: The normal deploy path is pushing to main, which triggers
# .github/workflows/deploy-gateway.yml automatically.
# This script is for manual/emergency deploys only.

if [[ "${1:-}" != "-y" ]]; then
  echo "⚠  You're about to deploy the gateway manually."
  echo "   The normal path is to push to main — GitHub Actions deploys automatically."
  echo ""
  read -rp "Are you sure? [y/N] " confirm
  if [[ "$confirm" != [yY] ]]; then
    echo "Aborted. Push to main instead."
    exit 0
  fi
fi

REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-kychee}"
STACK_NAME="AgentDB-Pod01"

echo "=== AgentDB Deploy ==="
echo "Region:  $REGION"
echo "Profile: $PROFILE"
echo "Stack:   $STACK_NAME"
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
  --profile "$PROFILE" \
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

# 4. ECR login
echo "4) Logging in to ECR..."
aws ecr get-login-password --profile "$PROFILE" --region "$REGION" \
  | docker login --username AWS --password-stdin "${ECR_URI%%/*}"

# 5. Docker buildx (cross-platform amd64) + push
echo "5) Building and pushing Docker image (linux/amd64)..."
docker buildx build \
  --platform linux/amd64 \
  -t "$ECR_URI:latest" \
  --push \
  -f packages/gateway/Dockerfile .

# 6. Force ECS service update
echo "6) Updating ECS service..."
CLUSTER_ARN=$(aws ecs list-clusters --profile "$PROFILE" --region "$REGION" \
  --query "clusterArns[?contains(@, 'AgentDB')]" --output text)
SERVICE_ARN=$(aws ecs list-services --profile "$PROFILE" --cluster "$CLUSTER_ARN" --region "$REGION" \
  --query "serviceArns[0]" --output text)

aws ecs update-service \
  --profile "$PROFILE" \
  --cluster "$CLUSTER_ARN" \
  --service "$SERVICE_ARN" \
  --force-new-deployment \
  --region "$REGION" \
  --no-cli-pager

echo ""
echo "=== Deployment initiated ==="
echo "ECS will rolling-deploy the new image."
echo ""

# 7. Wait for deployment stability
echo "Waiting for service stability..."
aws ecs wait services-stable \
  --profile "$PROFILE" \
  --cluster "$CLUSTER_ARN" \
  --services "$SERVICE_ARN" \
  --region "$REGION"
echo "Service stable!"

# 8. Health check
echo ""
echo "=== Health check ==="
curl -sf https://api.run402.com/health | python3 -m json.tool
echo ""
echo "=== Deploy complete ==="
