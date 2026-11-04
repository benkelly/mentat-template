// /graph: an interactive map of the notes in the browser, for the owner only.
//
// Sign-in is GitHub, like the MCP endpoint, but for a browser: after GitHub
// says who you are, we set a signed session cookie. Only ALLOWED_GITHUB_ID
// gets one.
//
//   GET /graph            the page (or a redirect to GitHub sign-in)
//   GET /callback         GitHub sends the browser back here. Graph sign-ins
//                         are told apart from MCP sign-ins by a "graph-"
//                         state prefix; everything else goes to the MCP flow.
//   GET /graph/logout     clears the session
//
// GitHub only accepts the exact registered callback URL, so the graph shares
// /callback with the MCP sign-in.

import { isAllowedUser, type GitHubUser } from "./auth";
import type { Notes } from "./notes";

export interface GraphEnv {
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  ALLOWED_GITHUB_ID: string;
}

const SESSION = "mentat_session";
const LOGIN = "mentat_login";
const SESSION_SECONDS = 7 * 24 * 3600;
const LOGIN_SECONDS = 600;
const STATE_PREFIX = "graph-";

const enc = new TextEncoder();
const b64url = (bytes: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
const randomToken = () => b64url(crypto.getRandomValues(new Uint8Array(32)));

// The session key is derived from the GitHub client secret, so rotating that
// secret also signs everyone out.
async function sessionKey(env: GraphEnv): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", enc.encode(env.GITHUB_CLIENT_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const derived = await crypto.subtle.sign("HMAC", base, enc.encode("mentat graph session v1"));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function makeSession(env: GraphEnv, githubId: string, now = Date.now()): Promise<string> {
  const payload = `${githubId}.${Math.floor(now / 1000) + SESSION_SECONDS}`;
  const sig = await crypto.subtle.sign("HMAC", await sessionKey(env), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

export async function checkSession(env: GraphEnv, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!value) return false;
  const m = /^(\d+)\.(\d+)\.([A-Za-z0-9_-]+)$/.exec(value);
  if (!m) return false;
  const [, id, exp, sig] = m;
  if (id !== env.ALLOWED_GITHUB_ID || Number(exp) * 1000 < now) return false;
  let sigBytes: Uint8Array;
  try {
    sigBytes = Uint8Array.from(atob(sig.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }
  return crypto.subtle.verify("HMAC", await sessionKey(env), sigBytes, enc.encode(`${id}.${exp}`));
}

function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("Cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return undefined;
}

const setCookie = (name: string, value: string, path: string, maxAge: number) =>
  `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;

async function s256(verifier: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
}

const plain = (text: string, status: number) =>
  new Response(`${text}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" } });

export async function handleGraph(req: Request, env: GraphEnv, notes: Notes, fetcher: typeof fetch = (i, n) => fetch(i, n)): Promise<Response | undefined> {
  const url = new URL(req.url);
  if (req.method !== "GET") return undefined;

  if (url.pathname === "/graph/logout") {
    const headers = new Headers({ Location: "/graph/signed-out" });
    headers.append("Set-Cookie", setCookie(SESSION, "", "/graph", 0));
    return new Response(null, { status: 302, headers });
  }
  if (url.pathname === "/graph/signed-out") return plain("Signed out of mentat.", 200);

  if (url.pathname === "/graph") {
    if (await checkSession(env, cookie(req, SESSION))) return graphPage(notes);

    // Start GitHub sign-in. State and PKCE verifier live in a short cookie
    // scoped to the callback path.
    const state = STATE_PREFIX + randomToken();
    const verifier = randomToken();
    const gh = new URL("https://github.com/login/oauth/authorize");
    gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
    gh.searchParams.set("redirect_uri", `${url.origin}/callback`);
    gh.searchParams.set("scope", "read:user");
    gh.searchParams.set("state", state);
    gh.searchParams.set("code_challenge", await s256(verifier));
    gh.searchParams.set("code_challenge_method", "S256");
    gh.searchParams.set("allow_signup", "false");
    const headers = new Headers({ Location: gh.toString(), "Cache-Control": "no-store" });
    headers.append("Set-Cookie", setCookie(LOGIN, `${state}.${verifier}`, "/callback", LOGIN_SECONDS));
    return new Response(null, { status: 302, headers });
  }

  if (url.pathname === "/callback" && (url.searchParams.get("state") ?? "").startsWith(STATE_PREFIX)) {
    const [state, verifier] = (cookie(req, LOGIN) ?? "").split(".");
    const code = url.searchParams.get("code");
    if (!state || !verifier || url.searchParams.get("state") !== state) {
      return plain("Sign-in expired or was not started here. Open /graph again.", 400);
    }
    if (!code || url.searchParams.get("error")) return plain("GitHub sign-in was cancelled.", 400);

    const tokenRes = await fetcher("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: env.GITHUB_CLIENT_ID,
        client_secret: env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${url.origin}/callback`,
        code_verifier: verifier,
      }),
    });
    const token = (await tokenRes.json()) as { access_token?: string };
    if (!token.access_token) return plain("GitHub sign-in failed.", 502);

    const userRes = await fetcher("https://api.github.com/user", {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "mentat-mcp" },
    });
    const user = (await userRes.json()) as GitHubUser;
    if (!userRes.ok || !isAllowedUser(user, env.ALLOWED_GITHUB_ID)) return plain("This GitHub account can't see these notes.", 403);

    const headers = new Headers({ Location: "/graph", "Cache-Control": "no-store" });
    headers.append("Set-Cookie", setCookie(SESSION, await makeSession(env, String(user.id)), "/graph", SESSION_SECONDS));
    headers.append("Set-Cookie", setCookie(LOGIN, "", "/callback", 0));
    return new Response(null, { status: 302, headers });
  }

  return undefined;
}

export function graphData(notes: Notes) {
  const all = notes.bundle.notes;
  const known = new Set(all.map((n) => n.slug));
  return {
    built: notes.bundle.built,
    nodes: all.map((n) => ({ id: n.slug, title: n.title, type: n.type || "note", status: n.status, updated: n.updated, body: n.body })),
    links: all.flatMap((n) => [...new Set(n.links)].filter((t) => known.has(t) && t !== n.slug).map((t) => ({ source: n.slug, target: t }))),
  };
}

export function graphPage(notes: Notes, opts: { demo?: boolean } = {}): Response {
  const nonce = randomToken();
  // JSON inside <script type="application/json">: stop "</script>" breaking out.
  const data = JSON.stringify(graphData(notes)).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en-IE">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${opts.demo ? "mentat demo map" : "mentat map"}</title>
<style nonce="${nonce}">
:root{--bg:#f7f7f5;--fg:#1c1c1c;--muted:#666;--line:#c9c9c4;--panel:#fff;--area:#2f7d5b;--project:#3567b5;--person:#b5652f;--log:#7b5bb5;--profile:#b53567;--note:#777}
@media (prefers-color-scheme: dark){:root{--bg:#141414;--fg:#eee;--muted:#a3a3a3;--line:#3a3a3a;--panel:#1d1d1d;--area:#5fbf93;--project:#7fa7ea;--person:#e59b63;--log:#ab8ce6;--profile:#e57fa3;--note:#999}}
*{box-sizing:border-box}
body{margin:0;font:16px/1.5 system-ui,sans-serif;background:var(--bg);color:var(--fg);display:grid;grid-template-columns:1fr minmax(18rem,28rem);height:100vh}
header{position:absolute;top:.6rem;left:1rem;right:29rem;display:flex;gap:.6rem;align-items:center;flex-wrap:wrap}
header h1{font-size:1.1rem;margin:0}
input{font:inherit;padding:.35rem .6rem;border:1px solid var(--line);border-radius:.4rem;background:var(--panel);color:var(--fg);min-width:12rem}
.legend{display:flex;flex-wrap:wrap;gap:.2rem .7rem;font-size:.85rem;color:var(--muted)}
.legend span{white-space:nowrap}
.legend span::before{content:"";display:inline-block;width:.7rem;height:.7rem;border-radius:50%;margin-right:.3rem;background:var(--c)}
svg{width:100%;height:100vh;display:block;touch-action:none;cursor:grab}
line{stroke:var(--line);stroke-width:1.2}
circle{stroke:var(--bg);stroke-width:2;cursor:pointer}
text{font-size:12px;fill:var(--fg);pointer-events:none;paint-order:stroke;stroke:var(--bg);stroke-width:3px}
.dim{opacity:.15}
aside{background:var(--panel);border-left:1px solid var(--line);padding:1rem 1.2rem;overflow:auto;height:100vh}
aside h2{margin:.2rem 0 .2rem;font-size:1.3rem}
aside .meta{color:var(--muted);font-size:.85rem;margin-bottom:.8rem}
aside .body{white-space:pre-wrap;font-size:.95rem}
aside button.link{font:inherit;background:none;border:0;padding:0;color:var(--project);text-decoration:underline;cursor:pointer}
aside ul.list{list-style:none;padding:0;margin:0}
aside ul.list li{padding:.15rem 0}
footer{color:var(--muted);font-size:.8rem;margin-top:1.5rem}
footer a{color:var(--muted)}
@media (max-width:760px){body{grid-template-columns:1fr;grid-template-rows:55vh 45vh;height:auto}svg{height:55vh}aside{height:45vh;border-left:0;border-top:1px solid var(--line)}header{right:1rem}.legend{font-size:.75rem}}
</style>
<header>
  <h1>mentat</h1>
  <input id="q" type="search" placeholder="Find a note" aria-label="Find a note">
  <div class="legend"></div>
</header>
<svg id="g" aria-label="Map of notes"></svg>
<aside id="panel"></aside>
<script type="application/json" id="data">${data}</script>
<script nonce="${nonce}">
(() => {
  const data = JSON.parse(document.getElementById("data").textContent);
  const DEMO = ${opts.demo ? "true" : "false"};
  const svg = document.getElementById("g");
  const panel = document.getElementById("panel");
  const NS = "http://www.w3.org/2000/svg";
  const types = [...new Set(data.nodes.map(n => n.type))].sort();
  const color = t => "var(--" + (["area","project","person","log","profile"].includes(t) ? t : "note") + ")";
  document.querySelector(".legend").innerHTML = types.map(t => '<span style="--c:' + color(t) + '">' + t + "</span>").join("");

  const byId = new Map(data.nodes.map(n => [n.id, n]));
  const degree = new Map(data.nodes.map(n => [n.id, 0]));
  data.links.forEach(l => { degree.set(l.source, degree.get(l.source) + 1); degree.set(l.target, degree.get(l.target) + 1); });
  const neighbours = new Map(data.nodes.map(n => [n.id, new Set([n.id])]));
  data.links.forEach(l => { neighbours.get(l.source).add(l.target); neighbours.get(l.target).add(l.source); });

  // Simple force layout: springs on links, repulsion between nodes, pull to centre.
  let W = svg.clientWidth, H = svg.clientHeight;
  data.nodes.forEach((n, i) => { const a = i * 2.4; n.x = W / 2 + Math.cos(a) * 30 * Math.sqrt(i); n.y = H / 2 + Math.sin(a) * 30 * Math.sqrt(i); n.vx = 0; n.vy = 0; n.r = 6 + 2 * Math.sqrt(degree.get(n.id)); });
  const view = { x: 0, y: 0, k: 1 };
  const root = document.createElementNS(NS, "g"); svg.appendChild(root);
  const lines = data.links.map(l => { const e = document.createElementNS(NS, "line"); root.appendChild(e); return e; });
  const nodes = data.nodes.map(n => {
    const g = document.createElementNS(NS, "g");
    const c = document.createElementNS(NS, "circle"); c.setAttribute("r", n.r); c.style.fill = color(n.type);
    const t = document.createElementNS(NS, "text"); t.textContent = n.title; t.setAttribute("dx", n.r + 3); t.setAttribute("dy", 4);
    const tip = document.createElementNS(NS, "title"); tip.textContent = n.title; c.appendChild(tip);
    g.append(c, t); root.appendChild(g);
    c.addEventListener("pointerdown", ev => { ev.stopPropagation(); drag = n; n.fixed = true; moved = false; svg.setPointerCapture(ev.pointerId); });
    c.addEventListener("click", () => { if (!moved) show(n.id); });
    return g;
  });

  let alpha = 1, drag = null, moved = false;
  function tick() {
    if (alpha > 0.01) {
      for (const a of data.nodes) for (const b of data.nodes) {
        if (a === b) continue;
        let dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 1;
        if (d2 > 90000) continue;
        const f = 1600 / d2; a.vx += dx * f * alpha * 0.05; a.vy += dy * f * alpha * 0.05;
      }
      for (const l of data.links) {
        const a = byId.get(l.source), b = byId.get(l.target);
        const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 1, f = (d - 120) / d * 0.04 * alpha;
        a.vx += dx * f; a.vy += dy * f; b.vx -= dx * f; b.vy -= dy * f;
      }
      for (const n of data.nodes) {
        n.vx += (W / 2 - n.x) * 0.002 * alpha; n.vy += (H / 2 - n.y) * 0.002 * alpha;
        if (!n.fixed) { n.x += n.vx; n.y += n.vy; }
        n.vx *= 0.6; n.vy *= 0.6;
      }
      alpha *= 0.985;
    }
    draw(); requestAnimationFrame(tick);
  }
  function draw() {
    root.setAttribute("transform", "translate(" + view.x + "," + view.y + ") scale(" + view.k + ")");
    data.links.forEach((l, i) => { const a = byId.get(l.source), b = byId.get(l.target); const e = lines[i]; e.setAttribute("x1", a.x); e.setAttribute("y1", a.y); e.setAttribute("x2", b.x); e.setAttribute("y2", b.y); });
    data.nodes.forEach((n, i) => nodes[i].setAttribute("transform", "translate(" + n.x + "," + n.y + ")"));
  }

  // Pan, zoom and drag.
  let pan = null;
  svg.addEventListener("pointerdown", ev => { pan = { x: ev.clientX - view.x, y: ev.clientY - view.y }; svg.setPointerCapture(ev.pointerId); });
  svg.addEventListener("pointermove", ev => {
    if (drag) { const r = svg.getBoundingClientRect(); drag.x = (ev.clientX - r.left - view.x) / view.k; drag.y = (ev.clientY - r.top - view.y) / view.k; moved = true; alpha = Math.max(alpha, 0.3); }
    else if (pan) { view.x = ev.clientX - pan.x; view.y = ev.clientY - pan.y; }
  });
  svg.addEventListener("pointerup", () => { if (drag) drag.fixed = false; drag = null; pan = null; });
  svg.addEventListener("wheel", ev => {
    ev.preventDefault(); const r = svg.getBoundingClientRect(), mx = ev.clientX - r.left, my = ev.clientY - r.top;
    const k = Math.min(4, Math.max(0.3, view.k * (ev.deltaY < 0 ? 1.1 : 0.9)));
    view.x = mx - (mx - view.x) * k / view.k; view.y = my - (my - view.y) * k / view.k; view.k = k;
  }, { passive: false });
  addEventListener("resize", () => { W = svg.clientWidth; H = svg.clientHeight; alpha = Math.max(alpha, 0.2); });

  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => "&#" + c.charCodeAt(0) + ";");
  const linkify = s => esc(s).replace(/\\[\\[([^\\]|]+)(?:\\|[^\\]]*)?\\]\\]/g, (m, slug) => byId.has(slug) ? '<button class="link" data-id="' + esc(slug) + '">' + esc(byId.get(slug).title) + "</button>" : m);

  function highlight(id) {
    const near = id ? neighbours.get(id) : null;
    data.nodes.forEach((n, i) => nodes[i].classList.toggle("dim", !!near && !near.has(n.id)));
    data.links.forEach((l, i) => lines[i].classList.toggle("dim", !!near && l.source !== id && l.target !== id));
  }
  function show(id) {
    const n = byId.get(id); if (!n) return;
    highlight(id);
    const meta = [n.type, n.status, n.updated && "updated " + n.updated].filter(Boolean).join(" · ");
    const linksTo = [...neighbours.get(id)].filter(x => x !== id).map(x => '<li><button class="link" data-id="' + esc(x) + '">' + esc(byId.get(x).title) + "</button></li>").join("");
    panel.innerHTML = "<h2>" + esc(n.title) + '</h2><div class="meta">[[' + esc(n.id) + "]] · " + esc(meta) + '</div><div class="body">' + linkify(n.body) + "</div>" + (linksTo ? "<h3>Connected</h3><ul class=list>" + linksTo + "</ul>" : "") + footer();
    panel.scrollTop = 0;
    history.replaceState(null, "", "#" + encodeURIComponent(id));
  }
  function home() {
    highlight(null);
    const groups = types.map(t => "<h3>" + esc(t) + "</h3><ul class=list>" + data.nodes.filter(n => n.type === t).sort((a, b) => a.title.localeCompare(b.title)).map(n => '<li><button class="link" data-id="' + esc(n.id) + '">' + esc(n.title) + "</button></li>").join("") + "</ul>").join("");
    panel.innerHTML = "<h2>All notes</h2><div class=meta>" + data.nodes.length + " notes, " + data.links.length + " links. Click a dot or a name.</div>" + groups + footer();
  }
  const footer = () => '<footer>' + (DEMO ? 'Demo notes about a made-up person · <a href="https://github.com/benkelly/mentat-template">Source</a>' : 'Built ' + esc(data.built)) + ' · <a href="#" data-home>All notes</a>' + (DEMO ? '' : ' · <a href="/graph/logout">Sign out</a>') + '</footer>';
  panel.addEventListener("click", ev => {
    const b = ev.target.closest("[data-id]"); if (b) { ev.preventDefault(); show(b.dataset.id); }
    if (ev.target.closest("[data-home]")) { ev.preventDefault(); history.replaceState(null, "", location.pathname); home(); }
  });
  document.getElementById("q").addEventListener("input", ev => {
    const q = ev.target.value.trim().toLowerCase();
    if (!q) return highlight(null);
    const hits = new Set(data.nodes.filter(n => (n.title + " " + n.id + " " + n.body).toLowerCase().includes(q)).map(n => n.id));
    data.nodes.forEach((n, i) => nodes[i].classList.toggle("dim", !hits.has(n.id)));
    lines.forEach(e => e.classList.add("dim"));
  });
  document.getElementById("q").addEventListener("keydown", ev => {
    if (ev.key !== "Enter") return;
    const q = ev.target.value.trim().toLowerCase();
    const hit = data.nodes.find(n => n.title.toLowerCase().includes(q) || n.id.includes(q)); if (hit) show(hit.id);
  });

  const start = decodeURIComponent(location.hash.slice(1));
  byId.has(start) ? show(start) : home();
  tick();
})();
</script>
</html>`;
  return new Response(html, {
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; style-src-attr 'unsafe-inline'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}
