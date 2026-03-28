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

# Install runtime dependencies
cp "$SCRIPT_DIR/package.json" "$BUILD_DIR/nodejs/package.json"
cd "$BUILD_DIR/nodejs"
npm install --omit=dev --ignore-scripts 2>&1 | tail -5

# Create the @run402/functions helper as a local module
mkdir -p "$BUILD_DIR/nodejs/node_modules/@run402/functions"
cat > "$BUILD_DIR/nodejs/node_modules/@run402/functions/package.json" << 'PKGJSON'
{
  "name": "@run402/functions",
  "version": "1.0.0",
  "type": "module",
  "main": "index.js"
}
PKGJSON

cat > "$BUILD_DIR/nodejs/node_modules/@run402/functions/index.js" << 'HELPERJS'
/**
 * @run402/functions — helper for serverless functions.
 *
 * Provides:
 *   db.from(table) — PostgREST-style queries
 *   db.sql(query) — raw SQL via gateway
 *   getUser(req) — verify caller's JWT, returns { id, role } or null
 */

import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);
const _jwt = _require("jsonwebtoken");

const API_BASE = process.env.RUN402_API_BASE || "https://api.run402.com";
const PROJECT_ID = process.env.RUN402_PROJECT_ID || "";
const SERVICE_KEY = process.env.RUN402_SERVICE_KEY || "";
const _JWT_SECRET = process.env.RUN402_JWT_SECRET || "";

class QueryBuilder {
  #table;
  #params = new URLSearchParams();
  #method = "GET";
  #body = undefined;

  constructor(table) {
    this.#table = table;
  }

  select(columns = "*") {
    this.#params.set("select", columns);
    return this;
  }

  eq(column, value) {
    this.#params.append(column, `eq.${value}`);
    return this;
  }

  neq(column, value) {
    this.#params.append(column, `neq.${value}`);
    return this;
  }

  gt(column, value) {
    this.#params.append(column, `gt.${value}`);
    return this;
  }

  lt(column, value) {
    this.#params.append(column, `lt.${value}`);
    return this;
  }

  gte(column, value) {
    this.#params.append(column, `gte.${value}`);
    return this;
  }

  lte(column, value) {
    this.#params.append(column, `lte.${value}`);
    return this;
  }

  like(column, pattern) {
    this.#params.append(column, `like.${pattern}`);
    return this;
  }

  ilike(column, pattern) {
    this.#params.append(column, `ilike.${pattern}`);
    return this;
  }

  in(column, values) {
    this.#params.append(column, `in.(${values.join(",")})`);
    return this;
  }

  order(column, { ascending = true } = {}) {
    this.#params.append("order", `${column}.${ascending ? "asc" : "desc"}`);
    return this;
  }

  limit(count) {
    this.#params.set("limit", String(count));
    return this;
  }

  offset(count) {
    this.#params.set("offset", String(count));
    return this;
  }

  insert(data) {
    this.#method = "POST";
    this.#body = Array.isArray(data) ? data : [data];
    return this;
  }

  update(data) {
    this.#method = "PATCH";
    this.#body = data;
    return this;
  }

  delete() {
    this.#method = "DELETE";
    return this;
  }

  async then(resolve, reject) {
    try {
      const qs = this.#params.toString();
      const url = `${API_BASE}/rest/v1/${this.#table}${qs ? "?" + qs : ""}`;

      const headers = {
        apikey: SERVICE_KEY,
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: this.#method === "POST" ? "return=representation" : "return=representation",
      };

      const res = await fetch(url, {
        method: this.#method,
        headers,
        body: this.#body ? JSON.stringify(this.#body) : undefined,
      });

      if (!res.ok) {
        const errBody = await res.text();
        reject(new Error(`PostgREST error (${res.status}): ${errBody}`));
        return;
      }

      const data = await res.json();
      resolve(data);
    } catch (err) {
      reject(err);
    }
  }
}

export const db = {
  from(table) {
    return new QueryBuilder(table);
  },

  async sql(query) {
    const url = `${API_BASE}/projects/v1/admin/${PROJECT_ID}/sql`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SERVICE_KEY}`,
        "Content-Type": "text/plain",
      },
      body: query,
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`SQL error (${res.status}): ${errBody}`);
    }

    return res.json();
  },
};

/**
 * Verify the caller's JWT and return user identity.
 * Returns { id, role } or null if unauthenticated/invalid.
 */
export function getUser(req) {
  const authHeader = req.headers.get
    ? req.headers.get("authorization")
    : req.headers?.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) return null;
  const token = authHeader.slice(7);
  try {
    const payload = _jwt.verify(token, _JWT_SECRET);
    if (payload.project_id !== PROJECT_ID) return null;
    return { id: payload.sub, role: payload.role };
  } catch {
    return null;
  }
}

/**
 * Email helper — send emails via the project's mailbox.
 *
 * Usage:
 *   email.send({ to, subject, html })               // raw mode
 *   email.send({ to, template, variables })          // template mode
 *   email.send({ to, subject, html, from_name })     // with display name
 */
export const email = (() => {
  let _mailboxId = null;

  async function _discoverMailbox() {
    if (_mailboxId) return _mailboxId;
    const res = await fetch(API_BASE + "/mailboxes/v1", {
      headers: { Authorization: "Bearer " + SERVICE_KEY },
    });
    if (!res.ok) throw new Error("Failed to discover mailbox: " + await res.text());
    const data = await res.json();
    if (!data.mailboxes || data.mailboxes.length === 0) {
      throw new Error("No mailbox configured for this project");
    }
    _mailboxId = data.mailboxes[0].mailbox_id;
    return _mailboxId;
  }

  return {
    async send(opts) {
      const mbxId = await _discoverMailbox();
      const body = { to: opts.to };
      if (opts.template) {
        body.template = opts.template;
        body.variables = opts.variables || {};
      } else {
        body.subject = opts.subject;
        body.html = opts.html;
        if (opts.text) body.text = opts.text;
      }
      if (opts.from_name) body.from_name = opts.from_name;
      const res = await fetch(API_BASE + "/mailboxes/v1/" + mbxId + "/messages", {
        method: "POST",
        headers: { Authorization: "Bearer " + SERVICE_KEY, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = await res.text();
        let msg;
        try { msg = JSON.parse(errBody).error || errBody; } catch { msg = errBody; }
        throw new Error("Email send failed (" + res.status + "): " + msg);
      }
      return res.json();
    },
  };
})();
HELPERJS

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
