"use strict";
// client_host.js on both sims (single-thread and client threads): load_code runs a slot as the game does (a <script>
// appended to the CODE's document: at once, at its top level, its errors the window's); a slot the setup doesn't give
// fails the run (sim.failed, the snapshot's end "failed" naming the character and the slot, chronal run and
// tools/fingerprint.js exit 1, --check warns of it).
//   node --test test/client.test.js      (needs the game: config al_root, chronal install)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { createSim } = require("../sim/sim");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "client-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

const FILES = {
	util: "var UTIL = 1; function twice(x) { return 2 * x; } const UTIL_C = 'top';\n",
	count: "var LOADS = (typeof LOADS === 'number' ? LOADS : 0) + 1;\n",
	broken: "var BEFORE = 1; throw new Error('broken slot'); var AFTER = 2;\n",
};
const CODE = `var order = [];
load_code("util");
order.push(UTIL, twice(21), UTIL_C, document.getElementsByTagName("head")[0].childNodes.length);
load_code("count"); load_code("count");
order.push(LOADS);
load_code("broken");
order.push(BEFORE, typeof AFTER === "undefined" ? "hoisted" : AFTER);`;

async function boot(threads, code, files, live) {
	const sim = await createSim({ root: ROOT, seed: 1, threads, live: live || false });
	const c = sim.addCharacter({ name: "Load1", type: "mage", code, fps: 10, files });
	await sim.until(async () => sim.halted || (await c.query("!!(character && code_active)")), 60000);
	return { sim, c };
}

for (const threads of [false, true])
	test(`load_code (${threads ? "client threads" : "single-thread"}): a slot at the CODE's top level, at once, every call; its errors are the window's, not the caller's`, { skip, timeout: 120000 }, async () => {
		const { sim, c } = await boot(threads, CODE, FILES);
		try {
			await sim.run(2000);
			assert.deepEqual(await c.query("window.__runner.order"), [1, 42, "top", 1, 2, 1, "hoisted"]);
			assert.ok(await c.query("(window.game_logs || []).some((x) => /broken slot/.test(x[0]))"), "the slot's error in the game log (runner.html's window.onerror does the same)");
			assert.equal(sim.failed, null);
		} finally {
			await sim.close();
		}
	});

for (const threads of [false, true])
	test(`a slot the setup doesn't give (${threads ? "client threads" : "single-thread"}): the run fails, naming the character and the slot`, { skip, timeout: 120000 }, async () => {
		const dir = tmp();
		const { sim, c } = await boot(threads, "setTimeout(function () { require_code(\"nosuch\"); }, 5000);", { util: FILES.util }, { dir, tag: "missing" });
		await sim.run(30000);
		assert.equal(sim.failed, 'Load1: require_code("nosuch"): the setup gives Load1 no slot nosuch (its slots: util)');
		assert.equal(sim.halted, "failed");
		assert.ok(!(await c.query("(window.game_logs || []).some((x) => /ECONNREFUSED|NetworkError/.test(x[0]))")));
		await sim.close();
		const s = JSON.parse(fs.readFileSync(sim.live.file, "utf8"));
		assert.deepEqual([s.done, s.end], [false, { reason: "failed", detail: sim.failed }]); // (not done, as a run whose process died)
	});

test("chronal run: a CODE that asks for a slot the setup doesn't give exits 1 (at the start or later; the run ends failed); --check warns of the literal names", { skip, timeout: 120000 }, () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, "lib"));
	fs.writeFileSync(path.join(d, "lib", "util.js"), "var u = require_code('deep');\n");
	fs.writeFileSync(path.join(d, "lib", "deep.js"), "module.exports = 1;\n");
	fs.writeFileSync(path.join(d, "miss.js"), "load_code('util'); var x = require_code(\"nosuch\"); var y = require_code('UTIL'); var z = require_code(name);\n");
	fs.writeFileSync(path.join(d, "later.js"), "setTimeout(function () { load_code('later_slot'); }, 30000);\n");
	const run = (file, ...a) => spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", "--code", path.join(d, file), "--dir", path.join(d, "lib"), "--class", "mage", ...a], { encoding: "utf8", env: { ...process.env, LIVE: "" } });
	const check = run("miss.js", "--check");
	assert.equal(check.status, 0, check.stderr);
	assert.deepEqual(JSON.parse(check.stdout).warnings, ["Mage1: its CODE calls require_code(\"nosuch\"), and the setup gives it no slot nosuch: the run fails there"]);
	for (const [file, msg] of [["miss.js", 'require_code("nosuch"): the setup gives Mage1 no slot nosuch'], ["later.js", 'load_code("later_slot"): the setup gives Mage1 no slot later_slot']]) {
		const live = path.join(d, "live-" + file),
			r = run(file, "--duration", "2m", "--live", live);
		assert.equal(r.status, 1, r.stdout + r.stderr);
		assert.ok(r.stderr.includes(`FAILED: ${file === "miss.js" ? "Error: " : ""}Mage1: ${msg} (its slots: deep, util)`), r.stderr);
		const f = fs.readdirSync(live).find((x) => /--\d+\.json$/.test(x));
		assert.deepEqual(JSON.parse(fs.readFileSync(path.join(live, f), "utf8")).end, { reason: "failed", detail: `Mage1: ${msg} (its slots: deep, util)` });
	}
});

test("tools/fingerprint.js (SETUP): a slot the setup doesn't give exits 1 once the run has failed", { skip, timeout: 120000 }, () => {
	const d = tmp();
	fs.mkdirSync(path.join(d, "later"));
	fs.writeFileSync(path.join(d, "later", "main.js"), "setTimeout(function () { load_code('later_slot'); }, 30000);\n");
	fs.writeFileSync(path.join(d, "later.json"), JSON.stringify({ format: "chronal-setup/1", name: "later", characters: [{ name: "Mage1", class: "mage", code: { dir: "later", entry: "main" } }] }));
	const r = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "fingerprint.js")], { encoding: "utf8", env: { ...process.env, LIVE: "", SETUP: path.join(d, "later.json"), MINUTES: "3", SEED: "1" } });
	assert.equal(r.status, 1, r.stdout + r.stderr);
	assert.ok(r.stderr.includes('FAILED: Mage1: load_code("later_slot"): the setup gives Mage1 no slot later_slot (its slots: main)'), r.stderr);
	assert.equal(r.stdout.split("\n").filter(Boolean).length, 0, "no fingerprint line for the minute it failed in");
});


// get_browser_data()'s keys, read from the game's main.js (an upstream change to them shows here)
function browserKeys() {
	const src = fs.readFileSync(path.join(ROOT, "main.js"), "utf8"),
		body = src.slice(src.indexOf("async function get_browser_data"));
	return [...body.slice(body.indexOf("return {"), body.indexOf("};")).matchAll(/^\s*(\w+):/gm)].map((m) => m[1]);
}

for (const threads of [false, true])
	test(`the client's G (${threads ? "client threads" : "single-thread"}) is what /data.js serves: its keys, the design's tables (drops, upgrades, compounds, monster_gold), items and monsters as designed`, { skip, timeout: 120000 }, async () => {
		const { sim, c } = await boot(threads, "", {});
		try {
			const g = JSON.parse(await c.query(`JSON.stringify({ keys: Object.keys(G), drops: !!G.drops && !!G.drops.monsters, upgrades: !!G.upgrades && !!G.compounds, gold: !!G.monster_gold,
				hpot0: Object.keys(G.items.hpot0), goo: "c" in G.monsters.goo, version: G.version })`));
			const keys = browserKeys();
			assert.deepEqual(g.keys.slice(0, keys.length), keys);
			assert.deepEqual(g.keys.slice(keys.length), ["quests", "base_gold"]); // (the client's own: old_common_functions.js, game.js's welcome)
			assert.ok(g.drops && g.upgrades && g.gold);
			// the server's own fields aren't there (the client adds charge, max_hp, buy, id, xcx itself: process_game_data)
			assert.ok(!g.hpot0.some((k) => ["igrade", "igrace", "a"].includes(k)), "items as designed: " + g.hpot0);
			assert.equal(g.goo, false);
			assert.equal(g.version, sim.server.G.version);
		} finally {
			await sim.close();
		}
	});

test("a host's own client thread script (login worker, extra): it runs for the character, again when its page loads again; extra reaches it, the sim's own workerData fields win", { skip, timeout: 180000 }, async () => {
	const dir = tmp(),
		mark = path.join(dir, "marks.txt"),
		worker = path.join(dir, "host-worker.js");
	// a host's script: notes what it got, then speaks the protocol by running chronal's own thread
	fs.writeFileSync(worker, `const { workerData: w } = require("node:worker_threads");
require("node:fs").appendFileSync(w.mark, JSON.stringify({ name: w.fixture.name, root: w.root === ${JSON.stringify(ROOT)}, host: w.host }) + "\\n");
require(${JSON.stringify(path.join(__dirname, "..", "sim", "client_worker.js"))});
`);
	const sim = await createSim({ root: ROOT, seed: 1, threads: true, live: false });
	try {
		const c = sim.addCharacter({ name: "Host1", type: "ranger", code: "setTimeout(() => disconnect(), 60000);", fps: 10, worker, extra: { mark, host: "mine", root: "not the sim's" } });
		await sim.until(async () => sim.halted || (await c.query("!!(character && code_active)")), 60000);
		await sim.run(90000);
		const marks = fs.readFileSync(mark, "utf8").trim().split("\n").map((l) => JSON.parse(l));
		assert.deepEqual(marks, [{ name: "Host1", root: true, host: "mine" }, { name: "Host1", root: true, host: "mine" }]);
		const now = sim.clients.findLast((x) => x.name === "Host1" && x.online !== false);
		assert.ok(now && (await now.query("!!character")), "in game again after its reload");
		assert.equal(sim.failed, null);
	} finally {
		await sim.close();
	}
});

test("a failing hook of chronal's (its measuring code around a game function) is reported, not swallowed: once on the console, counted in the snapshot's hook_errors and notes.chronal; CHRONAL_STRICT_HOOKS=1: the process exits 1", { skip, timeout: 120000 }, async () => {
	const sim = await createSim({ root: ROOT, seed: 1, threads: true, live: { dir: tmp(), tag: "hookerr" } }),
		warn = console.warn,
		said = [],
		exit0 = process.exitCode,
		strict0 = process.env.CHRONAL_STRICT_HOOKS;
	try {
		process.env.CHRONAL_STRICT_HOOKS = "1";
		console.warn = (...a) => said.push(a.join(" "));
		// (a game function the hook wraps that changed: here the measuring code itself throws)
		sim.live.open = () => {
			throw new Error("the game changed");
		};
		const c = sim.addCharacter({ name: "Hook1", type: "ranger", code: "setInterval(() => move(character.x + (Math.random() < 0.5 ? 10 : -10), character.y), 500);", fps: 10 });
		await sim.until(async () => sim.halted || (await c.query("!!(character && code_active)")), 60000);
		await sim.run(20000);
		const snap = sim.live.peek();
		assert.ok(snap.hook_errors.instance_block_action && snap.hook_errors.instance_block_action.n > 1, JSON.stringify(snap.hook_errors));
		assert.match(snap.hook_errors.instance_block_action.first, /the game changed/);
		assert.match(snap.notes.chronal, /hook instance_block_action failed \d+x: Error: the game changed/);
		assert.equal(said.filter((l) => /chronal's hook instance_block_action failed/.test(l)).length, 1, "printed once");
		assert.equal(process.exitCode, 1);
		assert.equal(sim.failed, null, "the run itself goes on");
	} finally {
		console.warn = warn;
		process.exitCode = exit0;
		if (strict0 === undefined) delete process.env.CHRONAL_STRICT_HOOKS;
		else process.env.CHRONAL_STRICT_HOOKS = strict0;
		await sim.close();
	}
});

test("the fake socket.io server: to(ids) emits to those sockets only (a room per socket id, as emit_fanout sends), a named room reaches nobody; engine takes the game's per-tick flush hook (#1)", () => {
	const { ServerIO } = require("../sim/fake_io");
	const io = new ServerIO({}, "/socket.io/"),
		got = [];
	for (const id of ["a", "b", "c"]) io.sockets.set(id, { emit: (e, d) => got.push([id, e, d]) });
	assert.equal(io.to(["a", "c"]).emit("x", 1), true);
	io.to("b").emit("y", 2);
	io.to("roulette").emit("bet", 3);
	assert.deepEqual(got, [["a", "x", 1], ["c", "x", 1], ["b", "y", 2]]);
	assert.doesNotThrow(() => io.engine.on("connection", () => {}));
});
