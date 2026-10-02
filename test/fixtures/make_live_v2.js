"use strict";
// Fixture snapshots for dashboard/server.js in the live schema v2.2 (docs/reference/snapshot.md), from a toy
// fight model stepped in game time, so every ledger adds up: by_skill and by_target sum to done, party.history is the
// fighters' sums, each history row and grid row is the ledgers at its time (the last one = the totals), what the
// merchant sent is what the fighters received, every character's gold closes the gold identity. Kane and Angel walk a
// fixed path (on a fresh server they start in town); their auras are on
// for whoever is within 330 px of them on main, and drive luck (drops for the kill's recipient) and gold (the chest
// opener's goldm). The fixed game-time grid goes to <id>.grid.ndjson beside each snapshot (v2.2: with each character's
// cumulative ms per condition, c). v2.2 also has overkill, taken_raw, every condition in the timeline (a ring of 40 per key), time-uniform history, and the run-control blocks
// (proc, control, launch, end, run) with fake pids. One run's merchant fights with the party; one run is 16 game hours.
// Each is a run of a setup: its setup file (<id>.setup.json) and CODE store (code/) beside it. One has a world age
// (world.age_ms) and the monsters' levels at the base and, once ended, at the end (world.mlevels).
// Deterministic per run (seed). Numbers are plausible, not measured.
//   node test/fixtures/make_live_v2.js [--dir test/fixtures/live-v2] [--tick] [--root DIR]
// --tick: keeps rewriting the running fixture (the 3-fighter party) once a real second, 30 game s further each time;
// its grid file only grows (new lines appended), as a producer's does.
// --root: the checkout the runs claim to have run from (run.root, proc.cwd), e.g. a dashboard's, so it offers their
// reruns; default none that exists.
const fs = require("node:fs"),
	path = require("node:path"),
	crypto = require("node:crypto");
const SETUP = require("../../lib/setup");

const LEVELS = { 38: 470e3, 39: 580e3, 40: 720e3, 41: 900e3, 58: 31e6, 59: 38e6, 60: 47e6, 61: 57e6, 62: 69e6, 63: 84e6, 64: 100e6, 65: 120e6, 66: 140e6, 67: 170e6, 68: 200e6, 69: 240e6, 70: 290e6 };
// the spots' monsters: hp, xp, gold per chest and what a kill may drop ([chance, item])
const MON = {
	squigtoad: { hp: 9600, xp: 32000, gold: 310, drops: [[0.3, "frogt"], [0.03, "seashell"], [0.004, "hpbelt"], [0.004, "ringsj"]] },
	porcupine: { hp: 3800, xp: 3200, gold: 90, drops: [[0.2, "spores"], [0.004, "hpamulet"]] },
	arcticbee: { hp: 1600, xp: 1800, gold: 40, drops: [[0.25, "beewings"], [0.002, "ringsj"], [0.001, "gem0"]] },
	tortoise: { hp: 12000, xp: 11000, gold: 260, drops: [[0.2, "tshell"], [0.03, "seashell"], [0.006, "hpamulet"], [0.004, "hpbelt"]] },
	frog: { hp: 4200, xp: 4000, gold: 110, drops: [[0.2, "frogt"], [0.004, "ringsj"], [0.001, "gem0"]] },
	boar: { hp: 12000, xp: 10800, gold: 260, drops: [[0.03, "seashell"], [0.006, "hpamulet"], [0.004, "hpbelt"]] },
	wolfie: { hp: 19200, xp: 16400, gold: 380, drops: [[0.02, "seashell"], [0.004, "wbook0"], [0.001, "gem0"]] },
};
const PRICE = { hpot1: 100, mpot1: 100, cscroll0: 6400, frogt: 3, spores: 120, beewings: 25, tshell: 150, seashell: 800, hpbelt: 20000, ringsj: 24000, hpamulet: 20000, wbook0: 12000, gem0: 240000 };
const JUNK = new Set(["frogt", "spores", "beewings", "tshell", "seashell", "wbook0"]); // the merchant sells these to NPCs, exchanges gems, compounds the rest by 3
// per class: damage per second in combat, damage share, average hit and targets per cast of each skill, crit/miss
// rates, overkill, mp per second, damage taken per second at danger 1, weapon
const CLS = {
	ranger: { dps: 620, skills: { attack: [0.6, 820, 1], "3shot": [0.3, 560, 3], supershot: [0.1, 2400, 1] }, crit: 0.08, miss: 0.02, over: 0.1, mp: 14, dtps: 30, weapon: "firebow+7" },
	priest: { dps: 140, skills: { attack: [1, 380, 1] }, crit: 0.05, miss: 0.02, over: 0.04, mp: 24, dtps: 26, weapon: "wand+7" },
	paladin: { dps: 380, skills: { attack: [0.82, 520, 1], smash: [0.18, 900, 1] }, crit: 0.05, miss: 0.03, over: 0.06, mp: 10, dtps: 90, weapon: "pmace+6" },
	warrior: { dps: 520, skills: { attack: [0.68, 640, 1], cleave: [0.32, 450, 4] }, crit: 0.06, miss: 0.03, over: 0.08, mp: 12, dtps: 110, weapon: "sword+7" },
	merchant: { dps: 170, skills: { attack: [1, 300, 1] }, crit: 0.03, miss: 0.04, over: 0.05, mp: 6, dtps: 36, weapon: "dartgun+6" },
};
const GEAR = { helmet: "helmet+8", chest: "coat+8", pants: "pants+8", shoes: "shoes+8", gloves: "gloves+8", ring1: "ringsj+2", ring2: "ringsj+2", amulet: "hpamulet+2", belt: "hpbelt+2", orb: "ftrinket+0" };
const HISTORY_COLS = ["t", "level", "xp", "hpots", "mpots", "kills", "deaths", "dmg", "taken", "heal", "income", "trips", "dmg_raw", "heal_raw", "taken_raw"];
const GRID_COLS = ["level", "xp", "kills", "credits", "deaths", "dmg", "dmg_raw", "taken", "heal", "heal_raw", "income", "loot_items", "hpots", "mpots", "mana", "gold", "alive_ms", "combat_ms", "party_ms",
	"c_citizen0aura", "c_citizen4aura", "c_mluck", "c_lonewolf", "c_party", "angel_gold", "taken_raw"];
// conditions[k].kind: the game's buff / debuff flags, the pseudo keys' own
const KIND = { citizen0aura: "buff", citizen4aura: "buff", mluck: "buff", encouragement_lonewolf: "buff", party: "buff", elixir: "buff", paladin_aura_zeal: "buff", mshield: "buff", fear: "debuff", poisoned: "debuff", anniversary_visit: "other" };
// where the fixtures' runs claim to have run from (the run-control blocks): no real checkout, unless given
const rootArg = (name, def) => { const i = process.argv.indexOf("--" + name); return i >= 0 && process.argv[i + 1] ? fs.realpathSync(process.argv[i + 1]) : def; };
const ROOT = rootArg("root", "/opt/chronal");
const ON_KEYS = ["citizen0aura", "citizen4aura", "mluck", "encouragement_lonewolf", "party", "fear"];
const T0 = Date.parse("2026-09-24T09:00:00Z"),
	STEP = 5, // game s per model step
	GRID_MS = 30000,
	TOWN = [-192, 104];

// the runs: members [name, class, level], spot { map, x, y, mix: {monster: weight}, danger }, xpm = xp per kill over
// the monster's (Lone Wolf included when solo), deaths [name, game s]; elixir: the first fighter's; fear: who gets
// feared at times; poison: who gets poisoned now and then (a flickering debuff: more intervals than the timeline's ring
// of 40); npcKills: kills by no run character (the Baron's: kills.others); bank: gold the merchant deposits on its 3rd
// trip; fights: the merchant fights with the party (no supply trips; its own kills' xp); until: the run's run.until; end/launch/plan:
// the run-control blocks (plan: the planned game hours, else hours); grid_s:
// the grid's step; world: the world's age in game s (worldOf)
const RUNS = [
	{ tag: "fx solo ranger", seed: 1, hours: 3, members: [["Ran1", "ranger", 64]], spot: { map: "main", x: -1175, y: 422, mix: { squigtoad: 1 }, danger: 0.4 }, xpm: 15, start: 0, elixir: "elixirluck", exact: true, end: { reason: "failed", detail: "exit 1: FAILED: Ran1 stuck at main -1175,422" } },
	{ tag: "fx ranger+priest", seed: 1, hours: 3, members: [["Ran1", "ranger", 64], ["Pri1", "priest", 61]], spot: { map: "winterland", x: 1082, y: -873, mix: { arcticbee: 1 }, danger: 1 }, xpm: 5.5, start: 1 },
	{ tag: "fx ranger+priest", seed: 2, hours: 3, members: [["Ran1", "ranger", 64], ["Pri1", "priest", 61]], spot: { map: "winterland", x: 1082, y: -873, mix: { arcticbee: 1 }, danger: 1 }, xpm: 5.5, start: 2, bank: 2e6,
		plan: 4, end: { reason: "stopped", detail: "dashboard" }, launch: { rerun_of: 1 } },
	{ tag: "fx ranger+priest+paladin", seed: 1, hours: 2.5, members: [["Ran1", "ranger", 64], ["Pri1", "priest", 61], ["Pal1", "paladin", 61]], spot: { map: "main", x: -1125, y: 1118, mix: { tortoise: 0.7, frog: 0.3 }, danger: 2.2 },
		xpm: 5.5, deaths: [["Pri1", 4230], ["Ran1", 6120], ["Ran1", 6210]], running: true, start: 3, fear: "Pal1", poison: "Pal1", npcKills: { snake: 2 } },
	{ tag: "fx ranger+priest+merchant (merchant fights)", seed: 1, hours: 2, members: [["Ran1", "ranger", 64], ["Pri1", "priest", 61]], spot: { map: "main", x: -1175, y: 422, mix: { squigtoad: 0.6, porcupine: 0.4 }, danger: 0.7 }, xpm: 5.5, start: 6, fights: true },
	{ tag: "fx level ranger to 65", seed: 4, hours: 16, members: [["Ran1", "ranger", 58]], spot: { map: "main", x: 740, y: 1570, mix: { boar: 1 }, danger: 0.5 }, xpm: 15, start: 7, until: "c.Ran1.level >= 65", grid_s: 60 },
	// accounts 30 days old
	{ tag: "fx setup ranger+priest", seed: 1, hours: 0.5, members: [["Ran1", "ranger", 64], ["Pri1", "priest", 61]], spot: { map: "main", x: -1175, y: 422, mix: { squigtoad: 1 }, danger: 0.4 }, xpm: 5.5, start: 8, setup: { age_days: 30 },
		world: { age: 7200 } },
];

const sha = (s, n = 8) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
function rng(seed) {
	let a = seed >>> 0;
	return () => ((a = (a + 0x6d2b79f5) >>> 0), (((a ^ (a >>> 15)) * (1 | a)) >>> 0) / 4294967296);
}
const add = (o, k, v) => (o[k] = (o[k] || 0) + v);
const addRN = (o, k, raw, net, extra) => {
	const e = (o[k] ||= { raw: 0, net: 0 });
	e.raw += raw;
	e.net += net;
	for (const [x, v] of Object.entries(extra || {})) add(e, x, v);
};
const add2 = (o, a, b, v) => add((o[a] ||= {}), b, v); // item -> who -> q
const r1 = (v) => Math.round(v * 10) / 10;
// v split by weights into integers that sum to v
function split(v, w) {
	const ks = Object.keys(w), tot = ks.reduce((a, k) => a + w[k], 0), out = {};
	let left = v;
	ks.forEach((k, i) => (left -= out[k] = i === ks.length - 1 ? left : Math.round((v * w[k]) / tot)));
	return out;
}
const levelUp = (c) => {
	while (LEVELS[c.level] && c.xpNow >= LEVELS[c.level]) (c.xpNow -= LEVELS[c.level]), c.level++;
};

// Kane's or Angel's walk as [t, x, y] points (walked at its speed in between): a fresh sim server starts them in town
// for most of the first hour; then they wait at far places of main and now and then pass by a spot on main
function npcPath(run, who, rnd, T) {
	const speed = who === "Kane" ? 30 : 20, spot = run.spot, FAR = [[-984, 1762], [-1203, -66], [600, 1700], [-1400, 1500]];
	let x = 0, y = 0, t = 0;
	const pts = [[0, x, y]];
	const go = (nx, ny, wait) => {
		t += Math.hypot(nx - x, ny - y) / speed;
		(x = Math.round(nx)), (y = Math.round(ny));
		pts.push([t, x, y]);
		if (wait) (t += wait), pts.push([t, x, y]);
	};
	for (let k = 0; k < 14; k++) go((rnd() - 0.5) * 320, (rnd() - 0.5) * 320, 120 + rnd() * 150);
	while (t < T) {
		const f = FAR[Math.floor(rnd() * FAR.length)];
		go(f[0] + (rnd() - 0.5) * 200, f[1] + (rnd() - 0.5) * 200, 500 + rnd() * 2000);
		if (spot.map === "main") {
			go(spot.x + (rnd() - 0.5) * 300, spot.y + (rnd() - 0.5) * 300, 20);
			for (let s = 60 + rnd() * 500; s > 0; s -= 60) go(x + (rnd() - 0.5) * 160, y + (rnd() - 0.5) * 160, 40);
		}
	}
	return pts;
}
function at(pts, t) {
	let i = 1;
	while (i < pts.length - 1 && pts[i][0] < t) i++;
	const [ta, xa, ya] = pts[i - 1], [tb, xb, yb] = pts[i], f = tb > ta ? Math.min(1, Math.max(0, (t - ta) / (tb - ta))) : 1;
	return [xa + (xb - xa) * f, ya + (yb - ya) * f];
}

function ledger(name, type, level, rnd) {
	return {
		name, type, level, start_level: level, xpNow: Math.round(LEVELS[level] * rnd() * 0.5), xp: 0, kills: 0, credits: 0, deaths: 0, hp: 0, mp: 0, pots: {}, casts: {}, dead: -1, hpDebt: 0, mpDebt: 0,
		dmg: { done: { raw: 0, net: 0 }, by_skill: {}, by_target: {}, taken: { raw: 0, net: 0 }, taken_by: {}, taken_mp: 0, avoided: { miss: 0, evade: 0, avoid: 0 } },
		heal: { done: { raw: 0, net: 0 }, by_skill: {}, by_target: {}, received: { raw: 0, net: 0 }, received_by: {}, overheal: 0 },
		mana: { spent: 0, by_skill: {}, gained: { pots: 0, regen: 0, steal: 0, other: 0 } },
		items: { looted: {}, consumed: {}, bought: {}, sold: {}, sent: {}, received: {}, upgraded: {}, compounded: {}, exchanged: {}, from_exchange: {}, crafted: {}, mluck_dupes: {} },
		gold_flow: { loot: 0, sold: 0, stand: 0, received: 0, other: 0, bought: 0, craft: 0, sent: 0, other_out: 0, banked: 0 },
		gold_start: type === "merchant" ? 12e6 : 250e3,
		chests: { opened: 0, dry: 0, stale: 0, gone: 0 }, alive_ms: 0, combat_ms: 0, party_ms: 0, modes: {}, since: { used: {}, looted: {}, gold: 0 }, owed: {}, history: [],
		cond: {}, open: {}, rows: [], on: {}, mult: { xpm: 0, goldm: 0, luckm: 0, enc_xp: 0, enc_gold: 0, enc_luck: 0 }, keys: {}, pos: null, map: null, angel: { gold: 0, chests: 0, kills: 0 },
	};
}
const income = (c) => c.gold_flow.loot + c.gold_flow.sold + c.gold_flow.stand;
const goldNow = (c) => { const g = c.gold_flow; return c.gold_start + g.loot + g.sold + g.stand + g.received + g.other - g.bought - g.craft - g.sent - g.other_out - g.banked; };
const looted = (c) => Object.values(c.items.looted).reduce((a, b) => a + b, 0);
// history: dmg / heal net, their raw beside, taken raw at the end
const row = (c, t, trips) => [t, c.level, c.xp, c.hp, c.mp, c.kills, c.deaths, c.dmg.done.net, c.dmg.taken.net, c.heal.done.net, income(c), trips, c.dmg.done.raw, c.heal.done.raw, c.dmg.taken.raw];
// time-uniform (rows at least st.step apart, the step doubles when full; the last row is the latest pass)
function pushU(h, r, st) {
	if (h.length >= 2 && r[0] - h[h.length - 2][0] < st.step) h[h.length - 1] = r;
	else h.push(r);
	if (h.length <= 300) return h;
	st.step = Math.max(2 * st.step, (h[h.length - 1][0] - h[0][0]) / 150);
	const out = [h[0]];
	for (let i = 1; i < h.length - 1; i++) if (h[i][0] - out[out.length - 1][0] >= st.step) out.push(h[i]);
	out.push(h[h.length - 1]);
	return out;
}
const onOf = (c, k) => (c.on[k] ||= { ms: 0, xp: 0, credits: 0, rkills: 0, items: 0, chests: 0, loot_gold: 0, x10: 0, x50: 0, dmg: 0, taken: 0, heal: 0, hpots: 0 });
// adds v to field f of every whitelisted key that is on for c
const onAdd = (c, f, v) => { for (const k in c.keys) if (ON_KEYS.includes(k)) onOf(c, k)[f] += v; };

// The world block (run.world): age_ms, and mlevels, each monster type's { n, avg, max } level on the spot's map at the base
// (after the world age) and, once the run has ended, at the end: an untouched monster levels up every max(180 s, hp * 30
// ms) * 2^((level - 1) * 0.3) (+-50 s); a hunted one, killed now and then, respawns at level 1 here. Its own random
// numbers (the run's stay as they were; the base's don't depend on how far the run is).
const OTHERS = { main: { goo: 60, bee: 540, crab: 1000, snake: 260, tortoise: 12000 } };
function worldOf(run, until, done) {
	const x = run.world;
	if (!x) return {};
	const rb = rng(run.seed * 104729 + 17),
		re = rng(run.seed * 104729 + 18),
		age = x.age * 1000,
		lvl = (rnd, hp, ms) => {
			let l = 1;
			for (let t = rnd() * 900e3; ; l++) { // (up to 15 game min less: spawned later)
				t += Math.max(180e3, hp * 30) * 2 ** ((l - 1) * 0.3) + (rnd() - 0.5) * 100e3;
				if (t > ms) return l;
			}
		},
		stats = (ls) => ({ n: ls.length, avg: Math.round((ls.reduce((a, b) => a + b, 0) / ls.length) * 100) / 100, max: Math.max(...ls) }),
		base = {},
		end = {};
	for (const [t, hp] of Object.entries({ ...Object.fromEntries(Object.keys(run.spot.mix).map((k) => [k, MON[k].hp])), ...(OTHERS[run.spot.map] || {}) })) {
		const n = 4 + Math.floor(rb() * 5), hunted = t in run.spot.mix;
		base[t] = stats(Array.from({ length: n }, () => lvl(rb, hp, age)));
		end[t] = stats(Array.from({ length: n }, () => lvl(re, hp, hunted ? re() * 600e3 : age + until * 1000)));
	}
	const map = run.spot.map;
	return { age_ms: age, mlevels: { base: { [map]: base }, end: done ? { [map]: end } : null } };
}
const ageText = (s) => (s === 0 ? "0m" : s % 3600 === 0 ? s / 3600 + "h" : s % 60 === 0 ? s / 60 + "m" : s + "s");

/** One run's snapshot after `until` game seconds (the whole run by default), and its grid lines. */
function generate(run, until = run.hours * 3600) {
	const rnd = rng(run.seed * 7919 + parseInt(sha(run.tag), 16)),
		n = run.members.length,
		party = n > 1,
		T = run.hours * 3600,
		gridMs = (run.grid_s || GRID_MS / 1000) * 1000;
	const F = run.members.map(([name, type, level]) => ledger(name, type, level, rnd)),
		M = ledger("Mer1", "merchant", 40, rnd),
		all = [...F, M],
		FF = run.fights ? all : F, // who fights: the fighters, and the merchant when it fights with them
		mix = run.spot.mix,
		pool = {},
		killsBy = {},
		killed = {},
		deaths = [],
		trips = [],
		perF = {},
		grid = [];
	const npc = { Kane: npcPath(run, "Kane", rng(run.seed * 31 + 1), T), Angel: npcPath(run, "Angel", rng(run.seed * 31 + 2), T) },
		frnd = rng(run.seed * 97 + 5), // fear, apart so the fights stay as they were
		prnd = rng(run.seed * 89 + 11); // poison, apart likewise
	for (const f of F) perF[f.name] = { trips: 0, meetings: 0, deliveries: 0, pickups: 0, sent: {}, received: {}, gold_sent: 0, gold_received: 0 };
	M.trips = M.outings = 0;
	const share = party ? Math.round((1 / n) * 1e4) / 1e4 : 1,
		bonus = [0, 0, 0.1, 0.16][n] || 0.2,
		priest = F.find((f) => f.type === "priest"),
		V0 = T0 + run.start * 3 * 3600e3 + 21345; // the virtual clock at the base (not on a grid boundary)
	let partyH = [],
		tripAt = run.fights ? Infinity : 1200, // a fighting merchant makes no supply trips
		mTrips = 0,
		trip = null,
		firstMeet = run.fights ? 0 : Infinity,
		fearUntil = -1,
		poisonUntil = -1,
		nextGrid = Math.ceil(V0 / gridMs) * gridMs;
	const hst = new Map(all.map((c) => [c, { step: 0 }])), pst = { step: 0 }; // v2.2 history steps
	for (let t = STEP; t <= until; t += STEP) {
		// where everyone is, and what is on for each: citizen auras within 330 px on main, mluck after the first
		// meeting, Lone Wolf solo, the party, an elixir, fear at times
		if (t >= tripAt - 300 && !trip) trip = { t_out: tripAt - 300 };
		for (const [i, c] of all.entries()) {
			const merchant = c === M, out = merchant && trip && t >= trip.t_out + 60, town = merchant && !out && !run.fights;
			c.map = town ? "main" : run.spot.map;
			c.pos = town ? TOWN : [run.spot.x + 30 * i + 20 * Math.sin(t / 97 + i), run.spot.y + 10 * i + 20 * Math.cos(t / 131 + i)];
			const keys = {};
			for (const [who, key] of [["Kane", "citizen0aura"], ["Angel", "citizen4aura"]]) {
				const [x, y] = at(npc[who], t), d = c.map === "main" ? Math.hypot(x - c.pos[0], y - c.pos[1]) : null;
				c["d_" + who] = d == null ? null : Math.round(d);
				if (d != null && d < 330) keys[key] = 200;
			}
			if (merchant || t >= firstMeet) keys.mluck = "Mer1";
			if (!merchant && !party) keys.encouragement_lonewolf = "3/3/3";
			if (!merchant && party) keys.party = ["", "", "xp10 luck20 gold5", "xp16 luck30 gold5"][n]; // formed before the base
			if (run.elixir && c === F[0]) keys.elixir = run.elixir;
			if (run.fear === c.name) {
				if (t > fearUntil && frnd() < 0.012) fearUntil = t + 10 + Math.round(frnd() * 6) * 5;
				if (t <= fearUntil && c.dead <= t) keys.fear = 1;
			}
			// v2.2 keys the v2.1 timeline left out or never saw: the paladin's aura on the party, its mana shield,
			// poison now and then, the merchant's anniversary visit in town
			if (!merchant && party && F.some((f) => f.type === "paladin")) keys.paladin_aura_zeal = F.find((f) => f.type === "paladin").name + " r1";
			if (c.type === "paladin" && c.dead <= t && t % 900 < 820) keys.mshield = null;
			if (run.poison === c.name) {
				if (t > poisonUntil && prnd() < 0.05) poisonUntil = t + 5 + Math.round(prnd() * 2) * 5;
				if (t <= poisonUntil && c.dead <= t) keys.poisoned = null;
			}
			if (town && t % 1800 < 400) keys.anniversary_visit = null;
			// conditions: ms on, intervals, the longest, the last value; the timeline row of each (a value change reopens)
			for (const [k, v] of Object.entries(keys)) {
				const e = (c.cond[k] ||= { ms: 0, n: 0, max_ms: 0, v, run: 0 });
				if (!(k in c.keys) || c.keys[k] !== v) (e.n += k in c.keys ? 0 : 1), (e.run = 0);
				e.ms += STEP * 1000;
				e.run += STEP * 1000;
				e.max_ms = Math.max(e.max_ms, e.run);
				e.v = v;
				if (c.open[k] && c.open[k][3] !== v) (c.open[k][2] = r1(t - STEP)), delete c.open[k];
				if (!c.open[k]) c.rows.push((c.open[k] = [k, r1(t - STEP), null, v]));
			}
			for (const k of Object.keys(c.open)) if (!(k in keys)) (c.open[k][2] = r1(t - STEP)), delete c.open[k];
			c.keys = keys;
			for (const k in keys) if (ON_KEYS.includes(k)) onOf(c, k).ms += STEP * 1000;
			const xpm = merchant ? 1 : party ? 1 + bonus : 1.1, goldm = (merchant ? 1 : party ? 1.05 : 1.08) + (keys.citizen4aura ? 2 : 0), luckm = (party ? 1.2 : 1.1) + (keys.citizen0aura ? 2 : 0) + (keys.mluck ? 0.12 : 0), enc = keys.encouragement_lonewolf ? 3 : 1;
			c.cur = { xpm, goldm, luckm };
			for (const [k, v] of Object.entries({ xpm, goldm, luckm, enc_xp: enc, enc_gold: enc, enc_luck: enc })) c.mult[k] += v * STEP * 1000;
			if (keys.party) c.party_ms += STEP * 1000;
		}
		const step_ = {}; // this step's taken net per fighter
		for (const f of FF) {
			const C = CLS[f.type];
			// deaths: a big hit, then 60 s dead
			for (const [who, when] of run.deaths || []) if (who === f.name && when > t - STEP && when <= t) {
				const hit = 4200 + Math.round(rnd() * 900), type = Object.keys(mix)[0];
				addRN(f.dmg.taken_by, type, hit + 1300, hit, { hits: 1 });
				f.dmg.taken.raw += hit + 1300;
				f.dmg.taken.net += hit;
				f.deaths++;
				f.dead = t + 60;
				deaths.push({ name: f.name, level: f.level, map: run.spot.map, x: Math.round(f.pos[0]), y: Math.round(f.pos[1]), by: type, t: when });
			}
			const dead = f.dead > t, act = dead ? 0 : 0.8 + 0.15 * rnd();
			if (!dead) f.alive_ms += STEP * 1000;
			f.combat_ms += Math.round(act * STEP * 1000);
			add(f.modes, dead ? "dead" : "kite", STEP * 1000);
			// damage done by skill (hits, crits, misses, casts), then by target; feared: 60%
			const raw = Math.round(C.dps * STEP * act * (0.85 + 0.3 * rnd()) * (f.keys.fear ? 0.6 : 1));
			let net = 0;
			for (const [sk, [sh, avg, per]] of Object.entries(C.skills)) {
				const r = Math.round(raw * sh), nt = Math.round(r * (1 - C.over * (0.7 + 0.6 * rnd()))), hits = Math.round(r / avg), casts = Math.round(hits / per);
				addRN(f.dmg.by_skill, sk, r, nt, { hits, crits: Math.round(hits * C.crit * (0.6 + 0.8 * rnd())), misses: Math.round(hits * C.miss * (0.5 + rnd())), casts });
				add(f.casts, sk, casts);
				f.dmg.done.raw += r;
				f.dmg.done.net += nt;
				net += nt;
				const rs = split(r, mix), ns = split(nt, mix), hs = split(hits, mix);
				for (const m in mix) addRN(f.dmg.by_target, m, rs[m], ns[m], { hits: hs[m] });
				for (const m in mix) ((pool[m] = (pool[m] || 0) + ns[m]), ((killsBy[m] ||= {})[f.name] = (killsBy[m][f.name] || 0) + ns[m]));
			}
			onAdd(f, "dmg", net);
			// mana
			const mp = Math.round(C.mp * STEP * act * (0.8 + 0.4 * rnd())), ms = split(mp, Object.fromEntries(Object.entries(C.skills).map(([k, [sh]]) => [k, sh])));
			f.mana.spent += mp;
			for (const k in ms) add(f.mana.by_skill, k, ms[k]);
			const regen = dead ? 0 : Math.round(STEP * 6);
			f.mana.gained.regen += regen;
			f.mpDebt += mp - regen;
			const mpots = Math.max(0, Math.floor(f.mpDebt / 500));
			if (mpots) (f.mpDebt -= mpots * 500), (f.mana.gained.pots += mpots * 500), (f.mp += mpots), add(f.pots, "mpot1", mpots), add(f.items.consumed, "mpot1", mpots), add(f.since.used, "mpot1", mpots);
			// damage taken
			const tk = dead ? 0 : Math.round(C.dtps * run.spot.danger * STEP * act * (0.6 + 0.8 * rnd())), tks = split(tk, mix);
			for (const m in mix) addRN(f.dmg.taken_by, m, tks[m], tks[m], { hits: Math.round(tks[m] / 70) });
			f.dmg.taken.raw += tk;
			f.dmg.taken.net += tk;
			f.dmg.avoided.miss += Math.round(tk / 900);
			f.dmg.avoided.evade += f.type === "ranger" ? Math.round(tk / 700) : 0;
			step_[f.name] = tk;
			onAdd(f, "taken", tk);
		}
		// healing: the priest covers 85% of what everyone took (20-40% overheal), a paladin heals itself, regen, then
		// hp potions for the rest
		for (const f of FF) {
			const tk = step_[f.name];
			let got = 0;
			const recv = (src, raw, net, hits) => (addRN(f.heal.received_by, src, raw, net, { hits }), (f.heal.received.raw += raw), (f.heal.received.net += net), (got += net));
			if (priest && priest.dead <= t && tk) {
				const net = Math.round(tk * 0.85), raw = Math.round(net * (1.2 + 0.2 * rnd())), part = split(raw, { heal: 0.7, partyheal: 0.3 }), partN = split(net, { heal: 0.7, partyheal: 0.3 });
				let hits = 0;
				for (const k in part) {
					const casts = Math.round(part[k] / (k === "heal" ? 950 : 500)), h = k === "heal" ? casts : Math.round(casts / n);
					addRN(priest.heal.by_skill, k, part[k], partN[k], { hits: h, casts: k === "heal" ? casts : Math.round(casts / n) });
					add(priest.casts, k, k === "heal" ? casts : Math.round(casts / n));
					hits += h;
				}
				addRN(priest.heal.by_target, f.name, raw, net, { hits });
				priest.heal.done.raw += raw;
				priest.heal.done.net += net;
				onAdd(priest, "heal", net);
				recv(priest.name, raw, net, hits);
			}
			if (f.type === "paladin" && tk) {
				const net = Math.round(tk * 0.2), raw = Math.round(net * 1.4), casts = Math.round(raw / 600);
				addRN(f.heal.by_skill, "selfheal", raw, net, { hits: casts, casts });
				add(f.casts, "selfheal", casts);
				addRN(f.heal.by_target, f.name, raw, net, { hits: casts });
				f.heal.done.raw += raw;
				f.heal.done.net += net;
				onAdd(f, "heal", net);
				recv(f.name, raw, net, casts);
			}
			if (tk) recv("regen_hp", Math.round(tk * 0.04), Math.round(tk * 0.04), Math.round(tk / 400));
			f.hpDebt += Math.max(0, tk - got);
			const hp = Math.floor(f.hpDebt / 360);
			if (hp) (f.hpDebt -= hp * 360), recv("hpot1", hp * 400, hp * 360, hp), (f.hp += hp), add(f.pots, "hpot1", hp), add(f.items.consumed, "hpot1", hp), add(f.since.used, "hpot1", hp), onAdd(f, "hpots", hp);
		}
		for (const f of all) f.heal.overheal = f.heal.done.raw - f.heal.done.net;
		// kills: the damage pool per monster type, the last hit to a fighter by its damage share; xp; the chest's
		// gold with its opener's goldm (Angel), drops with the recipient's luckm (Kane; the recipient is the monster's
		// target: the paladin tank mostly)
		for (const m in mix)
			while (pool[m] >= MON[m].hp) {
				pool[m] -= MON[m].hp;
				const by = killsBy[m], tot = Object.values(by).reduce((a, b) => a + b, 0);
				let x = rnd() * tot, killer = F[0];
				for (const f of FF) if ((x -= by[f.name] || 0) < 0) { killer = f; break; }
				killer.kills++;
				add(killed, m, 1);
				const base = MON[m].xp * run.xpm, alone = killer === M; // the merchant isn't in the party: its own kills' xp is its own
				for (const f of party && !alone ? F : [killer]) {
					const xp = Math.round(base * (alone ? 1 : share * (1 + (party ? bonus : 0))));
					(f.xp += xp), (f.xpNow += xp), f.credits++, levelUp(f);
					onAdd(f, "xp", xp), onAdd(f, "credits", 1);
				}
				const tank = F.find((f) => f.type === "paladin"), recip = !party ? killer : tank && rnd() < 0.7 ? tank : F[Math.floor(rnd() * n)];
				const opener = party ? F[Math.floor(rnd() * n)] : killer, dry = rnd() < 0.03, mult = rnd() < 1 / 32 ? 10 : rnd() < 1 / 480 ? 50 : 1;
				const goldm = dry ? 1 : opener.cur.goldm, g0 = MON[m].gold * (party ? 1 : 2.8) * (0.8 + 0.4 * rnd()) * mult;
				opener.chests.opened++;
				if (dry) opener.chests.dry++;
				let paid = 0, angel = 0;
				for (const f of party ? F : [killer]) {
					const gi = Math.round(g0 * share * goldm);
					(f.gold_flow.loot += gi), (f.since.gold += gi), (paid += gi);
					if (!dry && opener.keys.citizen4aura) angel += gi - Math.round(g0 * share * (goldm - 2));
				}
				onAdd(opener, "chests", 1), onAdd(opener, "loot_gold", paid);
				if (mult === 10) onAdd(opener, "x10", 1);
				if (mult === 50) onAdd(opener, "x50", 1);
				if (angel) (opener.angel.gold += angel), opener.angel.chests++;
				onAdd(recip, "rkills", 1);
				if (recip.keys.citizen0aura) recip.angel.kills++;
				for (const [p, item] of MON[m].drops)
					if (rnd() < (p * recip.cur.luckm) / 1.2) add(opener.items.looted, item, 1), add(opener.since.looted, item, 1), onAdd(recip, "items", 1);
			}
		// the merchant: a supply trip every 20 game minutes (5 out): pots bought, delivered to cover what each fighter
		// drank since the last one (in 50s), loot and 90% of the loot gold collected; junk sold, rings compounded, gems
		// exchanged; a deposit at the bank on the 3rd trip (run.bank)
		if (t >= tripAt) {
			Object.assign(trip, { t_back: t, met: F.map((f) => f.name), served: {} });
			for (const f of F) {
				const s = { sent: {}, received: {}, gold_sent: 0, gold_received: 0 }, pf = perF[f.name];
				pf.trips++, (pf.meetings += rnd() < 0.2 ? 2 : 1);
				// what it drank since, in 50s, the rest owed to the next trip
				for (const [pot, q0] of Object.entries(f.since.used)) {
					const q = Math.round((q0 + (f.owed[pot] || 0)) / 50) * 50;
					f.owed[pot] = q0 + (f.owed[pot] || 0) - q;
					if (!q) continue;
					M.items.bought[pot] ||= { q: 0, gold: 0 };
					M.items.bought[pot].q += q;
					M.items.bought[pot].gold += q * PRICE[pot];
					M.gold_flow.bought += q * PRICE[pot];
					add2(M.items.sent, pot, f.name, q), add2(f.items.received, pot, M.name, q), add(s.sent, pot, q), add(pf.sent, pot, q);
				}
				for (const [item, q] of Object.entries(f.since.looted)) add2(f.items.sent, item, M.name, q), add2(M.items.received, item, f.name, q), add(s.received, item, q), add(pf.received, item, q);
				const g = Math.round(f.since.gold * 0.9);
				(f.gold_flow.sent += g), (M.gold_flow.received += g), (s.gold_received = g), (pf.gold_received += g);
				if (Object.keys(s.sent).length || s.gold_sent) pf.deliveries++;
				if (Object.keys(s.received).length || s.gold_received) pf.pickups++;
				trip.served[f.name] = s;
				f.since = { used: {}, looted: {}, gold: 0 };
			}
			firstMeet = Math.min(firstMeet, t);
			trips.push(trip);
			trip = null;
			M.trips++, M.outings++, mTrips++;
			for (const [item, from] of Object.entries(M.items.received)) {
				const have = Object.values(from).reduce((a, b) => a + b, 0) - ((M.items.sold[item] && M.items.sold[item].q) || 0) - (M.items.exchanged[item] || 0) - ((M.items.compounded[item] && 3 * (M.items.compounded[item].ok + M.items.compounded[item].fail)) || 0);
				if (JUNK.has(item) && have > 0) {
					const e = (M.items.sold[item] ||= { q: 0, gold: 0 });
					(e.q += have), (e.gold += Math.round(have * PRICE[item] * 0.6)), (M.gold_flow.sold += Math.round(have * PRICE[item] * 0.6));
				} else if (item === "gem0" && have > 0) add(M.items.exchanged, item, have), add(M.items.from_exchange, "hpamulet", have);
				else if (!JUNK.has(item) && have >= 3) {
					const e = (M.items.compounded[item] ||= { ok: 0, fail: 0 });
					rnd() < 0.7 ? e.ok++ : e.fail++;
					M.items.bought.cscroll0 ||= { q: 0, gold: 0 };
					M.items.bought.cscroll0.q++, (M.items.bought.cscroll0.gold += PRICE.cscroll0), add(M.items.consumed, "cscroll0", 1), (M.gold_flow.bought += PRICE.cscroll0);
				}
			}
			if (run.bank && mTrips === 3) M.gold_flow.banked += run.bank;
			tripAt += 1200;
			add(M.modes, "restock", 300e3);
			add(M.modes, "market", -300e3);
		}
		if (!run.fights) add(M.modes, "market", STEP * 1000), (M.alive_ms += STEP * 1000);
		// history at the snapshot writes (~150 game s), the party's row: the fighters' sums, the
		// lowest level, dmg/heal null if any is
		if (t % 150 === 0 || t + STEP > until) {
			for (const f of F) f.history = pushU(f.history, row(f, t, 0), hst.get(f));
			M.history = pushU(M.history, row(M, t, mTrips), hst.get(M));
			const pr = HISTORY_COLS.map((c, i) => (i === 0 ? t : i === 1 ? Math.min(...F.map((f) => f.level)) : F.some((f) => f.history[f.history.length - 1][i] == null) ? null : F.reduce((a, f) => a + f.history[f.history.length - 1][i], 0)));
			pr[11] = 0;
			partyH = pushU(partyH, pr, pst);
		}
		// the grid: every character's ledgers at each 30 game s boundary of the virtual clock
		const v = V0 + t * 1000;
		if (v >= nextGrid) {
			const gt = r1((nextGrid - V0) / 1000), r = {}, cc = {};
			for (const c of all) {
				r[c.name] = [c.level, c.xp, c.kills, c.credits, c.deaths, c.dmg.done.net, c.dmg.done.raw, c.dmg.taken.net, c.heal.done.net, c.heal.done.raw, income(c), looted(c), c.hp, c.mp, c.mana.spent, goldNow(c),
					c.alive_ms, c.combat_ms, c.party_ms, ...["citizen0aura", "citizen4aura", "mluck", "encouragement_lonewolf", "party"].map((k) => (c.cond[k] ? c.cond[k].ms : 0)), c.angel.gold, c.dmg.taken.raw];
				// v2.2: every condition's cumulative ms on since the base (the lossless record of the timeline)
				const on = Object.fromEntries(Object.entries(c.cond).filter(([, e]) => e.ms > 0).map(([k, e]) => [k, e.ms]));
				if (Object.keys(on).length) cc[c.name] = on;
			}
			grid.push({ t: gt, v: nextGrid, r, c: cc });
			while (nextGrid <= v) nextGrid += gridMs;
		}
	}
	return snapshot(run, until, { F, M, trips, perF, deaths, killed, partyH, grid, V0, gridMs });
}

// v2.2 timeline: every key's true intervals, a ring of 40 closed rows per key and 200 per character (then the oldest
// row of the key with the most goes); what was dropped per key, and from when each key's rows are complete (since)
function ring(rows) {
	const byK = new Map(), dropped_by = {}, since = {}, closed = (a) => a.filter((r) => r[2] != null).length;
	for (const r of rows) (byK.get(r[0]) || byK.set(r[0], []).get(r[0])).push(r);
	const drop = (k) => {
		const a = byK.get(k);
		a.splice(a.findIndex((r) => r[2] != null), 1);
		dropped_by[k] = (dropped_by[k] || 0) + 1;
		since[k] = a.length ? a[0][1] : null;
	};
	for (const [k, a] of byK) while (closed(a) > 40) drop(k);
	while ([...byK.values()].reduce((n, a) => n + closed(a), 0) > 200) drop([...byK].sort((x, y) => closed(y[1]) - closed(x[1]))[0][0]);
	return { rows: [...byK.values()].flat().sort((a, b) => a[1] - b[1]), dropped: Object.values(dropped_by).reduce((a, b) => a + b, 0), dropped_by, since };
}
const idOf = (run) => run.tag.replace(/[^\w.-]+/g, "_") + "_s" + run.seed + "--" + (T0 + run.start * 3 * 3600e3);

function snapshot(run, until, { F, M, trips, perF, deaths, killed, partyH, grid, V0, gridMs }) {
	const measured = until * 1000,
		speed = 150,
		real = Math.round(measured / speed) + 6000,
		started = T0 + run.start * 3 * 3600e3, // fixed, so every generation writes the same file; the running one's updated is now
		party = F.length > 1,
		mix = run.spot.mix;
	const player = (c, i) => {
		const merchant = c.type === "merchant", d = c.dmg;
		const dmg = { ...d, overkill: d.done.raw - d.done.net };
		const gear = { mainhand: merchant ? (run.fights ? CLS.merchant.weapon : "staff+0") : CLS[c.type].weapon, ...(merchant ? { helmet: "helmet+0", shoes: "shoes+0" } : GEAR) };
		const share = (k) => (c.cond[k] ? Math.min(1, c.cond[k].ms / measured) : 0);
		const timeline = { gap_ms: 1000, cap: 200, key_cap: 40, ...ring(c.rows.map((r) => [...r])) };
		const on = Object.fromEntries(Object.entries(c.on).map(([k, o]) => [k, { ...o }]));
		const p = {
			name: c.name, type: c.type, level: c.level, start_level: c.start_level, xp: c.xpNow, max_xp: LEVELS[c.level] || 0, xp_gained: c.xp,
			gold: goldNow(c), map: c.map, x: Math.round(c.pos[0]), y: Math.round(c.pos[1]), rip: c.dead > until, free: merchant ? 11 : 20 - i * 3,
			hpots: c.hp, mpots: c.mp, pots: c.pots, kills: c.kills, deaths: c.deaths, trips: merchant ? c.trips : 0, outings: merchant ? c.outings : 0, town_visits: merchant ? 0 : Math.floor(until / 5400),
			out_share: merchant ? 0.21 : 0.98, maps: merchant ? { main: 0.9, [run.spot.map === "main" ? "bank" : run.spot.map]: 0.1 } : { [run.spot.map]: 1 },
			gear, gear_stat: merchant ? {} : { helmet: "dex", chest: "dex", pants: "dex", shoes: "dex", gloves: "dex" }, history: c.history, measured_ms: measured,
			role: merchant ? "merchant" : { priest: "healer", paladin: "tank", warrior: "tank" }[c.type] || "dps",
			party: party && !merchant ? { name: F[0].name, share: Math.round((1 / F.length) * 1e4) / 1e4, ms: c.party_ms, xp: c.xp } : { name: null, share: null, ms: 0, xp: 0 },
			buffs: { lonewolf: share("encouragement_lonewolf"), mluck: share("mluck"), xpm: c.cur.xpm, goldm: c.cur.goldm, luckm: +c.cur.luckm.toFixed(2) },
			alive_ms: c.alive_ms, combat_ms: c.combat_ms, credits: c.credits, casts: c.casts, gold_start: c.gold_start, xp_lost: 0, xp_award: c.xp,
			dmg, heal: c.heal, mana: c.mana, items: c.items, gold_flow: c.gold_flow, chests: { ...c.chests, gone: Math.round(c.chests.opened * 0.02) }, modes: c.modes,
			conditions: Object.fromEntries(Object.entries(c.cond).map(([k, e]) => [k, { ms: e.ms, n: e.n, max_ms: e.max_ms, kind: KIND[k] || "other", ...(e.v != null ? { v: e.v } : {}) }])),
			mult_avg: Object.fromEntries(Object.entries(c.mult).map(([k, v]) => [k, +(v / measured).toFixed(4)])),
			on, timeline,
			...(run.exact && !merchant ? { exact: { angel_gold: c.angel.gold, angel_chests: c.angel.chests, kane_kills: c.angel.kills } } : {}),
		};
		return p;
	};
	const all = [...F, M], players = all.map(player), sum = (f) => all.reduce((a, c) => a + f(c), 0);
	const groups = new Map();
	for (const d of deaths) {
		const k = d.name + d.map;
		const g = groups.get(k) || groups.set(k, { name: d.name, map: d.map, x: Math.round(d.x / 100) * 100, y: Math.round(d.y / 100) * 100, by: d.by, n: 0, first: d.t, last: d.t, level: d.level }).get(k);
		(g.n++, (g.last = d.t));
	}
	const gold0 = 60e6, goldNet = sum((c) => { const g = c.gold_flow; return income(c) + g.other - g.bought - g.craft - g.other_out; }); // sends and deposits stay in the account
	const roster = all.map((c) => ({ name: c.name, type: c.type, level: c.start_level, role: c.type === "merchant" ? "merchant" : { priest: "healer", paladin: "tank" }[c.type] || "dps", code: c.type === "merchant" ? "Mer1" : c.name, gear_hash: sha(c.name + c.type, 8) }));
	const where = Object.keys(mix).join("+") + " " + run.spot.map;
	const id = idOf(run);

	const npcKills = run.npcKills || {};
	const lines = grid.map((g) => JSON.stringify(g)), tail = grid.slice(-10).map(({ c, ...g }) => g); // the inline tail without c
	const plan = (run.plan || run.hours) * 3600e3, failed = run.end && run.end.reason === "failed";
	// run control: who writes it (a fake pid on no real host), what it accepts, how it ended, how to run it again
	const control = {
		proc: { pid: 41000 + run.start, host: "fixture", start: 8800000 + run.start, cwd: ROOT, cmdline: null, log: null },
		control: { file: id + ".ctl", stop: true, ack: 0 },
		launch: run.launch ? { key: "l-fixture-" + run.start, rerun_of: idOf(RUNS[run.launch.rerun_of]) } : null,
		end: run.running ? null : run.end || { reason: "complete", detail: "duration" },
		run: { root: ROOT, script: "chronal run", seed: run.seed, duration_ms: plan, warmup_ms: 60e3, until: run.until || null },
	};
	const w = {
		id, tag: run.tag,
		strategy: F.map((f) => f.type + " L" + f.start_level).join(" + ") + " + merchant" + (run.fights ? " (fights)" : "") + " @ " + where,
		script: "chronal run",
		versions: { sim: "fixture", code: "338ee20", code_hash: "fx" + sha(where, 6) }, setup_key: sha(JSON.stringify([run.members, run.spot, roster])),
		started: new Date(started).toISOString(), updated: new Date(run.running ? Date.now() : started + real).toISOString(), done: !run.running && !failed,
		virtual_ms: measured + 21345, measured_ms: measured, real_ms: real, trips_available: true,
		speed: { now: run.running ? speed + 4 : null, avg: speed, median: speed, min: Math.round(speed * 0.4), max: Math.round(speed * 1.2) },
		load: { now: run.running ? { server: 0.82, Mer1: 0.21, ...Object.fromEntries(F.map((f) => [f.name, 0.4])) } : null, avg: { server: 0.8, Mer1: 0.2, ...Object.fromEntries(F.map((f) => [f.name, 0.38])) } },
		gold: { start: gold0, now: gold0 + goldNet },
		kills: { total: all.reduce((a, f) => a + f.kills, 0), by_type: { ...killed }, others: { total: Object.values(npcKills).reduce((a, b) => a + b, 0), by_type: { ...npcKills }, by: Object.keys(npcKills).length ? { Baron: Object.values(npcKills).reduce((a, b) => a + b, 0) } : {} } },
		deaths: { total: deaths.length, groups: [...groups.values()], recent: deaths.slice(-10) },
		players, notes: {},
		world: { clock: V0 + measured, globals: { goldm: 1, luckm: 1, xpm: 1 }, ...worldOf(run, until, !run.running) },
		schema: 2, schema_minor: 2,
		precision: { dmg_done: "net", dmg_taken: "net", heal: "net", items: "exact", gold: "exact", gold_other: "exact", mana_by_skill: "exact", sample_ms: 250, modes: "exact", grid: "exact", attrib: "exact", overkill: "exact", overheal: "exact" },
		history_cols: HISTORY_COLS,
		roster,
		party: {
			members: F.map((f) => f.name), merchant: M.name, merchant_in_party: false, formed_ms: party ? 0 : null, party_ms: party ? F[0].party_ms : 0,
			groups: party ? { [F[0].name]: F.map((f) => f.name) } : {},
			history: partyH,
		},
		merchant: { name: M.name, trips: trips.slice(-50), per_fighter: perF },
		...control,
		grid: { step_ms: gridMs, cols: GRID_COLS, file: id + ".grid.ndjson", lines: lines.length, gen: 0, tail },
		_grid: [JSON.stringify({ cols: GRID_COLS, step_ms: gridMs, id }), ...lines], // written beside, not into the snapshot
	};
	return setupRun(run, w, all, started);
}

// Every run is a run of a setup: its resolved setup file and CODE as setup.js stores them
// (_setup: { side, bundles }; main writes <id>.setup.json and code/<sha>.json, <sha>.js beside the snapshot), and what
// the snapshot takes from it: the setup block, strategy, versions, roster (account, party, code hash), the run plan
// and setup_key. The CODE is a toy "any CODE" (an entry file, a helper slot, a report file appended).
const ANY = "/opt/anycode",
	HELPER = { helper: "function pick_target(types) {\n\treturn get_nearest_monster({ type: types[0] });\n}\n//# sourceURL=code/helper.js\n" },
	FARM = 'require_code("helper");\nsetInterval(function () {\n\tvar t = pick_target(chronal.params.farm.monsters);\n\tif (t && !is_on_cooldown("attack")) attack(t);\n}, 250);\n',
	STAND = "setInterval(function () {\n\tif (!character.stand) open_stand();\n}, 5000);\n",
	REPORT = 'var chronal = (self.chronal = self.chronal || {});\nchronal.mode = function () {\n\treturn character.rip ? "dead" : "farm";\n};\n';
const blob = (s) => sha(s, 16); // a store name, as setup.js's: a slot map's JSON (keys sorted; one key here) or an entry's text
const itemOf = (s) => ({ name: s.split("+")[0], level: +s.split("+")[1] });
function setupRun(run, w, all, started) {
	const at = new Date(started).toISOString(),
		members = all.filter((c) => c.type !== "merchant").map((c) => c.name),
		farm = { map: run.spot.map, x: run.spot.x, y: run.spot.y, monsters: Object.keys(run.spot.mix) },
		bundles = {},
		source = { characters: {}, accounts: {} },
		age = run.setup ? run.setup.age_days : 0;
	const characters = all.map((c, i) => {
		const merchant = c.type === "merchant",
			params = merchant ? null : { farm },
			extra = merchant ? ['chronal.role = "merchant";'] : [],
			entry = merchant ? "stand.js" : "farm.js",
			files = merchant ? {} : HELPER,
			text = SETUP.composeEntry({ params, entryText: merchant ? STAND : FARM, append: [REPORT], extra }),
			slots = blob(JSON.stringify(files)),
			t = blob(text);
		bundles[c.name] = { entry, files, text };
		const gear = merchant ? { mainhand: "staff+0", helmet: "helmet+0", shoes: "shoes+0" } : { mainhand: CLS[c.type].weapon, ...GEAR },
			state = { level: c.start_level, xp: Math.round(LEVELS[c.start_level] * 0.2), gold: c.gold_start, items: [{ name: "hpot1", q: 200 }, { name: "mpot1", q: 200 }, null, { name: "seashell", q: 3 }], slots: Object.fromEntries(Object.entries(gear).map(([k, v]) => [k, itemOf(v)])) },
			pos = { map: run.spot.map, x: run.spot.x + 30 * i, y: run.spot.y + 10 * i },
			from = merchant ? "/opt/exports/" + c.name + ".json" : null;
		source.characters[c.name] = { code_dir: merchant ? null : ANY + "/lib", recursive: false, code_git: "?", entry: null, file: ANY + "/" + entry, append: [ANY + "/report.js"], extra, prelude: null, build: null, state_from: from, exported_at: from && at };
		return { name: c.name, class: c.type, account: "main", role: null, fps: merchant ? 2 : 10, at: pos, params, state, code: { entry, slots, text: t, hash: sha(slots + t) } };
	});
	const bank = { gold: 2.5e6, items0: [{ name: "seashell", q: 40 }, { name: "ringsj", level: 1 }, null], items1: [] };
	source.accounts.main = { bank_from: "/opt/exports/Mer1.json" };
	const side = {
		format: SETUP.FORMAT, resolved: { at, by: "chronal run", from: ANY + "/setup.json" }, name: run.tag, strategy: null,
		run: { duration: run.hours * 60 + "m", warmup: "1m", seed: run.seed, until: run.until || null, check: "1s", grid_ms: (run.grid_s || GRID_MS / 1000) * 1000 },
		world: { roi: null, threads: true, age: run.world ? ageText(run.world.age) : "0m", ping: 18 }, party: { members, leader: members[0], form: "harness" },
		accounts: { main: { age_days: age, bank } }, characters, source,
	};
	const inParty = new Set(members);
	Object.assign(w, {
		strategy: SETUP.strategyText(side, { formed: true }),
		versions: { ...w.versions, code: "?", code_hash: SETUP.codeHash(side) },
		setup: { format: side.format, file: w.id + ".setup.json", name: side.name, from: side.resolved.from, hash: SETUP.sideHash(side) },
		roster: characters.map((c) => {
			const st = c.state;
			return { name: c.name, type: c.class, level: st.level, role: c.class === "merchant" ? "merchant" : { priest: "healer", paladin: "tank", warrior: "tank" }[c.class] || "dps", code: c.code.entry, gear_hash: sha(JSON.stringify(st.slots)), account: c.account, party: inParty.has(c.name), code_hash: c.code.hash };
		}),
		_setup: { side, bundles },
	});
	w.setup_key = SETUP.setupKey(side, w.versions.sim);
	w.proc.cmdline = "node\0chronal.js\0" + "run" + "\0" + ANY + "/setup.json";
	return w;
}

// the sums the schema promises; throws on the first one that doesn't hold
function check(w) {
	const F = w.players.filter((p) => p.type !== "merchant"), M = w.players.find((p) => p.type === "merchant");
	const eq = (a, b, what) => {
		if (a !== b) throw new Error(w.id + ": " + what + " " + a + " != " + b);
	};
	const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0), vals = (o, k) => Object.values(o).reduce((a, e) => a + (k ? e[k] : e), 0);
	for (const p of w.players) {
		eq(vals(p.dmg.by_skill, "raw"), p.dmg.done.raw, p.name + " by_skill");
		eq(vals(p.dmg.by_target, "raw"), p.dmg.done.raw, p.name + " by_target");
		eq(vals(p.dmg.taken_by, "net"), p.dmg.taken.net, p.name + " taken_by");
		eq(vals(p.heal.received_by, "net"), p.heal.received.net, p.name + " received_by");
		eq(vals(p.heal.by_target, "raw"), p.heal.done.raw, p.name + " heal by_target");
		const g = p.gold_flow;
		eq(p.gold - p.gold_start, g.loot + g.sold + g.stand + g.received + g.other - g.bought - g.craft - g.sent - g.other_out - g.banked, p.name + " gold identity");
		const h = p.history[p.history.length - 1];
		eq(h[2], p.xp_gained, p.name + " history xp");
		eq(h[3] + h[4], p.hpots + p.mpots, p.name + " history pots");
		for (const [k, o] of Object.entries(p.on)) if (o.ms > w.measured_ms || o.ms !== p.conditions[k].ms) throw new Error(w.id + ": " + p.name + " on." + k + ".ms");
		const last = w.grid.tail[w.grid.tail.length - 1].r[p.name];
		if (last[1] > p.xp_gained || last[2] > p.kills) throw new Error(w.id + ": " + p.name + " grid past the totals");
		if (w.schema_minor >= 2) {
			// v2.2: overkill = raw - net, taken_raw last in the history, a ring of 40 per key, every condition's kind,
			// history rows spread over the run (no stretch over a quarter of it once thinned)
			eq(p.dmg.overkill, p.dmg.done.raw - p.dmg.done.net, p.name + " overkill");
			eq(h[w.history_cols.indexOf("taken_raw")], p.dmg.taken.raw, p.name + " history taken_raw");
			const per = {};
			for (const r of p.timeline.rows) if (r[2] != null) per[r[0]] = (per[r[0]] || 0) + 1;
			if (Object.values(per).some((n) => n > 40) || Object.values(per).reduce((a, b) => a + b, 0) > 200) throw new Error(w.id + ": " + p.name + " timeline over its caps");
			for (const [k, c] of Object.entries(p.conditions)) if (!c.kind) throw new Error(w.id + ": " + p.name + " conditions." + k + " without a kind");
			const hs = p.history.map((r) => r[0]);
			if (hs.length > 150 && hs.some((t, i) => i && t - hs[i - 1] > (hs[hs.length - 1] - hs[0]) / 4)) throw new Error(w.id + ": " + p.name + " history not uniform");
		}
	}
	const ph = w.party.history[w.party.history.length - 1];
	eq(ph[2], sum(F, (p) => p.xp_gained), "party history xp");
	eq(ph[12], sum(F, (p) => p.dmg.done.raw), "party history dmg_raw");
	for (const f of F) for (const [item, from] of Object.entries(f.items.received)) eq(from[M.name], M.items.sent[item][f.name], f.name + " received " + item);
	eq(w.kills.total, vals(w.kills.by_type), "kills by type");
	return w;
}

function main() {
	const argv = process.argv.slice(2), i = argv.indexOf("--dir");
	const dir = path.resolve(i >= 0 ? argv[i + 1] : path.join(__dirname, "live-v2"));
	fs.mkdirSync(dir, { recursive: true });
	for (const f of fs.readdirSync(dir)) if (/^fx_/.test(f)) fs.unlinkSync(path.join(dir, f));
	const put = (file, text) => {
		const tmp = path.join(dir, "." + file + ".tmp");
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, path.join(dir, file));
	};
	const write = (w) => {
		const { _grid, _setup, ...snap } = w;
		put(w.id + ".grid.ndjson", _grid.join("\n") + "\n");
		if (_setup) {
			// its CODE in the store (written once), then its setup file, as live.js does
			const stored = SETUP.storeBundles(_setup.bundles, path.join(dir, "code"));
			for (const c of _setup.side.characters) if (stored[c.name].slots !== c.code.slots || stored[c.name].text !== c.code.text) throw new Error(w.id + ": " + c.name + "'s stored CODE is not its code block");
			put(w.id + ".setup.json", JSON.stringify(_setup.side, null, 1));
		}
		put(w.id + ".json", JSON.stringify(snap));
		return w;
	};
	const live = [];
	for (const run of RUNS) {
		const w = write(check(generate(run, run.running ? run.hours * 3600 * 0.6 : undefined)));
		if (run.running) live.push({ run, id: w.id, started: w.started, lines: w._grid.length });
		console.log(w.id, w.players.map((p) => p.name + " L" + p.level + " xp " + p.xp_gained).join(", "), "grid", w._grid.length - 1);
	}
	if (argv.includes("--tick")) {
		// the running ones move on in the same files (30 game s per real s); their grid files get the new lines
		const t0 = Date.now();
		setInterval(() => {
			for (const l of live) {
				const { run, id, started } = l, x = 30;
				const until = Math.min(run.hours * 3600, Math.round((run.hours * 3600 * 0.6 + ((Date.now() - t0) / 1000) * x) / STEP) * STEP), done = until >= run.hours * 3600;
				const { _grid, _setup, ...w } = generate(run, until);
				if (_grid.length > l.lines) (fs.appendFileSync(path.join(dir, id + ".grid.ndjson"), _grid.slice(l.lines).join("\n") + "\n"), (l.lines = _grid.length));
				put(id + ".json", JSON.stringify({ ...w, id, started, done, ...(done && w.schema_minor >= 2 ? { end: { reason: "complete", detail: "duration" } } : {}) }));
			}
		}, 1000);
	}
}
main();
