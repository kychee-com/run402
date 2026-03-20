"""Check Run402 endpoints and compare metadata with other services on the CDP x402 Bazaar."""

import json
import urllib.request

url = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=1000"
req = urllib.request.Request(url)
with urllib.request.urlopen(req) as resp:
    data = json.loads(resp.read())

total = data["pagination"]["total"]

# Find run402 entries
matches = [item for item in data["items"] if "run402" in item.get("resource", "")]

print(f"Total Bazaar resources: {total}")
print(f"Run402 endpoints found: {len(matches)}\n")

print("=== Run402 entries (full JSON) ===")
for m in matches:
    print(json.dumps(m, indent=2))
    print()

# Find entries that DO have bazaar metadata for comparison
print("=== Examples with bazaar metadata (first 3) ===")
count = 0
for item in data["items"]:
    for accept in item.get("accepts", []):
        extensions = accept.get("extensions", {})
        if "bazaar" in extensions:
            print(json.dumps(item, indent=2))
            print()
            count += 1
            break
    if count >= 3:
        break

if count == 0:
    # Check for metadata at the top level
    print("No extensions.bazaar found in accepts. Checking top-level metadata...")
    count2 = 0
    for item in data["items"]:
        if "metadata" in item or "extensions" in item:
            print(json.dumps(item, indent=2))
            print()
            count2 += 1
            if count2 >= 3:
                break
    if count2 == 0:
        print("No metadata found at top level either.")
        # Show a sample entry structure
        print("\n=== Sample entry structure ===")
        if data["items"]:
            print(json.dumps(data["items"][0], indent=2))
