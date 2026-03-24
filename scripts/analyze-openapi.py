"""Analyze the existing site/openapi.json for x-payment-info and guidance."""
import json

with open("site/openapi.json") as f:
    spec = json.load(f)

print("Version:", spec.get("openapi"))
print("Has guidance:", "guidance" in spec.get("info", {}))
print()

paths = spec.get("paths", {})
print(f"Paths ({len(paths)}):")
for path, methods in paths.items():
    for method, op in methods.items():
        if not isinstance(op, dict):
            continue
        has_xpi = "x-payment-info" in op
        has_402 = "402" in op.get("responses", {})
        has_input = bool(op.get("requestBody", {}).get("content", {}).get("application/json", {}).get("schema"))
        summary = op.get("summary", "")[:60]
        flags = []
        if has_xpi: flags.append("x-payment-info")
        if has_402: flags.append("402")
        if has_input: flags.append("input-schema")
        print(f"  {method.upper():6} {path:40} [{', '.join(flags)}] {summary}")
