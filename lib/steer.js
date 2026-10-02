"use strict";
// Steering conditions (docs/reference/setup.md): what a setup's steer `when` and run.until read: the run's own snapshot
// now (sim/live.js peek(): the numbers the dashboard shows), plus what only a character's page sees (monsters in view,
// its storage, its game log, the server's events) and the server's monsters, read only when a condition asks for them.
// Steering: the setup's steps, each at its time (at), once a condition holds (when; for: held that long; repeat: again
// each time it holds anew), or a while after another step fired (after, at: the while). The driver: sim/start.js
// steerer.
const WINDOW = "10m"; // rates' window by default
const ARGS = ["c", "t", "world", "steps", "party"];
const setup = () => require("./setup"); // (setup.js requires this file)

/** A condition (an expression of c.<Name>, party, t, world, steps) as a function of them; throws a SyntaxError */
function compile(expr) {
	return new Function(...ARGS, `return (${expr});`);
}

/** What an expression reads: the characters (c.<Name>), the steps (steps.<name>), and what it needs read besides the
 * snapshot: monsters in view (near, near_level), storage keys (get("k"): literal keys), game log lines (log), the
 * server's events (world.events), the server's monsters (world.alive, world.level), rates */
function refsOf(expr) {
	const e = String(expr);
	return {
		chars: [...new Set([...e.matchAll(/\bc\.([A-Za-z0-9]+)/g)].map((m) => m[1]))],
		steps: [...new Set([...e.matchAll(/\bsteps\.([A-Za-z_]\w*)/g)].map((m) => m[1]))],
		near: /\.near(_level)?\b/.test(e),
		get: [...new Set([...e.matchAll(/\.get\(\s*(["'`])((?:(?!\1).)*)\1\s*\)/g)].map((m) => m[2]))],
		log: /\.log\(/.test(e),
		events: /\bworld\.events\b/.test(e),
		server: /\bworld\.(alive|level)\b/.test(e),
		rate: /\.rate\b/.test(e),
	};
}
// what a condition may read besides its arguments: plain JavaScript
const GLOBALS = new Set(["Math", "Number", "String", "Boolean", "Object", "Array", "JSON", "Date", "RegExp", "isNaN", "isFinite", "parseInt", "parseFloat", "Infinity", "NaN", "undefined"]);
/**
 * What a condition gets wrong that only shows while it runs (where a misspelling reads undefined, so false): a name
 * that is none of c, party, t, world, steps (or plain JavaScript: Math...), and a field c.<Name>, party and world don't
 * have (c.Ran1.kils). Fields under a field (kills.<monster>, status...) are free. -> [problem]; throws a SyntaxError
 */
function lint(expr) {
	const acorn = require("acorn"),
		ast = acorn.parseExpressionAt(String(expr), 0, { ecmaVersion: "latest" }),
		fields = { c: Object.keys(record(null)), party: Object.keys(partyOf({})), world: ["alive", "level", "events"] },
		out = new Set();
	const walk = (n, parent, bound) => {
		if (!n || typeof n.type !== "string") return;
		if (/Function/.test(n.type)) bound = new Set([...bound, ...n.params.flatMap(namesOf)]);
		if (n.type === "Identifier" && !bound.has(n.name) && !ARGS.includes(n.name) && !GLOBALS.has(n.name)) {
			const prop = parent && ((parent.type === "MemberExpression" && parent.property === n && !parent.computed) || (parent.type === "Property" && parent.key === n && !parent.computed));
			if (!prop) out.add(`${n.name} is not something a condition reads (c.<Name>, party, t, world, steps)`);
		}
		// c.<Name>.<field>, party.<field>, world.<field>
		if (n.type === "MemberExpression" && !n.computed && n.property.type === "Identifier") {
			const o = n.object,
				at = (x, name) => x.type === "Identifier" && x.name === name && !bound.has(name);
			const known = (where, f) => (fields[where].includes(f) ? null : `${f} is not a field of ${where === "c" ? "c.<Name>" : where} (${fields[where].join(", ")})`);
			const p = o.type === "MemberExpression" && !o.computed && at(o.object, "c") ? known("c", n.property.name) : at(o, "party") ? known("party", n.property.name) : at(o, "world") ? known("world", n.property.name) : null;
			if (p) out.add(p);
		}
		for (const k in n) {
			const v = n[k];
			if (Array.isArray(v)) v.forEach((x) => walk(x, n, bound));
			else if (v && typeof v.type === "string") walk(v, n, bound);
		}
	};
	const namesOf = (p) => (!p ? [] : p.type === "Identifier" ? [p.name] : p.type === "AssignmentPattern" ? namesOf(p.left) : p.type === "RestElement" ? namesOf(p.argument) : p.type === "ArrayPattern" ? p.elements.flatMap(namesOf) : p.type === "ObjectPattern" ? p.properties.flatMap((q) => namesOf(q.type === "RestElement" ? q.argument : q.value)) : []);
	walk(ast, null, new Set());
	return [...out];
}
// the union of refsOf's
function mergeRefs(list) {
	const out = { chars: new Set(), steps: new Set(), near: false, get: new Set(), log: false, events: false, server: false, rate: false };
	for (const r of list) {
		for (const k of ["chars", "steps", "get"]) for (const x of r[k]) out[k].add(x);
		for (const k of ["near", "log", "events", "server", "rate"]) out[k] ||= r[k];
	}
	return { ...out, chars: [...out.chars], steps: [...out.steps], get: [...out.get] };
}

// a map of counts: a key it doesn't have reads as `none` (0: kills.bee before the first bee)
const counts = (o, none = 0) => new Proxy(o, { get: (t, k) => (typeof k !== "string" || Object.hasOwn(t, k) || k in Object.prototype ? t[k] : none) });
const sum = (o) => Object.values(o || {}).reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
const results = (by) => {
	let ok = 0,
		fail = 0;
	for (const x of Object.values(by || {})) (ok += (x && x.ok) || 0), (fail += (x && x.fail) || 0);
	return { ok, fail, total: ok + fail };
};

/**
 * A character's condition record from its snapshot entry (players[], docs/reference/snapshot.md), counted since the base; one
 * never in game: its start (online false). o: { t (s since the base), bank ({ gold, free } of its account), page (what
 * its page read: near, near_level, get), logs (its game log lines since the run started), start ({ level, xp, gold,
 * map } of one never in game) }
 */
function record(p, o = {}) {
	if (!p) {
		const s = o.start || {};
		p = { online: false, level: s.level ?? 1, start_level: s.level ?? 1, xp: s.xp ?? 0, gold: s.gold ?? 0, gold_start: s.gold ?? 0, map: s.map ?? null };
	}
	const inv = {},
		best = {},
		level = (name, l) => l != null && (best[name] = Math.max(best[name] ?? -1, l));
	for (const it of p.inventory || []) if (it) (inv[it.name] = (inv[it.name] || 0) + (it.q || 1)), level(it.name, it.level);
	for (const g of Object.values(p.gear || {})) {
		const m = /^(.+)\+(\d+)$/.exec(g);
		if (m) level(m[1], +m[2]);
	}
	const it = p.items || {},
		page = o.page || {},
		logs = o.logs || [];
	return {
		name: p.name, class: p.type ?? null, online: p.online !== false, rip: !!p.rip, level: p.level, levels: p.level - (p.start_level ?? p.level), xp: p.xp ?? 0, max_xp: p.max_xp ?? 0, xp_gained: p.xp_gained || 0,
		hp: p.hp ?? null, max_hp: (p.stats && p.stats.max_hp) ?? null, mp: p.mp ?? null, max_mp: (p.stats && p.stats.max_mp) ?? null,
		gold: p.gold ?? 0, gold_gained: (p.gold ?? 0) - (p.gold_start ?? p.gold ?? 0), map: p.map ?? null, x: p.x ?? null, y: p.y ?? null, party: (p.party && p.party.name) || null,
		kills: counts({ ...(p.kills_by || {}), total: p.kills || 0 }), deaths: p.deaths || 0, since_kill: (o.t || 0) - (p.last_kill ?? 0),
		dmg_done: (p.dmg && p.dmg.done && p.dmg.done.net) || 0, dmg_taken: (p.dmg && p.dmg.taken && p.dmg.taken.net) || 0,
		items: counts(inv), free: p.free ?? null, best: counts(best, -1),
		looted: counts({ ...(it.looted || {}), total: sum(it.looted) }), used: counts({ ...(it.consumed || {}) }), drunk: (p.hpots || 0) + (p.mpots || 0),
		upgrades: results(it.upgraded), compounds: results(it.compounded), chests: (p.chests && p.chests.opened) || 0, trips: p.trips || 0,
		bank_free: o.bank ? o.bank.free : null, bank_gold: o.bank ? o.bank.gold : null,
		s: counts(Object.fromEntries((p.s || []).map((k) => [k, true])), false), mode: p.mode ?? null, status: p.code_status ?? null,
		near: counts(page.near || {}), near_level: counts(page.near_level || {}, -1),
		get: (k) => (page.get && Object.hasOwn(page.get, k) ? page.get[k] : null),
		log: (re) => {
			const r = re instanceof RegExp ? re : new RegExp(String(re));
			return logs.filter((l) => r.test(l)).length;
		},
		rate: {},
	};
}

/**
 * The run's characters together (every one of them, the merchant too): their counts summed (kills, deaths, levels and
 * xp gained, gold, bag items and free slots, loot, uses, potions, upgrades, compounds, chests, trips, damage), the
 * highest level of an item, the fewest game s since a kill, how many there are, in game and dead, and each account's
 * bank once (its gold, free slots). rate: their rates summed (check() fills it in)
 */
function partyOf(c, banks = {}, accountOf = null) {
	const rs = Object.values(c),
		n = (f) => rs.reduce((a, r) => a + (typeof r[f] === "number" ? r[f] : 0), 0),
		map = (f) => {
			const out = {};
			for (const r of rs) for (const [k, v] of Object.entries({ ...r[f] })) out[k] = (out[k] || 0) + v;
			return counts(out);
		},
		res = (f) => ({ ok: rs.reduce((a, r) => a + r[f].ok, 0), fail: rs.reduce((a, r) => a + r[f].fail, 0), total: rs.reduce((a, r) => a + r[f].total, 0) }),
		best = {};
	for (const r of rs) for (const [k, v] of Object.entries({ ...r.best })) best[k] = Math.max(best[k] ?? -1, v);
	const accts = [...new Set(rs.map((r) => (accountOf ? accountOf(r.name) : null)))].filter((k) => banks[k]);
	return {
		size: rs.length, online: rs.filter((r) => r.online).length, dead: rs.filter((r) => r.rip).length,
		kills: map("kills"), deaths: n("deaths"), since_kill: rs.length ? Math.min(...rs.map((r) => r.since_kill)) : 0, levels: n("levels"), xp_gained: n("xp_gained"), gold: n("gold"), gold_gained: n("gold_gained"),
		items: map("items"), free: n("free"), best: counts(best, -1), looted: map("looted"), used: map("used"), drunk: n("drunk"),
		upgrades: res("upgrades"), compounds: res("compounds"), chests: n("chests"), trips: n("trips"), dmg_done: n("dmg_done"), dmg_taken: n("dmg_taken"),
		bank_free: accts.reduce((a, k) => a + (banks[k].free || 0), 0), bank_gold: accts.reduce((a, k) => a + (banks[k].gold || 0), 0), rate: {},
	};
}

/**
 * The context of a snapshot now: { c: { <name>: record }, party (partyOf), world: { alive,
 * level, events } }.
 * o: { names: every character of the run, accountOf: name -> account, t (s since the base), pages: { name: page read },
 * logs: { name: [lines] }, server: { alive, level } (serverRead's), events (a page's `S`: the server's events), starts:
 * { name: { level, xp, gold, map } } }
 */
function contextOf(snap, o = {}) {
	const by = new Map(((snap && snap.players) || []).map((p) => [p.name, p])),
		banks = (snap && snap.banks) || {},
		c = {};
	for (const n of new Set([...(o.names || []), ...by.keys()]))
		c[n] = record(by.get(n), { t: o.t, bank: banks[o.accountOf ? o.accountOf(n) : null], page: (o.pages || {})[n], logs: (o.logs || {})[n], start: (o.starts || {})[n] });
	const sv = o.server || {};
	return { c, party: partyOf(c, banks, o.accountOf), world: { alive: counts({ ...(sv.alive || {}) }), level: counts({ ...(sv.level || {}) }, -1), events: counts({ ...(o.events || {}) }, false) } };
}

// what a character's page reads for a condition (run in its game window): the monsters in view by type
// (count, highest level), storage keys (get's: JSON), the server's events (S)
function pageRead(o) {
	const out = {};
	if (o.near) {
		(out.near = {}), (out.near_level = {});
		for (const id in window.entities || {}) {
			const e = entities[id];
			if (!e || e.type !== "monster" || e.dead) continue;
			out.near[e.mtype] = (out.near[e.mtype] || 0) + 1;
			out.near_level[e.mtype] = Math.max(out.near_level[e.mtype] || 0, e.level || 1);
		}
	}
	if (o.get && o.get.length) {
		out.get = {};
		for (const k of o.get)
			try {
				out.get[k] = JSON.parse(localStorage.getItem("cstore_" + k));
			} catch (e) {
				out.get[k] = null;
			}
	}
	if (o.events) out.events = Object.fromEntries(Object.entries(window.S || {}).filter(([, v]) => v).map(([k, v]) => [k, typeof v === "object" ? JSON.parse(JSON.stringify(v)) : v]));
	return out;
}
const PAGE_READ = (o) => `(${pageRead.toString()})(${JSON.stringify(o)})`;
// the server's monsters alive by type (count, highest level), every type (run where `instances` is the server's)
function serverRead(instances) {
	const alive = {},
		level = {};
	for (const name in instances)
		for (const id in instances[name].monsters) {
			const m = instances[name].monsters[id];
			if (!m || m.dead) continue;
			alive[m.type] = (alive[m.type] || 0) + 1;
			level[m.type] = Math.max(level[m.type] || 0, m.level || 1);
		}
	return { alive, level };
}
const SERVER_READ = `(${serverRead.toString()})(instances)`;

/**
 * The setup's steps and their state. Time: ms since the run's start, after the warm-up (the drivers' start). A step fires
 * once: at its `at`; when its `when` holds at a check (every `check` ms: the setup's run.check), held `for` that long;
 * `after` a named step
 * fired, `at` later (again after each of its firings). `repeat`: a `when` step fires again each time it holds anew
 * (false in between).
 */
class Steering {
	constructor(steps = [], { until = null, check = "1s" } = {}) {
		const P = setup().parseDuration;
		this.checkMs = P(check);
		this.steps = steps.map((e, i) => ({
			e, i, name: e.name || null, kind: e.when != null ? "when" : e.after != null ? "after" : "at", ms: e.at != null ? P(e.at) : 0,
			fn: e.when != null ? compile(e.when) : null, forMs: e.for != null ? P(e.for) : 0, windowMs: P(e.window ?? WINDOW), refs: e.when != null ? refsOf(e.when) : null,
			n: 0, t: null, taken: false, armed: true, since: null, waits: [], error: null,
		}));
		this.until = until ? { fn: compile(until), refs: refsOf(until), error: null } : null;
		this.refs = mergeRefs([...this.steps.filter((s) => s.refs).map((s) => s.refs), ...(this.until ? [this.until.refs] : [])]);
		this.samples = []; // [ms, { name: [xp_gained, kills, gold_gained, looted, dmg_done, dmg_taken] }]
		this.maxWindow = Math.max(P(WINDOW), ...this.steps.map((s) => s.windowMs));
	}
	/** conditions to check: a when step not done, or run.until (until: while it counts) */
	waiting(until = false) {
		return (until && !!this.until) || this.steps.some((s) => s.kind === "when" && (s.armed || s.e.repeat));
	}
	/** the time-based steps due by now (at, after), in time order: [{ s, at: its time }] (each taken once) */
	due(now) {
		const out = [];
		for (const s of this.steps) {
			if (s.kind === "at" && !s.taken && s.ms <= now) (s.taken = true), out.push({ s, at: s.ms });
			if (s.kind === "after") {
				for (const w of s.waits) if (w <= now) out.push({ s, at: w });
				s.waits = s.waits.filter((x) => x > now);
			}
		}
		return out.sort((a, b) => a.at - b.at || a.s.i - b.s.i);
	}
	/** the next time a time-based step is due (Infinity: none) */
	next() {
		let t = Infinity;
		for (const s of this.steps) {
			if (s.kind === "at" && !s.taken) t = Math.min(t, s.ms);
			for (const w of s.waits) t = Math.min(t, w);
		}
		return t;
	}
	/** a step fired at now: counted; the steps after it due `at` later */
	fired(s, now) {
		s.n++;
		s.t = now;
		if (s.name) for (const a of this.steps) if (a.kind === "after" && a.e.after === s.name) a.waits.push(now + a.ms);
	}
	/** the steps fired so far, by name: { <name>: { n, t (s) } } */
	stepsNow() {
		return Object.fromEntries(this.steps.filter((s) => s.name && s.n > 0).map((s) => [s.name, { n: s.n, t: s.t / 1000 }]));
	}
	// the context's rates over a window: per hour (xp, kills, gold, items looted), per s (damage done, taken); the party's:
	// theirs summed
	rates(ctx, now, windowMs) {
		const first = this.samples.find(([t]) => t >= now - windowMs) || this.samples[this.samples.length - 1];
		for (const [n, r] of Object.entries(ctx.c)) {
			const was = first && first[1][n],
				dt = first ? (now - first[0]) / 1000 : 0,
				d = (i, v) => (was && dt > 0 ? (v - was[i]) / dt : 0);
			r.rate = { xp_h: d(0, r.xp_gained) * 3600, kills_h: d(1, r.kills.total) * 3600, gold_h: d(2, r.gold_gained) * 3600, looted_h: d(3, r.looted.total) * 3600, dmg_s: d(4, r.dmg_done), taken_s: d(5, r.dmg_taken) };
		}
		if (ctx.party) {
			const rs = Object.values(ctx.c);
			ctx.party.rate = Object.fromEntries(["xp_h", "kills_h", "gold_h", "looted_h", "dmg_s", "taken_s"].map((k) => [k, rs.reduce((a, r) => a + r.rate[k], 0)]));
		}
	}
	/** A check at now (ms) with a context (contextOf): the when steps that fire now (their `for` held; not done), and
	 * whether run.until holds (untilT: its t, s since the warm-up; null: not now). An expression that throws is false (its
	 * first error kept: .error) */
	check(now, ctx, untilT = null) {
		this.samples.push([now, Object.fromEntries(Object.entries(ctx.c).map(([n, r]) => [n, [r.xp_gained, r.kills.total, r.gold_gained, r.looted.total, r.dmg_done, r.dmg_taken]]))]);
		while (this.samples.length > 2 && this.samples[1][0] <= now - this.maxWindow) this.samples.shift();
		const steps = this.stepsNow(),
			fire = [],
			run = (x, t) => {
				if (x.refs.rate) this.rates(ctx, now, x.windowMs ?? setup().parseDuration(WINDOW));
				try {
					return !!x.fn(ctx.c, t, ctx.world, steps, ctx.party);
				} catch (e) {
					x.error ||= e.message;
					return false;
				}
			};
		for (const s of this.steps) {
			if (s.kind !== "when" || (!s.armed && !s.e.repeat)) continue;
			if (!run(s, now / 1000)) {
				s.since = null;
				if (s.e.repeat) s.armed = true;
				continue;
			}
			if (!s.armed) continue;
			if (s.since == null) s.since = now;
			if (now - s.since < s.forMs) continue;
			(s.armed = false), (s.since = null);
			fire.push(s);
		}
		return { fire, until: this.until && untilT != null ? run(this.until, untilT) : false };
	}
}

/** Why a step fired, as a line: "at 20m", "when <expr> for 5m", "10m after boss" */
function whyOf(e) {
	if (e.when != null) return `when ${e.when}${e.for ? " for " + e.for : ""}${e.repeat ? " (each time)" : ""}`;
	if (e.after != null) return `${e.at ?? "0s"} after ${e.after}`;
	return `at ${e.at}`;
}

module.exports = { compile, lint, refsOf, record, contextOf, counts, pageRead, PAGE_READ, serverRead, SERVER_READ, Steering, whyOf };
