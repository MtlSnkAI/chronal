"use strict";
// server_host.js seededCrypto(): the server's crypto randomness (the cave, the tavern's games, generated maps) comes
// from the run's seed: the same seed, the same draws.
//   node --test test/seeded_crypto.test.js      (the end-to-end test needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path");
const { seededCrypto } = require("../sim/server_host");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("seededCrypto: randomInt's forms and bounds, randomBytes, randomUUID; the same seed draws the same; hashes stay real", async () => {
	const c = seededCrypto(5),
		d = seededCrypto(5);
	for (let i = 0; i < 200; i++) {
		const v = c.randomInt(10);
		assert.ok(Number.isInteger(v) && v >= 0 && v < 10);
		const w = c.randomInt(-3, 3);
		assert.ok(w >= -3 && w < 3);
		assert.ok(c.randomInt(0, 2 ** 40) < 2 ** 40);
	}
	assert.equal(await new Promise((ok) => c.randomInt(7, (e, v) => ok(e === null && v >= 0 && v < 7))), true);
	assert.equal(c.randomBytes(12).length, 12);
	assert.match(c.randomUUID(), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	assert.throws(() => c.randomInt(3, 3), RangeError);
	const a = Array.from({ length: 50 }, () => seededCrypto(9).randomInt(1e6));
	assert.equal(new Set(a).size, 1); // a fresh stream per seed starts the same
	const e = seededCrypto(5);
	assert.deepEqual(Array.from({ length: 20 }, () => d.randomInt(1000)), Array.from({ length: 20 }, () => e.randomInt(1000))); // two streams of one seed
	assert.equal(c.createHash("sha256").update("x").digest("hex"), require("node:crypto").createHash("sha256").update("x").digest("hex"));
});

test("the server's cave draws come from the run's seed: seed 5 twice the same cave_boot and cave_random() values, seed 6 others", { skip, timeout: 120000 }, async () => {
	const draws = async (seed) => {
		const sim = await createSim({ root: ROOT, seed, threads: false, live: false });
		try {
			return [sim.server.Server.info.cave_boot, ...Array.from({ length: 100 }, () => sim.server.cave_random())];
		} finally {
			await sim.close();
		}
	};
	const [a, b, c] = [await draws(5), await draws(5), await draws(6)];
	assert.deepEqual(a, b);
	assert.notDeepEqual(a, c);
});
