"use strict";
// startSetup(): a resolved setup (setup.js resolveSetup) into a new sim, in a fixed call order: createSim, the world's
// age (world.age: the clock runs that long with no characters, as a server up that long that nobody played on: its
// monsters level up), each character in setup order (the account's user doc, i.e. its bank, with its first character;
// its browser storage before its first page), the account age, then the pages in setup order (at most 5 not in game
// at once) until every character is in game with its CODE running. steerer(): the setup's steering at its times.
const { createSim, roiOption } = require("./sim");
const { config } = require("../lib/config");
const { characterOver, accountUser, ageOf, parseDuration, storageEntries, steerText } = require("../lib/setup");
const { modeExpr } = require("./report");

/**
 * @param {object} resolved  resolveSetup(...).resolved
 * @param {object} bundles   resolveSetup(...).bundles: { <name>: { text, files } }
 * @param {object} [o] live: createSim's option ({ dir, tag, every, setup: { resolved, bundles, from } }: on; false or
 *   unset: off); record: createSim's; quiet; root (default config().al_root)
 * @returns {Promise<{ sim, clients: { [name]: client }, order: client[] }>}
 */
async function startSetup(resolved, bundles, { live, record, quiet, root, signals } = {}) {
	const run = resolved.run,
		world = resolved.world;
	const sim = await createSim({ root: root || config().al_root, seed: run.seed, threads: world.threads !== false, ping: world.ping, roi: roiOption(world.roi == null ? undefined : String(world.roi)), quiet, live, record, signals, ...(world.start ? { start: Date.parse(world.start) } : {}), seasons: (world.seasons || []).filter((x) => typeof x === "string" || x.from == null).map((x) => (typeof x === "string" ? x : x.season)), anniversary: world.anniversary !== false, ugrace: world.ugrace ?? null, ugrace_fixed: !!world.ugrace_fixed });
	// a custom world (world.spawns): its monsters in the server before anything runs (sim/world_spawns.js)
	if (world.spawns && world.spawns.length) sim.spawns = require("./world_spawns").spawnAll(sim.server, sim.clock, world.spawns);
	// world.age: nobody in game yet (0: nothing runs, the run as before); a halt ends it early (at the next game minute)
	const age = parseDuration(world.age ?? 0) || 0;
	if (age) {
		const t0 = sim.clock.now;
		await sim.run(age);
		if (sim.live) sim.live.aged(sim.clock.now - t0);
	}
	const seen = new Set(),
		logins = [];
	// each account's IP: "local" (the default) the run's own, 127.0.0.1; every other label its own 10.1.0.<n>, in the order
	// they first come (the server's per-IP limits and its is_same(): trade xp, the send-gold fee, aggro, pvp)
	const ips = new Map([["local", "127.0.0.1"]]),
		ipOf = (acc) => {
			const l = (resolved.accounts[acc] && resolved.accounts[acc].ip) || "local";
			if (!ips.has(l)) ips.set(l, "10.1.0." + ips.size);
			return ips.get(l);
		};
	// the account's characters as a page loads them (what start_character may start)
	const owned = (acc) => resolved.characters.filter((x) => x.account === acc).map((x) => ({ name: x.name, type: x.class, level: x.state ? x.state.level : 1, online: x.online !== false }));
	for (const c of resolved.characters) {
		const b = bundles[c.name],
			first = !seen.has(c.account);
		seen.add(c.account);
		if (first) sim.writeStorage(c.account, storageEntries(resolved.accounts[c.account]));
		const o = { name: c.name, type: c.class, account: c.account, fps: c.fps, over: characterOver(c), owned: owned(c.account), ip: ipOf(c.account), ...(first ? { user: accountUser(resolved.accounts[c.account]) } : {}) };
		// online: false: created on its account, in game once a page of the account starts it (start_character)
		if (c.online === false) {
			if (!sim.declare) throw new Error(`${c.name}: online: false needs threads mode (world.threads)`);
			sim.declare({ ...o, codeOf: slotOf(b) });
			continue;
		}
		const { over, user, ...rest } = o; // (rest: the login's, ip in)
		logins.push({ ...rest, fx: sim.createCharacter({ name: c.name, type: c.class, over, account: c.account, user }), code: b.text, files: b.files, codeOf: slotOf(b) });
	}
	// before any character logs in: a linked account (Steam, MAS) has its pid on the user and its characters as the
	// game's update_pids leaves them (its logins get an auth id: the Newcomers' Blessing's check, the per-IP
	// allowance; "claimed": the auth mark exists, so no blessing); an account age_days old: the user and its characters
	// created then, and the age each character keeps (info.p.encouragement, as live saves it, grouped by pid if linked)
	for (const [k, a] of Object.entries(resolved.accounts)) {
		const age = ageOf(a, sim.clock.nowMs()),
			acc = sim.accounts && sim.accounts.get(k),
			L = a.linked;
		if (!acc || (!age && !L)) continue;
		const db = (id) => sim.env.db.collection(sim.env.kindOf(id)).store,
			doc = (id) => db(id).get(id),
			user = doc(acc.user_id);
		if (L) {
			Object.assign(user, { pid: L.pid, platform: L.platform });
			for (const e of user.info.characters) Object.assign(doc(e.id), { pid: L.pid, platform: L.platform }), ((doc(e.id).info.p ||= {})[L.platform === "steam" ? "steam_id" : "mas_auth_id"] = L.pid);
			const mark = "MK_auth-" + L.pid;
			if (L.newcomer === "claimed") db(mark).set(mark, { _id: mark, type: "auth", phrase: L.pid, owner: acc.user_id, created: new Date(sim.clock.nowMs()) });
		}
		if (!age) continue;
		user.created = new Date(age.created);
		for (const e of user.info.characters) {
			const ch = doc(e.id);
			(ch.info.p ||= {}).encouragement = { group: L ? "pid:" + L.pid : "owner:" + acc.user_id, oldest: age.oldest, return_until: 0 };
			ch.created = new Date(age.created);
		}
	}
	// the pages log in in setup order, at most 5 at a time not in game yet: the server disconnects every other page of an
	// IP once more than 5 of its sockets have no character (server.js is_socket_allowed), as a browser's pages load
	// one after another on live. The page in game now of each name (a page the server disconnected loads again as a new
	// client).
	const cur = (name) => sim.clients.findLast((x) => x.name === name && x.online !== false) || null;
	const pending = async () => {
		let n = 0;
		for (const l of logins) if (l.in && !(cur(l.name) && (await cur(l.name).query("!!character")))) n++;
		return n;
	};
	for (const l of logins) {
		if ((await pending()) >= 5) await sim.until(async () => sim.halted || (await pending()) < 5, 60000);
		const { in: _, ...o } = l;
		sim.addCharacter(o);
		l.in = true;
	}
	const ok = await sim.until(async () => {
		for (const l of logins) {
			const c = cur(l.name);
			if (!(c && (await c.query("!!(character && code_active)")))) return false;
		}
		return true;
	}, 60000);
	// failed (a CODE asked for a slot the setup doesn't give): ended "failed" here; halted (a signal, the dashboard): the caller stops
	if (sim.failed) {
		await sim.close();
		throw new Error(sim.failed);
	}
	if (!ok && !sim.halted) throw new Error(`the characters of "${resolved.name}" didn't get into the game`);
	const order = logins.map((l) => cur(l.name)).filter(Boolean);
	return { sim, clients: Object.fromEntries(order.map((c) => [c.name, c])), order };
}

// the query that runs a steering entry's code in a character's CODE (the game's call_code_function("eval"), as
// command_character's snippet): null, else why it didn't run
const STEER_CODE = (code) => `(function (s) { if (!window.code_active) return "its CODE is not running"; try { get_code_function("eval")(s); return null; } catch (e) { return String((e && e.message) || e); } })(${JSON.stringify(code)})`;

/**
 * The setup's steering (resolved.steer, steer.js Steering) and run.until on a started sim. run(ms, { untilT0 }) advances
 * ms of game time as sim.run does, stopping at each step's time (game time since start(): the characters in game) and,
 * while a condition waits (a when step, run.until), every run.check (1 s by default) to check them against the run's snapshot now
 * (live.js peek(); a page read or the server's monsters only when a condition asks), to apply each step that fires: its
 * storage into its character's account's storage (none: every account's), its code in its character's CODE (none: every
 * character in game). Each applied ({ i, name, why, at, character, what, note, did, errors }) goes to the snapshot
 * (live.js steered) and to log. With untilT0 (the measured part's start: its t counts from there), run.until is checked
 * too, and ends run() early when it holds (until: true).
 * -> { start(), run(ms, o) -> { virtualMs, realMs, speed, halted, until }, done, steering }
 */
function steerer(sim, resolved, { log = () => {}, exportState = null } = {}) {
	const X = require("../lib/steer"),
		S = new X.Steering(resolved.steer || [], { until: resolved.run && resolved.run.until, check: resolved.run && resolved.run.check }),
		refs = S.refs,
		grid = sim.W || 1,
		done = [],
		accountOf = new Map(resolved.characters.map((c) => [c.name, c.account])),
		starts = Object.fromEntries(resolved.characters.map((c) => [c.name, { level: c.state && c.state.level, xp: c.state && c.state.xp, gold: c.state && c.state.gold, map: c.at && c.at.map }])),
		logs = {},
		logAt = new Map(); // client -> game log lines read
	if ((S.waiting(true) || refs.chars.length) && !sim.live) throw new Error("run.until and steering conditions read the run's snapshot: they need live snapshots (not --no-live)");
	for (const s of S.steps) s.ms = Math.round(s.ms / grid) * grid;
	let t0 = null,
		nextCheck = 0; // (ms since the start)
	const inGame = (name) => sim.clients.findLast((c) => c.name === name && c.online !== false) || null;
	// the context now: the snapshot, and what the conditions ask of the pages and the server
	async function context() {
		const snap = sim.live.peek(),
			pages = {},
			q = { near: refs.near, get: refs.get };
		let events = {};
		for (const n of refs.chars) {
			const c = inGame(n);
			if (!c) continue;
			if (refs.near || refs.get.length) pages[n] = await c.query(X.PAGE_READ(q));
			if (refs.log) {
				const i = logAt.get(c) || 0,
					lines = await c.query(`(window.game_logs || []).slice(${i}).map(function (l) { return String(l[0]); })`);
				logAt.set(c, i + lines.length);
				(logs[n] ||= []).push(...lines);
			}
		}
		if (refs.events) {
			const c = resolved.characters.map((x) => inGame(x.name)).find(Boolean);
			if (c) events = (await c.query(X.PAGE_READ({ events: true }))).events || {};
		}
		return X.contextOf(snap, { names: resolved.characters.map((c) => c.name), accountOf: (n) => accountOf.get(n), t: snap.measured_ms / 1000, pages, logs, events, starts, server: refs.server ? X.serverRead(sim.server.instances) : null });
	}
	async function apply(s, why) {
		const e = s.e,
			who = e.character ? [e.character] : resolved.characters.map((c) => c.name),
			out = { i: s.i, ...(s.name ? { name: s.name } : {}), why, at: e.at ?? null, character: e.character || null, what: steerText(e), ...(e.note ? { note: e.note } : {}), did: [], errors: [] };
		S.fired(s, sim.clock.now - t0);
		const st = storageEntries(e);
		if (Object.keys(st).length)
			for (const k of new Set(resolved.characters.filter((c) => who.includes(c.name)).map((c) => c.account))) sim.writeStorage(k, st), out.did.push(`storage ${k}`);
		if (e.code != null)
			for (const n of who) {
				const c = inGame(n),
					no = c ? await c.query(STEER_CODE(e.code)) : "not in game";
				if (no) out.errors.push(`${n}: ${no}`);
				else out.did.push(`code ${n}`);
			}
		if (e.export != null) {
			const dir = exportState ? await exportState(e.export) : null;
			if (dir) out.did.push(`export ${e.export}`);
			else out.errors.push("export: no state dir (--no-export)");
		}
		if (sim.live) sim.live.steered(out);
		done.push(out);
		log(out);
	}
	return {
		done,
		steering: S,
		start() {
			t0 = sim.clock.now;
		},
		async run(ms, { untilT0 = null } = {}) {
			const end = sim.clock.now + ms,
				sum = { virtualMs: 0, realMs: 0, speed: 0, halted: false, until: false },
				until = untilT0 != null;
			for (;;) {
				const now = sim.clock.now - t0;
				for (const { s } of S.due(now)) if (!sim.halted) await apply(s, X.whyOf(s.e));
				// the checks: on the run.check grid from the start, each once
				if (S.waiting(until) && now >= nextCheck && !sim.halted) {
					nextCheck = (Math.floor(now / S.checkMs + 1e-9) + 1) * S.checkMs;
					const r = S.check(now, await context(), until ? (sim.clock.now - untilT0) / 1000 : null);
					for (const s of r.fire) await apply(s, X.whyOf(s.e));
					if (r.until) {
						sum.until = true;
						break;
					}
				}
				// an export the dashboard asked for (live.js poll): between chunks, where the pages can be read
				const want = sim.live && sim.live.exportWanted;
				if (want && exportState && !sim.halted) await exportState(want.label);
				else if (want) sim.live.exportWanted = null;
				const next = Math.min(end, t0 + S.next(), S.waiting(until) ? t0 + nextCheck : Infinity);
				if (next <= sim.clock.now || sim.halted) break;
				const r = await sim.run(next - sim.clock.now, { stop: () => !!(sim.live && sim.live.exportWanted) });
				(sum.virtualMs += r.virtualMs), (sum.realMs += r.realMs), (sum.halted = !!r.halted);
				if (r.halted) break;
				if (sim.clock.now < next && !(sim.live && sim.live.exportWanted)) break;
			}
			sum.speed = sum.virtualMs / Math.max(sum.realMs, 1e-9);
			return sum;
		},
	};
}

// start_character(name, slot): the CODE for a slot of the character's own CODE: none ("") or its entry = its composed
// entry (params, extras, appends as the setup gives them), another slot = that slot's text as it is; null = no such slot
function slotOf(b) {
	return (slot) => {
		const k = String(slot || "").toLowerCase();
		if (!k || k === String(b.entry).toLowerCase()) return { code: b.text, files: b.files };
		const hit = Object.keys(b.files).find((n) => n.toLowerCase() === k);
		return hit ? { code: b.files[hit], files: b.files } : null;
	};
}

// What chronal run reads from a client: kills are "You killed a X" alone (in a
// party every member gets "<Name> killed a X" for every member's kill, so each counts only its own); mode: the CODE's
// (report.js modeExpr)
const STAT = `({ l: character.level, xp: character.xp, max: character.max_xp, g: character.gold, map: character.map,
	lw: !!(character.s && character.s.encouragement_lonewolf), np: !!(character.s && character.s.encouragement_new),
	deaths: (window.game_logs || []).filter((x) => /Defeated by/.test(x[0])).length,
	kills: (window.game_logs || []).filter((x) => new RegExp("^(You|" + character.name + ") killed ").test(x[0])).length,
	free: character.esize, hp: (character.items.find((i) => i && i.name == "hpot0") || { q: 0 }).q,
	slots: Object.fromEntries(Object.entries(character.slots).filter(([k, v]) => v && !k.startsWith("trade")).map(([k, v]) => [k, { name: v.name, level: v.level, stat_type: v.stat_type }])),
	mode: ${modeExpr} })`;
// a character's stats and party at the end (chronal run --result fields)
const STATS = `({ name: character.name, ctype: character.ctype, str: character.str, dex: character.dex, int: character.int, vit: character.vit,
	attack: character.attack, frequency: character.frequency, armor: character.armor, resistance: character.resistance, max_hp: character.max_hp, max_mp: character.max_mp,
	speed: character.speed, range: character.range, xpm: character.xpm, goldm: character.goldm, luckm: character.luckm, hp: character.hp,
	party: character.party || null, party_list: parent.party_list || [] })`;

// Total xp across levels (gains that cross a level-up)
function xpTotal(levels, q) {
	let s = q.xp;
	for (let l = 1; l < q.l; l++) s += levels[l] || 0;
	return s;
}

module.exports = { startSetup, steerer, STAT, STATS, xpTotal };
