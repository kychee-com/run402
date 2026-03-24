#!/usr/bin/env python3
"""Moltbook engagement cycle: check dashboard, find candidates, print summary.

Usage: uv run --python 3.13 scripts/moltbook/cycle.py
"""
import sys
import time

from . import api
from .replied import ALREADY_REPLIED, SKIP_TOPICS, INFRA_KEYWORDS


def has_non_latin(s: str) -> bool:
    return sum(1 for c in s if ord(c) > 0x2FF) > len(s) * 0.15


def check_dashboard() -> list[dict]:
    """Check home dashboard for new activity. Returns reply-worthy items."""
    print("=== DASHBOARD ===")
    home = api.home()
    print(f"Karma: {home.get('your_account', {}).get('karma', '?')}")

    activity = home.get("activity_on_your_posts", [])
    reply_targets = []

    for a in activity:
        n = a.get("new_notification_count", 0)
        if n == 0:
            continue
        pid = a["post_id"]
        print(f"  [{pid[:8]}] {n} new — {a['post_title'][:60]}")
        print(f"    From: {', '.join(a.get('latest_commenters', []))}")
        comments = api.post_comments(pid, limit=5)
        for c in comments[:4]:
            au = c.get("author", {}).get("name", "?")
            if au != "run402":
                karma = c.get("author", {}).get("karma") or 0
                content = c.get("content", "")
                print(f"    > {au} ({karma}k): {content[:220]}")
                if karma > 100 or "@run402" in content.lower():
                    reply_targets.append({
                        "pid": pid, "author": au, "karma": karma,
                        "content": content, "title": a["post_title"],
                    })
        time.sleep(0.3)

    if not reply_targets:
        print("  No new activity" if not activity else "  No high-value replies")
    return reply_targets


def find_candidates(min_score: int = 3) -> list[dict]:
    """Search feed for relevant posts to comment on."""
    print(f"\n=== FEED (score>={min_score}) ===")
    posts = api.feed(sort="new", limit=40)
    candidates = []

    for p in posts:
        pid = p.get("id", "")
        if pid[:8] in ALREADY_REPLIED:
            continue
        au = p.get("author", {}).get("name", "")
        if au == "run402":
            continue

        title = p.get("title") or ""
        content = p.get("content") or p.get("content_preview") or ""
        blob = (title + " " + content).lower()

        if "mbc-20" in blob or "mbc20" in blob or '"op":"mint"' in blob:
            continue
        if any(s in blob for s in SKIP_TOPICS):
            continue
        if has_non_latin(title + content):
            continue

        score = sum(1 for k in INFRA_KEYWORDS if k in blob)
        if score >= min_score:
            candidates.append({
                "score": score,
                "karma": p.get("author", {}).get("karma", 0),
                "pid": pid,
                "author": au,
                "submolt": p.get("submolt", {}).get("name", p.get("submolt_name", "?")),
                "title": title,
                "content": content[:400],
            })

    candidates.sort(key=lambda x: (-x["score"], -x["karma"]))
    print(f"Candidates: {len(candidates)}")
    for c in candidates[:6]:
        print(f"  [{c['pid'][:8]}] s={c['score']} {c['author']} ({c['karma']}k) ({c['submolt']}): {c['title'][:65]}")
        print(f"    {c['content'][:150]}")
        print()

    return candidates


def main():
    replies = check_dashboard()
    candidates = find_candidates()
    api.mark_read()

    if not replies and not candidates:
        print("\nQuiet cycle — nothing to engage with.")
    else:
        print(f"\nSummary: {len(replies)} reply targets, {len(candidates)} candidates")

    print("Done.")


if __name__ == "__main__":
    main()
