// Read-only access to the bundled notes. The bundle is built by
// scripts/bundle_notes.py from the repo's markdown files.

export interface Note {
  slug: string;
  path: string;
  title: string;
  type: string;
  status: string;
  updated: string;
  tags: string[];
  links: string[];
  body: string;
}

export interface Bundle {
  built: string;
  notes: Note[];
}

export class Notes {
  private bySlug = new Map<string, Note>();
  private backlinks = new Map<string, Set<string>>();

  constructor(readonly bundle: Bundle) {
    for (const note of bundle.notes) this.bySlug.set(note.slug, note);
    for (const note of bundle.notes) {
      for (const target of note.links) {
        if (!this.backlinks.has(target)) this.backlinks.set(target, new Set());
        this.backlinks.get(target)!.add(note.slug);
      }
    }
  }

  get(slug: string): Note | undefined {
    return this.bySlug.get(normaliseSlug(slug));
  }

  list(filter: { type?: string; tag?: string; status?: string } = {}): Note[] {
    return this.bundle.notes
      .filter((n) => !filter.type || n.type === filter.type)
      .filter((n) => !filter.tag || n.tags.includes(filter.tag))
      .filter((n) => !filter.status || n.status === filter.status)
      .sort((a, b) => a.title.localeCompare(b.title));
  }

  /** Simple ranked keyword search over title, tags and body. */
  search(query: string, limit = 10): { note: Note; score: number; snippet: string }[] {
    const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 1);
    if (terms.length === 0) return [];
    const results = [];
    for (const note of this.bundle.notes) {
      const title = note.title.toLowerCase();
      const body = note.body.toLowerCase();
      const tags = note.tags.join(" ").toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (title.includes(term)) score += 5;
        if (tags.includes(term) || note.slug.includes(term)) score += 3;
        score += Math.min(countOccurrences(body, term), 5);
      }
      if (score > 0) results.push({ note, score, snippet: snippet(note.body, terms) });
    }
    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Notes this note links to, and notes that link to it. */
  related(slug: string): { outgoing: Note[]; incoming: Note[] } | undefined {
    const note = this.get(slug);
    if (!note) return undefined;
    const outgoing = note.links.map((s) => this.bySlug.get(s)).filter((n): n is Note => !!n);
    const incoming = [...(this.backlinks.get(note.slug) ?? [])]
      .map((s) => this.bySlug.get(s))
      .filter((n): n is Note => !!n);
    return { outgoing, incoming };
  }

  latestLog(): Note | undefined {
    return this.bundle.notes
      .filter((n) => n.type === "log")
      .sort((a, b) => b.slug.localeCompare(a.slug))[0];
  }
}

export function normaliseSlug(input: string): string {
  return input
    .trim()
    .replace(/^\[\[|\]\]$/g, "")
    .replace(/\.md$/, "")
    .split("/")
    .pop()!
    .toLowerCase();
}

function countOccurrences(text: string, term: string): number {
  let count = 0;
  let i = text.indexOf(term);
  while (i !== -1) {
    count++;
    i = text.indexOf(term, i + term.length);
  }
  return count;
}

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, hit - 80);
  return (start > 0 ? "…" : "") + body.slice(start, start + 240).replace(/\s+/g, " ").trim() + "…";
}
