"use strict";
// The dashboard's Settings (api/config): the live account's API token (pasted, tested against the game's token API,
// saved in config al_token_file, by default config/al_token, mode 0600; never sent back to the page), and the
// folders and port of config/local.json (applied when chronal dash starts again).
const fs = require("node:fs"),
	path = require("node:path");
const { ROOT, config, sources, setLocal } = require("../lib/config");
const P = require("../lib/pull");

const API = () => process.env.CHRONAL_AL_API || "https://adventure.land/mcp_api";
const DEFAULT_TOKEN = path.join(ROOT, "config", "al_token");
// a token as the game makes them: letters, digits and a few signs, no spaces
const okToken = (t) => typeof t === "string" && /^[\w.:+/=-]{8,512}$/.test(t.trim());

/** where the token comes from: env, a file, or none. Settings writes the file when it is ChronAL's own (config/al_token:
 *  ours, which it may also forget) or doesn't exist yet: a token file of yours it never overwrites */
function tokenInfo() {
	const file = config().al_token_file,
		ours = !!file && path.resolve(file) === DEFAULT_TOKEN;
	if (process.env.CHRONAL_AL_TOKEN) return { source: "env", file, ours, writable: false };
	const has = !!file && fs.existsSync(file);
	return { source: has ? "file" : "none", file, ours, writable: !!file && (ours || !has) };
}

/** GET api/config: the token's source; each path's and the port's value and where it comes from */
function info() {
	const s = sources(),
		rel = (v) => (typeof v === "string" && v.startsWith(ROOT + path.sep) ? path.relative(ROOT, v) : v);
	return [200, { token: { ...tokenInfo(), file: rel(config().al_token_file) }, settings: s, local_file: path.join("config", "local.json"), root: ROOT }];
}

/** POST api/config/token { action: "test" | "save", token? }: test asks the game which account it is (read-only); save
 *  tests it, then writes it (mode 0600). Without a token: the one set now. -> { characters: [{ name, class, level }] } */
async function token(b) {
	const action = b && b.action,
		t = b && typeof b.token === "string" ? b.token.trim() : null;
	if (action !== "test" && action !== "save") return [400, { reason: "action: test or save" }];
	if (t != null && !okToken(t)) return [400, { reason: "that doesn't look like a token (letters and digits, no spaces): copy it whole from adventure.land/vscode" }];
	const ti = tokenInfo();
	if (action === "save" && !ti.writable) return [409, { reason: ti.source === "env" ? "the token comes from CHRONAL_AL_TOKEN: change it there" : !ti.file ? "config al_token_file is none: set it (Folders and port) first" : `${ti.file} is your token file (config al_token_file): ChronAL doesn't overwrite it. Change it there, or drop al_token_file from config/local.json to keep the token in config/al_token` }];
	if (action === "save" && t == null) return [400, { reason: "token: the one to save" }];
	let tok = t;
	if (tok == null)
		try {
			tok = P.token();
		} catch (e) {
			return [400, { reason: e.message }];
		}
	let characters;
	try {
		characters = await P.accountOf(API(), tok);
	} catch (e) {
		return [502, { reason: /invalid_token|not_found|unauthor/i.test(e.message) ? "the game doesn't know this token (" + e.message + "): create a new one at adventure.land/vscode" : "the game's token API: " + e.message }];
	}
	if (action === "save") {
		const f = ti.file;
		fs.mkdirSync(path.dirname(f), { recursive: true });
		fs.writeFileSync(f, tok + "\n", { mode: 0o600 });
		fs.chmodSync(f, 0o600);
	}
	return [200, { characters, saved: action === "save" }];
}

/** DELETE api/config/token: config/al_token removed (only ChronAL's own file) */
function forget() {
	const ti = tokenInfo();
	if (!ti.ours) return [409, { reason: ti.source === "env" ? "the token comes from CHRONAL_AL_TOKEN" : `the token is in ${ti.file}, not ChronAL's own file: remove it there` }];
	if (ti.source === "file") fs.rmSync(ti.file, { force: true });
	return [200, { forgotten: true }];
}

/** PUT api/config { set: { <path key or port>: value, or null: back to the default } }: config/local.json changed */
function put(b) {
	const set = b && b.set;
	if (!set || typeof set !== "object" || Array.isArray(set)) return [400, { reason: "set: { key: value or null }" }];
	const s = sources();
	for (const k of Object.keys(set)) if (s[k] && s[k].from === "env") return [409, { reason: `${k} comes from ${s[k].env}: change it there` }];
	try {
		setLocal(set);
	} catch (e) {
		return [400, { reason: e.message }];
	}
	return info();
}

module.exports = { info, token, forget, put, tokenInfo };
