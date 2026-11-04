// Calls the MCP endpoint logic directly (no OAuth) with real JSON-RPC requests.
// Run: npm test

import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp";
import { Notes, type Bundle } from "../src/notes";
import bundle from "../src/notes.generated.json" with { type: "json" };

const notes = new Notes(bundle as Bundle);
let id = 0;

async function rpc(method: string, params: unknown = {}) {
  const res = await handleMcp(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
    }),
    notes,
  );
  assert.equal(res.status, 200, `${method} -> HTTP ${res.status}: ${await res.clone().text()}`);
  return (await res.json()) as any;
}

const call = async (name: string, args: Record<string, unknown> = {}) =>
  (await rpc("tools/call", { name, arguments: args })).result.content[0].text as string;

const init = await rpc("initialize", {
  protocolVersion: "2025-06-18",
  capabilities: {},
  clientInfo: { name: "test", version: "0" },
});
assert.equal(init.result.serverInfo.name, "mentat");

const tools = (await rpc("tools/list")).result.tools.map((t: any) => t.name).sort();
assert.deepEqual(tools, ["latest_log", "list_notes", "read_note", "related_notes", "search_notes"]);

assert.match(await call("read_note", { slug: "[[me]]" }), /How to help me/);
assert.match(await call("search_notes", { query: "pairing" }), /\[\[acme-cloud\]\]/);
assert.match(await call("list_notes", { type: "project" }), /\[\[weather-station\]\]/);
const rel = await call("related_notes", { slug: "acme-cloud" });
assert.match(rel, /Links to:[\s\S]*\[\[job-hunt\]\]/);
assert.match(rel, /Linked from:[\s\S]*\[\[jordan-lee\]\]/);
// The newest log changes every month, so check against the newest one in the bundle.
const newestLog = bundle.notes.filter((n) => n.type === "log").map((n) => n.slug).sort().at(-1)!;
assert.match(await call("latest_log"), new RegExp(newestLog.replace(/^logs\//, "")));
assert.match(await call("read_note", { slug: "nope" }), /No note called/);

console.log(`ok: ${tools.length} tools, ${bundle.notes.length} notes`);
