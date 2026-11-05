#!/usr/bin/env python3
"""Build INDEX.md and graph.json from the notes, and check for broken [[links]].

INDEX.md ends with an "Open items" section: every unticked `- [ ]` line
across the notes, grouped by note, then the dated ones by the latest date each one mentions,
then "Dates ahead": other lines that mention a date after the newest `updated:` date
in the notes. That date stands in for today, so the output is the same whenever it is built.

Usage: python3 scripts/build_index.py [--check]

--check  exit 1 if any [[link]] points to a note that doesn't exist,
         or if INDEX.md / graph.json are out of date. Writes nothing.

Standard library only.
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SKIP_DIRS = {".git", ".github", "raw", "scripts", "node_modules", ".obsidian", "mcp"}
SKIP_FILES = {"INDEX.md", "README.md", "AGENTS.md", "CLAUDE.md"}
LINK_RE = re.compile(r"\[\[([^\]|#]+)(?:[#|][^\]]*)?\]\]")
FENCE_RE = re.compile(r"```.*?```", re.S)
TASK_RE = re.compile(r"^\s*[-*] \[ \] (.+?)\s*$", re.M)
DATE_RE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b")


def frontmatter(text):
    meta = {}
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            for line in text[4:end].splitlines():
                if ":" in line and not line.startswith(" "):
                    k, v = line.split(":", 1)
                    meta[k.strip()] = re.sub(r"\s+#.*$", "", v).strip()
    return meta


def notes():
    for path in sorted(ROOT.rglob("*.md")):
        rel = path.relative_to(ROOT)
        if set(rel.parts[:-1]) & SKIP_DIRS or rel.name in SKIP_FILES:
            continue
        if rel.parts[0] == "docs":
            continue
        yield path, rel


def strip_frontmatter(text):
    if text.startswith("---\n"):
        end = text.find("\n---", 4)
        if end != -1:
            return text[end + 4 :]
    return text


def line_text(line):
    """A table row or list item as one short line of text."""
    text = line.strip().lstrip("-*").strip()
    if text.startswith("|"):
        text = " | ".join(c.strip() for c in text.strip("|").split("|") if c.strip())
    text = re.sub(r"\s+", " ", text)
    return text if len(text) <= 160 else text[:157].rstrip() + "..."


def build():
    nodes, edges, broken, tasks, dates = {}, [], [], [], []
    parsed = []
    for path, rel in notes():
        text = path.read_text(encoding="utf-8")
        meta = frontmatter(text)
        slug = rel.stem
        nodes[slug] = {
            "id": slug,
            "path": str(rel),
            "title": meta.get("title", slug),
            "type": meta.get("type", ""),
            "status": meta.get("status", ""),
            "updated": meta.get("updated", ""),
        }
        body = FENCE_RE.sub("", text)
        parsed.append((slug, rel, body))
        for item in TASK_RE.findall(body):
            tasks.append({"note": slug, "text": item, "date": max(DATE_RE.findall(item), default="")})
        if meta.get("type") != "log":
            for line in strip_frontmatter(body).splitlines():
                found = DATE_RE.findall(line)
                if found and not TASK_RE.match(line) and not line.lstrip().startswith("|---") and "| ---" not in line:
                    dates.append({"note": slug, "text": line_text(line), "date": max(found)})
    for slug, rel, body in parsed:
        for target in sorted(set(m.strip() for m in LINK_RE.findall(body))):
            if target in nodes:
                edges.append({"from": slug, "to": target})
            else:
                broken.append(f"{rel}: [[{target}]]")
    newest = max((n["updated"] for n in nodes.values()), default="")
    dates = [d for d in dates if d["date"] > newest]
    return nodes, edges, broken, tasks, dates


def render_open(nodes, tasks, dates):
    """Open items grouped by note, the dated ones in date order, then other dates ahead."""
    lines = ["## Open items", "", "Unticked tasks from every note, in one place. Dates are ISO; compare with today.", ""]
    if not tasks and not dates:
        return lines + ["Nothing open.", ""]
    order = ["profile", "area", "project", "person", "people", "log"]
    rank = {k: i for i, k in enumerate(order)}
    by_note = {}
    for t in tasks:
        by_note.setdefault(t["note"], []).append(t["text"])
    for slug in sorted(by_note, key=lambda s: (rank.get(nodes[s]["type"], len(order)), nodes[s]["title"].lower())):
        lines.append(f"- [[{slug}]]")
        lines += [f"  - [ ] {text}" for text in by_note[slug]]
    dated = sorted((t for t in tasks if t["date"]), key=lambda t: (t["date"], t["note"]))
    if dated:
        lines += ["", "### Dated", ""]
        lines += [f"- {t['date']}: [[{t['note']}]]: {t['text']}" for t in dated]
    if dates:
        newest = max(n["updated"] for n in nodes.values())
        lines += ["", "### Dates ahead", "", f"Other lines that mention a date after {newest}, the newest note update.", ""]
        lines += [f"- {d['date']}: [[{d['note']}]]: {d['text']}" for d in sorted(dates, key=lambda d: (d["date"], d["note"]))]
    lines.append("")
    return lines


def render_index(nodes, edges, tasks, dates):
    backlinks = {}
    for e in edges:
        backlinks.setdefault(e["to"], set()).add(e["from"])
    groups = {}
    for n in nodes.values():
        groups.setdefault(n["type"] or "other", []).append(n)
    order = ["profile", "area", "project", "person", "people", "log"]
    lines = [
        "# Index",
        "",
        "Generated by `scripts/build_index.py`. Do not edit by hand.",
        "",
    ]
    for kind in order + sorted(set(groups) - set(order)):
        if kind not in groups:
            continue
        lines += [f"## {kind.title()}", "", "| Note | Status | Updated | Linked from |", "| --- | --- | --- | --- |"]
        for n in sorted(groups[kind], key=lambda n: n["title"].lower()):
            refs = ", ".join(f"[[{b}]]" for b in sorted(backlinks.get(n["id"], [])))
            lines.append(f"| [[{n['id']}]] ({n['path']}) | {n['status']} | {n['updated']} | {refs} |")
        lines.append("")
    lines += render_open(nodes, tasks, dates)
    return "\n".join(lines)


def main():
    check = "--check" in sys.argv
    nodes, edges, broken, tasks, dates = build()
    index = render_index(nodes, edges, tasks, dates)
    graph = json.dumps({"nodes": list(nodes.values()), "edges": edges}, indent=1) + "\n"
    if broken:
        print("Broken links:\n  " + "\n  ".join(broken))
    if check:
        stale = []
        for name, content in (("INDEX.md", index), ("graph.json", graph)):
            p = ROOT / name
            if not p.exists() or p.read_text(encoding="utf-8") != content:
                stale.append(name)
        if stale:
            print("Out of date (run scripts/build_index.py): " + ", ".join(stale))
        sys.exit(1 if broken or stale else 0)
    (ROOT / "INDEX.md").write_text(index, encoding="utf-8")
    (ROOT / "graph.json").write_text(graph, encoding="utf-8")
    print(f"{len(nodes)} notes, {len(edges)} links, {len(tasks)} open items, {len(broken)} broken")
    sys.exit(1 if broken else 0)


if __name__ == "__main__":
    main()
