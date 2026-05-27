#!/usr/bin/env python3
"""Read macOS Chrome cookies for a domain, output Playwright Cookie[] JSON to stdout.

Usage:
  uv run scripts/read-chrome-cookies.py <domain>
  # e.g. uv run scripts/read-chrome-cookies.py scys.com
"""
import sys
import json
from pycookiecheat import chrome_cookies


def main() -> None:
    if len(sys.argv) != 2:
        print("Usage: read-chrome-cookies.py <domain>", file=sys.stderr)
        sys.exit(1)
    domain = sys.argv[1]
    url = f"https://{domain}/"
    cookies_dict = chrome_cookies(url)
    out = []
    for name, value in cookies_dict.items():
        out.append({
            "name": name,
            "value": value,
            "domain": f".{domain}",
            "path": "/",
            "secure": True,
            "httpOnly": False,
            "sameSite": "Lax",
        })
    print(json.dumps(out))


if __name__ == "__main__":
    main()
