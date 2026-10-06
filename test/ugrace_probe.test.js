"use strict";
// tools/ugrace: invert() against the server's formula (forward() below, the upgrade handler's with a scroll and no
// offering) over levels, grades, grace and scrolls; then the probe CODE on a real sim with world.ugrace set and held:
// it reads back what the setup gave, per level, from items of both grades, with and without grace of their own.
//   node --test test/ugrace_probe.test.js       (the last test needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawn } = require("node:child_process");
const { invert, summarize, worldUgrace, recordsOf } = require("../tools/ugrace/invert");
const { config } = require("../lib/config");

const DIR = path.join(__dirname, ".."),
	ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;
// the server's G.upgrades (design/upgrades.js)
const UP = (() => {
	const vm = require("node:vm"), c = {};
	vm.createContext(c);
	vm.runInContext(fs.readFileSync(path.join(ROOT, "design", "upgrades.js"), "utf8") + ";this.U = upgrades;", c);
	return c.U;
})();

// the server's chance (server.js, the upgrade handler; pug: the character's own grace at L, og: its offering grace)
function forward({ L, p, grace, igrace, term, high, pug = 0, og = 0 }) {
	let g = Math.max(0, Math.min(L + 1, grace + Math.min(3, pug / 4.5) + igrace) + term + og / 3.2);
	g = (p * g) / L + g / 1000;
	let prob = high ? p * 1.2 + 0.01 : p;
	prob += Math.max(0, g / 4.8 - 0.4 / ((L - 0.999) * (L - 0.999)));
	return high ? Math.min(prob, p + 0.36, p * 3) : Math.min(prob, p + 0.24, p * 2);
}

test("invert: the server's grace term back from its chance, wherever the chance shows it (else floor with its bound, or cap)", { skip }, () => {
	const n = { ok: 0, floor: 0, cap: 0 };
	for (let L = 2; L <= 12; L++)
		for (const igrade of [0, 1, 2])
			for (const grace of [0, 1.5, 4])
				for (const term of [0, 1 / 3, 1, 2.5, 4, 17 / 3, 6])
					for (const high of L <= 10 ? [false, true] : [false]) {
						const x = { L, p: UP[igrade][L], grace, igrace: { 0: 1, 1: -1, 2: -2 }[igrade], high };
						x.chance = forward({ ...x, term });
						const v = invert(x), what = JSON.stringify({ ...x, term, v });
						n[v.state]++;
						if (v.state === "ok") {
							assert.ok(Math.abs(v.term - term) < 1e-9, what);
							assert.ok(term < 6 ? Math.abs(v.ugrace - 3 * term) < 1e-8 : v.ugrace === null, what);
						} else if (v.state === "floor") assert.ok(term <= v.t_max + 1e-9 || Math.min(L + 1, grace + x.igrace) + term <= 0, what);
						else assert.equal(v.state, "cap", what);
					}
	assert.ok(n.ok > 500 && n.floor > 50 && n.cap > 50, JSON.stringify(n));
	// at the floor with a bound under 1: 0 (the server's values are whole), as live's first readings had it (EU IV,
	// 2026-10-05: a +3 bow at 0.7 exactly, S.ugrace <= 0.63); a high grade +3 at its floor only bounds it (<= 6.7)
	assert.deepEqual(invert({ L: 4, p: 0.7, grace: 0, igrace: 1, high: false, chance: 0.7 }), { state: "ok", term: 0, ugrace: 0, floor: true });
	const hi = invert({ L: 4, p: 0.68, grace: 0, igrace: -1, high: false, chance: 0.68 });
	assert.ok(hi.state === "floor" && Math.abs(3 * hi.t_max - 6.74) < 0.01, JSON.stringify(hi));
	// a character with grace of its own (it upgraded): read too high, past 6 "off"
	const x = { L: 6, p: UP[0][6], grace: 0, igrace: 1, high: false };
	assert.equal(invert({ ...x, chance: forward({ ...x, term: 6, pug: 9 }) }).state, "off");
});

test("summarize: by round (items of one time agree, a reading twice counts once), floors at their bound, min, median, max (>= 18 apart), mean; world.ugrace", () => {
	const x = (t, num, L, term, grace = 0) => ({ t, num, L, p: UP[0][L], grace, igrace: 1, high: false, chance: forward({ L, p: UP[0][L], grace, igrace: 1, term, high: false }) });
	const rows = summarize([
		x("a", 1, 5, 2), x("a", 2, 5, 2, 1.5), x("a", 2, 5, 2, 1.5), x("b", 1, 5, 3), x("c", 1, 5, 6), // L5: 6, 9, >= 18
		x("a", 3, 7, 4 / 3), x("b", 3, 7, 0), x("c", 3, 7, 1 / 3), // L7: 4, then 0 and 1 at the floor (at most 1: half of it in mean)
	]);
	const pick = (r) => [r.L, r.n, r.rounds, r.solved, r.floor, r.min, r.median, r.max, r.saturated, +r.mean.toFixed(9), r.spread < 1e-9, r.frac < 1e-9];
	assert.deepEqual(rows.map(pick).map((a) => a.map((v) => (typeof v === "number" && Number.isFinite(v) ? +v.toFixed(9) : v))), [
		[5, 4, 3, 3, 0, 6, 9, Infinity, 0.333333333, 11, true, true],
		[7, 3, 3, 1, 2, 1, 1, 4, 0, 1.666666667, true, true],
	]);
	assert.deepEqual(worldUgrace(rows), { 5: 11, 7: 1.7 });
	// two items apart at one time: the spread and the rounds apart show it
	const ap = summarize([x("a", 1, 5, 2), x("a", 2, 5, 2.5), x("b", 1, 5, 1), x("b", 2, 5, 1)])[0];
	assert.ok(ap.spread > 1.4 && ap.apart === 1, JSON.stringify(ap));
	// a level only bounded (every round at the floor) stays out of world.ugrace
	assert.deepEqual(worldUgrace(summarize([x("a", 3, 7, 0), x("a", 1, 5, 1)])), { 5: 3 });
});

test("the probe CODE on a real sim reads back world.ugrace (held) per level: both grades, with and without the item's grace, >= 18 as such", { skip, timeout: 240000 }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ugrace-probe-"));
	try {
		const UG = { 4: 4, 5: 10, 6: 13, 7: 30, 8: 7, 9: 16 },
			setup = path.join(dir, "probe.json");
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "ugrace-probe", run: { duration: "2m", warmup: "0m" }, world: { ugrace: UG, ugrace_fixed: true },
			characters: [{
				name: "Probe", class: "merchant", at: "main:-204:-129", code: { file: path.join(DIR, "tools", "ugrace", "probe.js") }, params: { ugrace_probe: { every_s: 20, hours: 0.02 } },
				state: {
					level: 20, gold: 0,
					items: [
						{ name: "coat", level: 3 }, { name: "helmet", level: 3, grace: 1.5 }, // L4 twice
						{ name: "shoes", level: 4 }, { name: "coat1", level: 4 }, // L5: normal and high grade
						{ name: "pants", level: 5 }, { name: "gloves", level: 6 }, { name: "blade", level: 7 }, // L6, L7, L8 (grade 1: scroll1)
						{ name: "bow", level: 8, grace: 3 }, // L9: read through its own grace
						{ name: "staff", level: 2, l: "l" }, // locked: not asked
						{ name: "scroll0", q: 1 }, { name: "scroll1", q: 1 },
					],
				},
			}],
		}));
		const out = await new Promise((resolve) => {
			const c = spawn(process.execPath, ["chronal.js", "run", setup, "--live", dir, "--no-export"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });
			let s = "";
			c.stdout.on("data", (d) => (s += d));
			c.stderr.on("data", (d) => (s += d));
			c.on("exit", (code) => resolve({ code, s }));
		});
		assert.equal(out.code, 0, out.s);
		const snap = path.join(dir, fs.readdirSync(dir).find((f) => /--\d+\.json$/.test(f))),
			[R] = recordsOf(snap);
		assert.ok(R, "the probe's record in code_status");
		assert.deepEqual(R.errors, []);
		assert.ok(R.rounds >= 3 && R.done, JSON.stringify({ rounds: R.rounds, done: R.done }));
		assert.equal(new Set(R.readings.map((r) => r.item)).has("staff"), false);
		assert.deepEqual([...new Set(R.readings.filter((r) => r.L === 8).map((r) => r.scroll))], ["scroll1"]);
		// nothing consumed: the scrolls and items are where they were (the readings named their slots)
		const s = JSON.parse(fs.readFileSync(snap, "utf8")).players.find((p) => p.name === "Probe");
		assert.equal(s.inventory.filter((it) => it && /^scroll/.test(it.name)).length, 2);
		const rows = summarize(R.readings);
		assert.deepEqual(rows.map((r) => r.L), [4, 5, 6, 7, 8, 9]);
		for (const r of rows) {
			assert.equal(r.solved, r.rounds, `level ${r.L}: every round solved`);
			assert.ok(r.spread < 1e-9, `level ${r.L}: items agree`);
			if (UG[r.L] >= 18) assert.deepEqual([r.min, r.max], [Infinity, Infinity], `level ${r.L}: >= 18`);
			else assert.ok(Math.abs(r.min - UG[r.L]) < 1e-9 && Math.abs(r.max - UG[r.L]) < 1e-9, `level ${r.L}: ${r.min}..${r.max} vs ${UG[r.L]}`);
		}
		assert.deepEqual(worldUgrace(rows), { 4: 4, 5: 10, 6: 13, 7: 18, 8: 7, 9: 16 });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
