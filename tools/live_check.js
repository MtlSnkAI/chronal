// Reconciles a live snapshot (schema v2.5) with itself, its grid file and the server's own counters, and optionally
// with a chronal run RESULT (--result). Exit 1 when a check fails.
//   node tools/live_check.js live/<id>.json [RESULT.json] [--quiet]
// Per character:
//   dmg:   by_skill and by_target sum to done (raw and net), net <= raw; done.net without burn and dreturn = the
//          server's player.t.mdamage since the base (burn ticks and returned damage aren't in it); taken_by sums to
//          taken, net <= raw; overkill = raw - net
//   heal:  net <= raw everywhere, overheal = raw - net >= 0, by_skill sums to done, received_by to received
//   xp:    the server's player.t.xp since the base = xp_award (issue_monster_award deltas); xp_gained = xp_award -
//          xp_lost + the rest (shown: merchant xp, bottles...)
//   gold:  gold_start + loot + sold + stand + received + other - bought - traded - craft - sent - other_out - banked = gold
//          (residual 0); loot = the server's player.t.cgold since the base
//   items: items.held (what the character holds, by name, since the base) = looted + received + bought + mluck copies
//          + crafted + exchange results + other gains - consumed - sent - sold - exchanged - lost upgrades - compounds (2 per success,
//          3 per failure; one in progress counts as what comes back); a dismantle shows up as a difference; a snapshot
//          without items.held (the fixtures in test/fixtures/live-v2) skips it with a note
//   time:  alive, combat, party, every condition and sum(modes) <= measured
//   buffs: on[k].ms = conditions[k].ms; outcomes while on <= the totals (party: xp = party.xp); Angel's extra gold <= the
//          gold of the chests opened with her aura, every chest matched; Kane kills = on.citizen0aura.rkills;
//          timeline rows = the conditions: merged over 1 s gaps they give n intervals and the longest, and they
//          cover every ms counted (within the 0.1 s rounding); every key has rows, a kind, a value only when it is
//          one of the valued keys; a key whose oldest rows were dropped: its rows start at since[key], at most key_cap
//          closed, no more intervals than n
//   history: at most 300 rows from the base, increasing; 60+ rows leave no gap over a tenth of the span
// Grid: header, one row per GRID_MS boundary (increasing), every character's GRID_COLS; the last row = the snapshot
// (a finished run: equal, at t = measured; a running one: cumulative columns <= the snapshot); gold since the
// base, taken_raw, every line's `c` (condition ms by character) never decreasing and = conditions at the end.
// Party: history's last row = the members' sums; the characters' last hits = kills.total (NPCs such as the Baron
// kill too: kills.others).
// Run control: proc, control (<id>.ctl), run; a finished run has end complete, stopped or failed and no .ctl.
// World (when it has age_ms or mlevels): age_ms >= 0, mlevels { base, end } per map and
// type { n, avg, max } (base once measured, end once done).
// Setup (a chronal run run): <id>.setup.json parses as chronal-setup/1 with the roster's characters in run order, its hash =
// setup.hash, the code hashes = the roster's and versions.code_hash, each character's CODE in the store (code/, or
// ../code for removed/) with content matching its hash; its world.age = world.age_ms (less for a run stopped during it).
// RESULT: chronal run characters.
const fs = require("fs"), path = require("path"), crypto = require("crypto");

const args = process.argv.slice(2).filter((a) => !a.startsWith("--")),
	quiet = process.argv.includes("--quiet");
if (!args[0]) {
	console.error("usage: node tools/live_check.js <snapshot.json> [RESULT.json] [--quiet]");
	process.exit(2);
}
const s = JSON.parse(fs.readFileSync(args[0], "utf8")),
	res = args[1] ? JSON.parse(fs.readFileSync(args[1], "utf8")) : null;
let fails = 0,
	checks = 0;
const ok = (cond, what, detail = "") => {
	checks++;
	if (!cond) fails++;
	if (!cond || !quiet) console.log(`${cond ? "ok  " : "FAIL"} ${what}${detail ? "  " + detail : ""}`);
};
const info = (what) => quiet || console.log(`     ${what}`);
const sum = (o, f = (x) => x) => Object.values(o || {}).reduce((a, x) => a + (f(x) || 0), 0);
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

if (!(s.schema === 2 && s.schema_minor >= 2)) (console.error("not a schema v2.2 snapshot"), process.exit(2));
const M = s.measured_ms;
// the keys with a value (condValue), the kinds
const VALUED = /^(citizen[04]aura|mluck|encouragement_\w+|paladin_aura_\w+|elixir|party|fear|booster)$/,
	KINDS = new Set(["buff", "debuff", "other"]);
// history rows: at most 300, from the base, increasing, spread over the run (60+ rows: no gap over a tenth of the span)
// from: the first row's t (0; a character that logged in after the base: at or after its first login)
const histOk = (h, from = 0) => {
	if (!h || !h.length) return "none";
	const t = h.map((r) => r[0]),
		gaps = t.slice(1).map((x, i) => x - t[i]),
		span = t[t.length - 1] - t[0],
		max = Math.max(0, ...gaps.slice(0, -1));
	if (h.length > 300) return `${h.length} rows`;
	if ((from ? t[0] < from : t[0] !== 0) || gaps.some((g) => g < 0)) return `t ${t[0]}.. not from ${from ? "its login at " + from : 0} or not increasing`;
	if (h.length >= 60 && max > span / 10) return `a gap of ${max} s in ${span} s`;
	return "";
};
console.log(`${s.tag} (${s.script}, ${s.strategy}) ${Math.round(M / 60000)} game min measured${s.done ? "" : s.end && s.end.reason === "failed" ? ", failed: " + s.end.detail : ", still running"}`);
for (const p of s.players) {
	if (!p.dmg) {
		info(`${p.name}: no v2 counters`);
		continue;
	}
	const n = p.name.padEnd(10);
	// damage done
	const d = p.dmg,
		skillNet = (k) => (d.by_skill[k] && d.by_skill[k].net) || 0;
	ok(near(sum(d.by_skill, (x) => x.raw), d.done.raw) && near(sum(d.by_skill, (x) => x.net), d.done.net), `${n} dmg by_skill sums to done`, `${d.done.raw} raw ${d.done.net} net`);
	ok(near(sum(d.by_target, (x) => x.raw), d.done.raw) && near(sum(d.by_target, (x) => x.net), d.done.net), `${n} dmg by_target sums to done`);
	ok(Object.values(d.by_skill).every((x) => x.net <= x.raw && x.net >= 0), `${n} dmg net <= raw per skill`);
	ok(d.overkill === d.done.raw - d.done.net && d.overkill >= 0, `${n} dmg overkill = raw - net`, `${d.overkill}`);
	if (p.server) {
		const own = d.done.net - skillNet("burn") - skillNet("dreturn");
		ok(near(own, p.server.mdamage), `${n} dmg net (no burn, dreturn) = server t.mdamage`, `${own} vs ${p.server.mdamage}`);
	}
	ok(near(sum(d.taken_by, (x) => x.raw), d.taken.raw) && near(sum(d.taken_by, (x) => x.net), d.taken.net) && d.taken.net <= d.taken.raw, `${n} taken_by sums to taken, net <= raw`, `${d.taken.raw} raw ${d.taken.net} net`);
	// heals
	const h = p.heal,
		pairsOk = (o) => Object.values(o).every((x) => x.net <= x.raw && x.net >= 0);
	ok(h.done.net <= h.done.raw && h.overheal >= 0 && near(h.overheal, h.done.raw - h.done.net), `${n} heal done net <= raw, overheal >= 0`, `${h.done.raw} raw ${h.done.net} net ${h.overheal} over`);
	ok(pairsOk(h.by_skill) && pairsOk(h.by_target) && pairsOk(h.received_by) && h.received.net <= h.received.raw, `${n} heal net <= raw per skill/target/source`);
	ok(near(sum(h.by_skill, (x) => x.raw), h.done.raw) && near(sum(h.by_skill, (x) => x.net), h.done.net), `${n} heal by_skill sums to done`);
	ok(near(sum(h.received_by, (x) => x.raw), h.received.raw) && near(sum(h.received_by, (x) => x.net), h.received.net), `${n} heal received_by sums to received`, `${h.received.raw} raw ${h.received.net} net`);
	// xp
	if (p.server) ok(p.server.xp === p.xp_award, `${n} xp awards = server t.xp`, `${p.xp_award} vs ${p.server.xp}`);
	const xpRest = p.xp_gained - p.xp_award + p.xp_lost;
	(p.type === "merchant" ? info : (x) => ok(xpRest === 0, x))(`${n} xp gained = awards - death losses (rest ${xpRest})`);
	// gold
	const f = p.gold_flow,
		expect = p.gold_start + f.loot + f.sold + f.stand + f.received + f.other - f.bought - (f.traded || 0) - f.craft - f.sent - f.other_out - f.banked;
	ok(expect === p.gold, `${n} gold start + flows = now`, `residual ${p.gold - expect} (${JSON.stringify(f)})`);
	ok(Object.entries(f).every(([k, x]) => k === "banked" || x >= 0), `${n} gold flows >= 0 (but banked)`);
	if (p.server) ok(f.loot === p.server.cgold, `${n} loot gold = server t.cgold`, `${f.loot} vs ${p.server.cgold}`);
	const it = p.items;
	if (!it.held) info(`${n} items held = flows: skipped, the snapshot has no items.held`);
	else {
		const sb = it.stand_bought || {},
			ss = it.stand_sold || {};
		const names = new Set([...Object.keys(it.held), ...Object.keys(it.looted), ...Object.keys(it.consumed), ...Object.keys(it.bought), ...Object.keys(it.sold), ...Object.keys(sb), ...Object.keys(ss), ...Object.keys(it.sent), ...Object.keys(it.received),
				...Object.keys(it.mluck_dupes), ...Object.keys(it.crafted), ...Object.keys(it.from_exchange), ...Object.keys(it.other || {}), ...Object.keys(it.exchanged), ...Object.keys(it.upgraded), ...Object.keys(it.compounded)]);
		const off = [];
		for (const k of names) {
			const c = it.compounded[k] || { ok: 0, fail: 0 };
			const e = (it.looted[k] || 0) + sum(it.received[k]) + ((it.bought[k] && it.bought[k].q) || 0) + ((sb[k] && sb[k].q) || 0) + (it.mluck_dupes[k] || 0) + (it.crafted[k] || 0) + (it.from_exchange[k] || 0) + ((it.other || {})[k] || 0)
				- (it.consumed[k] || 0) - sum(it.sent[k]) - ((it.sold[k] && it.sold[k].q) || 0) - ((ss[k] && ss[k].q) || 0) - (it.exchanged[k] || 0) - ((it.upgraded[k] && it.upgraded[k].lost) || 0) - 2 * c.ok - 3 * c.fail;
			if (e !== (it.held[k] || 0)) off.push(`${k} held ${it.held[k] || 0} flows ${e}`);
		}
		ok(!off.length, `${n} items held = flows (${names.size} items)`, off.join(", "));
	}
	info(`${n} looted ${sum(it.looted)} consumed ${sum(it.consumed)} sent ${sum(it.sent, (x) => sum(x))} received ${sum(it.received, (x) => sum(x))} chests ${JSON.stringify(p.chests)} credits ${p.credits} kills ${p.kills}`);
	// time
	const C = p.conditions;
	const over = [["alive", p.alive_ms], ["combat", p.combat_ms], ["party", p.party.ms], ["modes", p.modes ? sum(p.modes) : 0], ...Object.entries(C || {}).map(([k, x]) => [k, x.ms])].filter(([, ms]) => !(ms >= 0 && ms <= M));
	ok(!over.length, `${n} time counters and conditions <= measured`, over.map(([k, ms]) => `${k} ${ms}`).join(", "));
	const hb = histOk(p.history, p.sessions && p.sessions.length ? p.sessions[0][0] : 0);
	ok(!hb, `${n} history spread over the run`, hb || `${p.history.length} rows to t ${p.history[p.history.length - 1][0]}`);
	info(`${n} alive ${(p.alive_ms / 60000).toFixed(1)} min, combat ${(p.combat_ms / 60000).toFixed(1)}, party ${(p.party.ms / 60000).toFixed(1)}, buffs ${JSON.stringify(p.buffs)}, modes ${JSON.stringify(p.modes)}`);
	if (!C) {
		info(`${n} no conditions (single-thread Sim)`);
		continue;
	}
	// buffs: on[k] against the totals
	const cms = (k) => (C[k] ? C[k].ms : 0),
		bad = [];
	for (const [k, o] of Object.entries(p.on)) {
		if (o.ms !== cms(k)) bad.push(`${k} ms ${o.ms} vs ${cms(k)}`);
		const lim = { xp: p.xp_award, credits: p.credits, dmg: s.precision.dmg_done === "raw" ? d.done.raw : d.done.net, taken: d.taken.net, heal: h.done.net, hpots: p.hpots, chests: p.chests.opened };
		for (const [c, max] of Object.entries(lim)) if (o[c] > max + 1e-6) bad.push(`${k} ${c} ${o[c]} > ${max}`);
		if (o.x10 + o.x50 > 2 * o.chests) bad.push(`${k} x10+x50 ${o.x10 + o.x50} > 2 x chests ${o.chests}`);
	}
	if (p.on.party) ok(p.on.party.xp === p.party.xp, `${n} on.party.xp = party.xp`, `${p.on.party.xp} vs ${p.party.xp}`);
	ok(!bad.length, `${n} on: ms = conditions, outcomes <= totals (${Object.keys(p.on).join(", ") || "none"})`, bad.join(", "));
	ok(near(p.buffs.lonewolf, +Math.min(1, cms("encouragement_lonewolf") / M).toFixed(3), 0.0015) && near(p.buffs.mluck, +Math.min(1, cms("mluck") / M).toFixed(3), 0.0015), `${n} buffs.lonewolf/mluck = conditions`);
	const x = p.exact,
		a4 = p.on.citizen4aura || { loot_gold: 0, chests: 0 };
	if (x) {
		ok(x.angel_gold >= 0 && x.angel_gold <= a4.loot_gold && x.angel_chests <= a4.chests, `${n} Angel's extra <= gold of chests opened with her aura`, `${x.angel_gold} of ${a4.loot_gold} (${x.angel_chests} of ${a4.chests} chests)`);
		ok(!x.angel_unmatched, `${n} Angel: every chest's paid gold = the server's formula`, `${x.angel_unmatched} unmatched`);
		ok(x.kane_kills === ((p.on.citizen0aura && p.on.citizen0aura.rkills) || 0), `${n} Kane kills = on.citizen0aura.rkills`, `${x.kane_kills}`);
	}
	// timeline against conditions: rows of a key merged over <= 1 s gaps (0.1 s rounding: 0.9..1.1) = n intervals, the
	// longest = max_ms; the rows cover the ms counted; rows of a key with drops only from since[key]
	const tl = p.timeline,
		end = M / 1000,
		slack = s.done ? 0 : ((s.precision && s.precision.sample_ms) || 250) / 1000 + 0.1,
		dby = tl.dropped_by || {};
	const tbad = [];
	const kb = Object.entries(C).filter(([k, c]) => !KINDS.has(c.kind) || (c.v !== undefined && !VALUED.test(k))).map(([k, c]) => `${k} ${c.kind} ${c.v}`);
	ok(!kb.length, `${n} conditions: kind, values only for valued keys`, kb.join(", "));
	const closed = tl.rows.filter((r) => r[2] != null),
		per = {};
	for (const r of closed) per[r[0]] = (per[r[0]] || 0) + 1;
	if (tl.gap_ms !== 1000 || closed.length > tl.cap || Object.values(per).some((x) => x > tl.key_cap)) tbad.push(`gap ${tl.gap_ms}, ${closed.length} closed of ${tl.cap}, per key ${JSON.stringify(per)} of ${tl.key_cap}`);
	if (tl.dropped !== Object.values(dby).reduce((a, x) => a + x, 0)) tbad.push(`dropped ${tl.dropped} vs dropped_by ${JSON.stringify(dby)}`);
	for (const [k, c] of Object.entries(C)) {
		const rows = tl.rows.filter((r) => r[0] === k).map((r) => [r[1], r[2] == null ? end : r[2]]);
		if (dby[k]) {
			const iv = rows.filter((r, i) => !i || r[0] - rows[i - 1][1] > 1.1).length;
			if (rows.length && rows[0][0] < tl.since[k]) tbad.push(`${k} rows from ${rows[0][0]} < since ${tl.since[k]}`);
			if (rows.reduce((a, r) => a + r[1] - r[0], 0) * 1000 > c.ms + rows.length * 1100 + slack * 1000) tbad.push(`${k} rows longer than ms ${c.ms}`);
			if (iv > c.n) tbad.push(`${k} ${iv} intervals > n ${c.n}`);
			continue;
		}
		if (!rows.length) {
			tbad.push(`${k} no rows`);
			continue;
		}
		const len = rows.reduce((a, r) => a + r[1] - r[0], 0),
			spans = (gap) => {
				const out = [];
				for (const r of rows) {
					const l = out[out.length - 1];
					if (l && r[0] - l[1] <= gap) l[1] = r[1];
					else out.push([...r]);
				}
				return out;
			};
		if (len * 1000 < c.ms - rows.length * 100 - 1e-6) tbad.push(`${k} rows ${len.toFixed(1)} s < ms ${c.ms}`);
		if (tl.gap_ms === 1000) {
			const lo = spans(1.1), hi = spans(0.9),
				maxOf = (sp) => Math.max(...sp.map((r) => r[1] - r[0])) * 1000;
			if (!(lo.length <= c.n && c.n <= hi.length)) tbad.push(`${k} intervals ${lo.length}..${hi.length} vs n ${c.n}`);
			if (!(c.max_ms <= maxOf(lo) + 200 + slack * 1000 && c.max_ms >= maxOf(hi) - 200 - slack * 1000)) tbad.push(`${k} longest ${maxOf(hi)}..${maxOf(lo)} vs max_ms ${c.max_ms}`);
		} else if (rows.length > c.n) tbad.push(`${k} rows ${rows.length} > n ${c.n}`);
	}
	ok(!tbad.length, `${n} timeline = conditions (${tl.rows.length} rows, gap ${tl.gap_ms} ms, ${tl.dropped} dropped${tl.dropped ? " " + JSON.stringify(dby) : ""})`, tbad.join(", "));
	info(`${n} conditions ${Object.entries(C).map(([k, c]) => `${k} ${(c.ms / M * 100).toFixed(1)}% n${c.n}${c.v !== undefined ? " " + c.v : ""}`).join(", ")}; mult_avg ${JSON.stringify(p.mult_avg)}`);
	if (Object.keys(p.on).length) info(`${n} on ${JSON.stringify(p.on)}${x ? ", exact " + JSON.stringify(x) : ""}`);
}
// the grid file
const G = s.grid;
if (G) {
	const file = path.join(path.dirname(args[0]), G.file),
		lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
	const head = lines.shift();
	ok(head && JSON.stringify(head.cols) === JSON.stringify(G.cols) && head.step_ms === G.step_ms, `grid ${G.file}: header`, `${lines.length} rows`);
	const shape = lines.every((l, i) => (l.end || (!i && l.t === 0) || l.v % G.step_ms === 0) && (!i || l.v > lines[i - 1].v) && Object.values(l.r).every((r) => r.length === G.cols.length));
	ok(lines.length && shape && (!s.done || lines.length === G.lines), `grid rows: the base, then on step boundaries, increasing, ${G.cols.length} columns`, `${lines.length} rows, snapshot says ${G.lines}`);
	// c: every line, cumulative per character and key
	const cbad = [];
	lines.forEach((l, i) => {
		if (!l.c) return void cbad.push(`line ${i} without c`);
		const prev = i ? lines[i - 1].c || {} : {};
		for (const [name, o] of Object.entries(l.c)) for (const [k, ms] of Object.entries(o)) if (!(ms > 0)) cbad.push(`${name} ${k} ${ms} at t ${l.t}`);
		for (const [name, o] of Object.entries(prev)) for (const [k, ms] of Object.entries(o)) if (!(((l.c[name] || {})[k] || 0) >= ms)) cbad.push(`${name} ${k} ${(l.c[name] || {})[k]} < ${ms} at t ${l.t}`);
	});
	ok(G.cols.includes("taken_raw") && !cbad.length, "grid: taken_raw, c on every line and never decreasing", cbad.slice(0, 5).join(", "));
	const last = lines[lines.length - 1],
		col = (name) => G.cols.indexOf(name);
	if (last) {
		const want = (p) => ({
			level: p.level, xp: p.xp_gained, kills: p.kills, credits: p.credits, deaths: p.deaths, dmg: p.dmg.done.net, dmg_raw: p.dmg.done.raw, taken: p.dmg.taken.net, taken_raw: p.dmg.taken.raw, heal: p.heal.done.net, heal_raw: p.heal.done.raw,
			income: p.income, loot_items: sum(p.items.looted), hpots: p.hpots, mpots: p.mpots, mana: p.mana.spent, gold: p.gold - p.gold_start, alive_ms: p.alive_ms, combat_ms: p.combat_ms, party_ms: p.party.ms,
			c_citizen0aura: ((p.conditions || {}).citizen0aura || {}).ms || 0, c_citizen4aura: ((p.conditions || {}).citizen4aura || {}).ms || 0, c_mluck: ((p.conditions || {}).mluck || {}).ms || 0,
			c_lonewolf: ((p.conditions || {}).encouragement_lonewolf || {}).ms || 0, c_party: ((p.conditions || {}).party || {}).ms || 0, angel_gold: p.exact ? p.exact.angel_gold : 0,
		});
		const gbad = [],
			end = s.done; // the last row is the snapshot's
		for (const p of s.players.filter((q) => q.dmg)) {
			const row = last.r[p.name];
			if (!row) {
				gbad.push(`${p.name} missing`);
				continue;
			}
			for (const [k, v] of Object.entries(want(p))) {
				if (col(k) < 0) continue;
				const g = row[col(k)];
				if (end ? !near(g, v) : !["level", "xp", "gold"].includes(k) && g > v + 1e-6) gbad.push(`${p.name} ${k} ${g} vs ${v}`);
			}
			// c: the conditions' ms (> 0) at the end, at most them while running
			const lc = (last.c || {})[p.name];
			if (p.conditions && lc) {
				const want = Object.fromEntries(Object.entries(p.conditions).filter(([, c]) => c.ms > 0).map(([k, c]) => [k, c.ms]));
				for (const k of new Set([...Object.keys(want), ...Object.keys(lc)])) if (end ? lc[k] !== want[k] : !((lc[k] || 0) <= (want[k] || 0))) gbad.push(`${p.name} c.${k} ${lc[k]} vs ${want[k]}`);
			}
		}
		if (end) ok(last.end && near(last.t, Math.round(M / 100) / 10, 0.051), "grid: the last row is the end", `t ${last.t} vs measured ${M / 1000}`);
		ok(!gbad.length, `grid: last row ${end ? "=" : "<="} snapshot (t ${last.t})`, gbad.join(", "));
		const { c: _c, ...bare } = last;
		ok(JSON.stringify(G.tail[G.tail.length - 1]) === JSON.stringify(bare) || !s.done, "grid: inline tail ends with the file's last row (without c)");
	}
}
// the items' events: every line read, in time order, as many as the snapshot says; the attempts as the ledgers count
const IL = s.items_log;
if (IL) {
	const file = path.join(path.dirname(args[0]), IL.file),
		lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : null;
	ok(lines && (!s.done || lines.length === IL.lines) && lines.every((e, i) => Number.isFinite(e.t) && typeof e.k === "string" && (!i || e.t >= lines[i - 1].t)), `items ${IL.file}: ${lines ? lines.length : "no"} events in time order`, `snapshot says ${IL.lines}`);
	if (lines && s.done && !IL.capped) {
		const n = (k, who, item, f) => lines.filter((e) => e.k === k && e.who === who && e.item === item && (!f || f(e))).length, bad = [];
		for (const p of s.players.filter((q) => q.items)) {
			for (const [item, o] of Object.entries(p.items.upgraded || {})) if (n("upgrade", p.name, item) + n("stat", p.name, item) !== o.ok + o.fail) bad.push(`${p.name} ${item} upgrades ${n("upgrade", p.name, item)} vs ${o.ok + o.fail}`);
			for (const [item, o] of Object.entries(p.items.compounded || {})) if (n("compound", p.name, item) !== o.ok + o.fail) bad.push(`${p.name} ${item} compounds ${n("compound", p.name, item)} vs ${o.ok + o.fail}`);
			for (const [item, q] of Object.entries(p.items.looted || {})) { const got = lines.filter((e) => e.k === "loot" && e.who === p.name && e.item === item).reduce((a, e) => a + e.q, 0); if (got !== q) bad.push(`${p.name} looted ${item} ${got} vs ${q}`); }
		}
		ok(!bad.length, "items: the events add up to the ledgers (looted, upgrades, compounds)", bad.slice(0, 5).join(", "));
	}
}
// party
const P = s.party,
	mem = s.players.filter((p) => P.members.includes(p.name));
ok(P.formed_ms == null || (P.formed_ms >= 0 && P.formed_ms <= M), "party formed_ms in 0..measured", `${P.formed_ms}`);
ok(P.party_ms >= 0 && P.party_ms <= M, "party party_ms <= measured", `${P.party_ms}`);
const lastRows = mem.map((p) => p.history && p.history[p.history.length - 1]).filter(Boolean),
	ph = P.history && P.history[P.history.length - 1];
if (P.history && P.history.length) {
	// (from the first fighter's login when none was in game at the base)
	const first = Math.min(...mem.map((p) => (p.sessions && p.sessions.length ? p.sessions[0][0] : 0)));
	const hb = histOk(P.history, Number.isFinite(first) ? first : 0);
	ok(!hb, "party history spread over the run", hb || `${P.history.length} rows`);
}
if (ph && lastRows.length === mem.length && lastRows.every((r) => r[0] === ph[0])) {
	const cols = s.history_cols,
		want = cols.map((c, i) => (c === "t" ? ph[0] : c === "level" ? Math.min(...lastRows.map((r) => r[i])) : c === "trips" ? 0 : lastRows.reduce((a, r) => a + r[i], 0)));
	const bad = cols.filter((c, i) => !near(want[i], ph[i]));
	ok(!bad.length, `party history's last row = sums over ${P.members.join(", ")}`, bad.map((c) => `${c} ${ph[cols.indexOf(c)]} vs ${want[cols.indexOf(c)]}`).join(", "));
}
const hits = s.players.reduce((a, p) => a + p.kills, 0);
ok(hits === s.kills.total, "kills.total = the characters' last hits (others: kills.others)", `${hits} vs ${s.kills.total}; others ${s.kills.others.total} ${JSON.stringify(s.kills.others.by)}`);
info(`party formed ${P.formed_ms == null ? "never" : Math.round(P.formed_ms / 1000) + " s"} in, ${(P.party_ms / 60000).toFixed(1)} min together, groups ${JSON.stringify(P.groups)}, merchant in party: ${P.merchant_in_party}`);
if (s.merchant) info(`merchant ${s.merchant.name}: ${s.merchant.trips.length} trips listed, per fighter ${JSON.stringify(s.merchant.per_fighter)}`);
// run control
const pr = s.proc || {},
	ct = s.control || {},
	rn = s.run || {},
	ctl = path.join(path.dirname(args[0]), s.id + ".ctl");
ok(Number.isInteger(pr.pid) && typeof pr.host === "string" && typeof pr.cwd === "string" && (pr.start === null || Number.isFinite(pr.start)), "proc: pid, host, start, cwd", JSON.stringify({ ...pr, cmdline: pr.cmdline && pr.cmdline.split("\0").join(" ") }));
const obj = (x) => !!x && typeof x === "object";
ok(ct.file === s.id + ".ctl" && ct.ack >= 0 && typeof ct.stop === "boolean", "control: <id>.ctl, stop, ack", JSON.stringify(ct));
ok(path.isAbsolute(rn.root || "") && typeof rn.script === "string" && Number.isFinite(rn.seed), "run: root, script, seed", JSON.stringify(rn));
ok(!("npcs" in s), "no npcs");
ok(s.precision.overkill === "exact" && s.precision.overheal === "exact", "precision: overkill exact, overheal exact");
if (s.done) ok(s.end && ["complete", "stopped", "failed"].includes(s.end.reason) && !fs.existsSync(ctl), "a finished run: end complete, stopped or failed, no .ctl", JSON.stringify(s.end));
else ok(s.end === null || (s.end && s.end.reason === "failed"), "a running run: no end (or failed)", JSON.stringify(s.end));
const W = s.world || {},
	ml = W.mlevels;
info(`launch ${JSON.stringify(s.launch)}; world ${JSON.stringify({ ...W, mlevels: undefined })}`);
if ("age_ms" in W || ml !== undefined) {
	// { <map>: { <type>: { n, avg, max } } } or null (not read yet)
	const shape = (m) => m === null || (obj(m) && Object.values(m).every((t) => obj(t) && Object.values(t).every((x) => Number.isInteger(x.n) && x.n >= 1 && x.max >= 1 && x.avg >= 1 && x.avg <= x.max)));
	ok(Number.isFinite(W.age_ms) && W.age_ms >= 0 && obj(ml) && shape(ml.base) && shape(ml.end) && (s.measured_ms > 0 ? ml.base !== null : true) && (s.done ? ml.end !== null : true),
		"world: age_ms, mlevels { base, end } (base once measured, end once done)", JSON.stringify({ age_ms: W.age_ms, base: ml && ml.base && Object.keys(ml.base).length, end: ml && ml.end && Object.keys(ml.end).length }));
	for (const k of ["base", "end"]) {
		const rows = ml && ml[k] ? Object.entries(ml[k]).flatMap(([map, t]) => Object.entries(t).map(([type, x]) => [map + " " + type, x])) : [];
		if (rows.length) info(`monster levels (${k}): ${rows.length} map/types, ${rows.filter(([, x]) => x.max > 1).length} above L1, highest ${Math.max(...rows.map(([, x]) => x.max))}`);
	}
}
// the setup side file and its CODE in the store
if (s.setup) {
	const SETUP = require("../lib/setup"),
		dir = path.dirname(args[0]),
		f = path.join(dir, s.setup.file);
	let side = null;
	try {
		side = JSON.parse(fs.readFileSync(f, "utf8"));
	} catch (e) {
		ok(false, `setup ${s.setup.file}: exists and parses`, e.message);
	}
	if (side) {
		const names = (side.characters || []).map((c) => c.name),
			roster = (s.roster || []).map((r) => r.name);
		ok(side.format === "chronal-setup/1" && side.format === s.setup.format, `setup ${s.setup.file}: format chronal-setup/1`, side.format);
		ok(JSON.stringify(names) === JSON.stringify(roster), "setup characters = roster (run order)", `${names.join(", ")} vs ${roster.join(", ")}`);
		ok(SETUP.sideHash(side) === s.setup.hash, "setup hash = setup.hash", `${SETUP.sideHash(side)} vs ${s.setup.hash}`);
		ok(side.characters.every((c) => (s.roster.find((r) => r.name === c.name) || {}).code_hash === c.code.hash) && SETUP.codeHash(side) === s.versions.code_hash, "setup code hashes = roster code_hash, versions.code_hash", s.versions.code_hash);
		const sha = (x) => crypto.createHash("sha1").update(x).digest("hex").slice(0, 16),
			stores = [path.join(dir, "code"), path.join(dir, "..", "code")],
			bad = [];
		for (const c of side.characters) {
			const d = stores.find((x) => fs.existsSync(path.join(x, c.code.slots + ".json")) && fs.existsSync(path.join(x, c.code.text + ".js")));
			if (!d) bad.push(`${c.name}: no ${c.code.slots}.json / ${c.code.text}.js`);
			else if (sha(fs.readFileSync(path.join(d, c.code.slots + ".json"), "utf8")) !== c.code.slots || sha(fs.readFileSync(path.join(d, c.code.text + ".js"), "utf8")) !== c.code.text) bad.push(`${c.name}: stored CODE does not match its hash`);
		}
		ok(!bad.length, "setup CODE in the store (slot maps and entries, content = hash)", bad.join(", "));
		// (a run stopped during the age: less, and nothing measured)
		if (side.world && side.world.age != null && s.world && "age_ms" in s.world && s.world.age_ms !== null) {
			const want = SETUP.parseDuration(side.world.age);
			ok(s.world.age_ms === want || (s.world.age_ms < want && !s.measured_ms && s.end && s.end.reason !== "complete"), "setup world.age = world.age_ms (less: stopped during the age)", `${side.world.age} vs ${s.world.age_ms}`);
		}
	}
}
// the RESULT's end state (client side) against the snapshot's (server side, written at the end)
if (res && s.done) {
	const members = res.characters || {};
	for (const [name, r] of Object.entries(members)) {
		const p = s.players.find((x) => x.name === name);
		if (!p) (ok(false, `RESULT member ${name} in the snapshot`), 0);
		else ok(r.level === p.level, `${name.padEnd(10)} RESULT level = snapshot`, `${r.level} vs ${p.level}`);
	}
}
console.log(`${checks - fails}/${checks} checks passed`);
process.exit(fails ? 1 : 0);
