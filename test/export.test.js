"use strict";
// sim/export.js + lib/continue.js: a run's state export (raw items and gear, server state, the whole bank, cash, age)
// and a setup that continues from it recreating the characters; an export on request (steering's export) changes
// nothing in the run.
//   node --test test/export.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const S = require("../lib/setup");
const { config } = require("../lib/config");
const { endState, writeState } = require("../sim/export");
const { continuation } = require("../lib/continue");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "export-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const IDLE = path.join(__dirname, "..", "codes", "idle.js");
const write = (d, f, v) => (fs.writeFileSync(path.join(d, f), typeof v === "string" ? v : JSON.stringify(v)), path.join(d, f));

test("end state: raw items (grace, locked), gear incl. a trade slot, p, the whole bank with its rooms, cash; a continuation recreates the characters", { skip, timeout: 180000 }, async () => {
	const { startSetup } = require("../sim/start");
	const d = tmp(),
		ug = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
	const setup = {
		format: "chronal-setup/1", name: "exp", run: { duration: "1m" }, world: { threads: false, start: "2026-03-01T00:00:00Z" },
		accounts: { a: { age_days: 3, cash: 11, bank: { gold: 900, items0: [{ name: "hpot1", q: 4 }], items1: [], items8: [{ name: "gem0", q: 1 }] } } },
		characters: [
			{ name: "Ran", class: "ranger", account: "a", at: "main:10:20", code: { file: IDLE }, state: { level: 40, gold: 1234, items: [{ name: "coat", level: 3, grace: 2 }, { name: "ringsj", level: 1, l: "l" }, null], slots: { mainhand: { name: "bow", level: 5 } }, p: { ugrace: ug, ograce: 4 } } },
			{ name: "Mer", class: "merchant", account: "a", at: "main:30:40", code: { file: IDLE }, state: { level: 30, slots: { trade1: { name: "hpot0", q: 10, price: 50 } } } },
		],
	};
	const { resolved, bundles } = S.resolveSetup(S.loadSetup(write(d, "setup.json", setup)), { build: false });
	const { sim } = await startSetup(resolved, bundles, { live: false });
	let st;
	try {
		await sim.run(3000);
		st = await endState(sim, resolved, { label: "end", run: "exp--1", seed: 1 });
	} finally {
		await sim.close();
	}
	const ran = st.files.Ran,
		mer = st.files.Mer;
	assert.equal(ran.format, "chronal-export/1");
	assert.deepEqual(ran.source, { from: "sim", run: "exp--1", label: "end", seed: 1, setup_key: null, in_game: true });
	assert.deepEqual(ran.character.items.slice(0, 2), [{ name: "coat", level: 3, grace: 2 }, { name: "ringsj", level: 1, l: "l" }]);
	assert.deepEqual(ran.character.slots.mainhand, { name: "bow", level: 5 });
	assert.equal(ran.character.level, 40);
	assert.equal(ran.character.gold, 1234);
	assert.deepEqual(ran.server.p.ugrace, ug);
	assert.equal(ran.server.p.ograce, 4);
	assert.ok(!Object.keys(ran.server.s).some((k) => k.startsWith("encouragement_")), "login-made conditions left out");
	assert.equal(mer.character.slots.trade1.name, "hpot0");
	assert.equal(mer.character.slots.trade1.price, 50);
	assert.deepEqual(ran.bank, { gold: 900, items0: [{ name: "hpot1", q: 4 }], items1: [], items8: [{ name: "gem0", q: 1 }], unlocked: { bank_b: true } });
	assert.equal(ran.account.cash, 11);
	assert.ok(Math.abs(ran.account.age_days - (3 + 3000 / 86400e3)) < 1e-4, "its age at the end: " + ran.account.age_days);
	// written, then continued: the characters as they were (state.from), the account (bank.from, age), the clock
	const live = tmp(),
		base = path.join(live, "exp--1"),
		dir = writeState(base + ".state", st);
	fs.writeFileSync(base + ".setup.json", JSON.stringify(resolved));
	const next = continuation(base + ".setup.json", dir, { duration: "2m" });
	assert.equal(next.world.start, st.at);
	assert.equal(next.run.duration, "2m");
	assert.deepEqual(next.accounts.a.bank, { from: path.join(dir, "Ran.json") });
	assert.equal(next.accounts.a.age_days, ran.account.age_days);
	assert.deepEqual(next.characters.map((c) => [c.name, c.at, c.state]), [["Ran", "main:10:20", { from: path.join(dir, "Ran.json") }], ["Mer", "main:30:40", { from: path.join(dir, "Mer.json") }]]);
	const r2 = S.resolveSetup(S.loadSetup(write(live, "next.json", next)), { build: false }).resolved;
	const over = S.characterOver(r2.characters[0]);
	assert.deepEqual(over.info.items.slice(0, 2), ran.character.items.slice(0, 2));
	assert.deepEqual(over.info.p.ugrace, ug);
	assert.equal(over.info.hp, ran.character.hp);
	assert.equal(S.accountUser(r2.accounts.a).cash, 11);
	assert.deepEqual(S.accountUser(r2.accounts.a).info.items8, [{ name: "gem0", q: 1 }]);
	// --reseed: that account as the run's setup gave it
	const re = continuation(base + ".setup.json", dir, { reseed: ["a"] });
	assert.deepEqual(re.accounts.a.bank, resolved.accounts.a.bank);
	assert.equal(re.characters[0].state.level, 40);
	assert.equal(re.characters[0].state.from, undefined);
});

test("an export on request (steering's export) is written and listed, and changes nothing in the run", { skip, timeout: 300000 }, () => {
	const d = tmp();
	const run = (steer, live) => {
		const f = write(d, `s${live.length}.json`, { format: "chronal-setup/1", name: "ex", run: { duration: "2m" }, characters: [{ name: "Ran", class: "ranger", code: { file: path.join(__dirname, "..", "codes", "example", "farm.js") }, state: { level: 20 }, params: { farm: { monsters: ["goo"] } } }], ...(steer ? { steer } : {}) });
		const res = path.join(live, "r.json"),
			r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", f, "--live", live, "--result", res, "--no-build"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		return JSON.parse(fs.readFileSync(res, "utf8"));
	};
	const a = run(null, tmp()),
		bl = tmp(),
		b = run([{ at: "1m", export: "mid" }], bl);
	const snap = JSON.parse(fs.readFileSync(b.live, "utf8"));
	assert.deepEqual(snap.state.exports.map((e) => e.label), ["mid", "end"]);
	assert.ok(fs.existsSync(path.join(b.state, "..", "mid", "Ran.json")));
	const pick = (r) => ({ level: r.characters.Ran.level, xp: r.characters.Ran.xp, gold: r.characters.Ran.gold, kills: r.characters.Ran.kills, map: r.characters.Ran.map });
	assert.deepEqual(pick(b), pick(a));
});
