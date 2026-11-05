// The MCP server: read tools over the bundled notes, plus write tools that
// only ever open pull requests (see github.ts).
// Stateless: a fresh server and transport per request, JSON responses.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import { Notes, type Note } from "./notes";
import { appendToLog, checkLogEntry, checkNote, checkPath, checkText, todayLocal, type Writer } from "./github";
import { renderNote, tickItem } from "./edits";

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
        "then search_notes or list_notes to find context, related_notes to follow [[links]], and open_items for what is next. " +
        "Notes are summaries; dates are ISO. Write replies in Irish/British English, short and clear. " +
        "Keep mentat up to date without being asked: when a chat produces something durable (a decision, " +
        "a status change, a new date or deadline, an application sent, a reply received, a new contact), " +
        "propose it near the end of the task with add_log_entry, and with propose_note_change if a note's " +
        "Status or Next steps is now wrong, or complete_item when something on a list got done. If a topic will clearly come up again and has no note yet " +
        "(search_notes first), propose one with new_note: areas/ for an ongoing part of life, projects/ for " +
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
      description: "List notes, optionally filtered by type (area, project, person, people, log, profile), tag or status.",
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

  server.registerTool(
    "open_items",
    {
      title: "Open items",
      description:
        "Every unticked task across the notes, grouped by note, then the dated ones in date order, " +
        "then other lines that mention a future date (interviews, deadlines). " +
        "The quickest way to answer 'what is next' or 'what is due this week'.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    async () => {
      const today = todayLocal();
      const items = notes.openItems();
      const ahead = notes.datesAhead(today).map((i) => `- ${i.date}: [[${i.note.slug}]]: ${i.text}`);
      if (!items.length && !ahead.length) return text(`Today: ${today}\n\nNothing open.`);
      const byNote = new Map<string, string[]>();
      for (const i of items) byNote.set(i.note.slug, [...(byNote.get(i.note.slug) ?? []), i.text]);
      const grouped = [...byNote].map(([slug, texts]) => `[[${slug}]]\n${texts.map((t) => `  - [ ] ${t}`).join("\n")}`);
      const dated = items
        .filter((i) => i.date)
        .sort((a, b) => a.date.localeCompare(b.date) || a.note.slug.localeCompare(b.note.slug))
        .map((i) => `- ${i.date}: [[${i.note.slug}]]: ${i.text}`);
      return text(
        `Today: ${today}\n\n${grouped.join("\n")}` +
          (dated.length ? `\n\nDated:\n${dated.join("\n")}` : "") +
          (ahead.length ? `\n\nDates ahead:\n${ahead.join("\n")}` : ""),
      );
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

  server.registerTool(
    "complete_item",
    {
      title: "Complete item",
      description:
        "Tick one open '- [ ]' item in a note and bump its updated date. Give the item's text, or a unique part of it. " +
        "Opens a small pull request that merges on its own after a wait, like log lines. " +
        "Use this instead of propose_note_change when the only change is that something got done.",
      inputSchema: {
        path: z.string().describe("For example 'areas/acme-cloud.md'."),
        item: z.string().max(300).describe("The item's text, or a unique part of it."),
        date: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional()
          .describe("YYYY-MM-DD for the updated date. Defaults to today in the owner's time zone."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ path, item, date }) => {
      const bad = checkPath(path) ?? checkText(item);
      if (bad) return fail(bad);
      if (/^logs\//.test(path)) return fail("Logs have no items to tick. Use add_log_entry.");
      const current = await writer.getFile(path);
      if (!current) return fail(`No file at ${path} on main.`);
      const result = tickItem(current.content, item, date ?? todayLocal());
      if ("error" in result) return fail(result.error);
      const url = await writer.propose({
        path,
        content: result.content,
        title: `Tick ${path}: ${item.slice(0, 60)}${item.length > 60 ? "…" : ""}`,
        body: `Ticks one item in \`${path}\`:\n\n> - [x] ${item}`,
      });
      return text(`Pull request opened: ${url}\nIt merges on its own after the usual wait unless the owner stops it.`);
    },
  );

  server.registerTool(
    "new_note",
    {
      title: "New note",
      description:
        "Create a note in the standard format: frontmatter, then Status, Key facts, Next steps and Related. " +
        "For a new area (ongoing part of life), project (software the owner builds), person or people (a group). " +
        "Search first: if the note exists, use propose_note_change instead. Opens a pull request for the owner to merge.",
      inputSchema: {
        path: z.string().describe("For example 'people/jordan-lee.md'. Lower-case slug."),
        title: z.string().max(120),
        type: z.enum(["area", "project", "person", "people"]),
        status: z.enum(["active", "waiting", "done", "idea"]).optional().describe("Required for areas and projects."),
        tags: z.array(z.string().max(40)).max(10).describe("For example ['job-hunt', 'acme-cloud']."),
        summary: z.string().max(600).optional().describe("One or two sentences for the Status section."),
        key_facts: z.array(z.string().max(500)).max(30).optional(),
        next_steps: z.array(z.string().max(300)).max(20).optional().describe("Open items. Each becomes '- [ ] ...'."),
        related: z.array(z.string().max(60)).max(20).optional().describe("Slugs of related notes, for example ['job-hunt']."),
        reason: z.string().max(300).describe("One sentence: why this note is needed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async (a) => {
      if (/^logs\//.test(a.path)) return fail("Logs are written with add_log_entry.");
      if ((a.type === "area" || a.type === "project") && !a.status) return fail(`A ${a.type} note needs a status.`);
      const folder = a.type === "person" || a.type === "people" ? "people" : `${a.type}s`;
      if (!a.path.startsWith(`${folder}/`)) return fail(`A ${a.type} note goes in ${folder}/.`);
      const unknown = (a.related ?? []).map((r) => r.replace(/^\[\[|\]\]$/g, "").trim()).filter((r) => !notes.get(r));
      if (unknown.length) return fail(`No note called ${unknown.map((u) => `'${u}'`).join(", ")}. Related must be existing slugs.`);
      const content = renderNote({
        title: a.title,
        type: a.type,
        status: a.status,
        tags: a.tags,
        updated: todayLocal(),
        summary: a.summary,
        keyFacts: a.key_facts,
        nextSteps: a.next_steps,
        related: a.related,
      });
      const bad = checkNote(a.path, content) ?? checkText(a.reason);
      if (bad) return fail(bad);
      if (await writer.getFile(a.path)) return fail(`${a.path} already exists. Read it with read_note_source and use propose_note_change.`);
      const url = await writer.propose({ path: a.path, content, title: `Add ${a.path}`, body: a.reason });
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
