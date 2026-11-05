#!/usr/bin/env python3
"""Check the notes follow the rules in AGENTS.md.

Usage: python3 scripts/lint_notes.py

Fails if a note:
- has no frontmatter, or is missing title, type, updated or tags
- has a type outside profile, area, project, person, people, log
- has a status outside active, waiting, done, idea (areas and projects must have one)
- has an updated date that is not ISO (YYYY-MM-DD) or is in the future
- uses an em dash, or a slash date like 5/11/2026
- is a person note that no people note (family, work-contacts) links to

Standard library only.
"""
import re
import sys
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_index import FENCE_RE, LINK_RE, frontmatter, notes, strip_frontmatter  # noqa: E402

TYPES = {"profile", "area", "project", "person", "people", "log"}
STATUSES = {"active", "waiting", "done", "idea"}
NEEDS_STATUS = {"area", "project"}
ISO = re.compile(r"^\d{4}-\d{2}-\d{2}$")
SLASH_DATE = re.compile(r"\b\d{1,2}/\d{1,2}/\d{2,4}\b")


def main():
    problems = []
    today = date.today().isoformat()
    people_links = set()
    persons = []
    for path, rel in notes():
        text = path.read_text(encoding="utf-8")
        meta = frontmatter(text)
        if not text.startswith("---\n") or not meta:
            problems.append(f"{rel}: no frontmatter")
            continue
        for key in ("title", "type", "updated", "tags"):
            if not meta.get(key):
                problems.append(f"{rel}: frontmatter is missing {key}")
        kind = meta.get("type", "")
        if kind and kind not in TYPES:
            problems.append(f"{rel}: type '{kind}' is not one of {', '.join(sorted(TYPES))}")
        status = meta.get("status", "")
        if status and status not in STATUSES:
            problems.append(f"{rel}: status '{status}' is not one of {', '.join(sorted(STATUSES))}")
        if kind in NEEDS_STATUS and not status:
            problems.append(f"{rel}: {kind} notes need a status")
        updated = meta.get("updated", "")
        if updated and not ISO.match(updated):
            problems.append(f"{rel}: updated '{updated}' is not YYYY-MM-DD")
        elif updated > today:
            problems.append(f"{rel}: updated '{updated}' is in the future")
        body = FENCE_RE.sub("", strip_frontmatter(text))
        for n, line in enumerate(body.splitlines(), 1):
            if "—" in line:
                problems.append(f"{rel}: em dash on line {n} of the body. Use a comma, full stop or colon.")
            if SLASH_DATE.search(line):
                problems.append(f"{rel}: slash date on line {n} of the body. Use YYYY-MM-DD.")
        if kind == "people":
            people_links |= {m.strip() for m in LINK_RE.findall(body)}
        if kind == "person":
            persons.append((rel, rel.stem))
    for rel, slug in persons:
        if slug not in people_links:
            problems.append(f"{rel}: no people note (family, work-contacts) links to [[{slug}]]")
    if problems:
        print("Note lint:\n  " + "\n  ".join(problems))
        return 1
    print("Notes follow the rules.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
