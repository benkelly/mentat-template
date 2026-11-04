#!/usr/bin/env python3
"""Turn a claude.ai or ChatGPT data export into one markdown file per chat.

Usage:
  python3 scripts/import_chat_export.py path/to/conversations.json [--out raw/claude]

Output goes to raw/ by default, which is git-ignored. Read the files, then
write short summaries into the notes. Never commit the raw files.

Standard library only.
"""
import argparse
import json
import re
from datetime import datetime, timezone
from pathlib import Path


def slugify(text, fallback):
    s = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (s or fallback)[:60]


def claude_chats(data):
    for c in data:
        msgs = []
        for m in c.get("chat_messages", []):
            text = m.get("text") or ""
            if not text and isinstance(m.get("content"), list):
                text = "\n".join(p.get("text", "") for p in m["content"] if isinstance(p, dict))
            msgs.append((m.get("sender", "?"), m.get("created_at", ""), text))
        yield c.get("name") or "untitled", c.get("created_at", ""), c.get("uuid", ""), msgs


def chatgpt_chats(data):
    for c in data:
        mapping = c.get("mapping", {})
        msgs = []
        for node in mapping.values():
            m = node.get("message")
            if not m or not m.get("content"):
                continue
            parts = m["content"].get("parts") or []
            text = "\n".join(p for p in parts if isinstance(p, str)).strip()
            if not text:
                continue
            ts = m.get("create_time") or 0
            when = datetime.fromtimestamp(ts, timezone.utc).isoformat() if ts else ""
            msgs.append((m.get("author", {}).get("role", "?"), when, text))
        msgs.sort(key=lambda x: x[1])
        created = c.get("create_time")
        created = datetime.fromtimestamp(created, timezone.utc).isoformat() if created else ""
        yield c.get("title") or "untitled", created, c.get("id", ""), msgs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("export")
    ap.add_argument("--out", default="raw/chats")
    args = ap.parse_args()

    data = json.loads(Path(args.export).read_text(encoding="utf-8"))
    is_chatgpt = bool(data) and "mapping" in data[0]
    chats = chatgpt_chats(data) if is_chatgpt else claude_chats(data)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    count = 0
    for i, (title, created, cid, msgs) in enumerate(chats):
        date = (created or "0000-00-00")[:10]
        path = out / f"{date}_{slugify(title, str(i))}.md"
        with path.open("w", encoding="utf-8") as f:
            f.write(f"---\ntitle: {json.dumps(title)}\ncreated: {created}\nid: {cid}\nsource: {'chatgpt' if is_chatgpt else 'claude'}\n---\n\n")
            for sender, when, text in msgs:
                f.write(f"### {sender} ({when[:16]})\n\n{text.strip()}\n\n")
        count += 1
    print(f"Wrote {count} chats to {out}/")


if __name__ == "__main__":
    main()
