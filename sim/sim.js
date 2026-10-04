"use strict";
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const { Worker, MessageChannel, receiveMessageOnPort } = require("node:worker_threads");
const { VirtualClock } = require("./vclock");
const { Hub, Link, RemotePeer, Gate, spinWhile } = require("./fake_io");
const { makeEnv, seedMaps, startServer, insertAfter } = require("./server_host");
const { startClient, clientInfo, makeStorage, putStorage } = require("./client_host");

let rejectionHandler = false;
// round trip client<->server ms when a caller gives none (a setup's world.ping has the same default)
const DEFAULT_PING = 18;

// LIVE sims: SIGINT/SIGTERM halts them at the next game minute (the runner writes its numbers, close() the final
// snapshot); a second signal writes their snapshots as they are and exits at once. Without LIVE, Node's default.
const SIGNALS = ["SIGINT", "SIGTERM"],
	halting = new Set();
let signaled = null;
function onSignal(sig) {
	if (signaled) {
		for (const sim of halting)
			try {
				sim.live.close({ reason: "stopped", detail: sig + " x2" });
			} catch (e) {}
		process.exit(128 + (os.constants.signals[sig] || 0));
	}
	signaled = sig;
	for (const sim of halting) sim.halt(sig);
	console.error(`[sim] ${sig}: stopping at the next game minute (again: at once)`);
}
function haltOnSignals(sim, on) {
	if (on) {
		if (!halting.size) for (const sig of SIGNALS) process.on(sig, onSignal);
		halting.add(sim);
	} else if (halting.delete(sim) && !halting.size) {
		for (const sig of SIGNALS) process.off(sig, onSignal);
		signaled = null;
	}
}

/**
 * @param {object} o
 * @param {string} o.root              adventureland_mongodb checkout (with common/ + secretsandconfig/ linked)
 * @param {number} [o.seed]            same seed + same CODE => same run
 * @param {number} [o.start]           epoch ms the world's clock starts at (default 2026-01-01T00:00Z: vclock.js)
 * @param {string[]} [o.seasons]       the server's season switches on (server_host.js startServer)
 * @param {boolean} [o.anniversary]    the anniversary event (default on, as the game server ships)
 * @param {*} [o.ugrace]                the server's upgrade grace per level (null: a new realm's, 24 each; a number, a list,
 *                                     { <level>: n } over the 24s); o.ugrace_fixed: held there (a busy realm's steady state)
 * @param {boolean} [o.threads]        one thread per character, stepped in lockstep with the server (docs/explanation/sim.md)
 * @param {number} [o.ping]           round trip client<->server ms, as the game's character.ping (default 18): each way
 *                                     takes 0.4-0.6x it, uniform. In threads mode the minimum is also the lockstep window.
 * @param {(rng,profile)=>number} [o.lateness]  timer lateness ms (default 1–3)
 * @param {boolean} [o.quiet]          silence server console spam (default true)
 * @param {{radius?:number, box?:number}} [o.roi]   opt-in: freeze monsters (and their spawn areas) out of every player's reach:
 *                                     farther than radius (900), or with `box`, outside the view box grown by that many px
 * @param {false|object} [o.live]     live snapshots: { dir, tag, every, setup: { resolved, bundles, from } } = on (live.js
 *                                     liveOf); false or unset = off
 * @param {boolean} [o.record]        replay recordings (lib/rec.js) beside the snapshot: threads mode with live snapshots
 */
async function createSim(o) {
	// Browsers only log unhandled rejections (AL's CODE API rejects promises all the time); Node would crash.
	if (!rejectionHandler) (rejectionHandler = true), process.on("unhandledRejection", (e) => o.onRejection && o.onRejection(e));
	const ping = o.ping ?? DEFAULT_PING;
	if (!(ping > 0)) throw new Error(`[sim] ping ${ping}: a round trip in ms > 0`);
	const [lo, hi] = [ping * 0.4, ping * 0.6];
	const clock = new VirtualClock({ seed: o.seed ?? 1, lateness: o.lateness, start: o.start });
	const hub = new Hub(clock, { latency: (rng) => lo + rng() * (hi - lo) });
	const env = makeEnv({ clock, hub, root: o.root });
	seedMaps(env);
	if (o.roi)
		env.sourcePatches = [
			// One flag check per monster / NPC; the flags are computed by enableROI() below.
			(src) => insertAfter(src, "update_instance", "var monster = instance.monsters[id];", " if (monster[__roi_skip]) continue;"),
			(src) => "var __roi_skip = Symbol('roi_skip');\n" + src,
		];
	const log = console.log;
	if (o.quiet !== false) console.log = () => {};
	let server;
	try {
		server = await startServer(env, { seasons: o.seasons || [], anniversary: o.anniversary !== false });
		server.__root = env.root; // clientInfo() reads the design files from here (what /data.js serves)
		if (o.ugrace != null || o.ugrace_fixed) setUgrace(server, o.ugrace, !!o.ugrace_fixed);
	} finally {
		console.log = log;
	}
	if (o.quiet !== false) server.console = { ...console, log() {}, info() {} };
	pauseIdleMaps(server);
	skipPausedAuras(server);
	dateFreeMssince(server, clock);
	if (o.roi) enableROI(server, o.roi);
	const Kind = o.threads ? ThreadedSim : Sim;
	const sim = new Kind(clock, hub, env, server, { seed: o.seed ?? 1, latencyRange: [lo, hi] });
	// opt-in live snapshots for the dashboard: read-only, outcomes unchanged
	sim.live = require("./live").liveOf(sim, o.live);
	if (sim.live) haltOnSignals(sim, true);
	// replay recordings (lib/rec.js, o.record): <live dir>/<id>.rec/, one per character; threads mode with live snapshots
	// only (the single-thread Sim's clients share one hub)
	const record = !!o.record;
	if (record && !(o.threads && sim.live)) console.warn("[sim] record: no recording (it needs threads mode and live snapshots)");
	sim.recDir = record && o.threads && sim.live ? path.join(sim.live.dir, sim.live.id + ".rec") : null;
	return sim;
}

/** Same rule the live server applies after 50s (players <= npcs, no observers), applied at boot so we skip the warm-up. */
function pauseIdleMaps(S) {
	const sleeping = new Map(),
		pause = S.pause_instance,
		resume = S.resume_instance;
	// NPCs on a paused map still cost ~0.5ms per npc_loop tick; nobody can see them, so park them until the map resumes.
	S.pause_instance = function (inst) {
		pause.apply(this, arguments);
		const list = [];
		for (const id in S.npcs) if (S.npcs[id].in === inst.name) list.push([id, S.npcs[id]]), delete S.npcs[id];
		if (list.length) sleeping.set(inst.name, list);
	};
	S.resume_instance = function (inst) {
		const list = inst && sleeping.get(inst.name);
		if (list) for (const [id, npc] of list) S.npcs[id] = npc;
		if (inst) sleeping.delete(inst.name);
		return resume.apply(this, arguments);
	};
	for (const inst of Object.values(S.instances))
		if (!inst.paused && Object.keys(inst.players).length <= inst.npcs && !Object.keys(inst.observers).length) S.pause_instance(inst);
}

/**
 * refresh_paladin_auras() walks every instance's players (NPCs included) once a second: ~1.2ms, mostly on paused maps.
 * A paused map has no paladins and no paladin-aura conditions, so skipping it changes nothing.
 */
function skipPausedAuras(S) {
	const refresh = S.refresh_paladin_auras;
	S.refresh_paladin_auras = function () {
		const all = S.instances,
			live = {};
		for (const k in all) if (!all[k].paused) live[k] = all[k];
		S.instances = live;
		try {
			return refresh.apply(this, arguments);
		} finally {
			S.instances = all;
		}
	};
}

/**
 * mssince(t) with no `ref` makes a Date only to subtract `t` from it: ~360k calls per virtual minute, all without a
 * ref. That Date's time value is the virtual now and it never escapes, so this computes the same thing (same
 * conversion of `t`, same result) without it. Compiled in the server's context so its callers can inline it; only
 * replaces the exact version it was checked against.
 */
const MSSINCE = "function mssince(t, ref) {\n\tif (!ref) ref = new Date();\n\tif (!t) return 999999999;\n\treturn ref - t;\n}";
function dateFreeMssince(S, clock) {
	if (typeof S.mssince !== "function" || Function.prototype.toString.call(S.mssince) !== MSSINCE) return console.warn("[sim] the server's mssince() changed: not replaced");
	S.mssince = vm.runInContext(`(function (clock) {
		var floor = Math.floor;
		return function mssince(t, ref) {
			if (!ref) return t ? floor(clock.now) - t : 999999999;
			if (!t) return 999999999;
			return ref - t;
		};
	})`, S, { filename: "sim.js:mssince" })(clock);
}

/**
 * Opt-in approximation: monsters are skipped by the per-tick update (frozen in place; they still level up and respawn
 * as usual) when they're farther than `radius` from every player, and so is the box of their spawn area, and they're
 * inside it. Monsters of an area within reach still wander into view as they would live (large areas: arena, tortoises),
 * and one left outside its area (after a chase) first walks home. Never frozen: anything targeting/focusing, anything
 * with an active condition, map-roaming monsters, and special/cooperative/roaming/global/announced monsters (bosses,
 * event mobs). A client sees 700 x 500 px each way (860 to a corner), and a moving player is also sent what's in a box
 * up to ~28 px ahead (corner ~900): at radius 900 the margin is about 0 px (probes never found a frozen monster in view),
 * 950 gives a real one.
 * `box` (px) instead: "near" is each watcher's own view box (player.vision, 700 x 500 each way) grown by `box` on every
 * side, and a spawn area is within reach when its box overlaps that one. Tighter than the circle (it skips the circle's
 * corners outside the view) with the same margin everywhere: box 50 keeps 32-39% fewer monsters live than radius 900.
 * `merchant` (px): merchants keep only the monsters within this radius live (no view box, no spawn areas), since no
 * merchant CODE reads monsters and a monster picks a player up from under ~100 px (ghash 32 + its range). The
 * merchant's client then sees monsters beyond that frozen in place.
 */
function enableROI(S, { radius = 900, box = null, merchant = null } = {}) {
	const r2 = radius * radius,
		mr2 = merchant == null ? 0 : merchant * merchant,
		m = box,
		SKIP = S.__roi_skip,
		never = new Set();
	for (const [type, def] of Object.entries(S.G.monsters)) if (def.special || def.cooperative || def.roam || def.global || def.announce) never.add(type);
	// [players and observers who get the full rule, merchants who get `merchant`]
	const watchers = (inst) => {
		const list = [],
			merchants = [];
		for (const id in inst.players) {
			const p = inst.players[id];
			if (!p.npc) (merchant != null && p.type === "merchant" ? merchants : list).push(p);
		}
		for (const id in inst.observers) list.push(inst.observers[id]);
		return [list, merchants];
	};
	const merchantNear = (e, list) => {
		for (let i = 0; i < list.length; i++) {
			const dx = e.x - list[i].x,
				dy = e.y - list[i].y;
			if (dx * dx + dy * dy < mr2) return true;
		}
		return false;
	};
	const vision = (p) => p.vision || S.B.vision;
	const near =
		m == null
			? (e, list) => {
				for (let i = 0; i < list.length; i++) {
					const dx = e.x - list[i].x,
						dy = e.y - list[i].y;
					if (dx * dx + dy * dy < r2) return true;
				}
				return false;
			}
			: (e, list) => {
				for (let i = 0; i < list.length; i++) {
					const v = vision(list[i]);
					if (Math.abs(e.x - list[i].x) < v[0] + m && Math.abs(e.y - list[i].y) < v[1] + m) return true;
				}
				return false;
			};
	// a spawn area's box [x1, y1, x2, y2] within reach
	const boxNear =
		m == null
			? (b, list) => {
				for (let i = 0; i < list.length; i++) {
					const dx = Math.max(b[0] - list[i].x, 0, list[i].x - b[2]),
						dy = Math.max(b[1] - list[i].y, 0, list[i].y - b[3]);
					if (dx * dx + dy * dy < r2) return true;
				}
				return false;
			}
			: (b, list) => {
				for (let i = 0; i < list.length; i++) {
					const p = list[i], v = vision(p);
					if (b[0] < p.x + v[0] + m && b[2] > p.x - v[0] - m && b[1] < p.y + v[1] + m && b[3] > p.y - v[1] - m) return true;
				}
				return false;
			};
	const busy = (m) => {
		if (m.target || m.focus || never.has(m.type) || (m.map_def && m.map_def.roam)) return true;
		for (const k in m.s) return true;
		return false;
	};
	// its spawn area is within reach, or it's outside it (areas: one boxNear() per spawn area and update)
	const home = (m, list, areas) => {
		const d = m.map_def,
			b = d && d.boundary;
		if (!b || m.in !== m.oin) return false;
		if (m.x < b[0] || m.x > b[2] || m.y < b[1] || m.y > b[3]) return true;
		let a = areas.get(d);
		if (a === undefined) areas.set(d, (a = boxNear(b, list)));
		return a;
	};
	const update = S.update_instance;
	S.update_instance = function update_instance_roi(inst) {
		if (!inst.paused && !inst.frozen) {
			const [list, merchants] = watchers(inst),
				areas = new Map();
			for (const id in inst.monsters) {
				const m = inst.monsters[id];
				m[SKIP] = !busy(m) && !near(m, list) && !(merchants.length && merchantNear(m, merchants)) && !home(m, list, areas);
			}
		}
		return update.apply(this, arguments);
	};
}

/** The ROI env value: "900" (radius), "box50" (view box + 50 px; "box" = 50), then optionally ",m300" (merchants: 300 px
 * only), e.g. "box50,m300"; unset or "0": off. */
function roiOption(v) {
	if (!v || v === "0") return undefined;
	const [shape, ...rest] = String(v).split(","),
		b = /^box(\d*)$/.exec(shape),
		o = b ? { box: b[1] === "" ? 50 : Number(b[1]) } : Number(shape) > 0 ? { radius: Number(shape) } : null;
	if (!o) return undefined;
	for (const t of rest) if (/^m\d+$/.test(t)) o.merchant = Number(t.slice(1));
	return o;
}

class Sim {
	constructor(clock, hub, env, server, o) {
		Object.assign(this, { clock, hub, env, server, clients: [], seed: o.seed, latencyRange: o.latencyRange });
		this.nextId = 1;
		this.halted = null; // the reason sim.halt() was given: a signal name, "dashboard", "failed"...
		this.failed = null; // why the run failed (sim.fail())
		this.storage = {}; // account -> its pages' localStorage entries (writeStorage)
	}
	/** An account's browser storage (a setup's accounts.<k>.storage, steering): localStorage entries ({ <key>: <text>,
	 * null: removed }) into its pages' storage now and the ones it opens later. The single-thread Sim's pages share one
	 * storage, every account's (a same-origin browser profile) */
	writeStorage(account, entries) {
		const kept = (this.storage[account] ||= {});
		for (const [k, v] of Object.entries(entries)) v === null ? delete kept[k] : (kept[k] = v);
		putStorage((this.env.localStorage ||= makeStorage()), entries);
	}
	/** Stop early: run() returns after the current event (ThreadedSim: at the next game minute), until() stops waiting.
	 * The first reason wins. */
	halt(reason) {
		this.halted ||= String(reason ?? "halt");
	}
	/** A run that can't go on (its CODE asked for a slot the setup doesn't give): halted like halt(), and it ends "failed"
	 * (close()); the first reason wins. */
	fail(reason) {
		if (!this.failed) console.error(`[sim] failed: ${reason}`);
		this.failed ||= String(reason);
		this.halt("failed");
	}
	/** Insert a user + character like create_character_api does. `over` is merged into the character (level, info.items,
	 * info.map/x/y...); an item of over.info.slots replaces the starter's in its slot whole (none of its fields, such as gift),
	 * over.info.cx the class's cosmetics whole. */
	createCharacter({ name, type = "warrior", look = 0, over = {}, account, user: userOver }) {
		const S = this.server,
			G = S.G,
			db = this.env.db,
			kind = this.env.kindOf,
			now = new Date(this.clock.nowMs());
		// `account`: characters with the same key share one user (as on live: one account, several characters)
		this.accounts ||= new Map();
		const shared = account != null ? this.accounts.get(account) : null;
		const n = this.nextId++,
			user_id = shared ? shared.user_id : "US_sim" + n,
			auth = shared ? shared.auth : "simauth" + n,
			cid = "CH_sim" + n + name.toLowerCase();
		const base = G.classes[type],
			spawn = G.maps.main.spawns[0];
		const character = {
			_id: cid, created: now, updated: now, a_rand: 0.5, realm: "main", name, type, level: 1, worth: 0, xp: 0, owner: user_id, referrer: "", platform: "", pid: "",
			online: false, server: "", guild: "", friends: [], last_sync: now, last_online: now, to_backup: false, popularity: 0, private: false, blobs: ["info"],
			info: {
				characterth: n, name, gold: 0, items: [{ name: "hpot0", q: 200, gift: 1 }, { name: "mpot0", q: 200, gift: 1 }],
				slots: { ...JSON.parse(JSON.stringify(base.base_slots || {})), helmet: { name: "helmet", level: 0, gift: 1 }, shoes: { name: "shoes", level: 0, gift: 1 } },
				stats: {}, skin: base.looks[look][0], cx: base.looks[look][1], map: "main", in: "main", x: spawn[0], y: spawn[1],
			},
		};
		const { slots, cx, ...info } = over.info || {};
		deepMerge(character, { ...over, info });
		if (slots) Object.assign(character.info.slots, JSON.parse(JSON.stringify(slots)));
		if (cx) character.info.cx = JSON.parse(JSON.stringify(cx));
		const entry = { id: cid, name, type, level: character.level };
		const user = shared
			? shared.user
			: {
				_id: user_id, name, created: now, updated: now, cash: 0, pid: "", referrer: "", friends: [], guild: "", server: "", blobs: ["info"],
				// as api.js signs a user up: 1000 gold and the two free bank packs
				info: { auths: [auth], gold: 1000, items0: [], items1: [], characters: [], slots: 8, email: user_id + "@sim.local" },
			};
		user.info.characters.push(entry);
		if (userOver) deepMerge(user, userOver);   // e.g. { info: { gold, items0: [...] } }: the bank
		if (account != null && !shared) this.accounts.set(account, { user_id, auth, user });
		db.collection(kind(user_id)).store.set(user_id, structuredClone(user));
		db.collection(kind(cid)).store.set(cid, structuredClone(character));
		const mark = "MK_character-" + name.toLowerCase();
		db.collection(kind(mark)).store.set(mark, { _id: mark, type: "character", phrase: name.toLowerCase(), owner: cid, created: now });
		return { user_id, auth, character: cid, name };
	}
	/** Log a character in (a new one, or fx: one createCharacter made) and run `code` unmodified once it enters the game. */
	addCharacter({ name, type, over, code, fps = 60, api, account, user, files, fx: made, ip }) {
		const fx = made || this.createCharacter({ name, type, over, account, user });
		const state = startClient(this.env, clientInfo(this.server), { ...fx, code, fps, api, files, ip, onFatal: (msg) => this.fail(msg) });
		const c = { name, state, game: state.game, query: async (expr) => state.query(expr), get runner() { return state.runner; }, get errors() { return state.errors; } };
		this.clients.push(c);
		return c;
	}
	async run(ms, o = {}) {
		if (this.halted) return { virtualMs: 0, realMs: 0, speed: 0, events: 0, halted: true };
		const stop = o.stop ? () => !!this.halted || o.stop() : () => !!this.halted;
		return { ...(await this.clock.run({ forMs: ms, ...o, stop })), halted: !!this.halted };
	}
	/** Advance until `pred()` (may be async) is truthy (or halted). */
	async until(pred, maxMs = 120000, stepMs = 250) {
		const t0 = this.clock.now;
		while (!this.halted && !(await pred()) && this.clock.now - t0 < maxMs) await this.run(stepMs);
		return !!(await pred());
	}
	async close() {
		if (this.live) this.live.close(this.failed ? { reason: "failed", detail: this.failed } : this.halted ? { reason: "stopped", detail: this.halted } : this.ended ? { reason: "complete", detail: this.ended } : { reason: "complete" });
		haltOnSignals(this, false);
	}
}

// The lockstep window: at most the minimum latency (the lookahead), and a whole divisor of a game minute (chunks and
// windows end on the same ms, window times stay exact): the largest whole ms that divides 60000, else 1/2^n ms
function lockstepWindow(lo) {
	for (let d = Math.floor(lo); d >= 1; d--) if (60_000 % d === 0) return d;
	let w = 0.5;
	while (w > lo) w /= 2;
	return w;
}

/**
 * Lockstep, one thread per character. Nothing a client does reaches the server sooner than the minimum latency
 * (and vice versa), so each thread runs ahead on its own and only waits when another thread could still send it
 * something that arrives before its next event (see Gate). Deliveries are ordered by sender and send order, never by
 * when a thread took them in: deterministic for a given seed.
 * Each thread still walks through the same windows of that length as before (a microtask drain at each window start):
 * the same results as a window-by-window lockstep.
 */
class ThreadedSim extends Sim {
	constructor(...a) {
		super(...a);
		this.W = lockstepWindow(this.latencyRange[0]);
		// Busy-wait up to this many ms before sleeping on a futex: a sleeping thread takes ~0.1-1ms to wake up (VMs).
		// Burns the waiting thread's core, so only when there are cores to spare.
		this.spin = require("node:os").cpus().length >= 4 ? Number(process.env.CHRONAL_SPIN_MS ?? 0.5) : 0;
		if (!(this.W > 0)) throw new Error("[sim] threads mode needs a minimum latency > 0");
		this.workers = [];
		// Every reply bumps this counter too, so the main thread can sleep until any client thread replies.
		this.any = new Int32Array(new SharedArrayBuffer(4));
		// Progress of every thread (slot 0: the server, then one per client thread).
		this.shared = Gate.buffer();
		const ws = this.workers;
		this.gate = new Gate({
			shared: this.shared, self: 0, peers: [], L: this.W, spin: this.spin,
			flush: () => {
				for (const w of ws) if (w.peer.out.length) w.data.postMessage(w.peer.take());
			},
			receive: () => {
				for (const w of ws) for (let m; (m = receiveMessageOnPort(w.data)); ) w.peer.receive(m.message);
			},
			// a client thread that replied before reaching the end of the run failed
			check: () => {
				for (const w of ws) if (!w.dead && w.idle() && this.gate.read(w.index + 1) < this.end) throw new Error(`[sim] client thread ${w.name} stopped: ${w.reply().err || "?"}`);
			},
		});
		this.gate.init(0, this.clock.now);
		// what the server sends between runs goes with the window that just ended (as a window-by-window lockstep had it)
		this.hub.window = this.clock.now;
		// Character switching (start_character, stop_character, command_character; a page's own disconnect): the pages'
		// requests arrive as messages (hub.onRequest) and are served at the next window boundary, where a character
		// logs in (a new client thread) or out (its sockets close, its thread ends at the end of the game minute)
		this.offline = new Map(); // name -> a created character not in game: { fx, name, type, account, fps, codeOf, owned }
		this.requests = [];
		this.leaving = []; // [worker, reason]: left in this game minute (onLeave, then the thread ends)
		this.reloads = []; // { at, w }: a page the server disconnected, loading again
		this.hub.onRequest = (peer, data) => this.requests.push({ w: peer.w, data });
		this.onLeave = null; // (client, reason): a character is about to leave (its thread still answers queries)
	}
	addCharacter({ name, type, over, code, fps = 60, account, user, files, owned, codeOf, fx: made, ip }) {
		const fx = made || this.createCharacter({ name, type, over, account, user });
		return this.login(fx, { name, type, account, code, fps, files, owned, codeOf, ip });
	}
	/** Create a character (as addCharacter) that stays out of the game until CODE starts it (start_character).
	 * codeOf(slot) -> { code, files } for the slot start_character names ("": its own entry), or null: none such. */
	declare({ name, type, over, account, user, fps = 60, codeOf, owned, ip }) {
		const fx = this.createCharacter({ name, type, over, account, user });
		this.offline.set(name, { fx, name, type, account, fps, codeOf, owned, ip });
	}
	/** Log a created character in: its client thread from now (a window boundary while running). codeOf: as declare's,
	 * for a start_character after it left (none: it can't be started again) */
	login(fx, { name, type, account, code, fps = 60, files, owned, byPage = null, codeOf = null, ip = null }) {
		const { port1, port2 } = new MessageChannel(),
			data = new MessageChannel();
		// Shared control block: i32[0] go, i32[1] done, i32[2] kind (0 run to f64[2], 2 command posted), f64[3] busy ms.
		const ctrl = new SharedArrayBuffer(32);
		const index = this.workers.length;
		const modes = this.live ? new MessageChannel() : null; // LIVE: the thread's time per CODE mode (live.js)
		this.gate.init(index + 1, this.clock.now);
		const thread = new Worker(path.join(__dirname, "client_worker.js"), {
			workerData: { storage: this.storage[account] || {}, rec: this.recDir ? { dir: this.recDir, name } : null, root: this.env.root, start: this.clock.now, seed: this.seed * 1009 + index + 1, info: clientInfo(this.server), latencyRange: this.latencyRange, W: this.W, fixture: fx, code, fps, files, owned, byPage: !!byPage, ctrl, any: this.any.buffer, port: port2, data: data.port2, shared: this.shared, slot: index + 1, spin: this.spin, modes: modes && modes.port2 },
			transferList: [port2, data.port2, ...(modes ? [modes.port2] : [])],
		});
		const i32 = new Int32Array(ctrl),
			f64 = new Float64Array(ctrl);
		// done: replies expected so far (the thread replies once when it's ready)
		const w = { index, name, type, account, fx, thread, port: port1, data: data.port1, modes: modes && modes.port1, ctrl: i32, done: 1, peer: new RemotePeer(this.hub, index), parent: byPage, children: new Set(), dead: false };
		w.peer.w = w;
		w.peer.ip = ip; // (its account's address: fake_io.js ServerSocket)
		w.decl = { fx, name, type, account, fps, codeOf, owned, ip };
		Object.assign(w, { code, files, fps, owned });
		w.peer.onClose = (peer) => this.requests.push({ w, data: { op: "closed" } });
		const go = (kind) => (++w.done, Atomics.store(i32, 2, kind), Atomics.add(i32, 0, 1), Atomics.notify(i32, 0));
		w.run = (end) => ((f64[2] = end), go(0));
		w.cmd = (msg) => (port1.postMessage(msg), go(2));
		w.idle = () => Atomics.load(i32, 1) >= w.done;
		// every reply is posted before it's counted and carries its number: one missing or out of order is an error, not a hang
		w.reply = () => {
			const m = receiveMessageOnPort(port1);
			if (!m || m.message.n !== w.done) throw new Error(`[sim] client thread ${name}: expected reply ${w.done}, got ${m ? m.message.n : "none"}`);
			return m.message;
		};
		w.wait = () => {
			this.waitFor(() => w.idle());
			return w.reply();
		};
		const ready = w.wait();
		if (ready.err) throw new Error(`[sim] client thread ${name} failed to start:\n${ready.err}`);
		this.workers.push(w);
		this.gate.peers.push(index + 1);
		this.gate.bound = Math.min(this.gate.bound, this.clock.now + this.W); // it may send from now on
		const querySync = (expr) => {
			if (w.stopped) throw new Error(`[sim] ${name} is not in game`);
			w.cmd({ t: "q", expr });
			const r = w.wait();
			if (r.err) throw new Error(r.err);
			return r.value;
		};
		const c = {
			name,
			get online() { return !w.dead; },
			querySync,
			query: async (expr) => querySync(expr),
		};
		w.client = c;
		this.clients.push(c);
		// logged in while running (a window boundary): it runs to the end of this game minute with the others
		if (this.end > this.clock.now) w.run(this.end);
		return c;
	}

	// ---------- character switching -------------------------------------------------------
	/** Serve the pages' requests (at a window boundary: now) */
	serveRequests() {
		const list = this.requests;
		this.requests = [];
		for (const { w, data } of list) {
			if (!w || w.dead) continue;
			const op = data && data.op;
			if (op === "start") this.startFor(w, String(data.name), data.slot == null ? "" : String(data.slot));
			else if (op === "in_game") w.parent && this.notify(this.named(w.parent), { op: "started", name: w.name });
			else if (op === "stop") w.children.has(data.name) && this.leave(this.named(data.name), "stopped");
			else if (op === "eval") {
				const t = w.children.has(data.name) && this.named(data.name);
				if (t) this.notify(t, { op: "eval", snippet: String(data.snippet) });
			} else if (op === "closed") {
				// the server closed this page's last socket (its CODE's disconnect(), a limit): the page reloads, as the
				// game's does (game.js disconnect(): a page loaded for its character retries in 2500 ms; auto_reload is
				// "off" in the sim's page) - the same character with the same CODE in a new page, in the same iframe
				if (![...w.peer.sockets.values()].some((s) => s.connected)) {
					this.leave(w, "disconnected", true);
					this.reloads.push({ at: this.clock.now + 2500, w });
				}
			}
		}
		// pages loading again (an iframe's only while its page is still there)
		const due = this.reloads.filter((r) => r.at <= this.clock.now);
		if (due.length) this.reloads = this.reloads.filter((r) => r.at > this.clock.now);
		for (const { w } of due) {
			const p = w.parent && this.named(w.parent);
			if (w.parent && !(p && p.children.has(w.name))) {
				this.offline.set(w.name, w.decl);
				continue;
			}
			this.offline.delete(w.name);
			this.login(w.fx, { name: w.name, type: w.type, account: w.account, code: w.code, fps: w.fps, files: w.files, owned: w.owned, byPage: w.parent, codeOf: w.decl.codeOf, ip: w.decl.ip });
		}
	}
	named(name) {
		return this.workers.find((x) => !x.dead && x.name === name) || null;
	}
	/** writeStorage: here each client thread has its page's own storage, its account's (a page that reloads or starts
	 * later: the account's as written so far; what its CODE set itself stays in its old page) */
	writeStorage(account, entries) {
		const kept = (this.storage[account] ||= {});
		for (const [k, v] of Object.entries(entries)) v === null ? delete kept[k] : (kept[k] = v);
		for (const w of this.workers) if (!w.dead && !w.stopped && w.account === account) w.client.querySync(`(function (e) { for (var k in e) e[k] === null ? localStorage.removeItem(k) : localStorage.setItem(k, e[k]); return 1; })(${JSON.stringify(entries)})`);
	}
	notify(w, data) {
		if (!w || w.dead) return;
		this.replyLink ||= new Link(this.hub);
		w.peer.send(this.replyLink.nextTime(), "r", 0, data);
	}
	// start_character(name, slot) from w's page: a character of w's account, not in game, with the CODE of that slot
	startFor(w, name, slot) {
		const fail = (reason, message) => this.notify(w, { op: "failed", name, reason, message: message || reason });
		const d = this.offline.get(name);
		if (!d || d.account !== w.account) return this.named(name) ? fail("already_running") : fail("character_not_found");
		const got = d.codeOf ? d.codeOf(slot) : null;
		if (!got) {
			if (d.codeOf) this.fail(`${w.name}: start_character(${JSON.stringify(name)}, ${JSON.stringify(slot)}): the setup gives ${name} no slot ${slot}`);
			return fail("start_failed", `no code slot ${slot}`);
		}
		this.offline.delete(name);
		w.children.add(name);
		this.login(d.fx, { name, type: d.type, account: d.account, code: got.code, fps: d.fps, files: got.files, owned: d.owned, byPage: w.name, codeOf: d.codeOf, ip: d.ip });
	}
	/** A character leaves: its page (and the pages it started) close as a closed tab; the thread ends with this game minute.
	 * reload: its page loads again (the server disconnected it): its page above keeps its iframe */
	leave(w, reason, reload = false) {
		if (!w || w.dead) return;
		for (const n of [...w.children]) this.leave(this.named(n), "stopped");
		this.leaving.push([w, reason]);
		w.dead = true;
		w.leftAt = this.clock.now;
		w.peer.dead = true;
		// (in the next window: the server's disconnect handling runs as a clock event)
		const open = [...w.peer.sockets.values()].filter((s) => s.connected);
		if (open.length) this.clock.at(this.clock.now, () => open.forEach((s) => s._onclose("transport close")), "page closed");
		this.gate.peers = this.gate.peers.filter((x) => x !== w.index + 1);
		this.gate.init(w.index + 1, Infinity);
		const p = w.parent && this.named(w.parent);
		if (reload) return; // (in the same iframe; reloads puts it back in game)
		if (p) p.children.delete(w.name), this.notify(p, { op: "gone", name: w.name, reason });
		this.offline.set(w.name, w.decl); // it can be started again (once the server has let it go)
	}
	/** Block until `check()` (re-checked after every client reply). */
	waitFor(check, timeoutMs = 120000) {
		const any = this.any,
			t0 = Date.now();
		for (;;) {
			const seen = Atomics.load(any, 0);
			if (check()) return;
			if (this.spin) spinWhile(any, 0, seen, this.spin);
			if (Atomics.load(any, 0) === seen && Atomics.wait(any, 0, seen, 1000) === "timed-out" && Date.now() - t0 > timeoutMs) throw new Error("[sim] a client thread stopped responding");
		}
	}
	/**
	 * Advance `ms` in chunks of a game minute on the window grid (the same windows as in one go): the event loop turns
	 * in between (signal handlers, the dashboard's stop request), and sim.halt() ends the run at the next chunk.
	 */
	async run(ms) {
		const end = this.clock.now + ms,
			v0 = this.clock.now,
			e0 = this.clock.events,
			r0 = performance.now(),
			chunk = this.W * Math.round(60_000 / this.W);
		while (this.clock.now < end) {
			await new Promise(setImmediate);
			if (this.halted) break;
			await this.runChunk(Math.min(this.clock.now + chunk, end));
		}
		const realMs = performance.now() - r0,
			virtualMs = this.clock.now - v0;
		return { virtualMs, realMs, speed: virtualMs / Math.max(realMs, 1e-9), events: this.clock.events - e0, halted: !!this.halted };
	}
	async runChunk(end) {
		const ws = this.workers,
			gate = this.gate;
		// busy ms, added per window so live snapshots see it during a long run
		let b0 = performance.now(),
			waited = gate.waited;
		const busy = () => {
			const now = performance.now();
			this.serverBusy = (this.serverBusy || 0) + now - b0 - (gate.waited - waited);
			(b0 = now), (waited = gate.waited);
		};
		this.end = end;
		for (const w of ws) if (!w.stopped) w.run(end);
		// runSync needs a macrotask (this may be a promise continuation)
		await new Promise((resolve, reject) =>
			setImmediate(() => {
				try {
					for (let until = Math.min(this.clock.now + this.W, end); ; until = Math.min(until + this.W, end)) {
						this.hub.window = until;
						this.clock.runSync({ before: until, gate });
						this.clock.mark(until); // the clients' messages sent in this window sort here
						if (this.requests.length || this.reloads.length) this.serveRequests();
						busy();
						if (this.live) this.live.tick(b0); // b0: this window's performance.now()
						if (until >= end) break;
					}
					resolve();
				} catch (e) {
					reject(e);
				}
			}),
		);
		gate.publish(end);
		busy();
		this.waitFor(() => ws.every((w) => w.stopped || w.idle()));
		for (const w of ws) {
			if (w.stopped) continue;
			const r = w.reply();
			if (r.err) console.error(`[sim ${w.name}]`, r.err);
			if (r.fatal) this.fail(r.fatal);
		}
		gate.receive();
		// the threads of characters that left: the runner reads them one last time (onLeave), then they end
		for (const [w, reason] of this.leaving.splice(0)) {
			if (this.onLeave)
				try {
					this.onLeave(w.client, reason);
				} catch (e) {
					console.error(`[sim] onLeave ${w.name}:`, e.message);
				}
			(w.stopped = true), w.cmd({ t: "stop" }), w.wait(), w.thread.terminate();
		}
	}
	/** Busy ms per thread since the start: { server, <name>: ms } (compare with the wall clock: the busiest thread is the limit). */
	busy() {
		const out = { server: this.serverBusy || 0 };
		for (const w of this.workers) out[w.name] = (out[w.name] || 0) + new Float64Array(w.ctrl.buffer)[3]; // (a character in game twice: both threads)
		return out;
	}
	/** Start (true) / stop (false) a CPU profile on every thread; stop returns { server, <name>: profile }. */
	async profile(on) {
		const out = {};
		for (const w of this.workers) {
			if (w.stopped) continue;
			w.cmd({ t: "prof", on });
			const r = w.wait();
			if (r.err) throw new Error(r.err);
			if (!on) out[w.name] = JSON.parse(r.value);
		}
		const inspector = require("node:inspector");
		const post = (m, p) => new Promise((res, rej) => this._ps.post(m, p || {}, (e, r) => (e ? rej(e) : res(r))));
		if (on) {
			this._ps = new inspector.Session();
			this._ps.connect();
			await post("Profiler.enable");
			await post("Profiler.setSamplingInterval", { interval: 250 });
			await post("Profiler.start");
		} else {
			out.server = (await post("Profiler.stop")).profile;
			this._ps.disconnect();
		}
		return out;
	}
	async close() {
		await super.close();
		for (const w of this.workers) if (!w.stopped) w.cmd({ t: "stop" }), w.wait(), await w.thread.terminate();
	}
}

function deepMerge(a, b) {
	for (const [k, v] of Object.entries(b)) {
		if (v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date) && a[k] && typeof a[k] === "object") deepMerge(a[k], v);
		else a[k] = v;
	}
	return a;
}

// The server's upgrade grace (S.ugrace: per level 0-24, the level an upgrade goes to; a new realm starts at 24 each,
// a live one carries what its players' upgrades made of it): v (null: as it is; a number; a list; { <level>: n }), and
// fixed: its levels held (a failed or successful upgrade moves nothing; plain values for the server's saves)
function setUgrace(server, v, fixed) {
	const S = server.S,
		cur = (S && S.ugrace) || Array(25).fill(24),
		vals = Array.from({ length: 25 }, (_, i) => (v == null ? cur[i] : typeof v === "number" ? v : Array.isArray(v) ? v[i] ?? cur[i] : v[i] ?? cur[i]));
	if (!fixed) return void (S.ugrace = vals);
	const held = [];
	for (let i = 0; i < 25; i++) Object.defineProperty(held, i, { get: () => vals[i], set() {}, enumerable: true });
	S.ugrace = held;
}

module.exports = { createSim, roiOption, lockstepWindow, setUgrace };
