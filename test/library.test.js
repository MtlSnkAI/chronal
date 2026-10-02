"use strict";
// library.js (the CODE library): links and paths read (sourceOf); CODE added from a git repo (a local one by its file://
// link: its default branch; a folder at a branch, the longest ref; a file), a paste (a new version under its name),
// files (a folder's name taken off; paths checked) and a folder of this machine (read where it is); Update pins the
// newest commit of its branch; revisions; the scan; trust: setup.js refuses the library's CODE at a commit not trusted
// (and its build) and reads it once trusted, code_sets.js lists the library's sets (and <name>@<rev>), chronal run --check
// names it and --trust trusts it.
//   node --test test/library.test.js      (the chronal run test needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { execFileSync } = require("node:child_process");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "library-test-"))), dirs[dirs.length - 1]);
const libWas = process.env.CHRONAL_LIBRARY_DIR,
	LIBDIR = tmp();
process.env.CHRONAL_LIBRARY_DIR = LIBDIR;
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
	if (libWas === undefined) delete process.env.CHRONAL_LIBRARY_DIR;
	else process.env.CHRONAL_LIBRARY_DIR = libWas;
});
const L = require("../lib/library");
const C = require("../lib/code_sets");
const S = require("../lib/setup");
const GIT = require("../lib/git_tree");

const write = (dir, f, text) => (fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }), fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));
const git = (dir, ...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...a], { encoding: "utf8" }).trim();
const G = { classes: { ranger: { base_slots: { mainhand: { name: "bow", level: 0, gift: 1 } } } }, maps: { main: { spawns: [[5, 6, 0, 100]] } } };
const MAIN = `// someone's bot
var ws = new WebSocket("wss://dash.example.com/ws");
fetch("https://api.example.com/stats");
$.getJSON("https://api.example.com/x");
eval("1 + 1");
var fs = require("fs");
load_code("helper");
`;

// someone's repo (bot/main.js, bot/helper.js, lone.js, package.json; branches main and feature/x) and its bare clone,
// to fetch from by its file:// link
function remote() {
	const d = tmp(),
		src = path.join(d, "src"),
		bare = path.join(d, "remote.git");
	fs.mkdirSync(src);
	git(src, "init", "-q", "-b", "main");
	write(src, "bot/main.js", MAIN);
	write(src, "bot/helper.js", "function helper() { return 1; }\n");
	write(src, "lone.js", "say('lone');\n");
	write(src, "package.json", JSON.stringify({ scripts: { build: "tsc" }, devDependencies: { typescript: "5" } }));
	git(src, "add", "-A");
	git(src, "commit", "-qm", "one");
	git(src, "branch", "feature/x");
	execFileSync("git", ["clone", "-q", "--bare", src, bare]);
	// (a commit pushed later: Update's)
	const push = (f, text) => {
		write(src, f, text);
		git(src, "add", "-A");
		git(src, "commit", "-qm", "more");
		git(src, "push", "-q", bare, "main");
		return git(src, "rev-parse", "HEAD");
	};
	return { src, bare, url: "file://" + bare, commit: git(src, "rev-parse", "HEAD"), push };
}

test("sourceOf: GitHub repo, folder, file and raw links; gists and their raw links; GitLab-style; ssh; pastebin; paths; refused", () => {
	const o = (s) => {
		const { kind, url, at, ref, sub, file, repo } = L.sourceOf(s);
		return { kind, url, at, ref, sub, file, repo };
	};
	assert.deepEqual(o("https://github.com/o/r"), { kind: "github", url: "https://github.com/o/r.git", at: undefined, ref: undefined, sub: undefined, file: undefined, repo: "o-r" });
	assert.deepEqual(o("https://github.com/o/r.git/"), o("https://github.com/o/r"));
	assert.deepEqual([o("https://github.com/o/r/tree/feature/x/src").at, o("https://github.com/o/r/tree/feature/x/src").file], [["feature", "x", "src"], false]);
	assert.deepEqual([o("https://github.com/o/r/blob/main/a b.js").at, o("https://github.com/o/r/blob/main/a b.js").file], [["main", "a b.js"], true]);
	assert.equal(o("https://github.com/o/r/commit/abc1234").ref, "abc1234");
	assert.deepEqual(o("https://raw.githubusercontent.com/o/r/refs/heads/main/a.js").at, ["main", "a.js"]);
	assert.deepEqual(o("https://gist.github.com/u/0123456789abcdef0123"), { kind: "gist", url: "https://gist.github.com/0123456789abcdef0123.git", at: undefined, ref: undefined, sub: undefined, file: undefined, repo: "gist-0123456" });
	const c = "0123456789abcdef0123456789abcdef01234567";
	assert.deepEqual([o(`https://gist.githubusercontent.com/u/0123456789abcdef0123/raw/${c}/x.js`).ref, o(`https://gist.githubusercontent.com/u/0123456789abcdef0123/raw/${c}/x.js`).sub], [c, "x.js"]);
	assert.deepEqual([o("https://gist.githubusercontent.com/u/0123456789abcdef0123/raw/x.js").ref, o("https://gist.githubusercontent.com/u/0123456789abcdef0123/raw/x.js").sub], [undefined, "x.js"]);
	assert.deepEqual([o("https://gitlab.com/g/sub/r/-/tree/main/src").url, o("https://gitlab.com/g/sub/r/-/tree/main/src").at], ["https://gitlab.com/g/sub/r.git", ["main", "src"]]);
	assert.deepEqual([o("git@github.com:o/r.git").kind, o("git@github.com:o/r.git").repo], ["git", "r"]);
	assert.deepEqual([o("https://pastebin.com/AbC123").kind, o("https://pastebin.com/AbC123").url], ["url", "https://pastebin.com/raw/AbC123"]);
	assert.equal(o("https://example.com/bot.js").kind, "probe");
	assert.deepEqual(L.sourceOf("~/al/bot").path, path.join(os.homedir(), "al/bot"));
	for (const [s, re] of [["", /a link/], ["./rel", /a full path/], ["ftp://x/y", /an https link/], ["https://github.com/o", /a repository's link/], ["https://gist.github.com/u", /a gist's link/]]) assert.throws(() => L.sourceOf(s), re);
});

test("add: a repo by its link (its default branch, pinned), a folder at a branch (the longest ref), a file; names; a name twice refused", async () => {
	const rem = remote();
	let r = await L.add({ from: rem.url });
	assert.deepEqual([r.added, r.entry.name, r.commit], [true, "remote", rem.commit]);
	assert.deepEqual([r.entry.meta.kind, r.entry.meta.follow, r.entry.meta.sub, r.entry.meta.file, r.entry.meta.recursive], ["git", { ref: "main", kind: "branch" }, null, false, false]);
	assert.ok(!fs.existsSync(path.join(r.entry.repo, "lone.js"))); // cloned without a checkout: read at its commit
	r = await L.add({ from: { kind: "git", url: rem.url, web: rem.url, at: ["feature", "x", "bot"], repo: "remote" } });
	assert.deepEqual([r.entry.name, r.entry.meta.follow, r.entry.meta.sub, r.entry.meta.recursive], ["remote-bot", { ref: "feature/x", kind: "branch" }, "bot", false]);
	r = await L.add({ from: { kind: "git", url: rem.url, web: rem.url, at: ["main", "lone.js"], file: true, repo: "remote" } });
	assert.deepEqual([r.entry.name, r.entry.meta.sub, r.entry.meta.file], ["remote-lone", "lone.js", true]);
	r = await L.add({ from: { kind: "git", url: rem.url, web: rem.url, ref: rem.commit.slice(0, 7), repo: "remote" }, name: "pinned" });
	assert.deepEqual(r.entry.meta.follow, { ref: rem.commit, kind: "commit" });
	await assert.rejects(L.add({ from: rem.url, name: "remote" }), /in the library already/);
	await assert.rejects(L.add({ from: rem.url, name: "../x" }), /name: "..\/x"/);
	await assert.rejects(L.add({ from: rem.url, name: "farm", taken: ["farm"] }), /a CODE set named farm exists/);
	await assert.rejects(L.add({ from: { kind: "git", url: rem.url, web: rem.url, at: ["main", "nope"], repo: "remote" } }), /no nope at/);
	await assert.rejects(L.add({ from: { kind: "git", url: rem.url, web: rem.url, at: ["nobranch", "x"], repo: "remote" } }), /no branch, tag or commit nobranch/);
	await assert.rejects(L.add({ from: "file://" + path.join(tmp(), "none.git") }), /no such repository here, or a private one/);
	// nothing half-made left behind
	assert.deepEqual(fs.readdirSync(LIBDIR).filter((n) => n.startsWith(".")), []);
});

test("add: a paste (a new version under its name), files (a folder's name taken off; paths checked), a folder of this machine", async () => {
	let r = await L.add({ paste: { text: "say(1);\n" } });
	assert.deepEqual([r.added, r.entry.meta.kind, r.entry.meta.sub, r.entry.meta.file], [true, "paste", "main.js", true]);
	const name = r.entry.name,
		c1 = r.commit;
	r = await L.add({ paste: { text: "say(2);\n" }, name });
	assert.deepEqual([r.added, r.commit !== c1, r.entry.name], [false, true, name]);
	assert.equal(git(r.entry.repo, "rev-list", "--count", "HEAD"), "2");
	r = await L.add({ paste: { text: "say(2);\n" }, name });
	assert.equal(git(r.entry.repo, "rev-list", "--count", "HEAD"), "2"); // the same text: no new version
	await assert.rejects(L.add({ files: [{ path: "a.js", text: "1" }], name }), /in the library already/);
	await assert.rejects(L.add({ paste: { text: " " } }), /paste: its text/);
	r = await L.add({ files: [{ path: "theirs/a.js", text: "var a;\n" }, { path: "theirs/lib/b.js", text: "var b;\n" }] });
	assert.deepEqual([r.entry.name, r.entry.meta.kind, r.entry.meta.file, r.entry.meta.recursive], ["theirs", "upload", false, false]);
	assert.deepEqual(git(r.entry.repo, "ls-files").split("\n"), ["a.js", "lib/b.js"]);
	for (const bad of ["../x.js", "a/../../x.js", ".git/config", "a/.GIT/x", ""]) await assert.rejects(L.add({ files: [{ path: bad, text: "" }, { path: "ok.js", text: "" }] }), /is not a file's path/);
	await assert.rejects(L.add({ files: [{ path: "a.js", text: "" }, { path: "A.js", text: "" }] }), /twice/);
	// a folder of this machine: read where it is, no commit, no trust needed
	const d = tmp();
	write(d, "x/one.js", "var one;\n");
	r = await L.add({ from: path.join(d, "x") });
	assert.deepEqual([r.entry.meta.kind, r.entry.meta.path, r.commit, r.entry.repo], ["path", path.join(d, "x"), null, null]);
	assert.deepEqual(L.setDef(r.entry), { dir: path.join(d, "x") });
	assert.deepEqual(L.untrusted([["Ran", { dir: path.join(d, "x") }]]), []);
});

test("update: the newest commit of its branch pinned and counted; a link to a commit, a paste: nothing to fetch; revisions; remove", async () => {
	const rem = remote(),
		r = await L.add({ from: rem.url, name: "upd" });
	let u = await L.update("upd");
	assert.deepEqual([u.moved, u.commit, u.count], [false, rem.commit, 0]);
	const c2 = rem.push("bot/new.js", "var n;\n");
	u = await L.update("upd");
	assert.deepEqual([u.moved, u.was, u.commit, u.count], [true, rem.commit, c2, 1]);
	assert.equal(L.get("upd").meta.commit, c2);
	const p = await L.add({ from: { kind: "git", url: rem.url, web: rem.url, ref: rem.commit, repo: "remote" }, name: "fixed" });
	assert.match((await L.update("fixed")).why, /a link to a commit/);
	assert.equal(p.entry.meta.commit, rem.commit);
	assert.match((await L.update((await L.add({ paste: { text: "x;" } })).entry.name)).why, /a new version/);
	const rv = L.revisions("upd");
	assert.deepEqual([rv.branches.map((b) => b.name).sort(), rv.commits.map((c) => c.commit)], [["feature/x", "main"], [c2, rem.commit]]);
	assert.equal(L.revOf("upd", "feature/x"), rem.commit);
	assert.equal(L.remove("upd").name, "upd");
	assert.throws(() => L.get("upd"), /no CODE upd in the library/);
	assert.ok(!fs.existsSync(r.entry.dir));
});

test("scan: what a version reaches (network calls, servers, code it makes as it runs, Node's modules, a build step)", async () => {
	const rem = remote(),
		r = await L.add({ from: rem.url, name: "scanned" }),
		s = L.scanOf("scanned");
	assert.equal(s.commit, rem.commit);
	assert.deepEqual([s.files, s.js], [4, 3]);
	assert.deepEqual(s.network.map((x) => [x.what, x.n, x.at]), [["$.getJSON", 1, ["bot/main.js:4"]], ["WebSocket", 1, ["bot/main.js:2"]], ["fetch", 1, ["bot/main.js:3"]]]);
	assert.deepEqual(s.hosts, [{ host: "api.example.com", n: 2 }, { host: "dash.example.com", n: 1 }]);
	assert.deepEqual(s.code.map((x) => x.what), ["eval"]);
	assert.deepEqual(s.node.map((x) => x.what), ['require("fs")']);
	assert.deepEqual(s.build, ["package.json: scripts build, 1 dependency"]);
	assert.deepEqual(s.unread, []);
	const lines = L.scanLines(s).join("\n");
	assert.match(lines, /reaches other servers: \$\.getJSON \(bot\/main\.js:4\); WebSocket/);
	// a file's own, and one not parsed
	const t = tmp();
	write(t, "a.js", "var x = ;");
	assert.deepEqual([L.scan(t).unread.length, L.scan(t).network], [1, []]);
	assert.equal(r.entry.name, "scanned");
});

test("trust: setup.js refuses the library's CODE at a commit not trusted (and its build); trusted, it runs; code_sets lists the library's sets", async () => {
	const rem = remote(),
		r = await L.add({ from: { kind: "git", url: rem.url, web: rem.url, at: ["main", "bot"], repo: "remote" }, name: "bot" });
	// a CODE set like any other (its revisions too), with what the form shows of it
	const set = C.codeSet("bot");
	assert.deepEqual([set.kind, set.code.dir, set.code.git.rev, set.lib.kind, set.lib.trusted, set.lib.label], ["dir", path.join(r.entry.repo, "bot"), rem.commit, "git", false, rem.bare.replace(/\.git$/, "")]);
	const c2 = rem.push("bot/main.js", "say('v2');\n");
	await L.update("bot");
	assert.equal(C.codeSet("bot@" + rem.commit.slice(0, 7)).code.git.rev, rem.commit);
	assert.ok(C.loadCodeSets().sets.some((s) => s.name === "bot" && s.lib && s.lib.commit === c2));
	const setup = (code) => S.loadSetup({ format: S.FORMAT, name: "t", characters: [{ name: "Ran", class: "ranger", code }] }, { G });
	const at = { ...C.codeFor(C.codeSet("bot"), "Ran"), entry: "main" };
	assert.throws(() => S.resolveSetup(setup(at), { G }), /CODE bot at [0-9a-f]{7} \(file:.*\), for Ran: not trusted here yet/);
	// read off its repo, not at a commit: refused too
	assert.throws(() => S.resolveSetup(setup({ dir: path.join(r.entry.repo, "bot"), entry: "main" }), { G }), /CODE bot of the library is read at a commit|no such directory/);
	assert.deepEqual(L.untrusted([["Ran", { dir: path.join(r.entry.repo, "bot") }]]).map((u) => [u.name, u.commit]), [["bot", null]]);
	// its build: not run in an untrusted commit's tree
	const tree = GIT.treeOf({ repo: GIT.repoOf(r.entry.repo), commit: c2 });
	assert.throws(() => S.runBuild({ cmd: ["node", "-e", "0"], cwd: tree }), /the build of CODE bot at [0-9a-f]{7}: not run/);
	assert.throws(() => S.runBuild({ cmd: ["node", "-e", "0"], cwd: r.entry.repo }), /runs in its commit's tree/);
	L.trust(c2, { name: "bot", by: "test" });
	assert.equal(L.trusted(c2), true);
	assert.equal(C.codeSet("bot").lib.trusted, true);
	const { bundles } = S.resolveSetup(setup(at), { G });
	assert.match(bundles.Ran.text, /say\('v2'\)/);
	assert.deepEqual(Object.keys(bundles.Ran.files).sort(), ["helper", "main"]);
	S.runBuild({ cmd: ["node", "-e", "0"], cwd: tree });
	// the earlier commit is still not trusted
	assert.throws(() => S.resolveSetup(setup({ ...C.codeFor(C.codeSet("bot@" + rem.commit.slice(0, 7)), "Ran"), entry: "main" }), { G }), /not trusted here yet/);
	assert.throws(() => L.trust("nope"), /not a commit/);
	// a set of the sets file with the library's name wins (and says so)
	const f = write(tmp(), "sets.json", JSON.stringify({ format: "chronal-code-sets/1", sets: { bot: { file: path.join(rem.src, "lone.js") } } }));
	const ls = C.loadCodeSets({ file: f });
	assert.deepEqual([ls.sets.filter((s) => s.name === "bot").map((s) => s.kind), ls.problems], [["file"], [`the library's bot: ${f} has a set of that name (that one is used)`]]);
});

test("chronal run --check names others' CODE not trusted yet; --trust trusts it", { skip: !fs.existsSync(require("../lib/config").config().al_root) && "no game checkout (config al_root)" }, async () => {
	const rem = remote();
	await L.add({ from: rem.url, name: "cli" });
	const file = write(tmp(), "one.json", JSON.stringify({ format: "chronal-setup/1", name: "one", run: { duration: "1m" }, characters: [{ name: "Ran1", class: "ranger", code: { file: path.join(__dirname, "..", "codes", "idle.js") } }] }));
	const run = (...a) => {
		try {
			return { code: 0, out: execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", file, "--code-set", "cli", "--missing", "Ran1=slot:lone", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, CHRONAL_LIBRARY_DIR: LIBDIR } }) };
		} catch (e) {
			return { code: e.status, out: String(e.stdout), err: String(e.stderr) };
		}
	};
	let r = run("--check");
	assert.equal(r.code, 2);
	const o = JSON.parse(r.out);
	assert.deepEqual(o.untrusted, [{ name: "cli", commit: rem.commit, web: rem.url }]);
	assert.match(o.problems[0], /CODE cli at [0-9a-f]{7} .*, for every character: not trusted here yet/);
	r = run("--check", "--trust");
	assert.equal(r.code, 0, r.err);
	assert.equal(JSON.parse(r.out).ok, true);
	assert.equal(L.trusted(rem.commit), true);
});
