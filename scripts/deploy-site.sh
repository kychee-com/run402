#!/usr/bin/env bash
set -euo pipefail

PROFILE="${AWS_PROFILE:-kychee}"
STACK="AgentDB-Site"

echo "Deploying $STACK with profile=$PROFILE..."
cd "$(dirname "$0")/../infra"
npx cdk deploy "$STACK" --profile "$PROFILE" --require-approval broadening
