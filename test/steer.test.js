"use strict";
// steer.js: what a condition reads (refsOf), a character's record from a snapshot entry (contextOf), the steps' states
// (at, when with for and repeat, after), rates over a window, run.until; setup.js's checks of a steer list.
//   node --test test/steer.test.js
const test = require("node:test"),
	assert = require("node:assert/strict");
const X = require("../lib/steer");
const S = require("../lib/setup");

// a snapshot as sim/live.js writes it (docs/reference/snapshot.md players[], banks)
const snap = (o = {}) => ({
	measured_ms: 120_000,
	banks: { acc: { gold: 5000, free: 3 } },
	players: [
		{
			name: "Ran", type: "ranger", online: true, rip: false, level: 12, start_level: 10, xp: 50, max_xp: 900, xp_gained: 4000, hp: 300, mp: 40, stats: { max_hp: 600, max_mp: 80 },
			gold: 1500, gold_start: 1000, map: "main", x: 1, y: 2, party: { name: "Ran" }, kills: 7, kills_by: { goo: 5, bee: 2 }, last_kill: 100, deaths: 1,
			dmg: { done: { net: 900 }, taken: { net: 120 } }, free: 30, hpots: 3, mpots: 2, trips: 0, chests: { opened: 4 },
			inventory: [{ name: "hpot0", q: 150 }, null, { name: "bow", level: 3 }, { name: "hpot0", q: 50 }], gear: { mainhand: "bow+7", helmet: "helmet+0" },
			items: { looted: { seashell: 6, gem0: 1 }, consumed: { hpot0: 3 }, upgraded: { bow: { ok: 2, fail: 1 }, coat: { ok: 1, fail: 0 } }, compounded: { ringsj: { ok: 0, fail: 2 } } },
			s: ["mluck", "encouragement_lonewolf"], mode: "farm", code_status: { target: "goo" }, ...o,
		},
	],
});
const ctx = (o = {}) => X.contextOf(snap(o.p), { names: ["Ran", "Mer"], accountOf: () => "acc", t: 120, starts: { Mer: { level: 44, gold: 9, map: "main" } }, ...o });

test("refsOf: the characters, steps and what a condition needs read besides the snapshot", () => {
	assert.deepEqual(X.refsOf('c.Ran.kills.goo > 3 && c.Mer.near.bee && steps.boss && c.Ran.get("mode") == "x" && c.Ran.get(\'k2\')'), { chars: ["Ran", "Mer"], steps: ["boss"], near: true, get: ["mode", "k2"], log: false, events: false, server: false, rate: false });
	assert.deepEqual(X.refsOf("c.Ran.log(/x/) || world.events.goobrawl || world.alive.franky || c.Ran.rate.xp_h < 1"), { chars: ["Ran"], steps: [], near: false, get: [], log: true, events: true, server: true, rate: true });
	assert.throws(() => X.compile("c.Ran.kills >"), SyntaxError);
});

test("contextOf: a character's record from its snapshot entry (counts read 0 when missing), its account's bank, one never in game, the pages' and the server's reads", () => {
	const c = ctx({ pages: { Ran: { near: { bee: 2 }, near_level: { bee: 4 }, get: { mode: "boss" } } }, logs: { Ran: ["You killed a Goo", "Out of potions", "out of potions"] }, server: { alive: { franky: 1 }, level: { franky: 3 } }, events: { goobrawl: { live: true } } });
	const r = c.c.Ran;
	assert.deepEqual([r.level, r.levels, r.xp_gained, r.gold, r.gold_gained, r.hp, r.max_hp, r.mp, r.max_mp, r.party, r.online, r.rip, r.map], [12, 2, 4000, 1500, 500, 300, 600, 40, 80, "Ran", true, false, "main"]);
	assert.deepEqual([r.kills.total, r.kills.goo, r.kills.bee, r.kills.squigtoad, r.deaths, r.since_kill], [7, 5, 2, 0, 1, 20]);
	assert.deepEqual([r.items.hpot0, r.items.bow, r.items.nothing, r.free, r.best.bow, r.best.helmet, r.best.nothing], [200, 1, 0, 30, 7, 0, -1]);
	assert.deepEqual([r.looted.seashell, r.looted.total, r.looted.x, r.used.hpot0, r.drunk, r.chests, r.trips], [6, 7, 0, 3, 5, 4, 0]);
	assert.deepEqual([r.upgrades, r.compounds], [{ ok: 3, fail: 1, total: 4 }, { ok: 0, fail: 2, total: 2 }]);
	assert.deepEqual([r.bank_free, r.bank_gold, r.dmg_done, r.dmg_taken], [3, 5000, 900, 120]);
	assert.deepEqual([r.s.mluck, r.s.encouragement_lonewolf, r.s.newcomersblessing, r.mode, r.status.target], [true, true, false, "farm", "goo"]);
	assert.deepEqual([r.near.bee, r.near.goo, r.near_level.bee, r.near_level.goo, r.get("mode"), r.get("nope")], [2, 0, 4, -1, "boss", null]);
	assert.deepEqual([r.log(/Out of/), r.log("[Oo]ut of"), r.log(/Goo$/)], [1, 2, 1]);
	assert.deepEqual([c.world.alive.franky, c.world.alive.goo, c.world.level.franky, c.world.level.goo, !!c.world.events.goobrawl, c.world.events.holiday], [1, 0, 3, -1, true, false]);
	// never in game (not in the snapshot): its start, online false, nothing counted
	const m = c.c.Mer;
	assert.deepEqual([m.online, m.level, m.levels, m.gold, m.gold_gained, m.kills.total, m.map, m.bank_free], [false, 44, 0, 9, 0, 0, "main", 3]);
	// a condition over it
	assert.equal(X.compile("c.Ran.kills.goo >= 5 && c.Ran.looted.seashell > 5 && !c.Ran.s.newcomersblessing && c.Mer.online === false")(c.c, 120, c.world, {}), true);
});

test("party: the run's characters together (counts summed, the highest level of an item, the fewest s since a kill, how many in game and dead, each account's bank once), rates summed", () => {
	const two = snap();
	two.players.push({ ...two.players[0], name: "Pri", type: "priest", kills: 3, kills_by: { goo: 1, crab: 2 }, last_kill: 115, rip: true, free: 12, inventory: [{ name: "bow", level: 9 }], gear: {}, items: { looted: { seashell: 1 }, upgraded: {}, compounded: {} } });
	const c = X.contextOf(two, { names: ["Ran", "Pri", "Mer"], accountOf: () => "acc", t: 120, starts: { Mer: { level: 44 } } }),
		p = c.party;
	assert.deepEqual([p.size, p.online, p.dead], [3, 2, 1], "(Mer never in game)");
	assert.deepEqual([p.kills.total, p.kills.goo, p.kills.bee, p.kills.crab, p.kills.squigtoad, p.deaths, p.since_kill], [10, 6, 2, 2, 0, 2, 5]);
	assert.deepEqual([p.looted.seashell, p.looted.total, p.items.hpot0, p.free, p.best.bow, p.best.nope, p.upgrades, p.compounds], [7, 8, 200, 42, 9, -1, { ok: 3, fail: 1, total: 4 }, { ok: 0, fail: 2, total: 2 }]);
	assert.deepEqual([p.bank_free, p.bank_gold, p.gold_gained, p.levels], [3, 5000, 1000, 4], "the account's bank once");
	assert.equal(X.compile("party.kills.total >= 10 && party.dead > 0 && party.kills.goo == 6")(c.c, 0, c.world, {}, p), true);
	// rates: theirs summed (5 kills a minute each: 300/h each, 600/h together)
	const st = new X.Steering([], { until: "party.rate.kills_h >= 600" });
	assert.equal(st.check(0, c, 0).until, false);
	two.players[0].kills = 12;
	assert.equal(st.check(60_000, X.contextOf(two, { names: ["Ran", "Pri"], t: 180 }), 60).until, false, "Ran's 300/h alone");
	two.players[0].kills = 17;
	two.players[1].kills = 13;
	assert.equal(st.check(120_000, X.contextOf(two, { names: ["Ran", "Pri"], t: 240 }), 120).until, true, "(over 2 min: Ran 10, Pri 10)");
});

test("Steering: at steps due once, in time order; after steps a while after each firing of theirs", () => {
	const st = new X.Steering([{ at: "2m", code: "a" }, { name: "b", at: "30s", code: "b" }, { after: "b", at: "10s", code: "c" }, { name: "d", after: "b", code: "d" }, { after: "d", at: "1m", code: "e" }]);
	assert.equal(st.next(), 30_000);
	assert.deepEqual(st.due(29_999), []);
	const due = st.due(30_000);
	assert.deepEqual(due.map((x) => x.s.e.code), ["b"]);
	st.fired(due[0].s, 30_000);
	assert.deepEqual(st.due(30_000).map((x) => [x.s.e.code, x.at]), [["d", 30_000]], "after with no while: at once");
	st.fired(st.steps[3], 30_000);
	assert.equal(st.next(), 40_000);
	assert.deepEqual(st.due(200_000).map((x) => [x.s.e.code, x.at]), [["c", 40_000], ["e", 90_000], ["a", 120_000]]);
	assert.deepEqual([st.due(300_000), st.next()], [[], Infinity]);
	assert.deepEqual(st.stepsNow(), { b: { n: 1, t: 30 }, d: { n: 1, t: 30 } });
});

test("Steering: when steps fire once when their condition holds, held `for` first; repeat: again each time it holds anew; steps.<name>; an error reads as false (kept)", () => {
	let goo = 0,
		mode = "farm";
	const c = () => ctx({ p: { kills_by: { goo }, mode } });
	const st = new X.Steering([
		{ name: "g", when: "c.Ran.kills.goo >= 3", code: "1" },
		{ when: "c.Ran.kills.goo >= 3", for: "30s", code: "2" },
		{ when: 'c.Ran.mode == "rest"', repeat: true, code: "3" },
		{ when: "steps.g && steps.g.n > 0", code: "4" },
		{ when: "c.Nobody.kills.goo > 1", code: "5" },
	]);
	const fire = (t) => st.check(t, c()).fire.map((s) => (st.fired(s, t), s.e.code));
	assert.deepEqual(fire(0), []);
	goo = 3;
	assert.deepEqual(fire(10_000), ["1"]);
	assert.deepEqual(fire(20_000), ["4"], "(steps.g: fired at 10 s)");
	assert.deepEqual(fire(30_000), []);
	assert.deepEqual(fire(40_000), ["2"], "held 30 s (from 10 s)");
	assert.deepEqual(fire(50_000), [], "each once");
	mode = "rest";
	assert.deepEqual(fire(60_000), ["3"]);
	assert.deepEqual(fire(70_000), [], "still holding: not again");
	mode = "farm";
	assert.deepEqual(fire(80_000), []);
	mode = "rest";
	assert.deepEqual(fire(90_000), ["3"], "holds anew");
	assert.equal(st.steps[4].error, "Cannot read properties of undefined (reading 'kills')");
	assert.equal(st.waiting(), true, "a repeat step keeps waiting");
	// for: broken by a check where it doesn't hold
	let on = true;
	const f = new X.Steering([{ when: "c.Ran.online && t >= 0 && ON()", for: "20s", code: "x" }]);
	global.ON = () => on;
	const fire2 = (t) => f.check(t, c()).fire.map((s) => s.e.code);
	assert.deepEqual([fire2(0), fire2(10_000)], [[], []]);
	on = false;
	assert.deepEqual(fire2(20_000), []);
	on = true;
	assert.deepEqual([fire2(30_000), fire2(40_000), fire2(50_000)], [[], [], ["x"]]);
	delete global.ON;
	assert.equal(f.waiting(), false, "done");
});

test("Steering: rates over a step's window (per hour: xp, kills, gold, loot; per s: damage done and taken); run.until with its own t", () => {
	const st = new X.Steering([{ when: "c.Ran.rate.kills_h >= 600", window: "1m", code: "fast" }], { until: "c.Ran.rate.xp_h > 0 && t >= 30" });
	const at = (t, kills, xp) => st.check(t, ctx({ p: { kills, xp_gained: xp, kills_by: {} } }), t / 1000 - 60);
	assert.deepEqual(at(0, 0, 0), { fire: [], until: false });
	assert.deepEqual(at(60_000, 5, 3600).fire, [], "5 kills in 1 min: 300/h");
	assert.equal(at(60_000, 5, 3600).until, false, "(its t: 0)");
	const r = at(120_000, 15, 3600); // (10 in the last minute: 600/h; until's rates over 10 min: xp from 0)
	assert.deepEqual([r.fire.map((s) => s.e.code), r.until], [["fast"], true]);
	assert.equal(st.check(190_000, ctx(), null).until, false, "(untilT null: not checked)");
});

test("setup.js: a steer list's names, triggers (at, when with for / repeat / window, after with its while), conditions' names; cycles; run.until reads the same", () => {
	const base = { format: "chronal-setup/1", characters: [{ name: "A", class: "ranger", code: { file: "codes/idle.js" } }] };
	// run.check: how often conditions are checked (default 1 s; 100 ms to 10 min); a duration takes ms
	assert.deepEqual([S.loadSetup(base).run.check, S.loadSetup({ ...base, run: { check: "250ms" } }).run.check, S.parseDuration("250ms"), S.parseDuration("1.5s"), S.parseDuration("2")], ["1s", "250ms", 250, 1500, 120_000]);
	for (const c of ["50ms", "11m", "soon"]) assert.throws(() => S.loadSetup({ ...base, run: { check: c } }), (e) => (assert.deepEqual(e.problems, [`run.check: "${c}", how often conditions are checked: 100ms to 10m (e.g. "1s", "500ms")`]), true));
	assert.equal(new X.Steering([], { check: "250ms" }).checkMs, 250);
	assert.equal(S.setupKey(S.resolveSetup(S.loadSetup({ ...base, run: { check: "5s" } })).resolved, "v"), S.setupKey(S.resolveSetup(S.loadSetup(base)).resolved, "v"), "a run knob: not in setup_key");
	const ok = S.loadSetup({ ...base, run: { until: "c.A.kills.goo >= 30 || steps.boss" }, steer: [{ name: "boss", when: "c.A.kills.goo >= 10", for: "30s", repeat: true, window: "5m", storage: { m: 1 } }, { after: "boss", at: "1m", code: "1" }, { after: "boss", code: "2" }] });
	assert.deepEqual(ok.steer, [{ name: "boss", when: "c.A.kills.goo >= 10", for: "30s", repeat: true, window: "5m", storage: { m: 1 } }, { at: "1m", after: "boss", code: "1" }, { after: "boss", code: "2" }]);
	assert.throws(() => S.loadSetup({
		...base, run: { until: "c.B.level > 2 || steps.nope" },
		steer: [{ when: "c.Z.kills.goo > 1", code: "1" }, { when: "t > 1", at: "1m", code: "1" }, { after: "x", code: "1" }, { name: "a", after: "b", code: "1" }, { name: "b", after: "a", code: "1" }, { at: "1m", for: "1m", repeat: true, code: "1" }, { code: "1" }, { name: "a b", when: "t > (", code: "1" }, { when: "t > 1", for: "soon", code: "1" }],
	}), (e) => {
		assert.deepEqual(e.problems, [
			"steer[0].when: c.Z is not a character of the setup", "steer[1]: when, or at / after (a time), not both", 'steer[2].after: "x", the name of another step',
			"steer[5].for: with when only", "steer[5].repeat: with when only", "steer[6]: at (a game time since the run's start, after the warm-up), when (a condition) or after (another step)",
			'steer[7].name: "a b", a word (letters, digits, _)', "steer[7].when: Unexpected token ')'", 'steer[8].for: "soon", a game time (90s, 30m, 2h, or minutes)',
			"steer: a is after itself (a -> b -> a): it never fires", "run.until: c.B is not a character of this setup", "run.until: steps.nope: no step of that name",
		]);
		return true;
	});
});

test("conditions are checked when the setup loads: a name a condition doesn't read, a field c.<Name>, party or world doesn't have", () => {
	const base = { format: "chronal-setup/1", characters: [{ name: "Ran1", class: "ranger", code: { file: "codes/idle.js" } }] };
	const problems = (o) => {
		try {
			S.loadSetup({ ...base, ...o });
			return [];
		} catch (e) {
			return e.problems;
		}
	};
	assert.deepStrictEqual(problems({ run: { until: "kills.goo >= 10" } }), ["run.until: kills is not something a condition reads (c.<Name>, party, t, world, steps)"]);
	assert.match(problems({ steer: [{ when: "c.Ran1.kils >= 3", storage: { mode: "rest" } }] })[0], /^steer\[0\]\.when: kils is not a field of c\.<Name> \(name, class, /);
	assert.match(problems({ run: { until: "party.kill.total > 3" } })[0], /^run\.until: kill is not a field of party \(size, online, dead, kills, /);
	// what the docs show reads fine (fields under a field are free; plain JavaScript, arrow parameters)
	for (const ok of ["c.Ran1.kills.squigtoad >= 500", "party.kills.total >= 50 && t > 60", "!c.Ran1.s.mluck", "c.Ran1.log(/Out of potions/) > 0", "c.Ran1.rate.xp_h < 400000", "world.alive.goo > 3", "Math.max(c.Ran1.level, 1) > 3 && [1].some((x) => x < c.Ran1.levels)", 'c.Ran1.get("mode") == "rest"'])
		assert.deepStrictEqual(problems({ run: { until: ok } }), [], ok);
});
