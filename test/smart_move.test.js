"use strict";
// smart_move on the virtual clock (#4): a character placed outside a map's walls is refused (a search from there never
// ends); smart_move's search runs in slices over the ticks as on live (its 40/500 ms slice was by Date, which doesn't
// move inside a synchronous loop); a thread stuck in one event is the one the run's error names.
//   node --test test/smart_move.test.js      (needs the game: config al_root, chronal install)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path");
const { createSim } = require("../sim/sim");
const { Gate } = require("../sim/fake_io");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

// main:300:300 is outside main's walls: a fill from it with the game's own can_move runs past the map's edge
test("a character at a spot outside the walls is refused, naming it; a spot inside, a spawn and a map whose walls don't close are not", { skip, timeout: 120000 }, async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false, silent: true });
	try {
		assert.throws(() => sim.createCharacter({ name: "Out1", type: "merchant", over: { info: { map: "main", x: 300, y: 300 } } }), /Out1: main:300:300 is outside main's walls/);
		assert.doesNotThrow(() => sim.createCharacter({ name: "In1", type: "merchant", over: { info: { map: "main", x: 250, y: -100 } } }));
		assert.doesNotThrow(() => sim.createCharacter({ name: "Spawn1", type: "merchant", over: { info: { map: "main", x: 0, y: 0 } } }));
		// a map whose own spawns leak past its edge (its walls don't close): the check can't tell there, so it allows
		assert.doesNotThrow(() => sim.createCharacter({ name: "Isle1", type: "merchant", over: { info: { map: "shellsisland", x: 40, y: 40 } } }));
	} finally {
		await sim.close();
	}
});

// From town to main:300:300 there is no path: the search covers all of main (~145k nodes) and fails. On the virtual clock
// it used to do that in one go (0 ms of game time); sliced, it takes ticks, then fails as on live.
test("smart_move's search spreads over ticks: an unreachable target fails after game time has passed; a reachable one arrives", { skip, timeout: 120000 }, async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false, silent: true });
	const code = `window.out = {};
		setTimeout(function () {
			var t0 = Date.now();
			smart_move({ map: "main", x: 300, y: 300 }).then(function () { out.far = "arrived"; }, function (e) { out.far = e.reason; out.far_ms = Date.now() - t0;
				var t1 = Date.now();
				smart_move({ map: "main", x: 250, y: -100 }).then(function () { out.near = "arrived"; out.near_ms = Date.now() - t1; }, function (e) { out.near = e.reason; });
			});
		}, 2000);`;
	const c = sim.addCharacter({ name: "Walk1", type: "merchant", code, fps: 10, over: { info: { map: "main", x: -60, y: 60 } } });
	try {
		await sim.until(async () => sim.halted || (await c.query("!!(window.__runner && window.__runner.out && window.__runner.out.near)")), 60000);
		const out = await c.query("window.__runner.out");
		assert.equal(out.far, "failed");
		assert.ok(out.far_ms >= 160, `the failed search took ${out.far_ms} game ms (at least 2 ticks of 80 ms)`);
		assert.equal(out.near, "arrived");
		assert.equal(sim.failed, null);
	} finally {
		await sim.close();
	}
});

test("Gate: the error when the peers stop moving names the ones furthest behind", () => {
	const shared = Gate.buffer(),
		name = (slot) => (slot === 0 ? "the server" : `client thread C${slot}`);
	const g = new Gate({ shared, self: 0, peers: [1, 2, 3], L: 5, spin: 0, flush() {}, receive() {}, name });
	g.init(1, 1000);
	g.init(2, 400);
	g.init(3, 1000);
	assert.match(g.stalled().message, /^\[sim\] a thread stopped making progress: client thread C2 \(no virtual time passed in 120 s/);
	const c = new Gate({ shared, self: 2, peers: [0], L: 5, spin: 0, flush() {}, receive() {}, name, patience: 150000 });
	assert.match(c.stalled().message, /progress: the server \(no virtual time passed in 150 s/);
});
