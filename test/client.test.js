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

