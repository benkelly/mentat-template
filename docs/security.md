# Security

Your notes are personal, and AI agents work on them with your GitHub access. These steps limit what goes wrong if an agent, a token or a tool misbehaves. Each takes a few minutes.

## 1. Protect `main`

Stop anyone, including an agent using your token, from deleting `main` or rewriting its history.

Repo → **Settings → Rules → Rulesets → New ruleset → New branch ruleset**:

1. **Ruleset name:** `main branch policy`. **Enforcement status:** Active.
2. **Target branches:** Add target → **Include default branch**.
3. **Bypass list:** leave it empty.
4. **Rules:** tick these three, and nothing else:
   - **Restrict deletions**
   - **Require linear history.** Auto-merge already squashes. Merge your own PRs with **Squash and merge**.
   - **Block force pushes**
5. **Create.**

Day to day nothing changes. The MCP connector and agents already work through pull requests.

### Why not "Require a pull request"?

The index job pushes the rebuilt `INDEX.md` and `graph.json` straight to `main`. On a repo owned by a personal account, GitHub doesn't offer **GitHub Actions** as a bypass, so requiring pull requests would block that job.

If you want the stricter setup, give the index job its own deploy key:

1. Make a key: `ssh-keygen -t ed25519 -C "mentat index" -f mentat_index -N ""`.
2. Repo → Settings → **Deploy keys** → add `mentat_index.pub`, with **Allow write access**.
3. Repo → Settings → Secrets and variables → Actions → new secret `INDEX_DEPLOY_KEY`, containing `mentat_index`. Then delete both files from your computer.
4. In `.github/workflows/index.yml`, in the `commit-index` job, give the checkout step `with:` and `ssh-key: ${{ secrets.INDEX_DEPLOY_KEY }}`. Its pushes then use the deploy key.
5. In the ruleset, add that deploy key to the bypass list (**Always allow**), then tick **Require a pull request before merging** (0 approvals) and **Require status checks to pass** with `check`.

Don't require `test-and-deploy`. It skips PRs that only touch docs or images, so those PRs could never merge.

## 2. Turn on vigilant mode

GitHub → your **Settings → SSH and GPG keys → Vigilant mode**. Commits that aren't signed then show as **Unverified**, so anything odd stands out.

## 3. Sign agent commits

Give agents on your computer (Claude Code, OpenCode) their own signing key, not yours. You can revoke it on its own, and GitHub shows which key signed each commit.

```sh
ssh-keygen -t ed25519 -C "mentat agent" -f ~/.ssh/agent_signing
cd path/to/your-notes
git config gpg.format ssh
git config user.signingkey ~/.ssh/agent_signing.pub
git config commit.gpgsign true
```

Then GitHub → **Settings → SSH and GPG keys → New SSH key**, key type **Signing key**, and paste `~/.ssh/agent_signing.pub`.

Some cloud agent sessions sign commits themselves. Leave those as they are.

**Never put a private key in your notes**, even a private repo. Every connected chat can read the notes, and git keeps the key in history after you delete it.

## 4. Keep tokens narrow

- The MCP write token (`GITHUB_WRITE_TOKEN`) should be a fine-grained token for **this repo only**, with Contents and Pull requests set to read and write, and nothing else. Set it to expire, and renew it.
- The Cloudflare token should be limited to your account and your domain's zone.
- If you think a token has leaked, revoke it first, then make a new one.

## 5. Clean up chat exports

Exports from Claude or ChatGPT hold your whole chat history: addresses, health chats, everything. After importing:

- Delete the downloaded export.
- `raw/` is git-ignored, so it never leaves your computer. Delete it too if you don't need to search old chats.

See also the security notes in [mcp.md](mcp.md#security-notes).
