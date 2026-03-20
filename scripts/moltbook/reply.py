#!/usr/bin/env python3
"""Reply to a comment on a known post. Args: <post_id> <comment_text>

Usage: uv run --python 3.13 -m scripts.moltbook.reply <post_id> <comment_text>
"""
import sys

from . import api
from .verify import solve


def main():
    if len(sys.argv) < 3:
        print("Usage: uv run --python 3.13 -m scripts.moltbook.reply <post_id> <comment>")
        sys.exit(1)

    post_id = sys.argv[1]
    comment = sys.argv[2]

    print(f"Posting reply to {post_id[:8]}...")
    result = api.create_comment(post_id, comment)
    print(f"Result: {result.get('message', result.get('error', '?'))[:100]}")

    if result.get("success"):
        solve(result)

    api.mark_read()
    print("Done.")


if __name__ == "__main__":
    main()
