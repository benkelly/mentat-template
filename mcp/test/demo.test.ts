// The public demo Worker: read tools only, no sign-in, no write tools.
// Run: npm test

import assert from "node:assert/strict";
import { handleDemo } from "../src/demo";

const rpc = async (method: string, params: unknown = {}) => {
  const res = await handleDemo(
    new Request("https://mentat-demo.example.com/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }),
  );
  assert.equal(res.status, 200);
  return (await res.json()) as any;
};

const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name).sort();
assert.deepEqual(tools, ["latest_log", "list_notes", "read_note", "related_notes", "search_notes"], "read tools only");

const me = (await rpc("tools/call", { name: "read_note", arguments: { slug: "me" } })).result.content[0].text;
assert.match(me, /Robin Hale/, "serves the demo notes");

const graph = await handleDemo(new Request("https://mentat-demo.example.com/graph"));
assert.equal(graph.status, 200, "no sign-in");
const html = await graph.text();
assert.match(html, /const DEMO = true/);

for (const path of ["/authorize", "/callback", "/register", "/graph/logout", "/.well-known/oauth-authorization-server"]) {
  assert.equal((await handleDemo(new Request(`https://mentat-demo.example.com${path}`))).status, 404, path);
}

// The demo entry point must not pull in the OAuth provider or the write tools.
const { readFileSync } = await import("node:fs");
const src = readFileSync(new URL("../src/demo.ts", import.meta.url), "utf8");
assert.ok(!/workers-oauth-provider|\.\/github|\.\/index/.test(src), "demo.ts imports no auth or write code");

console.log("ok: demo worker");
