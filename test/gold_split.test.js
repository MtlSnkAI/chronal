"use strict";
// live.js: a chest's gold split into the chest's own (gold x goldm), the monster's egold and the encouragement receipts;
// together the server's t.cgold; live_check's gold identity holds.
//   node --test test/gold_split.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("gold split: chest + egold + enc = the server's cgold; a new account's New Player receipts in enc", { skip, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "gold-test-"));
	try {
		const setup = path.join(d, "setup.json");
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "gold", run: { duration: "3m" }, accounts: { a: { age_days: 0 } },
			characters: [{ name: "Ran", class: "ranger", account: "a", at: "main:-64:787", code: { dir: path.join(__dirname, "..", "codes", "example"), entry: "fighter" }, state: { level: 20 }, params: { farm: { map: "main", x: -64, y: 787, monsters: ["goo"] } } }],
		}));
		const res = path.join(d, "r.json"),
			r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", path.join(d, "live"), "--result", res, "--no-build", "--no-export"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const file = JSON.parse(fs.readFileSync(res, "utf8")).live,
			p = JSON.parse(fs.readFileSync(file, "utf8")).players[0],
			f = p.gold_flow;
		assert.ok(p.chests.opened > 10, "chests opened: " + p.chests.opened);
		assert.ok(f.chest > 0 && f.enc > f.chest, JSON.stringify(f)); // (New Player's gold receipts: most of it)
		assert.equal(f.chest + f.egold + f.enc, p.server.cgold);
		assert.equal(p.income, f.chest + f.egold + f.enc + f.sold + f.stand);
		const lc = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "live_check.js"), file, "--quiet"], { encoding: "utf8" });
		assert.equal(lc.status, 0, lc.stdout + lc.stderr);
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

test("Angel's aura on a new account's chests: its share of each chest's gold measured (exact.angel_gold), every chest matching the server's formula, no hook failing", { skip, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "angel-test-"));
	try {
		const setup = path.join(d, "setup.json");
		// the aura as Angel gives it (server.js: citizen4aura, its def.aura), held for the run
		const aura = { ms: 3600000, name: "Citizen's Aura", skin: "citizens", citizens: true, gold: 200 };
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "angel", run: { duration: "3m" }, accounts: { a: { age_days: 0 } },
			characters: [{ name: "Ran", class: "ranger", account: "a", at: "main:-64:787", code: { dir: path.join(__dirname, "..", "codes", "example"), entry: "fighter" }, state: { level: 20, s: { citizen4aura: aura } }, params: { farm: { map: "main", x: -64, y: 787, monsters: ["goo"] } } }],
		}));
		const res = path.join(d, "r.json"),
			r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", path.join(d, "live"), "--result", res, "--no-build", "--no-export"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const file = JSON.parse(fs.readFileSync(res, "utf8")).live,
			snap = JSON.parse(fs.readFileSync(file, "utf8")),
			p = snap.players[0];
		assert.deepEqual(snap.hook_errors, {});
		assert.ok(p.exact.angel_chests > 10 && p.exact.angel_gold > 0, JSON.stringify(p.exact));
		assert.equal(p.exact.angel_unmatched, 0);
		assert.ok(p.gold_flow.enc > 0, JSON.stringify(p.gold_flow)); // (receipts under the aura too)
		const lc = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "live_check.js"), file, "--quiet"], { encoding: "utf8" });
		assert.equal(lc.status, 0, lc.stdout + lc.stderr);
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});
