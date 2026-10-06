"use strict";
// lib/install.js: the game's repos at the commits this chronal is tested with (upstream.json), upstream's newest with
// --latest; what runtime/installed.json says against the pin (gameCheck: the warnings of chronal run and the
// dashboard); how far upstream is ahead (check). Local repos stand in for upstream's.
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ execFileSync } = require("node:child_process");
const I = require("../lib/install");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "install-test-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const git = (d, ...a) => execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
// an "upstream" repo with commits; -> [dir, commit of each]
function origin(name, n) {
	const d = path.join(dir, "origin-" + name);
	fs.mkdirSync(d);
	git(d, "init", "-q", "-b", "main");
	const cs = [];
	for (let i = 0; i < n; i++) {
		fs.writeFileSync(path.join(d, "f.txt"), name + i);
		git(d, "add", "f.txt");
		git(d, "commit", "-qm", "c" + i);
		cs.push(git(d, "rev-parse", "HEAD"));
	}
	return [d, cs];
}

test("checkout: a repo cloned when missing, at its pin (detached); --latest: upstream's newest; a pin not fetched yet is fetched", () => {
	const [o, cs] = origin("game", 3),
		up = path.join(dir, "upstream1"),
		P = { game: { dir: "game", url: o, commit: cs[0] } };
	let r = I.checkout(P, up);
	assert.equal(git(r.up.game, "rev-parse", "HEAD"), cs[0]);
	assert.equal(git(r.up.game, "rev-parse", "--abbrev-ref", "HEAD"), "HEAD"); // detached
	r = I.checkout(P, up, { latest: true });
	assert.deepEqual([r.target.game, git(r.up.game, "rev-parse", "HEAD")], [cs[2], cs[2]]);
	// a new commit upstream, pinned: not in the clone yet
	fs.writeFileSync(path.join(o, "f.txt"), "new");
	git(o, "commit", "-qam", "c3");
	const c3 = git(o, "rev-parse", "HEAD");
	r = I.checkout({ game: { ...P.game, commit: c3 } }, up);
	assert.equal(git(r.up.game, "rev-parse", "HEAD"), c3);
	assert.throws(() => I.checkout({ game: { ...P.game, commit: "0".repeat(40) } }, up), /no commit 0{40}/);
});

test("gameCheck: the installed game against the pin; an install from before installed.json; another al_root is the user's own", () => {
	const app = path.join(dir, "runtime", "app"),
		file = path.join(dir, "runtime", "installed.json"),
		P = { game: { commit: "a".repeat(40) }, common: { commit: "b".repeat(40) }, config: { commit: "c".repeat(40) } };
	fs.mkdirSync(app, { recursive: true });
	let g = I.gameCheck(app, { P, app, file });
	assert.deepEqual([g.ok, g.game, g.pinned], [false, null, "aaaaaaaa"]);
	assert.match(g.text, /installed before chronal recorded what it installs: run chronal install/);
	fs.writeFileSync(file, JSON.stringify({ game: "a".repeat(40), common: "b".repeat(40), config: "c".repeat(40), pinned: true }));
	assert.deepEqual(I.gameCheck(app, { P, app, file }), { ok: true, game: "aaaaaaaa", pinned: "aaaaaaaa", text: null });
	fs.writeFileSync(file, JSON.stringify({ game: "d".repeat(40), common: "b".repeat(40), config: "c".repeat(40), pinned: false }));
	g = I.gameCheck(app, { P, app, file });
	assert.deepEqual([g.ok, g.game], [false, "dddddddd"]);
	assert.equal(g.text, "the game installed (game dddddddd) isn't the one this chronal is tested with (game aaaaaaaa): run chronal install");
	assert.deepEqual(I.gameCheck(path.join(dir, "elsewhere"), { P, app, file }), { ok: true, game: null, pinned: "aaaaaaaa", text: null });
});

test("check: pinned, installed and upstream's newest commits per repo, and how far upstream is ahead of the pin", () => {
	const [o, cs] = origin("common", 4),
		up = path.join(dir, "upstream2"),
		P = { common: { dir: "common", url: o, commit: cs[1] } };
	I.checkout(P, up);
	const file = path.join(dir, "installed2.json");
	fs.writeFileSync(file, JSON.stringify({ common: cs[1] }));
	assert.deepEqual(I.check({ P, upstream: up, file }), [{ repo: "common", pinned: cs[1].slice(0, 8), installed: cs[1].slice(0, 8), upstream: cs[3].slice(0, 8), ahead: 2 }]);
	assert.deepEqual(I.check({ P: { x: { dir: "none", commit: cs[0] } }, upstream: up, file })[0].upstream, "?");
});

test("upstream.json: the three repos, each with its url and a full commit", () => {
	const P = JSON.parse(fs.readFileSync(I.PIN_FILE, "utf8"));
	assert.deepEqual(Object.keys(P), ["game", "common", "config"]);
	for (const r of Object.values(P)) assert.ok(/^https:\/\/github\.com\//.test(r.url) && /^[0-9a-f]{40}$/.test(r.commit) && r.dir, JSON.stringify(r));
});

test("gData: the installed game's cache/G-<version>-<game>.json, else the newest by version (then the latest written); a configured g_data first", () => {
	const { gData } = require("../lib/config");
	const d = path.join(dir, "cache");
	fs.mkdirSync(d);
	const put = (f, t) => (fs.writeFileSync(path.join(d, f), "{}"), fs.utimesSync(path.join(d, f), t, t));
	put("G-15555.json", 1000);
	put("G-15555-90052162.json", 2000);
	put("G-15555-98783128.json", 3000);
	put("G-15554-aaaaaaaa.json", 4000);
	assert.equal(gData({ g_data: null }, { dir: d, game: "90052162" }), path.join(d, "G-15555-90052162.json"));
	assert.equal(gData({ g_data: null }, { dir: d, game: "98783128" }), path.join(d, "G-15555-98783128.json"));
	assert.equal(gData({ g_data: null }, { dir: d, game: "bbbbbbbb" }), path.join(d, "G-15555-98783128.json")); // (not cached: the newest)
	assert.equal(gData({ g_data: null }, { dir: d, game: null }), path.join(d, "G-15555-98783128.json"));
	assert.equal(gData({ g_data: "/x.json" }, { dir: d, game: "90052162" }), "/x.json");
	assert.equal(gData({ g_data: null }, { dir: path.join(dir, "none"), game: null }), null);
});
