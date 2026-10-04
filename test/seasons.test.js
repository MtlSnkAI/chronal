"use strict";
// sim/seasons.js: a season's switch from the server's own code (its sprocess_game_data blocks), on and off at runtime;
// a setup's schedule (world.seasons { season, from, to }) switching them as a run goes.
//   node --test test/seasons.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { blocks, seasonOn, seasonOff } = require("../sim/seasons");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("blocks(): every season's block from sprocess_game_data, only pushes and assignments (a change upstream throws)", { skip }, () => {
	const b = blocks(ROOT);
	assert.deepEqual(Object.keys(b).sort(), ["egghunt", "halloween", "holidayseason", "lunarnewyear", "valentines"]);
	assert.ok(b.halloween.some((x) => x.set === "G.monsters.jr.respawn") && b.halloween.some((x) => x.push === '[0.00125, "candy1"]'));
	assert.ok(b.valentines.some((x) => x.set === "events.pinkgoo"));
});

test("seasonOn / seasonOff on a booted server: halloween's drops and jr's respawn, then all as before", { skip, timeout: 120000 }, async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false });
	try {
		const S = sim.server,
			global = () => JSON.stringify(require("node:vm").runInContext("D.drops.maps.global", S)),
			before = { g: global(), jr: S.G.monsters.jr.respawn, ev: !!S.events.halloween };
		assert.equal(seasonOn(S, "halloween", sim.env.seasons, ROOT), true);
		assert.match(global(), /candy1/);
		assert.equal(S.G.monsters.jr.respawn, 480);
		assert.equal(S.events.halloween, true);
		await sim.run(2000);
		assert.equal(S.E.halloween, true);
		assert.equal(seasonOff(S, "halloween", sim.env.seasons), true);
		assert.deepEqual({ g: global(), jr: S.G.monsters.jr.respawn, ev: !!S.events.halloween }, before);
		await sim.run(2000);
		assert.equal(S.E.halloween, undefined);
	} finally {
		await sim.close();
	}
});

test("a run's schedule: halloween from 1m to 2m: switched then, in the snapshot; a continuation takes the seasons on at the end", { skip, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "seasons-test-"));
	try {
		const setup = path.join(d, "setup.json");
		fs.writeFileSync(setup, JSON.stringify({ format: "chronal-setup/1", name: "sea", run: { duration: "3m" }, world: { seasons: ["valentines", { season: "halloween", from: "1m", to: "2m" }] },
			characters: [{ name: "Ran", class: "ranger", code: { file: path.join(__dirname, "..", "codes", "idle.js") } }] }));
		const res = path.join(d, "r.json"),
			r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", path.join(d, "live"), "--result", res, "--no-build"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		assert.match(r.stdout, /season halloween on at 1m/);
		const out = JSON.parse(fs.readFileSync(res, "utf8")),
			w = JSON.parse(fs.readFileSync(out.live, "utf8")).world;
		assert.deepEqual(w.season_switches.map((x) => [x.season, x.on, x.t]), [["halloween", true, 60], ["halloween", false, 120]]);
		assert.deepEqual(w.seasons_on, ["valentines"]);
		const index = JSON.parse(fs.readFileSync(path.join(out.state, "index.json"), "utf8"));
		assert.deepEqual(index.seasons_on, ["valentines"]);
		const next = require("../lib/continue").continuation(out.setup, out.state, {});
		assert.deepEqual(next.world.seasons, ["valentines"]);
		// windows of one season that overlap: a problem
		const S = require("../lib/setup");
		fs.writeFileSync(setup, JSON.stringify({ format: "chronal-setup/1", name: "sea", world: { seasons: [{ season: "halloween", to: "2m" }, { season: "halloween", from: "1m" }] }, characters: [{ name: "Ran", class: "ranger", code: { file: path.join(__dirname, "..", "codes", "idle.js") } }] }));
		assert.throws(() => S.loadSetup(setup), /halloween twice at once/);
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});
