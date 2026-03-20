#!/usr/bin/env python3
"""Find full post UUID from prefix. Args: <prefix>"""
import sys
from . import api


def main():
    prefix = sys.argv[1] if len(sys.argv) > 1 else ""
    # Check home activity first
    home = api.home()
    for a in home.get("activity_on_your_posts", []):
        if a["post_id"].startswith(prefix):
            print(a["post_id"])
            return
    # Check feed
    for p in api.feed():
        if p.get("id", "").startswith(prefix):
            print(p["id"])
            return
    print(f"NOT FOUND: {prefix}")


if __name__ == "__main__":
    main()
