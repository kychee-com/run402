#!/usr/bin/env bash
# Build and publish the Run402 Functions Lambda layer.
#
# Usage:
#   ./build-layer.sh [--publish]
#
# Without --publish, builds the layer zip locally.
# With --publish, also publishes to AWS Lambda.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/.layer-build"
LAYER_NAME="run402-functions-runtime"
REGION="${AWS_REGION:-us-east-1}"
PROFILE="${AWS_PROFILE:-kychee}"

echo "Building Lambda layer: $LAYER_NAME"

# Clean previous build
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/nodejs"

# Install runtime dependencies (convenience packages users can import)
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/nodejs/package.json"
cd "$BUILD_DIR/nodejs"
npm install --omit=dev --ignore-scripts 2>&1 | tail -5

# Create @run402/functions alias so `import { db } from '@run402/functions'` resolves
mkdir -p "$BUILD_DIR/nodejs/node_modules/@run402"
ln -s ../run402-functions "$BUILD_DIR/nodejs/node_modules/@run402/functions"

# Build zip
cd "$BUILD_DIR"
ZIP_FILE="$SCRIPT_DIR/$LAYER_NAME.zip"
rm -f "$ZIP_FILE"
zip -r "$ZIP_FILE" nodejs/ -x "*.ts" > /dev/null

LAYER_SIZE=$(du -sh "$ZIP_FILE" | cut -f1)
echo "Layer built: $ZIP_FILE ($LAYER_SIZE)"

# Publish if requested
if [[ "${1:-}" == "--publish" ]]; then
  echo "Publishing layer to AWS..."
  LAYER_ARN=$(aws lambda publish-layer-version \
    --layer-name "$LAYER_NAME" \
    --compatible-runtimes "nodejs22.x" \
    --zip-file "fileb://$ZIP_FILE" \
    --region "$REGION" \
    --profile "$PROFILE" \
    --query 'LayerVersionArn' \
    --output text)
  echo "Published: $LAYER_ARN"
  echo ""
  echo "Set this in your environment:"
  echo "  LAMBDA_LAYER_ARN=$LAYER_ARN"
fi

# Cleanup
rm -rf "$BUILD_DIR"
echo "Done."
