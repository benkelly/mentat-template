// Write tools: validation, the log helper, the GitHub calls (with a fake GitHub),
// and the MCP tools end to end. No network.
// Run: npm test

import assert from "node:assert/strict";
import { GitHubWriter, appendToLog, checkLogEntry, checkNote, checkPath, todayLocal } from "../src/github";
import { handleMcp } from "../src/mcp";
import { Notes, type Bundle } from "../src/notes";
import bundle from "../src/notes.generated.json" with { type: "json" };

// --- validation ---
assert.equal(checkPath("areas/acme-cloud.md"), undefined);
assert.equal(checkPath("people/jordan-lee.md"), undefined);
assert.equal(checkPath("logs/2026-11.md"), undefined);
for (const bad of ["raw/chat.md", "me.md", "INDEX.md", "mcp/src/index.ts", "areas/../me.md", "areas/Acme.md", "logs/2026-13.md", ".github/workflows/x.md"]) {
  assert.ok(checkPath(bad), `should refuse ${bad}`);
}

const note = "---\ntitle: Test\ntype: area\n---\n\n## Status\n\nFine.\n";
assert.equal(checkNote("areas/test.md", note), undefined);
assert.ok(checkNote("areas/test.md", "no frontmatter"));
assert.ok(checkNote("areas/test.md", note + "IBAN IE29 AIBK 9311 5212 3456 78\n"));  // private-data: allow (fake IBAN for the test)
assert.ok(checkNote("areas/test.md", note + "card 4111 1111 1111 1111\n"));
assert.ok(checkNote("areas/test.md", note + "token ghp_abcdefghijklmnopqrstuvwxyz0123\n"));
assert.ok(checkNote("areas/test.md", note + "x".repeat(20_001)));
// Dates, times and phone numbers are fine.
assert.equal(checkNote("areas/test.md", note + "Call 2026-11-19 18:00, then 2026-11-20 2026-11-21. +353 1 555 0100\n"), undefined);

assert.equal(checkLogEntry("Did the [[acme-cloud]] round."), undefined);
assert.ok(checkLogEntry(""));
assert.ok(checkLogEntry("two\nlines"));
assert.ok(checkLogEntry("x".repeat(501)));

// --- log helper ---
const fresh = appendToLog(undefined, "2026-12-01", "First entry.");
assert.match(fresh, /^---\ntitle: Log December 2026\ntype: log\nupdated: 2026-12-01\n/);
assert.match(fresh, /\n- 2026-12-01: First entry\.\n$/);
const more = appendToLog("---\ntitle: Log November 2026\ntype: log\nupdated: 2026-11-02\n---\n\n- 2026-11-02: A.\n\n", "2026-11-04", "B.");
assert.match(more, /updated: 2026-11-04/);
assert.match(more, /- 2026-11-02: A\.\n- 2026-11-04: B\.\n$/);
assert.equal(todayLocal(new Date("2026-11-04T23:30:00Z")), "2026-11-04");

// --- GitHubWriter against a fake GitHub ---
const calls: { method: string; url: string; body?: any }[] = [];
const files: Record<string, string> = {
  "logs/2026-11.md": "---\ntitle: Log November 2026\ntype: log\nupdated: 2026-11-02\n---\n\n- 2026-11-02: A.\n",
  "areas/home.md": "---\ntitle: Home\ntype: area\nstatus: active\nupdated: 2026-11-01\ntags: [home]\n---\n\n## Next steps\n\n- [ ] Pick a paint colour for the hall.\n- [ ] Book the boiler service.\n",
};
let openPrs: any[] = [];
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const method = init?.method ?? "GET";
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  calls.push({ method, url, body });
  assert.equal((init?.headers as any).Authorization, "Bearer test-token");
  const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
  const path = url.replace("https://api.github.com/repos/you/mentat", "");
  if (method === "GET" && path.startsWith("/pulls")) return json(openPrs);
  if (method === "GET" && path === "/git/ref/heads/main") return json({ object: { sha: "mainsha" } });
  if (method === "GET" && path.startsWith("/contents/")) {
    const p = path.slice("/contents/".length).split("?")[0];
    return p in files ? json({ type: "file", sha: `sha-${p}`, content: btoa(files[p]) }) : json({}, 404);
  }
  if (method === "POST" && path === "/git/refs") return json({}, 201);
  if (method === "PUT" && path.startsWith("/contents/")) return json({}, 201);
  if (method === "POST" && /^\/issues\/\d+\/comments$/.test(path)) return json({}, 201);
  if (method === "POST" && path === "/pulls") return json({ html_url: "https://github.com/you/mentat/pull/99" }, 201);
  return json({ message: "unexpected" }, 500);
}) as typeof fetch;

const writer = new GitHubWriter("test-token", "you/mentat", fakeFetch);
const url = await writer.propose({ path: "logs/2026-11.md", content: "new", title: "t", body: "b" });
assert.equal(url, "https://github.com/you/mentat/pull/99");
const ref = calls.find((c) => c.method === "POST" && c.url.endsWith("/git/refs"))!;
assert.match(ref.body.ref, /^refs\/heads\/mcp\/logs-2026-11-/);
assert.equal(ref.body.sha, "mainsha");
const put = calls.find((c) => c.method === "PUT")!;
assert.equal(put.body.branch, ref.body.ref.replace("refs/heads/", ""));
assert.equal(put.body.sha, "sha-logs/2026-11.md", "updates pass the existing file sha");
assert.equal(atob(put.body.content), "new");
const pr = calls.find((c) => c.method === "POST" && c.url.endsWith("/pulls"))!;
assert.equal(pr.body.base, "main");
assert.ok(!calls.some((c) => c.method !== "GET" && /heads\/main|ref":"refs\/heads\/main/.test(c.url)), "never writes to main");

openPrs = Array.from({ length: 10 }, () => ({ head: { ref: "mcp/x" } }));
await assert.rejects(writer.propose({ path: "logs/2026-11.md", content: "x", title: "t", body: "b" }), /already 10 open/);
openPrs = [];

// --- the MCP tools, end to end ---
const notes = new Notes(bundle as Bundle);
let id = 0;
async function rpc(method: string, params: unknown, w: GitHubWriter | null = writer) {
  const res = await handleMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    notes,
    w ?? undefined,
  );
  return (await res.json()) as any;
}
const call = async (name: string, args: Record<string, unknown>) => (await rpc("tools/call", { name, arguments: args })).result;

const names = (await rpc("tools/list", {})).result.tools.map((t: any) => t.name);
for (const t of ["add_log_entry", "propose_note_change", "read_note_source", "complete_item", "new_note"]) assert.ok(names.includes(t), `has ${t}`);
const readOnly = (await rpc("tools/list", {}, null)).result.tools.map((t: any) => t.name);
assert.ok(!readOnly.includes("add_log_entry"), "no write tools without a token");

calls.length = 0;
let r = await call("add_log_entry", { entry: "Tested the write tools.", date: "2026-11-04" });
assert.ok(!r.isError, r.content[0].text);
assert.match(r.content[0].text, /pull\/99/);
const logPut = calls.find((c) => c.method === "PUT")!;
assert.match(logPut.url, /\/contents\/logs\/2026-11\.md$/);
assert.match(atob(logPut.body.content), /- 2026-11-02: A\.\n- 2026-11-04: Tested the write tools\.\n$/);

r = await call("propose_note_change", { path: "raw/x.md", content: note, reason: "x" });
assert.ok(r.isError);
r = await call("propose_note_change", { path: "areas/test.md", content: note + "4111111111111111\n", reason: "x" });
assert.ok(r.isError);
r = await call("propose_note_change", { path: "areas/test.md", content: note, reason: "Add a test note." });
assert.ok(!r.isError, r.content[0].text);
r = await call("read_note_source", { path: "logs/2026-11.md" });
assert.match(r.content[0].text, /title: Log November 2026/);

// complete_item ticks one line and bumps the date, nothing else.
calls.length = 0;
r = await call("complete_item", { path: "areas/home.md", item: "paint colour", date: "2026-11-05" });
assert.ok(!r.isError, r.content[0].text);
const tickPut = calls.find((c) => c.method === "PUT")!;
assert.match(tickPut.url, /\/contents\/areas\/home\.md$/);
assert.equal(
  atob(tickPut.body.content),
  "---\ntitle: Home\ntype: area\nstatus: active\nupdated: 2026-11-05\ntags: [home]\n---\n\n## Next steps\n\n- [x] Pick a paint colour for the hall.\n- [ ] Book the boiler service.\n",
);
r = await call("complete_item", { path: "areas/home.md", item: "the" });
assert.ok(r.isError && /More than one/.test(r.content[0].text));
r = await call("complete_item", { path: "areas/nope.md", item: "x" });
assert.ok(r.isError && /No file/.test(r.content[0].text));
r = await call("complete_item", { path: "logs/2026-11.md", item: "x" });
assert.ok(r.isError && /add_log_entry/.test(r.content[0].text));

// new_note renders the template and refuses existing paths, wrong folders and unknown related slugs.
calls.length = 0;
r = await call("new_note", {
  path: "people/sam-ortiz-test.md",
  title: "Sam Ortiz",
  type: "person",
  tags: ["people", "acme"],
  summary: "Recruiter at Acme Cloud.",
  next_steps: ["Intro call 2026-11-09."],
  related: ["job-hunt"],
  reason: "New recruiter contact.",
});
assert.ok(!r.isError, r.content[0].text);
const newPut = calls.find((c) => c.method === "PUT")!;
assert.match(atob(newPut.body.content), /^---\ntitle: Sam Ortiz\ntype: person\nupdated: \d{4}-\d{2}-\d{2}\ntags: \[people, acme\]\n---\n\n## Status\n\nRecruiter at Acme Cloud\.\n\n## Next steps\n\n- \[ \] Intro call 2026-11-09\.\n\n## Related\n\n- \[\[job-hunt\]\]\n$/);
r = await call("new_note", { path: "areas/home.md", title: "Home", type: "area", status: "active", tags: [], reason: "x" });
assert.ok(r.isError && /already exists/.test(r.content[0].text));
r = await call("new_note", { path: "areas/thing.md", title: "Thing", type: "area", tags: [], reason: "x" });
assert.ok(r.isError && /needs a status/.test(r.content[0].text));
r = await call("new_note", { path: "areas/bob.md", title: "Bob", type: "person", tags: [], reason: "x" });
assert.ok(r.isError && /goes in people\//.test(r.content[0].text));
r = await call("new_note", { path: "projects/thing.md", title: "Thing", type: "project", status: "idea", tags: [], related: ["nope"], reason: "x" });
assert.ok(r.isError && /No note called 'nope'/.test(r.content[0].text));

// A second log entry joins the open log PR instead of opening another one.
openPrs = [
  { number: 7, html_url: "https://github.com/you/mentat/pull/7", head: { ref: "mcp/logs-2026-11-abc", repo: { full_name: "you/mentat" } } },
  { number: 8, html_url: "https://github.com/someone/fork/pull/8", head: { ref: "mcp/logs-2026-11-evil", repo: { full_name: "someone/fork" } } },
];
calls.length = 0;
r = await call("add_log_entry", { entry: "Second entry.", date: "2026-11-05" });
assert.ok(!r.isError, r.content[0].text);
assert.match(r.content[0].text, /open log pull request: .*pull\/7/);
assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/git/refs")), "no new branch");
assert.ok(!calls.some((c) => c.method === "POST" && c.url.endsWith("/pulls")), "no new PR");
const joinGet = calls.find((c) => c.method === "GET" && c.url.includes("/contents/logs/2026-11.md"))!;
assert.match(joinGet.url, /ref=mcp%2Flogs-2026-11-abc/, "reads the log from the PR branch");
const joinPut = calls.find((c) => c.method === "PUT")!;
assert.equal(joinPut.body.branch, "mcp/logs-2026-11-abc");
assert.match(atob(joinPut.body.content), /- 2026-11-05: Second entry\.\n$/);
assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/issues/7/comments")));

// A December entry doesn't join November's PR.
calls.length = 0;
r = await call("add_log_entry", { entry: "December.", date: "2026-12-01" });
assert.ok(calls.some((c) => c.method === "POST" && c.url.endsWith("/git/refs")), "new branch for a new month");
openPrs = [];

console.log("ok: write tools");
