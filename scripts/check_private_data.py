#!/usr/bin/env python3
"""Fail if tracked files look like they hold bank details or Irish PPS numbers.

Usage: python3 scripts/check_private_data.py

Checks every file in `git ls-files` for:
- IBAN-like strings (country code, check digits, then the account part,
  with or without spaces). Flagged if the mod-97 check passes, or if it
  has the shape of an Irish IBAN.
- PPS numbers: 7 digits then 1 or 2 letters.

Skips images, other binary files and mcp/package-lock.json.
To allow a line on purpose, add `private-data: allow` to that line.

Standard library only.
"""
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_FILES = {"mcp/package-lock.json"}
SKIP_EXT = {
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".ico", ".pdf",
    ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz",
}
ALLOW = "private-data: allow"

IBAN_RE = re.compile(
    r"\b([A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?)\b", re.I
)
IRISH_IBAN_RE = re.compile(r"^IE\d{2}[A-Z]{4}\d{14}$", re.I)
PPS_RE = re.compile(r"\b\d{7}[A-W][A-IW]?\b", re.I)


def iban_ok(raw):
    s = raw.replace(" ", "").upper()
    if not 15 <= len(s) <= 34:
        return False
    if IRISH_IBAN_RE.match(s):
        return True
    moved = s[4:] + s[:4]
    try:
        num = int("".join(str(int(c, 36)) for c in moved))
    except ValueError:
        return False
    return num % 97 == 1


def tracked_files():
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=ROOT, check=True, capture_output=True
    ).stdout
    return [p for p in out.decode().split("\0") if p]


def main():
    problems = []
    for rel in tracked_files():
        if rel in SKIP_FILES or Path(rel).suffix.lower() in SKIP_EXT:
            continue
        path = ROOT / rel
        if not path.is_file():
            continue
        try:
            text = path.read_text(encoding="utf-8")
        except UnicodeDecodeError:
            continue
        for n, line in enumerate(text.splitlines(), 1):
            if ALLOW in line:
                continue
            for m in IBAN_RE.finditer(line):
                if iban_ok(m.group(1)):
                    problems.append(f"{rel}:{n}: looks like an IBAN")
            if PPS_RE.search(line):
                problems.append(f"{rel}:{n}: looks like a PPS number")
    if problems:
        print("Possible private data in tracked files (values not shown):")
        print("\n".join(problems))
        print(f"Remove it, or add '{ALLOW}' to the line if it is safe.")
        return 1
    print("No IBANs or PPS numbers found.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
