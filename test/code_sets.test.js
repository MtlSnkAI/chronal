"use strict";
// code_sets.js: the sets file (pull, dir + build, file; entries, append; problems), the sets every pull gives,
// dir:/file: sets, codeFor, and a setup taking a set (loadSetup overrides.code_set: CODE replaced, extra kept, recorded
// in the resolved setup's source; refused for a side file).
//   node --test test/code_sets.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const C = require("../lib/code_sets");
const S = require("../lib/setup");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "codesets-test-"))), dirs[dirs.length - 1]);
const libWas = process.env.CHRONAL_LIBRARY_DIR;
process.env.CHRONAL_LIBRARY_DIR = tmp(); // (an empty CODE library: none of this machine's sets)
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	if (libWas === undefined) delete process.env.CHRONAL_LIBRARY_DIR;
	else process.env.CHRONAL_LIBRARY_DIR = libWas;
});
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const G = { classes: { ranger: { base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } }, priest: { base_slots: {} } }, maps: { main: { spawns: [[5, 6, 0, 100]] } } };

// a pulls dir with two pulls of "acc" (chronal pull's layout: pull.json + code/)
function pulls() {
	const root = tmp();
	for (const [time, text] of [["2026-09-26T10-00-00Z", "// old Ran\n"], ["2026-09-27T10-00-00Z", "// new Ran\n"]]) {
		const d = path.join(root, "acc", time);
		write(d, "code/Ran.js", text);
		write(d, "code/core.js", "var core = 1;\n");
		write(d, "pull.json", JSON.stringify({ format: "chronal-pull/1", pulled_at: time.replace(/T(\d\d)-(\d\d)-(\d\d)Z/, "T$1:$2:$3.000Z"), account: "acc", characters: [], code: { dir: "code", slots: 2, characters: ["Ran"] } }));
	}
	return root;
}

test("loadCodeSets: the file's sets (pull, dir + build, file) and one per pull; problems listed", () => {
	const root = pulls(),
		d = tmp();
	write(d, "dist/Ran.js", "// local Ran\n");
	write(d, "adapter.js", "// adapter\n");
	write(d, "farm.js", "// farm\n");
	const file = write(d, "sets/code-sets.json", JSON.stringify({
		format: "chronal-code-sets/1",
		sets: {
			live: { note: "live", pull: "acc", append: ["../adapter.js"], entries: { Pri: "Ran" } },
			old: { pull: "acc/2026-09-26T10-00-00Z" },
			local: { dir: "../dist", build: { cmd: ["node", "build.js"], cwd: ".." }, append: ["../adapter.js"] },
			farm: { file: "../farm.js", prelude: "var x = 1;" },
			bad: { dir: "../dist", pull: "acc" },
			none: {},
			gone: { pull: "other" },
			odd: { dir: "../dist", colour: 1 },
		},
	}));
	const { sets, problems } = C.loadCodeSets({ file, pullsDir: root }),
		by = Object.fromEntries(sets.map((s) => [s.name, s]));
	assert.deepEqual(sets.map((s) => s.name), ["live", "old", "local", "farm", "example", "pull:latest", "pull:acc", "pull:acc/2026-09-26T10-00-00Z", "pull:acc/2026-09-27T10-00-00Z"]);
	assert.deepEqual(by.live, {
		name: "live", kind: "pull", note: "live", code: { dir: path.join(root, "acc", "2026-09-27T10-00-00Z", "code"), append: [path.join(d, "adapter.js")] }, entries: { Pri: "Ran" }, classes: {},
		pull: { dir: path.join(root, "acc", "2026-09-27T10-00-00Z"), account: "acc", pulled_at: "2026-09-27T10:00:00.000Z", characters: ["Ran"] }, git: null,
	});
	assert.equal(by.old.code.dir, path.join(root, "acc", "2026-09-26T10-00-00Z", "code"));
	assert.deepEqual(by.local.code, { dir: path.join(d, "dist"), append: [path.join(d, "adapter.js")], build: { cmd: ["node", "build.js"], cwd: d } });
	assert.deepEqual([by.farm.kind, by.farm.code], ["file", { file: path.join(d, "farm.js"), prelude: "var x = 1;", append: [] }]);
	assert.equal(by["pull:latest"].code.dir, path.join(root, "acc", "2026-09-27T10-00-00Z", "code"));
	assert.deepEqual(problems, [
		"code set bad: pull and dir: a pull's CODE is its own dir",
		"code set none: no CODE: pull, dir or file",
		`code set gone: pull "other": no such pull in ${root} (chronal pull)`,
		"code set odd: colour: unknown key (known: note, pull, dir, recursive, entry, entries, classes, file, prelude, append, build, git, fit)",
	]);
	// no file, no pulls: the built-in set alone
	const bare = C.loadCodeSets({ file: null, pullsDir: tmp() });
	assert.deepEqual([bare.sets.map((x) => x.name), bare.problems, bare.file], [["example"], [], null]);
	assert.deepEqual(C.loadCodeSets({ file: path.join(d, "missing.json"), pullsDir: tmp() }).problems, [`${path.join(d, "missing.json")}: no such file`]);
});

test("codeSet: by name, dir:/file:; codeFor: the entry per character; slotNames", () => {
	const root = pulls(),
		d = tmp();
	write(d, "lib/a.js", "");
	write(d, "lib/sub/b.js", "");
	const live = C.codeSet("pull:acc", { file: null, pullsDir: root });
	assert.deepEqual(C.codeFor(live, "Ran"), { dir: live.code.dir, append: [], entry: "Ran" });
	assert.deepEqual(C.codeFor({ ...live, entries: { Pri: "Ran" } }, "Pri").entry, "Ran");
	assert.deepEqual(C.codeFor({ ...live, code: { ...live.code, entry: "core" } }, "Pri").entry, "core");
	assert.deepEqual(C.slotNames(live), ["Ran", "core"]);
	const dir = C.codeSet(`dir:${path.join(d, "lib")}`);
	assert.deepEqual([dir.kind, dir.code], ["dir", { dir: path.join(d, "lib"), append: [] }]);
	assert.deepEqual(C.slotNames(dir), ["a"]);
	assert.deepEqual(C.slotNames({ ...dir, code: { ...dir.code, recursive: true } }), ["a", "b"]);
	const file = C.codeSet(`file:${path.join(d, "lib", "a.js")}`);
	assert.deepEqual(C.codeFor(file, "Ran"), { file: path.join(d, "lib", "a.js"), append: [] });
	assert.equal(C.slotNames(file), null);
	assert.throws(() => C.codeSet(`dir:${path.join(d, "nope")}`), /no such directory/);
	assert.throws(() => C.codeSet("nope", { file: null, pullsDir: root }), /--code-set nope: no such set\. Known: example, pull:latest, pull:acc, .*; or dir:<path>, file:<path>/);
});

test("a setup takes a CODE set: every character's code replaced, extra and params kept, the set in the resolved source", () => {
	const root = pulls(),
		d = tmp();
	write(d, "own/Ran.js", "// own Ran\n");
	write(d, "own/Pri.js", "// own Pri\n");
	write(d, "adapter.js", "// adapter\n");
	const file = write(d, "setup.json", JSON.stringify({
		format: "chronal-setup/1",
		defaults: { code: { dir: "own", append: ["adapter.js"] } },
		characters: [{ name: "Ran", class: "ranger", extra: ["var x = 1;"], params: { farm: { monsters: ["goo"] } } }, { name: "Pri", class: "priest", code: { entry: "Pri" } }],
	}));
	const set = { ...C.codeSet("pull:acc", { file: null, pullsDir: root }), entries: { Pri: "core" } };
	const s = S.loadSetup(file, { G, overrides: { code_set: set } });
	assert.deepEqual(s.characters.map((c) => [c.name, c.code.dir, c.code.entry, c.code.append]), [["Ran", set.code.dir, "Ran", []], ["Pri", set.code.dir, "core", []]]);
	assert.deepEqual(s.characters[0].extra, ["var x = 1;"]);
	assert.deepEqual(s.characters[0].params, { farm: { monsters: ["goo"] } });
	assert.deepEqual(s.code_set, { name: "pull:acc", kind: "pull", pull: set.pull.dir, pulled_at: "2026-09-27T10:00:00.000Z" });
	const { resolved, bundles } = S.resolveSetup(s, { build: false, G });
	assert.deepEqual(resolved.source.code_set, s.code_set);
	assert.match(bundles.Ran.text, /\/\/ new Ran/);
	assert.match(bundles.Ran.text, /var x = 1;/);
	assert.doesNotMatch(bundles.Ran.text, /adapter/);
	// without a set: the setup's own CODE, no code_set
	const own = S.loadSetup(file, { G });
	assert.equal(own.code_set, null);
	assert.equal(S.resolveSetup(own, { build: false, G }).resolved.source.code_set, undefined);
	// a side file takes it too, but never leaving a character out (chronal run <id>.setup.json --code-set)
	const side = write(d, "x.setup.json", JSON.stringify({ ...resolved, format: "chronal-setup/1" }));
	assert.equal(S.loadSetup(side, { G, overrides: { code_set: set } }).code_set.name, "pull:acc");
	assert.throws(() => S.loadSetup(side, { G, overrides: { code_set: set, missing: { Ran: "exclude" } } }), (e) => e.problems.some((p) => /^missing\.Ran: exclude: not for a run's setup file/.test(p)));
});

test("missingEntries, parseMissing: the characters a set has no entry for; the choices", () => {
	const root = pulls(),
		set = C.codeSet("pull:acc", { file: null, pullsDir: root });
	assert.deepEqual(C.missingEntries(set, ["Ran", "Pri"]), [{ name: "Pri", entry: "Pri", slots: ["Ran", "core"] }]);
	assert.deepEqual(C.missingEntries({ ...set, entries: { Pri: "core" } }, ["Ran", "Pri"]), []);
	assert.deepEqual(C.missingEntries({ ...set, code: { file: "/x.js", append: [] } }, ["Pri"]), []);
	let built = 0;
	C.missingEntries({ ...set, code: { ...set.code, build: { cmd: ["true"], cwd: "/" } } }, ["Pri"], { build: () => built++ });
	assert.equal(built, 1);
	assert.deepEqual(C.parseMissing("A=idle, B=exclude,C=core,D=slot:idle,*=idle"), { A: "idle", B: "exclude", C: "slot:core", D: "slot:idle", "*": "idle" });
	assert.throws(() => C.parseMissing("A"), /--missing A: NAME=SLOT/);
});

test("a setup with missing entries: a slot of the set, idle (no CODE, extra, params), exclude (out of the run and party)", () => {
	const root = pulls(),
		d = tmp();
	const file = write(d, "setup.json", JSON.stringify({
		format: "chronal-setup/1",
		defaults: { code: { file: write(d, "farm.js", "// farm\n") } },
		characters: [
			{ name: "Ran", class: "ranger" },
			{ name: "Pri", class: "priest", extra: ["M.go();"], params: { farm: { monsters: ["goo"] } } },
			{ name: "Pri2", class: "priest" },
		],
		party: { members: ["Pri2", "Ran", "Pri"], leader: "Pri2", form: "harness" },
	}));
	const set = C.codeSet("pull:acc", { file: null, pullsDir: root });
	const s = S.loadSetup(file, { G, overrides: { code_set: set, missing: { Pri: "idle", Pri2: "exclude" } } });
	assert.deepEqual(s.characters.map((c) => c.name), ["Ran", "Pri"]);
	assert.deepEqual(s.characters[1].code, { dir: null, recursive: false, entry: null, file: C.IDLE, prelude: null, append: [], build: null });
	assert.deepEqual([s.characters[1].extra, s.characters[1].params], [[], null]);
	assert.deepEqual(s.party, { members: ["Ran", "Pri"], leader: "Ran", form: "harness" });
	assert.deepEqual(s.code_set.missing, { Pri: "idle", Pri2: "exclude" });
	const { bundles } = S.resolveSetup(s, { build: false, G });
	assert.match(bundles.Pri.text, /^\/\/ No CODE: the character stands idle/);
	assert.doesNotMatch(bundles.Pri.text, /M\.go/);
	// another slot of the set; every party member excluded: no party
	const t = S.loadSetup(file, { G, overrides: { code_set: set, missing: { Pri: "slot:core", Pri2: "exclude" } } });
	assert.equal(t.characters[1].code.entry, "core");
	assert.deepEqual(t.characters[1].extra, ["M.go();"]);
	const only = write(d, "only.json", JSON.stringify({ format: "chronal-setup/1", defaults: { code: { file: path.join(d, "farm.js") } }, characters: [{ name: "Ran", class: "ranger" }, { name: "Pri", class: "priest" }], party: { members: ["Pri"] } }));
	assert.equal(S.loadSetup(only, { G, overrides: { code_set: set, missing: { Pri: "exclude" } } }).party, null);
	// problems
	const bad = (o) => {
		try {
			S.loadSetup(file, { G, overrides: o });
		} catch (e) {
			return e.problems;
		}
		return [];
	};
	assert.deepEqual(bad({ missing: { Pri: "idle" } }), ["missing: only with a CODE set (code_set)"]);
	assert.deepEqual(bad({ code_set: set, missing: { Nope: "idle", Pri: "later", Pri2: "exclude" } }).filter((p) => p.startsWith("missing")), ["missing.Nope: no such character", 'missing.Pri: "later" ("slot:<slot>", "idle" or "exclude")']);
});

test("chronal run --code-set --check: the characters without an entry listed (missing), --missing chooses", () => {
	const { execFileSync } = require("node:child_process"),
		d = tmp();
	write(d, "lib/Ran.js", "// Ran\n");
	write(d, "lib/core.js", "// core\n");
	const file = write(d, "setup.json", JSON.stringify({ format: "chronal-setup/1", defaults: { code: { dir: "lib" } }, characters: [{ name: "Ran", class: "ranger" }, { name: "Pri", class: "priest", code: { entry: "Ran" } }] }));
	const check = (...a) => {
		try {
			return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", file, "--check", "--code-set", `dir:${path.join(d, "lib")}`, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
		} catch (e) {
			return JSON.parse(e.stdout);
		}
	};
	const none = check();
	assert.equal(none.ok, false);
	assert.deepEqual(none.missing, [{ name: "Pri", entry: "Pri", slots: ["Ran", "core"] }]);
	assert.match(none.problems[0], /^Pri: the CODE set dir:.* has no slot Pri: choose with --missing Pri=<slot>\|idle\|exclude \(its slots: Ran, core\)/);
	const idle = check("--missing", "Pri=idle");
	assert.equal(idle.ok, true);
	assert.deepEqual(idle.code_set.missing, { Pri: "idle" });
	assert.deepEqual(idle.characters.map((c) => [c.name, c.entry]), [["Ran", "Ran"], ["Pri", "idle.js"]]);
	assert.deepEqual(check("--missing", "*=core").characters.map((c) => c.entry), ["Ran", "core"]);
	assert.deepEqual(check("--missing", "*=exclude").characters.map((c) => c.name), ["Ran"]);
	assert.deepEqual(check("--missing", "Pri=nope").problems, [`--missing Pri: no slot nope in dir:${path.join(d, "lib")}`]);
	assert.deepEqual(check("--missing", "Ran=idle,Pri=idle").problems, ["--missing Ran: its CODE has its entry"]);
});

test("chronal run <a run's setup file> --code-set: its characters as they were, their CODE from the set; idle, a slot; never exclude", () => {
	const { execFileSync } = require("node:child_process"),
		S = require("../lib/setup"),
		d = tmp();
	write(d, "v1/Ran.js", "// Ran v1\n");
	write(d, "v2/Ran.js", "// Ran v2\n");
	write(d, "v2/core.js", "// core\n");
	const file = write(d, "setup.json", JSON.stringify({ format: "chronal-setup/1", defaults: { code: { dir: "v1" } }, characters: [{ name: "Ran", class: "ranger" }, { name: "Pri", class: "priest", code: { entry: "Ran" } }] }));
	// the side file and CODE store a run writes (lib/setup.js resolveSetup, storeBundles)
	const { resolved, bundles } = S.resolveSetup(S.loadSetup(file), { build: false });
	S.storeBundles(bundles, path.join(d, "live", "code"));
	const side = write(d, "live/r--1.setup.json", JSON.stringify(resolved));
	const check = (...a) => {
		try {
			return JSON.parse(execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", side, "--check", "--no-live", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
		} catch (e) {
			return JSON.parse(e.stdout);
		}
	};
	const stored = check();
	assert.equal(stored.ok, true);
	assert.equal(stored.code_hash_stored, undefined);
	const v2 = check("--code-set", `dir:${path.join(d, "v2")}`, "--missing", "Pri=core");
	assert.equal(v2.ok, true, JSON.stringify(v2.problems));
	assert.deepEqual(v2.characters.map((c) => [c.name, c.entry, c.code_hash !== c.code_hash_stored]), [["Ran", "Ran", true], ["Pri", "core", true]]);
	assert.equal(v2.code_hash_stored, stored.code_hash);
	assert.deepEqual(check("--code-set", `dir:${path.join(d, "v2")}`, "--missing", "Pri=idle").characters.map((c) => c.entry), ["Ran", "idle.js"]);
	// a set at a git revision (a library version, <set>@<rev>)
	const g = (...x) => execFileSync("git", ["-C", path.join(d, "v2"), "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...x], { stdio: "ignore" });
	g("init", "--quiet"), g("add", "--all"), g("commit", "--quiet", "-m", "v2");
	const atRev = check("--code-set", `dir:${path.join(d, "v2")}@HEAD`, "--missing", "Pri=core");
	assert.equal(atRev.ok, true, JSON.stringify(atRev.problems));
	assert.deepEqual(atRev.characters.map((c) => c.code_hash), v2.characters.map((c) => c.code_hash));
	assert.match(check("--code-set", `dir:${path.join(d, "v2")}`, "--missing", "Pri=exclude").problems.join(), /exclude: not for a run's setup file/);
	assert.throws(() => execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", side, "--check", "--code-set", `dir:${path.join(d, "v2")}`, "--current-code"], { stdio: ["ignore", "pipe", "pipe"] }), (e) => /--current-code or --code-set, not both/.test(e.stderr));
});

test("the built-in set example (ChronAL's example bot): an entry by class (classes), a file's set of that name wins; classes in a sets file", () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "codesets-ex-"));
	try {
		const ex = C.codeSet("example", { file: null, pullsDir: root });
		assert.deepEqual([ex.builtin, ex.party_form, C.slotNames(ex)], [true, "harness", ["farm", "fighter", "merchant", "priest"]]);
		assert.deepEqual([["Ran1", "ranger"], ["Pri1", "priest"], ["Mer1", "merchant"], ["War1", "warrior"]].map(([n, c]) => C.codeFor(ex, n, c).entry), ["fighter", "priest", "merchant", "fighter"]);
		assert.deepEqual(C.missingEntries(ex, ["Ran1", "Pri1"], { classOf: (n) => ({ Ran1: "ranger", Pri1: "priest" })[n] }), []);
		// a sets file's: classes under entries, over the slot named after the character
		fs.mkdirSync(path.join(root, "mine"));
		for (const f of ["Ran1.js", "healer.js", "dps.js"]) fs.writeFileSync(path.join(root, "mine", f), "1;\n");
		const file = path.join(root, "sets.json");
		fs.writeFileSync(file, JSON.stringify({ format: C.FORMAT, sets: { mine: { dir: "mine", entries: { Ran1: "Ran1" }, classes: { priest: "healer", "*": "dps" } }, example: { dir: "mine" } } }));
		const mine = C.codeSet("mine", { file, pullsDir: root });
		assert.deepEqual([["Ran1", "ranger"], ["Pri1", "priest"], ["War1", "warrior"]].map(([n, c]) => C.codeFor(mine, n, c).entry), ["Ran1", "healer", "dps"]);
		assert.equal(C.codeSet("example", { file, pullsDir: root }).builtin, undefined); // the file's
		fs.writeFileSync(file, JSON.stringify({ format: C.FORMAT, sets: { bad: { dir: "mine", classes: { priest: 3 } } } }));
		assert.match(C.loadCodeSets({ file, pullsDir: root }).problems.join("\n"), /code set bad: classes: \{ <class> \| "\*": <slot> \}/);
	} finally {
		fs.rmSync(root, { recursive: true, force: true });
	}
});
