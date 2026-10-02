"use strict";
// lib/gear_sets.js (gear sets: the built-in Discord list, yours in gear_sets_dir) and compose.js's --gear-set and
// --sweep-gear-set: the built-in sets as the game lets them be worn, yours checked, written, listed and removed; a set
// worn under the gear edits, sets compared.
//   node --test test/gear_sets.test.js      (needs the game: chronal install)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const GS = require("../lib/gear_sets");
const K = require("../lib/compose");
const G = K.game();

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "gear-sets-test-"));

test("the built-in sets: early, mid and late per class, each item worn as the game allows, stat scrolls the class's main stat", () => {
	const b = GS.list(tmp()).filter((s) => s.builtin);
	assert.deepStrictEqual(b.map((s) => s.name).filter((n) => n.startsWith("mage-")), ["mage-early", "mage-mid", "mage-late"]);
	assert.strictEqual(b.length, 18);
	for (const s of b) {
		assert.deepStrictEqual(Object.keys(s.gear), GS.SLOTS, s.name);
		const slots = Object.fromEntries(GS.SLOTS.map((k) => [k, K.parseGear(s.gear[k], G)]));
		for (const k of GS.SLOTS) {
			const r = K.checkGear(G, s.class, k, slots[k], slots);
			assert.deepStrictEqual([...r.problems, ...r.warnings], [], s.name);
			const it = slots[k];
			if (it) assert.strictEqual(it.stat_type, G.items[it.name].stat ? G.classes[s.class].main_stat : undefined, s.name + " " + k);
		}
	}
});

test("yours: checked, saved, listed after the built-in ones, removed; a built-in name refused; a bad file listed", () => {
	const dir = tmp(),
		mine = { name: "ran-mine", class: "ranger", gear: { mainhand: "firebow+9:dex", offhand: "none", helmet: "fury+4:str" } };
	assert.deepStrictEqual(GS.check(mine, G), []);
	const p = GS.check({ name: "mage-mid", class: "bard", gear: { hat: "x", mainhand: "nosuchitem", chest: "Bad Spec", elixir: "elixirdex0" } }, G);
	for (const re of [/built-in/, /class: one of/, /no slot hat/, /no item nosuchitem/, /chest: an item spec/, /no slot elixir/]) assert.ok(p.some((x) => re.test(x)), re + " in " + p.join("; "));
	const w = GS.save(dir, mine, G);
	assert.deepStrictEqual(w, { format: GS.FORMAT, name: "ran-mine", class: "ranger", gear: { helmet: "fury+4:str", mainhand: "firebow+9:dex" } });
	assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, "ran-mine.json"), "utf8")), w);
	assert.throws(() => GS.save(dir, { ...mine, name: "ranger-late" }, G), (e) => /built-in/.test(e.message));
	fs.writeFileSync(path.join(dir, "junk.json"), "{");
	const l = GS.list(dir).filter((s) => !s.builtin);
	assert.deepStrictEqual(l.map((s) => s.name), ["junk", "ran-mine"]);
	assert.ok(l[0].problems.length);
	assert.deepStrictEqual(GS.get(dir, "ran-mine").gear, w.gear);
	assert.strictEqual(GS.get(dir, "junk"), null);
	assert.strictEqual(GS.remove(dir, "ran-mine"), true);
	assert.strictEqual(GS.remove(dir, "ran-mine"), false);
	assert.strictEqual(GS.remove(dir, "../x"), false);
});

test("compose: a set worn (each slot; the gear edits on top), sets compared (the set in place of the sheet's edits)", () => {
	const dir = tmp(),
		env = { G, pullsDir: tmp(), codeSets: null, gearSetsDir: dir, now: new Date("2026-10-02T11:00:00.000Z") };
	GS.save(dir, { name: "mine", class: "mage", gear: { mainhand: "staff+3" } }, G);
	const one = K.compose({ char: ["Wiz:mage:60"], gear_set: { Wiz: "mage-late" }, gear: ["Wiz:ring1=cring+3"] }, env).variants;
	const sl = one[0].setup.characters[0].state.slots;
	assert.deepStrictEqual([one.length, sl.mainhand, sl.offhand, sl.helmet, sl.ring1], [1, { name: "sparkstaff", level: 9 }, null, { name: "mmhat", level: 9, stat_type: "int" }, { name: "cring", level: 3 }]);
	assert.match(one[0].setup.notes, /gear sets: Wiz mage-late \| gear: Wiz ring1=cring\+3\./);
	const v = K.compose({ char: ["Wiz:mage:60"], gear: ["Wiz:ring1=cring+3"], sweep_gear_set: ["Wiz=mage-early,mine"], sweep_gear: ["Wiz:orb=jacko+3,orbg+1"] }, env).variants;
	assert.deepStrictEqual(v.map((x) => [x.label, x.key]), [
		["Wiz set=mage-early, Wiz orb=jacko+3", "Wiz-set-mage-early--Wiz-orb-jacko+3"],
		["Wiz set=mage-early, Wiz orb=orbg+1", "Wiz-set-mage-early--Wiz-orb-orbg+1"],
		["Wiz set=mine, Wiz orb=jacko+3", "Wiz-set-mine--Wiz-orb-jacko+3"],
		["Wiz set=mine, Wiz orb=orbg+1", "Wiz-set-mine--Wiz-orb-orbg+1"],
	]);
	const m = v[2].setup.characters[0].state.slots;
	assert.deepStrictEqual([m.mainhand, m.ring1, m.helmet, m.orb], [{ name: "staff", level: 3 }, null, null, { name: "jacko", level: 3 }]);
	assert.match(v[2].setup.notes, /gear sets: Wiz mine \| gear: Wiz orb=jacko\+3\./);
	assert.throws(() => K.compose({ char: ["Ran:ranger:60"], gear_set: { Ran: "mage-late" } }, env), /gear set mage-late: a mage's \(Ran is a ranger\)/);
	assert.throws(() => K.compose({ char: ["Ran:ranger:60"], gear_set: { Ran: "nope" } }, env), /--gear-set Ran=nope: no gear set nope/);
	assert.throws(() => K.compose({ char: ["Ran:ranger:60"], gear_set: { Zed: "ranger-mid" } }, env), /--gear-set Zed: not in the roster/);
	assert.throws(() => K.compose({ char: ["Ran:ranger:60"], sweep_gear_set: ["Ran:ranger-mid"] }, env), /--sweep-gear-set Ran:ranger-mid: NAME=A,B/);
});
