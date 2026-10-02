"use strict";
// lib/accounts.js (crafted accounts: the dashboard's Accounts page, New sim's Save as account): checked against the
// game (classes, slots, items), written as chronal-account/1, listed (a bad file with its problems), removed.
//   node --test test/accounts.test.js      (needs the game: chronal install)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const A = require("../lib/accounts");
const G = require("../lib/compose").game();

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "accounts-test-"));
const ok = { name: "alts", age_days: 3, code: "example", characters: [{ name: "AltRan", class: "ranger", level: 60, gear: { mainhand: "firebow+7:dex", offhand: "none" } }, { name: "AltPri", class: "priest", level: 58 }] };

test("an account checked: names, classes, levels, gear slots and items, one merchant", () => {
	assert.deepStrictEqual(A.check(ok, G), []);
	const bad = { name: "a b", age_days: -1, characters: [{ name: "Way2LongName13", class: "bard", level: 0, gear: { hat: "x", mainhand: "nosuchitem", chest: "Bad Spec" } }, { name: "M1", class: "merchant", level: 9 }, { name: "m1", class: "merchant", level: 9 }] };
	const p = A.check(bad, G);
	for (const re of [/^name:/, /^age_days/, /name: 1-12/, /class: one of/, /level: 1-200/, /no slot hat/, /no item nosuchitem/, /chest: an item spec/, /twice in the account/]) assert.ok(p.some((x) => re.test(x)), re + " in " + p.join("; "));
	assert.ok(A.check({ name: "x", characters: [] }, G).some((x) => /at least one/.test(x)));
});

test("saved, listed, removed; a bad file listed with its problems", () => {
	const w = A.save(dir, ok, G);
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "alts.json"), "utf8")), { format: A.FORMAT, ...w });
	assert.deepStrictEqual(w.characters[1], { name: "AltPri", class: "priest", level: 58 });
	assert.throws(() => A.save(dir, { ...ok, name: "" }, G), (e) => e.problems.length > 0);
	fs.writeFileSync(path.join(dir, "junk.json"), "{");
	const l = A.list(dir);
	assert.deepStrictEqual(l.map((a) => a.name), ["alts", "junk"]);
	assert.strictEqual(l[0].code, "example");
	assert.ok(l[1].problems.length);
	assert.strictEqual(A.remove(dir, "alts"), true);
	assert.strictEqual(A.remove(dir, "alts"), false);
	assert.strictEqual(A.remove(dir, "../x"), false);
});
