"use strict";
// Settings: config/defaults.json holds the defaults; config/local.json (gitignored, optional) overrides them per
// machine. Paths are relative to this checkout (null = none):
//   al_root        the game the sim runs (default runtime/app: chronal install's copy of upstream)
//   upstream       the game's three repos (chronal install clones them there when missing)
//   live_dir       run snapshots (the dashboard's runs)
//   g_data         a G file (else the newest cache/G-<version>.json: chronal g-data)
//   al_token_file  a file whose first line is the live account's API token (chronal pull; the dashboard's Settings
//                  saves one in config/al_token, mode 0600)
//   pulls_dir      chronal pull's pulls; players_dir: other players' public pages (chronal pull --player)
//   code_sets      the CODE sets file (lib/code_sets.js); library_dir: the CODE library (lib/library.js)
//   setups_dir     where chronal new writes setups
//   accounts_dir   crafted accounts (lib/accounts.js: the dashboard's Accounts)
//   gear_sets_dir  your gear sets (lib/gear_sets.js)
// A path also comes from a caller's `cli` values, else env CHRONAL_<KEY> (e.g. CHRONAL_LIVE_DIR), before the files.
// port: the dashboard's (chronal dash).
//   config/local.json: { "g_data": "../data_live.js", "port": 18089 }
const fs = require("node:fs"),
	path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const PATHS = ["al_root", "upstream", "live_dir", "g_data", "al_token_file", "pulls_dir", "players_dir", "code_sets", "library_dir", "setups_dir", "accounts_dir", "gear_sets_dir"];

function read(file) {
	try {
		return JSON.parse(fs.readFileSync(file, "utf8"));
	} catch (e) {
		if (e.code === "ENOENT") return {};
		throw new Error(`${file}: ${e.message}`);
	}
}
// (CHRONAL_LOCAL_CONFIG: another local.json, e.g. a test's)
const DEFAULTS = path.join(ROOT, "config", "defaults.json"),
	LOCAL = process.env.CHRONAL_LOCAL_CONFIG ? path.resolve(process.env.CHRONAL_LOCAL_CONFIG) : path.join(ROOT, "config", "local.json");
const cfg = { ...read(DEFAULTS), ...read(LOCAL) };

/** The paths, absolute (null: none). @param {object} [o] @param {object} [o.cli] { <key>: path } from a command line (relative to the cwd) */
function config({ cli = {} } = {}) {
	const out = {};
	for (const k of PATHS) {
		const env = process.env["CHRONAL_" + k.toUpperCase()];
		if (cli[k] != null && cli[k] !== "") out[k] = path.resolve(String(cli[k]));
		else if (env) out[k] = path.resolve(env);
		else out[k] = cfg[k] == null ? null : path.resolve(ROOT, String(cfg[k]));
	}
	return out;
}

/** The G file to read: c.g_data, else the newest cache/G-<version>.json (chronal g-data writes it), else null. */
function gData(c = config()) {
	if (c.g_data) return c.g_data;
	let best = null,
		version = -Infinity;
	try {
		for (const f of fs.readdirSync(path.join(ROOT, "cache"))) {
			const m = /^G-(\d+)\.json$/.exec(f);
			if (m && +m[1] > version) (version = +m[1]), (best = path.join(ROOT, "cache", f));
		}
	} catch (e) {}
	return best;
}

/**
 * Where each setting comes from, as the files are now (a running process keeps what it read at its start):
 * { <key>: { value, from: "env" | "local" | "default", env, local, default } } for the paths and the port.
 */
function sources() {
	const def = read(DEFAULTS),
		loc = read(LOCAL),
		out = {};
	for (const k of [...PATHS, "port"]) {
		const env = k === "port" ? null : "CHRONAL_" + k.toUpperCase(),
			e = env && process.env[env];
		out[k] = { value: e || (k in loc ? loc[k] : def[k] ?? null), from: e ? "env" : k in loc ? "local" : "default", env, local: k in loc ? loc[k] : undefined, default: def[k] ?? null };
	}
	return out;
}

/**
 * config/local.json with these settings changed: { <key>: value, or null to drop it (back to the default) }; the
 * paths and the port only. -> the file's content
 */
function setLocal(changes) {
	const loc = read(LOCAL);
	for (const [k, v] of Object.entries(changes)) {
		if (![...PATHS, "port"].includes(k)) throw new Error(`${k}: not a setting here (${[...PATHS, "port"].join(", ")})`);
		if (v === null) delete loc[k];
		else if (k === "port" ? !(Number.isInteger(v) && v > 0 && v < 65536) : typeof v !== "string" || !v.trim() || /[\0\n]/.test(v)) throw new Error(`${k}: ${k === "port" ? "a port, 1-65535" : "a path"}`);
		else loc[k] = k === "port" ? v : v.trim();
	}
	fs.writeFileSync(LOCAL, JSON.stringify(loc, null, 2) + "\n");
	return loc;
}

module.exports = { ROOT, PATHS, cfg, config, gData, sources, setLocal };
