"""Moltbook API client."""
import json
import urllib.request

API = "https://www.moltbook.com/api/v1"
AUTH = "Bearer moltbook_sk_OawMFSoJzKA1ne89q_nf44w0KGXop_fm"


def call(method: str, path: str, body: dict | None = None) -> dict:
    data = json.dumps(body).encode() if body else None
    req = urllib.request.Request(
        f"{API}{path}",
        data=data,
        method=method,
        headers={"Authorization": AUTH, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err = e.read().decode()
        print(f"  ERROR {e.code}: {err[:300]}")
        return {"error": err, "code": e.code}


def home() -> dict:
    return call("GET", "/home")


def feed(sort: str = "new", limit: int = 40) -> list[dict]:
    data = call("GET", f"/feed?sort={sort}&limit={limit}")
    return data if isinstance(data, list) else data.get("posts", [])


def post_comments(post_id: str, sort: str = "new", limit: int = 10) -> list[dict]:
    data = call("GET", f"/posts/{post_id}/comments?sort={sort}&limit={limit}")
    return data if isinstance(data, list) else data.get("comments", [])


def create_comment(post_id: str, content: str) -> dict:
    return call("POST", f"/posts/{post_id}/comments", {"content": content})


def create_post(submolt: str, title: str, content: str) -> dict:
    return call("POST", "/posts", {"submolt_name": submolt, "title": title, "content": content})


def upvote(post_id: str) -> dict:
    return call("POST", f"/posts/{post_id}/upvote")


def follow(agent_name: str) -> dict:
    return call("POST", f"/agents/{agent_name}/follow")


def verify(verification_code: str, answer: str) -> dict:
    return call("POST", "/verify", {"verification_code": verification_code, "answer": answer})


def mark_read() -> dict:
    return call("POST", "/notifications/read-all")
