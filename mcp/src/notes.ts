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

  /**
   * Ranked keyword search over title, tags, slug and body. BM25 over stemmed
   * words, so "interviewing" finds "interviewer" and "applied" finds "applications".
   * Title and tag hits weigh more than body hits.
   */
  search(query: string, limit = 10): { note: Note; score: number; snippet: string }[] {
    const terms = [...new Set(tokens(query))];
    if (terms.length === 0) return [];
    const idx = this.index();
    const results = [];
    for (const doc of idx.docs) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term);
        if (!tf) continue;
        const df = idx.df.get(term) ?? 1;
        const idf = Math.log(1 + (idx.docs.length - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / idx.avgLength)));
      }
      if (score > 0) results.push({ note: doc.note, score, snippet: snippet(doc.note.body, terms) });
    }
    return results.sort((a, b) => b.score - a.score || a.note.title.localeCompare(b.note.title)).slice(0, limit);
  }

  private idx?: Index;
  private index(): Index {
    if (this.idx) return this.idx;
    const docs: Doc[] = this.bundle.notes.map((note) => {
      const tf = new Map<string, number>();
      const add = (text: string, weight: number) => {
        for (const t of tokens(text)) tf.set(t, (tf.get(t) ?? 0) + weight);
      };
      add(note.title, 5);
      add(`${note.slug.replace(/-/g, " ")} ${note.tags.join(" ")}`, 2);
      add(note.body, 1);
      let length = 0;
      for (const v of tf.values()) length += v;
      return { note, tf, length };
    });
    const df = new Map<string, number>();
    for (const d of docs) for (const t of d.tf.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    const avgLength = docs.reduce((n, d) => n + d.length, 0) / Math.max(1, docs.length);
    return (this.idx = { docs, df, avgLength });
  }

  /** Every unticked `- [ ]` line across the notes, with the latest ISO date each one mentions. */
  openItems(): { note: Note; text: string; date: string }[] {
    const items = [];
    for (const note of this.bundle.notes) {
      for (const m of stripFences(note.body).matchAll(TASK_RE)) {
        items.push({ note, text: m[1], date: latestDate(m[1]) });
      }
    }
    return items;
  }

  /** Lines in non-log notes, other than open items, that mention a date after `today`. */
  datesAhead(today: string): { note: Note; text: string; date: string }[] {
    const out = [];
    for (const note of this.bundle.notes) {
      if (note.type === "log") continue;
      for (const line of stripFences(note.body).split("\n")) {
        if (TASK_RE_LINE.test(line) || /^\s*\|\s*-{3}/.test(line)) continue;
        const date = latestDate(line);
        if (date > today) out.push({ note, text: lineText(line), date });
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.note.slug.localeCompare(b.note.slug));
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

interface Doc {
  note: Note;
  tf: Map<string, number>;
  length: number;
}
interface Index {
  docs: Doc[];
  df: Map<string, number>;
  avgLength: number;
}
const K1 = 1.2;
// Low length normalisation: a long area note with many hits should beat a one-line person note.
const B = 0.3;
const TASK_RE = /^\s*[-*] \[ \] (.+?)\s*$/gm;
const TASK_RE_LINE = /^\s*[-*] \[[ x]\] /;

const stripFences = (body: string) => body.replace(/```[\s\S]*?```/g, "");

const latestDate = (text: string) => (text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []).sort().at(-1) ?? "";

/** A table row or list item as one short line of text. */
function lineText(line: string): string {
  let text = line.trim().replace(/^[-*]\s*/, "");
  if (text.startsWith("|")) {
    text = text
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim())
      .filter(Boolean)
      .join(" | ");
  }
  text = text.replace(/\s+/g, " ");
  return text.length <= 160 ? text : `${text.slice(0, 157).trimEnd()}...`;
}

const STOP = new Set("a an and are as at be but by for from has have he her his i if in is it its me my of on or our she so that the their them they this to was we were with you your".split(" "));

/** Lower-case words of 2+ letters or digits, minus stopwords, lightly stemmed. */
export function tokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/g) ?? [])
    .map((w) => w.replace(/'s$|'/g, ""))
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map(stem);
}

/** A small suffix stripper. Good enough for notes in English; not Porter. */
export function stem(word: string): string {
  if (word.length <= 3 || /\d/.test(word)) return word;
  const rules: [RegExp, string][] = [
    [/ie[sd]$/, "y"],
    [/(ss|us|is)$/, "$1"],
    [/(s|x|z|ch|sh)es$/, "$1"],
    [/ations?$/, "ate"],
    [/(ing|ed|ers?|ly|ness|ments?)$/, ""],
    [/s$/, ""],
  ];
  for (const [re, to] of rules) {
    if (re.test(word)) {
      const out = word.replace(re, to);
      if (out.length >= 3) return out.replace(/(.)\1$/, "$1");
      return word;
    }
  }
  return word;
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

function snippet(body: string, terms: string[]): string {
  const lower = body.toLowerCase();
  const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  // Terms are stems, so "interview" also lands on "interviewer".
  const start = Math.max(0, hit - 80);
  return (start > 0 ? "…" : "") + body.slice(start, start + 240).replace(/\s+/g, " ").trim() + "…";
}
