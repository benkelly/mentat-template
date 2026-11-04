// The MCP server: read tools over the bundled notes, plus write tools that
// only ever open pull requests (see github.ts).
// Stateless: a fresh server and transport per request, JSON responses.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Notes, type Note } from "./notes";
import { appendToLog, checkLogEntry, checkNote, checkPath, checkText, todayLocal, type Writer } from "./github";

const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });

function summary(n: Note): string {
  const bits = [n.type, n.status, n.updated && `updated ${n.updated}`].filter(Boolean).join(", ");
  return `- [[${n.slug}]] ${n.title}${bits ? ` (${bits})` : ""}`;
}

export function createServer(notes: Notes, writer?: Writer): McpServer {
  const server = new McpServer(
    { name: "mentat", version: "1.0.0" },
    {
      instructions:
        "A personal knowledge base. Start with read_note('me') for who the owner is and how they like to work, " +
        "then search_notes or list_notes to find context, and related_notes to follow [[links]]. " +
        "Notes are summaries; dates are ISO. Write replies in Irish/British English, short and clear. " +
        "Keep mentat up to date without being asked: when a chat produces something durable (a decision, " +
        "a status change, a new date or deadline, an application sent, a reply received, a new contact), " +
        "propose it near the end of the task with add_log_entry, and with propose_note_change if a note's " +
        "Status or Next steps is now wrong. If a topic will clearly come up again and has no note yet " +
        "(search_notes first), propose a new one: areas/ for an ongoing part of life, projects/ for " +
        "software the owner builds, people/ for someone they deal with. Use the note format (frontmatter: title, " +
        "type, status, updated, tags; sections: Status, Key facts, Next steps, Related) and link it with " +
        "[[slug]]. Batch changes: at most one log entry and one note change per " +
        "chat, unless the owner asks for more. Skip small talk and anything already in the notes. Tell the owner in one " +
        "line what you proposed. These tools open a pull request; nothing changes until they merge. Only " +
        "write facts the owner stated, never raw chats, bank details, ID numbers or passwords.",
    },
  );

  server.registerTool(
    "list_notes",
    {
      title: "List notes",
      description: "List notes, optionally filtered by type (area, project, person, log, profile), tag or status.",
      inputSchema: {
        type: z.string().optional(),
        tag: z.string().optional(),
        status: z.string().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      const list = notes.list(args);
      return text(list.length ? list.map(summary).join("\n") : "No notes match.");
    },
  );

  server.registerTool(
    "read_note",
    {
      title: "Read note",
      description: "Read one note in full by its slug, for example 'acme-cloud', 'me' or '[[job-hunt]]'.",
      inputSchema: { slug: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const note = notes.get(slug);
      if (!note) return { ...text(`No note called '${slug}'. Try search_notes.`), isError: true };
      return text(`# ${note.title}\n\npath: ${note.path}\n\n${note.body}`);
    },
  );

  server.registerTool(
    "search_notes",
    {
      title: "Search notes",
      description: "Keyword search across all notes. Returns the best matches with a snippet.",
      inputSchema: { query: z.string(), limit: z.number().int().min(1).max(25).optional() },
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }) => {
      const hits = notes.search(query, limit ?? 10);
      if (!hits.length) return text(`Nothing found for '${query}'.`);
      return text(hits.map((h) => `${summary(h.note)}\n  ${h.snippet}`).join("\n"));
    },
  );

  server.registerTool(
    "related_notes",
    {
      title: "Related notes",
      description: "Follow the graph: notes this note links to, and notes that link back to it.",
      inputSchema: { slug: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ slug }) => {
      const rel = notes.related(slug);
      if (!rel) return { ...text(`No note called '${slug}'.`), isError: true };
      const out = rel.outgoing.map(summary).join("\n") || "(none)";
      const inc = rel.incoming.map(summary).join("\n") || "(none)";
      return text(`Links to:\n${out}\n\nLinked from:\n${inc}`);
    },
  );

  server.registerTool(
    "latest_log",
    {
      title: "Latest log",
      description: "The most recent monthly log: what happened and what was decided.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const log = notes.latestLog();
      return log ? text(`# ${log.title}\n\n${log.body}`) : text("No logs yet.");
    },
  );

  if (!writer) return server;

  const fail = (msg: string) => ({ ...text(msg), isError: true });

  server.registerTool(
    "read_note_source",
    {
      title: "Read note source",
      description:
        "The full markdown of a note as it is on main now, including frontmatter. " +
        "Use this before propose_note_change, so you edit the latest version. Path like 'areas/acme-cloud.md'.",
      inputSchema: { path: z.string() },
      annotations: { readOnlyHint: true },
    },
    async ({ path }) => {
      const bad = checkPath(path);
      if (bad) return fail(bad);
      const file = await writer.getFile(path);
      return file ? text(file.content) : fail(`No file at ${path} on main.`);
    },
  );

  server.registerTool(
    "add_log_entry",
    {
      title: "Add log entry",
      description:
        "Propose one line for this month's log (logs/YYYY-MM.md): what happened or what was decided. " +
        "Opens a pull request for the owner to merge. One short line, past tense, facts the owner stated.",
      inputSchema: {
        entry: z.string().describe("The log line, without the date. Use [[slug]] links."),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD. Defaults to today in the owner's time zone."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ entry, date }) => {
      const bad = checkLogEntry(entry);
      if (bad) return fail(bad);
      const day = date ?? todayLocal();
      const path = `logs/${day.slice(0, 7)}.md`;

      // One open log PR per month. New entries join it, so log PRs never
      // conflict with each other, whatever order the owner merges things in.
      const open = await writer.findOpenPr(`mcp/logs-${day.slice(0, 7)}-`);
      if (open) {
        const onBranch = await writer.getFile(path, open.branch);
        if (onBranch) {
          await writer.commitTo(open, {
            path,
            content: appendToLog(onBranch.content, day, entry),
            sha: onBranch.sha,
            message: `Log ${day}: ${entry.slice(0, 60)}${entry.length > 60 ? "…" : ""}`,
            note: `Also adds:\n\n> - ${day}: ${entry}`,
          });
          return text(`Added to the open log pull request: ${open.url}\nThe owner needs to merge it before it shows up.`);
        }
      }

      const current = await writer.getFile(path);
      const content = appendToLog(current?.content, day, entry);
      const url = await writer.propose({
        path,
        content,
        title: `Log ${day}: ${entry.slice(0, 60)}${entry.length > 60 ? "…" : ""}`,
        body: `Adds to \`${path}\`:\n\n> - ${day}: ${entry}`,
      });
      return text(`Pull request opened: ${url}\nThe owner needs to merge it before it shows up.`);
    },
  );

  server.registerTool(
    "propose_note_change",
    {
      title: "Propose note change",
      description:
        "Create or update one note in areas/, projects/ or people/ by giving its full new markdown. " +
        "Read the current version with read_note_source first and keep what is still true. " +
        "Follow the note format: frontmatter (title, type, status, updated, tags), then short sections " +
        "(Status, Key facts, Next steps, Related). Opens a pull request for the owner to merge.",
      inputSchema: {
        path: z.string().describe("For example 'areas/acme-cloud.md' or 'people/jordan-lee.md'."),
        content: z.string().describe("The whole file, frontmatter included."),
        reason: z.string().max(300).describe("One sentence: what changed and why."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, content, reason }) => {
      const bad = checkNote(path, content) ?? checkText(reason);
      if (bad) return fail(bad);
      const current = await writer.getFile(path);
      if (current?.content === content) return text("No change: the note on main already matches.");
      const url = await writer.propose({
        path,
        content: content.endsWith("\n") ? content : `${content}\n`,
        title: `${current ? "Update" : "Add"} ${path}`,
        body: reason,
      });
      return text(`Pull request opened: ${url}\nThe owner needs to merge it before it shows up.`);
    },
  );

  return server;
}

export async function handleMcp(request: Request, notes: Notes, writer?: Writer): Promise<Response> {
  const server = createServer(notes, writer);
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await server.connect(transport);
  return transport.handleRequest(request);
}
