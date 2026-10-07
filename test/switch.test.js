// Character switching on a real sim (threads mode): a page's start_character / stop_character / get_active_characters /
// command_character, a page reloading after its own disconnect(), setup characters with online: false, Lone Wolf as
// they come and go, the same run twice.
//   node --test test/switch.test.js      (needs the game: config al_root, chronal install)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const S = require("../lib/setup");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "switch-test-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const write = (f, text) => (fs.writeFileSync(path.join(dir, f), text), path.join(dir, f));

// Boss (a merchant, in game) starts and stops the others; A and B (online: false) only log what they see
write("boss.js", `
var L = (parent.__log = []), T0 = Date.now();
var log = (s) => L.push(Math.round((Date.now() - T0) / 1000) + " " + s);
setTimeout(() => {
	start_character("A").then((r) => log("A in " + r.name + " " + JSON.stringify(get_active_characters())), (e) => log("A failed " + e.reason));
	log("pending " + JSON.stringify(get_active_characters()));
}, 10000);
setTimeout(() => {
	start_character("Nope").catch((e) => log("Nope " + e.reason));
	start_character("A").then((r) => log("A again " + r.name));
	start_character("Boss").catch((e) => log("Boss " + e.reason));
}, 30000);
setTimeout(() => command_character("A", "parent.__cmd = character.name + ' ' + typeof smart_move"), 40000);
setTimeout(() => { stop_character("A"); log("stopped " + JSON.stringify(get_active_characters())); }, 60000);
setTimeout(() => start_character("B").then(() => log("B in"), (e) => log("B failed " + e.reason)), 90000);
setTimeout(() => start_character("A").then(() => log("A back"), (e) => log("A back failed " + e.reason)), 120000);
setTimeout(() => log("active " + JSON.stringify(get_active_characters())), 170000);
`);
write("a.js", `parent.__runs = (parent.__runs || 0) + 1;`);
write("b.js", `setTimeout(() => disconnect(), 60000);`);

async function run() {
	const { startSetup } = require("../sim/start");
	const s = S.loadSetup(write("setup.json", JSON.stringify({
		format: "chronal-setup/1", name: "switch", run: { seed: 3 }, world: { threads: true },
		characters: [
			{ name: "Boss", class: "merchant", code: { file: "boss.js" } },
			{ name: "A", class: "ranger", online: false, code: { file: "a.js" } },
			{ name: "B", class: "priest", online: false, code: { file: "b.js" } },
		],
	})));
	const { resolved, bundles } = S.resolveSetup(s);
	const { sim, clients, order } = await startSetup(resolved, bundles, { live: false, silent: true }); // (B's disconnect(): the game's raw socket events)
	const at = {},
		inGame = (n) => sim.clients.findLast((c) => c.name === n && c.online !== false) || null,
		lw = async (n) => { const c = inGame(n); return c ? await c.query("!!(character && character.s.encouragement_lonewolf)") : null; };
	try {
		assert.deepEqual(order.map((c) => c.name), ["Boss"], "only Boss is in game at the start");
		assert.deepEqual(Object.keys(clients), ["Boss"]);
		for (let t = 10; t <= 180; t += 10) {
			await sim.run(10_000);
			at[t] = { A: !!inGame("A"), B: !!inGame("B"), lwA: await lw("A"), lwB: await lw("B"), cmd: inGame("A") ? await inGame("A").query("window.__cmd || null") : null };
		}
		at.log = await clients.Boss.query("parent.__log");
		at.sessionsB = sim.clients.filter((c) => c.name === "B").length;
		at.runsA = await inGame("A").query("window.__runs");
		at.failed = sim.failed;
		return at;
	} finally {
		await sim.close();
	}
}

test("switching: start_character, stop_character, get_active_characters, command_character, a page reloading after disconnect(); the same run twice", { timeout: 180000 }, async (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const a = await run();
	assert.equal(a.failed, null);
	const log = a.log.map((x) => x.replace(/^\d+ /, ""));
	// the page's promise and iframe states, as the browser's
	assert.ok(log.includes('pending {"Boss":"self","A":"starting"}'), log.join("\n"));
	assert.ok(log.includes('A in A {"Boss":"self","A":"code"}'), log.join("\n"));
	assert.ok(log.includes("Nope character_not_found") && log.includes("A again A") && log.includes("Boss already_running"), log.join("\n"));
	assert.ok(log.includes('stopped {"Boss":"self"}'), log.join("\n"));
	assert.ok(log.includes("B in") && log.includes("A back"), log.join("\n"));
	// B's own disconnect() 60 s after its login: its page (the iframe) loads again 2.5 s later, as the game's does
	assert.ok(log.includes('active {"Boss":"self","B":"code","A":"code"}'), log.join("\n"));
	assert.equal(a.sessionsB, 2);
	// in game: A 10..60 and from 120, B 90..150 and from ~153
	assert.deepEqual([20, 50, 70, 110, 130, 140, 170].map((t) => [t, a[t].A, a[t].B]), [[20, true, false], [50, true, false], [70, false, false], [110, false, true], [130, true, true], [140, true, true], [170, true, true]]);
	// command_character ran in A's CODE
	assert.equal(a[50].cmd, "A function");
	// Lone Wolf: alone (the merchant doesn't count), not with the other fighter in game
	assert.equal(a[50].lwA, true);
	assert.equal(a[110].lwB, true);
	assert.equal(a[140].lwA, false);
	assert.equal(a[140].lwB, false);
	assert.equal(a[170].lwA, false);
	// A's CODE ran once in its second session (a new page)
	assert.equal(a.runsA, 1);
	const b = await run();
	assert.deepEqual(b, a, "the same seed and CODE: the same run");
});

test("setup: online false is validated, not counted in the account's limit, and kept in the side file", () => {
	const s = S.loadSetup(write("limits.json", JSON.stringify({
		format: "chronal-setup/1", world: { threads: true },
		characters: [
			{ name: "M", class: "merchant", code: { file: "boss.js" } },
			{ name: "F1", class: "ranger", code: { file: "a.js" } },
			{ name: "F2", class: "ranger", code: { file: "a.js" } },
			{ name: "F3", class: "ranger", code: { file: "a.js" } },
			{ name: "F4", class: "priest", online: false, code: { file: "a.js" } },
		],
	})));
	const { resolved } = S.resolveSetup(s, { build: false });
	assert.equal(resolved.characters.find((c) => c.name === "F4").online, false);
	assert.equal("online" in resolved.characters.find((c) => c.name === "F1"), false);
	assert.throws(() => S.loadSetup(write("bad.json", JSON.stringify({ format: "chronal-setup/1", characters: [{ name: "X", class: "ranger", online: "no", code: { file: "a.js" } }] }))), /online: true/);
	assert.throws(() => S.loadSetup(write("none.json", JSON.stringify({ format: "chronal-setup/1", characters: [{ name: "X", class: "ranger", online: false, code: { file: "a.js" } }] }))), /no character in game at the start/);
});
