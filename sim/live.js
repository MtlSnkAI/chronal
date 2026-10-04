"use strict";
// Optional live snapshots for the dashboard (dashboard/server.js), schema v2.2 (docs/reference/snapshot.md). On with a
// dir (createSim's live option, chronal run --live; its default: config live_dir), the sim writes <dir>/<id>.json about once a real second, and <dir>/<id>.grid.ndjson (a row per character every GRID_MS
// game ms), built from the server's own state on the main thread: no virtual-clock events, so outcomes stay
// byte-identical. Counters come from wrappers on server functions that call the original with the same `this` and
// arguments, return its result and only count (inside try/catch; nothing is added to game objects, no game function
// with side effects is called):
// - combat: complete_attack() keeps a stack of contexts (attacker, skill); xy_emit(..., "hit") reads every hit while
//   it's sent (raw amounts, misses, crits on a context's first target only: def.crit/lifesteal go stale across splash
//   targets). Net amounts come from the server's own calls: achievement_logic_monster_damage() (player -> monster),
//   encouragement_wound() (monster -> player) and encouragement_heal() (heals; none = nothing restored), all within
//   the same target's turn. Burn ticks come as their own "hit"; a killing tick's net from add_coop_points().
// - requests: instance_block_action() opens one (player, method, data), the sim socket's _packet() closes it once the
//   handler returned: every character's gold before/after (by method: loot, sold, bought, sent...), potions and
//   regen (hp/mp before/after), chest opens (dry/stale from the chest's distance and age), upgrade/compound rolls.
// - items: consume() by ls_method, only inside a handler (drunk/used, exchanged; listing and sales apart), add_item()
//   (chest loot, mluck copies, exchange results), success_response() (NPC buys and sales, crafts), add_to_history()
//   (sends between characters), exchange() (results and gold, outside handlers).
// - xp: issue_monster_award() before/after (the exact party split) and kill credits (p.p.stats.monsters); consume_mp()
//   (mana by skill), consume_skill() (casts); kill_monster() (last hits), rip() + defeated_by_a_monster() (deaths).
// - buffs: encouragement_chest() (each kill's drop recipient and its chest), encouragement_loot() (Angel's share of the
//   encouragement gold); `on` counts outcomes by the conditions of the character they belong to at that moment.
// Every PROBE_MS game ms (from the lockstep window loop): town trips with the fighters met, time per map. Every
// SAMPLE_MS: time alive / in combat / in a party, multipliers, conditions (p.s keys and pseudo keys) with their
// timeline. What the CODE reports (report.js: its chronal object): each client thread reads the mode after every
// lockstep window and the status and role every STATUS_MS, through guarded(), and posts them (client_worker.js); the
// single-thread Sim reads them in probe(). Rates and every v2 counter start at the first probe with every character in
// game (the base: a game time, the same for the same seed; the single-thread Sim probes once per real second). The
// world: the monster levels by instance and type at the base and at close (mlevels(): a read of the server's
// instances), and the world's age (start.js aged(): the game time it ran with no characters; virtual_ms counts from the
// login).
// peek(): the snapshot as it would be written now, nothing of it kept (what steering conditions and run.until read:
// steer.js); each character's hp, mp, condition keys and CODE mode now, its kills by type and the last one's t, each
// account's bank (banks) are there for them.
// Runners attach fields with sim.live.note(key, value) and the steering applied with sim.live.steered(entry). A run of a
// setup (chronal run: new Live(sim, { setup: { resolved, bundles } })) is described by it: <id>.setup.json (the resolved
// setup) and its CODE in <dir>/code/ (setup.js storeBundles) are written at construction, the snapshot's setup block,
// roster, run plan, versions and setup_key come from it.
// Run control: the snapshot names its process (proc), how to run it again (run) and how it ended (end); the dashboard
// asks for a stop through <id>.ctl, read at the snapshot cadence (sim.halt("dashboard"), acked in control.ack).
// Naming: here S is the server's vm context (its globals); the server's own `var S` ("server data") is S.S.
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	vm = require("node:vm"),
	crypto = require("node:crypto"),
	{ receiveMessageOnPort } = require("node:worker_threads"),
	{ ServerSocket } = require("./fake_io"),
	{ readMode, readStatus, readRole, guarded, logTap, LOG_KEEP, STATUS_MS, WHY } = require("./report"),
	SETUP = require("../lib/setup"),
	SCH = require("../lib/schedule"),
	{ gitVersion, simVersion } = SETUP;

const GEAR = ["mainhand", "offhand", "helmet", "chest", "pants", "shoes", "gloves", "ring1", "ring2", "earring1", "earring2", "amulet", "belt", "orb", "cape", "elixir"];
const HISTORY = 300; // points per character, spread evenly over the run (histPush)
const HISTORY_COLS = ["t", "level", "xp", "hpots", "mpots", "kills", "deaths", "dmg", "taken", "heal", "income", "trips", "dmg_raw", "heal_raw", "taken_raw"];
// town for trips: main within 600 px of 0,0 to come back, beyond 800 px to have left (hysteresis); the bank maps
const TOWN_IN = 600, TOWN_OUT = 800, DELIVERY_R = 400, RESPAWN_MS = 120_000;
const PROBE_MS = 100; // game ms between town/map checks (about 5 px of walking)
const SAMPLE_MS = 250; // game ms between samples of the time counters and conditions
const COMBAT_MS = 3000, TRIPS = 50;
const BANK_PACK = 42; // slots in a bank pack
const ROLE = { merchant: "merchant", priest: "healer", warrior: "tank", paladin: "tank" };
// requests whose add_item() is counted elsewhere (buy/craft: the response, send: the history) or only moves an item
const MOVED = new Set(["buy", "send", "craft", "exchange", "unequip", "equip", "bank", "swap", "split", "trade_buy", "trade_sell"]);
// conditions: intervals less than GAP_MS apart are one; the timeline has every key, TL_KEY_CAP closed rows per key and
// TL_CAP per character
const GAP_MS = 1000, TL_CAP = 200, TL_KEY_CAP = 40;
// a condition's kind: G.conditions' buff/debuff flags, these first
const KIND = { citizen0aura: "buff", citizen4aura: "buff", newcomersblessing: "buff", elixir: "buff", party: "buff", booster: "buff", fear: "debuff", realmfatigue: "debuff" };
// outcomes while a condition was on (`on`): these s keys and the pseudo keys party and fear
const ON_S = ["citizen0aura", "citizen4aura", "mluck", "encouragement_new", "encouragement_lonewolf", "encouragement_returning", "poisoned"];
const ON_KEYS = new Set([...ON_S, "party", "fear"]);
const onRow = () => ({ xp: 0, credits: 0, rkills: 0, items: 0, chests: 0, loot_gold: 0, x10: 0, x50: 0, dmg: 0, taken: 0, heal: 0, hpots: 0 });
// the fixed game-time grid (<id>.grid.ndjson): a row per character at the base and every GRID_MS game ms, cumulative since it;
// each line's `c` has every condition's ms by character
const GRID_COLS = ["level", "xp", "kills", "credits", "deaths", "dmg", "dmg_raw", "taken", "heal", "heal_raw", "income", "loot_items", "hpots", "mpots", "mana", "gold",
	"alive_ms", "combat_ms", "party_ms", "c_citizen0aura", "c_citizen4aura", "c_mluck", "c_lonewolf", "c_party", "angel_gold", "taken_raw"];
const GRID_TAIL = 10, GRID_MAX = 8 << 20, GRID_KEEP_MS = 24 * 3600_000;
// the items' events (<id>.items.ndjson, a line each from the base on): { t, k, who, ... } k loot (item, level, q),
// upgrade or compound (item, from, to: the levels; ok; lost), stat (item, stat, ok), give (to, item, level, q), gold (to,
// amount); past ITEMS_MAX a last { k: "cap" } and no more
const ITEMS_MAX = 16 << 20;

const sha = (s, n = 8) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
// the players[] gear: GEAR order, "name+level", stat scrolls apart; gear_hash hashes both
function gearOf(slots) {
	const gear = {},
		gear_stat = {};
	for (const k of GEAR) if (slots && slots[k]) (gear[k] = slots[k].name + (slots[k].level != null ? "+" + slots[k].level : "")), slots[k].stat_type && (gear_stat[k] = slots[k].stat_type);
	return { gear, gear_stat };
}
const gearHash = (slots) => sha(JSON.stringify(gearOf(slots)));
// the players[] stats: the game's character sheet (the XP bar's panel) as the server computed it, plus max hp and mp;
// the numbers a character has
const STATS = ["max_hp", "max_mp", "attack", "heal", "frequency", "str", "int", "dex", "vit", "for", "armor", "resistance", "courage", "mcourage", "pcourage", "speed", "mp_cost",
	"lifesteal", "manasteal", "dreturn", "reflection", "evasion", "miss", "crit", "critdamage", "apiercing", "rpiercing", "goldm", "xpm", "luckm", "tax"];
const statsOf = (p) => Object.fromEntries(STATS.filter((k) => typeof p[k] === "number" && isFinite(p[k])).map((k) => [k, +p[k].toFixed(4)]));
const tax = (g) => g - parseInt(g * 0.1); // server_tax() without its side effect (S.gold)
const r1 = (ms) => Math.round(ms / 100) / 10; // measured game s, 1 decimal

const amount = () => ({ raw: 0, net: 0 }),
	entry = (o, k) => o[k] || (o[k] = { raw: 0, net: 0, hits: 0 }),
	skillEntry = (o, k) => o[k] || (o[k] = { raw: 0, net: 0, hits: 0, crits: 0, misses: 0 }),
	inc = (o, k, q) => (o[k] = (o[k] || 0) + q),
	nest = (o, k, k2, q) => {
		const x = o[k] || (o[k] = {});
		x[k2] = (x[k2] || 0) + q;
	},
	ledger = () => ({ trips: 0, meetings: 0, deliveries: 0, pickups: 0, sent: {}, received: {}, gold_sent: 0, gold_received: 0, mluck: 0 });
// a raw + net pair into a total and a keyed entry
function both(total, map, key, raw, net) {
	total.raw += raw;
	total.net += net;
	const e = entry(map, key);
	e.raw += raw;
	e.net += net;
	e.hits++;
}
// a condition's value: what changes its effect (a new value closes its timeline row and opens another), for the
// conditions and the pseudo keys (conditions())
function condValue(k, x) {
	if (!x || typeof x !== "object") return undefined;
	if (k === "citizen0aura") return x.luck;
	if (k === "citizen4aura") return x.gold;
	if (k === "mluck") return x.f;
	if (k.startsWith("encouragement_")) return `${x.gold_multiplier}/${x.xp_multiplier}/${x.luck_multiplier}` + (x.phase != null ? " p" + x.phase : "");
	if (k.startsWith("paladin_aura_")) return `${x.f} r${x.rank}`;
	return undefined;
}
const kindOf = (k, G) => {
	const c = G.conditions[k];
	return KIND[k] || (k.startsWith("encouragement_") ? "buff" : c && c.buff ? "buff" : c && c.debuff ? "debuff" : "other");
};
// timeline rows [key, t_on, t_off | null, v] by key (ms since the base here, s in the snapshot): the same key and value
// back within gap_ms of the close extends the row (fear: any level; the row keeps the highest)
function tlOpen(tl, k, t, v) {
	const rows = tl.by[k] || (tl.by[k] = []),
		last = rows[rows.length - 1];
	if (last && last[2] != null && t - last[2] <= tl.gap_ms && (last[3] === v || k === "fear")) {
		if (k === "fear" && v > last[3]) last[3] = v;
		return void ((last[2] = null), tl.closed--);
	}
	rows.push([k, t, null, v]);
}
// a row closes; over key_cap closed rows of its key, or cap in all, the oldest closed row of that key (of the key with
// the most) goes: rows are never merged or made up, since[key] says from when a key's rows are complete
function tlClose(tl, k, t) {
	const rows = tl.by[k],
		last = rows && rows[rows.length - 1];
	if (!last || last[2] != null) return;
	last[2] = t;
	tl.closed++;
	if (rows.length > tl.key_cap) tlDrop(tl, k); // (all of its rows are closed now)
	while (tl.closed > tl.cap) {
		let top = null,
			n = 0;
		for (const x in tl.by) {
			const r = tl.by[x],
				c = r.length - (r.length && r[r.length - 1][2] == null ? 1 : 0);
			if (c > n) (n = c), (top = x);
		}
		tlDrop(tl, top);
	}
}
function tlDrop(tl, k) {
	const rows = tl.by[k],
		r = rows.shift();
	tl.closed--;
	tl.dropped++;
	tl.dropped_by[k] = (tl.dropped_by[k] || 0) + 1;
	tl.since[k] = rows.length ? rows[0][1] : r[2];
}
// a history row (`o.history`): rows at least o.hstep game s apart, the last one the latest pass (replaced until it is
// hstep after the one before); over HISTORY rows the step at least doubles and the rows are thinned to it, so they stay
// spread evenly from the base to now
function histPush(o, row) {
	const h = o.history || (o.history = []),
		n = h.length;
	if (n >= 2 && h[n - 1][0] - h[n - 2][0] < (o.hstep || 0)) h[n - 1] = row;
	else h.push(row);
	if (h.length <= HISTORY) return;
	o.hstep = Math.max(2 * (o.hstep || 0), (row[0] - h[0][0]) / (HISTORY / 2));
	const out = [h[0]];
	for (let i = 1; i < h.length - 1; i++) if (h[i][0] - out[out.length - 1][0] >= o.hstep) out.push(h[i]);
	out.push(row);
	o.history = out;
}
// the process that writes the snapshot: the dashboard checks pid + start (field 22 of /proc/<pid>/stat) + cwd before it
// signals anything; log = where stdout goes when that is a file
function procOf() {
	const read = (f) => {
		try {
			return fs.readFileSync(f, "latin1");
		} catch (e) {
			return null;
		}
	};
	const stat = read("/proc/self/stat"),
		start = stat ? Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]) : NaN;
	let log = null;
	try {
		if (fs.fstatSync(1).isFile()) log = fs.readlinkSync("/proc/self/fd/1");
	} catch (e) {}
	return { pid: process.pid, host: os.hostname(), start: Number.isFinite(start) ? start : null, cwd: process.cwd(), cmdline: read("/proc/self/cmdline"), log };
}

// monster levels (world.mlevels): { <instance>: { <type>: { n, avg, max } } }, the instances with monsters; the types
// the server's level-up loop never levels (cute, peaceful, stationary: critters, pets, dummies, cave NPCs) left out
function mlevels(S) {
	const out = {},
		M = S.G.monsters;
	for (const name of Object.keys(S.instances).sort()) {
		const by = {},
			list = S.instances[name].monsters;
		for (const id in list) {
			const m = list[id],
				d = M[m.type];
			if (!d || d.cute || d.peaceful || d.stationary) continue;
			const t = (by[m.type] ||= { n: 0, avg: 0, max: 0 });
			t.n++;
			t.avg += m.level;
			if (m.level > t.max) t.max = m.level;
		}
		const types = Object.keys(by).sort();
		if (!types.length) continue;
		out[name] = {};
		for (const k of types) out[name][k] = { n: by[k].n, avg: +(by[k].avg / by[k].n).toFixed(2), max: by[k].max };
	}
	return out;
}

// v2 counters of one character, from the base on
// a CODE's mode ms up to the clock `to`: its totals, and its current mode since the reading (before it: back)
function modesUpTo(x, to) {
	const o = { ...x.totals };
	if (x.cur != null && x.at != null) o[x.cur] = (o[x.cur] || 0) + to - x.at;
	return o;
}

function metrics(p, census) {
	return {
		p, // the player object (refreshed with this.ours)
		dmg: { done: amount(), by_skill: {}, by_target: {}, taken: amount(), taken_by: {}, taken_mp: 0, avoided: { miss: 0, evade: 0, avoid: 0 } },
		heal: { done: amount(), by_skill: {}, by_target: {}, received: amount(), received_by: {} },
		mana: { spent: 0, by_skill: {}, gained: { pots: 0, regen: 0, steal: 0, other: 0 } },
		items: { looted: {}, consumed: {}, bought: {}, sold: {}, stand_bought: {}, stand_sold: {}, sent: {}, received: {}, upgraded: {}, compounded: {}, exchanged: {}, crafted: {}, mluck_dupes: {}, from_exchange: {}, other: {} },
		gold_flow: { chest: 0, egold: 0, enc: 0, sold: 0, stand: 0, received: 0, other: 0, bought: 0, traded: 0, craft: 0, sent: 0, other_out: 0, banked: 0 },
		chests: { opened: 0, dry: 0, stale: 0, gone: 0 },
		casts: {}, credits: 0, xp_award: 0, xp_lost: 0, party_xp: 0, loot_items: 0, lastc: -Infinity,
		// time: alive, in combat, in a party, sampled (sums of the intervals between samples, by what was true at the first)
		alive_ms: 0, combat_ms: 0, party_ms: 0, sampled: 0, st: null,
		mult: { xpm: 0, goldm: 0, luckm: 0, enc_xp: 0, enc_gold: 0, enc_luck: 0 }, // value x ms
		cond: {}, gen: 0, on: {}, exact: { angel_gold: 0, angel_chests: 0, kane_kills: 0, angel_unmatched: 0 },
		tl: { gap_ms: GAP_MS, cap: TL_CAP, key_cap: TL_KEY_CAP, closed: 0, dropped: 0, dropped_by: {}, since: {}, by: {} },
		fd: !!(p.p && p.p.first_drop),
		gold0: p.gold || 0, t0: { mdamage: (p.t && p.t.mdamage) || 0, cgold: (p.t && p.t.cgold) || 0, xp: (p.t && p.t.xp) || 0 }, census0: census,
	};
}

const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 1e4) / 1e4 : null);
// sockets of which sim have a Live (requests are closed after their handler: ServerSocket._packet)
const LIVES = new Map();
let patched = false;
function patchSockets() {
	if (patched) return;
	patched = true;
	const proto = ServerSocket.prototype,
		orig = proto._packet;
	proto._packet = function (packet) {
		const live = LIVES.get(this.nsp && this.nsp.hub);
		if (!live) return orig.apply(this, arguments);
		live.req = live.reqData = null;
		const r = orig.apply(this, arguments);
		try {
			if (live.req) live.closeReq();
		} catch (e) {}
		live.req = live.reqData = null;
		return r;
	};
}
// a process that exits without sim.close() (an error, process.exit): its snapshots say "failed" (not done)
let exitHook = false;
function onExit(code) {
	for (const live of LIVES.values())
		if (!live.closed)
			try {
				live.end = { reason: "failed", detail: "exit " + code };
				live.write(false);
				fs.rmSync(live.ctl, { force: true });
			} catch (e) {}
}

// A run's id: its tag and its start (ms), or the next ms after it that is free in dir: an exclusive create of
// <id>.json (two runs of one tag that start in the same ms never share files) that no removed run had
function reserveId(dir, base, t) {
	for (; ; t++) {
		const id = base + "--" + t;
		if (fs.existsSync(path.join(dir, "removed", id + ".json"))) continue;
		try {
			fs.closeSync(fs.openSync(path.join(dir, id + ".json"), "wx"));
			return id;
		} catch (e) {
			if (e.code !== "EEXIST") throw e;
		}
	}
}

class Live {
	constructor(sim, { dir, tag, every = 1000, setup = null } = {}) {
		this.sim = sim;
		this.dir = path.resolve(dir);
		const rs = setup && setup.resolved, // a setup's run: { resolved, bundles }
			script = rs ? "chronal run" : path.basename(process.argv[1] || "sim", ".js"),
			env = process.env;
		this.setup = rs ? setup : null;
		this.started = Date.now();
		this.tag = String(tag || `${script} s${rs ? rs.run.seed : sim.seed}`);
		fs.mkdirSync(this.dir, { recursive: true });
		this.id = reserveId(this.dir, this.tag.replace(/[^\w.-]+/g, "_").slice(0, 80), this.started);
		this.file = path.join(this.dir, this.id + ".json");
		// run control: the dashboard's requests (ack: the last seq applied), how it ended, how to run it again
		this.ctl = path.join(this.dir, this.id + ".ctl");
		this.ack = 0;
		this.logs = {}; // name -> { lines, errors, console, last }: its game log (logged())
		this.taps = new WeakMap(); // single-thread Sim: a client -> its game log's tap (report.js logTap)
		this.outside = new Set(); // characters whose gold the totals leave out (their account's totals: false)
		this.outsideAccounts = [];
		this.exportWanted = null; // an export the dashboard asked for (its label): the run's loop writes it (exported())
		this.exports = []; // the state exports written: { label, at, t, dir }
		this.end = null;
		this.closed = false;
		this.proc = procOf();
		// the dashboard's launch that started it (env CHRONAL_LAUNCH_KEY, CHRONAL_RERUN_OF)
		this.launch = env.CHRONAL_LAUNCH_KEY || env.CHRONAL_RERUN_OF ? { key: env.CHRONAL_LAUNCH_KEY || null, rerun_of: env.CHRONAL_RERUN_OF || null } : null;
		// a setup's run: its plan
		this.runInfo = {
			root: fs.realpathSync(SETUP.ROOT), script, seed: rs ? rs.run.seed : sim.seed,
			duration_ms: rs ? SETUP.parseDuration(rs.run.duration) : null, warmup_ms: rs ? SETUP.parseDuration(rs.run.warmup) : null, until: rs ? rs.run.until : null,
		};
		this.every = Number.isFinite(every) && every >= 250 ? every : 1000;
		this.coarse = !sim.workers; // single-thread Sim: probed once per real second only
		this.notes = {};
		this.steers = []; // the setup's steering as applied (steered)
		this.v0 = sim.clock.now; // the run's start: after the world's age (aged())
		this.t0 = performance.now();
		this.ageMs = rs ? SETUP.parseDuration(rs.world.age) || 0 : 0; // world.age: game ms with no characters before they logged in
		this.mlv = { base: null, end: null }; // monster levels at the base and at the end (mlevels())
		this.forcedEvents = []; // the dailies and nightlies the setup forced (world.events): { event, at_ms, t } as they fired
		this.eventsSeen = {}; // a daily or nightly on at a snapshot: { <event>: { from, to } } (game s from the base; null: before it)
		this.last = 0;
		this.prev = null; // { real, v, busy } at the previous snapshot
		this.base = null; // { real, v, at, busy, gold, kills, deaths } at the first probe with every character in game, after the warm-up
		this.warmMs = rs ? SETUP.parseDuration(rs.run.warmup) || 0 : 0; // the warm-up: not measured
		this.measureAt = null; // the virtual ms the measured part starts at (measureFrom; else every character in game + the warm-up)
		this.speeds = [];
		this.who = {}; // name -> v1 counters
		this.kills = {}; // monster type -> kills by the run's characters
		this.okills = {}; // monster type -> kills by others (the game's fighting NPCs: Baron, Cunn...)
		this.okBy = {}; // killer (an NPC's name, a monster's type, "?") -> kills
		this.deaths = []; // every death: { t, name, level, map, x, y, by }
		this.killer = {};
		// v2
		this.mx = {}; // name -> metrics(), from the base on
		this.ours = []; // [player, metrics] of every character in game (a new array when that changes)
		this.list = []; // probe(): characters in game, fighters among them (reused)
		// characters that come and go (start_character, stop_character, a page's disconnect()): the names in game at the
		// last probe, the server's player object of each one that left (as it left: its row stays in players[]), and
		// every character's sessions [t_in, t_out] (game s from the base)
		this.inGame = new Set();
		this.gone = new Map();
		this.sessions = {};
		this.leftV = {}; // name -> the clock when it left (its CODE modes end there)
		this.modesPast = {}; // name -> mode ms of its sessions before this one (a new thread counts from 0)
		this.fighters = [];
		this.sf = []; // sample(): the fighters (reused)
		this.stack = []; // complete_attack() contexts (pooled), this.depth deep
		this.depth = 0;
		this.req = null; // the request whose handler runs now (one of ours, after the base)
		this.reqData = null; // its data, for any player
		this.pw = this.ph = this.pburn = this.dtE = null; // this target's net from encouragement_wound/_heal, a killing burn tick, hp before a player's burn tick
		this.pwNet = this.phAmt = this.dtHp = 0;
		this.exDepth = 0;
		this.roster = null;
		this.party = { formed: null, ms: 0, on: false, merchant_in: false, history: [] };
		this.merchant = { trips: [], per_fighter: {} };
		this.modeTotals = {}; // name -> { at, cur, totals: { mode: ms } } since the start (client threads)
		this.codes = {}; // name -> what its CODE reports: { from, status, role, impure: { field: why } | null, at } (reportOf())
		this.explicit = new Set(); // names whose roster role the setup gave
		this.warned = new Set();
		this.modes0 = {};
		this.sv = null; // the clock at the last sample
		this.chestX = new WeakMap(); // chest -> 10, 50 or 500 (its gold roll)
		this.grid = null;
		this.gridMs = Math.max(10_000, Number(rs && rs.run.grid_ms) || 30_000);
		if (rs) {
			const first = rs.source.characters[rs.characters[0].name] || {},
				members = new Set((rs.party && rs.party.members) || []);
			this.meta = {
				strategy: SETUP.strategyText(rs), script,
				versions: { sim: simVersion(), code: first.git ? first.git.commit.slice(0, 7) : first.code_dir || first.file ? gitVersion(first.code_dir || path.dirname(first.file)) : "?", code_hash: SETUP.codeHash(rs) },
				setup: { format: rs.format, file: this.id + ".setup.json", name: rs.name, from: (rs.resolved && rs.resolved.from) || null, hash: SETUP.sideHash(rs) },
			};
			// accounts.<k>.totals false (a market account): its characters' and bank's gold out of the run's gold totals
			this.outsideAccounts = Object.keys(rs.accounts || {}).filter((k) => rs.accounts[k].totals === false);
			this.outside = new Set(rs.characters.filter((c) => this.outsideAccounts.includes(c.account)).map((c) => c.name));
			this.roster = rs.characters.map((c) => ({ name: c.name, type: c.class, level: c.state ? c.state.level : null, role: c.role || ROLE[c.class] || "dps", code: c.code.entry, gear_hash: c.state ? gearHash(c.state.slots) : null,
				account: c.account, party: members.has(c.name), code_hash: c.code.hash, ...(c.online === false ? { online: false } : {}), ...(this.outside.has(c.name) ? { totals: false } : {}) }));
			this.explicit = new Set(rs.characters.filter((c) => c.role).map((c) => c.name));
		} else {
			this.meta = {
				strategy: "default", script,
				versions: { sim: simVersion(), code: null, code_hash: null },
			};
		}
		this.setupKey();
		if (rs) {
			// the resolved setup beside the snapshot, its CODE in the store (content-addressed, written once)
			SETUP.storeBundles(setup.bundles, path.join(this.dir, "code"));
			const f = path.join(this.dir, this.meta.setup.file),
				tmp = f + "." + process.pid + ".tmp";
			fs.writeFileSync(tmp, JSON.stringify(rs, null, 1));
			fs.renameSync(tmp, f);
		}
		this.wrap(sim.server);
		LIVES.set(sim.hub, this);
		patchSockets();
		if (!exitHook) (exitHook = true), process.on("exit", onExit);
		if (this.coarse) (this.timer = setInterval(() => this.tick(), this.every)).unref();
	}
	/** chronal run: the measured part starts at virtual ms v (after the warm-up): the base is the first probe from then on */
	measureFrom(v) {
		this.measureAt = v;
	}
	/** chronal run: the plan as it runs (its options over the setup's): duration_ms, warmup_ms, until (null: until stopped) */
	plan(o) {
		for (const k of ["duration_ms", "warmup_ms", "until"]) if (o[k] !== undefined) this.runInfo[k] = o[k];
	}
	/** start.js, once the world has run `ms` game ms with no characters (world.age): the run's game time starts now */
	aged(ms) {
		this.ageMs = ms;
		this.v0 = this.sim.clock.now;
		this.prev = null;
	}
	// the run's text: the setup's, else "default"
	strategyText(formed) {
		return this.setup ? SETUP.strategyText(this.setup.resolved, { formed }) : "default";
	}
	setupKey() {
		this.meta.setup_key = this.setup ? SETUP.setupKey(this.setup.resolved, this.meta.versions.sim) : null;
	}
	stat(name) {
		return (this.who[name] ||= { pots: {}, kills: 0, kby: {}, lastKill: null, deaths: 0, trips: 0, outings: 0, visits: 0, town: null, open: false, near: false, trip: null, lastDeath: -Infinity, out_ms: 0, maps: {}, at: null, start: null });
	}
	// players[].role: the setup's explicit role, else the CODE's (chronal.role), else rosterRole
	roleOf(p) {
		const c = this.codes[p.name];
		return (this.explicit.has(p.name) && this.rosterRole(p)) || (c && c.role) || this.rosterRole(p);
	}
	// roster[].role: the setup's, else by class (never the CODE's: the roster enters setup_key)
	rosterRole(p) {
		const r = this.roster && this.roster.find((x) => x.name === p.name);
		return (r && r.role) || ROLE[p.type] || "dps";
	}
	reportOf(name) {
		return (this.codes[name] ||= { from: null, status: null, role: null, impure: null, at: -Infinity });
	}
	xpTotal(level, xp) {
		const L = this.sim.server.G.levels;
		let t = xp || 0;
		for (let l = 1; l < level; l++) t += L[l] || 0;
		return t;
	}
	xpSince(p, level, xp) {
		return p.level === level ? p.xp - xp : this.xpTotal(p.level, p.xp) - this.xpTotal(level, xp);
	}
	// v1 counters of a character (deltas against its counters at the base)
	counters(p, s) {
		const pots = (re) => {
			let n = 0;
			for (const k in s.pots) if (re.test(k)) n += s.pots[k];
			return n;
		};
		return { xp: this.xpTotal(p.level, p.xp), kills: s.kills, deaths: s.deaths, hp: pots(/^hpot/), mp: pots(/^mpot/), trips: s.trips, visits: s.visits, outings: s.outings, level: p.level };
	}
	// Wrappers: same `this` and arguments, the original's result; they only count, inside try/catch.
	wrap(S) {
		const live = this,
			G = S.G,
			hook = (name, around) => {
				if (typeof S[name] === "function") S[name] = around(S[name]);
			},
			inHandler = () => S.current_socket !== S.false_socket;
		// items drunk, used, exchanged (consume_one calls consume)
		hook("consume", (orig) =>
			function (player, num, quantity) {
				let name;
				try {
					name = player.items[num] && player.items[num].name;
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					if (name && player.name && !player.npc) live.consumed(S, player, name, quantity);
				} catch (e) {}
				return r;
			});
		hook("kill_monster", (orig) =>
			function (attacker, target) {
				const was = !!(target && target.dead);
				const r = orig.apply(this, arguments);
				try {
					if (target && !was && target.dead) {
						// a run character's last hit (the sim has no other players), else another's: an NPC's (citizens that
						// fight), a monster's, none
						if (attacker && attacker.name && !attacker.npc) {
							const s = live.stat(attacker.name);
							(live.kills[target.type] = (live.kills[target.type] || 0) + 1), s.kills++;
							// by type and the last one: from the base (players[].kills_by, last_kill)
							if (live.base) (s.kby[target.type] = (s.kby[target.type] || 0) + 1), (s.lastKill = live.sim.clock.now);
						} else {
							const by = (attacker && (attacker.npc ? attacker.name || attacker.npc : attacker.type || attacker.name)) || "?";
							live.okills[target.type] = (live.okills[target.type] || 0) + 1;
							live.okBy[by] = (live.okBy[by] || 0) + 1;
						}
					}
				} catch (e) {}
				return r;
			});
		hook("defeated_by_a_monster", (orig) =>
			function (attacker, player) {
				let n, xp0;
				try {
					n = player && !player.npc && player.name;
					if (n) live.killer[n] = attacker ? attacker.type || attacker.name || "?" : "?";
					if (n && live.mx[n]) xp0 = [player.level, player.xp];
				} catch (e) {}
				try {
					return orig.apply(this, arguments);
				} finally {
					try {
						if (n) delete live.killer[n];
						if (xp0) live.mx[n].xp_lost -= live.xpSince(player, xp0[0], xp0[1]);
					} catch (e) {}
				}
			});
		hook("rip", (orig) =>
			function (player) {
				let was, burn;
				try {
					was = !!(player && player.rip);
					burn = player && player.s && player.s.burned;
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					if (player && !player.npc && player.name && !was && player.rip) {
						const s = live.stat(player.name),
							by = live.killer[player.name] || (burn ? "burn" + (burn.fid || burn.f ? " (" + (burn.fid || burn.f) + ")" : "") : "?");
						s.deaths++;
						s.lastDeath = live.sim.clock.now;
						live.deaths.push({ v: live.sim.clock.now, name: player.name, level: player.level, map: player.map, x: Math.round(player.x), y: Math.round(player.y), by });
						if (live.deaths.length > 20_000) live.deaths.splice(0, 10_000);
					}
				} catch (e) {}
				return r;
			});
		// combat: a context per complete_attack (it nests: a kill can start an instant attack)
		hook("complete_attack", (orig) =>
			function (attacker, target, info) {
				let pushed = false;
				try {
					pushed = live.push(attacker, info);
				} catch (e) {}
				try {
					return orig.apply(this, arguments);
				} finally {
					if (pushed) live.depth--;
				}
			});
		// every hit passes here (the hottest global): compiled in the server's context so the call stays in its realm;
		// only "hit" events reach the counting
		const onHit = (entity, data) => {
			try {
				live.hit(S, entity, data);
			} catch (e) {}
		};
		if (typeof S.xy_emit === "function")
			S.xy_emit = vm.runInContext(`(function (orig, onHit) {
				return function xy_emit(entity, event, data, must) {
					var r = orig.apply(this, arguments);
					if (event === "hit") onHit(entity, data);
					return r;
				};
			})`, S, { filename: "live.js:xy_emit" })(S.xy_emit, onHit);
		// the server's net amounts, each called within the same target's turn as its "hit"
		hook("achievement_logic_monster_damage", (orig) =>
			function (player, monster, damage) {
				const r = orig.apply(this, arguments);
				try {
					live.dealt(player, monster, damage);
				} catch (e) {}
				return r;
			});
		hook("encouragement_wound", (orig) =>
			function (player, monster, damage) {
				const r = orig.apply(this, arguments);
				try {
					(live.pw = player), (live.pwNet = damage);
				} catch (e) {}
				return r;
			});
		hook("encouragement_heal", (orig) =>
			function (healer, player, amount) {
				const r = orig.apply(this, arguments);
				try {
					(live.ph = player), (live.phAmt = amount);
				} catch (e) {}
				return r;
			});
		// a killing burn tick: contribution = the monster's hp before it
		hook("add_coop_points", (orig) =>
			function (m, attacker, mnet, contribution) {
				const r = orig.apply(this, arguments);
				try {
					const b = live.pburn;
					if (b && m === b.e && attacker && attacker.name === b.name) {
						live.pburn = null;
						(b.m.dmg.done.net += contribution), (b.s.net += contribution), (b.t.net += contribution);
						live.onAdd(b.m, "dmg", contribution);
					}
				} catch (e) {}
				return r;
			});
		// a player's burn tick shows its "-N" just before the hp change: remember the hp before
		hook("disappearing_text", (orig) =>
			function (socket, entity) {
				try {
					if (live.base && entity && entity.is_player) (live.dtE = entity), (live.dtHp = entity.hp);
				} catch (e) {}
				return orig.apply(this, arguments);
			});
		hook("consume_mp", (orig) =>
			function (player) {
				let mp0;
				try {
					mp0 = player.mp;
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					live.mana(player, mp0);
				} catch (e) {}
				return r;
			});
		// successful skill uses (casts); the merchant's mluck by target. A reuse call is not a use: the server starts a
		// reuse_cooldown later with it (invis on reappearing, pickpocket/fishing/mining on a success)
		hook("consume_skill", (orig) =>
			function (player, name, reuse) {
				const r = orig.apply(this, arguments);
				try {
					const m = player && live.mx[player.name];
					if (m && name && !reuse) {
						inc(m.casts, name, 1);
						const q = live.req,
							t = name === "mluck" && q && q.p === player && q.data && S.players[S.id_to_id[q.data.id]];
						if (t && t.name !== player.name) (live.merchant.per_fighter[t.name] ||= ledger()).mluck++;
					}
				} catch (e) {}
				return r;
			});
		// xp and kill credits: every character before/after (the party split, level-ups inside)
		hook("issue_monster_award", (orig) =>
			function (monster) {
				let pre;
				try {
					pre = live.awardPre(monster);
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					if (pre) live.awardPost(pre, monster);
				} catch (e) {}
				return r;
			});
		// each kill's chest, sealed at the end of drop_something(): its recipient (the monster's target) and items
		hook("encouragement_chest", (orig) =>
			function (player, monster, chest, share) {
				try {
					live.dropped(S, player, monster, chest, share);
				} catch (e) {}
				return orig.apply(this, arguments);
			});
		// a chest's encouragement gold (the receipts are gone after the call)
		hook("encouragement_loot", (orig) =>
			function (chest, goldm, looters) {
				let pre;
				try {
					pre = live.lootPre(S, chest, goldm);
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					if (pre) live.lootPost(pre);
				} catch (e) {}
				return r;
			});
		// requests: opened here (the handler runs next), closed by ServerSocket._packet after it
		hook("instance_block_action", (orig) =>
			function (player, method, data) {
				const r = orig.apply(this, arguments);
				try {
					if (!r) live.open(S, player, method, data);
				} catch (e) {}
				return r;
			});
		hook("add_item", (orig) =>
			function (player, item, args) {
				const r = orig.apply(this, arguments);
				try {
					live.added(S, player, item, args);
				} catch (e) {}
				return r;
			});
		// success_response(obj) | (response, obj) | (response, place, obj): the object gets response and place
		hook("success_response", (orig) =>
			function (response, place, data) {
				let d;
				try {
					d = [data, place, response].find((x) => x !== null && typeof x === "object");
				} catch (e) {}
				const r = orig.apply(this, arguments);
				try {
					if (d) live.responded(d);
				} catch (e) {}
				return r;
			});
		// a merchant's stand sale (trade_buy) or a buy order filled (trade_sell): the server records it on both sides
		// (add_to_trade_history, the seller's "sell" then the buyer's "buy"), the price before the seller's tax
		hook("add_to_trade_history", (orig) =>
			function (player, event, name, item, price) {
				const r = orig.apply(this, arguments);
				try {
					const q = live.req;
					if (q && (q.method === "trade_buy" || q.method === "trade_sell") && player && item) live.traded(player, event, name, item, price, q.method === "trade_sell" ? "wish" : "stand");
				} catch (e) {}
				return r;
			});
		hook("add_to_history", (orig) =>
			function (player, event) {
				const r = orig.apply(this, arguments);
				try {
					live.history(player, event);
				} catch (e) {}
				return r;
			});
		// exchange results (nested calls; at an exchange's end in update_instance): items via add_item, gold here
		hook("exchange", (orig) =>
			function (player) {
				let g0;
				try {
					if (live.exDepth++ === 0 && live.mx[player.name] && !inHandler()) g0 = player.gold;
				} catch (e) {}
				try {
					return orig.apply(this, arguments);
				} finally {
					live.exDepth--;
					try {
						const d = g0 === undefined ? 0 : player.gold - g0,
							f = d && live.mx[player.name].gold_flow;
						if (d > 0) f.other += d;
						else if (d < 0) f.other_out -= d;
					} catch (e) {}
				}
			});
		this.G = G;
	}
	// a trade's side (seller "sell", buyer "buy"): the items' ledgers of ours, an items' event per trade (from its sale)
	traded(player, event, other, item, price, via) {
		const q = item.q || 1,
			m = this.mx[player.name],
			om = this.mx[other];
		if (event === "sell") {
			const net = Math.round(price * (1 - (player.tax || 0))),
				tax = price - net;
			if (m) {
				const s = m.items.stand_sold[item.name] || (m.items.stand_sold[item.name] = { q: 0, gold: 0, tax: 0 });
				(s.q += q), (s.gold += net), (s.tax += tax);
			}
			if (m || om) this.itemEvent({ k: "trade", who: player.name, to: other, item: item.name, ...(item.level ? { level: item.level } : {}), ...(item.stat_type ? { stat_type: item.stat_type } : {}), q, price, tax, via });
		} else if (event === "buy" && m) {
			const b = m.items.stand_bought[item.name] || (m.items.stand_bought[item.name] = { q: 0, gold: 0 });
			(b.q += q), (b.gold += price);
		}
	}
	push(a, info) {
		if (!this.base || !a) return false;
		const c = this.stack[this.depth] || (this.stack[this.depth] = {});
		c.a = a;
		c.skill = (info && info.atype) || "?";
		c.heal = !!(info && info.heal);
		c.refl = !!(info && info.reflected_from);
		c.key = c.refl ? "reflect" : c.skill; // a reflection's damage counts for the reflector as "reflect"
		c.ls = (info && info.lifesteal) || 0;
		c.ms = (info && info.manasteal) || 0;
		c.ahp = a.hp;
		c.amp = a.mp;
		c.n = 0;
		// a gold-stealing monster: our characters' gold before (def.goldsteal stays on the shared def across targets)
		const md = a.is_monster && this.G.monsters[a.type];
		c.gs = md && md.goldsteal ? new Map(this.ours.map(([p]) => [p, p.gold || 0])) : null;
		this.depth++;
		return true;
	}
	/** One "hit": misses, heals, damage dealt/taken, lifesteal, dreturn, mshield, goldsteal. */
	hit(S, e, d) {
		const mx = this.mx,
			pw = this.pw, pwNet = this.pwNet, ph = this.ph, phAmt = this.phAmt;
		this.pw = this.ph = this.pburn = null;
		if (!this.base || !e || !d) return;
		const now = this.sim.clock.now;
		if (!this.depth) {
			if (d.source === "burn") this.burn(e, d, now);
			return;
		}
		const c = this.stack[this.depth - 1],
			a = c.a,
			am = a.is_player ? mx[a.name] : undefined,
			tm = e.is_player ? mx[e.name] : undefined;
		if (c.gs && tm) this.goldsteal(S, c, e, tm);
		if (d.miss || d.evade || d.avoid) {
			if (am) {
				if (c.heal) {
					const h = entry(am.heal.by_skill, c.key);
					h.misses = (h.misses || 0) + 1;
				} else skillEntry(am.dmg.by_skill, c.key).misses++;
				am.lastc = now;
			}
			if (tm && !c.heal) (tm.dmg.avoided[d.miss ? "miss" : d.evade ? "evade" : "avoid"]++, (tm.lastc = now));
			return;
		}
		if (d.reflect !== undefined && d.source === undefined) return; // a reflection's notice (damage 0)
		if (am) am.lastc = now;
		if (tm) tm.lastc = now;
		const first = c.n++ === 0;
		if (d.heal !== undefined) {
			if (!e.is_player) return;
			const raw = d.heal || 0,
				net = ph === e ? phAmt : 0;
			if (am) {
				both(am.heal.done, am.heal.by_skill, c.key, raw, net);
				const t = entry(am.heal.by_target, e.name);
				(t.raw += raw), (t.net += net), t.hits++;
				this.onAdd(am, "heal", net);
			}
			if (tm) both(tm.heal.received, tm.heal.received_by, a.is_monster ? a.type : a.name, raw, net);
			return;
		}
		const raw = d.damage || 0;
		if (am && e.is_monster) {
			am.dmg.done.raw += raw;
			const s = skillEntry(am.dmg.by_skill, c.key),
				t = entry(am.dmg.by_target, e.type);
			(s.raw += raw), s.hits++, (t.raw += raw), t.hits++;
			if (first && d.crit) s.crits++;
			// the attacker's hp moved by lifesteal, then dreturn (first target only), before this emit: ls = the server's
			// formula (the target's hp before = its hp now + the damage), both nets from the hp before and after
			const dr = first && d.dreturn;
			if (c.ls || dr) {
				const ls = c.ls ? Math.ceil((Math.min(raw, e.hp + raw) * c.ls) / 100) : 0,
					hp1 = Math.min(a.max_hp, c.ahp + Math.max(0, ls));
				if (ls > 0) {
					both(am.heal.done, am.heal.by_skill, "lifesteal", ls, hp1 - c.ahp);
					both(am.heal.received, am.heal.received_by, "lifesteal", ls, hp1 - c.ahp);
					const b = entry(am.heal.by_target, a.name);
					(b.raw += ls), (b.net += hp1 - c.ahp), b.hits++;
					this.onAdd(am, "heal", hp1 - c.ahp);
				}
				if (dr) {
					both(am.dmg.taken, am.dmg.taken_by, "dreturn", dr, Math.max(0, hp1 - a.hp));
					this.onAdd(am, "taken", Math.max(0, hp1 - a.hp));
				}
				c.ahp = a.hp;
			}
			if (c.ms) {
				if (a.mp > c.amp) am.mana.gained.steal += a.mp - c.amp;
				c.amp = a.mp;
			}
		} else if (tm && !am) {
			// net: encouragement_wound() just before this emit (monsters; none = nothing lost), else from the hp now
			const net = pw === e ? pwNet : a.is_monster ? 0 : raw + Math.min(0, e.hp);
			both(tm.dmg.taken, tm.dmg.taken_by, c.refl ? "reflect" : a.is_monster ? a.type : a.name || "?", raw, net);
			this.onAdd(tm, "taken", net);
			if (d.mp_damage) tm.dmg.taken_mp += d.mp_damage;
			if (d.mp_restored) tm.mana.gained.other += d.mp_restored;
			// the target's dreturn back at the monster (first target only): net = the monster's hp lost
			if (first && d.dreturn && a.is_monster) {
				const dn = Math.max(0, Math.min(d.dreturn, c.ahp - a.hp)),
					s = skillEntry(tm.dmg.by_skill, "dreturn"),
					t = entry(tm.dmg.by_target, a.type);
				c.ahp = a.hp;
				(tm.dmg.done.raw += d.dreturn), (tm.dmg.done.net += dn);
				(s.raw += d.dreturn), (s.net += dn), s.hits++, (t.raw += d.dreturn), (t.net += dn), t.hits++;
				this.onAdd(tm, "dmg", dn);
			}
		}
		if (d.guardian && d.redirected) {
			const gm = mx[d.guardian];
			if (gm) {
				both(gm.dmg.taken, gm.dmg.taken_by, "guardians_oath", d.redirected, d.redirected);
				this.onAdd(gm, "taken", d.redirected);
				if (d.guardian_mp) gm.mana.gained.other += d.guardian_mp;
			}
		}
	}
	goldsteal(S, c, e, m) {
		const g0 = c.gs.get(e),
			g = e.gold || 0;
		if (g0 == null || g0 === g) return;
		c.gs.set(e, g);
		if (S.current_socket !== S.false_socket) return; // a request's bracket has it
		if (g > g0) m.gold_flow.other += g - g0;
		else m.gold_flow.other_out += g0 - g;
	}
	burn(e, d, now) {
		const raw = d.damage || 0;
		if (e.is_monster) {
			const m = this.mx[d.hid]; // the burner's name
			if (!m) return;
			m.lastc = now;
			m.dmg.done.raw += raw;
			const s = skillEntry(m.dmg.by_skill, "burn"),
				t = entry(m.dmg.by_target, e.type);
			(s.raw += raw), s.hits++, (t.raw += raw), t.hits++;
			if (d.kill) this.pburn = { e, name: d.hid, m, s, t }; // net: add_coop_points' contribution, next
			else (m.dmg.done.net += raw), (s.net += raw), (t.net += raw), this.onAdd(m, "dmg", raw);
		} else if (e.is_player) {
			const m = this.mx[e.name];
			if (!m) return;
			m.lastc = now;
			const net = this.dtE === e ? this.dtHp - Math.max(0, e.hp) : raw;
			both(m.dmg.taken, m.dmg.taken_by, "burn", raw, net);
			this.onAdd(m, "taken", net);
		}
		this.dtE = null;
	}
	dealt(player, monster, net) {
		const c = this.depth ? this.stack[this.depth - 1] : null,
			m = player && this.mx[player.name];
		if (!c || c.heal || !m || !monster || !(net > 0)) return;
		m.dmg.done.net += net;
		skillEntry(m.dmg.by_skill, c.key).net += net;
		entry(m.dmg.by_target, monster.type).net += net;
		this.onAdd(m, "dmg", net);
	}
	/** An outcome of m's character into `on`, for each whitelisted condition it has right now. */
	onAdd(m, col, q) {
		const p = m && m.p;
		if (!q || !p) return;
		const s = p.s;
		if (s) for (const k of ON_S) if (s[k]) (m.on[k] ||= onRow())[col] += q;
		if (p.party) (m.on.party ||= onRow())[col] += q;
		if (p.fear > 0) (m.on.fear ||= onRow())[col] += q;
	}
	mana(player, mp0) {
		const m = player && this.mx[player.name];
		if (!m || typeof mp0 !== "number") return;
		const d = mp0 - player.mp,
			r = this.req;
		if (d > 0) {
			m.mana.spent += d;
			inc(m.mana.by_skill, r && r.p === player ? (r.method === "skill" ? (r.data && r.data.name) || "skill" : r.method) : "other", d);
		} else if (d < 0) m.mana.gained.other -= d; // restore_mp proc
	}
	awardPre(monster) {
		if (!this.base || !monster) return null;
		const out = [],
			type = monster.type;
		for (const [p] of this.ours) out.push(p.level, p.xp, (p.p && p.p.stats && p.p.stats.monsters && p.p.stats.monsters[type]) || 0);
		return out;
	}
	awardPost(pre, monster) {
		const type = monster.type;
		let i = 0;
		for (const [p, m] of this.ours) {
			const l = pre[i++], x = pre[i++], c = pre[i++];
			const d = this.xpSince(p, l, x);
			if (d && m) {
				m.xp_award += d;
				if (p.party) m.party_xp += d;
				this.onAdd(m, "xp", d);
			}
			const c1 = (p.p && p.p.stats && p.p.stats.monsters && p.p.stats.monsters[type]) || 0;
			if (c1 > c && m) (m.credits += c1 - c), this.onAdd(m, "credits", c1 - c);
		}
	}
	/** A kill's chest (drop_something, before its encouragement receipts): the recipient's `on` kills and items; x10/x50. */
	dropped(S, p, mon, ch, share) {
		const m = this.base && p && this.mx[p.name];
		if (!m || !ch || !mon) return;
		this.onAdd(m, "rkills", 1);
		this.onAdd(m, "items", (ch.items && ch.items.length) || 0);
		if (p.s && p.s.citizen0aura) m.exact.kane_kills++;
		// the gold roll: drop_something's smallest base gold times 10, 50 or 500 (the ranges don't overlap); a new
		// character's first drop carries 100000 more before that
		const fd = !!(p.p && p.p.first_drop),
			first = fd && !m.fd ? 100000 : 0,
			D = S.D,
			gold = S.B && S.B.use_pack_golds && mon.gold ? mon.gold : D.monster_gold[mon.type],
			min = Math.round(1 + gold * D.drops.gold.base * share) * mon.level * mon.mult;
		m.fd = fd;
		const x = min > 0 ? [500, 50, 10].find((k) => (ch.gold || 0) / k - first >= min * (1 - 1e-9)) : 0;
		if (x) this.chestX.set(ch, x);
	}
	open(S, player, method, data) {
		if (method === "disconnect") return; // the server's own on socket close: no packet closes it
		this.reqData = data;
		const m = player && this.mx[player.name];
		if (!m) return;
		const r = (this.req = { p: player, m, method, data, hp: player.hp, mp: player.mp, ours: this.ours, g: this.ours.map(([q]) => q.gold || 0), pot: null, used: null, chest: null, qu: player.q && player.q.upgrade, qc: player.q && player.q.compound });
		// an upgrade's or a compound's grace before its roll (the handler moves it): the item's (the three items' summed),
		// the character's and the server's per level, the offering grace
		try {
			if (method === "upgrade" && data) {
				const it = player.items[data.item_num],
					lv = ((it && it.level) || 0) + 1;
				if (it) r.grace0 = { grace: it.grace || 0, ug: [(player.p.ugrace || [])[lv] ?? null, ((S.S && S.S.ugrace) || [])[lv] ?? null], og: player.p.ograce || 0 };
			} else if (method === "compound" && data && Array.isArray(data.items))
				r.grace0 = { grace: data.items.reduce((a, n) => a + ((player.items[n] && player.items[n].grace) || 0), 0), og: player.p.ograce || 0 };
		} catch (e) {}
		if (method === "open_chest") {
			const ch = S.chests[data && data.id];
			if (!ch) return void (r.chest = false);
			// the opener's goldm goes to 1 for everyone beyond 400 px (dry), after 8 minutes (stale) and for a reserved chest
			const dry = S.simple_distance(ch, player) > 400,
				stale = S.msince(ch.date) > 8;
			r.chest = { id: data.id, obj: ch, dry, stale, forced: dry || stale || !!ch.character };
			// Angel's aura on the opener: its share of the opener's goldm
			const au = player.s && player.s.citizen4aura;
			if (au && au.gold) (r.aura = (au.gold / 100) * (player.tskin === "konami" ? 0.25 : 1)), (r.gm = player.goldm);
		}
	}
	lootPre(S, chest, goldm) {
		const r = this.req;
		if (!r || !r.chest || !chest) return null;
		const list = [];
		for (const rc of chest.encouragement || []) {
			const q = S.players[S.name_to_id[rc.name]];
			if (q) list.push([rc, q, q.gold]);
		}
		return { r, list, eg: chest.encouragement_gold || 0, egold: chest.egold || 0, goldm, angel: !!r.aura && !r.chest.forced };
	}
	// each paid receipt (the chest's encouragement gold for a character: what it got during the call); with Angel's
	// aura on the opener, the server's formula at goldm and at goldm without Angel (paid = the formula, else unmatched)
	lootPost({ r, list, eg, egold, goldm, angel }) {
		for (const [rc, q, g0] of list) {
			const paid = q.gold - g0;
			if (!paid) continue; // not paid now (gone, or kept in a reserved chest)
			(r.enc ||= new Map()).set(q, (r.enc.get(q) || 0) + paid);
			if (!angel) continue;
			const g = tax(Math.floor((eg * goldm + egold) * rc.gold));
			if (g !== paid) {
				r.bad = true;
				continue;
			}
			r.extra = (r.extra || 0) + g - tax(Math.floor((eg * (goldm - r.aura) + egold) * rc.gold));
		}
	}
	// a chest's gold for one of ours (d, after tax): its encouragement receipts (measured), the rest the chest's payout,
	// tax(round(gold x share x goldm) + round(egold x share)): split between the chest's gold and the monster's egold by
	// their shares before tax (the parts sum to d)
	chestGold(r, q, d, f) {
		const enc = Math.min(d, (r.enc && r.enc.get(q)) || 0),
			rest = d - enc,
			obj = r.chest && r.chest.obj,
			p = r.p,
			sh = p.party ? q.share || 0 : 1,
			E = obj ? Math.round((obj.egold || 0) * sh) : 0;
		let T = Math.round(rest / 0.9);
		for (const t of [T, T - 1, T + 1]) if (tax(t) === rest) T = t;
		const eg = T > 0 ? Math.min(rest, Math.round((rest * Math.min(E, T)) / T)) : 0;
		(f.enc += enc), (f.egold += eg), (f.chest += rest - eg);
	}
	/** After a request's handler: gold of every character by method, potions/regen, chest opens, upgrade rolls. */
	closeReq() {
		const r = this.req,
			S = this.sim.server;
		this.req = null;
		const p = r.p,
			m = r.m;
		for (let i = 0; i < r.ours.length; i++) {
			const [q, qm] = r.ours[i],
				d = (q.gold || 0) - r.g[i];
			if (!d || !qm) continue;
			const f = qm.gold_flow;
			switch (r.method) {
				case "open_chest": d > 0 ? this.chestGold(r, q, d, f) : (f.other_out -= d); break;
				case "sell": d > 0 ? (f.sold += d) : (f.other_out -= d); break;
				case "buy": case "sbuy": d < 0 ? (f.bought -= d) : (f.other += d); break;
				case "send": d < 0 ? (f.sent -= d) : (f.received += d); break;
				case "trade_buy": case "trade_sell": d > 0 ? (f.stand += d) : (f.traded -= d); break;
				case "craft": case "dismantle": d < 0 ? (f.craft -= d) : (f.other += d); break;
				case "bank":
					// a bank pack bought with gold is spent; deposits (+) and withdrawals (-) are banked
					if (r.data && r.data.operation === "unlock") d < 0 ? (f.bought -= d) : (f.other += d);
					else f.banked -= d;
					break;
				default: d > 0 ? (f.other += d) : (f.other_out -= d);
			}
		}
		if (r.pot) {
			if (r.pot.hp) both(m.heal.received, m.heal.received_by, r.pot.name, r.pot.hp, p.hp - r.hp);
			if (r.pot.mp && p.mp > r.mp) m.mana.gained.pots += p.mp - r.mp;
		}
		if (r.used === "hp") both(m.heal.received, m.heal.received_by, "regen_hp", (this.G.skills.regen_hp && this.G.skills.regen_hp.output) || 0, p.hp - r.hp);
		else if (r.used === "mp" && p.mp > r.mp) m.mana.gained.regen += p.mp - r.mp;
		// upgrade/compound: rolled at request time (the item comes back or not when the queue ends); grace offerings aren't rolls
		if (r.method === "upgrade" && p.q && p.q.upgrade && p.q.upgrade !== r.qu && p.p && p.p.u_type !== "offering") {
			const it = p.p.u_item || p.p.u_itemx,
				ph = p.items && p.items[p.q.upgrade.num];
			// an ingot or a nugget with no scroll: a roll to make the item shiny, its level unchanged (not an upgrade)
			// the roll: its scroll and offering, the chance it had (grace in) and the roll (a success: roll <= chance)
			const roll = ph && ph.name === "placeholder" && ph.p ? { scroll: ph.p.scroll, ...(ph.p.offering ? { offering: ph.p.offering } : {}), chance: r4(ph.p.chance), roll: r4(p.p.u_roll), ...(r.grace0 || {}) } : {};
			if (it && ph && ph.name === "placeholder" && ph.p && ph.p.scroll === null && ph.p.offering)
				this.itemEvent({ k: "shiny", who: p.name, item: it.name, level: it.level || 0, offering: ph.p.offering, ok: !p.p.u_fail, chance: roll.chance, roll: roll.roll });
			else if (it) {
				const u = m.items.upgraded[it.name] || (m.items.upgraded[it.name] = { ok: 0, fail: 0, lost: 0 }), ok = !!p.p.u_item && !p.p.u_fail, lv = it.level || 0;
				ok ? u.ok++ : u.fail++;
				if (!p.p.u_item) u.lost++;
				// (a success holds the new level, a failure the one it had)
				const from = Number.isFinite(p.p.u_level) ? p.p.u_level : ok ? lv - 1 : lv;
				if (p.p.u_type === "stat") this.itemEvent({ k: "stat", who: p.name, item: it.name, stat: it.stat_type || null, ok, ...(roll.scroll ? { scroll: roll.scroll } : {}) });
				else this.itemEvent({ k: "upgrade", who: p.name, item: it.name, from, to: from + 1, ok, ...(p.p.u_item ? {} : { lost: true }), ...roll });
			}
		}
		if (r.method === "compound" && p.q && p.q.compound && p.q.compound !== r.qc && p.p) {
			const it = p.p.c_item || p.p.c_itemx,
				ph = p.items && p.items[p.q.compound.num],
				roll = ph && ph.name === "placeholder" && ph.p ? { scroll: ph.p.scroll, ...(ph.p.offering ? { offering: ph.p.offering } : {}), chance: r4(ph.p.chance), roll: r4(p.p.c_roll), ...(r.grace0 || {}) } : {};
			if (it) {
				const u = m.items.compounded[it.name] || (m.items.compounded[it.name] = { ok: 0, fail: 0 }), ok = !!p.p.c_item, lv = it.level || 0;
				ok ? u.ok++ : u.fail++;
				this.itemEvent({ k: "compound", who: p.name, item: it.name, from: ok ? lv - 1 : lv, to: ok ? lv : lv + 1, ok, ...roll });
			}
		}
		if (r.chest) {
			if (!S.chests[r.chest.id]) {
				(m.chests.opened++, r.chest.dry && m.chests.dry++, r.chest.stale && m.chests.stale++);
				this.opened(S, r, p, m);
			}
		} else if (r.chest === false) m.chests.gone++;
	}
	// A chest p opened: `on` by the opener's conditions (gold paid to everyone, x10/x50). With Angel's aura on the opener
	// and its goldm paid: her extra gold = what everyone got - the same formula without her (the paid gold must match it).
	opened(S, r, p, m) {
		const ch = r.chest,
			x = this.chestX.get(ch.obj) || 1;
		let gold = 0;
		for (let i = 0; i < r.ours.length; i++) gold += Math.max(0, (r.ours[i][0].gold || 0) - r.g[i]);
		this.onAdd(m, "chests", 1);
		this.onAdd(m, "loot_gold", gold);
		if (x === 10 || x === 500) this.onAdd(m, "x10", 1);
		if (x >= 50) this.onAdd(m, "x50", 1);
		if (!r.aura || ch.forced) return;
		const obj = ch.obj,
			gm = r.gm,
			party = p.party && S.parties[p.party];
		let extra = r.extra || 0,
			bad = !!r.bad;
		for (let i = 0; i < r.ours.length; i++) {
			const q = r.ours[i][0];
			if (party ? !party.includes(q.name) : q !== p) continue;
			const sh = party ? q.share || 0 : 1,
				eg = Math.round((obj.egold || 0) * sh),
				got = tax(Math.round(obj.gold * sh * gm) + eg);
			if (got !== (q.gold || 0) - r.g[i] - ((r.enc && r.enc.get(q)) || 0)) bad = true;
			else extra += got - tax(Math.round(obj.gold * sh * (gm - r.aura)) + eg);
		}
		if (bad) return void m.exact.angel_unmatched++;
		m.exact.angel_gold += extra;
		m.exact.angel_chests++;
	}
	consumed(S, player, name, q) {
		const def = this.G.items[name],
			why = S.current_socket !== S.false_socket ? S.ls_method : null,
			data = this.reqData;
		// listing on the stand, NPC sales (counted from the response) and splits aren't used up
		if (why === "sell" || why === "split" || (why === "equip" && data && typeof data.slot === "string" && /^trade/.test(data.slot) && !data.consume)) return;
		const drink = why === "equip" && def && def.gives;
		if (drink) inc(this.stat(player.name).pots, name, q);
		const m = this.mx[player.name];
		if (!m) return;
		inc(why === "exchange" || why === "exchange_buy" ? m.items.exchanged : m.items.consumed, name, q);
		if (drink && /^hpot/.test(name)) this.onAdd(m, "hpots", q);
		const r = this.req;
		if (drink && r && r.p === player) {
			// the potion's effect comes right after (poisoned: half)
			let hp = 0, mp = 0;
			for (const [k, v] of def.gives) {
				const a = player.s && player.s.poisoned ? Math.round(v / 2) : v;
				if (k === "hp") hp += a;
				else if (k === "mp") mp += a;
			}
			r.pot = { name, hp, mp };
		}
	}
	added(S, player, it, args) {
		const m = player && player.socket && this.mx[player.name]; // (not a detached copy, as market_patron_runtime's dry run)
		if (!m) return;
		const name = typeof it === "string" ? it : it && it.name;
		if (!name || name === "placeholder") return;
		const q = typeof it === "string" ? (args && args.q) || 1 : it.q || 1,
			why = S.current_socket !== S.false_socket ? S.ls_method : null;
		if (args && args.found) inc(m.items.looted, name, q), (m.loot_items += q), this.itemEvent({ k: "loot", who: player.name, item: name, ...(typeof it === "object" && it.level ? { level: it.level } : {}), q });
		else if (args && args.m && !args.r) inc(m.items.mluck_dupes, name, q); // the merchant's 2% copy of a find
		else if (this.exDepth || why === "exchange_buy") inc(m.items.from_exchange, name, q);
		else if (!MOVED.has(why)) inc(m.items.other, name, q); // e.g. the merchant's market parcels, dismantles
	}
	responded(d) {
		const r = this.req;
		if (!r) return;
		const m = r.m;
		if (d.response === "buy_success" && d.name) {
			const b = m.items.bought[d.name] || (m.items.bought[d.name] = { q: 0, gold: 0 });
			(b.q += d.q || 1), (b.gold += d.cost || 0);
		} else if (d.response === "gold_received" && d.place === "sell" && d.item) {
			const s = m.items.sold[d.item.name] || (m.items.sold[d.item.name] = { q: 0, gold: 0 });
			(s.q += d.item.q || 1), (s.gold += d.gold || 0);
		} else if (d.response === "craft" && d.name) inc(m.items.crafted, d.name, 1);
		else if (d.place === "use" && d.used) r.used = d.used;
	}
	history(player, ev) {
		const m = player && this.mx[player.name];
		if (!m || !ev) return;
		const other = ev.to || ev.from;
		if (ev.name === "item" && other) nest(ev.to ? m.items.sent : m.items.received, ev.item, other, ev.q || 1);
		// a handover, once (the giver's side): its item's level
		if (ev.to && ev.name === "item") this.itemEvent({ k: "give", who: player.name, to: ev.to, item: ev.item, level: ev.level || 0, q: ev.q || 1 });
		else if (ev.to && ev.name === "gold") this.itemEvent({ k: "gold", who: player.name, to: ev.to, amount: ev.amount || 0 });
		// the merchant's ledger per fighter, and the open trip's
		if (player.type !== "merchant" || !other) return;
		const trip = this.stat(player.name).trip,
			pf = this.merchant.per_fighter[other] || (this.merchant.per_fighter[other] = ledger());
		for (const l of trip ? [pf, trip.served[other] || (trip.served[other] = { sent: {}, received: {}, gold_sent: 0, gold_received: 0 })] : [pf]) {
			if (ev.name === "item") inc(ev.to ? l.sent : l.received, ev.item, ev.q || 1);
			else if (ev.name === "gold") ev.to ? (l.gold_sent += ev.amount || 0) : (l.gold_received += ev.amount || 0);
		}
	}
	/**
	 * From the lockstep window loop (`real`: its performance.now()): trips every PROBE_MS game ms, samples every SAMPLE_MS,
	 * a grid row when the clock passes a GRID_MS boundary, the dashboard's requests and a snapshot at most once per `every`
	 * real ms.
	 */
	tick(real) {
		const v = this.sim.clock.now,
			now = real ?? performance.now();
		if (v - (this.probed || 0) >= PROBE_MS)
			try {
				this.probed = v;
				this.probe();
				// the base, and its snapshot (the history's row at t 0)
				if (!this.base && this.tryBase(now)) (this.last = now), this.write(false);
			} catch (e) {}
		if (this.base && v - this.sv >= SAMPLE_MS)
			try {
				this.sample(v);
			} catch (e) {}
		if (this.grid && v >= this.grid.next)
			try {
				this.sample(v);
				this.gridRow(Math.floor(v / this.gridMs) * this.gridMs);
			} catch (e) {}
		if (now - this.last < this.every) return;
		this.last = now;
		try {
			this.poll();
		} catch (e) {}
		try {
			this.write(false);
		} catch (e) {
			// a dashboard must never break a run
		}
	}
	// <id>.ctl ({ seq, stop?, speed?, at }, written by the dashboard): a stop halts the run (the sim ends it at its next
	// chunk and closes with end "stopped"); a sim has no speed to set, so that is only acknowledged
	poll() {
		const c = fs.existsSync(this.ctl) ? JSON.parse(fs.readFileSync(this.ctl, "utf8")) : null;
		if (!c || !(c.seq > this.ack)) return;
		if (c.stop) {
			if (typeof this.sim.halt !== "function") return;
			this.sim.halt("dashboard");
		}
		// an export of the run's state now: the run's loop takes it at its next chunk (page reads are async)
		if (c.export && !this.exportWanted) this.exportWanted = { label: String(c.export), seq: c.seq };
		this.ack = c.seq;
	}
	// a state export written (sim/export.js): listed in the snapshot (state.exports)
	exported(label, at, dir) {
		this.exports.push({ label, at, t: this.base ? Math.round((this.sim.clock.now - this.base.at) / 1000) : null, dir: path.relative(this.dir, dir) });
		this.exportWanted = null;
	}
	probe() {
		const S = this.sim.server,
			v = this.sim.clock.now,
			list = this.list,
			fighters = this.fighters;
		list.length = fighters.length = 0;
		for (const id in S.players) {
			const p = S.players[id];
			if (p && !p.npc) (list.push(p), p.type !== "merchant" && fighters.push(p));
		}
		for (const p of list) {
			const s = this.stat(p.name),
				r2 = p.x * p.x + p.y * p.y;
			const town = /^bank/.test(p.map) || (p.map === "main" && r2 < (s.town ? TOWN_OUT : TOWN_IN) ** 2);
			// time per map and out of town: since the base (the warm-up doesn't count)
			if (s.at != null && this.base) {
				const dt = v - Math.max(s.at, this.base.at);
				if (dt > 0) (s.maps[p.map] = (s.maps[p.map] || 0) + dt), s.town || (s.out_ms += dt);
			}
			if (p.type === "merchant") {
				// a trip: out of town, within reach of a fighter somewhere, back in town; met = the fighters it reached
				if (s.town === true && !town) (s.outings++, (s.open = true), (s.near = false), (s.trip = this.base ? { t_out: v, met: new Set(), close: new Set(), served: {} } : null));
				if (!town && s.open)
					for (const f of fighters) {
						const close = f.map === p.map && (f.x - p.x) ** 2 + (f.y - p.y) ** 2 < DELIVERY_R ** 2;
						if (close) s.near = true;
						if (!s.trip) continue;
						if (close && !s.trip.close.has(f.name)) (s.trip.close.add(f.name), s.trip.met.add(f.name), (this.merchant.per_fighter[f.name] ||= ledger()).meetings++);
						else if (!close) s.trip.close.delete(f.name);
					}
				if (s.town === false && town && s.open) {
					if (s.near) {
						s.trips++;
						if (s.trip && s.trip.met.size) this.tripDone(s.trip, v);
					}
					(s.open = false), (s.trip = null);
				}
			} else if (s.town === false && town && v - s.lastDeath > RESPAWN_MS) s.visits++; // not respawns
			s.town = town;
			s.at = v;
		}
		if (!this.base) return;
		const tms = v - this.base.at,
			here = new Set();
		for (const p of list) {
			here.add(p.name);
			if (!this.inGame.has(p.name)) this.joined(p, tms);
		}
		for (const n of this.inGame) if (!here.has(n)) this.left(n, tms);
		this.inGame = here;
		// [player, metrics] of every character in game: a new array when that changes (a request keeps the old one)
		const o = this.ours;
		let same = o.length === list.length;
		for (let i = 0; same && i < list.length; i++) same = o[i][0] === list[i];
		if (!same)
			this.ours = list.map((p) => {
				const m = this.mx[p.name] || (this.mx[p.name] = metrics(p, this.census(p)));
				m.p = p;
				return [p, m];
			});
		// what the CODE reports: the single-thread Sim reads it here (the client threads post theirs), through guarded();
		// status and role at most once per STATUS_MS game ms; an impure getter is not called again (its last value stands)
		if (this.coarse)
			for (const c of this.sim.clients) {
				const st = c.state,
					runner = st && st.runner,
					r = this.reportOf(c.name),
					x = (this.modeTotals[c.name] ||= { at: v, cur: null, totals: {} });
				const read = (k, fn) => {
					if (r.impure && r.impure[k]) return undefined;
					const g = guarded([st.game, runner], this.sim.clock, this.sim.hub, fn);
					if (g.impure && g.impure !== "threw") (r.impure ||= {})[k] = g.impure;
					return g.value;
				};
				// its game log's new lines (its console goes to the run's stderr here: not counted)
				const tap = this.taps.get(c) || (this.taps.set(c, logTap()), this.taps.get(c)),
					got = st && st.game ? tap(st.game) : [];
				if (got.length) this.logged(c.name, { n: got.length, err: got.filter(([kd]) => kd === "pageerror").length, con: 0, lines: got.slice(-LOG_KEEP).map(([kd, t]) => [v, kd, t]) });
				const m = runner ? read("mode", () => readMode(runner)) : null,
					k = m ? m.v : null;
				if (m && m.from) r.from = m.from;
				if (x.cur != null) inc(x.totals, x.cur, v - x.at);
				(x.at = v), (x.cur = k);
				if (runner && !(v - r.at < STATUS_MS)) {
					r.at = v;
					const s = read("status", () => readStatus(runner)),
						ro = read("role", () => readRole(runner));
					if (s !== undefined) r.status = s ? s.v : null;
					if (ro !== undefined) r.role = ro ? ro.v : null;
				}
			}
	}
	// a finished trip that met fighters: listed; per fighter met, handed something (deliveries), took something (pickups)
	// a character in game that wasn't at the last probe (tms: game ms from the base): logged in after the base, or again
	joined(p, tms) {
		(this.sessions[p.name] ||= []).push([Math.round(tms / 1000), null]);
		this.gone.delete(p.name);
		const s = this.stat(p.name),
			m = this.mx[p.name];
		if (!s.start) s.start = this.counters(p, s); // first in game after the base: counted from its login
		this.modes0[p.name] ||= {}; // (its CODE modes too)
		const x = this.modeTotals[p.name];
		if (x && this.leftV[p.name] != null) {
			// again: the last session's modes are kept, the new thread's count from 0
			const past = (this.modesPast[p.name] ||= {});
			for (const [k, ms] of Object.entries(modesUpTo(x, this.leftV[p.name]))) past[k] = (past[k] || 0) + ms;
			delete this.modeTotals[p.name];
		}
		delete this.leftV[p.name];
		this.gear0[p.name] ||= gearHash(p.slots);
		if (p.type !== "merchant") this.merchant.per_fighter[p.name] ||= ledger();
		if (m && m.p && m.p !== p) {
			// a new session: the server's own counters of the character (p.t) start again
			const was = m.p.t || {},
				now = p.t || {},
				past = (m.tPast ||= { mdamage: 0, cgold: 0, xp: 0 });
			for (const k of ["mdamage", "cgold", "xp"]) (past[k] += (was[k] || 0) - m.t0[k]), (m.t0[k] = now[k] || 0);
		}
	}
	// a character gone since the last probe: its session ends, its conditions close; its row stays (as it left)
	left(name, tms) {
		const ss = this.sessions[name],
			last = ss && ss[ss.length - 1];
		if (last && last[1] == null) last[1] = Math.round(tms / 1000);
		this.leftV[name] = this.base.at + tms;
		const m = this.mx[name];
		if (!m || !m.p) return;
		this.gone.set(name, m.p);
		m.st = null; // (the time away isn't sampled)
		for (const k in m.cond) {
			const c = m.cond[k];
			if (!c.on) continue;
			(c.on = false), (c.off = tms), (c.max_ms = Math.max(c.max_ms, tms - c.t0));
			tlClose(m.tl, k, tms);
		}
	}
	tripDone(trip, v) {
		const t = (x) => Math.max(0, Math.round((x - this.base.at) / 1000)),
			pf = this.merchant.per_fighter;
		for (const n of trip.met) (pf[n] ||= ledger()).trips++;
		for (const [n, x] of Object.entries(trip.served)) {
			const l = (pf[n] ||= ledger());
			if (x.gold_sent || Object.keys(x.sent).length) l.deliveries++;
			if (x.gold_received || Object.keys(x.received).length) l.pickups++;
		}
		this.merchant.trips.push({ t_out: t(trip.t_out), t_back: t(v), met: [...trip.met], served: trip.served });
		if (this.merchant.trips.length > TRIPS) this.merchant.trips.shift();
	}
	/**
	 * Every SAMPLE_MS game ms from the base (and before a grid row, at the end): the time since the last sample goes to
	 * what was true at it (alive, in combat, in a party, multipliers, conditions); then what is true now.
	 */
	sample(v) {
		const dt = this.sv == null ? 0 : v - this.sv,
			t = v - this.base.at,
			fighters = this.sf;
		this.sv = v;
		fighters.length = 0;
		if (this.party.on) this.party.ms += dt;
		for (const [p, m] of this.ours) {
			if (!m) continue;
			const st = m.st,
				mu = m.mult;
			if (st) {
				m.sampled += dt;
				if (st.alive) m.alive_ms += dt;
				if (st.combat) m.combat_ms += dt;
				if (st.party) m.party_ms += dt;
				(mu.xpm += st.xpm * dt), (mu.goldm += st.goldm * dt), (mu.luckm += st.luckm * dt), (mu.enc_xp += st.ex * dt), (mu.enc_gold += st.eg * dt), (mu.enc_luck += st.el * dt);
				for (const k in m.cond) if (m.cond[k].on) m.cond[k].ms += dt;
			}
			const e = p.encouragement && p.encouragement.totals,
				s = m.st || (m.st = {});
			s.alive = !p.rip;
			s.combat = !p.rip && v - m.lastc <= COMBAT_MS;
			s.party = !!p.party;
			(s.xpm = p.xpm || 0), (s.goldm = p.goldm || 0), (s.luckm = p.luckm || 0);
			(s.ex = e ? e.xp : 1), (s.eg = e ? e.gold : 1), (s.el = e ? e.luck : 1);
			this.conditions(p, m, t);
			if (p.type !== "merchant") fighters.push(p);
		}
		// the party: every fighter of the run in one server party
		const leader = fighters.length > 1 && fighters[0].party;
		this.party.on = !!leader && fighters.every((f) => f.party === leader);
		if (this.party.on && this.party.formed == null) this.party.formed = t;
		for (const [p] of this.ours) if (p.type === "merchant" && p.party && fighters.some((f) => f.party === p.party)) this.party.merchant_in = true;
	}
	// a character's conditions now: every p.s key, plus elixir, party, fear and booster; gone ones close
	conditions(p, m, t) {
		const gen = ++m.gen,
			s = p.s;
		if (s) for (const k in s) this.cond(m, k, t, gen, condValue(k, s[k]));
		const el = p.slots && p.slots.elixir;
		if (el) this.cond(m, "elixir", t, gen, el.name);
		if (p.party) this.cond(m, "party", t, gen, `xp${p.party_xp || 0} luck${p.party_luck || 0} gold${p.party_gold || 0}`);
		if (p.fear > 0) this.cond(m, "fear", t, gen, p.fear);
		if (p.stones)
			for (const it of p.items || [])
				if (it && it.expires && this.G.items[it.name] && this.G.items[it.name].gain) {
					this.cond(m, "booster", t, gen, it.name);
					break;
				}
		for (const k in m.cond) {
			const c = m.cond[k];
			if (c.on && c.gen !== gen) {
				c.on = false;
				c.off = t;
				c.max_ms = Math.max(c.max_ms, t - c.t0);
				tlClose(m.tl, k, t);
			}
		}
	}
	cond(m, k, t, gen, v) {
		const c = m.cond[k] || (m.cond[k] = { ms: 0, n: 0, max_ms: 0, v: undefined, cur: undefined, on: false, t0: 0, off: -Infinity, gen: 0, kind: kindOf(k, this.G) });
		c.gen = gen;
		if (!c.on) {
			c.on = true;
			if (t - c.off > GAP_MS) (c.n++, (c.t0 = t)); // else the same interval goes on
			tlOpen(m.tl, k, t, v);
			if (ON_KEYS.has(k)) m.on[k] ||= onRow();
		} else if (k === "fear") {
			const rows = m.tl.by.fear,
				r = rows && rows[rows.length - 1];
			if (r && r[2] == null && v > r[3]) r[3] = v;
		} else if (v !== c.cur) tlClose(m.tl, k, t), tlOpen(m.tl, k, t, v);
		c.cur = v;
		c.v = k === "fear" ? Math.max(c.v || 0, v) : v; // fear: the highest level
	}
	/**
	 * A grid line: every character's GRID_COLS at the virtual time `v` (the base, a GRID_MS boundary, or the end), and in `c` the ms
	 * of every condition it has had (> 0; the inline tail goes without `c`).
	 */
	gridRow(v, end) {
		const g = this.grid,
			r = {},
			c = {};
		const gone = [...this.gone].filter(([n]) => !this.inGame.has(n)).map(([n, p]) => [p, this.mx[n]]);
		for (const [p, m] of [...this.ours, ...gone])
			if (m) {
				r[p.name] = this.gridCols(p, m);
				const o = (c[p.name] = {});
				for (const k in m.cond) if (m.cond[k].ms > 0) o[k] = m.cond[k].ms;
			}
		const line = { t: r1(v - this.base.at), v, r };
		if (end) line.end = true;
		const text = JSON.stringify({ ...line, c }) + "\n";
		fs.writeSync(g.fd, text);
		g.bytes += Buffer.byteLength(text);
		g.lines++;
		g.tail.push(line);
		if (g.tail.length > GRID_TAIL) g.tail.shift();
		g.next = (Math.floor(v / this.gridMs) + 1) * this.gridMs;
		if (g.bytes > GRID_MAX) this.gridCompact();
	}
	// an item's event (ITEMS_MAX), at the clock's measured time
	itemEvent(e) {
		const L = this.items;
		if (!L || L.capped) return;
		const text = JSON.stringify({ t: r1(this.sim.clock.now - this.base.at), ...e }) + "\n";
		if (L.bytes + text.length > ITEMS_MAX) return void ((L.capped = true), fs.writeSync(L.fd, JSON.stringify({ t: r1(this.sim.clock.now - this.base.at), k: "cap" }) + "\n"), L.lines++);
		fs.writeSync(L.fd, text);
		L.bytes += Buffer.byteLength(text);
		L.lines++;
	}
	gridCols(p, m) {
		const s = this.stat(p.name),
			c = this.counters(p, s),
			s0 = s.start || c,
			f = m.gold_flow,
			cm = (k) => (m.cond[k] ? m.cond[k].ms : 0);
		return [p.level, c.xp - s0.xp, c.kills - s0.kills, m.credits, c.deaths - s0.deaths, m.dmg.done.net, m.dmg.done.raw, m.dmg.taken.net, m.heal.done.net, m.heal.done.raw,
			f.chest + f.egold + f.enc + f.sold + f.stand, m.loot_items, c.hp - s0.hp, c.mp - s0.mp, m.mana.spent, (p.gold || 0) - m.gold0, m.alive_ms, m.combat_ms, m.party_ms,
			cm("citizen0aura"), cm("citizen4aura"), cm("mluck"), cm("encouragement_lonewolf"), cm("party"), m.exact.angel_gold, m.dmg.taken.raw];
	}
	// over GRID_MAX: keep every other line older than the newest GRID_KEEP_MS (rows are cumulative: only resolution goes)
	gridCompact() {
		const g = this.grid;
		fs.closeSync(g.fd);
		const lines = fs.readFileSync(g.path, "utf8").split("\n").filter(Boolean),
			head = lines.shift(),
			vOf = (l) => Number((/"v":(\d+)/.exec(l) || [])[1]),
			newest = vOf(lines[lines.length - 1]);
		let odd = false;
		const keep = lines.filter((l) => vOf(l) >= newest - GRID_KEEP_MS || (odd = !odd));
		const text = [head, ...keep].join("\n") + "\n",
			tmp = g.path + "." + process.pid + ".tmp";
		fs.writeFileSync(tmp, text);
		fs.renameSync(tmp, g.path);
		g.fd = fs.openSync(g.path, "a");
		g.bytes = Buffer.byteLength(text);
		g.lines = keep.length;
		g.gen++;
	}
	/** What a character holds by item name: bag, gear and stand (and the account's bank for the merchant). */
	census(p) {
		const o = {},
			add = (it) => {
				if (!it) return;
				let n = it.name;
				if (n === "placeholder") n = it.p && it.p.name; // an upgrade/compound in progress
				if (n) o[n] = (o[n] || 0) + (it.q || 1);
			};
		const q = p.q || {},
			items = p.items || [];
		for (let i = 0; i < items.length; i++) {
			// the upgrade/compound in progress: what will come back (rolled at the request: the item, or nothing)
			const up = q.upgrade && q.upgrade.num === i,
				co = q.compound && q.compound.num === i;
			if (items[i] && items[i].name === "placeholder" && p.p && (up || co)) add(up ? p.p.u_item : p.p.c_item);
			else add(items[i]);
		}
		// (a trade slot's buy order, b: true, is wanted, not held)
		for (const k in p.slots || {}) if (k !== "elixir" && !(p.slots[k] && p.slots[k].b)) add(p.slots[k]);
		if (p.type === "merchant") {
			const bank = this.bankOf(p);
			for (const k in bank || {}) if (/^items\d+$/.test(k) && Array.isArray(bank[k])) for (const it of bank[k]) add(it);
		}
		return o;
	}
	bankOf(p) {
		if (p.user) return p.user; // mounted: the server's copy
		try {
			return this.sim.env.db.collection(this.sim.env.kindOf(p.owner)).store.get(p.owner).info;
		} catch (e) {
			return null;
		}
	}
	pollModes() {
		for (const w of this.sim.workers || [])
			if (w.modes)
				for (let m; (m = receiveMessageOnPort(w.modes)); ) {
					if (w.dead && (w.leftAt == null || m.message.at > w.leftAt)) continue; // (its page is closed)
					const x = (this.modeTotals[w.name] = m.message),
						r = this.reportOf(w.name);
					(r.from = x.from || null), (r.impure = x.impure || null);
					if ("status" in x) r.status = x.status;
					if ("role" in x) r.role = x.role;
					if (x.log) this.logged(w.name, x.log);
				}
	}
	// a character's game log lines and console errors (client threads: pollModes; the single-thread Sim: probe()):
	// counts since the start, the last LOG_KEEP lines
	logged(name, x) {
		const L = (this.logs[name] ||= { lines: 0, errors: 0, console: 0, last: [] });
		(L.lines += x.n), (L.errors += x.err || 0), (L.console += x.con || 0);
		L.last.push(...x.lines);
		if (L.last.length > LOG_KEEP) L.last.splice(0, L.last.length - LOG_KEEP);
	}
	// notes.chronal: the getters no longer called, "<name>: <field> disabled (<why>)"; each warned about once
	alSimNotes() {
		const out = [];
		for (const [name, c] of Object.entries(this.codes))
			for (const [k, why] of Object.entries(c.impure || {})) {
				const t = `${name}: ${k} disabled (${WHY[why] || why})`;
				out.push(t);
				if (!this.warned.has(t)) this.warned.add(t), console.warn("[sim] chronal " + t);
			}
		return out.join("; ");
	}
	// ms per CODE mode since the base: the last totals carried to now in their current mode, minus the same at the base;
	// at most the measured time
	modesOf(name, now, measured) {
		const x = this.modeTotals[name],
			past = this.modesPast && this.modesPast[name];
		if ((!x || !x.totals) && !past) return null;
		const at = (to) => {
			const o = x && x.totals ? modesUpTo(x, to) : {};
			for (const k in past || {}) o[k] = (o[k] || 0) + past[k];
			return o;
		};
		const m0 = (this.modes0[name] ||= at(this.base.at)),
			out = at(now);
		// rounded first, then their sum clamped to the whole measured ms (the single-thread Sim's clock carries the
		// timers' fractional lateness): the excess off the current mode, then off the largest
		let excess = -Math.floor(measured);
		for (const k in out) excess += out[k] = Math.round(Math.max(0, out[k] - (m0[k] || 0)));
		while (excess > 0) {
			const k = x.cur != null && out[x.cur] > 0 ? x.cur : Object.keys(out).reduce((a, b) => (out[b] > out[a] ? b : a)),
				d = Math.min(excess, out[k]);
			(out[k] -= d), (excess -= d);
		}
		const res = Object.entries(out).filter(([, ms]) => ms > 0);
		return res.length ? Object.fromEntries(res) : null;
	}
	note(key, value) {
		this.notes[key] = value;
	}
	/** A steering entry applied (start.js steerer): { at, character, note, did, errors }, its time t (game s since the
	 * base) added */
	steered(e) {
		const from = this.base ? this.base.at : this.measureAt;
		this.steers.push({ t: from != null ? r1(this.sim.clock.now - from) : 0, ...e });
	}
	/** The final snapshot with how the run ended: { reason: "complete" | "stopped" | "failed", detail }; done, but a failed
	 * run's (not done, as one whose process died: onExit). */
	close(end) {
		if (this.closed) return;
		this.closed = true;
		this.end = { reason: (end && end.reason) || "complete", detail: (end && end.detail) || null };
		if (this.timer) clearInterval(this.timer);
		try {
			this.probe();
			if (!this.base) this.tryBase(performance.now());
			if (this.base) this.sample(this.sim.clock.now);
			if (this.grid) this.gridRow(this.sim.clock.now, true);
		} catch (e) {}
		try {
			this.mlv.end = mlevels(this.sim.server);
		} catch (e) {}
		try {
			if (this.grid) fs.closeSync(this.grid.fd);
			if (this.items) fs.closeSync(this.items.fd);
		} catch (e) {}
		try {
			this.write(this.end.reason !== "failed");
		} catch (e) {}
		try {
			fs.rmSync(this.ctl, { force: true });
		} catch (e) {}
		if (LIVES.get(this.sim.hub) === this) LIVES.delete(this.sim.hub);
	}
	write(done) {
		const out = this.build(done);
		const tmp = this.file + "." + process.pid + ".tmp";
		fs.writeFileSync(tmp, JSON.stringify(out));
		fs.renameSync(tmp, this.file);
	}
	/** The snapshot as it would be written now, nothing kept (its speed sample, history rows): what steering conditions
	 * and run.until read (steer.js) */
	peek() {
		return this.build(false, true);
	}
	// the snapshot; peek: nothing of it kept (the speed sample, the history rows)
	build(done, peek = false) {
		const sim = this.sim,
			S = sim.server,
			G = S.G,
			real = performance.now(),
			v = sim.clock.now - this.v0,
			busy = typeof sim.busy === "function" ? sim.busy() : {};
		const list = [];
		for (const id in S.players) {
			const p = S.players[id];
			if (p && !p.npc) list.push(p);
		}
		this.pollModes();
		const alSim = this.alSimNotes();
		if (alSim) this.notes.chronal = alSim;
		// (the ones that left keep the gold they left with)
		const gold = this.goldOf([...list, ...[...this.gone].filter(([n]) => !list.some((p) => p.name === n)).map(([, p]) => p)]),
			base = this.base;
		let recent = null;
		if (base && this.prev && v > this.prev.v && real > this.prev.real) {
			recent = { speed: (v - this.prev.v) / (real - this.prev.real), load: {} };
			for (const [k, ms] of Object.entries(busy)) recent.load[k] = +Math.min(1, (ms - (this.prev.busy[k] || 0)) / (real - this.prev.real)).toFixed(3);
			if (!done && !peek) this.speeds.push(+recent.speed.toFixed(1));
			if (this.speeds.length > 20_000) this.speeds = this.speeds.filter((_, i) => i % 2 === 0);
		}
		if (!peek) this.prev = { real, v, busy };
		const t = base ? Math.round((v - base.v) / 1000) : 0,
			measured = base ? v - base.v : 0,
			share = (ms) => (measured > 0 ? +Math.min(1, ms / measured).toFixed(3) : 0),
			ts = (ms) => (ms == null ? null : r1(ms)),
			tNow = this.sv == null ? 0 : this.sv - (base ? base.at : 0); // conditions are counted to the last sample
		const players = [],
			rows = {},
			names = new Set(list.map((p) => p.name));
		// in game, then the ones that left (as they left: their history and grid rows go on flat, so sums over the
		// characters never drop when one logs out)
		const all = [...list.map((p) => [p, true]), ...[...this.gone].filter(([n]) => !names.has(n)).map(([, p]) => [p, false])];
		for (const [p, here] of all) {
			const s = this.stat(p.name),
				c = this.counters(p, s),
				s0 = s.start || c,
				d = {};
			for (const k of Object.keys(c)) d[k] = c[k] - s0[k];
			const m = this.mx[p.name];
			const f = m && m.gold_flow,
				income = m ? f.chest + f.egold + f.enc + f.sold + f.stand : 0;
			if (base) {
				rows[p.name] = [t, p.level, d.xp, d.hp, d.mp, d.kills, d.deaths, m ? m.dmg.done.net : 0, m ? m.dmg.taken.net : 0, m ? m.heal.done.net : 0, income, d.trips,
					m ? m.dmg.done.raw : 0, m ? m.heal.done.raw : 0, m ? m.dmg.taken.raw : 0];
				if (!peek) histPush(s, rows[p.name]);
			}
			const { gear, gear_stat } = gearOf(p.slots);
			const out = {
				name: p.name, type: p.type, level: p.level, start_level: s0.level, xp: p.xp, max_xp: G.levels[p.level] || 0, xp_gained: d.xp,
				gold: p.gold, map: p.map, x: Math.round(p.x), y: Math.round(p.y), rip: !!p.rip, free: (p.isize || 42) - (p.items || []).filter(Boolean).length,
				hpots: d.hp, mpots: d.mp, pots: Object.fromEntries(Object.entries(s.pots).map(([k, n]) => [k, n - ((s.pots0 || {})[k] || 0)]).filter(([, n]) => n > 0)), kills: d.kills, deaths: d.deaths, trips: d.trips, outings: d.outings, town_visits: d.visits,
				out_share: measured > 0 ? +Math.min(1, s.out_ms / measured).toFixed(3) : 0,
				maps: Object.fromEntries(Object.entries(s.maps).map(([k, ms]) => [k, +Math.min(1, ms / Math.max(1, measured)).toFixed(3)])),
				gear, gear_stat, stats: statsOf(p), history: s.history || null, measured_ms: measured, online: here, sessions: this.sessions[p.name] || null,
				role: this.roleOf(p), code_status: this.codes[p.name] ? this.codes[p.name].status : null, modes_from: this.codes[p.name] ? this.codes[p.name].from : null,
				...(this.outside.has(p.name) ? { outside: true } : {}),
				log: this.logs[p.name] ? this.logs[p.name].last : null, log_n: this.logs[p.name] ? { lines: this.logs[p.name].lines, errors: this.logs[p.name].errors, console: this.logs[p.name].console } : null,
				inventory: (p.items || []).map((it) => (it ? { name: it.name, q: it.q, level: it.level, stat_type: it.stat_type, p: typeof it.p === "string" ? it.p : undefined } : null)),
				// now: hp and mp, the condition keys on it, its CODE's mode; kills by type and the last one's t, from the base
				hp: p.hp, mp: p.mp, s: Object.keys(p.s || {}).sort(), mode: here && this.modeTotals[p.name] ? this.modeTotals[p.name].cur ?? null : null,
				kills_by: { ...s.kby }, last_kill: base && s.lastKill != null ? r1(s.lastKill - base.at) : null,
			};
			if (m) {
				const casts = (by) => Object.fromEntries(Object.entries(by).map(([k, e]) => [k, { ...e, casts: m.casts[k] || 0 }]));
				const now = this.census(p),
					held = {};
				for (const k of new Set([...Object.keys(now), ...Object.keys(m.census0)])) if ((now[k] || 0) !== (m.census0[k] || 0)) held[k] = (now[k] || 0) - (m.census0[k] || 0);
				const cond = m.cond,
					cms = (k) => (cond[k] ? cond[k].ms : 0),
					mean = (x) => (m.sampled > 0 ? +(x / m.sampled).toFixed(4) : null);
				Object.assign(out, {
					party: { name: p.party || null, share: p.party && typeof p.share === "number" ? +p.share.toFixed(4) : null, ms: m.party_ms, xp: m.party_xp },
					buffs: { lonewolf: share(cms("encouragement_lonewolf")), mluck: share(cms("mluck")), xpm: p.xpm, goldm: p.goldm, luckm: p.luckm },
					alive_ms: m.alive_ms, combat_ms: m.combat_ms, credits: m.credits,
					dmg: { ...m.dmg, by_skill: casts(m.dmg.by_skill), overkill: m.dmg.done.raw - m.dmg.done.net },
					heal: { ...m.heal, by_skill: casts(m.heal.by_skill), overheal: m.heal.done.raw - m.heal.done.net },
					mana: m.mana, items: { ...m.items, held }, gold_flow: f, income, chests: m.chests, casts: m.casts,
					modes: base ? this.modesOf(p.name, here ? sim.clock.now : this.leftV[p.name], measured) : null,
					gold_start: m.gold0, xp_award: m.xp_award, xp_lost: m.xp_lost,
					server: p.t ? { mdamage: p.t.mdamage - m.t0.mdamage + ((m.tPast && m.tPast.mdamage) || 0), cgold: p.t.cgold - m.t0.cgold + ((m.tPast && m.tPast.cgold) || 0), xp: p.t.xp - m.t0.xp + ((m.tPast && m.tPast.xp) || 0) } : null,
				});
				// buffs extension (null in the single-thread Sim: sampled once per real second); timeline rows of every key by t_on
				const fine = !this.coarse,
					tl = m.tl,
					tlRows = [];
				if (fine) for (const k in tl.by) for (const r of tl.by[k]) tlRows.push(r);
				tlRows.sort((a, b) => a[1] - b[1]);
				Object.assign(out, {
					conditions: fine ? Object.fromEntries(Object.entries(cond).map(([k, x]) => [k, { ms: x.ms, n: x.n, max_ms: x.on ? Math.max(x.max_ms, tNow - x.t0) : x.max_ms, kind: x.kind, ...(x.v !== undefined ? { v: x.v } : {}) }])) : null,
					mult_avg: fine ? { xpm: mean(m.mult.xpm), goldm: mean(m.mult.goldm), luckm: mean(m.mult.luckm), enc_xp: mean(m.mult.enc_xp), enc_gold: mean(m.mult.enc_gold), enc_luck: mean(m.mult.enc_luck) } : null,
					on: fine ? Object.fromEntries(Object.entries(m.on).map(([k, o]) => [k, { ms: cms(k), ...o }])) : null,
					exact: fine ? { ...m.exact } : null,
					timeline: fine ? { gap_ms: tl.gap_ms, cap: tl.cap, key_cap: tl.key_cap, dropped: tl.dropped, dropped_by: { ...tl.dropped_by }, since: Object.fromEntries(Object.entries(tl.since).map(([k, ms]) => [k, ts(ms)])),
						rows: tlRows.map((r) => [r[0], ts(r[1]), ts(r[2]), r[3] === undefined ? null : r[3]]) } : null,
				});
			}
			players.push(out);
		}
		players.sort((a, b) => (a.type === "merchant") - (b.type === "merchant") || a.name.localeCompare(b.name));
		// deaths: grouped by who, map, ~100 px and killer (complete), plus the last few
		// the deaths since the base (not the warm-up's or the login's), grouped
		const groups = new Map(),
			measuredDeaths = base ? this.deaths.slice(base.deaths) : [],
			rel = (dv) => Math.max(0, Math.round((dv - this.v0 - (base ? base.v : 0)) / 1000));
		for (const d of measuredDeaths) {
			const x = { ...d, t: rel(d.v) };
			const k = [x.name, x.map, Math.round(x.x / 100) * 100, Math.round(x.y / 100) * 100, x.by].join("|");
			const g = groups.get(k) || groups.set(k, { name: x.name, map: x.map, x: Math.round(x.x / 100) * 100, y: Math.round(x.y / 100) * 100, by: x.by, n: 0, first: x.t, last: x.t, level: x.level }).get(k);
			(g.n++, (g.last = x.t), (g.level = x.level));
		}
		const sorted = [...this.speeds].sort((a, b) => a - b),
			since = (now, at) => Object.fromEntries(Object.entries(now).map(([k, n]) => [k, n - ((at && at[k]) || 0)]).filter(([, n]) => n > 0)),
			sum = (o) => Object.values(o).reduce((a, b) => a + b, 0),
			kills = since(this.kills, base && base.kills),
			okills = since(this.okills, base && base.okills);
		const loadAvg = {};
		if (base && real > base.real) for (const [k, ms] of Object.entries(busy)) loadAvg[k] = +Math.min(1, (ms - (base.busy[k] || 0)) / (real - base.real)).toFixed(3);
		// roster (run order), the party of fighters and the merchant
		const roster = this.roster || list.map((p) => ({ name: p.name, type: p.type, level: (this.stat(p.name).start || {}).level || p.level, role: this.rosterRole(p), code: null, gear_hash: (this.gear0 && this.gear0[p.name]) || null }));
		const members = roster.filter((r) => r.type !== "merchant").map((r) => r.name),
			merchant = (roster.find((r) => r.type === "merchant") || {}).name || null;
		// (the fighters in game: characters come and go)
		if (base && members.some((n) => rows[n])) {
			const r = members.filter((n) => rows[n]).map((n) => rows[n]),
				col = (i) => r.reduce((a, x) => a + x[i], 0);
			if (!peek) histPush(this.party, [t, Math.min(...r.map((x) => x[1])), col(2), col(3), col(4), col(5), col(6), col(7), col(8), col(9), col(10), 0, col(12), col(13), col(14)]);
		}
		const partyGroups = {};
		for (const [leader, names] of Object.entries(S.parties || {})) if (Array.isArray(names) && names.length) partyGroups[leader] = [...names];
		// "(no party)": measured, the fighters were never in one party (so far)
		const formed = base && members.length > 1 && this.party.formed == null ? false : undefined;
		this.meta.strategy = this.strategyText(formed);
		const coarse = this.coarse,
			gr = this.grid;
		const out = {
			id: this.id, tag: this.tag, ...this.meta, schema: 2, schema_minor: 6,
			precision: { dmg_done: "net", dmg_taken: "net", heal: "net", overkill: "exact", overheal: "exact", items: "exact", gold: "exact", gold_other: "exact", mana_by_skill: "exact",
				sample_ms: coarse ? null : SAMPLE_MS, modes: coarse ? "coarse" : "exact", grid: coarse ? null : "exact", attrib: coarse ? null : "exact" },
			history_cols: HISTORY_COLS, roster,
			started: new Date(this.started).toISOString(), updated: new Date().toISOString(), done: !!done,
			proc: this.proc, control: { file: path.basename(this.ctl), stop: typeof sim.halt === "function", ack: this.ack }, launch: this.launch, end: this.end, run: this.runInfo,
			virtual_ms: v, measured_ms: measured, real_ms: Math.round(real - this.t0), trips_available: !coarse,
			speed: {
				now: done || !recent ? null : +recent.speed.toFixed(1),
				avg: base && real > base.real ? +((v - base.v) / (real - base.real)).toFixed(1) : null,
				median: sorted.length ? sorted[sorted.length >> 1] : null,
				min: sorted.length ? sorted[0] : null,
				max: sorted.length ? sorted[sorted.length - 1] : null,
			},
			load: { now: done || !recent ? null : recent.load, avg: loadAvg },
			gold: { start: base ? base.gold : gold, now: gold, ...(this.outsideAccounts.length ? { outside: this.outsideAccounts } : {}) },
			kills: { total: sum(kills), by_type: kills, others: { total: sum(okills), by_type: okills, by: since(this.okBy, base && base.okBy) } },
			deaths: { total: this.deaths.length - (base ? base.deaths : 0), groups: [...groups.values()].sort((a, b) => b.n - a.n).slice(0, 60), recent: measuredDeaths.slice(-10).map(({ v: dv, ...d }) => ({ ...d, t: rel(dv) })) },
			party: { members, merchant, merchant_in_party: this.party.merchant_in, formed_ms: members.length > 1 ? this.party.formed : null, party_ms: this.party.ms, groups: partyGroups, history: this.party.history },
			merchant: merchant ? { name: merchant, trips: this.merchant.trips, per_fighter: this.merchant.per_fighter } : null,
			world: { clock: sim.clock.now, start: new Date(sim.clock.start).toISOString(), seasons: this.setup ? this.setup.resolved.world.seasons || [] : [], anniversary: !!(S.events && S.events.anniversary), ugrace: S.S && S.S.ugrace ? Array.from(S.S.ugrace) : null, spawns: this.setup ? this.setup.resolved.world.spawns || [] : [], forced: this.forcedEvents, events: this.eventsOf(S), globals: { goldm: S.goldm, luckm: S.luckm, xpm: S.xpm }, age_ms: this.ageMs, mlevels: this.mlv },
			grid: gr ? { step_ms: this.gridMs, cols: GRID_COLS, file: path.basename(gr.path), lines: gr.lines, gen: gr.gen, tail: gr.tail } : null,
			items_log: this.items ? { file: path.basename(this.items.path), lines: this.items.lines, bytes: this.items.bytes, capped: this.items.capped } : null,
			players, notes: this.notes, steer: this.steers, banks: this.banks(list),
			state: { exports: this.exports, pending: this.exportWanted ? this.exportWanted.label : null },
		};
		return out;
	}
	// the server's dailies and nightlies on now (its var events), each one's first and last time seen
	eventsOf(S) {
		const t = this.base ? Math.round((this.sim.clock.now - this.base.at) / 1000) : null;
		for (const k of [...SCH.DAILIES, ...SCH.NIGHTLIES]) if (S.events && S.events[k]) (this.eventsSeen[k] ||= { from: t, to: t }).to = t;
		return this.eventsSeen;
	}
	// a forced event (chronal run: world.events) as it fired
	forced(e) {
		this.forcedEvents.push({ event: e.event, at_ms: SETUP.parseDuration(e.at), t: this.base ? Math.round((this.sim.clock.now - this.base.at) / 1000) : null });
	}
	// each account's bank now: { <account>: { gold, free } } (free: the empty slots of its packs; a mounted copy, inside
	// the bank, wins over the stored user doc); {} outside a setup's run
	banks(list) {
		const out = {},
			env = this.sim.env;
		for (const [k, a] of this.sim.accounts || []) {
			const on = list.find((p) => p.owner === a.user_id && p.user);
			let info = on ? on.user : null;
			if (!info)
				try {
					info = env.db.collection(env.kindOf(a.user_id)).store.get(a.user_id).info;
				} catch (e) {}
			if (!info) continue;
			const packs = Object.keys(info).filter((x) => /^items\d+$/.test(x) && Array.isArray(info[x]));
			out[k] = { gold: info.gold || 0, free: packs.reduce((n, x) => n + BANK_PACK - info[x].filter(Boolean).length, 0) };
		}
		return out;
	}
	// the characters' gold and their accounts' bank gold (a mounted copy, inside the bank, wins over the stored user doc)
	goldOf(list) {
		const env = this.sim.env,
			banks = new Map();
		list = list.filter((p) => !this.outside.has(p.name)); // (an account out of the totals: its characters and bank)
		for (const p of list) if (p.owner && p.user && p.user.gold != null) banks.set(p.owner, p.user.gold);
		for (const p of list)
			if (p.owner && !banks.has(p.owner))
				try {
					banks.set(p.owner, env.db.collection(env.kindOf(p.owner)).store.get(p.owner).info.gold || 0);
				} catch (e) {
					banks.set(p.owner, 0);
				}
		let gold = 0;
		for (const p of list) gold += p.gold || 0;
		for (const g of banks.values()) gold += g;
		return gold;
	}
	// The measured part starts once every character is in game and the warm-up is over (boot, login and the warm-up don't
	// count): at the first probe from then on that finds them all, a game time (the same for the same seed), not at a
	// snapshot (real time). probe() filled this.list.
	tryBase(real) {
		const sim = this.sim,
			expected = (sim.workers || sim.clients || []).length;
		if (!expected || this.list.length < expected) return false;
		if (this.warmMs) {
			if (this.measureAt == null) this.measureAt = sim.clock.now + this.warmMs; // (chronal run sets it: measureFrom)
			if (sim.clock.now < this.measureAt) return false;
		}
		this.startBase(this.list, real, sim.clock.now - this.v0, typeof sim.busy === "function" ? sim.busy() : {}, this.goldOf(this.list));
		return true;
	}
	// the base: every character's counters and gear now, the first sample (a party already formed: formed_ms 0), the grid file
	startBase(list, real, v, busy, gold) {
		const now = this.sim.clock.now;
		this.base = { real, v, at: now, busy: { ...busy }, gold, kills: { ...this.kills }, okills: { ...this.okills }, okBy: { ...this.okBy }, deaths: this.deaths.length };
		this.mlv.base = mlevels(this.sim.server);
		this.gear0 = {};
		for (const p of list) {
			const s = this.stat(p.name);
			s.start = this.counters(p, s);
			s.pots0 = { ...s.pots }; // potions by item at the base
			this.mx[p.name] = metrics(p, this.census(p));
			this.gear0[p.name] = gearHash(p.slots);
			if (p.type !== "merchant") this.merchant.per_fighter[p.name] ||= ledger();
			else if (s.open && !s.trip) s.trip = { t_out: now, met: new Set(), close: new Set(), served: {} }; // a trip under way at the base counts from it
		}
		for (const r of this.roster || []) if (this.gear0[r.name]) r.gear_hash = this.gear0[r.name];
		for (const p of list) this.inGame.add(p.name), (this.sessions[p.name] = [[0, null]]);
		this.setupKey();
		this.ours = list.map((p) => [p, this.mx[p.name]]);
		this.sample(now);
		if (this.coarse) return;
		const file = path.join(this.dir, this.id + ".grid.ndjson"),
			head = JSON.stringify({ cols: GRID_COLS, step_ms: this.gridMs, id: this.id }) + "\n";
		fs.writeFileSync(file, head);
		this.grid = { path: file, fd: fs.openSync(file, "a"), bytes: Buffer.byteLength(head), lines: 0, gen: 0, tail: [], next: 0 };
		this.gridRow(now); // the base's row (t 0: the charts start at 0:00), then one per GRID_MS boundary
		const items = path.join(this.dir, this.id + ".items.ndjson");
		fs.writeFileSync(items, "");
		this.items = { path: items, fd: fs.openSync(items, "a"), bytes: 0, lines: 0, capped: false };
	}
}

/**
 * o (createSim's live option): { dir, tag, every, setup }: on with o.dir; tag o.tag, else the setup's name, else
 * "<script> s<seed>". Never breaks a run.
 */
function liveOf(sim, o) {
	if (!o || !o.dir) return null;
	const name = o.setup && o.setup.resolved && o.setup.resolved.name;
	try {
		return new Live(sim, { dir: o.dir, tag: o.tag || name, every: o.every || 1000, setup: o.setup || null });
	} catch (e) {
		console.warn("[sim] live snapshots off:", (e && e.message) || e);
		return null;
	}
}

module.exports = { Live, liveOf, reserveId, gearOf, HISTORY_COLS, GRID_COLS, STATS, GEAR };
