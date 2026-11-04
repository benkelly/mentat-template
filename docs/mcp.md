# Hosted MCP server

`mcp/` is a Cloudflare Worker that serves these notes to AI tools over MCP, from any device.

- **URL:** `https://mentat.example.com/mcp`
- **Who can use it:** only one GitHub account, matched by its numeric user ID (`ALLOWED_GITHUB_ID` in `mcp/wrangler.jsonc`). Anyone else is refused at sign-in.
- **What it can do:** read the notes (`read_note`, `search_notes`, `list_notes`, `related_notes`, `latest_log`). With an optional token it can also propose changes, which open pull requests (see step 6).
- **How notes get there:** on every push to `main`, CI bundles the notes into the Worker and redeploys it. Changes only under `docs/`, `assets/` or images skip this. Deploys queue, so two never run at once.

## One-time setup

### 0. Make it yours

You need a domain (or subdomain) on Cloudflare. In `mcp/wrangler.jsonc`, change:

- `routes` → your subdomain, for example `mentat.yourdomain.com`
- `ALLOWED_GITHUB_ID` → your numeric GitHub user ID, from `https://api.github.com/users/<your-login>`
- `NOTES_REPO` → `your-login/your-notes-repo`
- the KV `id` → the ID printed by `npx wrangler kv namespace create mentat-mcp-oauth`

In the steps below, replace `mentat.example.com` with your subdomain.

### 1. GitHub OAuth app (for signing in)

1. GitHub → Settings → Developer settings → **OAuth Apps** → **New OAuth App**.
2. Name: `mentat`. Homepage URL: `https://mentat.example.com`.
3. Authorization callback URL: `https://mentat.example.com/callback`
4. Create it, copy the **Client ID**, then **Generate a new client secret** and copy it.

### 2. Cloudflare API token (for CI to deploy)

1. Cloudflare dashboard → My Profile → **API Tokens** → **Create Token**.
2. Use the **Edit Cloudflare Workers** template. Limit it to your account and the zone for your domain only.
3. Copy the token. Also copy your **Account ID** (on the Workers overview page).

### 3. GitHub repo secrets

In your notes repo → Settings → Secrets and variables → Actions, add:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Then re-run the `mcp` workflow (Actions → mcp → Run workflow). It deploys the Worker and the `mentat.example.com` custom domain.

### 4. Worker secrets (the GitHub OAuth app)

On your Mac:

```sh
cd ~/mentat/mcp
npm ci
npx wrangler login
npx wrangler secret put GITHUB_CLIENT_ID
npx wrangler secret put GITHUB_CLIENT_SECRET
```

Or set them in the Cloudflare dashboard: Workers → `mentat-mcp` → Settings → Variables and Secrets.

### 5. Connect Claude

Claude → Settings → Connectors → **Add custom connector** → URL `https://mentat.example.com/mcp`.
Authentication: **Sign in now**. OAuth client: **Use Claude's published identity**. Leave the client ID and secret empty. Don't use the GitHub app's ID or secret here: those belong to the Worker only.
You'll see the mentat consent page, then sign in with GitHub.

### OpenCode

```sh
opencode mcp add mentat --global --url https://mentat.example.com/mcp
```

This writes to `~/.config/opencode/opencode.jsonc` under `mcp.servers`. Then in OpenCode run `/mcps`, pick mentat and approve the sign-in in the browser. No client ID or secret is needed: OpenCode registers itself.

### 6. Write access (optional)

The connector can propose changes. It never writes to `main`. Each change opens a pull request, and nothing changes until you merge it.

Tools: `add_log_entry`, `propose_note_change`, `read_note_source`.

1. GitHub → Settings → Developer settings → **Fine-grained tokens** → **Generate new token**.
2. Name: `mentat-mcp-write`. Expiry: up to a year (put a reminder in your calendar).
3. Repository access: **Only select repositories** → your notes repo.
4. Permissions: **Contents: Read and write**, **Pull requests: Read and write**. Leave everything else as no access.
5. Cloudflare → Workers → `mentat-mcp` → Settings → Variables and Secrets → add `GITHUB_WRITE_TOKEN` as a **Secret**.
6. In Claude, open the mentat connector and reconnect it (or start a new chat) so the new tools show up.

To turn writing off again, delete the `GITHUB_WRITE_TOKEN` secret. The connector goes back to read-only.

Limits:

- Only `areas/`, `projects/`, `people/` and `logs/` can be changed. Never `raw/`, `me.md`, code, CI or docs.
- Notes max 20,000 characters. Log lines max 500 characters, one line.
- Refuses text that looks like a token, key, IBAN, or card or account number. CI checks the PR again.
- At most 10 open connector PRs at a time.

Merging in any order:

- Log entries share one open PR per month. A new entry joins the open log PR as an extra commit, so log PRs never conflict with each other.
- Note PRs are normal git merges, so nothing is silently overwritten. If two PRs change the same lines of one note, the second shows "This branch has conflicts". Close it and ask a chat to propose the change again from the latest version.

### See the map in a browser

Open `https://mentat.example.com/graph` and sign in with GitHub. Only the allowed GitHub account gets in. It shares the `/callback` URL with the MCP sign-in, so the GitHub OAuth app needs no changes. It shows every note as a dot, coloured by type, with lines for `[[links]]`. Click a dot or a name to read the note. Drag to move, scroll or pinch to zoom. It updates on every deploy. Sign out at the bottom of the side panel. The session lasts 7 days, and rotating the GitHub client secret signs everyone out.

## Checks

- `https://mentat.example.com/` shows a short text message.
- `https://mentat.example.com/mcp` without signing in returns `401`. That's correct.

## Local development

```sh
cd mcp
npm test          # runs every tool against the real notes, and checks the sign-in rule
npm run dev       # local Worker at http://localhost:8787 (needs a .dev.vars file with the two GitHub secrets)
```

## Security notes

- Sign-in checks the GitHub user ID, not the login. A login can be renamed and then claimed by someone else. An ID never changes. To find an ID: `https://api.github.com/users/<login>`.
- The Worker only runs at `mentat.example.com`. The `workers.dev` address is turned off (`workers_dev: false`).
- OAuth tokens and grants are stored hashed in the KV namespace `mentat-mcp-oauth`.
- The notes are bundled into the Worker. They're only served after sign-in.
- To cut off every connected app: delete the KV namespace contents, or rotate the GitHub client secret.
- Writes only ever open pull requests, from branches named `mcp/...`. A chat that is tricked into writing something can only open a PR, which you can close.
