"use strict";
// Names in CODE (names.js; setup.js code_names; compose.js namesOf, settle): what is mapped (strings exactly the name
// in any quotes or escapes, property names, shorthands) and what isn't (comments, longer strings, templates' text,
// patterns, identifiers), flags, swaps, texts not read; a setup's code_names validated and applied in both kinds of
// resolve (slots renamed, the entry by the character's name, what the setup writes itself left alone); the default map.
//   node --test test/names.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const N = require("../lib/names");
const S = require("../lib/setup");
const K = require("../lib/compose");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "names-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const G = {
	classes: { ranger: { base_slots: {} }, priest: { base_slots: {} }, merchant: { base_slots: {} }, paladin: { base_slots: {} } },
	maps: { main: { spawns: [[0, 0]] } },
};
const MAP = { JohnRanger: "Ran1", JohnPriest: "Pri1" };

test("mapText: a string that is the name, in any quotes or escapes; a property's name; a shorthand; the rest as it was", () => {
	const src = [
		"const party = [\"JohnRanger\", 'JohnPriest', `JohnRanger`, \"John\\u0052anger\"];",
		"const cfg = { JohnPriest: { mp: 1 }, \"JohnRanger\": 2, ['JohnPriest']: 3, JohnRanger };",
		"const { JohnPriest: pri, JohnRanger = 4 } = cfg;",
		"cfg.JohnPriest.x = cfg?.JohnRanger + cfg[\"JohnPriest\"];",
		"class A { JohnRanger() {} static JohnPriest = 1; get JohnRanger2() { return 1; } }",
		"const JohnRanger3 = 1; JohnRanger: for (;;) break JohnRanger;",
		"const x = { get JohnPriest() { return 1; }, JohnRanger: function () {} };",
	].join("\n");
	const r = N.mapText(src, MAP);
	assert.equal(r.error, null);
	assert.equal(r.text, [
		"const party = [\"Ran1\", 'Pri1', `Ran1`, \"Ran1\"];",
		"const cfg = { Pri1: { mp: 1 }, \"Ran1\": 2, ['Pri1']: 3, Ran1: JohnRanger };",
		"const { Pri1: pri, Ran1: JohnRanger = 4 } = cfg;",
		"cfg.Pri1.x = cfg?.Ran1 + cfg[\"Pri1\"];",
		"class A { Ran1() {} static Pri1 = 1; get JohnRanger2() { return 1; } }",
		"const JohnRanger3 = 1; JohnRanger: for (;;) break JohnRanger;",
		"const x = { get Pri1() { return 1; }, Ran1: function () {} };",
	].join("\n"));
	assert.deepEqual(r.hits, { JohnRanger: 9, JohnPriest: 8 });
	assert.deepEqual(r.flags, []);
});

test("mapText: comments, longer strings, templates' text and patterns stay; a string that may be meant as a name is flagged", () => {
	const src = [
		"// JohnRanger leads",
		"/* \"JohnPriest\" heals */ var a = 1;",
		"var s = \"JohnRanger,JohnPriest\", q = 'say \"JohnRanger\"', c = \"// JohnPriest\";",
		"var t = `hi ${who} JohnRanger`, u = `${\"JohnPriest\"}`;",
		"var r = /JohnRanger/g, k = x / 2 / y, after = \"JohnRanger\";",
		"var lo = \"johnpriest\", built = \"John\" + cls, tail = \"Ranger\", short = \"Jo\";",
		"var raw = String.raw`JohnRanger`;",
	].join("\n");
	const r = N.mapText(src, MAP);
	const lines = r.text.split("\n");
	assert.equal(lines[0], "// JohnRanger leads");
	assert.equal(lines[1], "/* \"JohnPriest\" heals */ var a = 1;");
	assert.equal(lines[2], "var s = \"JohnRanger,JohnPriest\", q = 'say \"JohnRanger\"', c = \"// JohnPriest\";");
	assert.equal(lines[3], "var t = `hi ${who} JohnRanger`, u = `${\"Pri1\"}`;");
	assert.equal(lines[4], "var r = /JohnRanger/g, k = x / 2 / y, after = \"Ran1\";", "a pattern and a division before a string");
	assert.equal(lines[6], "var raw = String.raw`JohnRanger`;", "a tagged template goes to its tag as written");
	assert.deepEqual(r.flags.map((f) => [f.line, f.text, f.name, f.why]), [
		[3, '"JohnRanger,JohnPriest"', "JohnRanger", "inside"],
		[3, "'say \"JohnRanger\"'", "JohnRanger", "inside"],
		[3, '"// JohnPriest"', "JohnPriest", "inside"],
		[4, " JohnRanger", "JohnRanger", "inside"],
		[5, "/JohnRanger/g", "JohnRanger", "inside"],
		[6, '"johnpriest"', "JohnPriest", "case"],
		[6, '"John"', "JohnRanger", "part"],
		[6, '"Ranger"', "JohnRanger", "part"],
		[7, "JohnRanger", "JohnRanger", "inside"],
	]);
	assert.equal(N.flagText({ where: "a.js", ...r.flags[6] }), 'a.js:6 "John" (a part of JohnRanger)');
});

test("mapText: a swap at once; a name to itself stays; a known name is no part of another", () => {
	const r = N.mapText('f("A1", "B1", "Ma", "Ma" + "B1x");', { A1: "B1", B1: "A1", Ma: "Ma" });
	assert.equal(r.text, 'f("B1", "A1", "Ma", "Ma" + "B1x");');
	assert.deepEqual(r.hits, { A1: 1, B1: 1 });
	// "John" starts "JohnRanger", but it is a name of its own (the map's, or the run's): not flagged
	assert.deepEqual(N.mapText('x("John", "JohnRanger")', { JohnRanger: "Ran1" }, ["John"]).flags, []);
	assert.deepEqual(N.mapText('x("John", "JohnRanger")', { JohnRanger: "Ran1", John: "John" }).flags, []);
	assert.equal(N.mapText('x("John", "JohnRanger")', { JohnRanger: "Ran1" }).flags[0].why, "part");
});

test("mapText: a syntax acorn doesn't take: an error, the text as it was; nothing to map: not parsed; a script's allowances", () => {
	const bad = N.mapText('var p = ["JohnRanger",\n (', MAP);
	assert.equal(bad.text, 'var p = ["JohnRanger",\n (');
	assert.match(bad.error, /^line 2: Unexpected token/);
	assert.equal(N.mapText("this is not ( CODE", MAP).error, null, "no name in it: not parsed");
	assert.equal(N.mapText('var x = "JohnRanger"', {}).text, 'var x = "JohnRanger"');
	const ok = N.mapText('#!/usr/bin/env node\nawait x("JohnRanger");\nreturn "JohnPriest";', MAP);
	assert.equal(ok.error, null);
	assert.equal(ok.text, '#!/usr/bin/env node\nawait x("Ran1");\nreturn "Pri1";');
});

test("scan: the names looked for (strings, keys, shorthands), and name-like strings passed as a character's name", () => {
	const src = [
		"// JohnPriest in a comment",
		"const cfg = { JohnPriest: 1, fighters: ['JohnRanger', \"JohnRanger\"] }, x = { JohnMage };",
		"send_cm(['Friend1', 'JohnRanger'], {}); parent.send_party_invite('Friend2'); get_player(\"Friend3\");",
		"if (character.name == 'Friend4' || 'Friend5' !== parent.character.name) start_character('Friend6', 'main');",
		"switch (character.name) { case 'Friend7': break; }",
		"const e = parent.entities['Friend8'] || entities.Friend9; send_gold('hello world', 1); send_item('123', 1);",
		"if (target.name === 'Goo') change_target(get_player(name));",
	].join("\n");
	const r = N.scan(src, ["JohnPriest", "JohnRanger", "JohnMage"]);
	assert.deepEqual(r.found, { JohnPriest: 1, JohnRanger: 3, JohnMage: 1 });
	assert.deepEqual(r.suggested, {
		Friend1: ["send_cm()"], Friend2: ["send_party_invite()"], Friend3: ["get_player()"], Friend4: ["character.name =="], Friend5: ["character.name !=="], Friend6: ["start_character()"], Friend7: ["switch (character.name)"], Friend8: ["entities[]"],
	});
	assert.deepEqual(N.scan("var a = 1;", ["JohnPriest"]), { found: {}, suggested: {}, error: null });
	assert.match(N.scan('send_cm("x", (', []).error, /^line 1:/);
});

// a CODE directory for John's party: an entry per character, a module naming them, a file loaded by a name
function johnCode() {
	const d = tmp();
	write(d, "code/JohnRanger.js", 'require_code("core"); var me = "JohnRanger"; var healer = "JohnPriest";\n');
	write(d, "code/JohnPriest.js", 'require_code("core"); load_code("JohnRanger_cfg"); var lead = "JohnRanger";\n');
	write(d, "code/JohnRanger_cfg.js", "var cfg_of = 'JohnRanger_cfg';\n");
	write(d, "code/core.js", 'var party = { JohnRanger: { role: "dps" }, JohnPriest: { role: "heal" } }; // JohnRanger leads\nvar list = "JohnRanger,JohnPriest";\n');
	write(d, "adapter.js", 'self.chronal = self.chronal || {}; chronal.lead = "JohnRanger";\n');
	return d;
}
const johnSetup = (d, o = {}) => ({
	format: "chronal-setup/1", name: "john",
	defaults: { code: { dir: path.join(d, "code"), append: [path.join(d, "adapter.js")] } },
	characters: [
		{ name: "Ran1", class: "ranger", extra: ['var mine = "JohnRanger";'] },
		{ name: "Pri1", class: "priest", code: { entry: "JohnPriest", prelude: 'var pre = "JohnPriest";' } },
	],
	code_names: { JohnRanger: "Ran1", JohnPriest: "Pri1" },
	...o,
});

test("loadSetup: code_names names the CODE's names and the run's characters; one to a character left out stays", () => {
	const d = johnCode();
	assert.deepEqual(S.loadSetup(johnSetup(d), { G }).code_names, { JohnRanger: "Ran1", JohnPriest: "Pri1" });
	assert.equal("code_names" in S.loadSetup(johnSetup(d, { code_names: undefined }), { G }), false);
	assert.throws(() => S.loadSetup(johnSetup(d, { code_names: { "bad name": "Ran1", JohnMage: "Nobody", JohnPal: 3, JohnX: "JohnX" } }), { G }), (e) => {
		assert.deepEqual(e.problems, ["code_names.bad name: a character's name (1-12 letters and digits)", "code_names.JohnMage: Nobody is not a character of the setup", "code_names.JohnPal: 3, a character's name"]);
		return true;
	});
	assert.throws(() => S.loadSetup(johnSetup(d, { code_names: ["x"] }), { G }), /code_names: \{ <a name in the CODE>/);
	// a CODE set: Pri1 has none, left out: its name in the CODE stays
	const set = { name: "dir:x", kind: "dir", code: { dir: path.join(d, "code"), append: [] }, entries: {} };
	assert.deepEqual(S.loadSetup(johnSetup(d), { G, overrides: { code_set: set, missing: { Pri1: "exclude" } } }).code_names, { JohnRanger: "Ran1", JohnPriest: "JohnPriest" });
});

test("resolveSetup: the CODE read from disk mapped (slots renamed, the entry by the character's name); the setup's own text as written; the side file keeps it", () => {
	const d = johnCode(),
		{ resolved, bundles, warnings } = S.resolveSetup(S.loadSetup(johnSetup(d), { G }), { G, build: false });
	const ran = bundles.Ran1,
		pri = bundles.Pri1;
	// Ran1 has no code.entry: the slot named like it, the one renamed so (JohnRanger)
	assert.deepEqual([ran.entry, ran.slot, pri.entry, pri.slot], ["Ran1", "JohnRanger", "Pri1", "JohnPriest"]);
	assert.deepEqual(Object.keys(ran.files).sort(), ["JohnRanger_cfg", "Pri1", "Ran1", "core"]);
	assert.deepEqual(ran.files, pri.files, "one slot map for the account");
	assert.match(ran.files.core, /var party = \{ Ran1: \{ role: "dps" \}, Pri1: \{ role: "heal" \} \}; \/\/ JohnRanger leads\nvar list = "JohnRanger,JohnPriest";/);
	assert.match(ran.text, /var me = "Ran1"; var healer = "Pri1";/);
	assert.match(ran.text, /chronal\.lead = "Ran1";/, "an appended file is CODE read from disk: mapped");
	assert.match(ran.text, /var mine = "JohnRanger";/, "an extra is the setup's own: as written");
	assert.match(pri.text, /^var pre = "JohnPriest";/, "a prelude is the setup's own: as written");
	assert.match(pri.text, /load_code\("JohnRanger_cfg"\); var lead = "Ran1";/);
	assert.equal(resolved.characters[0].code.entry, "Ran1");
	assert.equal(resolved.source.characters.Ran1.entry, "JohnRanger", "the source names the slot on disk");
	assert.deepEqual(resolved.code_names, { JohnRanger: "Ran1", JohnPriest: "Pri1" });
	assert.deepEqual(warnings, ['code_names: 1 string may be meant as a mapped name, not mapped: core.js:2 "JohnRanger,JohnPriest" (holds JohnRanger)']);
	// the side file: its stored CODE as mapped; --current-code maps its source's again, the same bytes
	const live = tmp(),
		st = S.storeBundles(bundles, path.join(live, "code"));
	const side = { ...structuredClone(resolved), characters: resolved.characters.map((c) => ({ ...c, code: { ...c.code, ...st[c.name] } })) };
	fs.writeFileSync(path.join(live, "x.setup.json"), JSON.stringify(side));
	const again = S.resolveSetup(S.loadSetup(path.join(live, "x.setup.json")), { build: false });
	assert.equal(again.bundles.Ran1.text, ran.text);
	assert.deepEqual(again.resolved.code_names, resolved.code_names);
	const cur = S.resolveSetup(S.loadSetup(path.join(live, "x.setup.json")), { build: false, currentCode: true });
	assert.deepEqual([cur.bundles.Ran1.text, cur.bundles.Pri1.text, cur.bundles.Ran1.files], [ran.text, pri.text, ran.files]);
	assert.deepEqual(cur.warnings, warnings);
});

test("resolveSetup: what code_names can't do is warned of or refused", () => {
	const d = johnCode();
	write(d, "code/Ran1.js", "var clash = 1;\n");
	assert.throws(() => S.resolveSetup(S.loadSetup(johnSetup(d, { characters: [{ name: "Ran1", class: "ranger", code: { entry: "core" } }, { name: "Pri1", class: "priest", code: { entry: "core" } }] }), { G }), { G, build: false }), (e) => {
		assert.match(e.problems.join("\n"), /code_names: the slots (JohnRanger and Ran1|Ran1 and JohnRanger) of .* would both be named Ran1 \(the game finds slots by name, whatever the case\)/);
		return true;
	});
	fs.rmSync(path.join(d, "code/Ran1.js"));
	const s = johnSetup(d, {
		characters: [{ name: "Ran1", class: "ranger" }, { name: "Pri1", class: "priest", code: { entry: "JohnPriest" } }, { name: "JohnMage", class: "priest", code: { entry: "core" } }],
		code_names: { JohnRanger: "Ran1", JohnPriest: "Pri1", JohnPal: "Pri1", JohnMage: "Ran1" },
	});
	const { warnings } = S.resolveSetup(S.loadSetup(s, { G }), { G, build: false });
	assert.deepEqual(warnings.filter((w) => !/may be meant/.test(w)), [
		"code_names: JohnPal -> Pri1: no JohnPal in the CODE, nothing mapped",
		"code_names: JohnMage -> Ran1: no JohnMage in the CODE, nothing mapped",
		"code_names: JohnRanger and JohnMage of the CODE all become Ran1",
		"code_names: JohnPriest and JohnPal of the CODE all become Pri1",
		"code_names: JohnMage is a character of the run, and the CODE's JohnMage becomes Ran1",
	]);
	// a file acorn can't read: its names stay
	write(d, "code/core.js", 'var party = ["JohnRanger", (;\n');
	const w = S.resolveSetup(S.loadSetup(johnSetup(d), { G }), { G, build: false }).warnings;
	assert.ok(w.includes("code_names: core.js: line 1: Unexpected token: not read, its names are not mapped"), w.join("\n"));
	// the default entry's slot missing: named, with where it would come from
	assert.throws(() => S.resolveSetup(S.loadSetup(johnSetup(d, { code_names: { JohnPriest: "Pri1" } }), { G }), { G, build: false }), /Ran1: no slot Ran1 in .*code \(the default entry is the slot named like the character, or the one code_names renames so: set code.entry or code.file\)/);
});

test("namesOf: the CODE's known names by class, a slot's name to who runs it, the chosen, the suggested; settle with missing CODE", () => {
	const d = johnCode();
	write(d, "code/core.js", 'var party = { JohnRanger: 1, JohnPriest: 1, JohnMerch: 1 }; send_cm("Friend1", {});\n');
	const known = new Map([["JohnRanger", { class: "ranger", of: "public page John" }], ["JohnPriest", { class: "priest", of: "public page John" }], ["JohnMerch", { class: "merchant", of: "public page John" }], ["Other", { class: "ranger", of: "pull Me" }]]);
	const setup = () => ({
		format: "chronal-setup/1", name: "x", defaults: { code: { dir: path.join(d, "code"), append: [] } },
		characters: [{ name: "Ran1", class: "ranger" }, { name: "Ran2", class: "ranger" }, { name: "Pri1", class: "priest" }],
	});
	const nm = K.namesOf(setup(), { known, build: null });
	assert.deepEqual(nm.map, { JohnRanger: "Ran1", JohnPriest: "Pri1", JohnMerch: "JohnMerch" });
	assert.deepEqual(nm.names.map((x) => [x.name, x.to, x.why, x.count]), [
		["JohnRanger", "Ran1", "by class", 3], ["JohnPriest", "Pri1", "by class", 2], ["JohnMerch", "JohnMerch", "no other merchant in the run", 1], ["Friend1", "Friend1", "found in send_cm()", 0],
	]);
	assert.deepEqual(nm.flags, []);
	// Ran2 runs John's ranger slot: it is JohnRanger; chosen: JohnPriest stays, Friend1 is Ran1
	const s2 = setup();
	s2.characters[1].code = { entry: "JohnRanger" };
	assert.deepEqual(K.namesOf(s2, { known, build: null }).map, { JohnRanger: "Ran2", JohnPriest: "Pri1", JohnMerch: "JohnMerch" });
	// (Ran1 taken: John's ranger is the next ranger)
	assert.deepEqual(K.namesOf(setup(), { known, given: { JohnPriest: "JohnPriest", Friend1: "Ran1" }, build: null }).map, { JohnPriest: "JohnPriest", Friend1: "Ran1", JohnRanger: "Ran2", JohnMerch: "JohnMerch" });
	// a name of the run stays itself; the CODE naming a character keeps it from being another's by class
	const s3 = setup();
	s3.characters[0].name = "JohnRanger";
	assert.deepEqual(K.namesOf(s3, { known, build: null }).map, { JohnPriest: "Pri1", JohnMerch: "JohnMerch" });
	// settle: the renamed slots are entries; Pri1's slot (JohnPriest) and Ran2's (none: JohnRanger is Ran1's) chosen
	const s4 = setup();
	const st = K.settle(s4, { known, choices: { Ran2: "slot:core" }, build: null });
	assert.deepEqual(st.open, [], "Ran1 and Pri1 run their CODE names' slots; Ran2 the one chosen");
	assert.deepEqual(st.applied.map((m) => [m.name, m.choice]), [["Ran2", "slot:core"]]);
	assert.deepEqual(s4.code_names, { JohnRanger: "Ran1", JohnPriest: "Pri1", JohnMerch: "JohnMerch" });
	assert.deepEqual(s4.characters.map((c) => K.entrySlot(s4, c)), ["JohnRanger", "core", "JohnPriest"]);
	const s5 = setup();
	const open = K.settle(s5, { known, given: false, build: null });
	assert.deepEqual([open.names, "code_names" in s5, open.open.map((m) => m.name)], [null, false, ["Ran1", "Ran2", "Pri1"]]);
	assert.deepEqual(K.settle(setup(), { known, choices: { Ran2: "slot:nope" }, build: null }).bad, ["Ran2: no slot nope in its CODE"]);
});

test("storageKeys: get/set keys, localStorage's (getItem, setItem, removeItem, members), a key built as it runs apart; a CODE's own get or set isn't the game's", () => {
	const r = N.storageKeys(`var m = get("mode") || "farm"; set("last", 1); if (get(character.name + "_t")) {}
var r = localStorage.getItem("raw"); localStorage.setItem("w", "1"); var q = window.localStorage["q"]; parent.localStorage.z = 2;
var y = localStorage.foo, l = localStorage.length; delete localStorage.old; localStorage.removeItem("rm"); get(\`tpl\`); get("mode");`);
	assert.deepEqual(r, {
		get: { mode: 2, tpl: 1 }, set: { last: 1 }, local: { raw: 1, q: 1, foo: 1 }, local_set: { w: 1, z: 1, old: 1, rm: 1 },
		dynamic: [{ line: 1, text: 'get(character.name + "_t")', kind: "get" }], error: null,
	});
	assert.deepEqual(N.storageKeys('function get(o, k) { return o[k]; } get(a, "x"); set("y", 1);'), { get: {}, set: { y: 1 }, local: {}, local_set: {}, dynamic: [], error: null });
	assert.deepEqual(N.storageKeys("var a = 1;"), { get: {}, set: {}, local: {}, local_set: {}, dynamic: [], error: null });
	assert.equal(N.storageKeys('get("a"').error, "line 1: Unexpected token");
});
