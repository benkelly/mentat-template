// Public demo Worker: the made-up demo notes, read-only, no sign-in.
//
// A separate entry point on purpose. It never imports the OAuth code or the
// write tools, so the real Worker (src/index.ts) can't be switched into an
// open mode by a setting. Deployed with wrangler.demo.jsonc.
//
//   /        short text
//   /mcp     MCP server with the five read tools
//   /graph   the map, no sign-in

import { graphPage } from "./graph";
import { handleMcp } from "./mcp";
import { Notes, type Bundle } from "./notes";
import bundle from "./notes.generated.json";

const notes = new Notes(bundle as Bundle);

const text = (body: string, status = 200) =>
  new Response(`${body}\n`, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });

export async function handleDemo(req: Request): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/") {
    return text(
      "mentat demo: made-up notes about a made-up person, read-only.\n" +
        "Add https://" + url.host + "/mcp to Claude or OpenCode as a connector (no sign-in), or open /graph.\n" +
        "Source: https://github.com/benkelly/mentat-template",
    );
  }
  if (url.pathname === "/mcp") return handleMcp(req, notes);
  if (url.pathname === "/graph" && req.method === "GET") return graphPage(notes, { demo: true });
  return text("Not found", 404);
}

export default { fetch: handleDemo } satisfies ExportedHandler;
