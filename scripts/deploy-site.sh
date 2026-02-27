#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-kychee}"
STACK="AgentDB-Site"

echo "Deploying $STACK with profile=$PROFILE..."
eval "$(aws configure export-credentials --profile "$PROFILE" --format env)"
cd "$(dirname "$0")/../infra"
npx cdk deploy "$STACK" --require-approval broadening
