"use strict";
// chronal run: run a setup in the sim (headless): any CODE, from anywhere, described by one JSON file
// (docs/reference/setup.md).
//   chronal run <setup.json | <id>.setup.json> [--duration 2h] [--warmup 2m] [--world-age 2h] [--ping 18] [--seed N] [--start ISO]
//              [--age-days N] [--tag T] [--live DIR | --no-live] [--result out.json] [--no-build] [--current-code]
//              [--record] [--check] [--code-set NAME [--missing NAME=SLOT|idle|exclude,...]] [--trust]
//   chronal run --code my.js [--dir modules/] --class ranger [--name Ranger1] [--level 40] [--at main:0:0] [--farm squigtoad] [--duration 30m] [...]
// <id>.setup.json: a run's resolved setup (beside its snapshot): the run again, with its stored CODE and states
// (--current-code: the CODE its source gives now, build hook included). Live snapshots go to --live DIR, else config
// live_dir; --no-live: none. --tag: the card's title (default the setup's name). --check validates and resolves,
// prints one JSON line and runs nothing. --result: the numbers as JSON (per character). --no-build (or env
// CHRONAL_NO_BUILD): the setup's build hooks don't run.
// --code-set NAME: every character's CODE from that set instead of the setup's (lib/code_sets.js: the config code_sets
// file's sets, pull:latest / pull:<account>[/<time>], dir:<path>, file:<path>, any but a pull @<rev>: at a git
// revision, e.g. local@HEAD~1; chronal code-sets lists them). A character the set has no entry for (on live: no CODE
// loaded for it) takes --missing's choice (NAME=<slot of the set>, idle: in game with no CODE, exclude: out of the run
// and its party; *=... for all), else the one asked on a terminal; without either the run stops and lists them. With a
// run's <id>.setup.json: its characters and states as they were, their CODE from the set (a new version of it, another
// set); exclude is not for it.
// Others' CODE (the CODE library's, lib/library.js) runs at a commit trusted here: one not trusted yet is shown (where
// it comes from, what it reaches) and asked about on a terminal; --trust trusts it without asking; else the run stops.
// --record: a replay recording per character beside the snapshot (<id>.rec/, docs/reference/recording.md).
// The run: the world's age (world.age, --world-age: the server runs with no characters before they log in), the
// warm-up, then the duration (or until run.until holds), the setup's steering at its times and conditions (start.js
// steerer, lib/steer.js: run.until and the conditions checked every run.check (1 s) against the run's snapshot, so they
// need live snapshots); SIGINT/SIGTERM or the dashboard's Stop end it at the next game minute. A CODE that asks for a
// slot its setup doesn't give (require_code, load_code) fails the run (--check warns of the literal names it finds).
// Exit 0 done or stopped, 1 failed, 2 usage or setup problems.
const fs = require("node:fs"),
	path = require("node:path");
const { FORMAT, loadSetup, resolveSetup, runBuild, parseDuration, codeHash } = require("../lib/setup");
const { config } = require("../lib/config");
const { codeSet, missingEntries, parseMissing, chooseMissing } = require("../lib/code_sets");
const LIB = require("../lib/library");
const { startSetup, steerer, STAT, STATS, xpTotal } = require("./start");

const USAGE = `usage: chronal run <setup.json | <id>.setup.json> [--duration 2h] [--warmup 2m] [--world-age 2h] [--ping 18] [--seed N] [--start ISO]
                  [--age-days N] [--tag T] [--live DIR | --no-live] [--result out.json] [--no-build] [--current-code]
                  [--record] [--check] [--code-set NAME [--missing NAME=SLOT|idle|exclude,...]] [--trust]
       chronal run --code my.js [--dir DIR] --class ranger [--name N] [--level 40] [--at map:x:y] [--farm type[,type]] [--duration 30m] [...]`;
const VALUE = ["--duration", "--warmup", "--world-age", "--seed", "--age-days", "--ping", "--start", "--code-set", "--missing", "--tag", "--live", "--result", "--code", "--dir", "--class", "--name", "--level", "--at", "--farm"],
	FLAG = ["--no-live", "--no-build", "--current-code", "--record", "--check", "--trust", "--help"];

function usage(msg) {
	if (msg) console.error("chronal run: " + msg);
	console.error(USAGE);
	process.exit(2);
}

function args(argv) {
	const o = { files: [] };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (VALUE.includes(a)) {
			if (i + 1 >= argv.length) usage(`${a} needs a value`);
			o[a.slice(2)] = argv[++i];
		} else if (FLAG.includes(a)) o[a.slice(2)] = true;
		else if (a.startsWith("--")) usage(`unknown option ${a}`);
		else o.files.push(a);
	}
	return o;
}

// --code-set: the characters the set has no entry for (on live: no CODE loaded for them) take --missing's choice, else
// the one asked for on a terminal (a slot of the set, idle or exclude); without either the run stops (exit 2), listing
// them (--check: as `missing: [{ name, entry, slots }]` too). -> { <name>: "slot:<slot>" | "idle" | "exclude" }
async function missingChoices(o, set, build, stop) {
	let raw;
	try {
		raw = JSON.parse(fs.readFileSync(o.files[0], "utf8"));
	} catch (e) {
		return {}; // loadSetup says what's wrong with the file
	}
	if (!raw || !Array.isArray(raw.characters)) return {};
	// (a run's side file: its characters' extra as its source recorded it)
	const side = "resolved" in raw,
		characters = raw.characters.filter((c) => c && typeof c.name === "string").map((c) => ({ name: c.name, extra: side ? ((raw.source && raw.source.characters && raw.source.characters[c.name]) || {}).extra || [] : c.extra ?? (raw.defaults && raw.defaults.extra) ?? [] }));
	const classOf = (n) => (raw.characters.find((c) => c && c.name === n) || {}).class || null;
	return chooseMissing(missingEntries(set, characters.map((c) => c.name), { build: build ? runBuild : null, classOf, code_names: raw.code_names && typeof raw.code_names === "object" ? raw.code_names : null }), {
		given: o.missing != null ? parseMissing(o.missing) : {}, characters, check: !!o.check, stop,
		what: (m) => `${m.name}: the CODE set ${set.name} has no slot ${m.entry}${set.kind === "pull" ? " (no CODE loaded for it on live)" : ""}`,
		where: set.name,
	});
}

// others' CODE among [[who, code spec]] at a commit not trusted here (library.js): --trust trusts it, else it's asked
// about on a terminal (its source, commit, what it reaches); without either the run stops (exit 2; --check:
// `untrusted: [{ name, commit, web }]` too)
async function trustOrStop(o, list, stop) {
	const no = LIB.untrusted(list);
	if (!no.length) return;
	if (no.some((u) => !u.commit)) return stop(no.filter((u) => !u.commit).map(LIB.untrustedText));
	if (o.trust) {
		for (const u of no) LIB.trust(u.commit, { name: u.name, source: u.web, by: "chronal run --trust" }), console.error(`trusted CODE ${u.name} at ${u.commit.slice(0, 7)}${u.web ? ` (${u.web})` : ""}`);
		return;
	}
	if (!o.check && process.stdin.isTTY && process.stdout.isTTY && (await LIB.ask(no, { by: "chronal run" }))) return;
	stop([...no.map(LIB.untrustedText), "(--trust: trust it without asking)"], { untrusted: no.map(({ name, commit, web }) => ({ name, commit, web })) });
}

// --code FILE --class C: a one-character setup (--dir: its slots for require_code)
function quick(o) {
	if (!o.class) usage("--code needs --class");
	const at = o.at || null,
		m = at && /^([\w-]+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(at),
		level = o.level != null ? Number(o.level) : null,
		monsters = o.farm ? o.farm.split(",").filter(Boolean) : null;
	if (at && !m) usage(`--at ${at}: map:x:y`);
	const name = o.name || o.class[0].toUpperCase() + o.class.slice(1) + "1";
	return {
		format: FORMAT,
		name: `${o.class}${level ? " L" + level : ""} ${path.basename(o.code, ".js")}${monsters ? " @ " + monsters.join("/") : ""}`,
		characters: [{
			name, class: o.class, ...(level != null ? { state: { level } } : {}), ...(at ? { at } : {}), code: { file: path.resolve(o.code), ...(o.dir ? { dir: path.resolve(o.dir) } : {}) },
			...(monsters ? { params: { farm: { ...(m ? { map: m[1], x: +m[2], y: +m[3] } : {}), monsters } } } : {}),
		}],
	};
}

// require_code / load_code of a literal name that isn't in the character's slots, or of a slot number, in its entry and the slots it loads
// that way (a name made at run time is not seen): the run fails when that call runs
function missingSlots(resolved, bundles) {
	const out = [],
		CALL = /\b(require_code|load_code)\s*\(\s*(["'])([^"'\\\n]+)\2/g,
		NUM = /\b(require_code|load_code)\s*\(\s*(\d+)\s*[,)]/g;
	for (const c of resolved.characters) {
		const files = bundles[c.name].files,
			lower = new Map(Object.keys(files).map((k) => [k.toLowerCase(), k])),
			seen = new Set(),
			todo = [bundles[c.name].text];
		while (todo.length) {
			const text = todo.pop();
			// a slot number the fit didn't name (code.fit.calls): the sim knows slots by name
			for (const [, call, n] of text.matchAll(NUM)) out.push(`${c.name}: its CODE calls ${call}(${n}), a slot number: the run fails there (name its slot in code.fit.calls, docs/reference/library.md)`);
			for (const [, call, , name] of text.matchAll(CALL)) {
				const k = Object.hasOwn(files, name) ? name : lower.get(name.toLowerCase());
				if (k == null) out.push(`${c.name}: its CODE calls ${call}("${name}"), and the setup gives it no slot ${name}: the run fails there`);
				else if (!seen.has(k)) seen.add(k), todo.push(files[k]);
			}
		}
	}
	return [...new Set(out)];
}


const main = (argv) => (async () => {
	const o = args(argv);
	if (o.help) return console.log(USAGE), process.exit(0);
	if (!o.code && o.files.length !== 1) usage(o.files.length ? "one setup file" : null);
	if (o["no-live"] && o.live) usage("--live or --no-live");
	const overrides = { run: {}, world: {} };
	if (o.duration != null) overrides.run.duration = /^\d+(\.\d+)?$/.test(o.duration) ? Number(o.duration) : o.duration;
	if (o.warmup != null) overrides.run.warmup = /^\d+(\.\d+)?$/.test(o.warmup) ? Number(o.warmup) : o.warmup;
	if (o["world-age"] != null) overrides.world.age = /^\d+(\.\d+)?$/.test(o["world-age"]) ? Number(o["world-age"]) : o["world-age"];
	if (o.ping != null) overrides.world.ping = Number(o.ping);
	if (o.start != null) overrides.world.start = o.start;
	if (o.seed != null) overrides.run.seed = Number(o.seed);
	if (o["age-days"] != null) overrides.age_days = Number(o["age-days"]);
	const build = !(o["no-build"] || process.env.CHRONAL_NO_BUILD),
		liveDir = o["no-live"] ? null : o.live ? path.resolve(o.live) : config().live_dir;
	if (o.missing != null && o["code-set"] == null) usage("--missing: with --code-set");
	if (o["current-code"] && o["code-set"] != null) usage("--current-code or --code-set, not both");
	const stop = (problems, extra = {}) => {
		if (o.check) process.stdout.write(JSON.stringify({ ok: false, problems, ...extra }) + "\n");
		else console.error(problems.join("\n"));
		process.exit(2);
	};
	if (o["code-set"] != null) {
		if (o.code) usage("--code-set: for a setup file (not --code)");
		try {
			overrides.code_set = codeSet(o["code-set"]);
		} catch (e) {
			stop([e.message]);
		}
		// (before its build: the set's missing entries are found once it's built)
		await trustOrStop(o, [["every character", overrides.code_set.code]], stop);
		try {
			overrides.missing = await missingChoices(o, overrides.code_set, build, stop);
		} catch (e) {
			stop([e.message]);
		}
	}
	let setup, r;
	try {
		setup = loadSetup(o.code ? quick(o) : o.files[0], { overrides });
		if (o["current-code"] && !setup.side) throw Object.assign(new Error("--current-code: only for a run's <id>.setup.json (a setup file always reads its current CODE)"), { problems: ["--current-code is for a run's <id>.setup.json"] });
	} catch (e) {
		if (!e.problems) throw e;
		stop(o.check ? e.problems : [e.message]);
	}
	if (!setup.side) await trustOrStop(o, setup.characters.map((c) => [c.name, c.code]), stop);
	try {
		// a side file's CODE: its own live dir's store, else this run's and the configured live dir's (a downloaded file)
		r = resolveSetup(setup, { build, currentCode: !!o["current-code"], by: "chronal run", store: [...new Set([liveDir, config().live_dir].filter(Boolean))].map((d) => path.join(d, "code")) });
	} catch (e) {
		if (!e.problems) throw e;
		stop(o.check ? e.problems : [e.message]);
	}
	const { resolved, bundles } = r,
		run = resolved.run;
	const warnings = [...r.warnings, ...missingSlots(resolved, bundles)];
	if (o.check) {
		const other = o["current-code"] || (setup.side && setup.code_set),
			stored = r.stored ? codeHash({ characters: resolved.characters.map((c) => ({ name: c.name, code: { hash: r.stored[c.name] } })) }) : null;
		process.stdout.write(JSON.stringify({
			ok: true, name: resolved.name, ...(setup.code_set ? { code_set: setup.code_set } : {}), run: { duration_ms: parseDuration(run.duration), warmup_ms: parseDuration(run.warmup), seed: run.seed }, world: { age_ms: parseDuration(resolved.world.age), ping: resolved.world.ping, start: resolved.world.start, seasons: resolved.world.seasons, events: resolved.world.events },
			accounts: Object.fromEntries(Object.entries(resolved.accounts).map(([k, a]) => [k, { age_days: a.age_days }])),
			characters: resolved.characters.map((c) => ({ name: c.name, class: c.class, account: c.account, entry: c.code.entry, code_hash: c.code.hash, ...(other ? { code_hash_stored: r.stored[c.name] } : {}) })),
			code_hash: codeHash(resolved), ...(other ? { code_hash_stored: stored } : {}), warnings,
		}) + "\n");
		process.exit(0);
	}
	if (!liveDir && (run.until != null || (resolved.steer || []).some((e) => e.when != null))) usage("run.until and steering conditions read the run's snapshot: they need live snapshots (not --no-live)");
	for (const w of warnings) console.error("warning: " + w);
	const warm = parseDuration(run.warmup),
		duration = parseDuration(run.duration),
		t0 = performance.now();
	const { sim, order } = await startSetup(resolved, bundles, { live: liveDir ? { dir: liveDir, tag: o.tag, setup: { resolved, bundles, from: setup.file } } : false, record: !!o.record });
	const age = parseDuration(resolved.world.age);
	console.log(`${resolved.name}: boot + ${age ? `world age ${age / 60e3} min + ` : ""}login ${Math.round(performance.now() - t0)} ms | ping ${resolved.world.ping} ms | ${setup.code_set ? `CODE set ${setup.code_set.name} | ` : ""}${resolved.characters.map((c) => `${c.name} (${c.class} L${c.state.level}, ${c.code.entry} ${c.code.hash})`).join(", ")}${resolved.party && resolved.party.form === "harness" ? " | party" : ""}`);
	if (sim.live) console.log(`live: ${sim.live.file}\nsetup: ${path.join(sim.live.dir, sim.live.meta.setup.file)}`);
	if (sim.live) sim.live.plan({ duration_ms: duration, warmup_ms: warm, until: run.until });
	// the setup's steering, at its times from the measured part's start (after the warm-up)
	const steer = steerer(sim, resolved, { log: (e) => console.log(`steer ${e.why}${e.character ? " @" + e.character : ""} ${e.what}: ${[...e.did, ...e.errors.map((x) => "not run: " + x)].join(", ") || "nothing"}`) });
	// --result: { seed, warm, minutes, vmin, speed, real_s, halted, setup, live, characters, fighter, merchant }
	const result = ({ characters = {}, fighter = null, merchant = null, ...m }) => {
		if (!o.result) return;
		const f = path.resolve(o.result);
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, JSON.stringify({ seed: run.seed, warm: warm / 60e3, minutes: duration / 60e3, ...m, setup: sim.live ? path.join(sim.live.dir, sim.live.meta.setup.file) : null, live: sim.live ? sim.live.file : null, characters, fighter, merchant }, null, 1));
	};
	// failed (a CODE asked for a slot the setup doesn't give): ended "failed", no result
	const failed = async () => {
		await sim.close();
		console.error("FAILED: " + sim.failed);
		process.exit(1);
	};
	// the warm-up: played, not measured (the snapshot's base, its 0:00, is its end)
	if (warm) {
		if (sim.live) sim.live.measureFrom(sim.clock.now + warm);
		await sim.run(warm);
	}
	steer.start();
	// the forced dailies and nightlies (world.events): at their game times from here, set as the server's own schedule
	// sets them (its var events), each marked in the snapshot
	for (const e of resolved.world.events || [])
		sim.clock.at(sim.clock.now + parseDuration(e.at), () => {
			sim.server.events[e.event] = true;
			if (sim.live) sim.live.forced(e);
			console.log(`event ${e.event} forced at ${e.at}`);
		});
	if (sim.failed) await failed();
	// halted (a signal, the dashboard's Stop) before the measured part: nothing measured
	if (sim.halted) {
		console.log(`halted (${sim.halted}) before the measured part`);
		result({ vmin: 0, speed: 0, real_s: 0, halted: true });
		await sim.close();
		process.exit(0);
	}
	const levels = await order[0].query("G.levels");
	const q0 = {};
	for (const c of order) q0[c.name] = await c.query(STAT);
	// characters that come and go (start_character, stop_character, a page's disconnect()): the last reading of each
	// one that left, and the kills and deaths of its sessions so far (a new session's game log starts empty)
	const left = {},
		past = {};
	const now = (name) => {
		for (let i = sim.clients.length - 1; i >= 0; i--) if (sim.clients[i].name === name) return sim.clients[i].online === false ? null : sim.clients[i];
		return null;
	};
	if ("onLeave" in sim)
		sim.onLeave = (cl, reason) => {
			const a = cl.querySync(STAT),
				p = (past[cl.name] ||= { kills: 0, deaths: 0 });
			(p.kills += a.kills), (p.deaths += a.deaths);
			left[cl.name] = { a: { ...a, kills: p.kills, deaths: p.deaths }, x: cl.querySync(STATS), reason };
		};
	// the duration, or until run.until holds (checked every run.check with the steering conditions: steer.js)
	const res = await steer.run(duration, { untilT0: sim.clock.now });
	if (res.until) (sim.ended = `until: ${run.until} at ${(res.virtualMs / 60e3).toFixed(1)} game min`), console.log(sim.ended);
	for (const x of [steer.steering.until && { what: "run.until", error: steer.steering.until.error }, ...steer.steering.steps.map((st) => ({ what: `steer[${st.i}] when`, error: st.error }))])
		if (x && x.error) console.error(`warning: ${x.what}: ${x.error} (read as false)`);
	if (sim.failed) await failed();
	console.log(`${sim.halted ? `${(res.virtualMs / 60e3).toFixed(1)} of ${duration / 60e3} vmin (halted: ${sim.halted})` : `${(res.virtualMs / 60e3).toFixed(1)} vmin`} after ${warm / 60e3} warm-up: ${Math.round(res.speed)}x (${(res.realMs / 1000).toFixed(1)} s real)`);
	const characters = {};
	for (const rc of resolved.characters) {
		const c = now(rc.name);
		let a, extra;
		if (c) {
			(a = await c.query(STAT)), (extra = await c.query(STATS));
			const p = past[rc.name];
			if (p) a = { ...a, kills: a.kills + p.kills, deaths: a.deaths + p.deaths };
		} else if (left[rc.name]) ({ a, x: extra } = left[rc.name]);
		else {
			// never in game (online: false, not started)
			characters[rc.name] = { name: rc.name, ctype: rc.class, level: rc.state.level, start_level: rc.state.level, xp: 0, xp_h: 0, gold: rc.state.gold, gold_gained: 0, kills: 0, deaths: 0, online: false };
			console.log(`${rc.name.padEnd(12)} L${rc.state.level} never in game`);
			continue;
		}
		// (from the measured part's start; a character that logged in later: from its start state)
		const b = q0[rc.name] || { l: rc.state.level, xp: rc.state.xp, g: rc.state.gold, kills: 0, deaths: 0 };
		const gained = xpTotal(levels, a) - xpTotal(levels, b),
			xp_h = res.virtualMs ? (gained / res.virtualMs) * 3600e3 : 0;
		characters[rc.name] = { ...extra, level: a.l, start_level: b.l, xp: gained, xp_h, gold: a.g, gold_gained: a.g - b.g, kills: a.kills - b.kills, deaths: a.deaths - b.deaths, map: a.map, mode: a.mode, lonewolf: a.lw, slots: a.slots, online: !!c };
		console.log(`${rc.name.padEnd(12)} L${a.l} xp ${(gained / 1e6).toFixed(2)}M (${(xp_h / 1e6).toFixed(1)}M/h) kills ${a.kills - b.kills} deaths ${a.deaths - b.deaths} gold ${a.g - b.g >= 0 ? "+" : ""}${a.g - b.g} ${a.map} ${a.mode}${a.lw ? " lone wolf" : ""}${extra.party ? " party " + extra.party : ""}${c ? "" : ` (left: ${left[rc.name].reason})`}`);
	}
	const fighter = resolved.characters.find((c) => c.class !== "merchant"),
		merchant = resolved.characters.find((c) => c.class === "merchant");
	result({
		vmin: res.virtualMs / 60e3, speed: res.speed, real_s: res.realMs / 1000, halted: !!sim.halted, characters, fighter: fighter ? characters[fighter.name] : null,
		merchant: merchant ? { deaths: characters[merchant.name].deaths, map: characters[merchant.name].map, mode: characters[merchant.name].mode } : null,
	});
	await sim.close();
	process.exit(0);
})().catch((e) => {
	console.error("FAILED:", (e && e.stack) || e);
	process.exit(1);
});

module.exports = { main };
