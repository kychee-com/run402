#!/usr/bin/env python3
"""Reply to a comment on a known post. Args: <post_id> <comment_text>

Usage: uv run --python 3.13 -m scripts.moltbook.reply <post_id> <comment_text>
"""
import sys

from . import api
from .verify import solve
from .replied import mark_dashboard_replied, mark_feed_replied


def main():
    if len(sys.argv) < 3:
        print("Usage: uv run --python 3.13 -m scripts.moltbook.reply <post_id> <comment> [--dashboard-author <name>]")
        sys.exit(1)

    post_id = sys.argv[1]
    comment = sys.argv[2]

    # Track dashboard reply dedup if --dashboard-author is passed
    dashboard_author = None
    if "--dashboard-author" in sys.argv:
        idx = sys.argv.index("--dashboard-author")
        if idx + 1 < len(sys.argv):
            dashboard_author = sys.argv[idx + 1]

    # Optimistic locking: mark BEFORE posting to prevent duplicates from timed-out runs
    mark_feed_replied(post_id)
    print(f"Marked feed reply: {post_id[:8]}")
    if dashboard_author:
        mark_dashboard_replied(post_id, dashboard_author)
        print(f"Marked dashboard reply: {post_id[:8]}:{dashboard_author}")

    print(f"Posting reply to {post_id[:8]}...")
    result = api.create_comment(post_id, comment)
    print(f"Result: {result.get('message', result.get('error', '?'))[:100]}")

    if result.get("success"):
        solve(result)

    api.mark_read()
    print("Done.")


if __name__ == "__main__":
    main()
