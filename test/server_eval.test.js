"use strict";
// server_host.js: the server's own /eval (realm_broadcast -> servers_eval: L80, blessings, a first login) runs in the
// sim, so its broadcasts reach the players as on live; any other address is refused in one line.
//   node --test test/server_eval.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	path = require("node:path");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("realm_broadcast reaches the players through the server's own /eval; no 'server_eval error'", { skip, timeout: 120000 }, async () => {
	const errors = [],
		err = console.error;
	console.error = (...a) => (errors.push(a.map(String).join(" ")), err(...a));
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false });
	try {
		const c = sim.addCharacter({ name: "Eval1", type: "mage", code: 'parent.socket.on("server_message", (d) => (window.SM = d.message));', fps: 10 });
		await sim.until(async () => sim.halted || (await c.query("!!(character && code_active)")), 60000);
		sim.server.realm_broadcast("server_message", { message: "x80" });
		await sim.run(2000);
		assert.equal(await c.query("window.__runner.SM || null"), "x80"); // (the CODE's window)
		assert.deepEqual(errors.filter((e) => /server_eval/.test(e)), []);
	} finally {
		console.error = err;
		await sim.close();
	}
});

test("fetch to anywhere else: refused with a one-line error (no stack)", { skip, timeout: 120000 }, async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false });
	try {
		const e = await sim.server.fetch("http://example.com/x").catch((e) => e);
		assert.equal(e.stack, "[sim] network disabled: GET http://example.com/x");
	} finally {
		await sim.close();
	}
});
