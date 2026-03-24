import json

with open("/Users/talweiss/Developer/run402/bugsnag_errors.json") as f:
    errors = json.load(f)

for e in errors:
    status = e.get("status", "?")
    cls = e.get("error_class", "?")
    msg = (e.get("message") or "")[:120]
    last = e.get("last_seen", "?")
    events = e.get("events", "?")
    users = e.get("users", "?")
    eid = e.get("id", "?")
    first = e.get("first_seen", "?")
    print(f"[{status}] {cls}: {msg}")
    print(f"  Last seen: {last} | First seen: {first} | Events: {events} | Users: {users}")
    print(f"  ID: {eid}")
    print()
