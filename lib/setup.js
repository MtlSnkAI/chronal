"use strict";
// Run setups (format "chronal-setup/1", docs/reference/setup.md): one JSON file describes a run completely.
// loadSetup() parses, fills the defaults and validates; resolveSetup() reads the states (exports, inline) and the CODE
// (a slot directory, a file, appended files, extras, an optional build hook; the characters' names it has mapped to the
// run's: code_names, names.js) into the resolved setup (what <id>.setup.json holds) and each character's bundle: the
// composed entry text and its slot map (composeEntry, characterOver, accountUser, ageOf: the CODE text, the start
// state and the account the sim gives each character).
// Others' CODE (the CODE library's, library.js) is read, and built, only at a commit trusted here. No dependency on sim.js.
const fs = require("node:fs"),
	path = require("node:path"),
	vm = require("node:vm"),
	crypto = require("node:crypto"),
	{ execFileSync } = require("node:child_process");
const { config } = require("./config");
const { codeFor, IDLE } = require("./code_sets");
const GIT = require("./git_tree");
const N = require("./names");
const STEER = require("./steer");
const LIB = require("./library");
const F = require("./fit");

const FORMAT = "chronal-setup/1";
// what a run may change without being another setup (setup_key leaves them out)
const RUN_ONLY = ["name", "strategy", "notes", "run.seed", "run.duration", "run.warmup", "run.until", "run.check", "run.grid_ms"];
const ROLES = ["dps", "tank", "healer", "merchant", "support"];
const FORMS = ["harness", "code", "none"];
const GEAR = ["mainhand", "offhand", "helmet", "chest", "pants", "shoes", "gloves", "ring1", "ring2", "earring1", "earring2", "amulet", "belt", "orb", "cape", "elixir"];
const EXPORT = "chronal-export/1";
const DAY = 86400e3;
// check: how often run.until and the steering conditions are checked (steer.js)
const RUN_DEFAULTS = { duration: "30m", warmup: "0m", seed: 1, until: null, check: "1s", grid_ms: 30000 };
// age: game time the world runs with no characters before they log in (not a run knob: it changes the outcome);
// ping: the round trip client<->server ms (sim.js DEFAULT_PING); start: the world's clock when it boots (an ISO time,
// UTC: what the server's hour, its night, dailies and nightlies follow: lib/schedule.js); seasons: the server's season
// switches on (holidayseason, lunarnewyear, valentines, halloween, egghunt); events: a daily or nightly forced
// ([{ event, at }]: at game time after the warm-up, as a steering step's; not as live, flagged everywhere)
// spawns: a custom world's monsters (sim/world_spawns.js; not as on live: flagged everywhere)
const WORLD_DEFAULTS = { roi: null, threads: true, age: "0m", ping: 18, start: require("./schedule").DEFAULT_START, seasons: [], events: [], spawns: [] };
const SPAWN_KEYS = ["monster", "at", "count", "radius", "level", "stats", "hp", "respawn", "clear"],
	SPAWN_STATS = ["hp", "attack", "armor", "resistance", "frequency", "speed", "range", "evasion", "avoidance", "reflection", "dreturn", "xp", "apiercing", "rpiercing", "crit", "lifesteal"];
// the keys a setup may have (anything else is a typo: an error)
const KEYS = {
	top: ["format", "name", "strategy", "notes", "run", "world", "defaults", "accounts", "characters", "party", "code_names", "steer"],
	side: ["format", "resolved", "name", "strategy", "notes", "run", "world", "party", "code_names", "steer", "accounts", "characters", "source"],
	run: Object.keys(RUN_DEFAULTS),
	world: Object.keys(WORLD_DEFAULTS),
	defaults: ["account", "fps", "code", "at", "state", "params", "extra", "role"],
	account: ["age_days", "bank", "cash", "linked", "storage", "local_storage"],
	linked: ["platform", "pid", "newcomer"],
	character: ["name", "class", "account", "role", "fps", "at", "state", "code", "params", "extra", "note", "online"],
	state: ["from", "level", "xp", "gold", "items", "slots", "skin", "cx", "p", "s"],
	// a character's server-side state a setup may set (the server's player.p; live never shows it)
	p: ["ugrace", "cgrace", "ograce", "stats", "achievements", "ap", "firstbuff", "encouragement_reached80", "first", "first_drop", "dt", "rewards", "minutes"],
	code: ["dir", "recursive", "entry", "file", "prelude", "append", "build", "git", "fit"],
	build: ["cmd", "cwd"],
	git: ["repo", "rev"],
	party: ["members", "leader", "form"],
	steer: ["name", "at", "when", "for", "repeat", "window", "after", "character", "storage", "local_storage", "code", "note"],
};

const sha = (s, n = 16) => crypto.createHash("sha1").update(s).digest("hex").slice(0, n);
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
// JSON with every object's keys sorted (hashes that don't depend on key order)
function canonical(v) {
	if (Array.isArray(v)) return "[" + v.map((x) => (x === undefined ? "null" : canonical(x))).join(",") + "]";
	if (isObj(v))
		return "{" + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ":" + canonical(v[k])).join(",") + "}";
	return JSON.stringify(v === undefined ? null : v);
}
// git head, plus a hash of the uncommitted diff (two different dirty trees don't look the same); "?" outside a repo
function gitVersion(dir, paths = []) {
	try {
		const run = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 });
		const head = (paths.length ? run("log", "-1", "--format=%h", "HEAD", ...paths) : run("rev-parse", "--short", "HEAD")).trim(),
			diff = run("diff", "HEAD", ...paths);
		return diff ? head + "+" + sha(diff, 6) : head;
	} catch (e) {
		return "?";
	}
}
// what the sim's version (a snapshot's versions.sim, part of setup_key) covers: the files that change what a run does,
// not the dashboard, the viewer, tests, docs, chronal new (it writes setup files: those are in the key), the install or
// the pulls; their last commit, plus a hash of their uncommitted diff
const ROOT = path.join(__dirname, "..");
const SIM_PATHS = ["--", "sim", "lib", "codes", ":(exclude)sim/g_data.js", ":(exclude)lib/compose.js", ":(exclude)lib/pull.js", ":(exclude)lib/example.js", ":(exclude)lib/install.js"];
const simVersion = (dir = ROOT) => gitVersion(dir, SIM_PATHS);
// sim.js createCharacter's merge (its `over` into a new character): objects merge key by key, the rest replaces
/** "500ms" | "90s" | "30m" | "2h" | "1d" | a number of minutes -> ms; null when it's none of these */
function parseDuration(s) {
	if (typeof s === "number") return Number.isFinite(s) && s >= 0 ? Math.round(s * 60e3) : null;
	const m = /^(\d+(?:\.\d+)?)(ms|[smhd])?$/.exec(String(s == null ? "" : s).trim());
	return m ? Math.round(+m[1] * { undefined: 60e3, ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: DAY }[m[2]]) : null;
}

// The game's classes and maps (starter gear, class names, main's spawn) from a game checkout's design files, as the
// server evaluates them; or from a G the caller has (the server's)
const designs = new Map();
function design(root = config().al_root) {
	if (!designs.has(root)) {
		const read = (f) => vm.runInNewContext(fs.readFileSync(path.join(root, "design", f + ".js"), "utf8") + "\n;" + f);
		designs.set(root, { classes: read("classes"), maps: read("maps") });
	}
	return designs.get(root);
}
function gameOf(G) {
	if (G && G.classes && G.maps) return G;
	try {
		return design();
	} catch (e) {
		throw new Error(`no game at ${config().al_root} (config al_root) to read the classes and maps from: ${e.message}`);
	}
}
// sim.js createCharacter's new character: the class's base_slots, a helmet and shoes
const starter = (G, cls) => ({ ...structuredClone(G.classes[cls].base_slots || {}), helmet: { name: "helmet", level: 0, gift: 1 }, shoes: { name: "shoes", level: 0, gift: 1 } });
const STARTER_ITEMS = () => [{ name: "hpot0", q: 200, gift: 1 }, { name: "mpot0", q: 200, gift: 1 }];

function readJson(file) {
	return JSON.parse(fs.readFileSync(file, "utf8"));
}
// an export (chronal-export/1: the snippet's or a pull's <name>.json)
// (a file of snippets/export-state.js: its JSON, or its clipboard text, compressed when large)
function readExport(file) {
	return require("./pull").exportFromText(fs.readFileSync(file, "utf8"), file);
}

function fail(problems, what) {
	const e = new Error(`${what}:\n  ${problems.join("\n  ")}`);
	e.problems = problems;
	throw e;
}

// "map:x:y" or { map, x, y } -> { map, x, y }, else null
function atOf(v) {
	if (typeof v === "string") {
		const m = /^([\w-]+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(v);
		return m ? { map: m[1], x: +m[2], y: +m[3] } : null;
	}
	if (isObj(v) && typeof v.map === "string" && v.map && Number.isFinite(v.x) && Number.isFinite(v.y) && Object.keys(v).every((k) => ["map", "x", "y"].includes(k))) return { map: v.map, x: v.x, y: v.y };
	return null;
}

/**
 * Parse, fill the defaults and validate a setup (or a resolved side file, <id>.setup.json: loaded as it is, for a
 * rerun). Throws an Error whose .problems lists every problem.
 * @param {string|object} src  a file, or the setup itself (its paths then relative to the cwd)
 * @param {object} [o.overrides]  { run: { duration, warmup, seed }, world: { age, ping }, age_days, code_set, missing }
 *   (age_days: every account; code_set: a CODE set (code_sets.js) every character takes its code from, its extra,
 *   params and own prelude kept; missing: { <name>: "slot:<slot>" | "idle" | "exclude" } for the characters the set has no entry for:
 *   another slot of the set, no CODE (its extra and params dropped too), or out of the setup and its party)
 * @param {object} [o.G]  the game's G (classes, maps); default the design files of config().al_root
 */
function loadSetup(src, { overrides = {}, G } = {}) {
	const problems = [];
	let raw, file = null;
	if (typeof src === "string") {
		file = path.resolve(src);
		try {
			raw = readJson(file);
		} catch (e) {
			fail([e.code === "ENOENT" ? `no such file ${file}` : `${file}: ${e.message}`], "setup");
		}
	} else raw = structuredClone(src);
	if (!isObj(raw)) fail(["a setup is a JSON object"], "setup");
	const dir = file ? path.dirname(file) : process.cwd(),
		abs = (p) => path.resolve(dir, p),
		side = "resolved" in raw;
	if (raw.format !== FORMAT) problems.push(`format: "${raw.format}", expected "${FORMAT}"`);
	const unknown = (o, keys, where) => {
		for (const k of Object.keys(o)) if (!keys.includes(k)) problems.push(`${where}${k}: unknown key (known: ${keys.join(", ")})`);
	};
	// the classes and maps to check against (a side file was checked when it was written)
	const game = side
		? null
		: (() => {
			try {
				return gameOf(G);
			} catch (e) {
				problems.push(e.message);
				return null;
			}
		})();
	unknown(raw, side ? KEYS.side : KEYS.top, "");
	// run, world (both kinds)
	const run = { ...RUN_DEFAULTS, ...(isObj(raw.run) ? raw.run : {}) };
	if (raw.run != null && !isObj(raw.run)) problems.push("run: an object");
	else if (raw.run) unknown(raw.run, KEYS.run, "run.");
	const ov = overrides.run || {};
	for (const k of ["duration", "warmup", "seed", "check"]) if (ov[k] != null) run[k] = ov[k];
	for (const k of ["duration", "warmup"]) if (parseDuration(run[k]) == null) problems.push(`run.${k}: "${run[k]}" is not a duration (90s, 30m, 2h, 1d, or minutes)`);
	if (!Number.isInteger(run.seed) || run.seed < 1) problems.push(`run.seed: ${JSON.stringify(run.seed)}, a whole number >= 1`);
	if (run.until != null && typeof run.until !== "string") problems.push("run.until: an expression (a string) or null");
	const chk = parseDuration(run.check);
	if (!(chk >= 100 && chk <= 600e3)) problems.push(`run.check: ${JSON.stringify(run.check)}, how often conditions are checked: 100ms to 10m (e.g. "1s", "500ms")`);
	if (!Number.isFinite(run.grid_ms) || run.grid_ms < 10000) problems.push(`run.grid_ms: ${JSON.stringify(run.grid_ms)}, >= 10000`);
	const world = { ...WORLD_DEFAULTS, ...(isObj(raw.world) ? raw.world : {}) };
	if (raw.world != null && !isObj(raw.world)) problems.push("world: an object");
	else if (raw.world) unknown(raw.world, KEYS.world, "world.");
	if (overrides.world && overrides.world.age != null) world.age = overrides.world.age;
	if (overrides.world && overrides.world.ping != null) world.ping = overrides.world.ping;
	if (overrides.world && overrides.world.start != null) world.start = overrides.world.start;
	const SCH = require("./schedule");
	if (!(typeof world.start === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/.test(world.start) && Number.isFinite(Date.parse(world.start)))) problems.push(`world.start: ${JSON.stringify(world.start)}, a time with its zone (e.g. "2026-01-01T00:00Z", UTC)`);
	if (!Array.isArray(world.seasons) || world.seasons.some((x) => !SCH.SEASONS.includes(x)) || new Set(world.seasons).size !== world.seasons.length) problems.push(`world.seasons: ${JSON.stringify(world.seasons)}, a list of ${SCH.SEASONS.join(", ")}`);
	if (!Array.isArray(world.spawns)) problems.push("world.spawns: a list of { monster, at, ... }");
	else
		world.spawns.forEach((x, i) => {
			const w = `world.spawns[${i}].`;
			if (!isObj(x)) return void problems.push(`world.spawns[${i}]: { monster, at, count, radius, level, stats, hp, respawn, clear }`);
			unknown(x, SPAWN_KEYS, w);
			if (typeof x.monster !== "string" || (game && game.monsters && !Object.hasOwn(game.monsters, x.monster))) problems.push(`${w}monster: ${JSON.stringify(x.monster)}, a monster type of the game`);
			const at = typeof x.at === "string" ? /^(\w+):(-?\d+(?:\.\d+)?):(-?\d+(?:\.\d+)?)$/.exec(x.at) : null;
			if (!at) problems.push(`${w}at: ${JSON.stringify(x.at)}, "map:x:y"`);
			else if (game && !Object.hasOwn(game.maps, at[1])) problems.push(`${w}at: no map "${at[1]}" in the game`);
			for (const [k, lo, hi] of [["count", 1, 100], ["radius", 0, 1000], ["level", 1, 200], ["clear", 0, 3000]]) if (x[k] != null && !(Number.isFinite(x[k]) && x[k] >= lo && x[k] <= hi)) problems.push(`${w}${k}: ${lo} to ${hi}`);
			if (x.stats != null && (!isObj(x.stats) || Object.entries(x.stats).some(([k, v]) => !SPAWN_STATS.includes(k) || !Number.isFinite(v)))) problems.push(`${w}stats: { ${SPAWN_STATS.join(", ")} }, numbers`);
			if (x.hp != null && x.hp !== "endless") problems.push(`${w}hp: "endless" (it never dies), or none (its stats' hp: stats.hp)`);
			if (x.respawn != null && x.respawn !== "no" && parseDuration(x.respawn) == null) problems.push(`${w}respawn: game time after a death (5s, 1m), or "no"`);
		});
	if (!Array.isArray(world.events)) problems.push("world.events: a list of { event, at }");
	else
		world.events.forEach((e, i) => {
			if (!isObj(e) || Object.keys(e).some((k) => !["event", "at"].includes(k))) return void problems.push(`world.events[${i}]: { event, at }`);
			if (![...SCH.DAILIES, ...SCH.NIGHTLIES].includes(e.event)) problems.push(`world.events[${i}].event: ${JSON.stringify(e.event)}, one of ${[...SCH.DAILIES, ...SCH.NIGHTLIES].join(", ")}`);
			const at = parseDuration(e.at);
			if (at == null) problems.push(`world.events[${i}].at: ${JSON.stringify(e.at)}, game time after the warm-up (90s, 30m, 2h)`);
			else if (parseDuration(run.duration) != null && at >= parseDuration(run.duration)) problems.push(`world.events[${i}].at: ${e.at} is past the run's end (${run.duration})`);
		});
	if (world.roi != null && !/^(\d+|box\d*)(,m\d+)?$/.test(String(world.roi))) problems.push(`world.roi: "${world.roi}" (e.g. "box50", "900", "box50,m300")`);
	if (typeof world.threads !== "boolean") problems.push("world.threads: true or false");
	if (!(typeof world.ping === "number" && world.ping > 0 && world.ping <= 1000)) problems.push(`world.ping: ${JSON.stringify(world.ping)} is not a round trip in ms (> 0, at most 1000)`);
	if (parseDuration(world.age) == null) problems.push(`world.age: "${world.age}" is not a duration (90s, 30m, 2h, 1d, or minutes)`);
	for (const k of ["name", "strategy", "notes"]) if (raw[k] != null && typeof raw[k] !== "string") problems.push(`${k}: a string`);
	const name = raw.name || (file ? path.basename(file).replace(/(\.setup)?\.json$/, "") : "setup");

	let characters, accounts, party, code_names = null,
		steer = [];
	if (side) {
		// a resolved side file: states inline, CODE by hash in a store
		characters = Array.isArray(raw.characters) ? raw.characters : [];
		accounts = isObj(raw.accounts) ? raw.accounts : {};
		party = raw.party || null;
		if (!characters.length) problems.push("characters: none");
		for (const c of characters)
			if (!isObj(c) || typeof c.name !== "string" || !isObj(c.code) || !/^[0-9a-f]{16}$/.test(c.code.slots) || !/^[0-9a-f]{16}$/.test(c.code.text)) problems.push(`characters: ${JSON.stringify((c && c.name) || c)} is not a resolved character (name, code: { slots, text })`);
		if (!isObj(raw.source) || !isObj(raw.source.characters)) problems.push("source: missing (a resolved side file has one)");
		namesMap(raw.code_names, characters, new Set(), problems);
	} else {
		const defaults = isObj(raw.defaults) ? raw.defaults : {};
		if (raw.defaults != null && !isObj(raw.defaults)) problems.push("defaults: an object");
		else unknown(defaults, KEYS.defaults, "defaults.");
		if (!Array.isArray(raw.characters) || !raw.characters.length) problems.push("characters: a list of at least one character");
		accounts = {};
		if (raw.accounts != null && !isObj(raw.accounts)) problems.push("accounts: an object");
		for (const [k, a] of Object.entries(isObj(raw.accounts) ? raw.accounts : {})) {
			const w = `accounts.${k}.`;
			if (!/^[\w.-]{1,40}$/.test(k)) problems.push(`accounts.${k}: a name (letters, digits, _.-)`);
			if (!isObj(a)) {
				problems.push(`accounts.${k}: an object`);
				continue;
			}
			unknown(a, KEYS.account, w);
			const age = a.age_days ?? 0;
			if (typeof age !== "number" || !(age >= 0)) problems.push(`${w}age_days: ${JSON.stringify(a.age_days)}, a number >= 0`);
			let bank = null;
			if (a.bank != null) {
				if (!isObj(a.bank)) problems.push(`${w}bank: { from } or { gold, items0, ... }`);
				else if ("from" in a.bank) {
					if (Object.keys(a.bank).length > 1) problems.push(`${w}bank: "from" alone, or inline gold and packs`);
					bank = { from: abs(String(a.bank.from)) };
					try {
						readExport(bank.from);
					} catch (e) {
						problems.push(`${w}bank.from: ${e.code === "ENOENT" ? "no such file " + bank.from : e.message}`);
					}
				} else {
					for (const [bk, v] of Object.entries(a.bank))
						if (
							bk === "gold" ? !(Number.isFinite(v) && v >= 0)
							: bk === "unlocked" ? !(v && typeof v === "object" && !Array.isArray(v))
							: bk === "rewards" ? !Array.isArray(v)
							: !/^items\d+$/.test(bk) || !Array.isArray(v)
						)
							problems.push(`${w}bank.${bk}: gold (a number), items<N> (a list), unlocked ({ <room>: true }) or rewards (a list)`);
					bank = structuredClone(a.bank);
				}
			}
			if (a.cash != null && !(Number.isInteger(a.cash) && a.cash >= 0)) problems.push(`${w}cash: a whole number >= 0 (shells)`);
			const linked = linkedOf(k, a.linked, w, problems, unknown);
			accounts[k] = { age_days: age, bank, ...(a.cash != null ? { cash: a.cash } : {}), ...(linked ? { linked } : {}), ...storageOf(a, w, problems) };
		}
		const missing = overrides.missing || {},
			excluded = new Set(Object.keys(missing).filter((n) => missing[n] === "exclude"));
		if (Object.keys(missing).length && !overrides.code_set) problems.push("missing: only with a CODE set (code_set)");
		for (const [n, v] of Object.entries(missing)) {
			if (!(Array.isArray(raw.characters) && raw.characters.some((c) => isObj(c) && c.name === n))) problems.push(`missing.${n}: no such character`);
			if (!(v === "idle" || v === "exclude" || /^slot:.+/.test(v))) problems.push(`missing.${n}: ${JSON.stringify(v)} ("slot:<slot>", "idle" or "exclude")`);
		}
		const merged = (Array.isArray(raw.characters) ? raw.characters : []).filter((c) => !(isObj(c) && excluded.has(c.name))).map((c, i) => {
			if (!isObj(c)) return problems.push(`characters[${i}]: an object`), null;
			const out = { ...defaults, ...c };
			// code: the character's keys over the defaults' (build too), an explicit null unsets one
			if (isObj(defaults.code) || isObj(c.code)) {
				const code = { ...(isObj(defaults.code) ? defaults.code : {}) };
				for (const [k, v] of Object.entries(isObj(c.code) ? c.code : {})) code[k] = k === "build" && isObj(v) && isObj(code.build) ? { ...code.build, ...v } : v;
				out.code = code;
			}
			if (overrides.code_set && typeof c.name === "string") {
				const m = missing[c.name],
					set = overrides.code_set;
				if (m === "idle") Object.assign(out, { code: { file: IDLE, append: [] }, extra: [], params: null });
				else out.code = { ...codeFor(m ? { ...set, entries: { ...set.entries, [c.name]: m.slice(5) } } : set, c.name, c.class), ...(isObj(c.code) && c.code.prelude != null ? { prelude: c.code.prelude } : {}) };
			}
			return out;
		});
		characters = [];
		const names = new Map();
		merged.forEach((c, i) => {
			if (!c) return;
			const w = `characters[${i}]${typeof c.name === "string" ? " (" + c.name + ")" : ""}.`;
			unknown(c, KEYS.character, w);
			if (typeof c.name !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(c.name)) problems.push(`${w}name: ${JSON.stringify(c.name)}, 1-12 letters and digits`);
			else if (names.has(c.name.toLowerCase())) problems.push(`${w}name: ${c.name} twice (names are unique, case-insensitive)`);
			else names.set(c.name.toLowerCase(), c.name);
			if (game && !(typeof c.class === "string" && Object.hasOwn(game.classes, c.class))) problems.push(`${w}class: ${JSON.stringify(c.class)} (one of ${Object.keys(game.classes).join(", ")})`);
			const account = c.account == null ? "main" : c.account;
			if (typeof account !== "string" || !/^[\w.-]{1,40}$/.test(account)) problems.push(`${w}account: ${JSON.stringify(account)}, a name (letters, digits, _.-)`);
			else if (!Object.hasOwn(accounts, account)) accounts[account] = { age_days: 0, bank: null };
			if (c.role != null && !ROLES.includes(c.role)) problems.push(`${w}role: ${JSON.stringify(c.role)} (one of ${ROLES.join(", ")})`);
			const fps = c.fps == null ? 10 : c.fps;
			if (!(typeof fps === "number" && fps > 0 && fps <= 60)) problems.push(`${w}fps: ${JSON.stringify(c.fps)}, 1..60`);
			const at = c.at == null ? null : atOf(c.at);
			if (c.at != null && !at) problems.push(`${w}at: ${JSON.stringify(c.at)}, "map:x:y" or { map, x, y }`);
			else if (at && game && !Object.hasOwn(game.maps, at.map)) problems.push(`${w}at: no map "${at.map}" in the game`);
			// state
			let state = null;
			if (c.state != null) {
				if (!isObj(c.state)) problems.push(`${w}state: an object`);
				else {
					unknown(c.state, KEYS.state, w + "state.");
					state = { ...c.state };
					if (state.from != null) {
						state.from = abs(String(state.from));
						try {
							const e = readExport(state.from);
							if (typeof c.class === "string" && e.character.class !== c.class) problems.push(`${w}state.from: ${state.from} is a ${e.character.class}, not a ${c.class}`);
						} catch (e) {
							problems.push(`${w}state.from: ${e.code === "ENOENT" ? "no such file " + state.from : e.message}`);
						}
					}
					if (state.level != null && !(Number.isInteger(state.level) && state.level >= 1)) problems.push(`${w}state.level: a whole number >= 1`);
					for (const k of ["xp", "gold"]) if (state[k] != null && !(Number.isFinite(state[k]) && state[k] >= 0)) problems.push(`${w}state.${k}: a number >= 0`);
					if (state.items != null && !Array.isArray(state.items)) problems.push(`${w}state.items: a list`);
					if (state.skin != null && (typeof state.skin !== "string" || !state.skin)) problems.push(`${w}state.skin: a skin's name`);
					if (state.cx != null && !(isObj(state.cx) && Object.values(state.cx).every((v) => typeof v === "string"))) problems.push(`${w}state.cx: { <place>: <cosmetic> }`);
					if (state.slots != null && !isObj(state.slots)) problems.push(`${w}state.slots: an object`);
					if (state.p != null) {
						if (!isObj(state.p)) problems.push(`${w}state.p: an object`);
						else {
							unknown(state.p, KEYS.p, w + "state.p.");
							for (const g of ["ugrace", "cgrace"])
								if (state.p[g] != null && !(Array.isArray(state.p[g]) && state.p[g].length === 15 && state.p[g].every(Number.isFinite))) problems.push(`${w}state.p.${g}: 15 numbers (one per level; the server resets any other length)`);
							for (const n of ["ograce", "minutes"]) if (state.p[n] != null && !Number.isFinite(state.p[n])) problems.push(`${w}state.p.${n}: a number`);
							for (const o of ["stats", "achievements", "ap", "dt"]) if (state.p[o] != null && !isObj(state.p[o])) problems.push(`${w}state.p.${o}: an object`);
							for (const b of ["firstbuff", "encouragement_reached80", "first", "first_drop"]) if (state.p[b] != null && typeof state.p[b] !== "boolean") problems.push(`${w}state.p.${b}: true or false`);
							if (state.p.rewards != null && !Array.isArray(state.p.rewards)) problems.push(`${w}state.p.rewards: a list`);
						}
					}
					if (state.s != null && !(isObj(state.s) && Object.values(state.s).every(isObj))) problems.push(`${w}state.s: { <condition>: { ms, ... } }`);
				}
			}
			// code
			let code = null;
			if (!isObj(c.code)) problems.push(`${w}code: { dir, entry } or { file } (in the character or defaults)`);
			else {
				unknown(c.code, KEYS.code, w + "code.");
				const k = c.code;
				code = {
					dir: k.dir == null ? null : abs(String(k.dir)), recursive: !!k.recursive, entry: k.entry == null ? null : String(k.entry), file: k.file == null ? null : abs(String(k.file)),
					prelude: k.prelude == null ? null : String(k.prelude), append: [].concat(k.append == null ? [] : k.append).map((p) => abs(String(p))), build: null,
				};
				if (code.entry && code.file) problems.push(`${w}code: entry and file both set (one of them; a character's "entry": null unsets the defaults')`);
				if (!code.entry && !code.file && !code.dir) problems.push(`${w}code: no entry (code.file, or code.dir with a slot named ${c.name} or code.entry)`);
				// git: the code block's paths inside the repo are the commit's (git_tree.js)
				let at = "",
					exists = fs.existsSync;
				if (k.git != null) {
					if (!isObj(k.git) || typeof k.git.rev !== "string" || !k.git.rev) problems.push(`${w}code.git: { repo, rev } (rev: a commit, branch or tag; repo: a path in the repo, default the code's dir)`);
					else {
						unknown(k.git, KEYS.git, w + "code.git.");
						try {
							code.git = GIT.resolve({ repo: abs(String(k.git.repo ?? (k.build && k.build.cwd) ?? k.dir ?? k.file ?? ".")), rev: k.git.rev });
							at = ` at ${code.git.rev === code.git.commit ? code.git.commit.slice(0, 7) : `${code.git.rev} (${code.git.commit.slice(0, 7)})`}`;
							exists = (p) => GIT.exists(code.git, p);
						} catch (e) {
							problems.push(`${w}code.git: ${e.message}`);
							exists = () => true;
						}
					}
				}
				if (code.file && !exists(code.file) && !k.build) problems.push(`${w}code.file: no such file ${code.file}${at}`);
				for (const p of code.append) if (!exists(p)) problems.push(`${w}code.append: no such file ${p}${at}`);
				if (k.build != null) {
					if (!isObj(k.build) || !Array.isArray(k.build.cmd) || !k.build.cmd.length || !k.build.cmd.every((x) => typeof x === "string")) problems.push(`${w}code.build: { cmd: ["node", "make.js", ...], cwd } or null`);
					else {
						unknown(k.build, KEYS.build, w + "code.build.");
						code.build = { cmd: [...k.build.cmd], cwd: abs(String(k.build.cwd == null ? "." : k.build.cwd)) };
					}
				}
				if (code.dir && !k.build && !exists(code.dir)) problems.push(`${w}code.dir: no such directory ${code.dir}${at}`);
				if (k.fit != null) {
					const bad = F.fitProblems(k.fit);
					if (bad.length) problems.push(...bad.map((x) => `${w}code.fit: ${x}`));
					else code.fit = structuredClone(k.fit);
				}
			}
			if (c.params != null && !isObj(c.params)) problems.push(`${w}params: an object ({ farm, path, ... })`);
			else if (c.params && c.params.farm != null) {
				const f = c.params.farm;
				if (!isObj(f) || (f.monsters != null && !(Array.isArray(f.monsters) && f.monsters.every((x) => typeof x === "string"))) || (f.map != null && (typeof f.map !== "string" || !Number.isFinite(f.x) || !Number.isFinite(f.y))))
					problems.push(`${w}params.farm: { map, x, y, monsters: [types] }`);
			}
			const extra = [].concat(c.extra == null ? [] : c.extra);
			if (!extra.every((x) => typeof x === "string")) problems.push(`${w}extra: a string or a list of strings (CODE)`);
			if (c.note != null && typeof c.note !== "string") problems.push(`${w}note: a string`);
			if (c.online != null && typeof c.online !== "boolean") problems.push(`${w}online: true (default: in game at the start) or false (on the account, started by CODE: start_character)`);
			characters.push({ name: c.name, class: c.class, account, role: c.role || null, fps, at, state, code, params: c.params == null ? null : structuredClone(c.params), extra, note: c.note || null, ...(c.online === false ? { online: false } : {}) });
		});
		// one account: at most 3 characters in game besides 1 merchant at the start (the server's limit; online: false
		// ones are not in game until CODE starts them, and then the server holds to its limit)
		for (const k of Object.keys(accounts)) {
			const of = characters.filter((c) => c.account === k && c.online !== false),
				m = of.filter((c) => c.class === "merchant").length;
			if (of.length - m > 3 || m > 1) problems.push(`accounts.${k}: ${of.length - m} characters and ${m} merchants in game at the start (at most 3 and 1 at once: put the others on another account, or online: false)`);
			if (characters.some((c) => c.account === k) && !of.length) problems.push(`accounts.${k}: no character in game at the start (online: false only; a page in game starts the others)`);
		}
		// and at most 3 besides merchants from one IP, whatever their accounts (the server's options.ip_limit): a run's
		// characters all play from one. They log in in setup order; a linked account's (Steam, MAS: an auth id) may be
		// one of 3 x 12 from an IP, and one of 3 per auth id (server_functions.js is_player_allowed)
		const fighters = characters.filter((c) => c.online !== false && c.class !== "merchant"),
			perPid = {},
			refused = [];
		fighters.forEach((c, i) => {
			const L = accounts[c.account] && accounts[c.account].linked;
			if (L ? i + 1 > 3 * 12 || (perPid[L.pid] = (perPid[L.pid] || 0) + 1) > 3 : i + 1 > 3) refused.push(c.name);
		});
		if (Object.keys(accounts).length > 1 && refused.length) problems.push(`${fighters.length} characters besides merchants in game at the start (${fighters.map((c) => c.name).join(", ")}): the game lets 3 play from one IP (a Steam- or MAS-linked account's: 36, 3 per link), whatever their accounts, and a run's characters all play from one: ${refused.join(", ")} would be refused (put them online: false)`);
		// party
		party = null;
		if (raw.party != null) {
			const p = raw.party;
			if (!isObj(p)) problems.push("party: { members, leader, form }");
			else {
				unknown(p, KEYS.party, "party.");
				const all = Array.isArray(p.members) ? p.members : [],
					members = all.filter((n) => !excluded.has(n));
				if (!all.length) problems.push("party.members: a list of character names");
				for (const n of members) if (!characters.some((c) => c.name === n)) problems.push(`party.members: no character ${JSON.stringify(n)}`);
				if (new Set(members).size !== members.length) problems.push("party.members: a name twice");
				const leader = p.leader == null || excluded.has(p.leader) ? members[0] : p.leader;
				if (members.length && !members.includes(leader)) problems.push(`party.leader: ${JSON.stringify(leader)} is not a member`);
				const form = p.form == null ? "harness" : p.form;
				if (!FORMS.includes(form)) problems.push(`party.form: ${JSON.stringify(form)} (${FORMS.join(", ")})`);
				party = members.length ? { members: [...members], leader, form } : null; // every member excluded: no party
			}
		}
		code_names = namesMap(raw.code_names, characters, excluded, problems);
		steer = steerList(raw.steer, characters, excluded, problems);
	}
	// a run's side file with a CODE set: its characters as they were, their CODE from the set (missing: idle or a slot;
	// none can be left out of a run that ran)
	if (overrides.code_set && side) for (const [n, v] of Object.entries(overrides.missing || {})) if (v === "exclude") problems.push(`missing.${n}: exclude: not for a run's setup file (its characters are fixed): idle or a slot`);
	if (overrides.age_days != null) {
		if (!(typeof overrides.age_days === "number" && overrides.age_days >= 0)) problems.push(`age_days: ${JSON.stringify(overrides.age_days)}, a number >= 0`);
		for (const a of Object.values(accounts)) a.age_days = overrides.age_days;
	}
	if (run.until != null) {
		try {
			STEER.compile(run.until);
			for (const p of STEER.lint(run.until)) problems.push(`run.until: ${p}`);
		} catch (e) {
			problems.push(`run.until: ${e.message}`);
		}
		const r = STEER.refsOf(run.until),
			steps = new Set((side ? raw.steer || [] : steer).map((e) => e && e.name).filter(Boolean));
		for (const n of r.chars) if (!characters.some((c) => c.name === n)) problems.push(`run.until: c.${n} is not a character of this setup`);
		for (const n of r.steps) if (!steps.has(n)) problems.push(`run.until: steps.${n}: no step of that name`);
	}
	if (problems.length) fail(problems, `${file || "setup"}: ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
	const out = side ? { ...raw, run, world, accounts } : { format: FORMAT, name, strategy: raw.strategy || null, notes: raw.notes || null, run, world, accounts, characters, party, ...(code_names ? { code_names } : {}), ...(steer.length ? { steer } : {}) };
	const cs = overrides.code_set,
		code_set = cs ? { name: cs.name, kind: cs.kind, ...(cs.pull ? { pull: cs.pull.dir, pulled_at: cs.pull.pulled_at } : {}), ...(cs.git ? { git: { ...cs.git } } : {}), ...(overrides.missing && Object.keys(overrides.missing).length ? { missing: { ...overrides.missing } } : {}) } : null;
	const code_set_def = side && cs ? { set: cs, missing: overrides.missing || {} } : null;
	for (const [k, v] of Object.entries({ file, dir, side, code_set, code_set_def })) Object.defineProperty(out, k, { value: v, enumerable: false });
	return out;
}

// code_names: { <a name in the CODE>: <a character of the setup, or the name itself: it stays> }; one mapped to a
// character left out (missing: exclude) stays -> the map, null for none
function namesMap(raw, characters, excluded, problems) {
	if (raw == null) return null;
	if (!isObj(raw)) return problems.push("code_names: { <a name in the CODE>: <a character of the setup, or the same name: it stays> }"), null;
	const out = {};
	for (const [a, b] of Object.entries(raw)) {
		if (!N.NAME.test(a)) problems.push(`code_names.${a}: a character's name (1-12 letters and digits)`);
		else if (typeof b !== "string" || !N.NAME.test(b)) problems.push(`code_names.${a}: ${JSON.stringify(b)}, a character's name`);
		else if (excluded.has(b)) out[a] = a;
		else if (a !== b && !characters.some((c) => c && c.name === b)) problems.push(`code_names.${a}: ${b} is not a character of the setup`);
		else out[a] = b;
	}
	return Object.keys(out).length ? out : null;
}

// an account's browser storage at the start: storage { <key>: <what get(key) returns> } (the game's set/get keep
// JSON under localStorage "cstore_<key>"), local_storage { <localStorage key>: <text> }; a null value: unset (a
// steering entry's, keep: the key removed then)
function storageOf(a, w, problems, keep = false) {
	const out = {},
		kept = ([, v]) => keep || v !== null;
	if (a.storage != null) {
		if (!isObj(a.storage)) problems.push(`${w}storage: { <key>: <a value, as get(key) returns it> }`);
		else out.storage = Object.fromEntries(Object.entries(a.storage).filter(kept).map(([k, v]) => [k, structuredClone(v)]));
	}
	if (a.local_storage != null) {
		if (!isObj(a.local_storage) || !Object.values(a.local_storage).every((v) => v === null || typeof v === "string")) problems.push(`${w}local_storage: { <localStorage key>: <text> }`);
		else out.local_storage = Object.fromEntries(Object.entries(a.local_storage).filter(kept));
	}
	for (const k of Object.keys(out.storage || {})) if (out.local_storage && Object.hasOwn(out.local_storage, "cstore_" + k)) problems.push(`${w}local_storage.cstore_${k}: storage.${k} sets it too (set/get keep their values under "cstore_<key>")`);
	for (const k of ["storage", "local_storage"]) if (out[k] && !Object.keys(out[k]).length) delete out[k];
	return out;
}
/** The localStorage entries of storage and local_storage (storageOf's): { <localStorage key>: <text>, or null: removed } */
function storageEntries({ storage = null, local_storage = null } = {}) {
	return { ...(local_storage || {}), ...Object.fromEntries(Object.entries(storage || {}).map(([k, v]) => ["cstore_" + k, v === null ? null : JSON.stringify(v)])) };
}

// steer: [{ name, at | when (for, repeat, window) | after (at: the while after), character (none: every character in
// game), storage, local_storage (into its account's storage, or every account's), code (run in its CODE, as
// command_character runs a snippet), note }] (steer.js: the conditions and the steps' states), in their order; one for
// a character left out (missing: exclude) is dropped
const STEP_NAME = /^[A-Za-z_]\w{0,31}$/;
function steerList(raw, characters, excluded, problems) {
	if (raw == null) return [];
	const shape = "{ name, at | when (for, repeat, window) | after, character, storage, local_storage, code, note }";
	if (!Array.isArray(raw)) return problems.push(`steer: a list of ${shape}`), [];
	const out = [],
		all = new Set([...characters.filter(Boolean).map((c) => c.name), ...excluded]),
		names = new Set(raw.filter((e) => isObj(e) && typeof e.name === "string").map((e) => e.name)),
		dur = (w, k, v, what = "") => parseDuration(v) == null && problems.push(`${w}${k}: ${JSON.stringify(v)}, a game time${what} (90s, 30m, 2h, or minutes)`),
		expr = (w, text) => {
			if (typeof text !== "string" || !text.trim()) return problems.push(`${w}: a condition (an expression of c.<Name>, t, world, steps)`);
			try {
				STEER.compile(text);
				for (const p of STEER.lint(text)) problems.push(`${w}: ${p}`);
			} catch (x) {
				return problems.push(`${w}: ${x.message}`);
			}
			const r = STEER.refsOf(text);
			for (const n of r.chars) if (!all.has(n)) problems.push(`${w}: c.${n} is not a character of the setup`);
			for (const n of r.steps) if (!names.has(n)) problems.push(`${w}: steps.${n}: no step of that name`);
		};
	raw.forEach((e, i) => {
		const w = `steer[${i}].`;
		if (!isObj(e)) return problems.push(`steer[${i}]: ${shape}`);
		for (const k of Object.keys(e)) if (!KEYS.steer.includes(k)) problems.push(`${w}${k}: unknown key (known: ${KEYS.steer.join(", ")})`);
		if (e.character != null && excluded.has(e.character)) return;
		if (e.name != null && (typeof e.name !== "string" || !STEP_NAME.test(e.name))) problems.push(`${w}name: ${JSON.stringify(e.name)}, a word (letters, digits, _)`);
		else if (e.name != null && raw.filter((x) => isObj(x) && x.name === e.name).length > 1) problems.push(`${w}name: ${e.name} twice`);
		// the trigger: at; when (for, repeat, window); after (at: the while after, default 0)
		if (e.when != null) {
			if (e.at != null || e.after != null) problems.push(`steer[${i}]: when, or at / after (a time), not both`);
			expr(`${w}when`, e.when);
			if (e.for != null) dur(w, "for", e.for);
			if (e.window != null) dur(w, "window", e.window);
			if (e.repeat != null && typeof e.repeat !== "boolean") problems.push(`${w}repeat: true (again each time it holds anew) or false`);
		} else {
			for (const k of ["for", "window", "repeat"]) if (e[k] != null) problems.push(`${w}${k}: with when only`);
			if (e.after != null) {
				if (typeof e.after !== "string" || !names.has(e.after)) problems.push(`${w}after: ${JSON.stringify(e.after)}, the name of another step`);
				else if (e.after === e.name) problems.push(`${w}after: itself`);
				if (e.at != null) dur(w, "at", e.at);
			} else if (e.at == null) problems.push(`steer[${i}]: at (a game time since the run's start, after the warm-up), when (a condition) or after (another step)`);
			else dur(w, "at", e.at, " since the run's start");
		}
		if (e.character != null && !characters.some((c) => c && c.name === e.character)) problems.push(`${w}character: ${JSON.stringify(e.character)} is not a character of the setup`);
		const st = storageOf(e, w, problems, true);
		if (e.code != null) {
			if (typeof e.code !== "string" || !e.code.trim()) problems.push(`${w}code: CODE (a string)`);
			else
				try {
					new vm.Script(e.code);
				} catch (x) {
					problems.push(`${w}code: ${x.message}`);
				}
		}
		if (e.note != null && typeof e.note !== "string") problems.push(`${w}note: a string`);
		if (!st.storage && !st.local_storage && !(typeof e.code === "string" && e.code.trim())) problems.push(`steer[${i}]: nothing to do (storage, local_storage or code)`);
		const keep = (k) => (e[k] != null ? { [k]: e[k] } : {});
		out.push({ ...keep("name"), ...keep("at"), ...keep("when"), ...keep("for"), ...keep("repeat"), ...keep("window"), ...keep("after"), ...keep("character"), ...st, ...keep("code"), ...keep("note") });
	});
	// a step after another that is after it (a cycle): never fires
	const after = new Map(out.filter((e) => e.name && e.after).map((e) => [e.name, e.after])),
		told = new Set();
	for (const [n] of after) {
		const seen = new Set([n]);
		for (let x = after.get(n); x != null && !told.has(n); x = after.get(x)) {
			if (seen.has(x)) {
				problems.push(`steer: ${n} is after itself (${[...seen, x].join(" -> ")}): it never fires`);
				for (const y of seen) told.add(y);
				break;
			}
			seen.add(x);
		}
	}
	return out;
}

/** A steering entry as a line: its keys and values, the CODE it runs (60 characters) */
function steerText(e) {
	return [
		...Object.entries(e.storage || {}).map(([k, v]) => `${k}=${JSON.stringify(v)}`), ...Object.entries(e.local_storage || {}).map(([k, v]) => `localStorage ${k}=${JSON.stringify(v)}`),
		...(e.code != null ? [`run ${String(e.code).replace(/\s+/g, " ").trim().slice(0, 60)}`] : []),
	].join(", ");
}

// every *.js in dir (recursive: in its subdirectories too) as a slot named as the game names it (fit.js slotFiles),
// each with a sourceURL line (CPU profiles attribute time to the slot's file)
function slotsIn(dir, recursive) {
	const out = {};
	for (const { slot, file } of F.slotFiles(dir, recursive)) out[slot] = fs.readFileSync(file, "utf8") + `\n//# sourceURL=code/${slot}.js\n`;
	return out;
}

// Parallel runs of one checkout build (and read the slot directory) one at a time: mkdir is atomic; a lock older than
// 120 s is a dead run's (<dirname of code.dir>/.build-lock, e.g. dist/.build-lock for a dir dist/<profile>)
function withLock(dir, fn) {
	if (!dir) return fn();
	const lock = path.join(dir, ".build-lock"),
		pause = new Int32Array(new SharedArrayBuffer(4));
	let locked = false;
	try {
		fs.mkdirSync(dir);
	} catch (e) {}
	for (;;) {
		try {
			fs.mkdirSync(lock);
			locked = true;
			break;
		} catch (e) {
			if (e.code !== "EEXIST") break; // no such directory, or read-only: unlocked
		}
		try {
			if (Date.now() - fs.statSync(lock).mtimeMs > 120_000) fs.rmdirSync(lock);
		} catch (e) {}
		Atomics.wait(pause, 0, 0, 200);
	}
	try {
		return fn();
	} finally {
		if (locked) fs.rmdirSync(lock);
	}
}

// a build hook (refused for the library's CODE at a commit not trusted here)
function runBuild(b) {
	const no = LIB.buildBlock(b.cwd);
	if (no) throw new Error(no);
	try {
		execFileSync(b.cmd[0] === "node" ? process.execPath : b.cmd[0], b.cmd.slice(1), { cwd: b.cwd, stdio: ["ignore", "ignore", "pipe"] });
	} catch (e) {
		throw new Error(`build ${JSON.stringify(b.cmd)} in ${b.cwd} failed (${e.status ?? e.code}): ${String(e.stderr || "").trim().split("\n").slice(-3).join(" | ")}`);
	}
}

// the party harness (party.form "harness"): the leader invites the other members every 5 s, they accept the leader's
// invites only (this replaces the CODE's own on_party_invite: use form "code" for CODE that forms its party)
function inviteOf(party, name) {
	if (!party || party.form !== "harness" || party.members.length < 2 || !party.members.includes(name)) return "";
	const rest = party.members.filter((n) => n !== party.leader);
	if (name === party.leader)
		return `\n;setInterval(function () { var l = parent.party_list || []; ${JSON.stringify(rest)}.forEach(function (n) { if (l.indexOf(n) < 0) send_party_invite(n); }); }, 5000);\n`;
	return `\n;on_party_invite = function (name) { if (name === ${JSON.stringify(party.leader)}) accept_party_invite(name); };\n`;
}

/**
 * A character's CODE text, the same bytes every time: params (chronal.params), the prelude, the entry (a slot's
 * text with its sourceURL line, or a file's raw text), each appended file's and each extra's text after "\n;", then the
 * party harness invite.
 */
function composeEntry({ params = null, prelude = null, entryText, append = [], extra = [], invite = "" }) {
	let s = "";
	if (params != null) s += `self.chronal = self.chronal || {}; chronal.params = ${JSON.stringify(params)};\n`;
	if (prelude != null) s += prelude + "\n";
	s += entryText;
	for (const t of append) s += "\n;" + t + "\n";
	for (const x of extra) s += "\n;" + x + "\n";
	return s + (invite || "");
}

// the store's content hashes: a slot map by its canonical JSON (keys sorted), an entry by its text
const slotsJson = (files) => JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
const codeBlock = (entry, files, text) => {
	const slots = sha(slotsJson(files)),
		t = sha(text);
	return { entry, slots, text: t, hash: sha(slots + t, 8) };
};

// The run's names in what a character's CODE reads from disk (setup code_names; names.js): null without a name to map,
// else { to(name), text(where, text, slots): mapped, hits, flags, errors } (the hits, flags and errors of the whole run;
// slots: the names of its CODE's slots, a string that is one of them names a slot, not a character: not flagged)
function namesCtx(map, runNames) {
	if (!map || !Object.entries(map).some(([a, b]) => a !== b)) return null;
	const x = { map, hits: {}, flags: [], errors: [] };
	x.to = (n) => (Object.hasOwn(map, n) ? map[n] : n);
	x.text = (where, t, slots = []) => {
		const r = N.mapText(t, map, [...runNames, ...slots]);
		for (const [k, n] of Object.entries(r.hits)) x.hits[k] = (x.hits[k] || 0) + n;
		if (r.error) x.errors.push(`${where}: ${r.error}`);
		for (const f of r.flags) x.flags.push({ where, ...f });
		return r.text;
	};
	return x;
}
// a slot directory's slots with the run's names: each text mapped, a slot named after a name of the CODE renamed so
// (require_code, load_code and the entry by the character's name find it under the run's name)
function namedSlots(files, names, dir, problems) {
	const out = {},
		taken = new Map();
	for (const [slot, text] of Object.entries(files)) {
		const to = names.to(slot),
			was = taken.get(to.toLowerCase());
		if (was != null) {
			problems.push(`code_names: the slots ${was} and ${slot} of ${dir} would both be named ${to} (the game finds slots by name, whatever the case)`);
			continue;
		}
		taken.set(to.toLowerCase(), slot);
		out[to] = names.text(slot + ".js", text, Object.keys(files));
	}
	return out;
}
// what the names don't map, or may not: a name mapped that the CODE doesn't have, two names one character, a name of
// the CODE that is the run's too, a text not read, the strings that may be meant as a mapped name (flags)
function namesWarnings(names, runNames) {
	const out = [],
		moves = Object.entries(names.map).filter(([a, b]) => a !== b),
		by = {};
	for (const [a, b] of moves) if (!names.hits[a]) out.push(`code_names: ${a} -> ${b}: no ${a} in the CODE, nothing mapped`);
	for (const [a, b] of Object.entries(names.map)) (by[b] ||= []).push(a);
	for (const [b, as] of Object.entries(by)) if (as.length > 1) out.push(`code_names: ${as.join(" and ")} of the CODE all become ${b}`);
	for (const [a, b] of moves) if (runNames.includes(a)) out.push(`code_names: ${a} is a character of the run, and the CODE's ${a} becomes ${b}`);
	for (const e of [...new Set(names.errors)]) out.push(`code_names: ${e}: not read, its names are not mapped`);
	const flags = names.flags;
	if (flags.length) out.push(`code_names: ${flags.length} string${flags.length > 1 ? "s" : ""} may be meant as a mapped name, not mapped: ${flags.slice(0, 4).map(N.flagText).join("; ")}${flags.length > 4 ? `; ${flags.length - 4} more` : ""}`);
	return out;
}

// A character's CODE from its code spec (absolute paths): build hook (once per {cmd, cwd}, under the lock), the slot
// directory (read once per directory), the entry, the appended files; fitted (code.fit, fit.js: the slots its calls
// load, the slots run before its entry; an ES module entry bundled); with the run's names (names: namesCtx, the slot
// directory's once, a file's once); then composed. The entry: code.entry, else the character's name: a slot of the
// directory (whatever its case; renamed: under its new name), else one renamed to it. cache: { slots, built, named, files }
function codeOf(name, spec, { params, extra, invite }, { build, cache, names = null }, problems) {
	let files = {};
	try {
		spec = GIT.inTree(spec); // code.git: its paths in the commit's tree
	} catch (e) {
		problems.push(`${name}: code.git: ${e.message}`);
		return null;
	}
	const fit = spec.fit || {},
		calls = fit.calls && Object.keys(fit.calls).length ? fit.calls : null,
		bk = spec.build ? JSON.stringify([spec.build.cmd, spec.build.cwd]) : null,
		key = JSON.stringify([spec.dir, spec.recursive, bk, calls]);
	try {
		if (cache.slots.has(key)) files = cache.slots.get(key);
		else {
			files = withLock(spec.dir && path.dirname(spec.dir), () => {
				if (bk && build && !cache.built.has(bk)) runBuild(spec.build), cache.built.add(bk);
				if (!spec.dir) return {};
				if (!fs.existsSync(spec.dir)) throw new Error(`no such directory ${spec.dir}`);
				const t = slotsIn(spec.dir, spec.recursive);
				return calls ? Object.fromEntries(Object.entries(t).map(([s, x]) => [s, F.fitCalls(x, calls)])) : t;
			});
			cache.slots.set(key, files);
		}
	} catch (e) {
		problems.push(`${name}: ${e.message}`);
		return null;
	}
	const raw = files;
	if (names) {
		if (!cache.named.has(key)) cache.named.set(key, namedSlots(raw, names, spec.dir, problems));
		files = cache.named.get(key);
	}
	// a text as this character's CODE reads it: fitted, with the run's names
	const named = (where, t) => (names ? names.text(where, t, Object.keys(raw)) : t);
	// a file read (the entry, an appended one; an ES module entry: bundled), fitted and with the run's names: once
	const read = (p, entry = false) => {
		const k = JSON.stringify([p, entry, calls]);
		if (!cache.files.has(k)) {
			let t = fs.readFileSync(p, "utf8");
			if (entry && F.facts(t).module) t = F.bundle(p, spec.dir || path.dirname(p)) + `\n//# sourceURL=code/${path.basename(p)}\n`;
			cache.files.set(k, named(path.basename(p), F.fitCalls(t, calls)));
		}
		return cache.files.get(k);
	};
	// a slot of the directory by its name, whatever its case (the game's lookup)
	const like = (m, s) => (Object.hasOwn(m, s) ? s : Object.keys(m).find((x) => x.toLowerCase() === F.toFilename(s).toLowerCase()));
	let entry, entryText, slot;
	try {
		if (spec.file) {
			if (!fs.existsSync(spec.file)) return problems.push(`${name}: code.file: no such file ${spec.file}`), null;
			entry = path.basename(spec.file);
			entryText = read(spec.file, true);
		} else {
			const want = spec.entry || name;
			slot = like(raw, want);
			entry = slot != null ? (names ? names.to(slot) : slot) : names ? like(files, want) : null;
			if (entry == null || !Object.hasOwn(files, entry)) return problems.push(`${name}: no slot ${want} in ${spec.dir}${spec.entry ? "" : ` (the default entry is the slot named like the character${names ? ", or the one code_names renames so" : ""}: set code.entry or code.file)`}`), null;
			if (slot == null) slot = Object.keys(raw).find((s) => names.to(s) === entry);
			entryText = F.facts(raw[slot]).module ? read(F.slotFiles(spec.dir, spec.recursive).find((x) => x.slot === slot).file, true) : files[entry];
			// the slots it runs first (fit.with: helpers it calls)
			const w = fit.with && fit.with[Object.keys(fit.with).find((x) => x.toLowerCase() === slot.toLowerCase())];
			const before = [];
			for (const h of w || []) {
				const r = like(raw, h);
				if (r == null) return problems.push(`${name}: code.fit.with ${slot}: no slot ${h} in ${spec.dir}`), null;
				before.push(files[names ? names.to(r) : r]);
			}
			if (before.length) entryText = before.join("\n;") + "\n;" + entryText;
		}
	} catch (e) {
		return problems.push(`${name}: ${e.message}`), null;
	}
	const append = [];
	for (const p of spec.append) {
		if (!fs.existsSync(p)) return problems.push(`${name}: code.append: no such file ${p}`), null;
		append.push(read(p));
	}
	const text = composeEntry({ params, prelude: spec.prelude, entryText, append, extra, invite });
	// slot: the entry's slot on disk, when code_names renamed it
	return { entry, files, text, ...(slot != null && slot !== entry ? { slot } : {}) };
}

// the library's CODE (library.js) at a commit not trusted here, among [[name, code spec]]: a problem each, before anything
// is built or read
function untrustedFail(setup, list) {
	const no = LIB.untrusted(list.filter(([, spec]) => spec));
	if (no.length) fail(no.map(LIB.untrustedText), `${setup.file || "setup"}: ${no.length} problem${no.length > 1 ? "s" : ""}`);
}

// the source of a character's CODE, as a code spec (absolute paths)
const specOf = (src) => ({ dir: src.code_dir, recursive: !!src.recursive, entry: src.entry, file: src.file, prelude: src.prelude, append: src.append || [], build: src.build, ...(src.git ? { git: src.git } : {}), ...(src.fit ? { fit: src.fit } : {}) });

/**
 * A setup (loadSetup) -> { resolved, bundles, warnings }: resolved = the side file's content (states inline, CODE by
 * hash), bundles = { <name>: { entry, text: <composed entry>, files: <slot map> } }.
 * A resolved side file as the input: its CODE from the store (<dir of file>/code, then <dir>/../code for removed/,
 * then store: more directories, e.g. a live dir's code/ for a side file saved elsewhere) and its states; currentCode: each character's CODE from its source instead (build hook included), and `stored` gives
 * the side file's code hashes.
 * @param {object} [o] { build = true (run build hooks), store: a directory or a list, G, currentCode = false, by:
 *   "chronal run" }
 */
function resolveSetup(setup, { build = true, store = null, G, currentCode = false, by = null } = {}) {
	const problems = [],
		cache = { slots: new Map(), built: new Set(), named: new Map(), files: new Map() },
		bundles = {},
		at = new Date().toISOString(),
		runNames = setup.characters.map((c) => c.name),
		names = namesCtx(setup.code_names, runNames);
	if (setup.side) {
		const side = setup,
			stores = [...(setup.dir ? [path.join(setup.dir, "code"), path.join(setup.dir, "..", "code")] : []), ...[].concat(store || [])],
			stored = {},
			own = (o, k) => (o && Object.hasOwn(o, k) ? o[k] : null);
		// a CODE set's code block for a character (code_set_def: chronal run --code-set), as a setup's (loadSetup)
		const def = setup.code_set_def,
			setCode = (c) => {
				const m = def.missing[c.name],
					src = own(side.source.characters, c.name);
				if (m === "idle") return { file: IDLE, append: [] };
				return { ...codeFor(m ? { ...def.set, entries: { ...def.set.entries, [c.name]: m.slice(5) } } : def.set, c.name, c.class), ...(src && src.prelude != null ? { prelude: src.prelude } : {}) };
			},
			source = def ? { ...side.source, characters: { ...side.source.characters }, code_set: setup.code_set } : side.source;
		// (its stored CODE ran once: the current CODE of its source, or a set's, is read only at a trusted commit)
		if (currentCode) untrustedFail(setup, side.characters.map((c) => [c.name, own(side.source.characters, c.name) && specOf(own(side.source.characters, c.name))]));
		else if (def) untrustedFail(setup, side.characters.map((c) => [c.name, setCode(c)]));
		const characters = side.characters.map((c) => {
			if (!c.state) problems.push(`${c.name}: no state`);
			stored[c.name] = c.code.hash;
			let code = c.code;
			if (def) {
				const spec = setCode(c),
					src = own(side.source.characters, c.name) || {},
					extra = def.missing[c.name] === "idle" ? [] : src.extra || [],
					b = codeOf(c.name, spec, { params: c.params, extra, invite: inviteOf(side.party, c.name) }, { build, cache, names }, problems);
				if (b) {
					(bundles[c.name] = b), (code = codeBlock(b.entry, b.files, b.text));
					source.characters[c.name] = { ...src, code_dir: spec.dir, recursive: spec.recursive, code_git: spec.git ? String(spec.git.commit || spec.git.rev).slice(0, 7) : null, git: spec.git, entry: spec.file ? null : b.slot || spec.entry || c.name, file: spec.file, append: spec.append, extra, prelude: spec.prelude, build: spec.build, fit: spec.fit };
				}
			} else if (currentCode) {
				const src = own(side.source.characters, c.name);
				if (!src) problems.push(`${c.name}: no source to take the current CODE from`);
				else {
					const b = codeOf(c.name, specOf(src), { params: c.params, extra: src.extra || [], invite: inviteOf(side.party, c.name) }, { build, cache, names }, problems);
					if (b) (bundles[c.name] = b), (code = codeBlock(b.entry, b.files, b.text));
				}
			} else {
				const d = stores.find((x) => fs.existsSync(path.join(x, c.code.slots + ".json")) && fs.existsSync(path.join(x, c.code.text + ".js")));
				if (!d) problems.push(`${c.name}: CODE ${c.code.slots}.json / ${c.code.text}.js in none of ${stores.join(", ") || "(no store)"}`);
				else {
					const json = fs.readFileSync(path.join(d, c.code.slots + ".json"), "utf8"),
						text = fs.readFileSync(path.join(d, c.code.text + ".js"), "utf8");
					if (sha(json) !== c.code.slots || sha(text) !== c.code.text) problems.push(`${c.name}: the stored CODE in ${d} does not match its hash`);
					else bundles[c.name] = { entry: c.code.entry, files: JSON.parse(json), text };
				}
			}
			return { ...c, code };
		});
		const accounts = side.accounts;
		if (problems.length) fail(problems, `${setup.file || "setup"}: ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
		const { resolved: _r, ...rest } = side;
		const resolved = { format: FORMAT, resolved: { at, by, from: setup.file }, ...rest, run: side.run, world: side.world, accounts, characters, source };
		return { resolved, bundles, warnings: (currentCode || def) && names ? namesWarnings(names, runNames) : [], stored };
	}
	untrustedFail(setup, setup.characters.map((c) => [c.name, c.code]));
	const game = gameOf(G),
		spawn = game.maps.main.spawns[0],
		source = { characters: {}, accounts: {}, ...(setup.code_set ? { code_set: setup.code_set } : {}) },
		gits = new Map(),
		git = (d) => (gits.has(d) ? gits.get(d) : gits.set(d, gitVersion(d)).get(d));
	const accounts = {},
		bankNotes = [];
	for (const [k, a] of Object.entries(setup.accounts)) {
		let bank = null,
			cash = a.cash ?? null;
		if (a.bank && a.bank.from) {
			const e = readExport(a.bank.from),
				b = e.bank || {},
				left = Object.keys(b).filter((x) => !BANK_KEY.test(x));
			bank = Object.fromEntries(Object.entries(structuredClone(b)).filter(([x]) => BANK_KEY.test(x)));
			if (left.length) bankNotes.push(`account ${k}: bank.from ${path.basename(a.bank.from)}: ${left.join(", ")} not taken (gold, items<N>, unlocked, rewards are)`);
			if (cash == null && e.account && Number.isFinite(e.account.cash)) cash = e.account.cash; // (the account's shells)
			source.accounts[k] = { bank_from: a.bank.from };
		} else if (a.bank) bank = structuredClone(a.bank);
		if (bank) bank = withDoors(bank, k, bankNotes);
		accounts[k] = { age_days: a.age_days, bank, ...(cash != null ? { cash } : {}), ...(a.linked ? { linked: { ...a.linked } } : {}), ...(a.storage ? { storage: structuredClone(a.storage) } : {}), ...(a.local_storage ? { local_storage: { ...a.local_storage } } : {}) };
	}
	const characters = setup.characters.map((c) => {
		const st = c.state || {},
			exp = st.from ? readExport(st.from) : null,
			state = startState(game, c.class, st, exp && exp.character);
		const b = codeOf(c.name, c.code, { params: c.params, extra: c.extra, invite: inviteOf(setup.party, c.name) }, { build, cache, names }, problems);
		if (b) bundles[c.name] = b;
		source.characters[c.name] = {
			code_dir: c.code.dir, recursive: c.code.recursive, code_git: c.code.git ? c.code.git.commit.slice(0, 7) : git(c.code.dir || path.dirname(c.code.file)), ...(c.code.git ? { git: c.code.git } : {}), entry: c.code.file ? null : (b && b.slot) || c.code.entry || c.name, file: c.code.file,
			append: c.code.append, extra: c.extra, prelude: c.code.prelude, build: c.code.build, ...(c.code.fit ? { fit: c.code.fit } : {}), state_from: st.from || null, exported_at: exp ? exp.exported_at || null : null,
		};
		return {
			name: c.name, class: c.class, account: c.account, role: c.role, fps: c.fps, at: c.at || { map: "main", x: spawn[0], y: spawn[1] }, params: c.params, state,
			code: b ? codeBlock(b.entry, b.files, b.text) : null, ...(c.note ? { note: c.note } : {}), ...(c.online === false ? { online: false } : {}),
		};
	});
	if (problems.length) fail(problems, `${setup.file || "setup"}: ${problems.length} problem${problems.length > 1 ? "s" : ""}`);
	const resolved = {
		format: FORMAT, resolved: { at, by, from: setup.file }, name: setup.name, strategy: setup.strategy, ...(setup.notes ? { notes: setup.notes } : {}),
		run: setup.run, world: setup.world, party: setup.party, ...(setup.code_names ? { code_names: setup.code_names } : {}), ...(setup.steer ? { steer: setup.steer } : {}), accounts, characters, source,
	};
	return { resolved, bundles, warnings: [...bankNotes, ...(names ? namesWarnings(names, runNames) : [])] };
}

// accounts.<k>.linked: a Steam- or MAS-linked account ({ platform, pid, newcomer }, null: a web account): its pid (a
// fixed 17 digits per account by default), the Newcomers' Blessing still to come ("auto") or claimed -> resolved or null
function linkedOf(k, L, w, problems, unknown) {
	if (L == null) return null;
	if (!isObj(L)) return problems.push(`${w}linked: { platform: "steam" | "mas", pid, newcomer: "auto" | "claimed" } or null`), null;
	unknown(L, KEYS.linked, w + "linked.");
	if (!["steam", "mas"].includes(L.platform)) problems.push(`${w}linked.platform: "steam" or "mas"`);
	if (L.pid != null && !(typeof L.pid === "string" && /^[\w.-]{1,64}$/.test(L.pid))) problems.push(`${w}linked.pid: an id (letters, digits, _.-)`);
	if (L.newcomer != null && !["auto", "claimed"].includes(L.newcomer)) problems.push(`${w}linked.newcomer: "auto" or "claimed"`);
	const pid = L.pid ?? "7656119" + String(parseInt(sha("linked:" + k, 12), 16)).slice(0, 10).padStart(10, "0");
	return { platform: L.platform, pid, newcomer: L.newcomer || "auto" };
}

// a bank's keys a setup takes: gold, its packs, the unlocked rooms and the rewards claimed (the server's user.info)
const BANK_KEY = /^(gold|items\d+|unlocked|rewards)$/;
// the bank's rooms its packs are in (the game's bank_packs: items8-23 in bank_b, items24-47 in bank_u): a bank holding
// one is unlocked there (an API pull's bank has no unlocked: its doors would refuse the merchant)
function withDoors(bank, k, notes) {
	const need = new Set();
	for (const x of Object.keys(bank)) {
		const m = /^items(\d+)$/.exec(x);
		if (m && +m[1] >= 24) need.add("bank_u");
		else if (m && +m[1] >= 8) need.add("bank_b");
	}
	const missing = [...need].filter((r) => !(bank.unlocked && bank.unlocked[r]));
	if (!missing.length) return bank;
	notes.push(`account ${k}: bank ${missing.join(", ")} unlocked (it has packs there)`);
	return { ...bank, unlocked: { ...(bank.unlocked || {}), ...Object.fromEntries(missing.map((r) => [r, true])) } };
}

/**
 * A character's start state from its setup state (st) and export's character (x, or null): an export: its level, xp,
 * gold, items and gear, the ones given on top (slots replace its gear); fresh: L1, 0 xp, 0 gold, the starter pots and
 * gear (slots given replace the starter weapon, helmet and shoes). The gear goes over the starter gear slot by slot, as
 * a new character's: an item replaces the starter's whole (it takes none of its fields, such as the starter's gift); an
 * export's (or its given slots) empties the starter's slots it doesn't list (no starter item comes back). Its looks
 * (skin and cosmetics) when given or exported (a snippet's export, a public page's; the API's has none): without them
 * the class's default. -> { level, xp, gold, items, slots[, skin, cx] }
 */
function startState(game, cls, st, x) {
	const skin = st.skin ?? (x && x.skin) ?? null;
	return {
		level: st.level ?? (x ? x.level : 1), xp: st.xp ?? (x ? x.xp : 0), gold: st.gold ?? (x ? x.gold || 0 : 0),
		items: structuredClone(st.items ?? (x ? x.items || [] : STARTER_ITEMS())),
		slots: x
			? { ...Object.fromEntries(Object.keys(starter(game, cls)).map((k) => [k, null])), ...structuredClone(st.slots ?? x.slots ?? {}) }
			: { ...starter(game, cls), ...structuredClone(st.slots != null ? { mainhand: null, helmet: null, shoes: null, ...st.slots } : {}) },
		...(skin ? { skin, cx: structuredClone(st.cx ?? (x && x.cx) ?? {}) } : {}),
		...serverState(st, x),
	};
}

// a character's server-side state: an export's tracker kill counts (the tracker's stats: p.stats), then the setup's p
// key by key; its conditions (s) only when the setup gives them -> { p?, s? }
function serverState(st, x) {
	const t = x && x.tracker,
		p = {};
	if (t) p.stats = structuredClone({ monsters: t.monsters || {}, monsters_diff: t.monsters_diff || {}, exchanges: t.exchanges || {} });
	Object.assign(p, structuredClone(st.p || {}));
	return { ...(Object.keys(p).length ? { p } : {}), ...(st.s ? { s: structuredClone(st.s) } : {}) };
}

/** createCharacter's `over` for a resolved character: level, xp and info { gold, items, slots, map, in, x, y[, skin, cx] } */
function characterOver(rc) {
	const s = rc.state,
		at = rc.at;
	return structuredClone({ level: s.level, xp: s.xp, info: { gold: s.gold, items: s.items, slots: s.slots, map: at.map, in: at.map, x: at.x, y: at.y, ...(s.skin ? { skin: s.skin, cx: s.cx } : {}), ...(s.p ? { p: s.p } : {}), ...(s.s ? { s: s.s } : {}) } });
}

/** createCharacter's `user` for a resolved account (with its first character): an established account (verified, no
 * DRM debuff), its bank (without one none of its keys: a new account's 1000 gold and two empty packs) and its cash */
function accountUser(ra) {
	return { ...(ra && ra.cash != null ? { cash: ra.cash } : {}), info: { verified: true, legacy_override: true, ...(ra && ra.bank ? structuredClone(ra.bank) : {}) } };
}

/** The account's dates for its age: created (the user and its characters) and oldest (info.p.encouragement), startMs -
 * age_days; null for 0 days (a new account: New Player) */
function ageOf(ra, startMs) {
	const d = ra && ra.age_days;
	return d > 0 ? { created: Math.round(startMs - d * DAY), oldest: Math.round(startMs - d * DAY) } : null;
}

/** Write each bundle's slot map (<sha>.json) and composed entry (<sha>.js) into the store, once (an existing blob is
 * kept); -> { <name>: { slots: <sha>, text: <sha> } } */
function storeBundles(bundles, storeDir) {
	fs.mkdirSync(storeDir, { recursive: true });
	const put = (name, data) => {
		const f = path.join(storeDir, name);
		if (fs.existsSync(f)) return;
		const tmp = f + "." + process.pid + ".tmp";
		fs.writeFileSync(tmp, data);
		fs.renameSync(tmp, f);
	};
	const out = {};
	for (const [n, b] of Object.entries(bundles)) {
		const json = slotsJson(b.files),
			slots = sha(json),
			text = sha(b.text);
		put(slots + ".json", json);
		put(text + ".js", b.text);
		out[n] = { slots, text };
	}
	return out;
}

/** sha8 of what defines the run: the resolved setup without RUN_ONLY, its provenance (resolved, source) and notes,
 * with the code hashes (in characters[].code) and the sim version */
function setupKey(resolved, simVersion) {
	const { resolved: _r, source: _s, ...r } = structuredClone(resolved);
	for (const p of RUN_ONLY) {
		const [a, b] = p.split(".");
		if (b) r[a] && delete r[a][b];
		else delete r[a];
	}
	r.characters = (r.characters || []).map(({ note, ...c }) => c);
	return sha(canonical({ ...r, sim: simVersion }), 8);
}

/** snapshot `setup.hash`: sha8 of the side file without resolved */
function sideHash(side) {
	const { resolved: _r, ...r } = side;
	return sha(canonical(r), 8);
}

/** snapshot `versions.code_hash`: sha8 of the sorted [name, code.hash] pairs */
function codeHash(resolved) {
	return sha(JSON.stringify(resolved.characters.map((c) => [c.name, c.code && c.code.hash]).sort((a, b) => (a[0] < b[0] ? -1 : 1))), 8);
}

/** A readable name for what ran (setup.strategy wins): the roster ("ranger L40 + priest L40 + merchant"), " (no party)"
 * when formed === false, " (party by CODE)", each distinct farm, the notes and each character's extras (80 chars) */
function strategyText(resolved, { formed } = {}) {
	if (resolved.strategy) return resolved.strategy;
	const cs = resolved.characters,
		party = resolved.party,
		lv = (c) => (c.state && c.state.level != null ? " L" + c.state.level : "");
	const who = [...cs.filter((c) => c.class !== "merchant").map((c) => c.class + lv(c)), ...(cs.some((c) => c.class === "merchant") ? ["merchant"] : [])].join(" + ");
	const parts = [who + (formed === false ? " (no party)" : party && party.form === "code" ? " (party by CODE)" : "")];
	const farms = new Set();
	for (const c of cs) {
		const f = c.params && c.params.farm;
		if (f) farms.add((f.monsters && f.monsters.length ? f.monsters.join("/") : "any") + (f.map ? ` @ ${f.map} ${f.x},${f.y}` : ""));
	}
	parts.push(...farms);
	if (resolved.notes) parts.push(resolved.notes);
	for (const c of cs) if (c.note) parts.push(`${c.name}: ${c.note}`);
	const src = (resolved.source && resolved.source.characters) || {};
	for (const c of cs) {
		const x = src[c.name] && src[c.name].extra;
		if (x && x.length) parts.push(`${c.name}: ${x.join(" ").replace(/\s+/g, " ").trim().slice(0, 80)}`);
	}
	return parts.filter(Boolean).join(" | ") || "default";
}

module.exports = { FORMAT, RUN_ONLY, ROLES, parseDuration, loadSetup, storageEntries, steerText, resolveSetup, runBuild, starter, startState, readExport, composeEntry, characterOver, accountUser, ageOf, storeBundles, setupKey, sideHash, codeHash, strategyText, gitVersion, simVersion, SIM_PATHS, ROOT, design };
