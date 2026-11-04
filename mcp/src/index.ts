// mentat MCP server on Cloudflare Workers.
//
// /mcp            the MCP endpoint. Needs an OAuth token issued by this Worker.
// /authorize      consent page, then sign in with GitHub.
// /callback       GitHub sends the user back here. Only the GitHub user ALLOWED_GITHUB_ID gets a token.
// /graph          map of the notes in the browser, behind GitHub sign-in (see graph.ts).
// /register, /oauth/token, /.well-known/*   handled by OAuthProvider.

import OAuthProvider, {
  AuthorizationError,
  type ConsentDescription,
  authorizationErrorRedirect,
} from "@cloudflare/workers-oauth-provider";
import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { isAllowedUser, type GitHubUser } from "./auth";
import { GitHubWriter } from "./github";
import { handleGraph } from "./graph";
import { handleMcp } from "./mcp";
import { Notes, type Bundle } from "./notes";
import bundle from "./notes.generated.json";

export interface Env {
  OAUTH_KV: KVNamespace;
  OAUTH_PROVIDER: OAuthHelpers;
  GITHUB_CLIENT_ID: string;
  GITHUB_CLIENT_SECRET: string;
  // Numeric GitHub user ID, as a string. Logins can change, IDs can't.
  ALLOWED_GITHUB_ID: string;
  // "owner/repo" of the notes repository, for the write tools.
  NOTES_REPO?: string;
  // Optional. Fine-grained token for NOTES_REPO (contents + pull requests).
  // Without it, the connector is read-only.
  GITHUB_WRITE_TOKEN?: string;
}

interface Props {
  login: string;
}

const notes = new Notes(bundle as Bundle);

const McpApiHandler = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const props = ctx.props as Props | undefined;
    if (!props?.login) return new Response("Unauthorised", { status: 401 });
    const writer =
      env.GITHUB_WRITE_TOKEN && env.NOTES_REPO ? new GitHubWriter(env.GITHUB_WRITE_TOKEN, env.NOTES_REPO) : undefined;
    return handleMcp(request, notes, writer);
  },
};

const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function consentPage(d: ConsentDescription, handle: string): string {
  const name = escape(d.clientName);
  const origin = d.clientDomain
    ? `Published by <strong>${escape(d.clientDomain)}</strong>.`
    : "This app registered itself, so its name is not verified.";
  const scopes = d.scope.map((s) => `<li>${escape(s)}</li>`).join("");
  return `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Allow ${name}?</title>
<style>
  body{font:18px/1.6 system-ui,sans-serif;max-width:32rem;margin:3rem auto;padding:0 1rem;background:#111;color:#eee}
  button{font:inherit;padding:.6rem 1.4rem;margin-right:.6rem;border-radius:.4rem;border:1px solid #888;cursor:pointer}
  .ok{background:#2a7;color:#fff;border-color:#2a7}
</style>
<h1>Allow ${name} to read your mentat notes?</h1>
<p>${origin}</p>
<p>Access goes to <strong>${escape(d.redirectHost)}</strong>.</p>
${d.redirectIsLoopback ? "<p><strong>This sends access to an app on this computer.</strong> Only continue if you just started signing in from it.</p>" : ""}
<p>Access requested:</p><ul>${scopes}</ul>
<p>Next you'll sign in with GitHub.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escape(handle)}">
  <button class="ok" name="decision" value="approve">Allow</button>
  <button name="decision" value="deny">Deny</button>
</form>`;
}

async function s256(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

const defaultHandler = {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const oauth = env.OAUTH_PROVIDER;

    const graph = await handleGraph(req, env, notes);
    if (graph) return graph;

    if (url.pathname === "/") {
      return new Response("mentat MCP server. Connect an MCP client to /mcp.\n", {
        headers: { "Content-Type": "text/plain" },
      });
    }

    if (url.pathname === "/authorize" && req.method === "GET") {
      let request;
      try {
        request = await oauth.parseAuthRequest(req);
      } catch (e) {
        if (!(e instanceof AuthorizationError)) throw e;
        // Log what was wrong with the request, so it shows in Workers Logs.
        console.log("authorize rejected", {
          code: e.code,
          description: e.description,
          resource: url.searchParams.getAll("resource"),
          scope: url.searchParams.get("scope"),
          client_id: url.searchParams.get("client_id"),
        });
        if (e.redirectTo) return Response.redirect(e.redirectTo, 302);
        return new Response(`Sign-in request rejected: ${e.code}: ${e.description}\n`, {
          status: 400,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
      const details = await oauth.describeConsent(request);
      const consent = await oauth.beginConsent(request);
      consent.headers.set("Content-Type", "text/html; charset=utf-8");
      return new Response(consentPage(details, consent.handle), { headers: consent.headers });
    }

    if (url.pathname === "/authorize" && req.method === "POST") {
      const form = await req.formData();
      const handle = String(form.get("handle"));
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(req, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(req, handle);
      const verifier = crypto.randomUUID() + crypto.randomUUID();
      const { state, headers } = await oauth.beginUpstream(approved.request, {
        data: { verifier },
        headers: approved.headers,
      });
      const gh = new URL("https://github.com/login/oauth/authorize");
      gh.searchParams.set("client_id", env.GITHUB_CLIENT_ID);
      gh.searchParams.set("redirect_uri", `${url.origin}/callback`);
      gh.searchParams.set("scope", "read:user");
      gh.searchParams.set("state", state);
      gh.searchParams.set("code_challenge", await s256(verifier));
      gh.searchParams.set("code_challenge_method", "S256");
      gh.searchParams.set("allow_signup", "false");
      headers.set("Location", gh.toString());
      return new Response(null, { status: 302, headers });
    }

    if (url.pathname === "/callback") {
      const { request: original, data, headers } = await oauth.finishUpstream<{ verifier: string }>(req);
      const code = url.searchParams.get("code");
      if (url.searchParams.get("error") || !code) {
        headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
        return new Response(null, { status: 302, headers });
      }

      const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: env.GITHUB_CLIENT_ID,
          client_secret: env.GITHUB_CLIENT_SECRET,
          code,
          redirect_uri: `${url.origin}/callback`,
          code_verifier: data.verifier,
        }),
      });
      const token = (await tokenRes.json()) as { access_token?: string };
      if (!token.access_token) return new Response("GitHub sign-in failed.", { status: 502 });

      const userRes = await fetch("https://api.github.com/user", {
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "mentat-mcp",
        },
      });
      const user = (await userRes.json()) as GitHubUser;

      // The only check that matters: is this the owner? Match the numeric ID, not the login.
      if (!userRes.ok || !isAllowedUser(user, env.ALLOWED_GITHUB_ID)) {
        headers.set("Location", authorizationErrorRedirect(original, "access_denied"));
        return new Response(null, { status: 302, headers });
      }

      const { redirectTo } = await oauth.completeAuthorization({
        request: original,
        userId: String(user.id),
        metadata: { login: user.login ?? String(user.id) },
        scope: original.scope,
        props: { login: user.login ?? String(user.id) } satisfies Props,
      });
      headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers });
    }

    return new Response("Not found", { status: 404 });
  },
};

// The provider needs the public URL of this Worker (workers.dev or a custom
// domain). Build it once per origin from the first request.
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: McpApiHandler,
      defaultHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp:read"],
      requiredScopes: ["mcp:read"],
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "mentat",
      },
      clientIdMetadataDocumentEnabled: true,
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
