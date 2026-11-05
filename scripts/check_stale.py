#!/usr/bin/env python3
"""Report notes and open items that look out of date. Never fails.

Usage: python3 scripts/check_stale.py [--days 30] [--overdue 7] [--today YYYY-MM-DD]

Prints markdown for the weekly review issue:
- active notes not updated in --days days
- open items whose latest date is more than --overdue days ago
- open items and dates in the next 7 days

Standard library only.
"""
import argparse
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_index import build  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=30, help="an active note older than this is stale")
    ap.add_argument("--overdue", type=int, default=7, help="a dated open item older than this is overdue")
    ap.add_argument("--today", default=date.today().isoformat())
    args = ap.parse_args()
    today = date.fromisoformat(args.today)
    stale_before = (today - timedelta(days=args.days)).isoformat()
    overdue_before = (today - timedelta(days=args.overdue)).isoformat()
    week_ahead = (today + timedelta(days=7)).isoformat()

    nodes, _edges, _broken, tasks, dates = build()
    out = []

    stale = [n for n in nodes.values() if n["status"] == "active" and n["updated"] and n["updated"] < stale_before]
    out += ["### Stale notes", ""]
    if stale:
        out += [f"- [[{n['id']}]] ({n['path']}): active, last updated {n['updated']}" for n in sorted(stale, key=lambda n: n["updated"])]
    else:
        out.append(f"None. Every active note was updated in the last {args.days} days.")

    overdue = sorted((t for t in tasks if t["date"] and t["date"] < overdue_before), key=lambda t: t["date"])
    out += ["", "### Overdue items", ""]
    if overdue:
        out += [f"- {t['date']}: [[{t['note']}]]: {t['text']}" for t in overdue]
    else:
        out.append(f"None. No open item is more than {args.overdue} days past its date.")

    soon = sorted(
        [t for t in tasks if t["date"] and args.today <= t["date"] <= week_ahead]
        + [d for d in dates if args.today < d["date"] <= week_ahead],
        key=lambda x: x["date"],
    )
    out += ["", "### Next 7 days", ""]
    if soon:
        out += [f"- {x['date']}: [[{x['note']}]]: {x['text']}" for x in soon]
    else:
        out.append("Nothing dated in the next 7 days.")

    print("\n".join(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
