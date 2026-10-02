"use strict";
// A custom world (world.spawns, sim/world_spawns.js): checked in a setup, then a short chronal run of the example bot:
// a dummy with endless hp and its attack set (damage dealt and taken, no kill), and an arena whose goos come back
// (more kills than goos). Also the world's start and seasons in the snapshot.
//   node --test test/world_spawns.test.js      (needs the game: chronal install)
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ execFileSync } = require("node:child_process");
const S = require("../lib/setup");
const G = require("../lib/compose").game();

const DIR = path.join(__dirname, ".."),
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "spawns-test-"));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
// a ranger of the example bot farming the spawns' spot
const setup = (world, file) => {
	const f = path.join(tmp, file);
	fs.writeFileSync(f, JSON.stringify({ format: "chronal-setup/1", name: file.replace(/\.json$/, ""), run: { duration: "3m" }, world, defaults: { code: { dir: path.join(DIR, "codes", "example"), entry: "fighter" } },
		characters: [{ name: "Ran1", class: "ranger", at: "main:-150:300", state: { level: 40 }, params: { farm: { map: "main", x: -200, y: 300, monsters: world.spawns.map((x) => x.monster) } } }] }));
	return f;
};
const runIt = (f) => {
	const live = fs.mkdtempSync(path.join(tmp, "live-"));
	execFileSync(process.execPath, [path.join(DIR, "chronal.js"), "run", f, "--live", live], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"], timeout: 240e3 });
	return JSON.parse(fs.readFileSync(path.join(live, fs.readdirSync(live).find((x) => /--\d+\.json$/.test(x))), "utf8"));
};

test("world.spawns checked: a monster of the game, a spot, numbers in range, stats, hp, respawn", () => {
	const problems = (spawns) => {
		try {
			S.loadSetup(setup({ spawns }, "check.json"), { G });
			return [];
		} catch (e) {
			return e.problems;
		}
	};
	assert.deepEqual(problems([{ monster: "goo", at: "main:-200:300", count: 3, level: 2, stats: { attack: 9 }, respawn: "5s", clear: 200 }]), []);
	for (const [sp, re] of [[{ monster: "dragonx", at: "main:0:0" }, /monster/], [{ monster: "goo", at: "main" }, /at: "main", "map:x:y"/], [{ monster: "goo", at: "nowhere:0:0" }, /no map "nowhere"/], [{ monster: "goo", at: "main:0:0", count: 0 }, /count: 1 to 100/], [{ monster: "goo", at: "main:0:0", stats: { mana: 1 } }, /stats/], [{ monster: "goo", at: "main:0:0", hp: 5 }, /hp: "endless"/], [{ monster: "goo", at: "main:0:0", respawn: "soon" }, /respawn/], [{ monster: "goo", at: "main:0:0", size: 2 }, /size: unknown key/]])
		assert.ok(problems([sp]).some((p) => re.test(p)), JSON.stringify(sp) + ": " + problems([sp]).join("; "));
});

test("a dummy: endless hp, its attack set: damage dealt and taken, no kill; the world's start and seasons recorded", () => {
	const w = runIt(setup({ start: "2026-10-31T12:00:00Z", seasons: ["halloween"], spawns: [{ monster: "bigbird", at: "main:-200:300", hp: "endless", stats: { attack: 50 }, clear: 250 }] }, "dummy.json"));
	const p = w.players[0];
	assert.ok(p.dmg.by_target.bigbird.raw > 1000, JSON.stringify(p.dmg.by_target));
	assert.equal(w.kills.total, 0);
	const hits = p.dmg.taken_by.bigbird;
	assert.ok(hits.hits > 10 && hits.raw / hits.hits < 80, "its set attack: " + JSON.stringify(hits));
	assert.deepEqual([w.world.start, w.world.seasons, w.world.spawns.length], ["2026-10-31T12:00:00.000Z", ["halloween"], 1]);
});

test("an arena: its goos come back after their respawn (more kills than goos)", () => {
	const w = runIt(setup({ spawns: [{ monster: "goo", at: "main:-200:300", count: 3, radius: 40, respawn: "5s", clear: 250 }] }, "arena.json"));
	assert.ok(w.kills.by_type.goo > 10, JSON.stringify(w.kills));
});
