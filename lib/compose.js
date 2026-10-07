"use strict";
// Compose a run setup (chronal-setup/1) the way the live game is set up: who is logged in, from what state, running what
// CODE; write it, then check or run it. docs/reference/cli.md (chronal new).
//   chronal new --chars JohnMerch,JohnRanger,JohnPaladin                       continue from now: the latest pull's states,
//                                                                              positions and CODE, the party by CODE
//   chronal new --template setups/party.json                             the template, its exported states refreshed
//   chronal new --char Mage1:mage:60 --gear Mage1:mainhand=firestaff+7   a character from scratch
//   chronal new --char Mage1:mage:60 --gear-set Mage1=mage-mid           ... in a gear set (lib/gear_sets.js)
//   chronal new --player KestrelRan --chars JohnMerch,KestrelRan,KestrelPri    another player's characters (their
//                                                                              public page: chronal pull --player) beside yours
//   ... --sweep-gear JohnRanger:mainhand=bow+8,firebow+7 --seeds 1,2,3 --run  one setup per item, each run per seed
//   ... --sweep-gear-set JohnRanger=ranger-mid,ranger-late                     one setup per gear set
// Others' CODE (the CODE library's, library.js) at a commit not trusted here is asked about before --check or --run (on
// a terminal; --trust: trusted without asking).
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const { spawn } = require("node:child_process");
const { config } = require("./config");
const S = require("./setup");
const C = require("./code_sets");
const P = require("./pull");
const GIT = require("./git_tree");
const N = require("./names");
const X = require("./steer");
const LIB = require("./library");
const F = require("./fit");
const GS = require("./gear_sets");

const SLOTS = ["ring1", "ring2", "earring1", "earring2", "belt", "mainhand", "offhand", "helmet", "chest", "pants", "shoes", "gloves", "amulet", "orb", "elixir", "cape"];
const FORMS = ["harness", "code", "none"];
const ISIZE = 42; // a character's inventory, as the game's server sets it (player.isize)
const isObj = (v) => v != null && typeof v === "object" && !Array.isArray(v);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

let gameCache = null;
/** The game's items, classes and maps (config al_root's design files, as main.js evaluates them) */
function game(root = config().al_root) {
	if (!gameCache || gameCache.root !== root) {
		const g = P.localGame(root),
			get = (k) => JSON.parse(g.get(k) || "{}");
		gameCache = { root, items: get("items"), classes: get("classes"), maps: get("maps"), titles: get("titles"), monsters: get("monsters"), conditions: get("conditions"), skills: get("skills") };
	}
	return gameCache;
}

// ---- gear ----

/** "item[+level][:stat][#title]" | "none" -> an item ({ name, level?, stat_type?, p? }) or null; throws on a malformed one */
function parseGear(spec, G) {
	if (spec === "none") return null;
	const m = /^([a-z][a-z0-9_]*)(?:\+(\d+))?(?::([a-z_]+))?(?:#([a-z0-9_]+))?$/.exec(spec);
	if (!m) throw new Error(`${spec}: ITEM[+LEVEL][:STAT][#TITLE] or none (e.g. firebow+7, coat+8:dex, ringsj+3#shiny)`);
	const def = G.items[m[1]];
	const item = { name: m[1] };
	if (m[2] != null || (def && (def.upgrade || def.compound))) item.level = Number(m[2] || 0);
	if (m[3]) item.stat_type = m[3];
	if (m[4]) item.p = m[4];
	return item;
}
/** An item as a gear spec (parseGear's inverse) */
const gearSpec = (item) => (item ? item.name + (item.level ? "+" + item.level : "") + (item.stat_type ? ":" + item.stat_type : "") + (item.p ? "#" + item.p : "") : "none");

/**
 * Can this class wear the item in that slot, as the game's can_equip_item decides (node/server.js), with the other
 * slots as they are; its level within its grades, a stat scroll where it takes one. -> { problems, warnings }
 */
function checkGear(G, cls, slot, item, slots) {
	const problems = [],
		warnings = [],
		say = (s) => problems.push(`${slot}=${item ? item.name : "none"}: ${s}`);
	if (!SLOTS.includes(slot)) return { problems: [`${slot}: not a gear slot (${SLOTS.join(", ")})`], warnings };
	if (item == null) return { problems, warnings };
	const def = G.items[item.name],
		cd = G.classes[cls] || {};
	if (!def) return { problems: [`${slot}=${item.name}: no such item`], warnings };
	const t = def.type,
		table = (k) => cd[k] || {},
		main = slots.mainhand && G.items[slots.mainhand.name],
		twoHanded = main && table("doublehand")[main.wtype];
	let fits;
	if (slot === "mainhand") fits = (t === "weapon" || t === "tool") && (table("mainhand")[def.wtype] || (table("doublehand")[def.wtype] && !slots.offhand));
	else if (slot === "offhand")
		fits = t === "weapon" ? table("offhand")[def.wtype] && (!main || table("mainhand")[main.wtype]) : ["shield", "misc_offhand", "quiver", "source"].includes(t) && table("offhand")[t] && !twoHanded;
	else if (slot === "ring1" || slot === "ring2") fits = t === "ring";
	else if (slot === "earring1" || slot === "earring2") fits = t === "earring";
	else fits = t === slot;
	if (!fits) say(t === "weapon" || t === "tool" ? `a ${cls} can't use a ${def.wtype} as its ${slot}${slot === "offhand" && main ? " (with a " + main.wtype + " in its mainhand)" : ""}` : `a ${t} doesn't go in ${slot}${slot === "offhand" && twoHanded ? " (a two-handed " + main.wtype + " in its mainhand)" : ""}`);
	if (slot === "mainhand" && twoHanded && slots.offhand) say(`a two-handed ${main.wtype} leaves no offhand (offhand=${slots.offhand.name})`);
	const max = def.upgrade || def.compound ? (def.grades || [9, 10, 11, 12])[3] : 0;
	if ((item.level || 0) > max || (item.level || 0) < 0) say(max ? `level ${item.level}: it goes to +${max}` : `level ${item.level}: it can't be upgraded`);
	if (item.stat_type != null) {
		if (!def.stat) say("it takes no stat scroll");
		else if (!G.items[item.stat_type + "scroll"]) say(`${item.stat_type}: no such stat scroll`);
	}
	if (item.p != null && !(G.titles || {})[item.p]) say(`#${item.p}: no such title`);
	if (Array.isArray(def.class) && !def.class.includes(cls)) warnings.push(`${slot}=${item.name}: for ${def.class.join(", ")}: a ${cls} wears it with none of its stats`);
	return { problems, warnings };
}

// ---- paths: a setup's file paths absolute (a template's) or relative to where it is written ----

function mapPaths(setup, fn) {
	const code = (c) => {
		if (!isObj(c)) return;
		for (const k of ["dir", "file"]) if (typeof c[k] === "string") c[k] = fn(c[k]);
		if (isObj(c.git) && typeof c.git.repo === "string") c.git.repo = fn(c.git.repo);
		if (c.append != null) c.append = [].concat(c.append).map((p) => fn(String(p)));
		if (isObj(c.build) && c.build.cwd != null) c.build.cwd = fn(String(c.build.cwd));
	};
	const state = (s) => isObj(s) && typeof s.from === "string" && (s.from = fn(s.from));
	if (isObj(setup.defaults)) code(setup.defaults.code), state(setup.defaults.state);
	for (const c of setup.characters || []) if (isObj(c)) code(c.code), state(c.state);
	for (const a of Object.values(setup.accounts || {})) if (isObj(a) && isObj(a.bank) && typeof a.bank.from === "string") a.bank.from = fn(a.bank.from);
	return setup;
}

// ---- options ----

// "A=x,B=y" or repeated flags -> { A: "x", B: "y" }
function pairs(list, what) {
	const out = {};
	for (const part of list.flatMap((v) => String(v).split(",")).map((x) => x.trim()).filter(Boolean)) {
		const m = /^([A-Za-z0-9]{1,12})=(.+)$/.exec(part);
		if (!m) throw new Error(`${what} ${part}: NAME=VALUE`);
		out[m[1]] = m[2];
	}
	return out;
}
// "KEY=x" (an account's name) -> { KEY: "x" }
function keyPairs(list, what) {
	const out = {};
	for (const part of list.flatMap((v) => String(v).split(",")).map((x) => x.trim()).filter(Boolean)) {
		const m = /^([\w.-]{1,40})=(.+)$/.exec(part);
		if (!m) throw new Error(`${what} ${part}: ACCOUNT=VALUE`);
		out[m[1]] = m[2];
	}
	return out;
}
// "KEY=VALUE" (one per flag, the first = splits) -> { KEY: VALUE }; value: its JSON, else the text (json false: the text)
function valuePairs(list, what, json = true) {
	const out = {};
	for (const part of list) {
		const i = String(part).indexOf("=");
		if (i < 1) throw new Error(`${what} ${part}: KEY=VALUE`);
		out[part.slice(0, i)] = json ? jsonOr(part.slice(i + 1)) : part.slice(i + 1);
	}
	return out;
}
const jsonOr = (t) => {
	try {
		return JSON.parse(t);
	} catch (e) {
		return t;
	}
};
// "NAME=CODE" (one per flag) -> { NAME: CODE }
function codePairs(list, what) {
	const out = {};
	for (const part of list) {
		const m = /^([A-Za-z0-9]{1,12})=([^]*)$/.exec(part);
		if (!m) throw new Error(`${what} ${part}: NAME=CODE`);
		out[m[1]] = m[2];
	}
	return out;
}
// "AT[@NAME] KEY=VALUE" | "AT[@NAME] run CODE" | a step as JSON ({ "when": ..., ... }) -> a steering entry
function steerOf(text) {
	if (/^\s*\{/.test(text))
		try {
			return JSON.parse(text);
		} catch (e) {
			throw new Error(`--steer ${text}: ${e.message}`);
		}
	const m = /^(\S+?)(?:@([A-Za-z0-9]{1,12}))?\s+(?:run\s+([^]+)|([^=\s][^=]*)=([^]*))$/.exec(String(text).trim());
	if (!m) throw new Error(`--steer ${text}: "AT[@NAME] KEY=VALUE", "AT[@NAME] run CODE" or a step as JSON (e.g. "20m mode=\"rest\"", "25m@Pri1 run set_message('hi')", '{"when": "c.Ran1.kills.goo >= 500", "storage": {"mode": "rest"}}')`);
	return { at: /^\d+(\.\d+)?$/.test(m[1]) ? Number(m[1]) : m[1], ...(m[2] ? { character: m[2] } : {}), ...(m[3] != null ? { code: m[3] } : { storage: { [m[4].trim()]: jsonOr(m[5]) } }) };
}
// "NAME:SLOT=SPEC" -> { name, slot, spec }
function gearEdit(text, what) {
	const m = /^([A-Za-z0-9]{1,12}):([a-z0-9]+)=(.+)$/.exec(text);
	if (!m) throw new Error(`${what} ${text}: NAME:SLOT=ITEM[+LEVEL][:STAT] (or =none)`);
	return { name: m[1], slot: m[2], spec: m[3] };
}
// a gear set worn: an edit of each of its slots (one it leaves out: empty; the elixir as it was)
function setEdits(name, set, dir, what) {
	const s = GS.get(dir, set);
	if (!s) throw new Error(`${what} ${name}=${set}: no gear set ${set} (built in: CLASS-early, CLASS-mid, CLASS-late; yours: ${dir})`);
	return GS.SLOTS.map((slot) => ({ name, slot, spec: s.gear[slot] || "none", set: s.name, cls: s.class }));
}

/**
 * The setup(s) the options describe (every path absolute), before missing CODE is chosen.
 * @param {object} o  { template, pull, players: [a player's page taken: ACCOUNT | ACCOUNT/TIME | a folder], chars,
 *   offline, char: ["NAME:CLASS[:LEVEL]"], account, account_of: { NAME: account }, account_age: { account: days },
 *   account_bank: { account: "none" | the account of a pull whose bank it takes }, state: { NAME: pull|template|fresh },
 *   level: { NAME: n }, at: { NAME: "map:x:y" }, gear_set: { NAME: a gear set } (worn under gear), gear: ["NAME:SLOT=SPEC"],
 *   party: "A,B[/form]" | false, code_set, name, duration, warmup, seed, ping, world_age, age_days,
 *   sweep_gear_set: ["NAME=A,B"], sweep_gear: ["NAME:SLOT=A,B"] (on each set), sweep_code_set: "A,B",
 *   start: the world's clock (an ISO time), seasons: ["halloween", ...], anniversary: true | false (else as the game
 *   ships it), events: [{ event, at }] (forced),
 *   spawns: a custom world's monsters (world.spawns), params: { "*" | NAME: { ... } } (merged into the characters'
 *   params: e.g. { farm: { map, x, y, monsters } } for the example bot),
 *   code_names: { A: B } (the CODE's name A is B in the run; "" or A: it stays) | false (none mapped),
 *   storage: { <account> | "*" (every account of the run): { <key>: <what get(key) returns>, null: unset } },
 *   local_storage: { <account> | "*": { <localStorage key>: <text>, null: unset } }, prelude: { NAME: CODE ("": none) },
 *   steer: [{ name, at | when (for, repeat, window) | after, character, storage, local_storage, code, note }] (in place of
 *   the template's), until: run.until (a condition: docs/reference/setup.md; "": none), check_every:
 *   run.check (how often conditions are checked: "1s", "500ms") }
 * @param {object} [env]  { G, pullsDir, playersDir, codeSets, gearSetsDir, now }
 * @returns {{ base: object, variants: [{ label, key, setup, code_set }], info: object, warnings: string[] }}
 */
function compose(o, { G = game(), pullsDir = config().pulls_dir, playersDir = config().players_dir, codeSets = config().code_sets, gearSetsDir = config().gear_sets_dir, now = new Date() } = {}) {
	const warnings = [],
		problems = [],
		info = { template: null, pull: null, players: [], states: {}, code: null, code_names: {} };
	// the template, its paths absolute
	let T = null;
	if (o.template) {
		const file = path.resolve(o.template);
		T = readJson(file);
		if (T.format !== S.FORMAT || "resolved" in T) throw new Error(`--template ${file}: not a setup file (a run's <id>.setup.json: rerun it with chronal run)`);
		mapPaths(T, (p) => path.resolve(path.dirname(file), p));
		info.template = file;
	}
	// the pull
	let pull = null;
	const ref = o.pull || (o.account ? o.account : "latest");
	if (o.pull && fs.existsSync(path.join(path.resolve(o.pull), "pull.json"))) pull = { dir: path.resolve(o.pull), meta: readJson(path.join(path.resolve(o.pull), "pull.json")) };
	else pull = C.findPull(ref, pullsDir);
	if (o.pull && !pull) throw new Error(`--pull ${o.pull}: no such pull in ${pullsDir} (chronal pull; --pull latest | ACCOUNT | ACCOUNT/TIME | a pull folder)`);
	if (pull) info.pull = pull.dir;
	// other players' pages taken (chronal pull --player): their characters on their own accounts
	const players = [];
	for (const ref of [].concat(o.players || [])) {
		const dir = path.resolve(String(ref)),
			p = fs.existsSync(path.join(dir, "pull.json")) ? { dir, meta: readJson(path.join(dir, "pull.json")) } : C.findPull(String(ref), playersDir);
		if (!p) throw new Error(`--player ${ref}: no player's page taken in ${playersDir} (chronal pull --player NAME; --player ACCOUNT | ACCOUNT/TIME | a folder)`);
		if (!players.some((q) => q.dir === p.dir)) players.push(p), info.players.push(p.dir);
	}
	// a character of the pull, else of a player's page: { src, c } (its pull and its entry there)
	const sources = [...(pull ? [pull] : []), ...players],
		find = (n) => { for (const src of sources) { const c = src.meta.characters.find((x) => x.name === n); if (c) return { src, c }; } return null; },
		pulled = (n) => (find(n) || {}).c || null,
		fileOf = (n) => path.join(find(n).src.dir, pulled(n).file),
		exportOf = (n) => readJson(fileOf(n)),
		isPlayer = (n) => !!find(n) && find(n).src !== pull,
		acct = o.account || (T && T.defaults && T.defaults.account) || (pull && pull.meta.account) || "main";

	// the roster: --chars (template characters, else the pull's), else the template's; then --char from scratch
	const tchars = T ? T.characters.filter(isObj) : [];
	const chars = o.chars ? o.chars.split(",").map((x) => x.trim()).filter(Boolean) : null;
	if (!chars && !T && !(o.char && o.char.length)) throw new Error(`--chars: who is logged in (${pull ? "the pull has " + pull.meta.characters.map((c) => `${c.name} (${c.class} L${c.level})`).join(", ") : "no pull: chronal pull"}), or --template, or --char`);
	const roster = [];
	for (const n of chars || tchars.map((c) => c.name)) {
		const t = tchars.find((c) => c.name === n);
		if (t) roster.push({ entry: structuredClone(t), from: "template" });
		else if (isPlayer(n)) roster.push({ entry: { name: n, class: pulled(n).class, account: find(n).src.meta.account }, from: "player" }); // (a public page has no place: main's spawn)
		else if (pulled(n)) {
			const e = exportOf(n).character,
				at = G.maps[e.map] && Number.isFinite(e.x) && Number.isFinite(e.y) ? `${e.map}:${Math.round(e.x)}:${Math.round(e.y)}` : null;
			if (!at) warnings.push(`${n}: pulled at ${e.map} ${e.x},${e.y}, not a place in the sim's game: it starts at main's spawn`);
			roster.push({ entry: { name: n, class: pulled(n).class, account: acct, ...(at ? { at } : {}) }, from: "pull" });
		} else throw new Error(`--chars ${n}: not a character of ${[T && "the template", pull && "the pull", players.length && "the players' pages"].filter(Boolean).join(" or ") || "any pull (chronal pull)"}`);
	}
	// from scratch: "NAME:CLASS[:LEVEL]" or { name, class, level, account }
	for (const spec of o.char || []) {
		const m = typeof spec === "string" ? /^([A-Za-z0-9]{1,12}):([a-z]+)(?::(\d+))?$/.exec(spec) : isObj(spec) ? [null, spec.name, spec.class, spec.level] : null;
		if (!m || typeof m[1] !== "string" || !/^[A-Za-z0-9]{1,12}$/.test(m[1])) throw new Error(`--char ${typeof spec === "string" ? spec : JSON.stringify(spec)}: NAME:CLASS[:LEVEL] (e.g. Mage1:mage:60; a name of 1-12 letters and digits)`);
		if (!G.classes[m[2]]) throw new Error(`--char ${m[1]}: no class ${m[2]} (${Object.keys(G.classes).join(", ")})`);
		if (m[3] != null && m[3] !== "" && !(Number.isInteger(Number(m[3])) && Number(m[3]) >= 1)) throw new Error(`--char ${m[1]}: level ${m[3]}: a whole number >= 1`);
		if (roster.some((r) => r.entry.name.toLowerCase() === m[1].toLowerCase())) throw new Error(`--char ${m[1]}: already in the roster`);
		const account = isObj(spec) && spec.account ? String(spec.account) : acct;
		roster.push({ entry: { name: m[1], class: m[2], account, state: m[3] != null && m[3] !== "" ? { level: Number(m[3]) } : {} }, from: "scratch" });
	}
	const names = roster.map((r) => r.entry.name);
	const per = { state: o.state || {}, level: o.level || {}, at: o.at || {}, gold: o.gold || {}, items: o.items || {}, code_sets: o.code_sets || {}, entries: o.entries || {}, account_of: o.account_of || {} };
	for (const [k, v] of Object.entries(per)) for (const n of Object.keys(v)) if (!names.includes(n)) problems.push(`--${k} ${n}: not in the roster (${names.join(", ")})`);
	for (const n of o.offline || []) if (!names.includes(n)) problems.push(`--offline ${n}: not in the roster`);
	// names in CODE (namesOf, once the CODE is chosen): the template's moves to a character of the roster, the ones given
	// ({ A: B }; B "" or A: A keeps it); false: none mapped
	if (o.code_names === false) info.code_names = false;
	else {
		for (const [a, b] of Object.entries(T && isObj(T.code_names) ? T.code_names : {})) if (a !== b && names.includes(b)) info.code_names[a] = b;
		for (const [a, b] of Object.entries(o.code_names || {})) {
			if (!N.NAME.test(a) || (b !== "" && !N.NAME.test(String(b)))) problems.push(`--code-name ${a}=${b}: NAME=NAME (a name in the CODE = a character of the run, or itself: it stays)`);
			else if (b !== "" && b !== a && !names.includes(b)) problems.push(`--code-name ${a}=${b}: ${b} is not in the roster (${names.join(", ")})`);
			else info.code_names[a] = b || a;
		}
	}

	// states: a template character's export refreshed from the pull (its inline state kept); --state chooses
	for (const r of roster) {
		const c = r.entry,
			n = c.name,
			want = (o.state || {})[n] || (r.from === "pull" || r.from === "player" ? "pull" : r.from === "scratch" ? "fresh" : isObj(c.state) && c.state.from && pulled(n) ? "pull" : "template");
		if (per.account_of[n] != null) {
			if (!/^[\w.-]{1,40}$/.test(String(per.account_of[n]))) problems.push(`--account-of ${n}=${per.account_of[n]}: an account's name (letters, digits, _ . -)`);
			c.account = String(per.account_of[n]);
		}
		if (want === "pull") {
			if (!pulled(n)) {
				problems.push(`--state ${n}=pull: ${sources.length ? "not in the pull" + (players.length ? " or the players' pages" : "") : "no pull"}`);
				continue;
			}
			if (pulled(n).class !== c.class) problems.push(`${n}: a ${c.class} here, a ${pulled(n).class} in the ${isPlayer(n) ? "player's page" : "pull"}`);
			c.state = { from: fileOf(n) };
			info.states[n] = isPlayer(n) ? `public page (L${pulled(n).level})` : `pull (L${pulled(n).level}${pulled(n).source === "snippet" ? ", snippet export" : ""})`;
			// a public page shows no inventory or gold: those of the pull's character of its class, else a new one's
			if (isPlayer(n) && per.items[n] == null) {
				const like = pull && pull.meta.characters.find((x) => x.class === c.class);
				if (like) {
					const e = readJson(path.join(pull.dir, like.file)).character;
					c.state.items = structuredClone(e.items || []);
					if (per.gold[n] == null) c.state.gold = e.gold || 0;
					info.states[n] += `, the inventory and gold of ${like.name}`;
				} else (c.state.items = S.startState(G, c.class, {}, null).items), (info.states[n] += ", a new character's inventory");
			}
		} else if (want === "fresh") {
			c.state = r.from === "scratch" ? c.state : {};
			info.states[n] = `fresh (L${(c.state && c.state.level) || 1})`;
		} else if (want === "template") {
			if (r.from !== "template") problems.push(`--state ${n}=template: not a template character`);
			info.states[n] = isObj(c.state) && c.state.from ? `template (${path.basename(c.state.from)})` : `template (${isObj(c.state) && c.state.level ? "L" + c.state.level : "L1"})`;
		} else problems.push(`--state ${n}=${want}: pull, template or fresh`);
		if ((o.level || {})[n] != null) {
			const l = Number(o.level[n]);
			if (!(Number.isInteger(l) && l >= 1)) problems.push(`--level ${n}=${o.level[n]}: a whole number >= 1`);
			c.state = { ...(c.state || {}), level: l };
			info.states[n] += ` -> L${l}`;
		}
		if (per.gold[n] != null) {
			const g = Number(per.gold[n]);
			if (!(Number.isFinite(g) && g >= 0)) problems.push(`--gold ${n}=${per.gold[n]}: a number >= 0`);
			c.state = { ...(c.state || {}), gold: g };
		}
		if (per.items[n] != null) {
			const bad = !Array.isArray(per.items[n]) ? ["a list"] : per.items[n].filter((i) => i != null && !(isObj(i) && typeof i.name === "string" && G.items[i.name] && (i.q == null || (Number.isInteger(i.q) && i.q >= 1)))).map((i) => JSON.stringify(i));
			if (bad.length) problems.push(`--items ${n}: ${bad.join(", ")} (items of the game: { name, q?, level?, stat_type?, p? })`);
			const held = Array.isArray(per.items[n]) ? per.items[n].filter(Boolean).length : 0;
			if (held > ISIZE) problems.push(`--items ${n}: ${held} items, the inventory holds ${ISIZE}`);
			// a stack past its item's stack size (the game's s; none: 1) is that size
			const items = !bad.length && Array.isArray(per.items[n]) ? structuredClone(per.items[n]).map((i) => {
				const max = (i && G.items[i.name].s) || 1;
				if (i && i.q > max) warnings.push(`--items ${n}: ${i.name} x${i.q}: a stack holds ${max}, so x${max}`), (i.q = max);
				return i;
			}) : structuredClone(per.items[n]);
			c.state = { ...(c.state || {}), items };
		}
		if ((o.at || {})[n]) c.at = o.at[n];
		if ((o.offline || []).includes(n)) c.online = false;
	}

	// accounts: every account holding a pulled state takes its pull's bank (a player's page has none) and age (a page
	// doesn't show it: 40 days, past the New Player bonus)
	const accounts = structuredClone(T && isObj(T.accounts) ? T.accounts : {});
	const accountOf = (c) => c.account || (T && T.defaults && T.defaults.account) || "main";
	for (const r of roster) {
		const c = r.entry,
			src = isObj(c.state) && c.state.from && sources.find((p) => c.state.from.startsWith(p.dir + path.sep));
		if (!src) continue;
		const k = accountOf(c),
			a = (accounts[k] ||= {});
		if (!a._aged && src.meta.source !== "public" && (!a.bank || a.bank.from)) a.bank = { from: c.state.from };
		if (src.meta.source === "public" && a.ip == null) a.ip = k; // (another player's account: its own IP)
		if (!a._aged) a.age_days = src.meta.account_age && src.meta.account_age.days != null ? src.meta.account_age.days : 40;
		a._aged = true;
	}
	for (const a of Object.values(accounts)) delete a._aged;
	if (o.age_days != null) for (const r of roster) (accounts[accountOf(r.entry)] ||= {}).age_days = Number(o.age_days);
	// per account: its age; its bank: none, or a pull's (by that pull's account)
	const inRun = new Set(roster.map((r) => accountOf(r.entry)));
	for (const [k, d] of Object.entries(o.account_age || {})) {
		if (!inRun.has(k)) problems.push(`--account-age ${k}: no character of the run is on it (${[...inRun].join(", ")})`);
		else if (!(Number.isFinite(Number(d)) && Number(d) >= 0)) problems.push(`--account-age ${k}=${d}: days >= 0`);
		else (accounts[k] ||= {}).age_days = Number(d);
	}
	// per account: its browser storage at the start (the template's, the keys given over it)
	for (const [what, given] of [["storage", o.storage], ["local_storage", o.local_storage]])
		for (const [k, m] of Object.entries(given || {})) {
			if (k !== "*" && !inRun.has(k)) problems.push(`--${what.replace("_", "-")} ${k}: no character of the run is on it (${[...inRun].join(", ")})`);
			else if (!isObj(m)) problems.push(`${what} ${k}: { <key>: <value> }`);
			else
				for (const a of k === "*" ? [...inRun] : [k]) {
					const st = { ...(accounts[a] || {})[what] };
					for (const [key, v] of Object.entries(m)) v === null ? delete st[key] : (st[key] = v);
					accounts[a] = { ...accounts[a], [what]: st };
					if (!Object.keys(st).length) delete accounts[a][what];
				}
		}
	for (const [k, b] of Object.entries(o.account_bank || {})) {
		const from = sources.find((p) => p.meta.source !== "public" && p.meta.account === b);
		if (!inRun.has(k)) problems.push(`--account-bank ${k}: no character of the run is on it (${[...inRun].join(", ")})`);
		else if (b === "none") delete (accounts[k] ||= {}).bank;
		else if (!from) problems.push(`--account-bank ${k}=${b}: none, or the account of a pull with a bank (${sources.filter((p) => p.meta.source !== "public").map((p) => p.meta.account).join(", ") || "none here"})`);
		else (accounts[k] ||= {}).bank = { from: path.join(from.dir, from.meta.characters[0].file) };
	}

	// CODE: --code-set, else the template's, else the pull's (the sets file's set on that pull when there is one: its
	// appends), else the example bot (the built-in set example)
	let set = null;
	if (o.code_set) set = C.codeSet(o.code_set, { file: codeSets, pullsDir });
	else if (!T && !o.sweep_code_set && !pull) set = C.codeSet("example", { file: codeSets, pullsDir });
	else if (!T && !o.sweep_code_set) {
		const own = C.loadCodeSets({ file: codeSets, pullsDir }).sets.filter((s) => s.pull && s.pull.dir === pull.dir);
		set = own.find((s) => !s.name.startsWith("pull:")) || own.find((s) => s.name === `pull:${path.basename(path.dirname(pull.dir))}/${path.basename(pull.dir)}`) || own[0];
	}

	// the party: --party, --no-party, the template's (the roster's members), else the fighters by CODE
	const inGame = roster.filter((r) => r.entry.online !== false).map((r) => r.entry);
	let party;
	if (o.party === false) party = null;
	else if (o.party) {
		const [list, form] = String(o.party).split("/");
		const members = list.split(",").map((x) => x.trim()).filter(Boolean);
		for (const n of members) if (!names.includes(n)) problems.push(`--party ${n}: not in the roster`);
		if (form && !FORMS.includes(form)) problems.push(`--party /${form}: ${FORMS.join(", ")}`);
		party = { members, leader: members[0], form: form || (T && T.party && T.party.form) || (set && set.party_form) || "code" };
	} else if (T && T.party) {
		const members = T.party.members.filter((n) => names.includes(n));
		party = members.length ? { ...T.party, members, leader: members.includes(T.party.leader) ? T.party.leader : members[0] } : null;
	} else {
		const fighters = inGame.filter((c) => c.class !== "merchant").map((c) => c.name);
		party = fighters.length > 1 ? { members: fighters, leader: fighters[0], form: (set && set.party_form) || "code" } : null;
	}

	// the setup
	const base = {
		format: S.FORMAT,
		name: o.name || `${T ? T.name || path.basename(info.template, ".json") : "now"}-${stamp(pull ? pull.meta.pulled_at : now.toISOString())}`,
		strategy: null,
		run: { ...(T && T.run), ...(o.duration != null ? { duration: o.duration } : {}), ...(o.warmup != null ? { warmup: o.warmup } : {}), ...(o.seed != null ? { seed: Number(o.seed) } : {}), ...(o.until != null ? { until: o.until || null } : {}), ...(o.check_every != null ? { check: o.check_every } : {}) },
		world: { ...(T && T.world), ...(o.ping != null ? { ping: Number(o.ping) } : {}), ...(o.world_age != null ? { age: o.world_age } : {}), ...(o.start != null ? { start: o.start } : {}), ...(o.seasons != null ? { seasons: o.seasons } : {}), ...(o.anniversary != null ? { anniversary: o.anniversary } : {}), ...(o.events != null ? { events: o.events } : {}), ...(o.spawns != null ? { spawns: o.spawns } : {}) },
		defaults: { ...(T && T.defaults) },
		accounts,
		characters: roster.map((r) => r.entry),
		party,
	};
	// steering: the one given, else the template's (its entries for characters of the roster, or for all)
	const steer = o.steer != null ? o.steer : T && Array.isArray(T.steer) ? T.steer.filter((e) => !isObj(e) || e.character == null || names.includes(e.character)) : [];
	if (steer.length) base.steer = structuredClone(steer);
	for (const n of Object.keys(o.prelude || {})) if (!names.includes(n)) problems.push(`--prelude ${n}: not in the roster (${names.join(", ")})`);
	if (o.params) for (const c of base.characters) if (o.params["*"] || o.params[c.name]) c.params = { ...(c.params || {}), ...(o.params["*"] || {}), ...(o.params[c.name] || {}) };
	if (!T) base.defaults.account = acct;
	if (!Object.keys(base.defaults).length) delete base.defaults;
	if (!party) delete base.party;

	// variants: the gear-set sweep x the gear sweep x the CODE-set sweep (one of each value); none: the base alone
	const edits = [...Object.entries(o.gear_set || {}).flatMap(([n, set]) => setEdits(n, set, gearSetsDir, "--gear-set")), ...(o.gear || []).map((g) => gearEdit(g, "--gear"))];
	const dims = [];
	for (const g of o.sweep_gear_set || []) {
		const m = /^([A-Za-z0-9]{1,12})=(.+)$/.exec(g);
		if (!m) throw new Error(`--sweep-gear-set ${g}: NAME=A,B,... (gear sets)`);
		dims.push(m[2].split(",").map((set) => ({ label: `${m[1]} set=${set}`, key: `${m[1]}-set-${set}`, gear: setEdits(m[1], set, gearSetsDir, "--sweep-gear-set") })));
	}
	for (const g of o.sweep_gear || []) {
		const m = /^([A-Za-z0-9]{1,12}):([a-z0-9]+)=(.+)$/.exec(g);
		if (!m) throw new Error(`--sweep-gear ${g}: NAME:SLOT=A,B,... (each ITEM[+LEVEL][:STAT] or none)`);
		dims.push(m[3].split(",").map((spec) => ({ label: `${m[1]} ${m[2]}=${spec}`, key: `${m[1]}-${m[2]}-${spec}`, gear: [{ name: m[1], slot: m[2], spec }] })));
	}
	if (o.sweep_code_set) dims.push(String(o.sweep_code_set).split(",").map((n) => ({ label: `CODE ${n}`, key: `code-${n}`, code_set: n })));
	let combos = [[]];
	for (const d of dims) combos = combos.flatMap((c) => d.map((v) => [...c, v]));
	if (problems.length) throw Object.assign(new Error(problems.join("\n")), { problems });

	const variants = combos.map((combo) => {
		const setup = structuredClone(base),
			vset = combo.find((v) => v.code_set) ? C.codeSet(combo.find((v) => v.code_set).code_set, { file: codeSets, pullsDir }) : set,
			// (a set compared: worn in place of the character's edits of its slots)
			more = combo.flatMap((v) => v.gear || []),
			worn = new Set(more.filter((g) => g.set).map((g) => g.name + ":" + g.slot)),
			gear = [...edits.filter((g) => !worn.has(g.name + ":" + g.slot)), ...more],
			vw = [];
		if (vset) applySet(setup, vset);
		// per character: another set (its whole code block), another entry slot
		for (const c of setup.characters) {
			if (per.code_sets[c.name]) {
				const own = C.codeSet(per.code_sets[c.name], { file: codeSets, pullsDir }),
					k = C.codeFor(own, c.name, c.class);
				c.code = { dir: k.dir || null, recursive: !!k.recursive, entry: k.entry || null, file: k.file || null, prelude: (c.code && c.code.prelude) ?? k.prelude ?? null, append: k.append || [], build: k.build || null, git: k.git || null };
			}
			if (per.entries[c.name]) c.code = { ...(c.code || {}), entry: per.entries[c.name], file: null };
			// CODE run before its entry (null: none, the defaults' too)
			if ((o.prelude || {})[c.name] != null) c.code = { ...(c.code || {}), prelude: String(o.prelude[c.name]) || null };
		}
		applyGear(setup, gear, G, pull, vw);
		const label = combo.map((v) => v.label).join(", ");
		if (label) setup.name = `${setup.name} [${label}]`;
		setup.notes = notesOf({ info, set: vset, T, gear, now, per });
		return { label, key: combo.map((v) => v.key).join("--").replace(/[^\w.+=-]/g, "_"), setup, code_set: vset ? vset.name : null, warnings: vw };
	});
	info.code = set ? set.name : "the template's";
	return { base, variants, info, warnings };
}

const stamp = (iso) => iso.slice(5, 16).replace("T", "-").replace(/[-:]/g, "").replace(/^(\d{4})(\d{4})$/, "$1-$2");

// every character's CODE from the set (its entries; the template's own code keys dropped but its prelude)
function applySet(setup, set) {
	const { entry, ...code } = set.code;
	setup.defaults = { ...(setup.defaults || {}), code: { ...code, ...(entry ? { entry } : {}) } };
	for (const c of setup.characters) {
		const pre = c.code && c.code.prelude;
		delete c.code;
		const e = set.entries[c.name] || (set.classes || {})[c.class] || (set.classes || {})["*"];
		if (e) c.code = { entry: e };
		if (pre != null) c.code = { ...(c.code || {}), prelude: pre };
	}
}

// gear edits: over the character's gear as it would start (its export's, its inline slots, else the starter gear),
// checked against the game's rules once all are in
function applyGear(setup, edits, G, pull, warnings) {
	const touched = new Map();
	for (const e of edits) {
		const c = setup.characters.find((x) => x.name === e.name);
		if (!c) throw new Error(`${e.set ? "--gear-set" : "--gear"} ${e.name}: not in the roster`);
		if (e.cls && e.cls !== c.class) throw new Error(`gear set ${e.set}: a ${e.cls}'s (${c.name} is a ${c.class})`);
		const st = (c.state ||= {});
		if (!touched.has(c.name)) {
			const x = st.from ? readJson(st.from).character : null;
			st.slots = S.startState(G, c.class, st, x).slots; // (the gear it would start with)
			touched.set(c.name, new Set());
		}
		st.slots[e.slot] = parseGear(e.spec, G);
		touched.get(c.name).add(e.slot);
	}
	const problems = [];
	for (const [n, slots] of touched) {
		const c = setup.characters.find((x) => x.name === n);
		for (const slot of slots) {
			const r = checkGear(G, c.class, slot, c.state.slots[slot], c.state.slots);
			problems.push(...r.problems.map((p) => `${n} ${p}`));
			warnings.push(...r.warnings.map((w) => `${n} ${w}`));
		}
	}
	if (problems.length) throw Object.assign(new Error(problems.join("\n")), { problems });
}

function notesOf({ info, set, T, gear, now, per = {} }) {
	const parts = [`Composed by chronal new, ${now.toISOString().slice(0, 16).replace("T", " ")}`];
	if (info.template) parts.push(`template ${path.basename(info.template)}`);
	if (info.pull) parts.push(`pull ${path.basename(path.dirname(info.pull))}/${path.basename(info.pull)}`);
	if (info.players && info.players.length) parts.push(`players' pages ${info.players.map((d) => `${path.basename(path.dirname(d))}/${path.basename(d)}`).join(", ")}`);
	parts.push(`CODE: ${set ? set.name + (set.git && set.git.rev !== set.git.commit ? ` (${set.git.commit.slice(0, 7)})` : "") : "the template's"}`);
	parts.push(`states: ${Object.entries(info.states).map(([n, s]) => `${n} ${s}`).join(", ")}`);
	const own = Object.entries(per.code_sets || {}).map(([n, v]) => `${n} ${v}`).concat(Object.entries(per.entries || {}).map(([n, v]) => `${n} slot ${v}`));
	if (own.length) parts.push(`CODE per character: ${own.join(", ")}`);
	const worn = [...new Set(gear.filter((g) => g.set).map((g) => `${g.name} ${g.set}`))], slots = gear.filter((g) => !g.set);
	if (worn.length) parts.push(`gear sets: ${worn.join(", ")}`);
	if (slots.length) parts.push(`gear: ${slots.map((g) => `${g.name} ${g.slot}=${g.spec}`).join(", ")}`);
	const inv = Object.keys(per.items || {}).concat(Object.keys(per.gold || {}).filter((n) => !(per.items || {})[n]));
	if (inv.length) parts.push(`inventory or gold set: ${inv.join(", ")}`);
	return parts.join(" | ") + "." + (T && T.notes ? " Template notes: " + T.notes : "");
}

/** Each character's start state in a setup (S.startState: its export, what's given on top, the starter gear) */
function statesOf(setup, G) {
	return Object.fromEntries(setup.characters.map((c) => {
		const st = c.state || {};
		return [c.name, S.startState(G, c.class, st, st.from ? S.readExport(st.from).character : null)];
	}));
}

// a character's code block (the defaults' keys under its own), its paths in its commit's tree (code.git), built once
function diskCode(setup, c, build, built) {
	let code = { ...(setup.defaults && setup.defaults.code), ...(c.code || {}) };
	code.append = [].concat(code.append || []);
	if (code.git) code = GIT.inTree(code);
	const bk = code.build ? JSON.stringify(code.build) : null;
	if (bk && build && !built.has(bk)) build(code.build), built.add(bk);
	return code;
}

// the library's entry a code block (diskCode's) reads, else null: one at a commit (its repo's), a folder of this machine
function libOf(code) {
	return LIB.specEntry(code) || (code.dir && (LIB.list().find((e) => e.meta.kind === "path" && path.resolve(e.meta.path) === path.resolve(code.dir)) || {}).name) || null;
}
// a folder's slots, read and fitted (fit.js slotsOf, suggest with its fit), once per folder and fit
function fitted(code, memo) {
	const k = JSON.stringify([code.dir, code.recursive, code.fit || null]);
	if (!memo.has(k)) {
		const slots = F.slotsOf(code);
		memo.set(k, { slots, s: F.suggest(slots, code.fit || {}) });
	}
	return memo.get(k);
}

/**
 * The characters whose CODE has no entry for them (their code dir lacks the slot, whatever its case; one the setup's
 * code_names renames is there under its new name too), per variant: [{ name, entry, slots, where, guess }] ; builds
 * each build hook once (build: S.runBuild, or null: not built). guess: others' CODE's (the library's) entry for it
 * (fit.js entryGuess: by its name, then its class; known: knownNames(): { slot, why }), else null.
 */
function lackingOf(setup, { build = S.runBuild, built = new Set(), G = null, memo = new Map(), known = null } = {}) {
	const out = [],
		cn = setup.code_names || {};
	for (const c of setup.characters) {
		const code = diskCode(setup, c, build, built);
		if (code.file || !code.dir) continue;
		const slots = C.slotNames({ code: { dir: code.dir, recursive: code.recursive } });
		const entry = code.entry || c.name,
			has = new Set([...(slots || []), ...(slots || []).map((s) => (Object.hasOwn(cn, s) ? cn[s] : s))].map((s) => s.toLowerCase()));
		if (!slots || has.has(F.toFilename(entry).toLowerCase())) continue;
		let guess = null;
		if (libOf(code)) {
			const f = fitted(code, memo);
			guess = F.entryGuess(f.slots, c, { skills: (G || game()).skills, loaded: f.s.loaded, known });
		}
		out.push({ name: c.name, entry, slots, where: code.dir, guess });
	}
	return out;
}

/**
 * Others' CODE (the library's) as the run's characters run it, per folder of slots and fit (fit.js): its load_code /
 * require_code targets (chosen, suggested, none found), the slots built as it runs, what each entry run here runs first,
 * the entries that are ES modules (bundled) -> [{ lib, dir, who, entries: { <name>: <slot> }, calls, dynamic, with,
 * modules, errors }] (calls, with: suggest()'s with the entry's chosen fit, so each says why)
 */
function fitsOf(setup, { build = S.runBuild, built = new Set() } = {}) {
	const by = new Map();
	for (const c of setup.characters) {
		const code = diskCode(setup, c, build, built),
			lib = !code.file && code.dir && fs.existsSync(code.dir) ? libOf(code) : null;
		if (!lib) continue;
		const k = JSON.stringify([code.dir, code.recursive, code.fit || null]);
		(by.get(k) || by.set(k, { code, lib, who: [] }).get(k)).who.push({ name: c.name, entry: code.entry || c.name });
	}
	return [...by.values()].map(({ code, lib, who }) => {
		let chosen = {};
		try {
			chosen = LIB.get(lib).meta.fit || {};
		} catch (e) {}
		const slots = F.slotsOf(code),
			s = F.suggest(slots, chosen),
			entries = Object.fromEntries(who.map((c) => [c.name, (slots.find((x) => x.slot.toLowerCase() === F.toFilename(c.entry).toLowerCase()) || {}).slot || null])),
			used = new Set(Object.values(entries).filter(Boolean).map((x) => x.toLowerCase()));
		return {
			lib, dir: code.dir, who: who.map((c) => c.name), entries, slots: slots.map((x) => x.slot), calls: s.calls, dynamic: s.dynamic,
			with: s.with.filter((w) => used.has(w.entry.toLowerCase())), modules: s.modules.filter((m) => used.has(m.toLowerCase())), errors: s.errors,
		};
	});
}

// ---- names in CODE (setup code_names, names.js) ----

/** The characters this checkout knows: its pulls' and the players' pages taken (the newest first) -> Map name -> { class, of } */
function knownNames({ pullsDir = config().pulls_dir, playersDir = config().players_dir } = {}) {
	const out = new Map();
	for (const [dir, of] of [[pullsDir, "pull"], [playersDir, "public page"]])
		for (const p of P.listPulls(dir).sort((a, b) => (a.meta.pulled_at < b.meta.pulled_at ? 1 : -1)))
			for (const c of p.meta.characters) if (!out.has(c.name)) out.set(c.name, { class: c.class, of: `${of} ${p.account}` });
	return out;
}

// the files a character's CODE reads: its slot directory's (fit.js slotFiles), its entry file, the appended ones
function codeFiles(code) {
	const out = [];
	if (code.dir && fs.existsSync(code.dir)) out.push(...F.slotFiles(code.dir, code.recursive).map((x) => x.file));
	for (const f of [code.file, ...code.append]) if (f && fs.existsSync(f)) out.push(f);
	return out;
}

/**
 * The names of characters in the run's CODE and who each is in the run: the names it has of the characters known here
 * (knownNames: with their classes) and of the roster, then the strings it gives the game's functions as a character's
 * name (send_cm, get_player, character.name === ...: suggested, kept unless chosen). Each: given (A: B; A: A keeps
 * it), else itself when in the run, else the character running its slot (code.entry A), else the first character of
 * its class the CODE doesn't name, else it stays.
 * @param {object} o  { given: { A: B }, known: knownNames(), build, built }
 * @returns {{ map: object|null (the setup's code_names: the moves, the known names that stay, the given), names: [{ name,
 *   class, of, count, to, why, ctx }], flags: [{ where, line, text, name, why }], errors: string[] }}
 */
function namesOf(setup, { given = {}, known = knownNames(), build = S.runBuild, built = new Set() } = {}) {
	const roster = setup.characters,
		inRun = new Set(roster.map((c) => c.name)),
		files = new Map(), // path -> its name in flags
		runs = new Map(); // a slot named as an entry -> the character running it
	for (const c of roster) {
		const code = diskCode(setup, c, build, built);
		for (const f of codeFiles(code)) files.set(f, path.basename(f));
		if (!code.file && code.entry && code.entry !== c.name && !runs.has(code.entry)) runs.set(code.entry, c.name);
	}
	const want = [...new Set([...known.keys(), ...inRun, ...Object.keys(given)])],
		found = {},
		suggested = {},
		errors = [],
		texts = [];
	for (const [f, where] of files) {
		const t = fs.readFileSync(f, "utf8"),
			r = N.scan(t, want);
		texts.push([where, t]);
		for (const [n, k] of Object.entries(r.found)) found[n] = (found[n] || 0) + k;
		for (const [n, at] of Object.entries(r.suggested)) suggested[n] = [...new Set([...(suggested[n] || []), ...at])];
		if (r.error) errors.push(`${where}: ${r.error}`);
	}
	// the most named first; the suggested after
	const order = [...Object.keys(found).sort((a, b) => found[b] - found[a] || (a < b ? -1 : 1)), ...Object.keys(suggested).filter((n) => !found[n]).sort()],
		named = new Set(order),
		to = {};
	for (const [a, b] of Object.entries(given)) to[a] = { to: b || a, why: "chosen" };
	for (const a of order)
		if (!to[a] && inRun.has(a)) to[a] = { to: a, why: "in the run" };
		else if (!to[a] && runs.has(a)) to[a] = { to: runs.get(a), why: "runs its slot" };
	const taken = new Set(Object.values(to).map((x) => x.to));
	for (const a of order) {
		if (to[a]) continue;
		const k = known.has(a) ? known.get(a).class : null,
			c = k && roster.find((r) => r.class === k && !taken.has(r.name) && !named.has(r.name));
		if (c) (to[a] = { to: c.name, why: "by class" }), taken.add(c.name);
		else to[a] = { to: a, why: k ? `no other ${k} in the run` : "found in " + suggested[a].join(", ") };
	}
	const map = {};
	for (const [a, x] of Object.entries(to)) if (x.why === "chosen" || x.to !== a || (known.has(a) && !inRun.has(a))) map[a] = x.to;
	// (a string that is a slot's name names a slot, not a character: not flagged)
	const flags = [],
		slots = [...files.keys()].map((f) => path.basename(f, ".js"));
	for (const [where, t] of texts) {
		const r = N.mapText(t, map, [...inRun, ...slots]);
		for (const f of r.flags) flags.push({ where, ...f });
		if (r.error && !errors.includes(`${where}: ${r.error}`)) errors.push(`${where}: ${r.error}`);
	}
	const names = [...new Set([...order, ...Object.keys(given)])].map((a) => ({
		name: a, class: known.has(a) ? known.get(a).class : (roster.find((c) => c.name === a) || {}).class || null, of: known.has(a) ? known.get(a).of : inRun.has(a) ? "the run" : null, count: found[a] || 0,
		to: to[a].to, why: to[a].why, ctx: suggested[a] || null,
	}));
	return { map: Object.keys(map).length ? map : null, names, flags, errors };
}

/**
 * A variant's names in CODE and its missing CODE, settled together (a character given another slot takes that slot's
 * name, which changes what the others lack): code_names (namesOf: given, false for none), then each character whose
 * CODE lacks its entry takes its choice (choices: { <name>: "slot:<slot>" | "idle" | "exclude" }, or a function of
 * the lacking one; none: others' CODE's guess, lackingOf), again until nothing changes. The setup is changed in place.
 * -> { names (namesOf's, null when off), open: [{ name, entry, slots, where, guess }] (lacking, no choice), applied:
 *   [{ name, entry, slots, where, guess, choice, guessed }], bad: [a choice of no slot of its CODE] }
 */
function settle(setup, { given = {}, known = knownNames(), choices = {}, build = S.runBuild, built = new Set(), G = null } = {}) {
	const applied = new Map(),
		bad = new Map(),
		memo = new Map(),
		pick = typeof choices === "function" ? choices : (m) => choices[m.name];
	for (;;) {
		const names = given === false ? null : namesOf(setup, { given, known, build, built });
		if (names && names.map) setup.code_names = names.map;
		else delete setup.code_names;
		const lacking = lackingOf(setup, { build, built, G, memo, known });
		let changed = false;
		for (const m of lacking) {
			const chosen = pick(m),
				ch = chosen || (m.guess ? "slot:" + m.guess.slot : null);
			if (!ch || applied.has(m.name) || bad.has(m.name)) continue;
			if (ch !== "idle" && ch !== "exclude" && !(typeof ch === "string" && ch.startsWith("slot:") && m.slots.includes(ch.slice(5)))) bad.set(m.name, `${m.name}: no slot ${String(ch).replace(/^slot:/, "")} in its CODE`);
			else applyChoice(setup, m.name, ch), applied.set(m.name, { ...m, choice: ch, guessed: !chosen }), (changed = true);
		}
		if (!changed) return { names, open: lacking.filter((m) => !applied.has(m.name)), applied: [...applied.values()], bad: [...bad.values()] };
	}
}

// a choice made (chooseMissing's): idle, exclude or another slot, into the setup
function applyChoice(setup, name, choice) {
	const i = setup.characters.findIndex((c) => c.name === name);
	if (i < 0) return;
	if (choice === "exclude") {
		setup.characters.splice(i, 1);
		if (setup.party) {
			const members = setup.party.members.filter((n) => n !== name);
			if (!members.length) delete setup.party;
			else setup.party = { ...setup.party, members, leader: members.includes(setup.party.leader) ? setup.party.leader : members[0] };
		}
	} else if (choice === "idle") Object.assign(setup.characters[i], { code: { file: C.IDLE, entry: null, prelude: null, append: [] }, extra: [], params: null });
	else setup.characters[i].code = { ...(setup.characters[i].code || {}), entry: choice.slice(5) };
}

// relative to dir when both share a project folder (a common ancestor 2+ levels deep), else absolute
function relPath(dir, p) {
	const rel = path.relative(dir, p) || ".",
		ups = rel.split(path.sep).filter((x) => x === "..").length,
		depth = path.resolve(dir).split(path.sep).filter(Boolean).length;
	return depth - ups >= 2 ? rel : path.resolve(p);
}

/** Write setups (paths made relative to where each goes); refuses to replace a file unless force, never the template */
function writeSetups(list, { force = false, template = null } = {}) {
	for (const { file } of list) {
		if (template && path.resolve(file) === path.resolve(template)) throw new Error(`${file}: that's the template (--name or --save another)`);
		if (fs.existsSync(file) && !force) throw new Error(`${file} exists (--force replaces it, --name or --save another)`);
	}
	for (const { file, setup } of list) {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		const out = mapPaths(structuredClone(setup), (p) => relPath(path.dirname(file), p));
		fs.writeFileSync(file, JSON.stringify(out, null, "\t") + "\n");
	}
}

/**
 * The storage keys the run's CODE reads (names.js storageKeys, in every file each character's CODE reads): the game's
 * get(k) (kind "get": accounts.<k>.storage) and localStorage's (kind "local": local_storage), each with how often it is
 * read, whether the CODE writes it too (set: its value may be the CODE's own), the accounts of the characters reading
 * it and where; the reads of a key built as the CODE runs apart (dynamic).
 * -> { keys: [{ key, kind, count, set, accounts, where }], dynamic: [{ where, line, text }], errors }
 */
function keysOf(setup, { build = S.runBuild, built = new Set() } = {}) {
	const seen = new Map(), // file -> storageKeys
		acct = (c) => c.account || (setup.defaults && setup.defaults.account) || "main",
		keys = new Map(),
		dynamic = [],
		errors = [];
	for (const c of setup.characters) {
		const code = diskCode(setup, c, build, built),
			texts = [...codeFiles(code), ...(code.prelude ? [{ t: code.prelude, where: c.name + " prelude" }] : [])];
		for (const f of texts) {
			const where = typeof f === "string" ? path.basename(f) : f.where;
			let r = seen.get(typeof f === "string" ? f : where + "\0" + f.t);
			if (!r) {
				r = N.storageKeys(typeof f === "string" ? fs.readFileSync(f, "utf8") : f.t);
				seen.set(typeof f === "string" ? f : where + "\0" + f.t, r);
				if (r.error) errors.push(`${where}: ${r.error}`);
				for (const d of r.dynamic) dynamic.push({ where, ...d });
			}
			for (const [kind, rk, wk] of [["get", "get", "set"], ["local", "local", "local_set"]])
				for (const k of new Set([...Object.keys(r[rk]), ...Object.keys(r[wk])])) {
					const id = kind + "\0" + k,
						x = keys.get(id) || keys.set(id, { key: k, kind, count: 0, set: false, accounts: [], where: [], files: new Set() }).get(id);
					if (!x.files.has(where)) (x.files.add(where), (x.count += r[rk][k] || 0), r[wk][k] && (x.set = true), r[rk][k] && x.where.push(where));
					if (!x.accounts.includes(acct(c))) x.accounts.push(acct(c));
				}
		}
	}
	// the ones read (a key the CODE only writes is its own)
	const list = [...keys.values()].filter((x) => x.count).map(({ files, ...x }) => x).sort((a, b) => b.count - a.count || (a.key < b.key ? -1 : 1));
	return { keys: list, dynamic, errors: [...new Set(errors)] };
}

// what namesOf found that may not be mapped, as warnings: the strings that may mean a mapped name, the texts not read
function namesNotes(nm) {
	if (!nm) return [];
	return [...nm.flags.map((f) => `names in CODE: ${N.flagText(f)}: not mapped`), ...nm.errors.map((e) => `names in CODE: ${e}: not read, its names are not mapped`)];
}

/** The slot a character's CODE starts from on disk: its code.entry, else the one code_names renames to its name, else
 * its name (a code.file: the file's name) */
function entrySlot(setup, c) {
	const code = { ...(setup.defaults && setup.defaults.code), ...(c.code || {}) },
		cn = setup.code_names || {};
	if (code.file) return path.basename(code.file);
	return code.entry || Object.keys(cn).find((a) => a !== c.name && cn[a] === c.name) || c.name;
}

// ---- running: every setup x seed, JOBS at a time; a table of the means ----

function runAll(files, { seeds, jobs, args = [], log = console.log }) {
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "chronal-new-")),
		queue = files.flatMap((f) => seeds.map((seed) => ({ ...f, seed }))),
		results = [];
	let n = 0;
	// SIGINT/SIGTERM: passed on to the runs going (each stops at its next game minute with its numbers), none started after
	const children = new Set(),
		pass = (sig) => {
			queue.length = 0;
			for (const c of children) c.kill(sig);
		};
	for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, pass);
	return new Promise((resolve) => {
		let active = 0;
		const done = (x) => {
			for (const sig of ["SIGINT", "SIGTERM"]) process.off(sig, pass);
			resolve(x);
		};
		const next = () => {
			if (!queue.length) return active || done({ results, tmp });
			const r = queue.shift(),
				i = n++,
				result = path.join(tmp, `${i}.json`),
				logFile = path.join(tmp, `${i}.log`),
				out = fs.openSync(logFile, "w");
			active++;
			// (several seeds: a tag per seed, so the runs' titles on the dashboard tell them apart; one: the setup's name)
			const tag = args.includes("--tag") || seeds.length < 2 ? [] : ["--tag", `${r.label || r.name} s${r.seed}`];
			const child = spawn(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", r.file, ...(r.seed != null ? ["--seed", String(r.seed)] : []), "--result", result, ...tag, ...args], { stdio: ["ignore", out, out] });
			children.add(child);
			child.on("exit", (code) => {
				children.delete(child);
				active--;
				fs.closeSync(out);
				const res = code === 0 && fs.existsSync(result) ? readJson(result) : null;
				results.push({ ...r, code, res, log: logFile });
				log(res ? `done ${r.label || r.name} seed ${r.seed ?? "(its own)"}: ${line(res)}` : `FAILED ${r.label || r.name} seed ${r.seed ?? "(its own)"} (exit ${code}): ${logFile}`);
				next();
			});
			if (active < jobs) next();
		};
		next();
	});
}
const perH = (v, res) => (res.minutes ? v / (res.minutes / 60) : 0);
const party = (res) => {
	const cs = Object.values(res.characters || {}).filter((c) => !c.outside); // (an account out of the totals)
	return { kills_h: perH(cs.reduce((s, c) => s + (c.kills || 0), 0), res), xp_h: cs.reduce((s, c) => s + (c.xp_h || 0), 0), gold_h: perH(cs.reduce((s, c) => s + (c.gold_gained || 0), 0), res), deaths: cs.reduce((s, c) => s + (c.deaths || 0), 0) };
};
const M = (v) => (Math.abs(v) >= 1e6 ? (v / 1e6).toFixed(2) + "M" : Math.abs(v) >= 1e3 ? (v / 1e3).toFixed(1) + "k" : v.toFixed(0));
const line = (res) => {
	const p = party(res);
	return `${M(p.kills_h)} kills/h, ${M(p.xp_h)} xp/h, ${M(p.gold_h)} gold/h, ${p.deaths} deaths (${res.minutes} min)`;
};
function table(results, files = []) {
	const by = new Map(files.map((f) => [f.file, { label: f.label || f.name, runs: [] }]));
	for (const r of results) (by.get(r.file) || by.set(r.file, { label: r.label || r.name, runs: [] }).get(r.file)).runs.push(r);
	const rows = [...by.values()].map(({ label, runs }) => {
		const ok = runs.filter((r) => r.res).map((r) => party(r.res)),
			mean = (k) => (ok.length ? ok.reduce((s, p) => s + p[k], 0) / ok.length : NaN);
		return { variant: label || "(the setup)", runs: `${ok.length}/${runs.length}`, "kills/h": ok.length ? M(mean("kills_h")) : "-", "xp/h": ok.length ? M(mean("xp_h")) : "-", "gold/h": ok.length ? M(mean("gold_h")) : "-", deaths: ok.length ? mean("deaths").toFixed(1) : "-" };
	});
	return rows;
}

// ---- command line: chronal new ... ----

const USAGE = `usage: chronal new [--template FILE] [--pull latest|ACCOUNT|ACCOUNT/TIME|DIR] [--player ACCOUNT|ACCOUNT/TIME|DIR]...
                    [--account KEY] [--account-of NAME=KEY]... [--account-age KEY=DAYS]... [--account-bank KEY=none|ACCOUNT]...
                    [--chars A,B,...] [--offline A,...] [--char NAME:CLASS[:LEVEL]]... [--state NAME=pull|template|fresh]...
                    [--level NAME=N]... [--at NAME=map:x:y]... [--gear-set NAME=SET]... [--gear NAME:SLOT=ITEM[+LEVEL][:STAT]|none]...
                    [--party A,B,...[/harness|code|none] | --no-party] [--code-set NAME] [--missing NAME=SLOT|idle|exclude,...]
                    [--code-name CODENAME=NAME]... [--no-code-names] [--prelude NAME=CODE]...
                    [--storage KEY=VALUE]... [--local-storage KEY=TEXT]... [--steer "AT[@NAME] KEY=VALUE" | "AT[@NAME] run CODE" | JSON]...
                    [--until EXPR] [--check-every 1s]
                    [--sweep-gear-set NAME=A,B,...]... [--sweep-gear NAME:SLOT=A,B,...]... [--sweep-code-set A,B,...]
                    [--duration 30m] [--warmup 2m] [--seed N] [--ping MS] [--world-age 2h] [--age-days N]
                    [--start 2026-10-31T18:00Z] [--season NAME]... [--anniversary on|off] [--event NAME@AT]... [--spawn JSON]... [--param NAME|*=JSON]...
                    [--name NAME] [--save PATH] [--force] [--check | --run [--seeds 1,2,3] [--jobs N] [--live DIR | --no-live] [--no-build]] [--trust]`;
const LISTS = ["--char", "--state", "--level", "--at", "--gear-set", "--gear", "--sweep-gear-set", "--sweep-gear", "--missing", "--player", "--account-of", "--account-age", "--account-bank", "--code-name", "--prelude", "--storage", "--local-storage", "--steer", "--season", "--event", "--spawn", "--param"],
	VALUES = ["--anniversary", "--until", "--check-every", "--template", "--pull", "--account", "--chars", "--offline", "--party", "--code-set", "--sweep-code-set", "--duration", "--warmup", "--seed", "--seeds", "--ping", "--world-age", "--age-days", "--name", "--save", "--jobs", "--live", "--start"],
	FLAGS = ["--no-party", "--no-code-names", "--force", "--check", "--run", "--no-live", "--no-build", "--trust", "--help"];

function parseArgs(argv) {
	const o = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i],
			k = a.slice(2);
		if (LISTS.includes(a) || VALUES.includes(a)) {
			if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
			if (LISTS.includes(a)) (o[k] ||= []).push(argv[++i]);
			else o[k] = argv[++i];
		} else if (FLAGS.includes(a)) o[k] = true;
		else throw new Error(`unknown ${a.startsWith("--") ? "option" : "argument"} ${a}`);
	}
	return o;
}

async function cli(argv) {
	let a;
	try {
		a = parseArgs(argv);
	} catch (e) {
		console.error(`${e.message}\n${USAGE}`);
		process.exit(2);
	}
	if (a.help) return console.log(USAGE);
	if (a.check && a.run) return console.error("--check or --run"), process.exit(2);
	const fail = (e) => {
		console.error(e.problems ? e.problems.map((p) => "problem: " + p).join("\n") : "chronal new: " + e.message);
		process.exit(2);
	};
	let out;
	try {
		out = compose({
			template: a.template, pull: a.pull, players: a.player, account: a.account, account_of: pairs(a["account-of"] || [], "--account-of"),
			account_age: keyPairs(a["account-age"] || [], "--account-age"), account_bank: keyPairs(a["account-bank"] || [], "--account-bank"), chars: a.chars, offline: a.offline ? a.offline.split(",") : [], char: a.char,
			state: pairs(a.state || [], "--state"), level: pairs(a.level || [], "--level"), at: pairs(a.at || [], "--at"), gear_set: pairs(a["gear-set"] || [], "--gear-set"), gear: a.gear,
			party: a["no-party"] ? false : a.party, code_set: a["code-set"], name: a.name, duration: a.duration, warmup: a.warmup, seed: a.seed,
			ping: a.ping, world_age: a["world-age"], age_days: a["age-days"], sweep_gear_set: a["sweep-gear-set"], sweep_gear: a["sweep-gear"], sweep_code_set: a["sweep-code-set"],
			spawns: a.spawn && a.spawn.map((x) => { try { return JSON.parse(x); } catch (e) { throw new Error(`--spawn ${x}: JSON ({ "monster": "goo", "at": "main:0:0", ... }): ${e.message}`); } }),
			params: a.param && Object.fromEntries(a.param.map((x) => { const m = /^([A-Za-z0-9]{1,12}|\*)=(.+)$/.exec(x); if (!m) throw new Error(`--param ${x}: NAME=JSON or *=JSON`); try { return [m[1], JSON.parse(m[2])]; } catch (e) { throw new Error(`--param ${x}: ${e.message}`); } })),
			start: a.start, seasons: a.season, anniversary: a.anniversary == null ? undefined : a.anniversary === "on" ? true : a.anniversary === "off" ? false : (() => { throw new Error(`--anniversary ${a.anniversary}: on or off`); })(), events: a.event && a.event.map((x) => { const m = /^(\w+)@(\S+)$/.exec(x); if (!m) throw new Error(`--event ${x}: NAME@AT (e.g. goobrawl@20m)`); return { event: m[1], at: m[2] }; }),
			code_names: a["no-code-names"] ? false : pairs(a["code-name"] || [], "--code-name"), prelude: codePairs(a.prelude || [], "--prelude"),
			storage: a.storage ? { "*": valuePairs(a.storage, "--storage") } : undefined, local_storage: a["local-storage"] ? { "*": valuePairs(a["local-storage"], "--local-storage", false) } : undefined,
			steer: a.steer ? a.steer.map(steerOf) : undefined, until: a.until, check_every: a["check-every"],
		});
	} catch (e) {
		return fail(e);
	}
	const { variants, info } = out;
	// names in CODE and missing CODE: settled per variant (settle), a missing one chosen once per character and CODE
	// (--missing, else asked) for every variant
	const given = a.missing ? C.parseMissing(a.missing.join(",")) : {},
		built = new Set(),
		asked = new Map(),
		known = knownNames(),
		key = (m) => m.name + "\0" + m.where;
	try {
		for (const v of variants) {
			for (;;) {
				const r = settle(v.setup, { given: info.code_names, known, choices: (m) => asked.get(key(m)), build: a["no-build"] ? null : S.runBuild, built }),
					todo = r.open.filter((m) => !asked.has(key(m)));
				v.names = r.names;
				v.guessed = [...(v.guessed || []), ...r.applied.filter((m) => m.guessed)];
				if (!todo.length) break;
				const where = v.code_set || "its CODE";
				const choices = await C.chooseMissing(todo, {
					given: Object.fromEntries(Object.entries(given).filter(([n]) => n === "*" || todo.some((m) => m.name === n))), check: !!a.check, where,
					characters: v.setup.characters.map((c) => ({ name: c.name, extra: c.extra ?? (v.setup.defaults && v.setup.defaults.extra) ?? [] })),
					what: (m) => `${m.name}: ${v.code_set ? `the CODE set ${v.code_set}` : `its CODE (${m.where})`} has no slot ${m.entry}${v.code_set && /^(live|pull:)/.test(v.code_set) ? " (no CODE loaded for it on live)" : ""}`,
					stop: (problems) => fail({ problems }),
				});
				for (const m of todo) asked.set(key(m), choices[m.name]);
			}
		}
		const unused = Object.keys(given).filter((n) => n !== "*" && ![...asked.keys()].some((k) => k.startsWith(n + "\0")));
		if (unused.length) return fail({ problems: unused.map((n) => `--missing ${n}: ${variants.some((v) => v.setup.characters.some((c) => c.name === n)) ? "its CODE has its entry" : "no such character"}`) });
	} catch (e) {
		return fail(e);
	}

	// where: one setup -> --save FILE, else <setups_dir>/<name>.json; a sweep -> a folder, a file per variant
	const setupsDir = config().setups_dir,
		baseName = out.base.name.replace(/[^\w.+=-]/g, "_");
	const files = variants.length === 1 && !variants[0].label
		? [{ file: path.resolve(a.save || path.join(setupsDir, baseName + ".json")), setup: variants[0].setup, label: "", name: variants[0].setup.name }]
		: variants.map((v) => ({ file: path.join(path.resolve(a.save || path.join(setupsDir, baseName)), v.key + ".json"), setup: v.setup, label: v.label, name: v.setup.name }));
	try {
		for (const f of files) S.loadSetup(f.setup); // every problem before anything is written
		writeSetups(files, { force: !!a.force, template: info.template });
	} catch (e) {
		return fail(e);
	}

	// what it is
	const s0 = files[0].setup;
	console.log(`${files.length === 1 ? files[0].file : `${files.length} setups in ${path.dirname(files[0].file)}`}`);
	console.log(`  ${[info.template && "template " + path.basename(info.template), info.pull && "pull " + path.basename(path.dirname(info.pull)) + "/" + path.basename(info.pull), ...info.players.map((d) => "player " + path.basename(path.dirname(d)) + "/" + path.basename(d)), "CODE " + (variants[0].code_set || "the template's")].filter(Boolean).join(" | ")}`);
	for (const c of s0.characters)
		console.log(`  ${c.name.padEnd(12)} ${c.class.padEnd(8)} ${String(c.account || "").padEnd(12)} ${String(info.states[c.name] || "").padEnd(24)} ${c.online === false ? "offline " : ""}${c.at ? (typeof c.at === "string" ? c.at : `${c.at.map}:${c.at.x}:${c.at.y}`) : "main spawn"}  ${entrySlot(s0, c)}`);
	if (s0.party) console.log(`  party ${s0.party.members.join(", ")} (leader ${s0.party.leader}, ${s0.party.form || "harness"})`);
	const nm = variants[0].names;
	if (nm && nm.names.some((x) => x.why !== "in the run")) {
		const moved = nm.names.filter((x) => x.to !== x.name),
			kept = nm.names.filter((x) => x.to === x.name && x.why !== "in the run");
		console.log(`  names in CODE: ${[moved.length && moved.map((x) => `${x.name} as ${x.to} (${x.why})`).join(", "), kept.length && "unchanged: " + kept.map((x) => `${x.name} (${x.why})`).join(", ")].filter(Boolean).join("; ")}`);
	}
	// storage: what each account's has, the keys the CODE reads that none sets; steering
	const ks = keysOf(s0, { build: a["no-build"] ? null : S.runBuild, built }),
		stored = Object.entries(s0.accounts || {}).filter(([, x]) => x.storage || x.local_storage),
		unset = ks.keys.filter((x) => x.accounts.some((k) => !Object.hasOwn(((s0.accounts || {})[k] || {})[x.kind === "get" ? "storage" : "local_storage"] || {}, x.key)));
	if (stored.length) console.log(`  storage: ${stored.map(([k, x]) => `${k} ${[...Object.entries(x.storage || {}).map(([q, v]) => `${q}=${JSON.stringify(v)}`), ...Object.entries(x.local_storage || {}).map(([q, v]) => `localStorage ${q}=${JSON.stringify(v)}`)].join(", ")}`).join("; ")}`);
	if (unset.length) console.log(`  storage the CODE reads, unset: ${unset.map((x) => (x.kind === "get" ? `get("${x.key}")` : `localStorage "${x.key}"`) + (x.set ? " (its CODE sets it too)" : "")).join(", ")}`);
	if (s0.steer) console.log(`  steer: ${s0.steer.map((e) => `${e.name ? e.name + " " : ""}${X.whyOf(e)}${e.character ? " @" + e.character : ""}: ${S.steerText(e)}`).join("; ")}`);
	if (s0.run && s0.run.until) console.log(`  until: ${s0.run.until}`);
	if (s0.run && s0.run.check) console.log(`  conditions checked every ${s0.run.check}`);
	// others' CODE fitted (fit.js): the entries guessed, what its calls load, what entries run first, ES modules
	const fitWarn = [];
	if (variants[0].guessed && variants[0].guessed.length) console.log(`  entries guessed: ${variants[0].guessed.map((m) => `${m.name} runs ${m.choice.slice(5)} (${m.guess.why})`).join(", ")} (--missing NAME=<slot> for another)`);
	for (const f of fitsOf(s0, { build: a["no-build"] ? null : S.runBuild, built })) {
		const fitted = f.calls.filter((c) => c.to !== undefined);
		if (fitted.length) console.log(`  ${f.lib}: ${fitted.map((c) => `${c.fn}(${c.number ? c.key : JSON.stringify(c.key)}) loads ${c.to === null ? "nothing" : c.to}`).join(", ")}`);
		for (const w of f.with.filter((x) => x.slots.length)) console.log(`  ${f.lib}: ${w.entry} runs first ${w.slots.join(", ")} (${w.why})`);
		if (f.modules.length) console.log(`  ${f.lib}: ${f.modules.join(", ")}: ES module${f.modules.length > 1 ? "s" : ""}, bundled`);
		for (const c of f.calls.filter((x) => x.to === undefined)) fitWarn.push(`${f.lib}: ${c.fn}(${c.number ? c.key : JSON.stringify(c.key)}) at ${c.where.slice(0, 2).join(", ")}: ${c.why} (chronal library fit ${f.lib} --call ${c.key}=SLOT|none)`);
		for (const d of f.dynamic) fitWarn.push(`${f.lib}: ${d.where}:${d.line} ${d.text}: its slot is built as it runs, not fitted`);
	}
	for (const w of [...out.warnings, ...new Set(variants.flatMap((v) => [...v.warnings, ...namesNotes(v.names)])), ...fitWarn]) console.error("warning: " + w);
	if (files.length > 1) for (const f of files) console.log(`  ${path.basename(f.file)}: ${f.label}`);

	// others' CODE (library.js) at a commit not trusted here: before a check or a run, asked about on a terminal
	// (--trust: trusted without asking); saved only, a warning
	const no = LIB.untrusted(variants.flatMap((v) => v.setup.characters.map((c) => [c.name, { ...(v.setup.defaults && v.setup.defaults.code), ...(c.code || {}) }])));
	if (no.length && a.trust) for (const u of no) LIB.trust(u.commit, { name: u.name, source: u.web, by: "chronal new --trust" }), console.error(`trusted CODE ${u.name} at ${u.commit.slice(0, 7)}`);
	else if (no.length && (a.check || a.run)) {
		if (!(process.stdin.isTTY && process.stdout.isTTY && (await LIB.ask(no, { by: "chronal new" })))) return fail({ problems: [...no.map(LIB.untrustedText), "(--trust: trust it without asking)"] });
	} else for (const u of no) console.error("warning: " + LIB.untrustedText(u));

	if (a.check) {
		let bad = 0;
		for (const f of files)
			try {
				const r = S.resolveSetup(S.loadSetup(f.file), { build: !a["no-build"] });
				console.log(`ok ${path.basename(f.file)}: ${r.resolved.characters.map((c) => `${c.name} ${c.code.entry} ${c.code.hash}`).join(", ")}${r.warnings.length ? " | " + r.warnings.join("; ") : ""}`);
			} catch (e) {
				bad++;
				console.log(`problems ${path.basename(f.file)}:\n  ${(e.problems || [e.message]).join("\n  ")}`);
			}
		process.exit(bad ? 2 : 0);
	}
	if (a.run) {
		const seeds = a.seeds ? a.seeds.split(",").map(Number) : [null];
		if (seeds.some((s) => s != null && !(Number.isInteger(s) && s >= 1))) return fail(new Error(`--seeds ${a.seeds}: whole numbers >= 1`));
		const per = 1 + Math.max(...files.map((f) => f.setup.characters.length)),
			jobs = Number(a.jobs) || Math.max(1, Math.floor(os.cpus().length / per));
		const args = [...(a["no-live"] ? ["--no-live"] : a.live ? ["--live", a.live] : []), ...(a["no-build"] ? ["--no-build"] : [])];
		console.log(`running ${files.length * seeds.length} runs, ${Math.min(jobs, files.length * seeds.length)} at a time`);
		const { results } = await runAll(files, { seeds, jobs, args });
		console.table(table(results, files));
		process.exit(results.every((r) => r.res) ? 0 : 1);
	}
}

module.exports = { compose, checkGear, parseGear, gearSpec, statesOf, lackingOf, fitsOf, applyChoice, knownNames, namesOf, settle, entrySlot, keysOf, steerOf, writeSetups, game, cli, table, SLOTS };
