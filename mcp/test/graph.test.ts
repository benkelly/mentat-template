// /graph: sessions, sign-in redirects, the callback and the page. No network.
// Run: npm test

import assert from "node:assert/strict";
import { checkSession, graphData, handleGraph, makeSession } from "../src/graph";
import { Notes, type Bundle } from "../src/notes";
import bundle from "../src/notes.generated.json" with { type: "json" };

const env = { GITHUB_CLIENT_ID: "cid", GITHUB_CLIENT_SECRET: "secret", ALLOWED_GITHUB_ID: "1234567" };
const notes = new Notes(bundle as Bundle);
const get = (path: string, cookie?: string, f?: typeof fetch) =>
  handleGraph(new Request(`https://mentat.example.com${path}`, { headers: cookie ? { Cookie: cookie } : {} }), env, notes, f);

// Sessions
const good = await makeSession(env, "1234567");
assert.ok(await checkSession(env, good));
assert.ok(!(await checkSession(env, good.replace(/.$/, (c) => (c === "A" ? "B" : "A")))), "tampered signature");
assert.ok(!(await checkSession(env, good.replace("1234567", "1"))), "other user id");
assert.ok(!(await checkSession({ ...env, GITHUB_CLIENT_SECRET: "rotated" }, good)), "rotating the secret signs out");
assert.ok(!(await checkSession(env, await makeSession(env, "1234567", Date.now() - 8 * 24 * 3600 * 1000))), "expired");
assert.ok(!(await checkSession(env, await makeSession(env, "999"))), "not the owner");
assert.ok(!(await checkSession(env, "junk")));

// Not signed in: redirect to GitHub with the registered /callback, and a login cookie.
let res = (await get("/graph"))!;
assert.equal(res.status, 302);
const gh = new URL(res.headers.get("Location")!);
assert.equal(gh.origin + gh.pathname, "https://github.com/login/oauth/authorize");
assert.equal(gh.searchParams.get("redirect_uri"), "https://mentat.example.com/callback");
assert.equal(gh.searchParams.get("code_challenge_method"), "S256");
const login = res.headers.get("Set-Cookie")!;
assert.match(login, /^mentat_login=[\w-]+\.[\w-]+; Path=\/callback; Max-Age=600; HttpOnly; Secure; SameSite=Lax$/);
const loginValue = login.split(";")[0];
const state = gh.searchParams.get("state")!;
assert.match(state, /^graph-/);
assert.equal(await get("/callback?code=x&state=mcp-state"), undefined, "MCP sign-ins pass through");

// Callback: state must match the cookie.
res = (await get(`/callback?code=x&state=graph-wrong`, loginValue))!;
assert.equal(res.status, 400);
res = (await get(`/callback?code=x&state=${state}`))!;
assert.equal(res.status, 400, "no login cookie");

// Callback with a fake GitHub.
const fakeGitHub = (id: number) =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/login/oauth/access_token")) {
      const body = JSON.parse(String(init!.body));
      assert.equal(body.redirect_uri, "https://mentat.example.com/callback");
      assert.ok(body.code_verifier);
      return new Response(JSON.stringify({ access_token: "t" }));
    }
    if (url === "https://api.github.com/user") return new Response(JSON.stringify({ id, login: "x" }));
    throw new Error(`unexpected ${url}`);
  }) as typeof fetch;

res = (await get(`/callback?code=x&state=${state}`, loginValue, fakeGitHub(123)))!;
assert.equal(res.status, 403, "someone else");
res = (await get(`/callback?code=x&state=${state}`, loginValue, fakeGitHub(1234567)))!;
assert.equal(res.status, 302);
assert.equal(res.headers.get("Location"), "/graph");
const session = res.headers.get("Set-Cookie")!.split(", mentat_login")[0];
assert.match(session, /^mentat_session=\d+\.\d+\.[\w-]+; Path=\/graph; Max-Age=604800; HttpOnly; Secure; SameSite=Lax/);

// Signed in: the page.
res = (await get("/graph", session.split(";")[0]))!;
assert.equal(res.status, 200);
assert.match(res.headers.get("Content-Security-Policy")!, /default-src 'none'; script-src 'nonce-/);
assert.equal(res.headers.get("Cache-Control"), "no-store");
const html = await res.text();
assert.match(html, /<title>mentat map<\/title>/);
assert.ok(!/<\/script>[^]*<\/script>[^]*<\/script>[^]*<\/script>/.test(html), "note text can't close the data script");

// Graph data
const data = graphData(notes);
assert.equal(data.nodes.length, bundle.notes.length);
assert.ok(data.links.some((l) => l.source === "acme-cloud" && l.target === "job-hunt"));
const ids = new Set(data.nodes.map((n) => n.id));
assert.ok(data.links.every((l) => ids.has(l.source) && ids.has(l.target)), "no dangling links");

// Logout and other paths
res = (await get("/graph/logout"))!;
assert.match(res.headers.get("Set-Cookie")!, /^mentat_session=; Path=\/graph; Max-Age=0/);
assert.equal(await get("/somewhere-else"), undefined);

console.log("ok: graph page");
