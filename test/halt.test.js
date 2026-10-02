"use strict";
// sim.halt(): ThreadedSim stops at the next game minute (chunks on the window grid), Sim after the current event;
// until() stops waiting; close() passes end; with live snapshots, SIGINT/SIGTERM halt the run and a second signal exits
// at once.
//   node --test test/halt.test.js
// Needs the game (config al_root: chronal install). The last test runs chronal run (a ranger on codes/idle.js) and
// SIGTERMs it mid-run; CHRONAL_HALT_E2E=0 skips it.
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawn } = require("node:child_process");
const { createSim } = require("../sim/sim");

const DIR = path.join(__dirname, ".."),
	ROOT = require("../lib/config").config().al_root;
const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "halt-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
// a stand-in for live.js: sees every lockstep window (ThreadedSim) and what close() passes
const fakeLive = (sim, onTick) => ({ ticks: [], ended: undefined, tick() { this.ticks.push(sim.clock.now); if (onTick) onTick(); }, close(end) { this.ended = end; } });
// the one snapshot in a live dir, and its grid lines
const snapshot = (dir) => {
	const f = fs.readdirSync(dir).find((x) => /--\d+\.json$/.test(x));
	const grid = path.join(dir, f.replace(/\.json$/, ".grid.ndjson"));
	return { s: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), grid: fs.existsSync(grid) ? fs.readFileSync(grid, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : null, ctl: fs.existsSync(path.join(dir, f.replace(/\.json$/, ".ctl"))) };
};
// live.js v2.2 writes end at close
const endIs = (s, reason, detail) => assert.deepEqual(s.end, { reason, detail });
const run = (args, env, started) =>
	new Promise((resolve) => {
		const child = spawn(process.execPath, args, { cwd: DIR, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
		let out = "";
		child.stdout.on("data", (d) => (out += d));
		child.stderr.on("data", (d) => (out += d));
		child.on("exit", (code, signal) => resolve({ code, signal, out }));
		if (started) started(child);
	});

test("ThreadedSim: run() goes window by window across its game-minute chunks; halt() ends it at the next chunk", async () => {
	const sigs = process.listenerCount("SIGTERM");
	const sim = await createSim({ root: ROOT, seed: 1, threads: true, live: false });
	assert.equal(process.listenerCount("SIGTERM"), sigs, "no signal handlers without live snapshots");
	assert.equal(sim.halted, null);
	const t0 = sim.clock.now,
		W = sim.W;
	let at = Infinity;
	sim.live = fakeLive(sim, () => sim.clock.now - t0 >= at && sim.halt("test"));
	// not halted: every window of the whole run, W apart, the last one at the end (as one long call had them)
	const r0 = await sim.run(150_000);
	assert.equal(r0.virtualMs, 150_000);
	assert.equal(r0.halted, false);
	const ticks = sim.live.ticks;
	assert.equal(ticks.length, 150_000 / W);
	for (let i = 0; i < ticks.length; i++) assert.equal(ticks[i], t0 + (i + 1) * W);
	// halted in the second chunk's window at +70 s (of this run): the run ends at the end of that chunk, +120 s
	const t1 = sim.clock.now;
	at = t1 - t0 + 70_000;
	const r1 = await sim.run(300_000);
	assert.equal(r1.halted, true);
	assert.equal(sim.halted, "test");
	assert.equal(r1.virtualMs, 120_000);
	assert.equal(sim.clock.now, t1 + 120_000);
	// halted: run() and until() return at once
	const r2 = await sim.run(60_000);
	assert.deepEqual([r2.virtualMs, r2.halted], [0, true]);
	let asked = 0;
	assert.equal(await sim.until(() => (asked++, false), 600_000), false);
	assert.equal(sim.clock.now, t1 + 120_000);
	assert.equal(asked, 1);
	sim.halt("later");
	assert.equal(sim.halted, "test", "the first reason wins");
	const live = sim.live;
	await sim.close();
	assert.deepEqual(live.ended, { reason: "stopped", detail: "test" });
});

test("Sim (one thread): halt() ends run() after the current event; until() stops; close() passes end", async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: false, live: false });
	const t0 = sim.clock.now;
	sim.clock.at(t0 + 90_000, () => sim.halt("test"));
	const r = await sim.run(300_000);
	assert.equal(r.halted, true);
	assert.equal(r.virtualMs, 90_000);
	assert.equal((await sim.run(60_000)).virtualMs, 0);
	assert.equal(await sim.until(() => false, 600_000), false);
	assert.equal(sim.clock.now, t0 + 90_000);
	sim.live = fakeLive(sim);
	const live = sim.live;
	await sim.close();
	assert.deepEqual(live.ended, { reason: "stopped", detail: "test" });
	// never halted: "complete"
	const sim2 = await createSim({ root: ROOT, seed: 1, threads: false, live: false });
	assert.equal((await sim2.run(1000)).halted, false);
	sim2.live = fakeLive(sim2);
	const live2 = sim2.live;
	await sim2.close();
	assert.deepEqual(live2.ended, { reason: "complete" });
});

// a sim with live snapshots (live: { dir, tag }) and without characters, signalled from inside
const child = (steps, live) => `
const { createSim } = require(${JSON.stringify(path.join(DIR, "sim/sim.js"))});
const say = (o) => console.log(JSON.stringify(o)), wait = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
	const sim = await createSim({ root: ${JSON.stringify(ROOT)}, seed: 1, threads: false, live: ${JSON.stringify(live)} });
	say({ live: !!sim.live, handlers: process.listenerCount("SIGTERM") });
	await sim.run(10_000);
	process.kill(process.pid, "SIGTERM");
	await wait(200);
	say({ halted: sim.halted, virtualMs: (await sim.run(60_000)).virtualMs });
	${steps}
})();`;
const lines = (out) => out.split("\n").filter((l) => l.startsWith("{")).map((l) => JSON.parse(l));

test("live: SIGTERM halts; close() writes the final snapshot and removes the handlers (Node's default again)", async () => {
	const dir = tmp();
	const r = await run(["-e", child(`await sim.close(); say({ handlers: process.listenerCount("SIGTERM") }); process.kill(process.pid, "SIGTERM"); await wait(2000); say({ alive: true });`, { dir, tag: "halt-close" })], {});
	const [a, b, c, d] = lines(r.out);
	assert.deepEqual(a, { live: true, handlers: 1 });
	assert.deepEqual(b, { halted: "SIGTERM", virtualMs: 0 });
	assert.deepEqual(c, { handlers: 0 });
	assert.equal(d, undefined, r.out);
	assert.equal(r.signal, "SIGTERM"); // the second signal after close(): killed as without handlers
	const { s, ctl } = snapshot(dir);
	assert.equal(s.done, true);
	endIs(s, "stopped", "SIGTERM");
	assert.equal(ctl, false);
});

test("live: a second SIGTERM writes the snapshot as it is and exits at once (143)", async () => {
	const dir = tmp();
	const r = await run(["-e", child(`process.kill(process.pid, "SIGTERM"); await wait(2000); say({ alive: true });`, { dir, tag: "halt-x2" })], {});
	assert.equal(r.code, 143, r.out);
	assert.equal(lines(r.out).length, 2, r.out);
	const { s } = snapshot(dir);
	assert.equal(s.done, true);
	endIs(s, "stopped", "SIGTERM x2");
});

test("chronal run with live snapshots: kill -TERM mid-run -> exit 0, its result halted, final snapshot done, last grid row", { skip: process.env.CHRONAL_HALT_E2E === "0" }, async () => {
	const dir = tmp(),
		result = path.join(dir, "result.json");
	let sent = 0,
		watch;
	const out = await run(["chronal.js", "run", "--code", path.join("codes", "idle.js"), "--class", "ranger", "--duration", "240m", "--warmup", "0m", "--live", dir, "--tag", "halt-e2e", "--result", result], {}, (c) => {
		// SIGTERM once the grid has 2 rows after its header (the base, then a game minute: mid-run, in the measured part)
		watch = setInterval(() => {
			const g = fs.readdirSync(dir).find((f) => f.endsWith(".grid.ndjson"));
			if (sent || !g || fs.readFileSync(path.join(dir, g), "utf8").split("\n").filter(Boolean).length < 3) return;
			sent = Date.now();
			c.kill("SIGTERM");
		}, 100);
	});
	clearInterval(watch);
	assert.ok(sent, "never signalled:\n" + out.out);
	const late = Date.now() - sent;
	assert.equal(out.code, 0, out.out);
	assert.ok(late < 10_000, `exited ${late} ms after SIGTERM`);
	const res = JSON.parse(fs.readFileSync(result, "utf8"));
	assert.equal(res.halted, true);
	assert.ok(res.vmin > 0 && res.vmin < 240 && Number.isInteger(res.vmin), "stopped at a game minute: " + res.vmin);
	const { s, grid, ctl } = snapshot(dir);
	assert.equal(s.done, true);
	endIs(s, "stopped", "SIGTERM");
	assert.equal(ctl, false);
	const last = grid[grid.length - 1];
	assert.equal(last.end, true, "the last grid row is written at close");
	assert.equal(last.v, s.world.clock);
});

test("chronal run's warm-up is played, not measured: the snapshot's base (0:00) is its end, the CLI's numbers are the snapshot's, steering counts from it", async () => {
	const dir = tmp(),
		result = path.join(dir, "result.json"),
		setup = path.join(dir, "warm.json");
	fs.writeFileSync(setup, JSON.stringify({
		format: "chronal-setup/1", name: "warm", run: { duration: "3m", warmup: "2m" },
		characters: [{ name: "Ran1", class: "ranger", code: { file: path.join(DIR, "codes", "example", "fighter.js"), dir: path.join(DIR, "codes", "example") } }],
		steer: [{ at: "0m", storage: { mode: "farm" } }, { at: "1m", storage: { mode: "farm" } }],
	}));
	const out = await run(["chronal.js", "run", setup, "--live", dir, "--result", result]);
	assert.equal(out.code, 0, out.out);
	const { s, grid } = snapshot(dir),
		res = JSON.parse(fs.readFileSync(result, "utf8")),
		p = s.players[0];
	// measured: the 3 minutes after the warm-up (the base is the first 100 ms probe from its end)
	assert.ok(s.measured_ms > 3 * 60e3 - 200 && s.measured_ms <= 3 * 60e3, String(s.measured_ms));
	assert.ok(s.virtual_ms >= 5 * 60e3 - 200, String(s.virtual_ms));
	// the CLI's (and --result's) numbers are the snapshot's
	assert.deepStrictEqual([p.kills, p.deaths, p.xp_gained], [res.characters.Ran1.kills, res.characters.Ran1.deaths, res.characters.Ran1.xp]);
	// steering at its times from the measured part's start; the grid from 0:00
	assert.deepStrictEqual(s.steer.map((e) => Math.round(e.t)), [0, 60]);
	assert.ok(grid[1].t === 0 && grid[grid.length - 1].t === 180, JSON.stringify([grid[1].t, grid[grid.length - 1].t]));
	// time per map: shares of the measured part (the warm-up's left out), adding up to it
	const share = Object.values(p.maps).reduce((a, b) => a + b, 0);
	assert.ok(share > 0.99 && share <= 1.001, JSON.stringify(p.maps));
	// deaths listed: the measured part's only
	assert.equal(s.deaths.recent.length, s.deaths.total);
});
