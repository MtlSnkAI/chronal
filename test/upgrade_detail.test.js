"use strict";
// live.js: an upgrade's and a compound's items' event carries its roll: scroll, offering, chance (grace in), the roll, and
// the grace before it (the item's, the character's and the server's per level, the offering grace).
//   node --test test/upgrade_detail.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("upgrade and compound events: scroll, chance, roll, grace before", { skip, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "upgrade-test-"));
	try {
		const code = path.join(d, "up.js");
		fs.writeFileSync(code, "setTimeout(() => { upgrade(0, 1); }, 3000); setTimeout(() => { compound(2, 3, 4, 5); }, 9000);");
		const setup = path.join(d, "setup.json");
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "up", run: { duration: "40s" },
			characters: [{ name: "Mer", class: "merchant", at: "main:-207:-200", code: { file: code },
				state: { level: 30, gold: 100000, items: [{ name: "coat", level: 3, grace: 1 }, { name: "scroll0", q: 5 }, { name: "ringsj", level: 0 }, { name: "ringsj", level: 0 }, { name: "ringsj", level: 0, grace: 2 }, { name: "cscroll0", q: 2 }], p: { ugrace: [0, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], ograce: 1.5 } } }],
		}));
		const live = path.join(d, "live"),
			res = path.join(d, "r.json");
		const r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", live, "--result", res, "--no-build", "--no-export"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const snap = JSON.parse(fs.readFileSync(JSON.parse(fs.readFileSync(res, "utf8")).live, "utf8")),
			ev = fs.readFileSync(path.join(live, snap.items_log.file), "utf8").trim().split("\n").map((l) => JSON.parse(l));
		const up = ev.find((e) => e.k === "upgrade"),
			co = ev.find((e) => e.k === "compound");
		assert.ok(up, "an upgrade event");
		assert.deepEqual([up.item, up.from, up.to, up.scroll, up.grace, up.ug[0], up.og], ["coat", 3, 4, "scroll0", 1, 6, 1.5]);
		assert.equal(up.ug[1], 24); // (the server's: a fresh realm's)
		assert.ok(up.chance > 0 && up.roll >= 0 && up.roll < 1 && (up.ok === up.roll <= up.chance + 1e-4), JSON.stringify(up));
		assert.ok(co, "a compound event");
		assert.deepEqual([co.item, co.scroll, co.grace], ["ringsj", "cscroll0", 2]);
		assert.ok(co.og > 0 && co.og <= 1.5, "the offering grace as the upgrade left it: " + co.og);
		assert.ok(co.chance > 0 && (co.ok === co.roll <= co.chance + 1e-4), JSON.stringify(co));
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});
