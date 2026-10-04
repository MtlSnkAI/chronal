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

test("world.ugrace: the server's upgrade grace per level (a new realm's 24; a number; { level: n }); fixed: held, still saved as plain values", { skip, timeout: 180000 }, async () => {
	const ug = async (o) => {
		const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false, ...o });
		try {
			const S = sim.server.S,
				before = Array.from(S.ugrace);
			S.ugrace[4] = 99; // (as a failed upgrade to +4 would move it)
			return { before, after: Array.from(S.ugrace), clone: structuredClone(S.ugrace) };
		} finally {
			await sim.close();
		}
	};
	const d = await ug({});
	assert.deepEqual(d.before, Array(25).fill(24));
	assert.equal(d.after[4], 99);
	const z = await ug({ ugrace: 0 });
	assert.deepEqual(z.before, Array(25).fill(0));
	const o = await ug({ ugrace: { 4: 3 } });
	assert.deepEqual([o.before[3], o.before[4], o.before[5]], [24, 3, 24]);
	const f = await ug({ ugrace: 6, ugrace_fixed: true });
	assert.equal(f.after[4], 6, "held");
	assert.deepEqual(Array.from(f.clone), Array(25).fill(6));
});
