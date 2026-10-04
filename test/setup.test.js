"use strict";
// setup.js: validation (every problem listed), parseDuration, composeEntry's bytes, the states (characterOver: the
// state merged into a new character), accounts (accountUser, ageOf), setupKey, the code store
// (write-once, a side file resolves from it), build hooks, storage and steering; start.js on a real sim (the account
// age, the world age, the steering).
//   node --test test/setup.test.js      (the real-sim tests need the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const S = require("../lib/setup");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "setup-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
// a small game: the classes' starter weapons, main's spawn
const G = {
	classes: { ranger: { base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } }, priest: { base_slots: { mainhand: { name: "staff", level: 0, gift: 1 } } }, merchant: { base_slots: { mainhand: { name: "staff", level: 0, gift: 1 } } }, warrior: { base_slots: { mainhand: { name: "blade", level: 0, gift: 1 } } } },
	maps: { main: { spawns: [[5, 6, 0, 100]] }, spookytown: {} },
};
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const EXP = {
	format: "chronal-export/1", exported_at: "2026-09-23T10:05:06.485Z",
	character: { name: "Ran", class: "ranger", level: 64, xp: 123, gold: 5000, items: [{ name: "hpot1", q: 9 }, null], slots: { mainhand: { name: "firebow", level: 7 }, chest: { name: "coat", level: 8, stat_type: "dex" }, helmet: null }, s: { mluck: {} } },
	bank: { gold: 777, items0: [{ name: "x" }], items1: [], items2: [null] },
};
// a CODE layout: slots in lib/ (one in a subdirectory), an entry file, an adapter, an export
function layout() {
	const d = tmp();
	write(d, "lib/helper.js", "function h() {}\n");
	write(d, "lib/Ran.js", "// Ran's own entry\n");
	write(d, "lib/sub/deep.js", "var deep = 1;\n");
	write(d, "farm.js", "// farm\n");
	write(d, "adapter.js", "self.chronal = self.chronal || {};\n");
	write(d, "Ran.json", JSON.stringify(EXP));
	return d;
}
const setupFile = (d, o) => write(d, "setup.json", JSON.stringify({ format: "chronal-setup/1", ...o }));
// sim.js createCharacter: a new character, `over` merged into it
function character(cls, over) {
	const c = { level: 1, xp: 0, info: { gold: 0, items: [{ name: "hpot0", q: 200, gift: 1 }, { name: "mpot0", q: 200, gift: 1 }], slots: { ...structuredClone(G.classes[cls].base_slots), helmet: { name: "helmet", level: 0, gift: 1 }, shoes: { name: "shoes", level: 0, gift: 1 } }, map: "main", in: "main", x: 5, y: 6 } };
	const merge = (a, b) => {
		for (const [k, v] of Object.entries(b)) {
			if (v && typeof v === "object" && !Array.isArray(v) && a[k] && typeof a[k] === "object") merge(a[k], v);
			else a[k] = v;
		}
		return a;
	};
	const { slots, ...info } = structuredClone(over.info || {});
	merge(c, { ...structuredClone(over), info });
	if (slots) Object.assign(c.info.slots, slots); // an item replaces the starter's whole
	return JSON.stringify(c);
}

test("parseDuration: 90s, 30m, 2h, 1d, minutes; anything else null", () => {
	assert.deepEqual(["90s", "30m", "2h", "1d", "1.5h", 20, "20", "0m", 0].map(S.parseDuration), [90e3, 30 * 60e3, 2 * 3600e3, 86400e3, 5400e3, 20 * 60e3, 20 * 60e3, 0, 0]);
	for (const bad of ["", "3x", "-1m", "m", null, undefined, -2, "1h30m"]) assert.equal(S.parseDuration(bad), null, String(bad));
});

test("loadSetup: defaults filled, paths absolute; every problem listed at once", () => {
	const d = layout();
	const s = S.loadSetup(setupFile(d, { defaults: { code: { dir: "lib" } }, characters: [{ name: "Ran", class: "ranger" }] }), { G });
	assert.equal(s.name, "setup");
	assert.deepEqual(s.run, { duration: "30m", warmup: "0m", seed: 1, until: null, check: "1s", grid_ms: 30000 });
	assert.deepEqual(s.world, { roi: null, threads: true, age: "0m", ping: 18, start: "2026-01-01T00:00:00Z", seasons: [], events: [], spawns: [] });
	// the world's clock, seasons and forced events checked
	const w = (world, run) => { try { S.loadSetup(setupFile(d, { defaults: { code: { dir: "lib" } }, characters: [{ name: "Ran", class: "ranger" }], world, ...(run ? { run } : {}) }), { G }); return []; } catch (x) { return x.problems; } };
	assert.deepEqual(w({ start: "2026-10-31T23:30Z", seasons: ["halloween"], events: [{ event: "goobrawl", at: "10m" }] }), []);
	for (const [world, re] of [[{ start: "2026-01-01" }, /^world\.start/], [{ start: "tomorrow" }, /^world\.start/], [{ seasons: ["summer"] }, /^world\.seasons/], [{ events: [{ event: "dragon", at: "1m" }] }, /^world\.events\[0\]\.event/], [{ events: [{ event: "franky", at: "40m" }] }, /past the run's end/], [{ events: [{ event: "franky" }] }, /^world\.events\[0\]\.at/]])
		assert.ok(w(world).some((x) => re.test(x)), JSON.stringify(world) + ": " + w(world).join("; "));
	assert.deepEqual(s.accounts, { main: { age_days: 0, bank: null } });
	assert.deepEqual(s.characters[0], { name: "Ran", class: "ranger", account: "main", role: null, fps: 10, at: null, state: null, code: { dir: path.join(d, "lib"), recursive: false, entry: null, file: null, prelude: null, append: [], build: null }, params: null, extra: [], note: null });
	assert.equal(s.party, null);
	assert.equal(s.file, path.join(d, "setup.json"));
	let e;
	try {
		S.loadSetup(setupFile(d, {
			nmae: "typo", run: { duration: "3x", seed: 0, sped: 20, until: "c.Nobody.level > 3" }, world: { roi: "huge", age: "2x", ping: 0 },
			defaults: { code: { dir: "lib", entry: "Ran" } },
			accounts: { main: { age_days: -1, bank: { gold: "lots" } } },
			characters: [
				{ name: "Ran", class: "ranger", code: { file: "farm.js" } },
				{ name: "ran", class: "ranger" },
				{ name: "Bad Name", class: "wizard", at: "main:x:y", role: "boss", state: { from: "Ran.json" } },
				{ name: "War1", class: "warrior", state: { from: "nope.json", level: 0 }, code: { append: ["missing.js"] } },
				{ name: "War2", class: "warrior" },
			],
			party: { members: ["Ran", "Ghost"], leader: "Ghost", form: "maybe" },
		}), { G });
	} catch (x) {
		e = x;
	}
	assert.ok(e && Array.isArray(e.problems), "throws with .problems");
	const want = [
		/^nmae: unknown key/, /^run\.duration: "3x"/, /^run\.seed: 0/, /^run\.sped: unknown key/, /^world\.roi: "huge"/, /^world\.age: "2x" is not a duration/, /^world\.ping: 0 is not a round trip/,
		/^accounts\.main\.age_days/, /^accounts\.main\.bank\.gold/,
		/Ran\)\.code: entry and file both set/, /\(ran\)\.name: ran twice/, /\.name: "Bad Name"/, /\.class: "wizard"/, /\.role: "boss"/, /\.at: "main:x:y"/,
		/War1\)\.state\.from: no such file/, /War1\)\.state\.level/, /War1\)\.code\.append: no such file/,
		/^accounts\.main: 5 characters and 0 merchants/, /^party\.members: no character "Ghost"/, /^party\.leader|^party\.form/, /^party\.form: "maybe"/, /^run\.until: c\.Nobody/,
	];
	for (const re of want) assert.ok(e.problems.some((p) => re.test(p)), `${re} in:\n${e.problems.join("\n")}`);
	// an export of another class
	assert.throws(() => S.loadSetup(setupFile(d, { characters: [{ name: "Pri", class: "priest", state: { from: "Ran.json" }, code: { file: "farm.js" } }] }), { G }), (x) => x.problems.some((p) => /is a ranger, not a priest/.test(p)));
	// overrides: run knobs, the world's age, every account's age
	const o = S.loadSetup(setupFile(d, { world: { age: "1h" }, accounts: { a: { age_days: 3 } }, characters: [{ name: "Ran", class: "ranger", account: "a", code: { file: "farm.js" } }, { name: "Pri", class: "priest", account: "b", code: { file: "farm.js" } }] }), { G, overrides: { run: { duration: "2h", seed: 7 }, world: { age: 90, ping: 5 }, age_days: 30 } });
	assert.deepEqual([o.run.duration, o.run.seed, o.world.age, o.world.ping, o.accounts.a.age_days, o.accounts.b.age_days], ["2h", 7, 90, 5, 30, 30]);
	assert.throws(() => S.loadSetup(setupFile(d, { characters: [{ name: "Ran", class: "ranger", code: { file: "farm.js" } }] }), { G, overrides: { world: { age: "-1m" } } }), (x) => x.problems.some((p) => /^world\.age: "-1m"/.test(p)));
});

test("composeEntry: params, prelude, entry, appended files, extras, the harness invites, in that order", () => {
	assert.equal(S.composeEntry({ entryText: "E" }), "E");
	assert.equal(
		S.composeEntry({ params: { farm: { map: "main", x: 1, y: 2, monsters: ["goo"] } }, prelude: "var FARM = null;", entryText: "E\n", append: ["A1", "A2"], extra: ["x1;", "x2;"], invite: "\n;INV\n" }),
		'self.chronal = self.chronal || {}; chronal.params = {"farm":{"map":"main","x":1,"y":2,"monsters":["goo"]}};\nvar FARM = null;\nE\n\n;A1\n\n;A2\n\n;x1;\n\n;x2;\n\n;INV\n',
	);
	// resolved: a dir slot keeps its sourceURL line, a file its raw text; the harness invites
	const d = layout();
	const s = S.loadSetup(setupFile(d, {
		defaults: { code: { dir: "lib", recursive: true, append: ["adapter.js"] } },
		characters: [
			{ name: "Ran", class: "ranger", extra: "M.x = 1;", params: { farm: { monsters: ["goo"] } } },
			{ name: "Pri", class: "priest", code: { file: "farm.js", prelude: "var P = 1;" } },
			{ name: "Mer", class: "merchant", code: { file: "farm.js" } },
		],
		party: { members: ["Pri", "Ran", "Mer"] },
	}), { G });
	const { resolved, bundles, warnings } = S.resolveSetup(s, { G });
	const slot = (n) => fs.readFileSync(path.join(d, "lib", n + ".js"), "utf8") + `\n//# sourceURL=code/${n.split("/").pop()}.js\n`;
	assert.deepEqual(Object.keys(bundles.Ran.files).sort(), ["Ran", "deep", "helper"]);
	assert.equal(bundles.Ran.files.deep, slot("sub/deep"));
	assert.equal(bundles.Ran.text, 'self.chronal = self.chronal || {}; chronal.params = {"farm":{"monsters":["goo"]}};\n' + slot("Ran") + "\n;self.chronal = self.chronal || {};\n\n" + "\n;M.x = 1;\n" + '\n;on_party_invite = function (name) { if (name === "Pri") accept_party_invite(name); };\n');
	assert.equal(bundles.Pri.text, "var P = 1;\n// farm\n\n;self.chronal = self.chronal || {};\n\n" + '\n;setInterval(function () { var l = parent.party_list || []; ["Ran","Mer"].forEach(function (n) { if (l.indexOf(n) < 0) send_party_invite(n); }); }, 5000);\n');
	assert.deepEqual([bundles.Ran.entry, bundles.Pri.entry], ["Ran", "farm.js"]);
	assert.deepEqual(resolved.party, { members: ["Pri", "Ran", "Mer"], leader: "Pri", form: "harness" });
	assert.deepEqual(resolved.characters.map((c) => c.code.entry), ["Ran", "farm.js", "farm.js"]);
	assert.match(resolved.characters[0].code.hash, /^[0-9a-f]{8}$/);
	assert.deepEqual(warnings, []);
	// form "code" and "none": no invites; no party: none
	for (const form of ["code", "none"]) {
		const r = S.resolveSetup(S.loadSetup(setupFile(d, { characters: [{ name: "A", class: "ranger", code: { file: "farm.js" } }, { name: "B", class: "priest", code: { file: "farm.js" } }], party: { members: ["A", "B"], form } }), { G }), { G });
		assert.deepEqual([r.bundles.A.text, r.bundles.B.text], ["// farm\n", "// farm\n"]);
	}
});

test("states: characterOver gives the state's character (export, export + slots, fresh, fresh + slots)", () => {
	const d = layout();
	const s = S.loadSetup(setupFile(d, {
		defaults: { code: { file: "farm.js" } },
		characters: [
			{ name: "E1", class: "ranger", state: { from: "Ran.json" }, at: "spookytown:677:129" },
			{ name: "E2", class: "ranger", state: { from: "Ran.json", level: 60, xp: 0, slots: { mainhand: { name: "bow", level: 9 }, ring1: { name: "ringsj", level: 2 } } }, at: { map: "main", x: -1, y: 2 } },
			{ name: "F1", class: "priest", account: "b", online: false }, // 3 besides merchants in game from one IP (the game's limit)
			{ name: "F2", class: "priest", account: "b", state: { level: 60, slots: { mainhand: { name: "wand", level: 7 } } }, at: "main:1:1" },
		],
	}), { G });
	const { resolved } = S.resolveSetup(s, { G });
	const [e1, e2, f1, f2] = resolved.characters;
	const x = EXP.character;
	// over(c, at, extra): an export's numbers at a place, merged into a new character (its gear: the export's, or the
	// given slots, every starter slot they don't list emptied)
	const empty = Object.fromEntries(Object.keys(S.starter(G, "ranger")).map((k) => [k, null]));
	const over = (c, at, extra = {}) => ({ level: c.level, xp: c.xp, ...extra, info: { gold: c.gold, items: c.items, ...at, ...(extra.info || {}), slots: { ...empty, ...((extra.info && extra.info.slots) || c.slots) } } });
	const at = (m, X, Y) => ({ map: m, in: m, x: X, y: Y });
	assert.equal(character("ranger", S.characterOver(e1)), character("ranger", over(x, at("spookytown", 677, 129))));
	assert.equal(character("ranger", S.characterOver(e2)), character("ranger", over(x, at("main", -1, 2), { level: 60, xp: 0, info: { slots: { mainhand: { name: "bow", level: 9 }, ring1: { name: "ringsj", level: 2 } } } })));
	assert.equal(character("priest", S.characterOver(f1)), character("priest", { info: at("main", 5, 6) }));
	assert.equal(character("priest", S.characterOver(f2)), character("priest", { level: 60, info: { ...at("main", 1, 1), slots: { mainhand: null, helmet: null, shoes: null, mainhand: { name: "wand", level: 7 } } } }));
	// the resolved state is the character's (over the starter gear slot by slot, as the sim makes it: a given item takes
	// none of the starter's fields, not its gift; a starter item not replaced stays a gift)
	assert.deepEqual(f2.state, { level: 60, xp: 0, gold: 0, items: [{ name: "hpot0", q: 200, gift: 1 }, { name: "mpot0", q: 200, gift: 1 }], slots: { mainhand: { name: "wand", level: 7 }, helmet: null, shoes: null } });
	assert.deepEqual(e1.state.slots, { mainhand: { name: "firebow", level: 7 }, helmet: null, shoes: null, chest: { name: "coat", level: 8, stat_type: "dex" } }); // (the export has no shoes: no starter's)
	assert.deepEqual(f1.at, { map: "main", x: 5, y: 6 }); // main's spawn
	assert.deepEqual(resolved.source.characters.E1, { code_dir: null, recursive: false, code_git: resolved.source.characters.E1.code_git, entry: null, file: path.join(d, "farm.js"), append: [], extra: [], prelude: null, build: null, state_from: path.join(d, "Ran.json"), exported_at: EXP.exported_at });
});

test("at most 3 besides merchants in game from one IP, whatever their accounts", () => {
	const d = layout(),
		chars = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ name: "C" + i, class: "ranger", account: i < 2 ? "a" : "b", ...extra })),
		problems = (characters) => {
			try {
				S.loadSetup(setupFile(d, { defaults: { code: { file: "farm.js" } }, characters }), { G });
				return [];
			} catch (e) {
				return e.problems;
			}
		};
	assert.deepEqual(problems([...chars(3), { name: "M1", class: "merchant", account: "a" }, { name: "M2", class: "merchant", account: "b" }]), []);
	assert.deepEqual(problems(chars(4)), ["4 characters besides merchants in game at the start (C0, C1, C2, C3): the game lets 3 play from one IP, whatever their accounts, and a run's characters all play from one (put the others online: false)"]);
	assert.deepEqual(problems([...chars(3), { name: "C3", class: "ranger", account: "b", online: false }]), []);
});

test("accounts: accountUser (flags, the bank from an export or inline, none), ageOf", () => {
	const d = layout();
	const s = S.loadSetup(setupFile(d, {
		defaults: { code: { file: "farm.js" } },
		accounts: { a: { bank: { from: "Ran.json" } }, b: { bank: { gold: 5, items0: [] }, age_days: 1.5 } },
		characters: [{ name: "A", class: "ranger", account: "a" }, { name: "B", class: "ranger", account: "b" }, { name: "C", class: "ranger", account: "c" }],
	}), { G });
	const { resolved } = S.resolveSetup(s, { G });
	// { ...flags, gold: bank.gold, ...items<N> }; a new account's: flags only
	assert.equal(JSON.stringify(S.accountUser(resolved.accounts.a)), JSON.stringify({ info: { verified: true, legacy_override: true, gold: 777, items0: [{ name: "x" }], items1: [], items2: [null] } }));
	assert.deepEqual(S.accountUser(resolved.accounts.b), { info: { verified: true, legacy_override: true, gold: 5, items0: [] } });
	assert.deepEqual(S.accountUser(resolved.accounts.c), { info: { verified: true, legacy_override: true } });
	assert.deepEqual(resolved.accounts.c, { age_days: 0, bank: null });
	assert.deepEqual(resolved.source.accounts, { a: { bank_from: path.join(d, "Ran.json") } });
	assert.equal(S.ageOf(resolved.accounts.a, 1e12), null);
	assert.deepEqual(S.ageOf(resolved.accounts.b, 1e12), { created: 1e12 - 1.5 * 86400e3, oldest: 1e12 - 1.5 * 86400e3 });
});

test("setupKey: the run knobs, name, strategy, notes and provenance don't count; states, CODE, world, party and the sim version do", () => {
	const d = layout();
	const r = (o = {}, ov) => S.resolveSetup(S.loadSetup(setupFile(d, { name: "x", characters: [{ name: "A", class: "ranger", code: { file: "farm.js" }, note: "n1" }], ...o }), { G, overrides: ov }), { G }).resolved;
	const k = S.setupKey(r(), "v1");
	assert.match(k, /^[0-9a-f]{8}$/);
	assert.equal(S.setupKey(r({ name: "y", strategy: "s", notes: "m", run: { duration: "2h", warmup: "1m", seed: 9, until: "t > 5", grid_ms: 60000 } }), "v1"), k);
	assert.equal(S.setupKey({ ...r(), resolved: { at: "later", by: "me", from: null } }, "v1"), k);
	assert.notEqual(S.setupKey(r(), "v2"), k);
	assert.notEqual(S.setupKey(r({ world: { threads: false } }), "v1"), k);
	assert.notEqual(S.setupKey(r({ world: { age: "2h" } }), "v1"), k);
	assert.notEqual(S.setupKey(r({}, { world: { age: "2h" } }), "v1"), k);
	assert.notEqual(S.setupKey(r({ characters: [{ name: "A", class: "ranger", code: { file: "farm.js" }, state: { level: 2 } }] }), "v1"), k);
	assert.notEqual(S.setupKey(r({ characters: [{ name: "A", class: "ranger", code: { file: "farm.js" }, extra: "1;" }] }), "v1"), k);
	assert.notEqual(S.setupKey(r({}, { age_days: 3 }), "v1"), k);
	// strategyText: roster, party, farm, notes, extras; the given one wins
	assert.equal(S.strategyText(r({ notes: "try 2" })), "ranger L1 | try 2 | A: n1");
	assert.equal(S.strategyText(r({ strategy: "mine" })), "mine");
	const two = r({ characters: [{ name: "A", class: "ranger", code: { file: "farm.js" }, params: { farm: { map: "main", x: 1, y: 2, monsters: ["goo", "bee"] } }, extra: ["M.a = 1;\n  M.b = 2;"] }, { name: "M", class: "merchant", code: { file: "farm.js" } }], party: { members: ["A", "M"], form: "code" } });
	assert.equal(S.strategyText(two), "ranger L1 + merchant (party by CODE) | goo/bee @ main 1,2 | A: M.a = 1; M.b = 2;");
	assert.equal(S.strategyText(two, { formed: false }), "ranger L1 + merchant (no party) | goo/bee @ main 1,2 | A: M.a = 1; M.b = 2;");
});

test("code store: storeBundles writes each blob once; a side file resolves from it (dir/code, then ../code), --current-code from its source", () => {
	const d = layout(),
		live = path.join(d, "live");
	const s = S.loadSetup(setupFile(d, { defaults: { code: { dir: "lib" } }, run: { seed: 3 }, characters: [{ name: "Ran", class: "ranger", state: { from: "Ran.json" } }] }), { G });
	const { resolved, bundles } = S.resolveSetup(s, { G, by: "test" });
	assert.deepEqual(resolved.resolved.by, "test");
	const store = path.join(live, "code");
	const ids = S.storeBundles(bundles, store);
	assert.deepEqual(ids, { Ran: { slots: resolved.characters[0].code.slots, text: resolved.characters[0].code.text } });
	const f = path.join(store, ids.Ran.text + ".js");
	assert.equal(fs.readFileSync(f, "utf8"), bundles.Ran.text);
	fs.writeFileSync(f, "kept");
	S.storeBundles(bundles, store);
	assert.equal(fs.readFileSync(f, "utf8"), "kept", "an existing blob is never rewritten");
	fs.writeFileSync(f, bundles.Ran.text);
	// the side file (as live.js writes it) in live/, then moved to live/removed/
	const side = write(live, "run--1.setup.json", JSON.stringify(resolved));
	for (const file of [side, write(live, "removed/run--1.setup.json", JSON.stringify(resolved))]) {
		const x = S.loadSetup(file, { overrides: { run: { duration: "5m" }, age_days: 30 } });
		assert.ok(x.side);
		const r = S.resolveSetup(x, { by: "rerun" });
		assert.deepEqual(r.bundles.Ran, { entry: "Ran", files: bundles.Ran.files, text: bundles.Ran.text });
		assert.deepEqual([r.resolved.run.duration, r.resolved.run.seed, r.resolved.accounts.main.age_days, r.resolved.resolved.from, r.resolved.resolved.by], ["5m", 3, 30, file, "rerun"]);
		assert.deepEqual(r.resolved.characters, resolved.characters);
		assert.deepEqual(r.stored, { Ran: resolved.characters[0].code.hash });
	}
	// the source changed: the stored CODE still runs; currentCode takes the new one
	fs.appendFileSync(path.join(d, "lib", "Ran.js"), "// edited\n");
	const cur = S.resolveSetup(S.loadSetup(side), { currentCode: true });
	assert.notEqual(cur.resolved.characters[0].code.hash, resolved.characters[0].code.hash);
	assert.match(cur.bundles.Ran.text, /edited/);
	assert.equal(S.resolveSetup(S.loadSetup(side)).bundles.Ran.text, bundles.Ran.text);
	// a tampered or missing blob
	fs.writeFileSync(f, "tampered");
	assert.throws(() => S.resolveSetup(S.loadSetup(side)), /does not match its hash/);
	fs.rmSync(f);
	assert.throws(() => S.resolveSetup(S.loadSetup(side)), /in none of/);
	// saved elsewhere (a downloaded side file): its CODE from the store given (a live dir's code/), after its own
	S.storeBundles(bundles, store);
	const away = write(path.join(d, "downloads"), "run--1.setup.json", JSON.stringify(resolved));
	assert.throws(() => S.resolveSetup(S.loadSetup(away)), /in none of/);
	assert.equal(S.resolveSetup(S.loadSetup(away), { store: [path.join(d, "nowhere"), store] }).bundles.Ran.text, bundles.Ran.text);
	fs.rmSync(f);
	// sideHash leaves out resolved; codeHash over the sorted names
	assert.equal(S.sideHash({ ...resolved, resolved: { at: "other" } }), S.sideHash(resolved));
	assert.equal(S.codeHash(resolved), S.codeHash({ characters: [...resolved.characters].reverse() }));
});

test("build hooks: once per {cmd, cwd} under <dirname of dir>/.build-lock, skipped with build: false", () => {
	const d = layout(),
		count = path.join(d, "count");
	write(d, "build.js", `const fs = require("fs"), path = require("path"); fs.appendFileSync(${JSON.stringify(count)}, "x"); if (!fs.existsSync(path.join(__dirname, "dist", ".build-lock"))) process.exit(3); fs.mkdirSync(path.join(__dirname, "dist/p"), { recursive: true }); fs.writeFileSync(path.join(__dirname, "dist/p/A.js"), "// built\\n");`);
	const file = setupFile(d, { defaults: { code: { dir: "dist/p", build: { cmd: ["node", "build.js"], cwd: "." } } }, characters: [{ name: "A", class: "ranger" }, { name: "B", class: "priest", code: { entry: "A" } }] });
	const r = S.resolveSetup(S.loadSetup(file, { G }), { G });
	assert.equal(fs.readFileSync(count, "utf8"), "x", "one build for both, run under the lock");
	assert.match(r.bundles.B.text, /built/);
	assert.ok(!fs.existsSync(path.join(d, "dist", ".build-lock")), "the lock is gone");
	S.resolveSetup(S.loadSetup(file, { G }), { G, build: false });
	assert.equal(fs.readFileSync(count, "utf8"), "x");
	write(d, "fail.js", "console.error('no such profile'); process.exit(4);");
	assert.throws(() => S.resolveSetup(S.loadSetup(setupFile(d, { characters: [{ name: "A", class: "ranger", code: { dir: "dist/p", build: { cmd: ["node", "fail.js"] } } }] }), { G }), { G }), /failed \(4\): no such profile/);
});

test("start.js on a real sim: characters in game with their CODE, the account's bank; age_days > 0: no New Player", { timeout: 120000 }, async (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const { startSetup } = require("../sim/start");
	const d = layout();
	for (const [age, np] of [[0, true], [45, false]]) {
		const s = S.loadSetup(setupFile(d, {
			world: { threads: false }, accounts: { main: { age_days: age, bank: { gold: 4321 } } },
			characters: [{ name: "Ran", class: "ranger", state: { level: 30 }, at: "main:0:0", code: { file: "farm.js" }, params: { farm: { monsters: ["goo"] } } }],
		}));
		const { resolved, bundles } = S.resolveSetup(s);
		const { sim, clients } = await startSetup(resolved, bundles, { live: false });
		try {
			await sim.run(3000);
			const q = await clients.Ran.query("({ level: character.level, np: !!(character.s && character.s.encouragement_new), params: window.__runner && window.__runner.chronal && window.__runner.chronal.params })");
			assert.deepEqual(q, { level: 30, np, params: { farm: { monsters: ["goo"] } } }, `age ${age}`);
			const user = sim.env.db.collection(sim.env.kindOf(sim.accounts.get("main").user_id)).store.get(sim.accounts.get("main").user_id);
			assert.deepEqual([user.info.gold, user.info.verified, user.info.legacy_override], [4321, true, true]);
		} finally {
			await sim.close();
		}
	}
});

test("start.js world.age: the world runs with no characters first (its monsters level up), then they log in; the snapshot's world.age_ms, mlevels, virtual_ms from the login", { timeout: 120000 }, async (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const { startSetup } = require("../sim/start");
	const d = layout(),
		live = tmp();
	const s = S.loadSetup(setupFile(d, { world: { age: "1h" }, characters: [{ name: "Ran", class: "ranger", state: { level: 30 }, at: "main:0:0", code: { file: "farm.js" } }] }));
	const { resolved, bundles } = S.resolveSetup(s);
	const { sim, clients } = await startSetup(resolved, bundles, { live: { dir: live, setup: { resolved, bundles, from: s.file } } });
	let file;
	try {
		assert.ok(sim.clock.now - sim.clock.start >= 3600e3, "the clock ran the age before the login");
		assert.equal(await clients.Ran.query("character.level"), 30);
		const levels = Object.values(sim.server.instances.main.monsters).map((m) => m.level);
		assert.ok(levels.some((l) => l > 1), "monsters levelled up during the age");
		await sim.run(3000);
		file = sim.live.file;
	} finally {
		await sim.close();
	}
	const snap = JSON.parse(fs.readFileSync(file, "utf8")),
		ml = snap.world.mlevels;
	assert.equal(snap.world.age_ms, 3600e3);
	assert.ok(snap.virtual_ms < 60e3, `virtual_ms counts from the login: ${snap.virtual_ms}`);
	assert.ok(ml.base && ml.end && Object.values(ml.base.main).some((x) => x.max > 1), "mlevels at the base: levelled monsters");
	for (const x of Object.values(ml.base.main)) assert.ok(Number.isInteger(x.n) && x.n >= 1 && x.avg >= 1 && x.avg <= x.max, JSON.stringify(x));
	// the types the level-up loop skips (cute, peaceful, stationary) are left out
	const M = sim.server.G.monsters;
	for (const t of Object.values(ml.base)) for (const k of Object.keys(t)) assert.ok(!(M[k].cute || M[k].peaceful || M[k].stationary), k);
});

test("storage and steering: accounts.<k>.storage and local_storage (null: unset), steer (in order, checked, a left-out character's dropped); storageEntries, steerText; the setup key counts them; a CODE set keeps a character's prelude", () => {
	const d = layout();
	const base = { characters: [{ name: "A", class: "ranger", code: { file: "farm.js" } }, { name: "B", class: "priest", code: { file: "farm.js", prelude: "var P = 1;" } }] };
	const s = S.loadSetup(setupFile(d, {
		...base, accounts: { main: { storage: { mode: "farm", n: 3, gone: null }, local_storage: { raw: "t" } } },
		steer: [{ at: "5m", storage: { mode: "boss", gone: null } }, { at: "90s", character: "B", code: "set_message('x')", note: "hi" }],
	}), { G });
	assert.deepEqual(s.accounts.main, { age_days: 0, bank: null, storage: { mode: "farm", n: 3 }, local_storage: { raw: "t" } });
	assert.deepEqual(s.steer, [{ at: "5m", storage: { mode: "boss", gone: null } }, { at: "90s", character: "B", code: "set_message('x')", note: "hi" }], "in their order");
	assert.deepEqual(S.storageEntries(s.accounts.main), { raw: "t", cstore_mode: '"farm"', cstore_n: "3" });
	assert.deepEqual(S.storageEntries(s.steer[0]), { cstore_mode: '"boss"', cstore_gone: null });
	assert.equal(S.steerText({ storage: { a: 1 }, local_storage: { b: "x" }, code: "f(1);\n  g()" }), 'a=1, localStorage b="x", run f(1); g()');
	const r = S.resolveSetup(s, { G }).resolved;
	assert.deepEqual([r.accounts.main.storage, r.steer.length], [{ mode: "farm", n: 3 }, 2]);
	const key = (o) => S.setupKey(S.resolveSetup(S.loadSetup(setupFile(d, { ...base, ...o }), { G }), { G }).resolved, "v");
	assert.notEqual(key({ accounts: { main: { storage: { mode: "farm" } } } }), key({}));
	assert.notEqual(key({ steer: [{ at: "1m", code: "1" }] }), key({}));
	// every problem at once
	assert.throws(() => S.loadSetup(setupFile(d, {
		...base, accounts: { main: { storage: [1], local_storage: { a: 1 } }, two: { storage: { k: 1 }, local_storage: { cstore_k: "1" } } },
		steer: [{ at: "x", character: "Z", code: "var (" }, { at: "1m" }, 3, { at: "1m", what: 1, code: "1" }],
	}), { G }), (e) => {
		assert.deepEqual(e.problems, [
			"accounts.main.storage: { <key>: <a value, as get(key) returns it> }", "accounts.main.local_storage: { <localStorage key>: <text> }",
			"accounts.two.local_storage.cstore_k: storage.k sets it too (set/get keep their values under \"cstore_<key>\")",
			`steer[0].at: "x", a game time since the run's start (90s, 30m, 2h, or minutes)`, 'steer[0].character: "Z" is not a character of the setup', "steer[0].code: Unexpected token '('",
			"steer[1]: nothing to do (storage, local_storage or code)", "steer[2]: { name, at | when (for, repeat, window) | after, character, storage, local_storage, code, note }",
			"steer[3].what: unknown key (known: name, at, when, for, repeat, window, after, character, storage, local_storage, code, note)",
		]);
		return true;
	});
	// a CODE set: the character's own prelude stays; left out (missing: exclude): its steering goes
	const set = { name: "x", kind: "dir", code: { dir: path.join(d, "lib") }, entries: { A: "Ran", B: "Ran" } };
	const withSet = S.loadSetup(setupFile(d, { ...base, steer: [{ at: "1m", character: "A", code: "1" }, { at: "2m", code: "2" }] }), { G, overrides: { code_set: set, missing: { A: "exclude" } } });
	assert.deepEqual([withSet.characters.map((c) => [c.name, c.code.prelude]), withSet.steer], [[["B", "var P = 1;"]], [{ at: "2m", code: "2" }]]);
});

test("start.js steerer on a real sim: each account's storage at the start (its pages'), steering at its times (storage into its character's account, code in its CODE; not running: said), a prelude", { timeout: 180000 }, async (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const { startSetup, steerer } = require("../sim/start");
	const d = tmp();
	write(d, "st.js", "parent.__seen = []; setInterval(() => parent.__seen.push([get('mode'), localStorage.getItem('raw'), typeof steered === 'undefined' ? null : steered]), 30000);\n");
	const s = S.loadSetup(setupFile(d, {
		run: { seed: 2 }, accounts: { main: { storage: { mode: "farm" }, local_storage: { raw: "r0" } }, other: { storage: { mode: "other" } } },
		characters: [{ name: "A", class: "ranger", code: { file: "st.js" } }, { name: "B", class: "priest", code: { file: "st.js" } }, { name: "C", class: "mage", account: "other", code: { file: "st.js", prelude: "var steered = 'pre';" } }],
		steer: [{ at: "60s", character: "A", storage: { mode: "boss" } }, { at: "90s", character: "B", code: "steered = 'yes'" }, { at: "95s", character: "C", code: "throw new Error('no')" }, { at: "100s", storage: { mode: null }, note: "clear" }],
	}));
	const { resolved, bundles } = S.resolveSetup(s);
	const { sim, clients } = await startSetup(resolved, bundles, { live: false });
	try {
		const st = steerer(sim, resolved);
		st.start();
		const r = await st.run(150_000);
		assert.equal(r.virtualMs, 150_000);
		assert.deepEqual(st.done.map((e) => [e.at, e.character, e.what, e.did, e.errors]), [
			["60s", "A", 'mode="boss"', ["storage main"], []], ["90s", "B", "run steered = 'yes'", ["code B"], []], ["95s", "C", "run throw new Error('no')", [], ["C: no"]], ["100s", null, "mode=null", ["storage main", "storage other"], []],
		]);
		const seen = {};
		for (const n of ["A", "B", "C"]) seen[n] = await clients[n].query("parent.__seen");
		assert.deepEqual(seen.A, [["farm", "r0", null], ["farm", "r0", null], ["boss", "r0", null], [null, "r0", null], [null, "r0", null]]);
		assert.deepEqual(seen.B.map((x) => x[0] + " " + x[2]), ["farm null", "farm null", "boss null", "null yes", "null yes"], "B: its account's storage (A's steering), its own CODE");
		assert.deepEqual(seen.C, [["other", null, "pre"], ["other", null, "pre"], ["other", null, "pre"], [null, null, "pre"], [null, null, "pre"]]);
	} finally {
		await sim.close();
	}
});

test("start.js steerer on a real sim: conditions checked every run.check (here 10 game s) against the run's snapshot (kills by type, a log line), a step after another, run.until ending the run", { timeout: 240000 }, async (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const { startSetup, steerer } = require("../sim/start");
	const d = tmp();
	write(d, "farm.js", `var last = null;
setInterval(function () {
	var want = get("farm");
	if (want !== last) game_log("farm " + want), (last = want), change_target(null);
	if (character.rip) return respawn();
	if (character.hp < character.max_hp * 0.6) use_hp_or_mp();
	loot();
	if (is_moving(character) || smart.moving || !want) return;
	var m = get_targeted_monster();
	if (!m || m.mtype !== want || !parent.entities[m.id]) { m = get_nearest_monster({ type: want }); if (!m) return smart_move(want); change_target(m); }
	if (!is_in_range(m)) move(character.x + (m.x - character.x) / 2, character.y + (m.y - character.y) / 2);
	else if (can_attack(m)) attack(m);
}, 250);
`);
	const s = S.loadSetup(setupFile(d, {
		run: { seed: 3, until: "steps.bees && t >= steps.bees.t + 40", check: "10s" }, accounts: { main: { storage: { farm: "goo" } } },
		characters: [{ name: "Ran", class: "ranger", state: { level: 30 }, code: { file: "farm.js" } }],
		steer: [
			{ name: "bees", when: "c.Ran.kills.goo >= 3", storage: { mode: "three" } },
			{ after: "bees", at: "20s", code: "game_log('after bees')" },
			{ when: "c.Ran.log(/after bees/) > 0", code: "parent.__saw = get('mode')" },
			{ when: "c.Ran.kills.goo >= 1000", code: "1" },
		],
	}));
	const { resolved, bundles } = S.resolveSetup(s);
	const { sim, clients } = await startSetup(resolved, bundles, { live: { dir: tmp(), tag: "conditions" } });
	try {
		const st = steerer(sim, resolved);
		st.start();
		const t0 = sim.clock.now,
			r = await st.run(600_000, { untilT0: sim.clock.now });
		assert.equal(r.until, true, "until: 40 s after the first step");
		assert.ok(r.virtualMs < 600_000 && r.virtualMs % 10_000 === 0, `ended at a check: ${r.virtualMs}`);
		const [bees, after, saw] = st.done;
		assert.deepEqual(st.done.map((e) => [e.i, e.name || null, e.why]), [[0, "bees", "when c.Ran.kills.goo >= 3"], [1, null, "20s after bees"], [2, null, "when c.Ran.log(/after bees/) > 0"]]);
		const at = (e) => sim.live.steers.find((x) => x.i === e.i).t;
		assert.equal(Math.round(at(bees)) % 10, 0, "a condition fires at a check");
		assert.equal(Math.round((at(after) - at(bees)) * 10) / 10, 20);
		assert.ok(at(saw) >= at(after) && at(saw) - at(after) <= 10, "the log line seen at the next check");
		assert.equal(await clients.Ran.query("parent.__saw"), "three", "its storage set by the first step");
		const p = sim.live.peek().players[0];
		assert.ok(p.kills_by.goo >= 3 && p.kills === p.kills_by.goo, JSON.stringify(p.kills_by));
		assert.equal(Math.round(r.virtualMs / 1000), Math.round(at(bees)) + 40, "(the checks' t and the steps' t: from the start, no warm-up)");
		assert.ok(sim.clock.now - t0 === r.virtualMs);
	} finally {
		await sim.close();
	}
});
