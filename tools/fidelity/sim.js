#!/usr/bin/env node
"use strict";
// Sim runs of the fidelity CODE (tools/fidelity/fidelity.js) for one character, one run per seed, matched to a live run
// when given its record: the same spot, warm-up and window, the world's clock at the same server hour, the live ping,
// the account's age then, the seasons the live server had on, the character's level, and mluck from a merchant of the
// account (that merchant in the run, casting it). docs/how-to/check-against-live.md.
//   node tools/fidelity/sim.js --live fidelity-<name>-<start>.json --seeds 1-6
//   node tools/fidelity/sim.js --char NAME --preset iceroamer --minutes 10 --seeds 1-6
// --pull ACCOUNT/TIME (default: the newest pull holding the character), --world-age 1h (monsters grown, as at a spot
// nobody farmed; the world starts that much earlier, the login stays at the matched time), --start ISO (the login's), --ping MS, --warmup S, --name N, --jobs N (default 4), --out DIR (default
// <live_dir>/fidelity: apart from the dashboard's runs; setups in its setups/)
const fs = require("node:fs"),
	path = require("node:path"),
	{ spawn } = require("node:child_process");
const { config } = require("../../lib/config");
const P = require("../../lib/pull");

const ROOT = path.resolve(__dirname, "..", "..");
const CODE = path.join(__dirname, "fidelity.js");
const SIM_OFFSET = -5; // the sim's server is US (lib/schedule.js)
const SEASONS = require("../../lib/schedule").SEASONS;

const args = process.argv.slice(2), opt = {};
for (let i = 0; i < args.length; i++) {
	const k = args[i].replace(/^--/, "");
	opt[k] = i + 1 < args.length && !args[i + 1].startsWith("--") ? args[++i] : true;
}
const fail = (m) => (console.error("fidelity sim: " + m), process.exit(2));
if (opt.help) return void console.log(fs.readFileSync(__filename, "utf8").split("\n").slice(2, 10).join("\n"));
const live = opt.live ? JSON.parse(fs.readFileSync(opt.live, "utf8")) : null;
const who = opt.char || (live && live.name);
if (!who) fail("--live RECORD or --char NAME");
const seeds = String(opt.seeds || "1-5").replace(/^(\d+)-(\d+)$/, (_, a, b) => Array.from({ length: b - a + 1 }, (_, i) => +a + i).join(","));

// the pull: the one given, else the newest holding the character
const pulls = P.listPulls(config().pulls_dir).sort((a, b) => (a.meta.pulled_at < b.meta.pulled_at ? 1 : -1));
const pick = opt.pull ? pulls.find((p) => p.account + "/" + path.basename(p.dir) === opt.pull) : pulls.find((p) => p.meta.characters.some((c) => c.name === who));
if (!pick) fail(opt.pull ? `no pull ${opt.pull} in ${config().pulls_dir}` : `no pull holds ${who} (chronal pull)`);
const pull = pick.account + "/" + path.basename(pick.dir), meta = pick.meta;

// the window and spot: the live run's, else the options'
const cfg = { ...(live ? live.cfg : {}), ...(opt.preset ? { preset: opt.preset } : {}), ...(opt.minutes ? { minutes: +opt.minutes } : {}), ...(opt.warmup ? { warmup_s: +opt.warmup } : {}) };
cfg.preset ||= "iceroamer";
cfg.minutes ||= 10;
cfg.warmup_s ??= 120;
cfg.runs = 1; // a seed is one run (a live series is a record per run, each matched on its own)
const notes = [], fl = ["new", "--pull", pull, "--no-party", "--code-set", "file:" + CODE, "--param", who + "=" + JSON.stringify({ fidelity: cfg })];
const chars = [who];
if (live) {
	// the level the live run had (a pull taken a level earlier: the rest of the character as pulled)
	const lv = live.window && live.window.stats && live.window.stats.level, pc = meta.characters.find((c) => c.name === who);
	if (lv && pc && pc.level !== lv) (fl.push("--level", who + "=" + lv), notes.push(`${who} at L${lv} as on live (the pull's L${pc.level})`));
	// Merchant's Luck on live: from a merchant of the account, that merchant in the sim, beside the fighter, casting it
	const ml = (live.encouragement && live.encouragement.start && live.encouragement.start.mluck) || (live.conditions0 && live.conditions0.mluck), giver = ml && ml.f;
	const gm = giver && meta.characters.find((c) => c.name === giver && c.class === "merchant");
	if (gm) {
		const fx = JSON.parse(fs.readFileSync(path.join(pick.dir, who + ".json"), "utf8")).character;
		chars.push(giver);
		fl.push("--at", `${giver}=${fx.map}:${Math.round(fx.x)}:${Math.round(fx.y)}`, "--param", giver + "=" + JSON.stringify({ fidelity_mluck: { target: who } }));
		notes.push(`mluck from ${giver}, as on live`);
	} else if (giver) notes.push(`mluck from ${giver} on live: another player's, not in the sim`);
}
fl.push("--chars", chars.join(","));
// the run long enough for the stop at the seller, the trip (well under 2 minutes from town), the warm-up and the window
fl.push("--duration", Math.ceil(3 + cfg.warmup_s / 60 + cfg.minutes) + "m");
// the world's age (it runs that long before the login: the clock's start moves back by it)
const span = (v) => { const m = /^(\d+(?:\.\d+)?)(s|m|h|d)$/.exec(String(v)); return m ? +m[1] * { s: 1e3, m: 60e3, h: 3600e3, d: 864e5 }[m[2]] : null; };
const age = opt["world-age"] ? span(opt["world-age"]) : 0;
if (age == null) fail(`--world-age ${opt["world-age"]}: 90s, 30m, 6h, 1d`);
if (live) {
	// the clock: the sim's server hour at the login as the live one's when the live run started
	const t = Date.parse(live.started_at), shift = ((live.server.time_offset || 0) - SIM_OFFSET) * 3600e3;
	fl.push("--start", new Date(t + shift - age).toISOString().replace(/\.\d+Z$/, "Z"));
	if (live.ping && live.ping.n) fl.push("--ping", String(Math.round(live.ping.sum / live.ping.n)));
	for (const s of (live.events || []).filter((e) => SEASONS.includes(e))) fl.push("--season", s);
	// the account's age when the live run started (the New Player phases follow it)
	if (meta.account_age && meta.account_age.created) fl.push("--account-age", pick.account + "=" + ((t - Date.parse(meta.account_age.created)) / 864e5).toFixed(3));
	notes.push(`live ${live.started_at} on ${live.server.region} ${live.server.id}: server hour ${live.window && live.window.server_hour}, ping ${fl[fl.indexOf("--ping") + 1] || "-"}, events ${(live.events || []).join(", ") || "none"}`);
}
if (opt.start) fl.push("--start", new Date(Date.parse(opt.start) - age).toISOString().replace(/\.\d+Z$/, "Z"));
if (opt.ping) fl.push("--ping", String(opt.ping));
if (opt["world-age"]) fl.push("--world-age", String(opt["world-age"]));
const name = opt.name || `fid-${cfg.preset}-${cfg.minutes}m${live ? "-live" + live.started_at.slice(5, 16).replace(/[-:T]/g, "") : ""}`;
const out = path.resolve(opt.out || path.join(config().live_dir, "fidelity"));
fs.mkdirSync(path.join(out, "setups"), { recursive: true });
// runs of this name from before: replaced (compare.js would count them with the new ones)
const old = fs.readdirSync(out).filter((f) => f.startsWith(name + "-s") && /^[^.]+-s\d+--\d+\./.test(f));
for (const f of old) fs.rmSync(path.join(out, f));
if (old.length) notes.push(`replaced the earlier runs named ${name}`);
console.log(`pull ${pull}; ${name}: ${who} at ${cfg.preset}, warm-up ${cfg.warmup_s} s, window ${cfg.minutes} min, seeds ${seeds}`);
for (const n of notes) console.log(n);
// a chronal run per seed, each named <name>-s<seed> (a run's files are named <name>--<the real ms it started>: two
// seeds of one name starting in the same ms would write one file), --jobs at once
const queue = seeds.split(","), jobs = Math.max(1, +(opt.jobs || 4));
let failed = 0;
const one = (seed) => new Promise((ok) => {
	const n = `${name}-s${seed}`, c = spawn(process.execPath, [path.join(ROOT, "chronal.js"), ...fl, "--name", n, "--save", path.join(out, "setups", n + ".json"), "--force", "--run", "--seeds", seed, "--live", out], { cwd: ROOT });
	let log = "";
	c.stdout.on("data", (d) => (log += d));
	c.stderr.on("data", (d) => (log += d));
	c.on("close", (code) => {
		const done = log.split("\n").find((l) => l.startsWith("done "));
		console.log(code ? `seed ${seed} failed (exit ${code}):\n${log.trim().split("\n").slice(-5).join("\n")}` : done || `seed ${seed}: done`);
		if (code) failed++;
		ok();
	});
});
(async () => {
	await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => { while (queue.length) await one(queue.shift()); }));
	console.log(`\nnode tools/fidelity/compare.js --name ${name}${opt.out ? " --runs " + out : ""}${opt.live ? " " + opt.live : ""}`);
	if (failed) process.exit(1);
})();
