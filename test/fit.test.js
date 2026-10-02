"use strict";
// fit.js (fitting others' CODE): slots as the game names them, what a text calls and defines, the calls fitted, the
// fit suggested for a folder (file names, helpers), entries guessed by name and class, ES modules bundled; setup.js
// applies code.fit and finds the entry whatever its case; a pull's slot numbers;
// the library keeps a fit per entry (suggested at its commit, chosen on top) and compose guesses its entries.
//   node --test test/fit.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { execFileSync } = require("node:child_process");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "fit-test-"))), dirs[dirs.length - 1]);
const libWas = process.env.CHRONAL_LIBRARY_DIR;
process.env.CHRONAL_LIBRARY_DIR = tmp();
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	if (libWas === undefined) delete process.env.CHRONAL_LIBRARY_DIR;
	else process.env.CHRONAL_LIBRARY_DIR = libWas;
});
const F = require("../lib/fit");
const S = require("../lib/setup");
const C = require("../lib/code_sets");
const L = require("../lib/library");
const K = require("../lib/compose");

const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" }).trim();
const G = { classes: { ranger: { base_slots: {} }, priest: { base_slots: {} }, warrior: { base_slots: {} } }, maps: { main: { spawns: [[5, 6, 0, 100]] } } };
const SKILLS = { heal: { class: ["priest"] }, curse: { class: ["priest"] }, supershot: { class: ["ranger"] }, "3shot": { class: ["ranger"] }, taunt: { class: ["warrior"] } };
const slotsOf = (d, recursive = true) => F.slotsOf({ dir: d, recursive });

test("slotFiles: the game's names (letters, digits, _-.+ and spaces), the shallowest first, a second name deeper in its folder's; no .git, node_modules or hidden folders", () => {
	const d = tmp();
	write(d, "Phoenix Farm (v2).js", "");
	write(d, "util.js", "");
	write(d, "lib/Util.js", "");
	write(d, "lib/deep/util.js", "");
	write(d, "readme.md", "");
	write(d, "node_modules/x/index.js", "");
	write(d, ".git/hooks/a.js", "");
	write(d, ".hidden/b.js", "");
	assert.deepEqual(F.slotFiles(d, true).map((x) => [x.slot, path.relative(d, x.file)]), [["Phoenix Farm v2", "Phoenix Farm (v2).js"], ["util", "util.js"], ["lib-Util", "lib/Util.js"], ["deep-util", "lib/deep/util.js"]]);
	assert.deepEqual(F.slotFiles(d, false).map((x) => x.slot), ["Phoenix Farm v2", "util"]);
	// setup.js and code_sets.js read the same names
	assert.deepEqual(C.slotNames({ code: { dir: d, recursive: true } }), ["Phoenix Farm v2", "deep-util", "lib-Util", "util"]);
});

test("fileSays: name.number, number_name, a character's id", () => {
	assert.deepEqual(F.fileSays("actions.2"), { name: "actions", number: 2 });
	assert.deepEqual(F.fileSays("02_constants"), { name: "constants", number: 2 });
	assert.deepEqual(F.fileSays("10 priest"), { name: "priest", number: 10 });
	assert.deepEqual(F.fileSays("RobertTables.6101872310222848"), { name: "RobertTables", number: null });
	assert.equal(F.fileSays("main"), null);
	assert.equal(F.fileSays("500_x"), null);
});

test("facts: a module or a script, its load_code / require_code keys (number, name, as it runs), what it defines and calls", () => {
	const f = F.facts('load_code(2); require_code("Actions"); load_code(`x`); parent.load_code(n);\nfunction a() { b(); var q = 1; }\nvar c = 1, { d } = o; e = function () {}; window.g = 1;\nnew H(); use_skill("heal");\n');
	assert.equal(f.module, false);
	assert.deepEqual(f.calls.map((c) => [c.fn, c.key, c.line]), [["load_code", "2", 1], ["require_code", "Actions", 1], ["load_code", "x", 1], ["load_code", null, 1]]);
	assert.deepEqual([...f.defines].sort(), ["a", "c", "d", "e", "g"]);
	assert.ok(["b", "H", "load_code", "require_code", "use_skill"].every((n) => f.called.has(n)));
	assert.ok(f.declared.has("q") && f.declared.has("a"));
	assert.equal(f.strings.get("heal"), 1);
	assert.equal(F.facts('import { x } from "/x.js";\nx();\n').module, true);
	assert.match(F.facts("function (").error, /^line 1/);
});

test("fitCalls: a number or a name to a slot (whatever its case and the characters the game drops), null to none; others left; unread text as it is", () => {
	const t = 'load_code(2);\nload_code("Startup");\nvar m = require_code("gone");\nload_code("gone");\nload_code(3);\nload_code(n);\n';
	assert.equal(F.fitCalls(t, { 2: "02_constants", "STARTUP!": "startup", gone: null }), 'load_code("02_constants");\nload_code("startup");\nvar m = ({});\nvoid 0;\nload_code(3);\nload_code(n);\n');
	assert.equal(F.fitCalls("load_code(2) {", { 2: "x" }), "load_code(2) {");
	assert.equal(F.fitCalls(t, {}), t);
});

test("suggest: calls by its files' names (number_name, name.number), open ones, dynamic; the helpers an entry calls; chosen kept (an emptied helper list too)", () => {
	const d = tmp();
	write(d, "01_master.js", "load_code(2);\nload_code(7);\nrequire_code('actions');\nload_code(slot);\nrun();\n");
	write(d, "02_constants.js", "var X = 1;\n");
	write(d, "actions.3.js", "function act() {}\n");
	write(d, "Bramble.js", "setInterval(function () { give_location('Lark'); smart_move('main'); }, 1000);\n");
	write(d, "helpers/cmstuff.js", "function give_location(p) { send_cm(p, 1); }\nfunction run() {}\n");
	write(d, "mod.js", 'import { a } from "./a.js";\n');
	const slots = slotsOf(d),
		s = F.suggest(slots);
	assert.deepEqual(s.calls.map((c) => [c.fn, c.key, c.to, c.why, c.where]), [
		["load_code", "2", "02_constants", "its file 02_constants.js", ["01_master:1"]],
		["load_code", "7", undefined, "no file numbered 7", ["01_master:2"]],
		["require_code", "actions", "actions.3", "its file actions.3.js", ["01_master:3"]],
	]);
	assert.deepEqual(s.dynamic, [{ where: "01_master", line: 4, text: "load_code(slot)" }]);
	assert.deepEqual(s.with.map((w) => [w.entry, w.slots, w.why]), [["01_master", ["cmstuff"], "defines run"], ["Bramble", ["cmstuff"], "defines give_location"]]);
	assert.deepEqual(s.modules, ["mod"]);
	assert.deepEqual([...s.loaded].sort(), ["02_constants", "actions.3"]);
	// chosen: a call's slot (or none), an entry's helpers (none: [])
	const c = F.suggest(slots, { calls: { 7: null, 2: "actions.3" }, with: { bramble: [] } });
	assert.deepEqual(c.calls.filter((x) => x.why === "chosen").map((x) => [x.key, x.to]), [["2", "actions.3"], ["7", null]]);
	assert.deepEqual(c.with.map((w) => [w.entry, w.slots, w.why]), [["01_master", ["cmstuff"], "defines run"], ["Bramble", [], "chosen"]]);
	// a name a slot has (whatever its case) needs no fit
	write(d, "Startup.js", "");
	write(d, "x.js", 'load_code("startup");\n');
	assert.ok(!F.suggest(slotsOf(d)).calls.some((x) => x.key === "startup"));
});

test("entryGuess: its file's name, a known character of its class, named for its class, main, its class's skills, the only slot; slots another loads are not entries", () => {
	const d = tmp();
	write(d, "RobertTables.6101872310222848.js", "");
	write(d, "Mendi.js", "setInterval(function () { heal(get_player('Bramble')); }, 250);\n");
	write(d, "Lark.js", 'use_skill("supershot"); use_skill("3shot"); use_skill("supershot"); use_skill("taunt");\n');
	write(d, "10_priest.js", "load_code(2);\n");
	write(d, "2_requires.js", "");
	const slots = slotsOf(d),
		loaded = F.suggest(slots).loaded,
		g = (ch, o = {}) => F.entryGuess(slots, ch, { skills: SKILLS, loaded, ...o });
	assert.deepEqual(g({ name: "RobertTables", class: "mage" }), { slot: "RobertTables.6101872310222848", why: "its file RobertTables.6101872310222848.js" });
	assert.deepEqual(g({ name: "Ann", class: "priest" }, { known: new Map([["Mendi", { class: "priest", of: "public page Bramble" }]]) }), { slot: "Mendi", why: "Mendi's, a priest (public page Bramble)" });
	assert.deepEqual(g({ name: "Ann", class: "priest" }), { slot: "10_priest", why: "named for priests" });
	assert.deepEqual(g({ name: "Bob", class: "ranger" }), { slot: "Lark", why: "uses ranger skills: supershot, 3shot" });
	assert.equal(g({ name: "Cid", class: "warrior" }), null); // taunt once, among ranger skills: not its class's
	write(d, "main.js", "");
	assert.deepEqual(F.entryGuess(slotsOf(d), { name: "Cid", class: "warrior" }, { skills: SKILLS }), { slot: "main", why: "named main" });
	const one = tmp();
	write(one, "bot.v2.js", "");
	assert.deepEqual(F.entryGuess(slotsOf(one), { name: "Cid", class: "warrior" }), { slot: "bot.v2", why: "its only slot" });
	// by skills its calls name too (heal()), alone: its class's only
	const two = tmp();
	write(two, "a.js", "heal(character);\n");
	write(two, "b.js", "");
	assert.deepEqual(F.entryGuess(slotsOf(two), { name: "Ann", class: "priest" }, { skills: SKILLS }), { slot: "a", why: "uses priest skills: heal" });
});

test("bundle: an ES module and what it imports (relative, \"/x\" from its folder) as one script; a package's import refused", () => {
	const d = tmp();
	write(d, "src/main.js", 'import { hi } from "/lib/util.js";\nimport * as M from "./more";\nhi(M.n);\n');
	write(d, "src/lib/util.js", "export function hi(n) { game_log('hi ' + n); }\n");
	write(d, "src/more.js", "export const n = 3;\n");
	const out = F.bundle(path.join(d, "src", "main.js"), d);
	assert.ok(!/\bimport\b|\bexport\b/.test(out.replace(/\/\/.*$/gm, "")), out);
	const said = [];
	new Function("game_log", out)((s) => said.push(s));
	assert.deepEqual(said, ["hi 3"]);
	write(d, "src/pkg.js", 'import axios from "axios";\naxios.get("x");\n');
	assert.throws(() => F.bundle(path.join(d, "src", "pkg.js"), d), /bundling pkg\.js: .*axios: a package/);
	write(d, "src/out.js", 'import "../../outside.js";\n');
	assert.throws(() => F.bundle(path.join(d, "src", "out.js"), d), /no such file/);
});

test("setup.js: code.fit (calls in every slot, helpers before the entry), the entry whatever its case, an ES module entry bundled; a bad fit refused", () => {
	const d = tmp();
	write(d, "code/Bramble.js", "load_code(2);\ngive_location('x');\n");
	write(d, "code/02_constants.js", 'var K = 1;\nrequire_code("gone");\n');
	write(d, "code/helpers/cmstuff.js", "function give_location(p) {}\n");
	write(d, "code/main.js", 'import { k } from "/k.js";\nload_code(2);\nk();\n');
	write(d, "code/k.js", "export function k() {}\n");
	const one = (name, code) =>
		S.resolveSetup(S.loadSetup({ format: "chronal-setup/1", name: "f", characters: [{ name, class: "ranger", code: { dir: path.join(d, "code"), recursive: true, ...code } }] }, { G }), { G, build: false });
	const fit = { calls: { 2: "02_constants", gone: null }, with: { Bramble: ["cmstuff"] } };
	const r = one("bramble", { fit });
	const b = r.bundles.bramble;
	assert.equal(b.entry, "Bramble");
	assert.match(b.text, /^function give_location\(p\) \{\}\n[\s\S]*\n;load_code\("02_constants"\);\ngive_location/);
	assert.match(b.files["02_constants"], /^var K = 1;\nvar|^var K = 1;\n\(\{\}\);/);
	assert.match(b.files.Bramble, /^load_code\("02_constants"\);/);
	assert.deepEqual(r.resolved.source.characters.bramble.fit, fit);
	// the module entry: bundled, its calls fitted
	const m = one("Ann", { entry: "main", fit: { calls: { 2: "02_constants" } } }).bundles.Ann;
	assert.ok(!/^import /m.test(m.text) && /load_code\("02_constants"\)/.test(m.text) && /sourceURL=code\/main\.js/.test(m.text), m.text);
	// without a fit: the CODE as it is
	assert.match(one("Bramble", {}).bundles.Bramble.text, /^load_code\(2\);/);
	assert.throws(() => S.loadSetup({ format: "chronal-setup/1", name: "f", characters: [{ name: "A", class: "ranger", code: { dir: path.join(d, "code"), fit: { calls: { 2: 3 }, other: 1 } } }] }, { G }), (e) => e.problems.some((p) => /code\.fit: other: unknown key/.test(p)) && e.problems.some((p) => /code\.fit: calls:/.test(p)));
	assert.throws(() => one("Bramble", { fit: { with: { Bramble: ["nope"] } } }), (e) => e.problems.some((p) => /code\.fit\.with Bramble: no slot nope/.test(p)));
});

test("a pull's set: the slot numbers its CODE writes load their slots (slots.json)", () => {
	const pulls = tmp(),
		p = path.join(pulls, "Acc", "2026-09-27T10-00-00Z");
	write(p, "code/core.js", "load_code(2);\nload_code(9);\n");
	write(p, "code/util.js", "");
	write(p, "code/slots.json", JSON.stringify([{ slot: "1", name: "core", file: "core.js" }, { slot: "2", name: "util", file: "util.js" }, { slot: "3", name: "spare", file: null }]));
	write(p, "pull.json", JSON.stringify({ format: "chronal-pull/1", account: "Acc", pulled_at: "2026-09-27T10:00:00.000Z", characters: [], code: { dir: "code", slots: 3, characters: [] } }));
	const s = C.loadCodeSets({ file: null, pullsDir: pulls }).sets.find((x) => x.name === "pull:Acc");
	assert.ok(s, "the pull's set");
	assert.deepEqual(s.code.fit, { calls: { 2: "util" } });
});

test("the library: a fit per entry (suggested at its commit, chosen over it), its sets fitted; compose guesses its entries and reports the fit", () => {
	const src = tmp();
	git(src, "init", "-q", "-b", "main");
	write(src, "Characters/Mendi.js", "setInterval(function () { heal(character); give_location('x'); }, 250);\n");
	write(src, "Characters/Bramble.js", 'use_skill("taunt"); load_code(2);\n');
	write(src, "Others/cmstuff.js", "function give_location(p) {}\n");
	write(src, "Others/02_util.js", "var U = 1;\n");
	git(src, "add", "-A");
	git(src, "commit", "-qm", "one");
	return L.add({ from: src, name: "theirs", taken: [] }).then(async () => {
		// (a folder of this machine is read in place: a clone of it pins a commit)
		const bare = path.join(tmp(), "r.git");
		execFileSync("git", ["clone", "-q", "--bare", src, bare]);
		await L.add({ from: "file://" + bare, name: "pinned", taken: [] });
		const e = L.get("pinned"),
			def = L.setDef(e);
		assert.deepEqual(def.fit, { calls: { 2: "02_util" }, with: { Mendi: ["cmstuff"] } });
		assert.equal(L.get("pinned").meta.fit_auto.commit, e.meta.commit);
		L.setFit("pinned", { calls: { 2: null }, with: { Mendi: [] } });
		assert.deepEqual(L.setDef(L.get("pinned")).fit, { calls: { 2: null } });
		L.setFit("pinned", { calls: { 2: undefined }, with: { Mendi: undefined } });
		assert.equal(L.get("pinned").meta.fit, undefined);
		assert.throws(() => L.setFit("pinned", { calls: { 2: "nope" } }), /no slot nope in pinned/);
		const info = L.fitInfo("pinned");
		assert.deepEqual([info.slots.length, info.calls.map((c) => c.to), info.with.map((w) => w.entry)], [4, ["02_util"], ["Mendi"]]);
		// the set (and a path entry's too): fitted
		assert.deepEqual(C.codeSet("pinned").code.fit, def.fit);
		assert.deepEqual(C.codeSet("theirs").code.fit, def.fit);
		// compose: a priest and a warrior on it get its entries by their classes; the fit as they run it
		const s = { format: "chronal-setup/1", name: "t", defaults: { code: { ...C.codeFor(C.codeSet("pinned"), "x"), entry: undefined } }, characters: [{ name: "Ann", class: "priest" }, { name: "Cid", class: "warrior" }] };
		delete s.defaults.code.entry;
		const st = K.settle(s, { given: false, build: null, G: { skills: SKILLS } });
		assert.deepEqual(st.applied.map((m) => [m.name, m.choice, m.guessed, m.guess.why]), [["Ann", "slot:Mendi", true, "uses priest skills: heal"], ["Cid", "slot:Bramble", true, "uses warrior skills: taunt"]]);
		const fits = K.fitsOf(s, { build: null });
		assert.deepEqual(fits.map((f) => [f.lib, f.entries, f.with.map((w) => w.entry), f.calls.map((c) => c.key)]), [["pinned", { Ann: "Mendi", Cid: "Bramble" }, ["Mendi"], ["2"]]]);
		// a choice beats the guess
		const s2 = structuredClone({ ...s, characters: [{ name: "Ann", class: "priest" }] });
		assert.deepEqual(K.settle(s2, { given: false, build: null, choices: { Ann: "slot:Bramble" }, G: { skills: SKILLS } }).applied.map((m) => [m.choice, m.guessed]), [["slot:Bramble", false]]);
	});
});
