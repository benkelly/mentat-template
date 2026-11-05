# Setup

## 1. Clone to your Mac

```sh
git clone git@github.com:<you>/mentat.git ~/mentat
```

## 2. Obsidian (reading and editing)

1. Install Obsidian from obsidian.md.
2. **Open folder as vault** and pick `~/mentat`.
3. Settings → Files and links → turn on **Use [[Wikilinks]]**.
4. Optional: install the community plugin **Git** to commit and push automatically.
5. Optional: Settings → Appearance → set the font to OpenDyslexic.

The graph view (left sidebar) shows how notes link together.

## 3. Basic Memory (lets AI tools read and write the notes)

Basic Memory is a local MCP server. It indexes this folder into a small SQLite database on your Mac and lets AI tools search notes and follow `[[links]]`.

```sh
brew install uv            # if you don't have it
uv tool install basic-memory
basic-memory project add mentat ~/mentat
basic-memory project default mentat
```

**Claude Desktop:** Settings → Developer → Edit Config, then add:

```json
{
  "mcpServers": {
    "basic-memory": { "command": "uvx", "args": ["basic-memory", "mcp"] }
  }
}
```

**OpenCode** (`opencode.json` in this repo or your global config):

```json
{
  "mcp": {
    "basic-memory": { "type": "local", "command": ["uvx", "basic-memory", "mcp"] }
  }
}
```

Check the Basic Memory README for the latest commands if anything has changed.

## 4. CI

`.github/workflows/index.yml` runs on every push and pull request:

- fails if anything in `raw/` was committed
- fails if a tracked file looks like it holds an IBAN or a PPS number (`scripts/check_private_data.py`; add `private-data: allow` to a line to let it through)
- runs gitleaks over the full git history to catch passwords and API keys
- fails if a `[[link]]` points to a note that doesn't exist
- regenerates `INDEX.md` and `graph.json` on `main`

Run the private data check locally with `python3 scripts/check_private_data.py`.

`.github/workflows/auto-merge.yml` merges connector log PRs so they don't pile up:

- only PRs on `mcp/` branches with no activity for 72 hours
- only if every file is a monthly log, and the only changes are new dated entry lines (plus the `updated:` date)
- never while checks are failing
- add the `hold` label to a PR to stop it
- every Monday it opens an issue listing what it merged that week, so you can skim and revert

New notes and edits to existing notes still wait for you. Every chat reads the notes as trusted context, so you see them first.

Workflows use read-only permissions. Only the job that commits the index on `main` and the auto-merge workflow can write. Actions are pinned to commit SHAs, and Dependabot (`.github/dependabot.yml`) opens weekly PRs to update them and the `mcp/` npm packages.

## 5. Hosted MCP (use your notes from anywhere)

See [mcp.md](mcp.md). The Worker in `mcp/` serves your notes at `https://mentat.example.com/mcp`, and only your GitHub account can sign in.

## 6. Importing old chats

1. claude.ai → Settings → Privacy → **Export data**. ChatGPT has a similar export.
2. Unzip it and run:
   ```sh
   python3 scripts/import_chat_export.py ~/Downloads/export/ --out raw/claude
   ```
3. `raw/` is git-ignored. Ask an AI to read the chats on a topic and update the summary notes.
