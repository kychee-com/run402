"""Decode a base64-encoded x402 payment-required header."""
import base64, json, sys

encoded = sys.argv[1]
decoded = base64.b64decode(encoded).decode()
data = json.loads(decoded)
print(json.dumps(data, indent=2))
