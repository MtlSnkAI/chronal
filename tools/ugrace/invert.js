#!/usr/bin/env node
"use strict";
// The server's upgrade grace per level (S.ugrace) from the probe's readings (tools/ugrace/probe.js): its records (the
// JSON it downloads on live) or sim snapshots (players[].code_status). Per level: the readings, how many solved, S.ugrace
// over time (min, median, max; >= 18 is all one: the chance takes min(6, S.ugrace / 3)), and a world.ugrace for setups.
// docs/how-to/measure-upgrade-grace.md.
//   node tools/ugrace/invert.js <record.json | snapshot.json> ... [--json]
//
// The server's chance for an upgrade with a scroll and no offering (server.js, the upgrade handler), L the level tried,
// p = G.upgrades[igrade][L], own = min(L + 1, item.grace + min(3, p.ugrace[L] / 4.5) + igrace), term = min(6, S.ugrace[L] / 3):
//   g0 = max(0, own + term + p.ograce / 3.2); g1 = p * g0 / L + g0 / 1000; g2 = max(0, g1 / 4.8 - 0.4 / (L - 0.999)^2)
//   chance = min(base + g2, cap); base p, cap min(p + 0.24, 2p); a higher grade scroll up to +10: base 1.2p + 0.01, cap
//   min(p + 0.36, 3p)
// With the character's own grace (p.ugrace) and offering grace 0, term is the one unknown. A chance at its cap tells
// nothing; at its base (g2's floor) only that term is at most t_max, and S.ugrace at most 3 t_max: the server's values
// are whole numbers (it adds 1, 2 or 3 per failure and resets to 0), so under 1 that is 0. term above 6 or below 0 (or
// a floor that can't be one): the character had grace of its own, or the server's formula isn't this one ("off").
const fs = require("node:fs"),
	path = require("node:path");

/** { state: "ok" | "floor" | "cap" | "off", term?, ugrace? (null: >= 18), t_max? } of a reading { L, p, high, grace, igrace, chance } */
function invert(x) {
	const base = x.high ? x.p * 1.2 + 0.01 : x.p,
		cap = x.high ? Math.min(x.p + 0.36, x.p * 3) : Math.min(x.p + 0.24, x.p * 2),
		k = x.p / x.L + 0.001,
		fl = 0.4 / ((x.L - 0.999) * (x.L - 0.999)),
		own = Math.min(x.L + 1, x.grace + x.igrace);
	if (x.chance >= cap - 1e-12) return { state: "cap" };
	if (x.chance - base <= 1e-12) {
		const t_max = (4.8 * fl) / k - own;
		return t_max < -1e-6 ? { state: "off" } : 3 * t_max < 1 - 1e-9 ? { state: "ok", term: 0, ugrace: 0, floor: true } : { state: "floor", t_max };
	}
	const term = (4.8 * (x.chance - base + fl)) / k - own;
	return { state: term > 6 + 1e-6 || term < -1e-6 ? "off" : "ok", term, ugrace: term < 6 - 1e-6 ? 3 * term : null };
}

// a file's probe records: a probe record itself, or a snapshot's players' (code_status)
function recordsOf(file) {
	const o = JSON.parse(fs.readFileSync(file, "utf8"));
	if (o && o.format === "chronal-ugrace-probe/1") return [o];
	return ((o && o.players) || []).map((p) => p.code_status).filter((s) => s && s.format === "chronal-ugrace-probe/1");
}

const median = (xs) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : null;
};

/** Per level, by round (a round: the readings of one time; one value, its items agreeing):
 * { L, n (readings), rounds, solved, floor (rounds only bounded: S.ugrace at most a whole number), cap (rounds unknown),
 * off (readings), min, median, max (Infinity: >= 18; a floor round at its bound), saturated (share of rounds >= 18),
 * mean (3 x the mean of min(6, S.ugrace / 3): the S.ugrace whose chance is the day's average one; a floor round at half
 * its bound), spread (most two items of one round read apart), apart (rounds whose items didn't agree), frac (most an
 * S.ugrace read off a whole number) }.
 * A reading held twice (overlapping downloads: each is the whole record so far) counts once. */
function summarize(readings) {
	const seen = new Set(),
		by = new Map();
	for (const r of readings) {
		const key = `${r.t} ${r.num} ${r.L}`;
		if (seen.has(key)) continue;
		seen.add(key);
		const v = invert(r),
			s = by.get(r.L) || by.set(r.L, { L: r.L, n: 0, off: 0, at: new Map() }).get(r.L),
			a = s.at.get(r.t) || s.at.set(r.t, { vals: [], bound: Infinity }).get(r.t);
		s.n++;
		if (v.state === "off") s.off++;
		else if (v.state === "ok") a.vals.push(v.ugrace ?? Infinity);
		else if (v.state === "floor") a.bound = Math.min(a.bound, Math.floor(3 * v.t_max + 1e-9));
	}
	return [...by.values()].sort((a, b) => a.L - b.L).map((s) => {
		const vals = [], fin = [];
		let solved = 0, floor = 0, cap = 0, spread = 0, apart = 0, term = 0;
		for (const a of s.at.values()) {
			if (a.vals.length) {
				const v = a.vals[0];
				solved++;
				vals.push(v);
				term += Math.min(6, v / 3);
				for (const x of a.vals) if (Number.isFinite(x)) fin.push(x);
				const d = Math.max(a.vals.every(Number.isFinite) ? Math.max(...a.vals) - Math.min(...a.vals) : a.vals.some(Number.isFinite) ? Infinity : 0, v > a.bound ? v - a.bound : 0); // (above another item's floor too)
				if (d > 1e-6) (apart++, (spread = Math.max(spread, d)));
			} else if (a.bound < Infinity) {
				floor++;
				vals.push(a.bound);
				term += Math.min(6, a.bound / 2 / 3);
			} else cap++;
		}
		const k = vals.length;
		return {
			L: s.L, n: s.n, rounds: s.at.size, solved, floor, cap, off: s.off,
			min: k ? Math.min(...vals) : null, median: median(vals), max: k ? Math.max(...vals) : null,
			saturated: k ? vals.filter((v) => v === Infinity).length / k : null, mean: k ? (3 * term) / k : null, spread, apart,
			frac: fin.length ? Math.max(...fin.map((u) => Math.abs(u - Math.round(u)))) : null,
		};
	});
}

// world.ugrace for a setup: per level the S.ugrace whose chance is the average one over the rounds read (mean), to 0.1
// (with world.ugrace_fixed: other players' upgrades keep it about there); a level never solved (only bounds) left out
const worldUgrace = (rows) => Object.fromEntries(rows.filter((r) => r.mean != null && r.solved).map((r) => [String(r.L), Math.round(r.mean * 10) / 10]));

function cli(argv) {
	const files = argv.filter((a) => !a.startsWith("--"));
	if (!files.length) return void (console.error("usage: node tools/ugrace/invert.js <record.json | snapshot.json> ... [--json]"), process.exit(2));
	const recs = files.flatMap((f) => recordsOf(path.resolve(f)).map((R) => ({ R, file: path.basename(f) })));
	if (!recs.length) return void (console.error("no ugrace probe records in " + files.join(", ")), process.exit(1));
	const realms = [...new Set(recs.map(({ R }) => `${R.server.region || "?"} ${R.server.id || "?"}`))];
	const rows = summarize(recs.flatMap(({ R }) => R.readings));
	if (argv.includes("--json")) return void console.log(JSON.stringify({ realms, levels: rows, world_ugrace: worldUgrace(rows) }, null, 1));
	const fmt = (v) => (v == null ? "-" : Number.isFinite(v) ? String(Math.round(v * 100) / 100) : ">=18");
	// (a probe's downloads: each the whole record so far; one line per run)
	const runs = new Map();
	for (const { R } of recs) {
		const k = `${R.name} (${R.env}, ${R.server.region || "?"} ${R.server.id || "?"}) from ${R.started_at}`;
		runs.set(k, Math.max(runs.get(k) || 0, R.rounds));
	}
	console.log(`${recs.length} record(s): ${[...runs].map(([k, n]) => `${k}: ${n} rounds`).join("; ")}`);
	if (realms.length > 1) console.log(`warning: several realms (${realms.join(", ")}): each has its own S.ugrace; read one at a time`);
	console.table(rows.map((r) => ({ level: r.L, readings: r.n, rounds: r.rounds, solved: r.solved, "floor (<=)": r.floor, cap: r.cap, off: r.off, min: fmt(r.min), median: fmt(r.median), max: fmt(r.max), ">=18": r.saturated == null ? "-" : Math.round(r.saturated * 100) + "%", mean: fmt(r.mean), "items apart": fmt(r.spread), "off whole": r.frac == null ? "-" : r.frac.toExponential(1) })));
	console.log("(by round: a floor round counts at its bound in min, median and max, at half of it in mean; mean: the S.ugrace whose chance is the average one)");
	for (const r of rows) {
		if (r.off) console.log(`level ${r.L}: ${r.off} reading(s) outside 0-6: the character has upgrade grace of its own (it upgraded, or used offerings), or the server's formula changed`);
		if (r.frac != null && r.frac > 1e-3) console.log(`level ${r.L}: S.ugrace read up to ${r.frac.toFixed(3)} off a whole number (the server's are whole): the formula or the assumptions don't hold`);
		// (a round's items are read one after another, a fraction of a second apart: now and then S.ugrace changes in between,
		// by a whole number; often, or by a fraction, the items' grace terms don't add up)
		if (r.spread > 1e-6)
			console.log(r.apart <= Math.max(1, 0.05 * r.rounds) && Math.abs(r.spread - Math.round(r.spread)) < 1e-6
				? `level ${r.L}: in ${r.apart} of ${r.rounds} rounds two items read up to ${fmt(r.spread)} apart: S.ugrace changed between the readings (taken one after another)`
				: `level ${r.L}: in ${r.apart} of ${r.rounds} rounds two items read up to ${fmt(r.spread)} apart: too often or not by whole numbers, the formula or the assumptions don't hold`);
		if (r.floor && !r.solved) console.log(`level ${r.L}: every round at the floor (S.ugrace <= ${fmt(r.min)}), left out of world.ugrace: an item with more grace of its own reads it`);
		if (r.cap && !r.solved && !r.floor) console.log(`level ${r.L}: every round at the cap: this level can't be read (a lower p reads it)`);
	}
	console.log("world.ugrace: " + JSON.stringify(worldUgrace(rows)));
}

if (require.main === module) cli(process.argv.slice(2));
module.exports = { invert, summarize, worldUgrace, recordsOf };
