#!/usr/bin/env python3
"""Smoke test: multiple users asking questions at the same time."""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import time
import urllib.error
import urllib.request


def login(base_url: str, username: str, password: str) -> str:
    payload = json.dumps({"username": username, "password": password}).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/login",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        cookies = resp.headers.get_all("Set-Cookie") or []
    if not cookies:
        raise RuntimeError(f"login failed for {username}: no session cookie")
    return "; ".join(part.split(";", 1)[0] for part in cookies)


def ask(base_url: str, cookie: str, query: str, user_label: str) -> dict:
    started = time.time()
    payload = json.dumps(
        {
            "message": query,
            "response_mode": "blocking",
        },
        ensure_ascii=False,
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/api/chat",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Cookie": cookie,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            body = resp.read().decode("utf-8", errors="replace")
        elapsed = time.time() - started
        data = json.loads(body) if body else {}
        answer = (data.get("answer") or data.get("message") or "")[:120]
        return {
            "user": user_label,
            "ok": True,
            "seconds": round(elapsed, 2),
            "preview": answer,
        }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        return {
            "user": user_label,
            "ok": False,
            "seconds": round(time.time() - started, 2),
            "preview": f"HTTP {exc.code}: {detail[:200]}",
        }
    except Exception as exc:  # noqa: BLE001
        return {
            "user": user_label,
            "ok": False,
            "seconds": round(time.time() - started, 2),
            "preview": f"{type(exc).__name__}: {exc}",
        }


def main() -> int:
    parser = argparse.ArgumentParser(description="Concurrent chat smoke test")
    parser.add_argument("--base-url", default="http://127.0.0.1:5002")
    parser.add_argument("--password", default="admin")
    parser.add_argument("--users", default="admin,user2,user3")
    parser.add_argument("--query", default="风力发电的原理是什么？")
    args = parser.parse_args()

    usernames = [name.strip() for name in args.users.split(",") if name.strip()]
    if not usernames:
        print("no users provided", file=sys.stderr)
        return 2

    cookies = {}
    for username in usernames:
        cookies[username] = login(args.base_url, username, args.password)

    started = time.time()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(usernames)) as pool:
        futures = [
            pool.submit(ask, args.base_url, cookies[name], args.query, name)
            for name in usernames
        ]
        results = [future.result() for future in concurrent.futures.as_completed(futures)]

    ok_count = sum(1 for item in results if item["ok"])
    print(json.dumps(results, ensure_ascii=False, indent=2))
    print(
        f"\n{ok_count}/{len(results)} succeeded in {round(time.time() - started, 2)}s "
        f"({len(usernames)} users in parallel)"
    )
    return 0 if ok_count == len(results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
