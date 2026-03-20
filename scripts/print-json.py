"""Pretty-print a JSON file."""
import json, sys
with open(sys.argv[1]) as f:
    print(json.dumps(json.load(f), indent=2))
