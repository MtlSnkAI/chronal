"use strict";
// CODE at a git revision (git_tree.js): a throwaway repo with a build step, its trees extracted and built; setups with
// code.git (checked at the commit, pinned in the source, rerun with --current-code), CODE sets' git and <set>@<rev>,
// and chronal new sweeping revisions.
//   node --test test/git_tree.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { execFileSync } = require("node:child_process");
const GIT = require("../lib/git_tree");
const S = require("../lib/setup");
const C = require("../lib/code_sets");
const K = require("../lib/compose");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "git-test-"))), dirs[dirs.length - 1]);
const trees = [];
const libWas = process.env.CHRONAL_LIBRARY_DIR;
process.env.CHRONAL_LIBRARY_DIR = tmp(); // (an empty CODE library: none of this machine's sets)
test.after(() => {
	for (const d of [...dirs, ...trees]) fs.rmSync(d, { recursive: true, force: true });
	if (libWas === undefined) delete process.env.CHRONAL_LIBRARY_DIR;
	else process.env.CHRONAL_LIBRARY_DIR = libWas;
});
const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const G = { classes: { ranger: { base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } } }, maps: { main: { spawns: [[5, 6, 0, 100]] } } };
const env = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_GLOBAL: "/dev/null" };

// a CODE repo: src/Ran.js built into dist/ by build.js (a comment with its version), an adapter; three commits, a
// branch "old" at the first, a tag v2 at the second, and an uncommitted change on top
function repo() {
	const d = tmp(),
		git = (...a) => execFileSync("git", ["-C", d, ...a], { env, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
	git("init", "-q", "-b", "main");
	write(d, ".gitignore", "dist/\n");
	write(d, "build.js", 'const fs = require("fs"); fs.mkdirSync(__dirname + "/dist", { recursive: true }); for (const f of fs.readdirSync(__dirname + "/src")) fs.writeFileSync(__dirname + "/dist/" + f, "// built\\n" + fs.readFileSync(__dirname + "/src/" + f, "utf8"));\n');
	write(d, "adapter.js", "// adapter v1\n");
	const commit = (text, msg) => (write(d, "src/Ran.js", text), git("add", "-A"), git("commit", "-q", "-m", msg), git("rev-parse", "HEAD"));
	const c1 = commit("// Ran v1\n", "v1");
	git("branch", "old");
	write(d, "adapter.js", "// adapter v2\n");
	const c2 = commit("// Ran v2\n", "v2");
	git("tag", "v2");
	write(d, "src/core.js", "// core\n");
	const c3 = commit("// Ran v3\n", "v3");
	write(d, "src/Ran.js", "// Ran dirty\n");
	return { d, c1, c2, c3 };
}
const treeOf = (g) => {
	const t = GIT.treeOf(g);
	trees.push(path.dirname(t));
	return t;
};

test("git_tree: repo, commits, what exists at a commit, its tree extracted once, a spec's paths moved into it", () => {
	const { d, c1, c2, c3 } = repo();
	assert.equal(GIT.repoOf(path.join(d, "dist", "not", "there")), fs.realpathSync(d));
	const top = fs.realpathSync(d);
	assert.deepEqual(GIT.resolve({ repo: path.join(d, "src"), rev: "old" }), { repo: top, rev: "old", commit: c1 });
	assert.equal(GIT.commitOf(top, "v2"), c2);
	assert.equal(GIT.commitOf(top, "HEAD~1"), c2);
	assert.equal(GIT.commitOf(top, c3.slice(0, 8)), c3);
	assert.throws(() => GIT.commitOf(top, "nope"), /no commit "nope" in/);
	assert.throws(() => GIT.commitOf(top, "--help"), /no commit "--help"/);
	assert.throws(() => GIT.repoOf(os.tmpdir()), /is not in a git repository/);
	const g1 = { repo: top, rev: "old", commit: c1 };
	assert.equal(GIT.exists(g1, path.join(top, "src", "Ran.js")), true);
	assert.equal(GIT.exists(g1, path.join(top, "src", "core.js")), false); // only from v3 on
	assert.equal(GIT.exists(g1, path.join(top, "src")), true);
	assert.equal(GIT.exists(g1, "/etc/hostname-nope"), false);
	const t = treeOf(g1);
	assert.equal(fs.readFileSync(path.join(t, "src", "Ran.js"), "utf8"), "// Ran v1\n");
	assert.equal(fs.existsSync(path.join(t, ".git")), false);
	fs.writeFileSync(path.join(t, "marker"), "");
	assert.equal(GIT.treeOf(g1), t); // extracted once
	assert.ok(fs.existsSync(path.join(t, "marker")));
	const spec = GIT.inTree({ dir: path.join(top, "dist"), append: [path.join(top, "adapter.js"), "/elsewhere.js"], build: { cmd: ["node", "build.js"], cwd: top }, git: { repo: top, rev: "old" } });
	assert.deepEqual(spec, { dir: path.join(t, "dist"), file: undefined, append: [path.join(t, "adapter.js"), "/elsewhere.js"], build: { cmd: ["node", "build.js"], cwd: t }, git: { repo: top, rev: "old" }, tree: t });
	assert.equal(GIT.inTree({ dir: "/x", append: [] }).dir, "/x"); // no git: as it is
});

test("a setup with code.git: checked at the commit, built in its tree, pinned in the source; --current-code rebuilds that commit", () => {
	const { d, c1, c2 } = repo(),
		top = fs.realpathSync(d),
		s = tmp();
	const file = write(s, "setup.json", JSON.stringify({
		format: "chronal-setup/1",
		defaults: { code: { dir: path.join(d, "dist"), build: { cmd: ["node", "build.js"], cwd: d }, append: [path.join(d, "adapter.js")], git: { rev: "v2" } } },
		characters: [{ name: "Ran", class: "ranger" }],
	}));
	const setup = S.loadSetup(file, { G });
	assert.deepEqual(setup.characters[0].code.git, { repo: top, rev: "v2", commit: c2 });
	const { resolved, bundles } = S.resolveSetup(setup, { G });
	trees.push(path.dirname(GIT.treeOf({ repo: top, commit: c2 })));
	assert.match(bundles.Ran.text, /^\/\/ built\n\/\/ Ran v2\n/);
	assert.match(bundles.Ran.text, /\/\/ adapter v2/);
	assert.equal(fs.readFileSync(path.join(d, "src", "Ran.js"), "utf8"), "// Ran dirty\n"); // the work tree untouched
	assert.equal(fs.existsSync(path.join(d, "dist")), false);
	const src = resolved.source.characters.Ran;
	assert.deepEqual([src.code_git, src.git, src.code_dir], [c2.slice(0, 7), { repo: top, rev: "v2", commit: c2 }, path.join(d, "dist")]);
	// the side file, rerun with the CODE its source gives now: the same commit, even with a tag moved
	const side = write(s, "run--1.setup.json", JSON.stringify(resolved));
	execFileSync("git", ["-C", d, "tag", "-f", "v2", c1], { env, stdio: "ignore" });
	const again = S.resolveSetup(S.loadSetup(side, { G }), { currentCode: true, G });
	assert.equal(again.resolved.characters[0].code.hash, resolved.characters[0].code.hash);
	// problems at the commit: a file the commit lacks, a revision there isn't, no repo
	const bad = (code) => {
		try {
			S.loadSetup(write(s, "bad.json", JSON.stringify({ format: "chronal-setup/1", characters: [{ name: "Ran", class: "ranger", code }] })), { G });
		} catch (e) {
			return e.problems;
		}
		return [];
	};
	assert.deepEqual(bad({ file: path.join(d, "src", "core.js"), git: { rev: "old" } }), [`characters[0] (Ran).code.file: no such file ${path.join(d, "src", "core.js")} at old (${c1.slice(0, 7)})`]);
	assert.deepEqual(bad({ file: path.join(d, "src", "Ran.js"), git: { rev: "nope" } }), [`characters[0] (Ran).code.git: no commit "nope" in ${top}`]);
	assert.deepEqual(bad({ file: path.join(d, "src", "Ran.js"), git: { rev: "old", colour: 1 } }), ["characters[0] (Ran).code.git.colour: unknown key (known: repo, rev)"]);
	assert.match(bad({ file: path.join(d, "src", "Ran.js"), git: "old" })[0], /code\.git: \{ repo, rev \}/);
});

test("CODE sets: git in the sets file, <set>@<rev> for any but a pull, pinned to the commit; the slots at that commit", () => {
	const { d, c1, c2, c3 } = repo(),
		top = fs.realpathSync(d),
		s = tmp();
	const file = write(s, "sets.json", JSON.stringify({
		format: "chronal-code-sets/1",
		sets: {
			local: { dir: path.join(d, "dist"), build: { cmd: ["node", "build.js"], cwd: d } },
			old: { dir: path.join(d, "dist"), build: { cmd: ["node", "build.js"], cwd: d }, git: "old" },
			bad: { dir: path.join(d, "dist"), git: { rev: "nope" } },
		},
	}));
	const o = { file, pullsDir: tmp() };
	const { sets, problems } = C.loadCodeSets(o);
	assert.deepEqual(sets.map((x) => x.name), ["local", "old", "example"]);
	assert.deepEqual(problems, [`code set bad: git: no commit "nope" in ${top}`]);
	const old = sets[1];
	assert.deepEqual([old.code.git, old.git], [{ repo: top, rev: c1 }, { rev: "old", commit: c1 }]);
	const v2 = C.codeSet("local@v2", o);
	assert.deepEqual([v2.name, v2.code.git, v2.git], ["local@v2", { repo: top, rev: c2 }, { rev: "v2", commit: c2 }]);
	assert.equal(C.codeSet("old@main", o).code.git.rev, c3); // another revision of a git set
	// the slots at the commit (built there): core.js only from v3 on
	const built = (set) => C.missingEntries(set, ["Ran", "core"], { build: S.runBuild });
	assert.deepEqual(built(v2), [{ name: "core", entry: "core", slots: ["Ran"] }]);
	assert.deepEqual(built(C.codeSet("local@main", o)), []);
	for (const c of [c1, c2, c3]) trees.push(path.dirname(GIT.treeOf({ repo: top, commit: c })));
	assert.throws(() => C.codeSet("local@nope", o), /--code-set local@nope: no commit "nope"/);
	assert.throws(() => C.codeSet("nope@v2", o), /--code-set nope@v2: no such set/);
	// a setup taking a revision: that commit's CODE, the set in its source
	const setup = write(s, "setup.json", JSON.stringify({ format: "chronal-setup/1", defaults: { code: { file: path.join(d, "build.js") } }, characters: [{ name: "Ran", class: "ranger" }] }));
	const loaded = S.loadSetup(setup, { G, overrides: { code_set: v2 } });
	assert.deepEqual(loaded.code_set, { name: "local@v2", kind: "dir", git: { rev: "v2", commit: c2 } });
	assert.match(S.resolveSetup(loaded, { G }).bundles.Ran.text, /\/\/ Ran v2/);
});

test("chronal new: a sweep over revisions pins each (rev = the commit), and it finds a character without an entry at one", () => {
	const { d, c1, c2 } = repo(),
		top = fs.realpathSync(d),
		s = tmp(),
		file = write(s, "sets.json", JSON.stringify({ format: "chronal-code-sets/1", sets: { local: { dir: path.join(d, "dist"), build: { cmd: ["node", "build.js"], cwd: d } } } }));
	const o = { G, pullsDir: tmp(), codeSets: file };
	const { variants } = K.compose({ char: ["Ran:ranger:40", "core:ranger"], sweep_code_set: "local,local@old,local@v2" }, o);
	assert.deepEqual(variants.map((v) => [v.code_set, v.setup.defaults.code.git || null]), [["local", null], ["local@old", { repo: top, rev: c1 }], ["local@v2", { repo: top, rev: c2 }]]);
	assert.match(variants[1].setup.notes, new RegExp(`CODE: local@old \\(${c1.slice(0, 7)}\\)`));
	// core.js is in the work tree (committed at v3), not at old or v2
	assert.deepEqual(variants.map((v) => K.lackingOf(v.setup).map((m) => m.name)), [[], ["core"], ["core"]]);
	trees.push(path.dirname(GIT.treeOf({ repo: top, commit: c1 })));
	// written: the repo path relative or absolute as any path; loads back pinned
	const out = path.join(s, "w.json");
	K.writeSetups([{ file: out, setup: variants[2].setup }]);
	const back = S.loadSetup(out, { G });
	assert.deepEqual(back.characters[0].code.git, { repo: top, rev: c2, commit: c2 });
});
