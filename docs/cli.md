Below is a **DynamoDB‑CLI‑compatible** design for a `run402` command that preserves AWS muscle memory as much as possible.

The goal is that for the common CRUD + table lifecycle operations, you can **almost always** do:

* Replace `aws dynamodb` with `run402 db` (or `run402 dynamodb`)
* Keep the rest of the command line the same

Example (yours):

```bash
aws dynamodb get-item --table-name MyTable --key '{"id":{"S":"123"}}'
run402 db get-item  --table-name MyTable --key '{"id":{"S":"123"}}'
```

---

## 1) CLI identity and compatibility contract

### Command shape (AWS-style)

`run402 [global options] <service> <operation> [parameters]`

### Service aliases

* `run402 db ...`  ✅ (short)
* `run402 dynamodb ...` ✅ (drop-in mental model)

### Compatibility contract

**For supported operations**, `run402 db` will:

* Accept the **same parameters** as the AWS CLI DynamoDB command references (AWS CLI v2 style) for the subset we implement (see scope below). ([AWS Documentation][1])
* Accept DynamoDB **AttributeValue JSON** (`{"S":...,"N":...,"M":...,"L":...}` etc.) exactly as AWS CLI examples and docs describe. ([AWS Documentation][2])
* Return response JSON shaped like AWS CLI outputs (e.g., `{"Item": ...}`, `{"TableDescription": ...}`), plus optional run402 extensions under a dedicated field (off by default).

---

## 2) Supported scope (v1)

You asked for “as close as possible” but not 100%. Here’s the intentional scope.

### ✅ Supported control-plane commands (table lifecycle)

| Command                                       | Status      | Notes                                                                                                                                                                                                                       |
| --------------------------------------------- | ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list-tables`                                 | ✅           | Supports AWS pagination flags `--starting-token`, `--page-size`, `--max-items`. ([AWS Documentation][3])                                                                                                                    |
| `describe-table`                              | ✅           | `--table-name` only. ([AWS Documentation][4])                                                                                                                                                                               |
| `create-table`                                | ✅ (limited) | Supports `--table-name`, `--attribute-definitions`, `--key-schema`, `--billing-mode`. **No GSIs/LSIs/streams** in v1. AWS has many more options; we will error if you try to use unsupported ones. ([AWS Documentation][5]) |
| `delete-table`                                | ✅           | `--table-name` only. ([AWS Documentation][6])                                                                                                                                                                               |
| `update-time-to-live`                         | ✅           | Supports `--time-to-live-specification Enabled=...,AttributeName=...` ([AWS Documentation][7])                                                                                                                              |
| `describe-time-to-live`                       | ✅           | `--table-name` only. ([AWS Documentation][8])                                                                                                                                                                               |
| `wait table-exists` / `wait table-not-exists` | ✅           | Parity with AWS waiters (behavioral equivalent).                                                                                                                                                                            |

### ✅ Supported data-plane commands (CRUD/query)

| Command            | Status            | Notes                                                                                                                                                         |
| ------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-item`         | ✅                 | Supports `--key`, `--consistent-read`, `--projection-expression`, `--expression-attribute-names`, `--return-consumed-capacity`. ([AWS Documentation][1])      |
| `put-item`         | ✅                 | Supports conditional puts and expressions, `--return-values`, `--return-consumed-capacity`. ([AWS Documentation][2])                                          |
| `update-item`      | ✅                 | Supports `--update-expression`, `--condition-expression`, `--expression-attribute-*`, `--return-values`. ([AWS Documentation][9])                             |
| `delete-item`      | ✅                 | Supports condition/expression flags and `--return-values`. ([AWS Documentation][10])                                                                          |
| `query`            | ✅ (no indexes v1) | Supports `--key-condition-expression`, `--filter-expression`, `--projection-expression`, pagination. `--index-name` errors for now. ([AWS Documentation][11]) |
| `scan`             | ⚠️ guarded        | Supported **only with an explicit run402 override** (see below), because scans are easy to abuse/costly. AWS supports scan broadly. ([AWS Documentation][12])  |
| `batch-get-item`   | ✅                 | Supports `--request-items`. ([AWS Documentation][13])                                                                                                         |
| `batch-write-item` | ✅                 | Supports `--request-items` (PutRequest/DeleteRequest). ([AWS Documentation][14])                                                                              |

### ❌ Not supported in v1 (explicit)

* Transactions: `transact-write-items`, `transact-get-items`
* Secondary indexes (LSI/GSI) creation/query
* Streams
* PartiQL (`execute-statement`, `batch-execute-statement`)
* Import/export, PITR backups, global tables (unless you choose to add a “multi-region tier” later)

If you call an unsupported operation or pass unsupported flags, you get a **hard error** (never silently ignored).

---

## 3) Global options (AWS-like) + run402 extensions

### AWS-like global options (supported)

* `--endpoint-url` (points to run402 API gateway; default configured)
* `--region` (maps to run402 “service region”)
* `--profile` (selects a run402 profile)
* `--output`, `--query`, `--no-cli-pager`
* `--cli-read-timeout`, `--cli-connect-timeout`
* `--cli-binary-format` (for Binary attributes parity)
* `--cli-input-json | --cli-input-yaml`, `--generate-cli-skeleton` (optional but recommended for parity)

These appear in AWS CLI DynamoDB command synopses and are worth matching to make scripts portable. ([AWS Documentation][1])

### run402-specific global extensions (namespaced to avoid collisions)

All run402-only flags start with `--run402-` so you can copy/paste AWS CLI commands unchanged and only add run402 controls when needed.

**Payment + approvals**

* `--run402-pay ask|auto|never` (default: `ask`)
* `--run402-max-pay-usd <float>` (cap for auto-pay)
* `--run402-approval ask|auto|never` (default: `ask`) *(v1.1)*
* `--run402-approval-url` (print-only; outputs a URL if approval is required) *(v1.1)*
* `--run402-noninteractive` (never prompt; return machine-readable “payment/approval required” JSON + exit code)

**Resource safety defaults**

* `--run402-ttl <duration>` (e.g., `7d`, `24h`) for `create-table` if you want explicit per-call TTL
* `--run402-max-spend-usd <float>` (hard lifetime cap for the table lease)
* `--run402-daily-cap-usd <float>` (optional)
* `--run402-include-billing` (adds a `Run402Billing` object to outputs; off by default)

**Scan guardrails**

* `--run402-allow-scan` (required to run `scan`)
* `--run402-scan-max-items <int>` (hard cap)
* `--run402-scan-max-mb <int>` (hard cap)

---

## 4) Config that feels like `aws configure`

### `run402 configure`

Interactive prompt modeled after AWS CLI, but instead of AWS access keys you set payment/policy defaults.

Prompts:

* Default endpoint URL
* Default region
* Default output format
* Default table TTL (e.g., 7d)
* Default max spend USD (e.g., 3.00)
* Payment mode (`ask`/`auto`/`never`)
* Max auto-pay USD
* Approval policy threshold (optional)

### File format (INI, AWS-like)

Path: `~/.run402/config`

Example:

```ini
[default]
region = us-east-1
output = json
endpoint_url = https://app.run402.com
run402_default_ttl = 7d
run402_default_max_spend_usd = 3.00
run402_pay = ask
run402_max_auto_pay_usd = 0.50

[profile work]
region = eu-west-1
run402_default_max_spend_usd = 25.00
run402_pay = auto
run402_max_auto_pay_usd = 1.00
```

This preserves the familiar `--profile` workflow from AWS CLI.

---

## 5) DynamoDB JSON compatibility (AttributeValue)

To match AWS CLI, keys and items use DynamoDB AttributeValue objects:

* String: `{"S":"hello"}`
* Number: `{"N":"123.45"}`
* Binary (base64): `{"B":"..."}`
* Map: `{"M": { "a": {"S":"x"} }}`
* List: `{"L": [ {"S":"x"}, {"N":"1"} ]}`
* Sets: `{"SS":[...], "NS":[...], "BS":[...]}`

This is exactly the format described in the AWS CLI references for item and expression values. ([AWS Documentation][2])

---

## 6) Payment + approval behavior (the big difference vs AWS)

AWS DynamoDB calls don’t have a payment step. Your wrapper does.

### When run402 will require payment

* `create-table` (fund the table lease / minimum deposit)
* Any operation when balance is low or cap would be exceeded
* Optional: log retention upgrades, TTL extension

### Interactive default (`--run402-pay ask`)

If the server replies with **HTTP 402 Payment Required** (x402 style), the CLI prints a prompt:

```txt
Payment required to continue (x402):
  Operation: db create-table
  Table: MyTable
  Required deposit: $1.50
  Cap (lifetime): $3.00
Approve & pay now? [y/N]
```

*(v1.1)* If approval is required (policy threshold exceeded), CLI prints:

```txt
Approval required:
  Estimated range: $0.35–$1.10
  Cap requested: $3.00
Open approval link:
  https://app.run402.com/approve/ap_...
```

### Non-interactive mode (`--run402-noninteractive`)

The CLI exits with:

* exit code `3` = payment required (not paid)
* exit code `4` = approval required (not granted) *(v1.1)*

And prints JSON such as:

```json
{
  "error": "ApprovalRequired",
  "approval_url": "https://app.run402.com/approve/ap_01J...",
  "requested_cap_usd": 3.0,
  "estimated_cost_range_usd": {"low": 0.35, "high": 1.10}
}
```

This is what you want for **agents**: they can display the quote and route the human to approve.

---

## 7) Command examples (AWS → run402)

### 7.1 `get-item` (exact drop-in)

AWS CLI flags here include `--table-name`, `--key`, optional `--consistent-read`, `--projection-expression`, etc. ([AWS Documentation][1])

```bash
run402 db get-item \
  --table-name MyTable \
  --key '{"id":{"S":"123"}}'
```

### 7.2 `put-item`

AWS CLI synopsis shows `--item`, expression flags, and `--return-values`, etc. ([AWS Documentation][2])

```bash
run402 db put-item \
  --table-name MyTable \
  --item '{"id":{"S":"123"},"email":{"S":"a@b.com"}}' \
  --return-consumed-capacity TOTAL
```

### 7.3 `query`

AWS CLI synopsis includes `--key-condition-expression`, `--expression-attribute-values`, `--filter-expression`, pagination flags. ([AWS Documentation][11])

```bash
run402 db query \
  --table-name MyTable \
  --key-condition-expression "id = :v" \
  --expression-attribute-values '{":v":{"S":"123"}}' \
  --limit 20
```

### 7.4 `create-table` (AWS-like args, run402 safety extensions)

AWS CLI `create-table` supports many options. We support the core ones and will reject unsupported ones in v1. ([AWS Documentation][5])

```bash
run402 db create-table \
  --table-name MyTable \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --run402-ttl 7d \
  --run402-max-spend-usd 3.00
```

### 7.5 TTL parity (`update-time-to-live` / `describe-time-to-live`)

AWS CLI TTL commands and shorthand syntax are well-defined. ([AWS Documentation][7])

```bash
run402 db update-time-to-live \
  --table-name MyTable \
  --time-to-live-specification Enabled=true,AttributeName=ttl
```

```bash
run402 db describe-time-to-live --table-name MyTable
```

### 7.6 `scan` (guarded)

AWS supports scan broadly; it’s paginated and has many flags. ([AWS Documentation][12])
run402 requires explicit opt-in:

```bash
run402 db scan \
  --table-name MyTable \
  --run402-allow-scan \
  --run402-scan-max-items 1000
```

---

## 8) Output compatibility (AWS-like), with optional run402 extensions

### Default output (AWS-shaped)

Example `get-item` output (AWS-like):

```json
{
  "Item": {
    "id": {"S":"123"},
    "email": {"S":"a@b.com"}
  },
  "ConsumedCapacity": {
    "TableName": "MyTable",
    "CapacityUnits": 0.5
  }
}
```

### Optional run402 fields (only with `--run402-include-billing`)

```json
{
  "Item": { "...": "..." },
  "ConsumedCapacity": { "...": "..." },
  "Run402Billing": {
    "estimated_cost_usd": 0.0000008,
    "balance_remaining_usd": 2.41,
    "cap_remaining_usd": 2.41,
    "request_id": "req_01J..."
  }
}
```

This keeps compatibility clean by default, while still enabling cost transparency when you want it.

---

## 9) What makes this “AWS-like” in practice

1. **Same command names**: `get-item`, `put-item`, `query`, etc. ([AWS Documentation][1])
2. **Same parameter names**: `--table-name`, `--key`, `--item`, expression parameters. ([AWS Documentation][1])
3. **Same DynamoDB JSON shapes** for item/keys/expression values. ([AWS Documentation][2])
4. **Same pagination ergonomics**: `--starting-token`, `--page-size`, `--max-items`. ([AWS Documentation][3])
5. **Strict errors** when you use features we haven’t implemented (indexes, transactions) so users don’t think they’re protected when they aren’t.

---

## 10) Next step: do you want *AWS CLI argument parsing exactness*?

If you want *maximum* drop-in compatibility (including odd edge behaviors like shorthand parsing quirks and skeleton generation), the most robust approach is:

* Implement `run402 db` using the **same parameter models** as the AWS CLI docs for each supported command (synopsis/options).
* Enforce a **compatibility test suite**:

  * take real AWS CLI DynamoDB examples
  * run them through `run402 db ...`
  * compare request objects and response shapes

If you want, I can produce:

* a **complete command-by-command “supported flags” matrix** (down to every option in each synopsis we support),
* and a **golden test corpus** built from AWS CLI docs for `get-item`, `put-item`, `query`, `update-item`, `batch-*`, `create-table`, TTL, scan. ([AWS Documentation][1])

[1]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/get-item.html "get-item — AWS CLI 2.33.8 Command Reference"
[2]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/put-item.html "put-item — AWS CLI 2.33.22 Command Reference"
[3]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/list-tables.html "list-tables — AWS CLI 2.33.28 Command Reference"
[4]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/describe-table.html "describe-table — AWS CLI 2.33.22 Command Reference"
[5]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/create-table.html "create-table — AWS CLI 2.33.19 Command Reference"
[6]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/delete-table.html "delete-table — AWS CLI 2.33.21 Command Reference"
[7]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-time-to-live.html "update-time-to-live — AWS CLI 2.33.20 Command Reference"
[8]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/describe-time-to-live.html "describe-time-to-live — AWS CLI 2.33.28 Command Reference"
[9]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/update-item.html "update-item — AWS CLI 2.33.18 Command Reference"
[10]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/delete-item.html "delete-item — AWS CLI 2.33.21 Command Reference"
[11]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/query.html "query — AWS CLI 2.33.20 Command Reference"
[12]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/scan.html "scan — AWS CLI 2.33.19 Command Reference"
[13]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/batch-get-item.html "batch-get-item — AWS CLI 2.33.22 Command Reference"
[14]: https://docs.aws.amazon.com/cli/latest/reference/dynamodb/batch-write-item.html "batch-write-item — AWS CLI 2.33.19 Command Reference"
