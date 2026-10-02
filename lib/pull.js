#!/usr/bin/env node
"use strict";
// Pull a live account through Adventure Land's token API (the one the VS Code extension and code/upload.js use) into a
// folder that setups (state.from, bank.from, code.dir) read. Read-only: it changes nothing on the account.
//   chronal pull                   every character, the bank and the CODE slots -> <pulls_dir>/<account>/<time>/
//   chronal pull --add FILE...     snippet exports (snippets/export-state.js) over the latest pull's
//   chronal pull --list            the pulls, and the players' pages taken
//   chronal pull --player NAME     another player: the game site's public page of NAME's account (every character's
//                                        class, level and gear; no inventory, gold, bank or CODE) -> <players_dir>/<account>/<time>/
//   chronal pull --top [TEXT]      the site's top 500 characters (those whose name or class has TEXT)
// Options: --account NAME (the folder; default: the account's first character name in sort order), --into DIR (--add:
// that pull instead of the latest), --no-code, --no-game-check. Token: CHRONAL_AL_TOKEN, else the first line of the file config
// al_token_file (config/al_token: the dashboard's Settings saves it there); CHRONAL_AL_API overrides https://adventure.land/mcp_api, CHRONAL_AL_SITE the site (https://adventure.land) --player and
// --top read.
//
// A pull folder:
//   pull.json         what was pulled (format chronal-pull/1): the characters, the bank, the CODE, the account's age,
//                     the game check, warnings, snippet overrides
//   <Name>.json       a character as the snippet writes it (chronal-export/1), the pull's bank included
//   <Name>.api.json   the API's copy of a character a snippet export replaced
//   bank.json         { bank, bank_source }: the pull's bank (the API's, or a snippet's taken inside the bank)
//   code/<slot>.js    the CODE slots by name (a character's own slot is named after it); code/slots.json lists them
//   game-diff.json    the game data entries live differs in from the sim's game (config al_root): { section: { key: { live, local } } }
// A player's page taken (--player) is a folder of the same kind (pull.json with source "public", a <Name>.json per
// character): no bank, no CODE, no account age; each character's gear, level and looks, nothing else.
const fs = require("node:fs"),
	path = require("node:path"),
	vm = require("node:vm");
const { config } = require("./config");

const FORMAT = "chronal-pull/1",
	EXPORT = "chronal-export/1",
	DAY = 86400e3,
	NEW_PLAYER_DAYS = 40; // node/logic/encouragement.js: encouragement_new expires 40 days after the account's oldest character
// main.js evaluates the design files in this order
const DESIGN = ["projectiles", "animations", "achievements", "game_design", "games", "conditions", "sprites", "dimensions", "monsters", "maps", "npcs", "multipliers", "items", "classes", "levels", "upgrades", "drops", "skills", "events", "recipes", "titles", "tokens"];
// the API's game data sections a run depends on
const SECTIONS = ["items", "monsters", "skills", "classes", "conditions", "drops", "levels", "sets", "titles", "maps", "npcs", "multipliers", "games", "craft", "dismantle", "tokens", "events", "achievements", "dimensions", "projectiles"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (f, v) => fs.writeFileSync(f, JSON.stringify(v, null, 1) + "\n");
// JSON with sorted keys: live and local data compare by content, not key order
const canon = (v) => (Array.isArray(v) ? "[" + v.map(canon).join(",") + "]" : v && typeof v === "object" ? "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + canon(v[k])).join(",") + "}" : JSON.stringify(v));

function token() {
	if (process.env.CHRONAL_AL_TOKEN) return process.env.CHRONAL_AL_TOKEN.trim();
	const file = config().al_token_file;
	if (!file || !fs.existsSync(file)) throw new Error(`no token: create one at https://adventure.land/vscode, then paste it in the dashboard's Settings${file ? " (or save it in " + file + ")" : ""}, or set CHRONAL_AL_TOKEN`);
	const t = fs.readFileSync(file, "utf8").split("\n")[0].trim();
	if (!t) throw new Error(`no token in ${file}`);
	return t;
}

/**
 * An export's text as snippets/export-state.js leaves it: its JSON (a file, or the clipboard), or on the clipboard
 * when large "chronal-export:gz:" and the gzipped JSON in base64. -> the export (chronal-export/1); throws with where
 */
function exportFromText(text, where = "export") {
	let t = String(text || "").trim();
	if (t.startsWith("chronal-export:gz:")) {
		try {
			t = require("node:zlib").gunzipSync(Buffer.from(t.slice(18).replace(/\s+/g, ""), "base64")).toString("utf8");
		} catch (e) {
			throw new Error(`${where}: a compressed export, cut short or changed (${e.message}): copy it again`);
		}
	}
	let e;
	try {
		e = JSON.parse(t);
	} catch (x) {
		throw new Error(`${where}: not an export (neither JSON nor chronal-export:gz:): ${x.message}`);
	}
	if (!e || e.format !== EXPORT || !e.character || typeof e.character !== "object") throw new Error(`${where}: not an export (format ${EXPORT}, from snippets/export-state.js)`);
	return e;
}

/** The characters of the account behind a token ({ name, class, level }); throws with the API's reason it refuses */
async function accountOf(api, tok) {
	const list = (await client(api, tok)("mainframe_list_characters")).characters || [];
	return list.map((c) => ({ name: c.character, class: c.class, level: c.level }));
}

/** call(method, body): the API's JSON; waits out rate limits, throws on { failed } */
function client(api, tok) {
	const base = api.replace(/\/+$/, "");
	return async function call(method, body = {}) {
		for (let attempt = 0; ; attempt++) {
			const res = await fetch(`${base}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: tok, ...body }) });
			const text = await res.text();
			let data;
			try {
				data = JSON.parse(text);
			} catch (e) {
				throw new Error(`${method}: HTTP ${res.status} ${text.slice(0, 120)}`);
			}
			if (data.reason === "rate_limited" && attempt < 30) {
				await sleep((data.retry_after_ms || Number(res.headers.get("retry-after")) * 1000 || 2000) + 100);
				continue;
			}
			if (data.failed) throw new Error(`${method}${body.character ? " " + body.character : body.slot ? " slot " + body.slot : body.section ? " " + body.section : ""}: ${data.reason}`);
			return data;
		}
	};
}

// the API's bank (get_bank) as an export's: its packs and gold; "locked" back to the game's l
function bankOf(b) {
	const out = { gold: b.gold };
	for (const [k, items] of Object.entries(b.packs || {}))
		out[k] = items.map((i) => {
			if (!i) return null;
			const { locked, ...rest } = i;
			return locked ? { ...rest, l: "l" } : rest;
		});
	return out;
}

// a character's detail (mainframe_get_character) as snippets/export-state.js writes it; exported_at is the pull's time
// for every character (one snapshot of the account), the character's last save in source.synchronized_at
function exportOf(p, roster, bank, bankSource, pulledAt) {
	return {
		format: EXPORT,
		exported_at: pulledAt,
		realm: p.server || null,
		source: { from: "api", synchronized_at: p.synchronized_at || null, pulled_at: pulledAt },
		character: {
			name: p.name, class: p.class, level: p.level, xp: p.xp, gold: p.gold, hp: p.hp, mp: p.mp, rip: p.rip, isize: p.inventory_slots,
			items: p.inventory || [], slots: p.equipment || {}, s: p.conditions || {}, q: p.quests || {}, map: p.map, in: p.map, x: p.x, y: p.y,
		},
		bank,
		bank_source: bankSource,
		account: { characters: roster },
	};
}

// the account's age from a character's New Player condition (it expires 40 days after the oldest character)
function ageOf(profiles, pulledAt) {
	for (const p of profiles) {
		const e = p.conditions && p.conditions.encouragement_new;
		if (!e || !Number.isFinite(e.expires)) continue;
		const created = e.expires - NEW_PLAYER_DAYS * DAY;
		return { days: Math.max(0, Math.round(((Date.parse(pulledAt) - created) / DAY) * 100) / 100), created: new Date(created).toISOString(), from: `${p.name}: encouragement_new expires ${new Date(e.expires).toISOString()}` };
	}
	return { days: null, created: null, from: "no New Player condition: the account is 40 days old or more" };
}

/** A section of the game's design files, as main.js evaluates them from `root`: get(name) -> JSON text | undefined */
function localGame(root) {
	const ctx = vm.createContext({}),
		failed = [];
	for (const f of DESIGN) {
		const file = path.join(root, "design", f + ".js");
		if (!fs.existsSync(file)) continue;
		try {
			vm.runInContext(fs.readFileSync(file, "utf8"), ctx, { filename: file });
		} catch (e) {
			failed.push(`${f}.js: ${e.message}`);
		}
	}
	const get = (name) => {
		try {
			return vm.runInContext(`typeof ${name} === "undefined" ? undefined : JSON.stringify(${name})`, ctx);
		} catch (e) {
			return undefined;
		}
	};
	return { get, failed };
}

// Whether two game data entries differ in wording only: every differing value is prose on both sides (a string with a
// space, or an explanation / says / interaction / text / label). Types and keys ("physical", "weapon") have no spaces.
const TEXT_KEYS = new Set(["explanation", "says", "interaction", "text", "label", "result"]);
function textOnly(a, b, key = null) {
	if (canon(a) === canon(b)) return true;
	if (typeof a === "string" && typeof b === "string") return (key != null && TEXT_KEYS.has(key)) || (/\s/.test(a) && /\s/.test(b));
	if (a && b && typeof a === "object" && typeof b === "object" && Array.isArray(a) === Array.isArray(b)) {
		const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
		return [...keys].every((k) => textOnly(a[k], b[k], Array.isArray(a) ? key : k));
	}
	return false;
}

/** Live game data vs the sim's game: { root, version, sections: { <s>: { entries, differ: [keys], text: [keys: wording only] } },
 * no_local, failed }, diff */
async function gameCheck(call, root) {
	const index = await call("get_game_data"),
		game = localGame(root),
		out = { root, version: index.version ?? null, sections: {}, no_local: [], failed: game.failed },
		diff = {};
	for (const s of SECTIONS.filter((s) => index.sections.includes(s))) {
		const text = game.get(s);
		if (text === undefined) {
			out.no_local.push(s);
			continue;
		}
		const live = (await call("get_game_data", { section: s })).data || {},
			local = JSON.parse(text) || {},
			all = [...new Set([...Object.keys(live), ...Object.keys(local)])].filter((k) => canon(live[k]) !== canon(local[k])).sort(),
			isText = (k) => textOnly(live[k], local[k]);
		out.sections[s] = { entries: Object.keys(live).length, differ: all.filter((k) => !isText(k)), text: all.filter(isText) };
		if (all.length) diff[s] = Object.fromEntries(all.map((k) => [k, { live: live[k] ?? null, local: local[k] ?? null, ...(isText(k) ? { text_only: true } : {}) }]));
	}
	return { check: out, diff };
}

// a slot name as a file name: any name without path characters
const fileName = (name) => (typeof name === "string" && name && !/[/\\\0]/.test(name) && name !== "." && name !== ".." ? name + ".js" : null);

/**
 * Pull the account behind the token into <root>/<account>/<time>/.
 * @param {object} o  { root: the pulls dir, api, token, account?, code: true, game: an al_root to check live's game data
 *                    against (null: no check), now: Date }
 * @returns {Promise<{ dir, meta }>}
 */
async function pull({ root, api, token: tok, account = null, code = true, game = null, now = new Date(), log = () => {} }) {
	const call = client(api, tok),
		pulledAt = now.toISOString(),
		warnings = [];
	const list = (await call("mainframe_list_characters")).characters || [];
	if (!list.length) throw new Error("the account has no characters");
	account = account || list.map((c) => c.character).sort()[0];
	if (!/^[\w.-]+$/.test(account)) throw new Error(`account: ${JSON.stringify(account)} (letters, digits, _ . -)`);
	log(`${list.length} characters`);
	const profiles = [];
	for (const c of list) profiles.push((await call("mainframe_get_character", { character: c.character })).profile);
	const b = await call("get_bank"),
		bank = bankOf(b),
		bankSource = { from: "api", at: b.retrieved_at || pulledAt, freshness: b.freshness || null };
	if (b.stale) warnings.push(`the bank is open in game: its saved copy may be stale (export from inside the bank with the snippet and --add it for the exact one)`);
	for (const p of profiles) {
		const busy = Object.keys(p.quests || {}).length || (p.inventory || []).some((i) => i && i.name === "placeholder");
		if (busy) warnings.push(`${p.name} was mid-upgrade/compound/exchange: its result exists only on the live server (pull again once its queue is empty)`);
	}
	for (const p of profiles) if (p.online) warnings.push(`${p.name} is online${p.server ? " (" + p.server + ")" : ""}: its state is the game's last save (${p.synchronized_at || "unknown"}; saved about every 24 s)`);
	const roster = list.map((c) => ({ name: c.character, type: c.class, level: c.level, online: !!(c.profile && c.profile.online), server: (c.profile && c.profile.server) || "" }));

	// CODE: every slot by name; a character's own slot (its id) is named after it
	let slots = null;
	const texts = {};
	if (code) {
		const ids = new Map(list.map((c) => [c.character_id, c.character])),
			codes = (await call("list_codes")).codes || [],
			taken = new Set();
		log(`${codes.length} CODE slots`);
		slots = [];
		for (const c of codes) {
			let file = fileName(c.name);
			if (!file) warnings.push(`CODE slot ${c.slot}: its name ${JSON.stringify(c.name)} can't be a file name (not written)`);
			else if (taken.has(file)) warnings.push(`CODE slots: two named ${c.name}; slot ${c.slot} not written (a setup takes the first)`), (file = null);
			if (file) taken.add(file), (texts[file] = (await call("get_code", { slot: String(c.slot) })).code.code);
			slots.push({ slot: String(c.slot), name: c.name, version: c.version ?? null, file, character: ids.get(String(c.slot)) || null });
		}
	}

	let game_check = null,
		diff = null;
	if (game) {
		log("game data");
		({ check: game_check, diff } = await gameCheck(call, game));
		const differ = Object.entries(game_check.sections).filter(([, s]) => s.differ.length);
		if (differ.length) warnings.push(`live's game data differs from the sim's game (${game}): ${differ.map(([k, s]) => `${k} ${s.differ.length} (${s.differ.slice(0, 4).join(", ")}${s.differ.length > 4 ? ", ..." : ""})`).join("; ")}: runs may not match live (game-diff.json)`);
		for (const f of game_check.failed) warnings.push(`game check: ${f}`);
	}

	const age = ageOf(profiles, pulledAt);
	const meta = {
		format: FORMAT, pulled_at: pulledAt, api, account,
		characters: profiles.map((p) => ({ name: p.name, class: p.class, level: p.level, online: !!p.online, server: p.server || null, synchronized_at: p.synchronized_at || null, file: p.name + ".json", source: "api" })),
		bank: { from: "api", at: bankSource.at, freshness: bankSource.freshness, stale: !!b.stale, gold: bank.gold, packs: Object.keys(bank).filter((k) => k !== "gold").length, items: Object.values(bank).filter(Array.isArray).reduce((n, p) => n + p.filter(Boolean).length, 0) },
		account_age: age,
		code: slots && { dir: "code", slots: slots.length, characters: slots.filter((s) => s.character && s.file).map((s) => s.character) },
		game: game_check,
		warnings,
		overrides: [],
	};

	const dir = writeFolder(root, account, pulledAt, (tmp) => {
		for (const p of profiles) writeJson(path.join(tmp, p.name + ".json"), exportOf(p, roster, bank, bankSource, pulledAt));
		writeJson(path.join(tmp, "bank.json"), { bank, bank_source: bankSource });
		if (slots) {
			fs.mkdirSync(path.join(tmp, "code"));
			for (const [f, text] of Object.entries(texts)) fs.writeFileSync(path.join(tmp, "code", f), text);
			writeJson(path.join(tmp, "code", "slots.json"), slots);
		}
		if (diff && Object.keys(diff).length) writeJson(path.join(tmp, "game-diff.json"), diff);
		writeJson(path.join(tmp, "pull.json"), meta);
	});
	return { dir, meta };
}

// <root>/<account>/<time>/, written whole into a temporary folder, then renamed: a pull folder is complete or absent
function writeFolder(root, account, pulledAt, write) {
	const parent = path.join(root, account),
		stamp = pulledAt.replace(/\.\d+Z$/, "Z").replace(/:/g, "-");
	fs.mkdirSync(parent, { recursive: true });
	let name = stamp;
	for (let i = 2; fs.existsSync(path.join(parent, name)); i++) name = `${stamp}-${i}`;
	const tmp = path.join(parent, `.${name}.tmp`);
	fs.rmSync(tmp, { recursive: true, force: true });
	fs.mkdirSync(tmp);
	write(tmp);
	const dir = path.join(parent, name);
	fs.renameSync(tmp, dir);
	return dir;
}

// ---- other players: the game site's public pages ----
// /player/<name> (the account of that character: every character of it, the account's name as the title),
// /character/<name> (that one) and /characters (the top 500) show each character as a script `var slots<name>={...}`
// (its gear: name, level, stat_type, p) followed by its Name, Class and Level lines, "Online" when it is, its skin and
// cosmetics (the looks a run gives it). Nothing else: no inventory, gold, bank, position or CODE.
const SITE = () => (process.env.CHRONAL_AL_SITE || "https://adventure.land").replace(/\/+$/, "");
const ITEM_KEYS = ["name", "level", "stat_type", "p"];
const unentity = (s) => s.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

/** A public page's characters: { title, characters: [{ name, class, level, online, slots, skin, cx }] } */
function parsePublic(html) {
	const title = ((/<title>([^<]*)<\/title>/i.exec(html) || [])[1] || "").trim(),
		starts = [...html.matchAll(/var slots\w*\s*=/g)].map((m) => m.index + m[0].length),
		characters = [];
	starts.forEach((at, i) => {
		const block = html.slice(at, i + 1 < starts.length ? starts[i + 1] : html.length),
			end = block.indexOf("</script>");
		let slots;
		try {
			slots = JSON.parse(block.slice(0, end < 0 ? undefined : end).trim().replace(/;$/, ""));
		} catch (e) {
			return;
		}
		const line = (k) => (new RegExp(`>${k}:</span>\\s*([^<]*)<`).exec(block) || [])[1],
			attr = (k) => { const m = new RegExp(`data-${k}="([^"]*)"`).exec(block); return m ? unentity(m[1]) : null; },
			name = (line("Name") || "").trim(),
			cls = (line("Class") || "").trim().toLowerCase(),
			level = Number((line("Level") || "").trim());
		if (!/^[A-Za-z0-9]{1,12}$/.test(name) || !cls || !Number.isInteger(level)) return;
		let cx = null;
		try {
			cx = attr("cx") ? JSON.parse(attr("cx")) : null;
		} catch (e) {}
		characters.push({ name, class: cls, level, online: /color:\s*green'?>\s*Online/.test(block), slots: slots && typeof slots === "object" && !Array.isArray(slots) ? slots : {}, skin: attr("skin") || null, cx });
	});
	return { title, characters };
}

const UA = { "user-agent": "chronal (chronal pull)" };
async function page(url) {
	const res = await fetch(url, { headers: UA });
	if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
	return res.text();
}

/**
 * Take another player's public page into <root>/<account>/<time>/ (its account: the page's title): a character file
 * per character as an export has it (its gear, level and looks; no items, gold 0), pull.json with source "public".
 * Items and classes the sim's game (game: an al_root) lacks are left out, with a warning.
 * @returns {Promise<{ dir, meta }>}
 */
async function publicPull({ root, name, site = SITE(), game = null, now = new Date() }) {
	if (!/^[A-Za-z0-9]{1,12}$/.test(String(name))) throw new Error(`${JSON.stringify(name)}: a character's name (1-12 letters and digits)`);
	const url = `${site}/player/${encodeURIComponent(name)}`,
		found = parsePublic(await page(url));
	if (!found.characters.length) throw new Error(`no character ${name} on ${site} (its page ${url} shows none)`);
	const account = /^[\w.-]{1,40}$/.test(found.title) && found.title !== "Adventure Land" ? found.title : found.characters.map((c) => c.name).sort()[0],
		pulledAt = now.toISOString(),
		warnings = [];
	let items = null,
		classes = null,
		sprites = null;
	if (game) {
		const g = localGame(game);
		(items = JSON.parse(g.get("items") || "{}")), (classes = JSON.parse(g.get("classes") || "{}"));
		sprites = new Set(Object.values(JSON.parse(g.get("sprites") || "{}")).flatMap((sh) => (sh && Array.isArray(sh.matrix) ? sh.matrix.flat() : [])));
	}
	const chars = found.characters.filter((c) => {
		if (!classes || Object.hasOwn(classes, c.class)) return true;
		warnings.push(`${c.name}: a ${c.class}, a class the sim's game (${game}) lacks: left out`);
	});
	// its looks: a skin or cosmetic the sim's game doesn't draw is left out (no skin: the class's default look)
	for (const c of chars) {
		if (!sprites) continue;
		if (c.skin && !sprites.has(c.skin)) warnings.push(`${c.name}: its skin ${c.skin}, one the sim's game lacks: the class's default look`), (c.skin = null), (c.cx = null);
		for (const [k, v] of Object.entries(c.cx || {})) if (typeof v !== "string" || (v && !sprites.has(v))) warnings.push(`${c.name}: its ${k} ${v}, a cosmetic the sim's game lacks: left out`), delete c.cx[k];
	}
	for (const c of chars)
		c.slots = Object.fromEntries(Object.entries(c.slots).flatMap(([slot, it]) => {
			if (!it || typeof it.name !== "string") return [];
			if (items && !Object.hasOwn(items, it.name)) return warnings.push(`${c.name}: ${slot} ${it.name}, an item the sim's game lacks (newer on live): left out`), [];
			return [[slot, Object.fromEntries(ITEM_KEYS.filter((k) => it[k] != null).map((k) => [k, it[k]]))]];
		}));
	const roster = chars.map((c) => ({ name: c.name, type: c.class, level: c.level, online: c.online, server: "" }));
	const meta = {
		format: FORMAT, source: "public", url, pulled_at: pulledAt, account,
		characters: chars.map((c) => ({ name: c.name, class: c.class, level: c.level, online: c.online, server: null, synchronized_at: null, file: c.name + ".json", source: "public" })),
		bank: null,
		account_age: { days: null, created: null, from: "a public page doesn't show it" },
		code: null, game: null, warnings, overrides: [],
	};
	const dir = writeFolder(root, account, pulledAt, (tmp) => {
		for (const c of chars)
			writeJson(path.join(tmp, c.name + ".json"), {
				format: EXPORT, exported_at: pulledAt, realm: null, source: { from: "public", url, pulled_at: pulledAt },
				character: { name: c.name, class: c.class, level: c.level, xp: 0, gold: 0, items: [], slots: c.slots, s: {}, q: {}, skin: c.skin, cx: c.cx },
				bank: null, bank_source: null, account: { characters: roster },
			});
		writeJson(path.join(tmp, "pull.json"), meta);
	});
	return { dir, meta };
}

/** The site's top 500 characters (/characters): [{ name, class, level, online }], highest first */
async function topCharacters({ site = SITE() } = {}) {
	return parsePublic(await page(`${site}/characters`)).characters.map(({ name, class: cls, level, online }) => ({ name, class: cls, level, online }));
}

/** The pulls under root: [{ account, dir, meta }], oldest first per account */
function listPulls(root, account = null) {
	const out = [];
	let accounts = [];
	try {
		accounts = fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith(".")).map((e) => e.name);
	} catch (e) {}
	for (const a of accounts.sort()) {
		if (account && a !== account) continue;
		for (const d of fs.readdirSync(path.join(root, a)).filter((d) => !d.startsWith(".")).sort()) {
			const file = path.join(root, a, d, "pull.json");
			if (fs.existsSync(file)) out.push({ account: a, dir: path.join(root, a, d), meta: readJson(file) });
		}
	}
	return out;
}

/** The latest pull (of an account, else of any), or null */
function latestPull(root, account = null) {
	const all = listPulls(root, account).sort((x, y) => (x.meta.pulled_at < y.meta.pulled_at ? -1 : 1));
	return all.length ? all[all.length - 1] : null;
}

/**
 * Put snippet exports (chronal-export/1) over a pull's characters: <Name>.json becomes the export (the API's copy
 * stays as <Name>.api.json). An export taken inside the bank (bank_source.from "character") also becomes the pull's
 * bank, in every character's file. Returns the updated meta and its warnings.
 */
function addExports(dir, files, { now = new Date() } = {}) {
	const meta = readJson(path.join(dir, "pull.json")),
		warnings = [];
	let chosen = readJson(path.join(dir, "bank.json"));
	for (const f of files) {
		const e = exportFromText(fs.readFileSync(f, "utf8"), f);
		if (!e.character.name) throw new Error(`${f}: not an export (format ${EXPORT}, from snippets/export-state.js)`);
		const name = e.character.name,
			c = meta.characters.find((x) => x.name === name);
		if (!c) throw new Error(`${f}: ${name} is not a character of this pull (${meta.characters.map((x) => x.name).join(", ")})`);
		const target = path.join(dir, c.file),
			api = path.join(dir, name + ".api.json");
		if (!fs.existsSync(api)) fs.renameSync(target, api);
		const was = readJson(api),
			synced = (was.source && was.source.synchronized_at) || was.exported_at;
		if (Date.parse(e.exported_at) < Date.parse(synced)) warnings.push(`${name}: the snippet export (${e.exported_at}) is older than the pulled state (${synced})`);
		writeJson(target, { ...e, source: { from: "snippet", file: path.resolve(f), added_at: now.toISOString() } });
		Object.assign(c, { level: e.character.level, source: "snippet", exported_at: e.exported_at });
		meta.overrides = meta.overrides.filter((o) => o.name !== name).concat({ name, file: path.resolve(f), exported_at: e.exported_at, added_at: now.toISOString() });
		if (e.bank && e.bank_source && e.bank_source.from === "character") chosen = { bank: e.bank, bank_source: { ...e.bank_source, via: name } };
	}
	// every character file carries the pull's bank
	for (const c of meta.characters) {
		const file = path.join(dir, c.file),
			e = readJson(file);
		writeJson(file, { ...e, bank: chosen.bank, bank_source: chosen.bank_source });
	}
	writeJson(path.join(dir, "bank.json"), chosen);
	const bank = chosen.bank;
	meta.bank = { from: chosen.bank_source.from === "api" ? "api" : "snippet", ...(chosen.bank_source.via ? { character: chosen.bank_source.via } : {}), at: chosen.bank_source.at, freshness: chosen.bank_source.freshness || (chosen.bank_source.from === "character" ? "exact" : null), stale: false, gold: bank.gold, packs: Object.keys(bank).filter((k) => /^items\d+$/.test(k)).length, items: Object.entries(bank).filter(([k]) => /^items\d+$/.test(k)).reduce((n, [, p]) => n + p.filter(Boolean).length, 0) };
	if (meta.bank.from === "snippet") meta.warnings = meta.warnings.filter((w) => !w.startsWith("the bank is open in game"));
	writeJson(path.join(dir, "pull.json"), meta);
	return { meta, warnings };
}

// ---- command line ----
const M = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
function summary(dir, meta) {
	const lines = [`${path.relative(process.cwd(), dir) || dir}  (${meta.account}, ${meta.pulled_at}${meta.source === "public" ? ", its public page" : ""})`];
	for (const c of meta.characters) lines.push(`  ${c.name.padEnd(14)} ${c.class.padEnd(8)} L${String(c.level).padEnd(3)} ${c.online ? "online " : "offline"} ${c.source === "snippet" ? "snippet export" : c.source === "public" ? "gear and level" : "saved " + (c.synchronized_at || "?")}`);
	if (meta.source === "public") return lines.concat("  no inventory, gold, bank, account age or CODE: a public page shows none", meta.warnings.map((w) => `  warning: ${w}`)).join("\n");
	lines.push(`  bank: ${meta.bank.packs} packs, ${meta.bank.items} items, ${M(meta.bank.gold)} gold (${meta.bank.from === "api" ? "the saved copy" : "a snippet export inside the bank, " + meta.bank.character})`);
	if (meta.code) lines.push(`  CODE: ${meta.code.slots} slots; characters with their own slot: ${meta.code.characters.join(", ") || "none"}`);
	lines.push(`  account age: ${meta.account_age.days == null ? meta.account_age.from : meta.account_age.days + " days (" + meta.account_age.from + ")"}`);
	if (meta.game) {
		const n = (k) => Object.values(meta.game.sections).reduce((t, s) => t + s[k].length, 0);
		lines.push(`  game data: ${n("differ")} entries differ from the sim's game, ${n("text")} in wording only (${Object.keys(meta.game.sections).length} sections checked${meta.game.no_local.length ? "; not: " + meta.game.no_local.join(", ") : ""})`);
	}
	for (const w of meta.warnings) lines.push(`  warning: ${w}`);
	return lines.join("\n");
}

function cli(argv) {
	const
		has = (f) => argv.includes(f),
		opt = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
	const known = ["--add", "--list", "--account", "--into", "--no-code", "--no-game-check", "--player", "--top", "--help", "-h"];
	const bad = argv.filter((a) => a.startsWith("-") && !known.includes(a));
	if (has("--help") || has("-h") || bad.length) {
		console.log("usage: chronal pull [--account NAME] [--no-code] [--no-game-check]\n       chronal pull --add FILE... [--into PULLDIR] [--account NAME]\n       chronal pull --list [--account NAME]\n       chronal pull --player NAME\n       chronal pull --top [TEXT]");
		process.exit(bad.length ? 2 : 0);
	}
	const c = config(),
		root = c.pulls_dir;
	(async () => {
		if (has("--list")) {
			const all = listPulls(root, opt("--account")),
				players = listPulls(c.players_dir, opt("--account"));
			if (!all.length && !players.length) return console.log(`no pulls in ${root}, no players' pages in ${c.players_dir}`);
			for (const p of all) console.log(`${p.account}/${path.basename(p.dir)}  ${p.meta.characters.map((x) => `${x.name} L${x.level}${x.source === "snippet" ? "*" : ""}`).join(", ")}${p.meta.game ? `  (game: ${Object.values(p.meta.game.sections).reduce((n, s) => n + s.differ.length, 0)} differ)` : ""}`);
			if (players.length) console.log(`players' public pages (${c.players_dir}):`);
			for (const p of players) console.log(`  ${p.account}/${path.basename(p.dir)}  ${p.meta.characters.map((x) => `${x.name} ${x.class} L${x.level}`).join(", ")}`);
			return;
		}
		if (has("--player")) {
			const name = opt("--player");
			if (!name || name.startsWith("--")) throw new Error("--player NAME: a character of the player");
			const { dir, meta } = await publicPull({ root: c.players_dir, name, game: c.al_root });
			return console.log(summary(dir, meta));
		}
		if (has("--top")) {
			const q = (opt("--top") || "").toLowerCase(),
				top = (await topCharacters()).filter((x) => !q || q.startsWith("--") || x.name.toLowerCase().includes(q) || x.class === q);
			for (const x of top) console.log(`${x.name.padEnd(14)} ${x.class.padEnd(8)} L${x.level}${x.online ? "  online" : ""}`);
			return;
		}
		if (has("--add")) {
			const files = argv.slice(argv.indexOf("--add") + 1).filter((a, i, all) => !a.startsWith("--") && !["--into", "--account"].includes(all[i - 1]));
			if (!files.length) throw new Error("--add: no export files");
			const into = opt("--into") ? path.resolve(opt("--into")) : (latestPull(root, opt("--account")) || {}).dir;
			if (!into) throw new Error(`--add: no pull in ${root} (pull first, or --into DIR)`);
			const { meta, warnings } = addExports(into, files);
			for (const w of warnings) console.log(`warning: ${w}`);
			return console.log(summary(into, meta));
		}
		const { dir, meta } = await pull({
			root, api: process.env.CHRONAL_AL_API || "https://adventure.land/mcp_api", token: token(), account: opt("--account") || null,
			code: !has("--no-code"), game: has("--no-game-check") ? null : c.al_root, log: (s) => console.log(`... ${s}`),
		});
		console.log(summary(dir, meta));
	})().catch((e) => {
		console.error("pull failed:", e.message);
		process.exit(1);
	});
}

module.exports = { cli, pull, accountOf, exportFromText, addExports, listPulls, latestPull, localGame, textOnly, bankOf, exportOf, ageOf, token, parsePublic, publicPull, topCharacters, FORMAT };
