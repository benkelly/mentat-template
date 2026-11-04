// Checks the sign-in rule: only the allowed numeric GitHub ID gets in.
// Run: npm test

import assert from "node:assert/strict";
import { isAllowedUser } from "../src/auth";

const allowed = "1234567";

assert.equal(isAllowedUser({ id: 1234567, login: "you" }, allowed), true);
// A renamed account keeps its ID, so it still gets in.
assert.equal(isAllowedUser({ id: 1234567, login: "someone-else" }, allowed), true);
// Someone who claims the old login has a different ID.
assert.equal(isAllowedUser({ id: 999, login: "you" }, allowed), false);
// Missing or odd IDs are refused.
assert.equal(isAllowedUser({ login: "you" }, allowed), false);
assert.equal(isAllowedUser({ id: "1234567" as unknown as number }, allowed), false);
// A missing or empty setting refuses everyone.
assert.equal(isAllowedUser({ id: 1234567 }, undefined), false);
assert.equal(isAllowedUser({ id: 1234567 }, ""), false);

console.log("ok: sign-in check");
