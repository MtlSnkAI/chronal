"use strict";
// report.js: the chronal readers (nothing else of a CODE is read), modeExpr, guarded(), vclock's RNG state and promise
// counter; then both sims end to end (single-thread probe() and client threads): what the snapshot gets from each kind
// of CODE, and an impure getter called once only.
//   node --test test/report.test.js        (the end-to-end tests need the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	vm = require("node:vm"),
	{ spawnSync } = require("node:child_process");
const { readMode, readStatus, readRole, modeExpr, guarded, STATUS_MS, STATUS_MAX } = require("../sim/report");
const { VirtualClock, mulberry32, promiseCount } = require("../sim/vclock");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "report-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("readers: plain values, getters (called on chronal); nothing without chronal (an M of the CODE's own is not read)", () => {
	let n = 0;
	const S = { kills: 4, mode: () => "farm" + ++n, status() { return { kills: this.kills, at: new Date(0) }; }, role: "healer" };
	assert.deepEqual(readMode({ chronal: S }), { v: "farm1", from: "chronal" });
	assert.deepEqual(readMode({ chronal: { mode: "rest" } }), { v: "rest", from: "chronal" });
	assert.deepEqual(readMode({ chronal: { mode: 7 } }), { v: "7", from: "chronal" });
	assert.deepEqual(readMode({ chronal: {}, M: { mode: () => "kite" } }), { v: null, from: "chronal" }); // chronal wins, even without a mode
	assert.deepEqual(readStatus({ chronal: S }), { v: { kills: 4, at: "1970-01-01T00:00:00.000Z" }, from: "chronal" }); // plain JSON
	assert.deepEqual(readStatus({ chronal: { status: { a: [1, 2] } } }), { v: { a: [1, 2] }, from: "chronal" });
	assert.deepEqual(readStatus({ chronal: { status: () => undefined } }), { v: null, from: "chronal" });
	assert.deepEqual(readRole({ chronal: S }), { v: "healer", from: "chronal" });
	assert.deepEqual(readRole({ chronal: { role: () => "tank" } }), { v: "tank", from: "chronal" });
	// without chronal: nothing, whatever else the CODE has (its own M.mode() / M.snapshot() are never called)
	let called = 0;
	const M = { mode: () => (called++, "kite"), snapshot: () => (called++, { mode: "kite", party: { role: "dps" } }) };
	for (const w of [null, undefined, {}, { M: {} }, { M }]) {
		assert.deepEqual(readMode(w), { v: null, from: null });
		assert.deepEqual(readStatus(w), { v: null, from: null });
		assert.deepEqual(readRole(w), { v: null, from: null });
	}
	assert.equal(called, 0);
	// a thrower throws (guarded() reports it)
	assert.throws(() => readStatus({ chronal: { status: () => ({ b: 1n }) } }));
});

test("readers: a status over 64 KB of JSON (UTF-8 bytes) is truncated; a role not in the list is null", () => {
	assert.equal(STATUS_MAX, 65536);
	const fits = { s: "x".repeat(STATUS_MAX - 8) }; // {"s":"..."} = 8 + length
	assert.deepEqual(readStatus({ chronal: { status: fits } }).v, fits);
	assert.deepEqual(readStatus({ chronal: { status: { s: "x".repeat(STATUS_MAX - 7) } } }).v, { truncated: true, bytes: STATUS_MAX + 1 });
	assert.deepEqual(readStatus({ chronal: { status: { s: "\u00e9".repeat(40000) } } }).v, { truncated: true, bytes: 80008 });
	for (const bad of ["wizard", "", 3, null, undefined, { role: "dps" }, "DPS"]) assert.deepEqual(readRole({ chronal: { role: bad } }).v, null);
	for (const ok of ["dps", "tank", "healer", "merchant", "support"]) assert.deepEqual(readRole({ chronal: { role: ok } }).v, ok);
});

test("modeExpr in a game window: chronal (string, getter, none), '?' without chronal (M or not)", () => {
	const q = (runner) => {
		const g = vm.createContext({ window: null });
		vm.runInContext("window = this", g);
		g.__runner = runner;
		return JSON.parse(vm.runInContext("JSON.stringify({ mode: " + modeExpr + " })", g)).mode;
	};
	assert.equal(q({ chronal: { mode: "farm" } }), "farm");
	assert.equal(q({ chronal: { k: "move", mode() { return this.k; } } }), "move");
	assert.equal(q({ chronal: {}, M: { mode: () => "kite" } }), null);
	assert.equal(q({ M: { mode: () => "kite" } }), "?");
	assert.equal(q({}), "?");
	assert.equal(q(undefined), "?");
});

test("vclock: mulberry32 state() / restore() round trip; promiseCount() counts promises (also in a vm context)", () => {
	const r = mulberry32(42),
		twin = mulberry32(42);
	r(), twin();
	const s = r.state(),
		a = [r(), r(), r()];
	r.restore(s);
	assert.deepEqual([r(), r(), r()], a);
	assert.deepEqual(a, [twin(), twin(), twin()]);
	const p0 = promiseCount();
	Promise.resolve(1);
	assert.ok(promiseCount() > p0);
	const g = vm.createContext(vm.constants.DONT_CONTEXTIFY),
		p1 = promiseCount();
	vm.runInContext("new Promise(function () {})", g);
	assert.ok(promiseCount() > p1);
});

// two contexts on a clock, as a character's game window and CODE runner (client_host.js makeWindow)
function character(seed = 3) {
	const clock = new VirtualClock({ seed }),
		hub = { out: [] },
		game = vm.createContext(vm.constants.DONT_CONTEXTIFY),
		runner = vm.createContext(vm.constants.DONT_CONTEXTIFY);
	clock.installInto(game, { profile: "browser" });
	clock.installInto(runner, { profile: "browser" });
	vm.runInContext("var game_logs = []; function add_log(m) { game_logs.push([m]); }", game);
	runner.parent = game;
	runner.hub = hub;
	return { clock, hub, game, runner, ctxs: [game, runner] };
}
const next = (c, n = 5) => [...[c.game, c.runner].map((g) => Array.from({ length: n }, () => vm.runInContext("Math.random()", g))), Array.from({ length: n }, () => c.clock.rng())];

test("guarded(): a random-consuming getter leaves every sequence where it was; value and no flag", () => {
	const a = character(),
		b = character();
	vm.runInContext("var chronal = { status: function () { Math.random(); Math.random(); parent.Math.random(); return { r: Math.random() < 2 }; } }", a.runner);
	const clockRng = () => a.clock.rng();
	const g = guarded(a.ctxs, a.clock, a.hub, () => (clockRng(), readStatus(a.runner)));
	assert.deepEqual(g, { value: { v: { r: true }, from: "chronal" }, impure: null });
	assert.deepEqual(next(a), next(b));
	// without guarded() the same getter would have moved them
	const c = character(),
		d = character();
	vm.runInContext("Math.random()", c.runner);
	assert.notDeepEqual(next(c), next(d));
});

test("guarded(): a getter that schedules a timer, emits, makes a promise, logs or throws is flagged", () => {
	const cases = [
		["timer", "setTimeout(function () { x++; }, 1000)"],
		["timer", "setTimeout(function () {}, 5)"], // (an empty callback takes an id only)
		["timer", "requestAnimationFrame(function () {})"],
		["timer", "setInterval(function () { x++; }, 100)"],
		["emit", "hub.out.push([0, 'p', 1, '[]'])"],
		["promise", "new Promise(function () {})"],
		["promise", "(async function () {})()"],
		["log", "parent.add_log('hi')"],
		["threw", "null.x"],
		[null, "Math.random(); new Date(); JSON.stringify({ a: 1 })"],
	];
	for (const [why, body] of cases) {
		const c = character(),
			seq = c.clock.seq;
		vm.runInContext(`var x = 0; var chronal = { status: function () { ${body}; return { ok: 1 }; } }`, c.runner);
		const g = guarded(c.ctxs, c.clock, c.hub, () => readStatus(c.runner));
		assert.equal(g.impure, why, body);
		assert.deepEqual(g.value, why === "threw" ? null : { v: { ok: 1 }, from: "chronal" }, body);
		if (!why) assert.equal(c.clock.seq, seq);
	}
	// a hub without `out` (the single-thread Sim: an emit schedules a delivery on the clock)
	const c = character();
	vm.runInContext("var chronal = { mode: function () { setTimeout(function () {}, 20); return 'm'; } }", c.runner);
	assert.equal(guarded(c.ctxs, c.clock, {}, () => readMode(c.runner)).impure, "timer");
});

test("live.js modesOf: each mode rounded, then the sum clamped to the whole measured ms (the single-thread Sim's is fractional)", () => {
	const { Live } = require("../sim/live");
	const modes = (x, now, measured) => Live.prototype.modesOf.call({ modeTotals: { A: x }, modes0: { A: {} }, base: { at: 0 } }, "A", now, measured);
	// 1000.6 + 2000.6 = 3001.2 = measured, but rounded 1001 + 2001 = 3002: the excess comes off the current mode
	assert.deepEqual(modes({ at: 1000.6, cur: "b", totals: { a: 1000.6 } }, 3001.2, 3001.2), { a: 1001, b: 2000 });
	// more excess than the current mode has: the rest off the largest
	assert.deepEqual(modes({ at: 0, cur: "c", totals: { a: 700.6, b: 300.6, c: 0.6 } }, 0, 1000.4), { a: 699, b: 301 });
	// no current mode: off the largest
	assert.deepEqual(modes({ at: 0, cur: null, totals: { a: 500.5, b: 500.5 } }, 0, 1001.9), { a: 500, b: 501 });
	// within measured: as they are
	assert.deepEqual(modes({ at: 100, cur: "a", totals: { b: 100 } }, 300, 300), { a: 200, b: 100 });
});

test("tools/live_check.js: a sim snapshot without items.held (test/fixtures/live-v2) skips that check with a note", () => {
	const dir = path.join(__dirname, "fixtures", "live-v2");
	for (const f of fs.readdirSync(dir).filter((x) => /^fx_.*--\d+\.json$/.test(x))) {
		const s = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
		if (s.players.some((p) => p.items && p.items.held)) continue;
		const r = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "live_check.js"), path.join(dir, f)], { encoding: "utf8" });
		assert.ok(r.status === 0 || r.status === 1, `${f}: exit ${r.status}\n${r.stderr}`); // (the toy data fails some checks)
		assert.equal(r.stderr, "", f);
		for (const p of s.players.filter((q) => q.dmg)) assert.ok(r.stdout.includes(`${p.name.padEnd(10)} items held = flows: skipped, the snapshot has no items.held`), f + " " + p.name);
		assert.match(r.stdout, /\d+\/\d+ checks passed\n$/, f);
	}
});

// ---- end to end: what each kind of CODE puts in the snapshot, and an impure getter called once only ----------------

const { createSim } = require("../sim/sim");
const { Live } = require("../sim/live");
const { config } = require("../lib/config");
const ROOT = config().al_root;
const CODES = {
	// chronal, with a status getter that schedules a timer (disabled after its first call; its value stands)
	AnyA: `var calls = { mode: 0, status: 0, role: 0, fired: 0 };
		self.chronal = {
			mode: function () { calls.mode++; Math.random(); return "idle"; },
			status: function () { calls.status++; setTimeout(function () { calls.fired++; }, 1000); return { calls: calls.status }; },
			role: function () { calls.role++; return "support"; },
		};`,
	// an M of its own, no chronal: not read (as AnyC)
	AnyB: `var M = { mode: function () { return "kite"; }, snapshot: function () { return { mode: "kite", party: { role: "healer" } }; } };`,
	// neither
	AnyC: `var nothing = 1;`,
};
async function runReport(threads) {
	const dir = tmp(),
		sim = await createSim({ root: ROOT, seed: 1, threads, live: false });
	sim.live = new Live(sim, { dir, tag: "report test" });
	const cs = Object.entries(CODES).map(([name, code], i) => sim.addCharacter({ name, type: ["ranger", "warrior", "mage"][i], code, fps: 10 }));
	assert.ok(await sim.until(async () => (await Promise.all(cs.map((c) => c.query("!!(character && code_active)")))).every(Boolean), 60000));
	threads || sim.live.tick(); // the base (client threads: taken in the window loop already)
	for (let i = 0; i < 25; i++) await sim.run(1000), threads || sim.live.tick(); // (single-thread: probe() once a game second)
	const calls = await cs[0].query("window.__runner.calls");
	await sim.close();
	const f = fs.readdirSync(dir).find((x) => /--\d+\.json$/.test(x));
	return { s: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")), calls };
}
function checkReport({ s, calls }) {
	const by = Object.fromEntries(s.players.map((p) => [p.name, p]));
	assert.deepEqual([by.AnyA.modes_from, by.AnyA.code_status, by.AnyA.role, Object.keys(by.AnyA.modes || {})], ["chronal", { calls: 1 }, "support", ["idle"]]);
	assert.deepEqual([by.AnyB.modes_from, by.AnyB.code_status, by.AnyB.role, by.AnyB.modes], [null, null, "tank", null]); // (a warrior: tank by class)
	assert.deepEqual([by.AnyC.modes_from, by.AnyC.code_status, by.AnyC.role, by.AnyC.modes], [null, null, "dps", null]);
	assert.deepEqual(Object.fromEntries(s.roster.map((r) => [r.name, r.role])), { AnyA: "dps", AnyB: "tank", AnyC: "dps" }); // roster: by class, never the CODE's
	assert.equal(s.notes.chronal, "AnyA: status disabled (scheduled a timer)");
	assert.equal(calls.status, 1, "the impure status getter is not called again");
	assert.equal(calls.fired, 1);
	assert.ok(calls.role >= 2 && calls.role <= 25000 / STATUS_MS + 1, `role read every ${STATUS_MS} ms: ${calls.role}`);
	assert.ok(calls.mode >= 25, `mode read: ${calls.mode}`);
}

test("single-thread Sim: probe() reads chronal (else nothing) through guarded(); an impure getter once", { skip: !fs.existsSync(ROOT) && "no " + ROOT }, async () => {
	checkReport(await runReport(false));
});

test("client threads: the same through client_worker.js and w.modes", { skip: !fs.existsSync(ROOT) && "no " + ROOT }, async () => {
	checkReport(await runReport(true));
});

// the base: the first probe with every character in game, a game time: identical runs measure the same (it was the first
// snapshot's, a real time); its snapshot starts the history at t 0
test("client threads: the base at the first probe with every character in game: two identical runs, the same measured_ms", { skip: !fs.existsSync(ROOT) && "no " + ROOT, timeout: 120000 }, async () => {
	const once = async () => {
		const sim = await createSim({ root: ROOT, seed: 5, threads: true, live: { dir: tmp(), tag: "base test" } });
		const cs = ["BaseA", "BaseB"].map((name, i) => sim.addCharacter({ name, type: ["ranger", "priest"][i], code: "var x = 1;", fps: 10 }));
		assert.ok(await sim.until(async () => (await Promise.all(cs.map((c) => c.query("!!(character && code_active)")))).every(Boolean), 60000));
		const v0 = sim.live.v0,
			at = sim.live.base && sim.live.base.at;
		await sim.run(40000);
		await sim.close();
		return { at: at - v0, s: JSON.parse(fs.readFileSync(sim.live.file, "utf8")) };
	};
	const a = await once(),
		b = await once();
	assert.ok(a.at > 0, "taken during the login, before sim.until() returned");
	assert.deepEqual([b.at, b.s.measured_ms, b.s.virtual_ms], [a.at, a.s.measured_ms, a.s.virtual_ms]);
	assert.ok(a.s.measured_ms > 40000 && a.s.measured_ms < a.s.virtual_ms, `${a.s.measured_ms} of ${a.s.virtual_ms}`);
	assert.deepEqual(a.s.players.map((p) => [p.measured_ms, p.history[0][0]]), [[a.s.measured_ms, 0], [a.s.measured_ms, 0]]);
});
