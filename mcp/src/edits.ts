// Small, checkable edits to a note's markdown: ticking an item, bumping the
// updated date, and rendering a new note from the standard template.
// Pure functions, no I/O. The tools in mcp.ts turn them into pull requests.

/** Set the frontmatter `updated:` line to a date. Adds one if missing. */
export function bumpUpdated(content: string, date: string): string {
  if (/^---\n[\s\S]*?\nupdated:\s*\S+/.test(content)) {
    return content.replace(/^(---\n[\s\S]*?\nupdated:\s*)\S+/, `$1${date}`);
  }
  return content.replace(/^---\n/, `---\nupdated: ${date}\n`);
}

/**
 * Tick one `- [ ]` item. `item` is the item's text, or a unique part of it
 * (case-insensitive). Returns the new content, or an error message.
 */
export function tickItem(content: string, item: string, date: string): { content: string } | { error: string } {
  const want = item.trim().toLowerCase();
  if (!want) return { error: "Say which item to tick." };
  const lines = content.split("\n");
  const open = lines
    .map((line, i) => ({ i, m: /^(\s*[-*] )\[ \] (.+?)\s*$/.exec(line) }))
    .filter((x): x is { i: number; m: RegExpExecArray } => !!x.m);
  if (!open.length) return { error: "That note has no open items." };
  let hits = open.filter((x) => x.m[2].trim().toLowerCase() === want);
  if (!hits.length) hits = open.filter((x) => x.m[2].toLowerCase().includes(want));
  if (!hits.length) {
    return { error: `No open item matches '${item}'. Open items:\n${open.map((x) => `- [ ] ${x.m[2]}`).join("\n")}` };
  }
  if (hits.length > 1) {
    return { error: `More than one open item matches '${item}':\n${hits.map((x) => `- [ ] ${x.m[2]}`).join("\n")}` };
  }
  const hit = hits[0];
  lines[hit.i] = `${hit.m[1]}[x] ${hit.m[2]}`;
  return { content: bumpUpdated(lines.join("\n"), date) };
}

export interface NewNote {
  title: string;
  type: "area" | "project" | "person" | "people";
  status?: string;
  tags: string[];
  updated: string;
  /** One or two sentences for the Status section. */
  summary?: string;
  keyFacts?: string[];
  nextSteps?: string[];
  /** Slugs of related notes, without brackets. */
  related?: string[];
}

/** Render a note in the standard format from AGENTS.md. */
export function renderNote(n: NewNote): string {
  const tags = n.tags.map((t) => t.trim()).filter(Boolean);
  const head = [
    "---",
    `title: ${n.title.trim()}`,
    `type: ${n.type}`,
    ...(n.status ? [`status: ${n.status}`] : []),
    `updated: ${n.updated}`,
    `tags: [${tags.join(", ")}]`,
    "---",
  ];
  const section = (name: string, lines: string[] | undefined, prefix: string) =>
    lines && lines.length ? [`## ${name}`, "", ...lines.map((l) => `${prefix}${l.trim()}`), ""] : [];
  const body = [
    ...(n.summary?.trim() ? ["## Status", "", n.summary.trim(), ""] : []),
    ...section("Key facts", n.keyFacts, "- "),
    ...section("Next steps", n.nextSteps, "- [ ] "),
    ...section("Related", n.related?.map((s) => `[[${s.replace(/^\[\[|\]\]$/g, "").trim()}]]`), "- "),
  ];
  return `${head.join("\n")}\n\n${body.join("\n")}`.replace(/\n+$/, "\n");
}
