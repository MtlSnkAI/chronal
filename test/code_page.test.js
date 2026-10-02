"use strict";
// dashboard/code.js (the CODE page's server side): a set's files and what a save does: your folder written in place,
// ChronAL's example bot copied into the library (trusted: it was yours), the copy's next saves new versions (commits);
// a syntax problem saved only with force; a copy's name never another set's; the runs whose setup files used a set.
//   node --test test/code_page.test.js      (needs git)
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "code-page-test-")));
Object.assign(process.env, { CHRONAL_LIBRARY_DIR: path.join(TMP, "library"), CHRONAL_PULLS_DIR: path.join(TMP, "pulls"), CHRONAL_CODE_SETS: path.join(TMP, "no-sets.json") });
const K = require("../dashboard/code");
const LIB = require("../lib/library");
const q = (o) => new URLSearchParams(o);

test("your folder: listed, read, written in place; a syntax problem only with force", async () => {
	const d = path.join(TMP, "mine");
	fs.mkdirSync(path.join(d, "sub"), { recursive: true });
	fs.writeFileSync(path.join(d, "main.js"), "say(1);\n");
	fs.writeFileSync(path.join(d, "sub", "conf.json"), "{}\n");
	fs.writeFileSync(path.join(d, "notes.bin"), "x");
	const set = "dir:" + d;
	const [, f] = K.files(q({ set }));
	assert.equal(f.mode, "place");
	assert.deepEqual(f.files.map((x) => x.path), ["main.js", "sub/conf.json"]);
	assert.equal(K.read(q({ set, path: "main.js" }))[1].text, "say(1);\n");
	assert.equal(K.read(q({ set, path: "../outside.js" }))[0], 404);
	let [code, o] = await K.write({ set, path: "main.js", text: "say(;", action: "save" });
	assert.equal(code, 422);
	assert.match(o.problems[0].message, /Unexpected token/);
	assert.equal(fs.readFileSync(path.join(d, "main.js"), "utf8"), "say(1);\n");
	[code] = await K.write({ set, path: "main.js", text: "say(2);\n", action: "save" });
	assert.equal(code, 200);
	assert.equal(fs.readFileSync(path.join(d, "main.js"), "utf8"), "say(2);\n");
	[code, o] = await K.write({ set, path: "sub/conf.json", text: "{", action: "check" });
	assert.equal(o.problems.length, 1);
});

test("the example bot: a save makes your copy (trusted, copy_of example); the copy's saves are its versions; a taken name refused", async () => {
	assert.equal(K.files(q({ set: "example" }))[1].mode, "copy");
	let [code, o] = await K.write({ set: "example", path: "fighter.js", text: "// mine\n", action: "save" });
	assert.equal(code, 400, "a copy needs a name");
	[code, o] = await K.write({ set: "example", path: "fighter.js", text: "// mine\n", action: "save", name: "ex-mine" });
	assert.equal(code, 200, JSON.stringify(o));
	assert.deepEqual([o.saved.mode, o.saved.set, o.saved.trusted, o.saved.from], ["copy", "ex-mine", true, "example"]);
	const c1 = o.saved.commit;
	let [, f] = K.files(q({ set: "ex-mine" }));
	assert.deepEqual([f.mode, f.copy_of, f.commit, f.trusted], ["version", "example", c1, true]);
	assert.deepEqual(f.files.map((x) => x.path), ["farm.js", "fighter.js", "merchant.js", "priest.js"]);
	const C = require("../lib/code_sets"), copy = C.codeSet("ex-mine");
	assert.deepEqual(["Pri", "Mer", "Ran"].map((n, i) => C.codeFor(copy, n, ["priest", "merchant", "ranger"][i]).entry), ["priest", "merchant", "fighter"], "the copy keeps the example's entry per class");
	assert.equal(K.read(q({ set: "ex-mine", path: "fighter.js" }))[1].text, "// mine\n");
	[code, o] = await K.write({ set: "ex-mine", path: "farm.js", text: "// farm v2\n", action: "save" });
	assert.deepEqual([code, o.saved.mode, o.saved.set, o.saved.trusted], [200, "version", "ex-mine", true]);
	assert.notEqual(o.saved.commit, c1);
	assert.equal(K.read(q({ set: "ex-mine", path: "farm.js" }))[1].text, "// farm v2\n");
	assert.equal(K.read(q({ set: "ex-mine@" + c1.slice(0, 7), path: "farm.js" }))[1].text, fs.readFileSync(path.join(__dirname, "..", "codes", "example", "farm.js"), "utf8"), "the older version: <set>@<commit>");
	assert.equal(K.files(q({ set: "ex-mine@" + c1.slice(0, 7) }))[1].mode, "copy");
	[code, o] = await K.write({ set: "example", path: "fighter.js", text: "// again\n", action: "save", name: "ex-mine" });
	assert.equal(code, 409);
	assert.ok(LIB.trusted(c1));
});

test("the runs that used a set: their setup files' source names it or its folder", () => {
	const live = path.join(TMP, "live");
	fs.mkdirSync(live);
	const side = (id, source) => fs.writeFileSync(path.join(live, id + ".setup.json"), JSON.stringify({ format: "chronal-setup/1", resolved: {}, characters: [], source }));
	side("a--1", { characters: { Ran: { code_dir: path.join(__dirname, "..", "codes", "example") } } });
	side("b--2", { characters: { Ran: { code_dir: path.join(TMP, "elsewhere") } }, code_set: { name: "example" } });
	side("c--3", { characters: { Ran: { code_dir: path.join(TMP, "elsewhere") } } });
	assert.deepEqual(K.runs(q({ set: "example" }), live)[1].runs.sort(), ["a--1", "b--2"]);
});
