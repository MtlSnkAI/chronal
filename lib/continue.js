"use strict";
// chronal continue: a setup that goes on from where a run was (its state export: sim/export.js), so a long progression
// runs as stages: each character from its exported state (state.from: raw items and gear, server state, hp; at its
// place), each account from its bank, cash, link, age and pages' storage; the world's clock from the export's time.
//   chronal continue <run id | <id>.json | <id>.setup.json> [--label end] [--live DIR] [--duration D] [--seed N]
//                    [--start ISO] [--seasons a,b | none] [--at end | spawn] [--reseed ACCOUNT,...] [--save FILE] [--run [-- run options]]
// The run's resolved setup (<id>.setup.json) gives the characters, their CODE (as its source gives it now: dir, file,
// entry, appends, extras, build), params, roles, the party, the world (seasons, ping, spawns); a run's own world age,
// warm-up, forced events and steering are not carried (they were the first stage's). --at spawn: every fighter at its
// map's first spawn (a fighter in a fight comes back before its CODE runs again; a live session has no such break).
// --reseed: those accounts' characters and bank as the run's setup gave them (a market account that starts each stage
// fresh). --save (default <id>.state/<label>/continue.setup.json) writes it; --run runs it (chronal run, the options
// after --).
const fs = require("node:fs"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { config } = require("./config");
const S = require("./setup");
const STATE_KEYS = ["level", "xp", "gold", "items", "slots", "skin", "cx", "p", "s"];
const VALUED = ["label", "live", "duration", "seed", "start", "seasons", "at", "reseed", "save"];

/**
 * The continuation setup of a run's state export.
 * @param {string} sideFile <id>.setup.json; @param {string} stateDir <id>.state/<label>/
 * @param {object} o duration, seed, start (ISO), seasons ([] | [...]), at ("end" | "spawn"), reseed ([accounts]), G (maps: spawns)
 */
function continuation(sideFile, stateDir, o = {}) {
	const side = JSON.parse(fs.readFileSync(sideFile, "utf8")),
		index = JSON.parse(fs.readFileSync(path.join(stateDir, "index.json"), "utf8")),
		src = (side.source && side.source.characters) || {},
		reseed = new Set(o.reseed || []),
		G = o.G || null;
	if (side.format !== S.FORMAT || !side.resolved) throw new Error(`${sideFile}: not a run's resolved setup (<id>.setup.json)`);
	const file = (n) => path.join(stateDir, n + ".json");
	const accounts = {};
	for (const [k, a] of Object.entries(side.accounts || {})) {
		const x = index.accounts[k];
		if (reseed.has(k) || !x) {
			accounts[k] = { age_days: a.age_days, ...(a.bank ? { bank: a.bank } : {}), ...(a.cash != null ? { cash: a.cash } : {}), ...(a.linked ? { linked: a.linked } : {}), ...(a.storage ? { storage: a.storage } : {}), ...(a.local_storage ? { local_storage: a.local_storage } : {}) };
			continue;
		}
		const ex = JSON.parse(fs.readFileSync(path.join(stateDir, x.bank_from), "utf8")),
			acc = ex.account || {};
		accounts[k] = {
			age_days: x.age_days,
			bank: { from: path.join(stateDir, x.bank_from) },
			...(x.linked ? { linked: { platform: x.linked.platform, pid: x.linked.pid, newcomer: x.newcomer_claimed ? "claimed" : "auto" } } : {}),
			...(acc.local_storage && Object.keys(acc.local_storage).length ? { local_storage: acc.local_storage } : {}),
		};
	}
	const spawnOf = (map) => {
		const sp = G && G.maps[map] && (G.maps[map].spawns || [])[0];
		return sp ? `${map}:${sp[0]}:${sp[1]}` : "main:0:0";
	};
	const characters = side.characters.map((c) => {
		const sc = src[c.name] || {},
			code = Object.fromEntries(Object.entries({ dir: sc.code_dir, recursive: sc.recursive || undefined, entry: sc.file ? undefined : sc.entry, file: sc.file, append: sc.append && sc.append.length ? sc.append : undefined, prelude: sc.prelude || undefined, build: sc.build || undefined, fit: sc.fit }).filter(([, v]) => v != null));
		const base = { name: c.name, class: c.class, account: c.account, ...(c.role ? { role: c.role } : {}), ...(c.fps ? { fps: c.fps } : {}), code, ...(c.params ? { params: c.params } : {}), ...(sc.extra && sc.extra.length ? { extra: sc.extra } : {}), ...(c.note ? { note: c.note } : {}) };
		// (the run's start state: its setup state keys)
		if (reseed.has(c.account) || !fs.existsSync(file(c.name))) return { ...base, at: c.at, state: Object.fromEntries(Object.entries(c.state || {}).filter(([k]) => STATE_KEYS.includes(k))), ...(c.online === false ? { online: false } : {}) };
		const x = JSON.parse(fs.readFileSync(file(c.name), "utf8")),
			ch = x.character;
		const at = o.at === "spawn" && c.class !== "merchant" ? spawnOf(ch.map) : `${ch.map}:${ch.x}:${ch.y}`;
		return { ...base, at, state: { from: file(c.name) }, ...((x.source && x.source.in_game === false) || c.online === false ? { online: false } : {}) };
	});
	// the seasons on at the export (a schedule's windows were the run's), unless given
	const world = { ...side.world, start: o.start || index.at, seasons: o.seasons || index.seasons_on || (side.world.seasons || []).filter((x) => typeof x === "string") };
	delete world.age;
	delete world.events;
	const run = { ...side.run, ...(o.duration ? { duration: o.duration } : {}), ...(o.seed != null ? { seed: o.seed } : {}), warmup: "0" };
	delete run.until;
	return {
		format: S.FORMAT,
		name: side.name,
		...(side.strategy ? { strategy: side.strategy } : {}),
		notes: [side.notes, `continued from ${index.run || path.basename(sideFile)} (${index.label}, ${index.at})`].filter(Boolean).join(" | "),
		run, world, ...(side.party ? { party: side.party } : {}), ...(side.code_names ? { code_names: side.code_names } : {}), accounts, characters,
	};
}

// a run's id or file -> { side: <id>.setup.json, state: <id>.state/<label>/ }
function locate(ref, { live, label }) {
	let base = String(ref).replace(/\.setup\.json$|\.json$/, "");
	if (!path.isAbsolute(base) && !fs.existsSync(base + ".setup.json")) base = path.join(live, base);
	const side = base + ".setup.json",
		state = path.join(base + ".state", label);
	if (!fs.existsSync(side)) throw new Error(`${side}: no such run setup`);
	if (!fs.existsSync(path.join(state, "index.json"))) throw new Error(`${state}: no state export "${label}" (chronal run writes "end"; the dashboard's Export state others)`);
	return { side, state };
}

function cli(argv) {
	const dd = argv.indexOf("--"),
		pass = dd >= 0 ? argv.slice(dd + 1) : [],
		a = dd >= 0 ? argv.slice(0, dd) : argv;
	const opt = (k) => {
		const i = a.indexOf("--" + k);
		return i >= 0 ? a[i + 1] : null;
	};
	const ref = a.find((x, i) => !x.startsWith("--") && !(i > 0 && VALUED.includes(a[i - 1].slice(2))));
	if (!ref || a.includes("--help")) {
		console.log("usage: chronal continue <run id | <id>.json | <id>.setup.json> [--label end] [--live DIR] [--duration D] [--seed N] [--start ISO]\n" +
			"                        [--seasons a,b | none] [--at end | spawn] [--reseed ACCOUNT,...] [--save FILE] [--run [-- run options]]");
		process.exit(ref ? 0 : 2);
	}
	const label = opt("label") || "end",
		live = path.resolve(opt("live") || config().live_dir);
	let where;
	try {
		where = locate(ref, { live, label });
	} catch (e) {
		console.error("chronal continue: " + e.message);
		process.exit(2);
	}
	let G = null;
	try {
		const g = require("./config").gData();
		if (g) G = JSON.parse(fs.readFileSync(g, "utf8"));
	} catch (e) {}
	const seasons = opt("seasons");
	const setup = continuation(where.side, where.state, {
		duration: opt("duration"), seed: opt("seed") != null ? +opt("seed") : null, start: opt("start"), at: opt("at") || "end", G,
		seasons: seasons == null ? null : seasons === "none" ? [] : seasons.split(",").filter(Boolean), reseed: (opt("reseed") || "").split(",").filter(Boolean),
	});
	const out = path.resolve(opt("save") || path.join(where.state, "continue.setup.json"));
	fs.mkdirSync(path.dirname(out), { recursive: true });
	fs.writeFileSync(out, JSON.stringify(setup, null, 1));
	console.log(out);
	if (a.includes("--run")) {
		const r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", out, ...pass], { stdio: "inherit" });
		process.exit(r.status ?? 1);
	}
}

module.exports = { continuation, locate, cli };
