#!/usr/bin/env node
"use strict";
// The fidelity records side by side: the sim runs' (their snapshots' players[].code_status, one per seed: sim.js's)
// against live records (the JSON fidelity.js downloads). Per metric over the measured window: the sim's mean +- sd over
// its seeds, each live value, live / sim and how many sim sds away it is (|z| > 2: outside what the seeds spread over);
// then what makes a live run unlike the sim's world. docs/how-to/check-against-live.md.
//   node tools/fidelity/compare.js --name fid-iceroamer-10m [--runs DIR] [live.json ...]
// --runs: sim.js's --out (default <live_dir>/fidelity). Without live records: the sim's own spread.
const fs = require("node:fs"),
	path = require("node:path");
const { config } = require("../../lib/config");

const args = process.argv.slice(2), opt = { files: [] };
for (let i = 0; i < args.length; i++) {
	if (!args[i].startsWith("--")) { opt.files.push(args[i]); continue; }
	opt[args[i].slice(2)] = args[++i];
}
const runs = path.resolve(opt.runs || path.join(config().live_dir, "fidelity"));
// a run's record: its snapshot's (the run's name begins with --name)
const sims = fs.readdirSync(runs).filter((f) => /^[\w.-]+--\d+\.json$/.test(f) && (!opt.name || new RegExp("^" + opt.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(-s\\d+)?--").test(f))).map((f) => {
	let w;
	try { w = JSON.parse(fs.readFileSync(path.join(runs, f), "utf8")); } catch (e) { return null; } // (a run that just reserved its file)
	const p = (w.players || []).find((x) => x.code_status && x.code_status.format === "chronal-fidelity/1");
	return p && p.code_status.phase === "done" ? { R: p.code_status, seed: w.run && w.run.seed, id: w.id } : null;
}).filter(Boolean);
const lives = opt.files.map((f) => ({ R: JSON.parse(fs.readFileSync(f, "utf8")), file: path.basename(f) }));
if (!sims.length) return void console.error(`no finished fidelity runs${opt.name ? " named " + opt.name : ""} in ${runs}`);

// ---- the metrics: per window hour, per hit, per kill
const H = (R) => R.cfg.minutes / 60, T = (R) => R.totals;
const ratio = (a, b) => (b ? a / b : null), mean = (o) => (o && o.n ? o.sum / o.n : null);
const shots = (R) => Object.values(T(R).shots).reduce((a, b) => a + b, 0);
const M = [
	["kills /h", (R) => T(R).kills / H(R)],
	["xp /h", (R) => T(R).xp / H(R)],
	["gold /h", (R) => T(R).gold / H(R)],
	["xp per kill", (R) => ratio(T(R).xp, T(R).kills)],
	["damage dealt /h", (R) => T(R).dmg / H(R)],
	["shots /h", (R) => shots(R) / H(R)],
	["damage per hit", (R) => mean(R.dmg.attack)],
	["evaded share", (R) => ratio(T(R).evaded, T(R).hits + T(R).evaded + T(R).missed)],
	["crit share", (R) => ratio(T(R).crits, T(R).hits)],
	["time to kill (s)", (R) => mean(R.ttk) / 1000],
	["shots per kill", (R) => mean(R.shots_per_kill)],
	["damage taken /h", (R) => T(R).taken / H(R)],
	["hits taken /h", (R) => T(R).hits_taken / H(R)],
	["hp potions /h", (R) => T(R).hp_pots / H(R)],
	["mp potions /h", (R) => T(R).mp_pots / H(R)],
	["deaths /h", (R) => T(R).deaths / H(R)],
	["chests /h", (R) => T(R).chests / H(R)],
	["items looted /h", (R) => T(R).items / H(R)],
	["healed by others /h", (R) => (T(R).healed == null ? null : T(R).healed / H(R))],
	["monster level (mean)", (R) => (R.mlevel && R.mlevel.n ? R.mlevel.sum / R.mlevel.n : null)],
	["kites /h", (R) => T(R).kites / H(R)],
	["idle share", (R) => T(R).idle_ms / (R.cfg.minutes * 60000)],
	["at the seller: sell, buy, heal (s)", (R) => R.stock_ms / 1000],
	["trip to the spot (s)", (R) => R.travel_ms / 1000],
];
// what makes a live run unlike the sim's world (none of it is in the sim; a condition the sim runs had too, such as
// mluck from a merchant of the account, isn't)
const simConds = new Set(sims.flatMap((s) => Object.keys(s.R.cond_ms || {})));
const flags = (R) => {
	const out = [], t = T(R);
	if (R.phase !== "done") out.push(`phase ${R.phase}: the window didn't end`);
	if (t.samples && t.others_near / t.samples > 0.05) out.push(`other players near ${((100 * t.others_near) / t.samples).toFixed(0)}% of the samples`);
	if (t.spot_deaths > t.kills) out.push(`${t.spot_deaths - t.kills} of the spot's monsters died to others`);
	for (const k of Object.keys(R.cond_ms || {})) if (!/^encouragement_/.test(k) && !simConds.has(k)) out.push(`${k} on ${((100 * R.cond_ms[k]) / (R.cfg.minutes * 60000)).toFixed(0)}% of the window`);
	// a hidden game tab: the browser runs its timers about once a second, so each throttled second lacks most of its ticks
	const thr = throttled(R);
	if (thr > 0.02 * R.cfg.minutes * 60) out.push(`the CODE loop throttled about ${Math.round(thr)} s (${((100 * thr) / (R.cfg.minutes * 60)).toFixed(0)}% of the window; longest gap ${(R.loop.max / 1000).toFixed(1)} s): the game window was hidden`);
	return out;
};
// the window's seconds at one tick a second (its ticks short of one per period)
const throttled = (R) => (R.loop && R.loop.n ? Math.max(0, (R.cfg.minutes * 60000) / R.cfg.period_ms - R.loop.n) / (1000 / R.cfg.period_ms - 1) : 0);
const sd = (xs) => { const m = xs.reduce((a, b) => a + b, 0) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, xs.length - 1)); };
const fmt = (v) => (v == null || !isFinite(v) ? "-" : Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e4 ? (v / 1e3).toFixed(1) + "k" : Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

const R0 = sims[0].R;
console.log(`${sims.length} sim runs (seeds ${sims.map((s) => s.seed).join(", ")}): ${R0.cfg.preset}, warm-up ${R0.cfg.warmup_s} s, window ${R0.cfg.minutes} min, server hour ${R0.window.server_hour}, ping ${fmt(mean(R0.ping))} ms`);
for (const l of lives) console.log(`live ${l.file}: ${l.R.server.region} ${l.R.server.id}, ${l.R.window ? "window from " + l.R.window.at + ", server hour " + l.R.window.server_hour : "no window"}, ping ${fmt(mean(l.R.ping))} ms`);
// the starting stats: the same character on both sides
const st = ["level", "attack", "frequency", "armor", "resistance", "max_hp", "max_mp", "speed", "range"];
for (const l of lives) {
	const a = R0.window.stats, b = l.R.window && l.R.window.stats, diff = b ? st.filter((k) => a[k] !== b[k] && !(typeof a[k] === "number" && Math.abs(a[k] - b[k]) < 1e-6)) : [];
	if (diff.length) console.log(`  ${l.file}: the character differs at the window's start: ${diff.map((k) => `${k} sim ${fmt(a[k])} live ${fmt(b[k])}`).join(", ")}`);
	for (const f of flags(l.R)) console.log("  ! " + f);
}
const rows = M.map(([label, f]) => {
	const xs = sims.map((s) => f(s.R)).filter((v) => v != null && isFinite(v)), m = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, s = xs.length > 1 ? sd(xs) : null;
	const row = [label, fmt(m) + (s != null ? " ± " + fmt(s) : ""), m ? ((100 * (s || 0)) / Math.abs(m)).toFixed(0) + "%" : "-"];
	for (const l of lives) {
		const v = f(l.R);
		row.push(fmt(v), v != null && m ? ((100 * v) / m).toFixed(0) + "%" : "-", v != null && s ? ((v - m) / s).toFixed(1) : "-");
	}
	return row;
});
const head = ["metric", "sim", "sim cv", ...lives.flatMap((_, i) => [`live ${lives.length > 1 ? i + 1 : ""}`.trim(), "live/sim", "z"])];
const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
const line = (r) => r.map((c, i) => (i ? String(c).padStart(w[i]) : String(c).padEnd(w[i]))).join("  ");
console.log("\n" + line(head) + "\n" + line(w.map((n) => "-".repeat(n))));
for (const r of rows) console.log(line(r));
