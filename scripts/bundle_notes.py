#!/usr/bin/env python3
"""Bundle all notes into mcp/src/notes.generated.json for the MCP Worker.

Usage: python3 scripts/bundle_notes.py
"""
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_index import FENCE_RE, LINK_RE, ROOT, frontmatter, notes, strip_frontmatter  # noqa: E402

OUT = ROOT / "mcp" / "src" / "notes.generated.json"


def main():
    items = []
    for path, rel in notes():
        text = path.read_text(encoding="utf-8")
        meta = frontmatter(text)
        tags = [t.strip() for t in meta.get("tags", "").strip("[]").split(",") if t.strip()]
        body = strip_frontmatter(text).lstrip("\n")
        links = sorted(set(m.strip() for m in LINK_RE.findall(FENCE_RE.sub("", body))))
        items.append(
            {
                "slug": rel.stem,
                "path": str(rel),
                "title": meta.get("title", rel.stem),
                "type": meta.get("type", ""),
                "status": meta.get("status", ""),
                "updated": meta.get("updated", ""),
                "tags": tags,
                "links": links,
                "body": body,
            }
        )
    OUT.write_text(
        json.dumps({"built": datetime.now(timezone.utc).isoformat(timespec="seconds"), "notes": items}, indent=1),
        encoding="utf-8",
    )
    print(f"Bundled {len(items)} notes into {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
