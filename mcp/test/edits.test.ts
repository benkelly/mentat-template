// Pure note edits: ticking items, bumping dates, rendering new notes.
// Run: npm test

import assert from "node:assert/strict";
import { bumpUpdated, renderNote, tickItem } from "../src/edits";
import { stem, tokens } from "../src/notes";

const note = "---\ntitle: Test\ntype: area\nstatus: active\nupdated: 2026-11-01\ntags: [x]\n---\n\n## Next steps\n\n- [ ] Pick the attic board material.\n- [ ] Update the status of both disputes.\n- [x] Already done.\n";

assert.match(bumpUpdated(note, "2026-11-05"), /\nupdated: 2026-11-05\n/);
assert.match(bumpUpdated("---\ntitle: T\n---\nbody", "2026-11-05"), /^---\nupdated: 2026-11-05\ntitle: T\n---\n/);

let r = tickItem(note, "attic board", "2026-11-05");
assert.ok("content" in r, JSON.stringify(r));
assert.match(r.content, /- \[x\] Pick the attic board material\.\n- \[ \] Update the status/);
assert.match(r.content, /updated: 2026-11-05/);
r = tickItem(note, "Update the status of both disputes.", "2026-11-05");
assert.ok("content" in r && /\[x\] Update the status/.test(r.content));
r = tickItem(note, "the", "2026-11-05");
assert.ok("error" in r && /More than one/.test(r.error));
r = tickItem(note, "nothing like this", "2026-11-05");
assert.ok("error" in r && /No open item matches/.test(r.error) && /Pick the attic/.test(r.error));
r = tickItem(note, "Already done", "2026-11-05");
assert.ok("error" in r, "ticked items are not open");
r = tickItem("---\ntitle: T\n---\n\nNo list.\n", "x", "2026-11-05");
assert.ok("error" in r && /no open items/.test(r.error));

const rendered = renderNote({
  title: "Erin Barkasy",
  type: "person",
  status: "active",
  tags: ["people", "job-hunt"],
  updated: "2026-11-05",
  summary: "Recruiter at Astronomer.",
  keyFacts: ["Intro call Mon 2026-11-09 18:00."],
  nextSteps: ["Ask about the Senior role too."],
  related: ["job-hunt", "[[cv]]"],
});
assert.equal(
  rendered,
  "---\ntitle: Erin Barkasy\ntype: person\nstatus: active\nupdated: 2026-11-05\ntags: [people, job-hunt]\n---\n\n" +
    "## Status\n\nRecruiter at Astronomer.\n\n## Key facts\n\n- Intro call Mon 2026-11-09 18:00.\n\n" +
    "## Next steps\n\n- [ ] Ask about the Senior role too.\n\n## Related\n\n- [[job-hunt]]\n- [[cv]]\n",
);
assert.equal(renderNote({ title: "Bare", type: "people", tags: [], updated: "2026-11-05" }), "---\ntitle: Bare\ntype: people\nupdated: 2026-11-05\ntags: []\n---\n");

// Stemming: related forms meet, unrelated words stay apart, short words and numbers are left alone.
for (const [a, b] of [["interviewing", "interviewer"], ["applied", "applies"], ["applications", "application"], ["rounds", "round"], ["recruiters", "recruiter"], ["deadlines", "deadline"]]) {
  assert.equal(stem(a), stem(b), `${a} ~ ${b}`);
}
assert.notEqual(stem("stripe"), stem("strip"));
assert.equal(stem("2026-11-05"), "2026-11-05");
assert.equal(stem("cv"), "cv");
assert.equal(stem("status"), "status");
assert.deepEqual(tokens("Robin's CV, the 2 Stripe rounds"), ["robin", "cv", "stripe", "round"]);

console.log("ok: edits and stemming");
