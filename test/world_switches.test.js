"use strict";
// The world's switches a setup sets (world.*): the anniversary event (its baker on main, its drops) on or off.
//   node --test test/world_switches.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("the game server ships the anniversary on (a change upstream shows here)", { skip }, () => {
	assert.match(fs.readFileSync(path.join(ROOT, "node", "server.js"), "utf8"), /anniversary:\s*true/);
});

for (const on of [true, false])
	test(`world.anniversary ${on}: its baker on main and E.anniversary ${on ? "there" : "never"}`, { skip, timeout: 120000 }, async () => {
		const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false, anniversary: on });
		try {
			await sim.run(3000);
			assert.equal(!!sim.server.npcs.anniversary_baker, on);
			assert.equal(!!sim.server.E.anniversary, on);
		} finally {
			await sim.close();
		}
	});
