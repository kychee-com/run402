import json, sys

fname = sys.argv[1]
with open(fname) as f:
    events = json.load(f)

for ev in events:
    print(f"=== {ev.get('error_class', '?')}: {(ev.get('message') or '')[:200]}")
    print(f"    Received: {ev.get('received_at', '?')}")
    print(f"    Severity: {ev.get('severity', '?')}")
    print(f"    Unhandled: {ev.get('unhandled', '?')}")

    # Request info
    req = ev.get("request", {})
    if req:
        print(f"    URL: {req.get('url', '?')}")
        print(f"    Method: {req.get('httpMethod', '?')}")

    # Context
    ctx = ev.get("context", "")
    if ctx:
        print(f"    Context: {ctx}")

    # Stacktrace (first exception, top frames)
    exceptions = ev.get("exceptions", [])
    for exc in exceptions[:1]:
        print(f"    Exception: {exc.get('errorClass', '?')}: {(exc.get('message') or '')[:200]}")
        frames = exc.get("stacktrace", [])
        for fr in frames[:8]:
            f_file = fr.get("file", "?")
            f_method = fr.get("method", "?")
            f_line = fr.get("lineNumber", "?")
            in_proj = fr.get("inProject", False)
            marker = " <--" if in_proj else ""
            print(f"      {f_file}:{f_line} in {f_method}{marker}")

    # Metadata
    meta = ev.get("metaData", {})
    for section, data in meta.items():
        if section in ("request", "device"):
            continue
        print(f"    [{section}]")
        if isinstance(data, dict):
            for k, v in data.items():
                val_str = str(v)[:200]
                print(f"      {k}: {val_str}")
    print()
