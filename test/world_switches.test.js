"use strict";
// The world's switches a setup sets (world.*): the anniversary event (its baker on main, its drops) as the game ships it,
// on or off.
//   node --test test/world_switches.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("shippedAnniversary: the game's own events.anniversary (its node/server.js); null when it has none", () => {
	const { shippedAnniversary } = require("../lib/schedule");
	const d = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "anniversary-"));
	try {
		fs.mkdirSync(path.join(d, "node"));
		for (const v of [true, false]) {
			fs.writeFileSync(path.join(d, "node", "server.js"), `var x = { anniversary: ${!v} };\nvar events = {\n\tanniversary: ${v}, // a comment\n\t// SEASONS\n\tholidayseason: false,\n};\n`);
			assert.equal(shippedAnniversary(d), v);
		}
		fs.writeFileSync(path.join(d, "node", "server.js"), "var events = {};\n");
		assert.equal(shippedAnniversary(d), null);
		assert.equal(shippedAnniversary(path.join(d, "none")), null);
		if (!skip) assert.equal(typeof shippedAnniversary(ROOT), "boolean", "the installed game has it");
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

// null: as the game ships it (off from 98783128's successor, 8be6dc34)
for (const on of [null, true, false])
	test(`world.anniversary ${on}: its baker on main and E.anniversary as ${on == null ? "the game ships it" : on ? "on" : "off"}`, { skip, timeout: 120000 }, async () => {
		const want = on ?? require("../lib/schedule").shippedAnniversary(ROOT);
		const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false, ...(on == null ? {} : { anniversary: on }) });
		try {
			await sim.run(3000);
			assert.equal(!!sim.server.npcs.anniversary_baker, want);
			assert.equal(!!sim.server.E.anniversary, want);
			assert.equal(sim.server.chronal_anniversary_game, require("../lib/schedule").shippedAnniversary(ROOT));
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
