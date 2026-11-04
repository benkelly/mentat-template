// Write access to the notes, through pull requests only.
//
// Nothing is written to main. Each change goes on a new branch with one commit,
// and a pull request is opened for the owner to review and merge. CI (gitleaks and the
// private-data check) runs on every pull request as usual.
//
// The token is a fine-grained GitHub token limited to the notes repo (NOTES_REPO), with
// "Contents: read and write" and "Pull requests: read and write".

export const BRANCH_PREFIX = "mcp/";
const MAX_OPEN_PRS = 10;

export const MAX_NOTE_CHARS = 20_000;
export const MAX_LOG_CHARS = 500;

// Notes the tools may change. Everything else (raw/, scripts/, mcp/, docs/,
// CI, me.md, INDEX.md, graph.json) is off limits.
const NOTE_PATH = /^(areas|projects|people)\/[a-z0-9][a-z0-9-]{0,60}\.md$/;
const LOG_PATH = /^logs\/\d{4}-(0[1-9]|1[0-2])\.md$/;

// Things that must never be written to the notes. CI checks again on the PR.
const FORBIDDEN: [RegExp, string][] = [
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, "a GitHub token"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/, "a GitHub token"],
  [/\bsk-[A-Za-z0-9_-]{20,}/, "an API key"],
  [/\bAKIA[0-9A-Z]{16}\b/, "an AWS key"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
  [/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}\b/, "what looks like an IBAN"],
  // Long digit runs, or 4-4-4-x groups. Dates and phone numbers don't match.
  [/\b\d{13,19}\b|\b\d{4}([ -])\d{4}\1\d{4}\1\d{1,7}\b/, "what looks like a card or account number"],
];

export function checkPath(path: string): string | undefined {
  if (NOTE_PATH.test(path) || LOG_PATH.test(path)) return undefined;
  return "Path must be areas/<slug>.md, projects/<slug>.md, people/<slug>.md or logs/YYYY-MM.md (lower-case slug).";
}

export function checkText(text: string): string | undefined {
  for (const [re, what] of FORBIDDEN) {
    if (re.test(text)) return `Refused: the text contains ${what}. mentat holds summaries only.`;
  }
  return undefined;
}

export function checkNote(path: string, content: string): string | undefined {
  const bad = checkPath(path);
  if (bad) return bad;
  if (content.length > MAX_NOTE_CHARS) return `Note is too long (max ${MAX_NOTE_CHARS} characters).`;
  if (!/^---\n[\s\S]*?\btitle:\s*\S[\s\S]*?\n---\n/.test(content)) {
    return "Note must start with YAML frontmatter (--- ... ---) that includes a title.";
  }
  return checkText(content);
}

export function checkLogEntry(entry: string): string | undefined {
  if (!entry.trim()) return "Log entry is empty.";
  if (entry.length > MAX_LOG_CHARS) return `Log entry is too long (max ${MAX_LOG_CHARS} characters).`;
  if (/[\r\n]/.test(entry)) return "Log entry must be one line.";
  return checkText(entry);
}

// Your time zone, for dating log entries. Change it to yours.
export const TIME_ZONE = "Europe/Dublin";

/** Today's date in TIME_ZONE, as YYYY-MM-DD. */
export function todayLocal(now = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE }).format(now);
}

/** Add one dated line to a monthly log, creating the log if needed. */
export function appendToLog(existing: string | undefined, date: string, entry: string): string {
  const line = `- ${date}: ${entry.trim()}`;
  if (!existing) {
    const [y, m] = date.split("-");
    const month = new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString("en-IE", { month: "long", timeZone: "UTC" });
    return `---\ntitle: Log ${month} ${y}\ntype: log\nupdated: ${date}\ntags: [log]\n---\n\n${line}\n`;
  }
  const bumped = existing.replace(/^(---\n[\s\S]*?\nupdated:\s*)\S+/, `$1${date}`);
  return `${bumped.replace(/\s*$/, "")}\n${line}\n`;
}

export interface FileOnMain {
  content: string;
  sha: string;
}

export interface OpenPr {
  branch: string;
  url: string;
  number: number;
}

export interface Writer {
  getFile(path: string, ref?: string): Promise<FileOnMain | undefined>;
  propose(change: { path: string; content: string; title: string; body: string }): Promise<string>;
  /** The open connector PR whose branch starts with this prefix, if any. */
  findOpenPr(branchPrefix: string): Promise<OpenPr | undefined>;
  /** Add a commit to an existing connector branch. */
  commitTo(pr: OpenPr, change: { path: string; content: string; sha: string; message: string; note: string }): Promise<void>;
}

const b64encode = (s: string) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};
const b64decode = (s: string) =>
  new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, "")), (c) => c.charCodeAt(0)));

export class GitHubWriter implements Writer {
  constructor(
    private token: string,
    // "owner/repo" of the notes repository.
    private repo: string,
    // Wrapped, not passed bare: calling the global fetch as a method of this
    // object throws "Illegal invocation" in Workers.
    private fetcher: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private async api(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.fetcher(`https://api.github.com/repos/${this.repo}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "mentat-mcp",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === "GET") return undefined;
    if (!res.ok) throw new Error(`GitHub ${method} ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res.json();
  }

  async getFile(path: string, ref = "main"): Promise<FileOnMain | undefined> {
    const file = await this.api("GET", `/contents/${path}?ref=${encodeURIComponent(ref)}`);
    if (!file || Array.isArray(file) || file.type !== "file") return undefined;
    return { content: b64decode(file.content), sha: file.sha };
  }

  async propose({ path, content, title, body }: { path: string; content: string; title: string; body: string }) {
    const open: any[] = (await this.api("GET", "/pulls?state=open&per_page=100")) ?? [];
    if (open.filter((p) => String(p.head?.ref).startsWith(BRANCH_PREFIX)).length >= MAX_OPEN_PRS) {
      throw new Error(`There are already ${MAX_OPEN_PRS} open mentat-mcp pull requests. Review those first.`);
    }

    const main = await this.api("GET", "/git/ref/heads/main");
    const stem = path.replace(/\.md$/, "").replace(/\//g, "-");
    const branch = `${BRANCH_PREFIX}${stem}-${Date.now().toString(36)}`;
    await this.api("POST", "/git/refs", { ref: `refs/heads/${branch}`, sha: main.object.sha });

    const current = await this.getFile(path);
    await this.api("PUT", `/contents/${path}`, {
      message: title,
      content: b64encode(content),
      branch,
      ...(current ? { sha: current.sha } : {}),
    });

    const pr = await this.api("POST", "/pulls", {
      title,
      head: branch,
      base: "main",
      body: `${body}\n\n---\nOpened by the mentat MCP connector. Review, then merge or close.`,
    });
    return pr.html_url as string;
  }

  async findOpenPr(branchPrefix: string): Promise<OpenPr | undefined> {
    if (!branchPrefix.startsWith(BRANCH_PREFIX)) return undefined;
    const open: any[] = (await this.api("GET", "/pulls?state=open&per_page=100")) ?? [];
    const pr = open.find((p) => String(p.head?.ref).startsWith(branchPrefix) && p.head?.repo?.full_name === this.repo);
    return pr ? { branch: pr.head.ref, url: pr.html_url, number: pr.number } : undefined;
  }

  async commitTo(pr: OpenPr, { path, content, sha, message, note }: { path: string; content: string; sha: string; message: string; note: string }) {
    if (!pr.branch.startsWith(BRANCH_PREFIX)) throw new Error("Refusing to write outside connector branches.");
    await this.api("PUT", `/contents/${path}`, { message, content: b64encode(content), branch: pr.branch, sha });
    await this.api("POST", `/issues/${pr.number}/comments`, { body: note });
  }
}
