"use strict";
// Real AL client (bot mode, like caracAL) + unmodified CODE, each in a jsdom-backed vm context.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { JSDOM } = require("jsdom");
const { realm } = require("./realm");

const CLIENT_FILES = [
	"js/pixi/fake/pixi.min.js",
	"js/jquery/jquery-3.2.0.min.js",
	"js/libraries/bowser/bowser.16.08.16.js",
	"js/libraries/combined.js",
	"js/codemirror/fake/codemirror.js",
	"common/js/common_functions.js",
	"js/old_common_functions.js",
	"js/functions.js",
	"js/generated_zones.js",
	"js/entity_animations.js",
	"js/game.js",
	"js/html.js",
	"js/progression/sources.js",
	"js/progression/stats.js",
	"js/progression/engine.js",
	"js/progression/runtime.js",
	"js/progression/ui.js",
	"js/merrit_stand_notice.js",
	"js/tavern_wheel.js",
	"js/tavern_slots.js",
	"js/tavern_poker.js",
	"js/payments.js",
	"js/keyboard.js",
];
const RUNNER_FILES = ["js/jquery/jquery-3.2.0.min.js", "common/js/common_functions.js", "js/old_common_functions.js", "js/runner_functions.js", "js/runner_compat.js"];
const LATE_FILES = ["js/pixel_fonts.js", "js/npc_obstruction_hint.js"];

// main.js get_browser_data(): what /data.js serves as G, in its order.
const BROWSER_G_FIELDS = ["version", "achievements", "animations", "monsters", "sprites", "maps", "geometry", "npcs", "tilesets", "imagesets", "items", "sets", "craft", "titles", "tokens", "dismantle", "conditions", "cosmetics", "projectiles", "classes", "dimensions", "levels", "upgrades", "compounds", "monster_gold", "positions", "skills", "games", "events", "images", "multipliers", "docs", "drops"];
// main.js's design files, in its order (dependencies first). /data.js serves them as they are: the running server's
// copies are not what a client gets (it adds items' igrade/igrace/a/buy/id, monsters' max_hp/c, sets' and classes'
// computed fields, the seasons' drops and respawns; drops, upgrades, compounds and monster_gold are locals of its
// init_game)
const DESIGN = ["projectiles", "animations", "achievements", "game_design", "games", "conditions", "sprites", "dimensions", "monsters", "maps", "npcs", "multipliers", "items", "classes", "levels", "upgrades", "drops", "skills", "events", "recipes", "titles", "tokens", "cosmetics", "precomputed_images"];
const designs = new Map();
function designOf(root) {
	if (!designs.has(root)) {
		const ctx = vm.createContext({});
		for (const f of DESIGN) vm.runInContext(fs.readFileSync(path.join(root, "design", f + ".js"), "utf8"), ctx, { filename: f + ".js" });
		vm.runInContext(fs.readFileSync(path.join(root, "docs/directory.js"), "utf8"), ctx, { filename: "directory.js" });
		designs.set(root, ctx);
	}
	return designs.get(root);
}
/** Everything a client needs from the server, as plain data (also shipped to client threads). */
function clientInfo(server) {
	if (!server.__clientInfo) {
		const root = server.__root,
			G = {};
		if (root) {
			// get_browser_data(): the design's tables; the version, and the geometry from the server's map records
			const d = designOf(root),
				v = (k) => vm.runInContext(`typeof ${k} === "undefined" ? undefined : ${k}`, d);
			for (const k of BROWSER_G_FIELDS) G[k] = k === "version" ? server.G.version : k === "geometry" ? server.G.geometry : k === "images" ? v("precomputed").images : v(k);
		} else for (const k of BROWSER_G_FIELDS) G[k] = server.G[k] !== undefined ? server.G[k] : server[k] !== undefined ? server[k] : k === "images" ? {} : undefined;
		server.__clientInfo = { gJson: JSON.stringify(G), path: (server.options && server.options.servers && server.options.servers.local && server.options.servers.local.path) || "/socket.io/", version: server.G.version };
	}
	return server.__clientInfo;
}

const sources = new Map();
function run(w, root, rel) {
	const file = path.join(root, rel);
	if (!sources.has(file)) sources.set(file, new vm.Script(fs.readFileSync(file, "utf8"), { filename: file }));
	return sources.get(file).runInContext(vmOf.get(w));
}
const vmOf = new WeakMap();

/** Web Storage with own-enumerable keys (so Object.keys(localStorage) works), shared per sim like a same-origin browser
 * profile (threads mode: per client thread, filled with its account's storage: sim.js writeStorage). */
function makeStorage() {
	const proto = {
		getItem(k) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : null; },
		setItem(k, v) { this[String(k)] = String(v); },
		removeItem(k) { delete this[k]; },
		clear() { for (const k of Object.keys(this)) delete this[k]; },
		key(i) { const k = Object.keys(this); return i < k.length ? k[i] : null; },
		get length() { return Object.keys(this).length; },
	};
	for (const k of Object.keys(Object.getOwnPropertyDescriptors(proto))) Object.defineProperty(proto, k, { enumerable: false });
	return Object.create(proto);
}
const exec = (w, code, filename) => vm.runInContext(code, vmOf.get(w), filename && { filename });

// Globals that belong to the harness or the JS realm itself, never forwarded to jsdom.
const OWN = new Set(["window", "self", "top", "parent", "frames", "globalThis", "eval", "console", "Date", "performance",
	"setTimeout", "setInterval", "clearTimeout", "clearInterval", "setImmediate", "clearImmediate", "requestAnimationFrame", "cancelAnimationFrame",
	"queueMicrotask", "structuredClone", "constructor", "onerror"]);

/**
 * A browser-like global: an ordinary V8 global (fast globals, own JS realm) with jsdom's DOM bridged onto it.
 * jsdom's own contextified window routes every global access through C++ interceptors (~8x slower for AL's code).
 * scripts (the CODE's window): its document's head and body are found by tag name, and a <script> appended to either runs.
 */
function makeWindow(env, { upper, label, onError, scripts, ip } = {}) {
	const jw = new JSDOM("<!DOCTYPE html><html><head></head><body></body></html>", { url: "http://localhost/" }).window; // DOM only
	// Bot mode renders no UI, so the document stays empty and every jQuery lookup returns nothing. Answer that directly
	// instead of running jsdom's selector engine (~100 lookups per frame); falls back to jsdom the moment anything is added.
	const doc = jw.document,
		empty = () => !doc.body.firstChild && !doc.head.firstChild;
	for (const m of ["querySelectorAll", "getElementsByClassName", "getElementsByTagName", "getElementsByName"]) {
		const orig = doc[m].bind(doc);
		if (scripts && m === "getElementsByTagName") doc[m] = (...a) => (empty() && !/^(html|head|body)$/i.test(a[0]) ? [] : orig(...a));
		else doc[m] = (...a) => (empty() ? [] : orig(...a));
	}
	for (const m of ["querySelector", "getElementById"]) {
		const orig = doc[m].bind(doc);
		doc[m] = (...a) => (empty() ? null : orig(...a));
	}
	const g = vm.createContext(vm.constants.DONT_CONTEXTIFY);
	vmOf.set(g, g);
	const builtins = new Set(Object.getOwnPropertyNames(g)),
		names = new Set(),
		bound = new Map();
	for (let o = jw; o && o !== Object.prototype; o = Object.getPrototypeOf(o)) for (const n of Object.getOwnPropertyNames(o)) names.add(n);
	for (const n of names) {
		if (builtins.has(n) || OWN.has(n)) continue;
		Object.defineProperty(g, n, {
			configurable: true,
			get() {
				const v = jw[n];
				if (typeof v !== "function" || /^[A-Z]/.test(n)) return v; // constructors stay unbound
				if (!bound.has(n)) bound.set(n, v.bind(jw));
				return bound.get(n);
			},
			set(v) {
				Object.defineProperty(g, n, { value: v, writable: true, configurable: true, enumerable: true });
			},
		});
	}
	for (const n of ["window", "self", "top", "frames"]) g[n] = g;
	env.localStorage ||= makeStorage();
	env.sessionStorage ||= makeStorage();
	Object.defineProperty(g, "localStorage", { value: env.localStorage, writable: true, configurable: true });
	Object.defineProperty(g, "sessionStorage", { value: env.sessionStorage, writable: true, configurable: true });
	g.parent = upper || g;
	g.__jsdom = jw;
	const report = onError || ((e) => console.error(`[sim ${label}]`, e));
	env.clock.installInto(g, { profile: "browser", onError: report });
	g.__ip = ip ?? (upper && upper.__ip) ?? null;
	g.io = env.hub.clientIo(realm(g).JSON, g.__ip);
	if (scripts) {
		// A classic inline <script> appended to the document runs as a browser runs it (load_code: "executes the code at
		// top-level in a synchronized manner"): at once, at this window's top level, once per element; what it throws goes
		// to the window's error handler (window.onerror in runner.html), not to the caller.
		const ran = new WeakSet();
		for (const el of [doc.head, doc.body]) {
			const append = el.appendChild.bind(el);
			el.appendChild = (node) => {
				const out = append(node);
				if (node && node.localName === "script" && !node.src && !ran.has(node) && (!node.type || /^(text|application)\/(x-)?(java|ecma)script$/i.test(node.type))) {
					ran.add(node);
					try {
						vm.runInContext(node.text, g, { filename: `${label} <script>` });
					} catch (e) {
						report(e);
					}
				}
				return out;
			};
		}
	}
	return g;
}

function pageVars(o) {
	const s = JSON.stringify;
	return `
var inside="selection";
var user_id=${s(o.user_id)},user_auth=${s(o.auth)};
var base_url="http://localhost";
var server_address=${s(o.server_address)},server_path=${s(o.server_path)};
var selection_server_explicit=true;
var server_names={"US":"Americas","EU":"Europas","ASIA":"Eastlands"};
var sound_music='',sound_sfx='',xmas_tunes=false,music_level=0.3,music_volume=100,sfx_volume=100;
var perfect_pixels='',screenshot_mode='',pro_mode='1',tutorial_ui='',proximity_guides='',close_buttons_enabled=true,new_attacks='1',recording_mode='';
var cached_map='1',scale='2',d_lines='',sd_lines='';
var Prod='',Dev='',Local='1',Staging='';
var is_electron='',is_tauri='',electron_data={},is_comm=false,no_eval=false;
var VERSION=${s(String(o.version))},platform='web',engine_mode='';
var no_graphics='1',border_mode='',no_html='bot',is_bot='1',explicit_slot='',is_mobile=false,is_bold=false;
var c_enabled='',stripe_enabled='';
var auto_reload="off",reload_times='0',character_to_load=${s(o.character)},mstand_to_load=null;
var url_address='',url_path='',url_character='';
var update_notes=[],update_notes_more=[],last_deploy=null;
var server_regions={"US":"Americas","EU":"Europas","ASIA":"Eastlands"};
var X={servers:[],characters:[],tutorial:{step:0,completed:[]},unread:0,codes:{}};
function payment_logic(){}
`;
}

/**
 * Start one character: game client context + (after it enters the game) a CODE runner context.
 * @param {object} o
 * @param {string} o.user_id  @param {string} o.auth  @param {string} o.character  character _id
 * @param {string} o.code     CODE source, run unmodified
 * @param {number} [o.fps]    client frame rate. 60 ≈ live with graphics (vsync). Lower = faster sim, positions sampled less often.
 * @param {object} [o.files]  the CODE's slots by name (require_code, load_code)
 * @param {(msg: string) => void} [o.onFatal]  the CODE asked for a slot that isn't in o.files
 * @param {object[]} [o.owned]  the account's characters as the page loaded them ({ name, type, level, online }): what
 *   start_character may start (the game checks X.characters, which the sim leaves empty as before)
 * @param {object} [o.sim]    { request(data), byPage }: the sim behind start_character and co (threads mode); byPage: a page
 *   started this one (start_character), which learns when it is in game
 */
function startClient(env, info, o) {
	const root = env.root,
		clock = env.clock,
		label = o.name || o.character;
	const game = makeWindow(env, { label, ip: o.ip });
	game.console = o.console || { ...console, log() {}, info() {}, debug() {} };

	// Language catalog, as htmls/language.html does.
	run(game, root, "js/phrases.js");
	game.phrase.load("en", realm(vmOf.get(game)).JSON.parse(JSON.stringify(require(path.join(root, "languages")).catalog("en"))));

	for (const f of CLIENT_FILES) run(game, root, f);
	game.G = realm(game).JSON.parse(info.gJson); // what /data.js serves
	exec(game, pageVars({ ...o, server_address: "localhost:7192", server_path: info.path, version: info.version }));
	for (const f of LATE_FILES) run(game, root, f);

	// Frame pacing: live clients draw on vsync (rAF). Bot mode uses setTimeout(draw,16); pace it on a frame grid instead.
	const frame = 1000 / (o.fps || 60),
		origin = clock.now,
		st = game.setTimeout;
	Object.defineProperty(game, "setTimeout", { writable: true, configurable: true, value: function (fn, delay, ...a) {
		if (fn === game.draw && delay === 16) return clock.at(origin + Math.ceil((clock.now - origin + 0.001) / frame) * frame, () => fn(), "client draw");
		return st(fn, delay, ...a);
	} });

	// No backend in the sim: HTTP API calls resolve to nothing (CODE-relevant ones can be added here).
	game.api_call = function (method, args, r_args) {
		if (o.api && o.api[method]) return o.api[method](args, r_args, game);
		return { then() { return this; }, catch() { return this; } };
	};
	game.api_call_l = game.api_call;

	// Named code slots for require_code and load_code (they ask parent.get_code_file first, then fetch /code.js - no
	// backend here), found as the game finds them: whatever the case, only letters, digits, _-.+ and spaces of the name
	// (find_code_slot). A name the setup does not give fails the run (o.onFatal: the sim ends it "failed") and the call
	// throws; so does a slot number (the sim has slots by name: code.fit.calls names the slot of a number the CODE writes).
	const files = o.files || {},
		byLower = Object.fromEntries(Object.entries(files).map(([k, v]) => [k.toLowerCase(), v]));
	game.get_code_file = (name) => {
		const text = files[name] ?? byLower[String(name).replace(/[^0-9A-Za-z_\-.+ ]/g, "").toLowerCase()];
		if (text != null) return text;
		const call = /\bat load_code\b/.test(new Error().stack) ? "load_code" : "require_code",
			have = Object.keys(files);
		const msg = /^\d+$/.test(String(name))
			? `${label}: ${call}(${JSON.stringify(name)}): a slot number; the sim knows slots by name (code.fit.calls names the slot of a number written in the CODE)`
			: `${label}: ${call}(${JSON.stringify(name)}): the setup gives ${label} no slot ${name} (its slots: ${have.length ? have.join(", ") : "none; code.dir gives slots"})`;
		if (o.onFatal) o.onFatal(msg);
		throw new Error(msg);
	};

	// tint_logic animates skill-cooldown overlays: jQuery lookups + .css/.append/.remove every frame, and it only ever
	// writes to the DOM (no read feeds any logic). Headless, nothing renders: same logic and tint bookkeeping, with $
	// a do-nothing chain inside it. (Was ~40-57% of a client's CPU in jsdom, even with the CSS writes dropped.)
	exec(game, `(function () {
		var original = tint_logic, chain = new Proxy(function () {}, { get: function () { return chain; }, apply: function () { return chain; } });
		var stub = function () { return chain; };
		tint_logic = function () {
			var $real = $;
			$ = stub;
			try { return original.apply(this, arguments); } finally { $ = $real; }
		};
	})();`);

	const state = { game, runner: null, name: label, errors: 0 };
	pages(game, o.sim, state, o.owned || []);
	/** Evaluate an expression in the game window; returns plain JSON data (works across threads too). */
	state.query = (expr) => {
		const json = exec(game, "JSON.stringify(" + expr + ")");
		return json === undefined ? undefined : JSON.parse(json);
	};
	game.get_code_function = (name) => (game.code_active && state.runner && state.runner[name]) || function () {};
	const ngl = game.new_game_logic;
	game.new_game_logic = function () {
		ngl.apply(this, arguments);
		if (!state.runner) {
			game.__runner = state.runner = startRunner(env, game, o.code, label, state);
			// (character_started_runner: the page that started this one learns it is in game)
			if (o.sim && o.sim.byPage) o.sim.request({ op: "in_game" });
		}
	};
	game.the_game();
	return state;
}

/**
 * Character switching: a browser page starts characters of its account in iframes (start_character_runner), closes
 * them (stop_character_runner), lists them (get_active_characters) and runs snippets in their CODE
 * (character_code_eval). Here each iframe is a client thread of the sim: the page asks the sim (sim.request) and keeps
 * the iframes' states from its answers (state.onSim). The checks and the promises are the game's (functions.js:
 * start_character_runner's checks, push_deferred, character_started_runner, character_start_failed_runner); the
 * account's characters are o.owned (the game's owned_character reads X.characters, which stays empty: filled, the
 * game's tutorial logic would change what a page sends). Without a sim (the single-thread Sim) the calls fail with
 * reason "sim_threads_only".
 */
function pages(game, sim, state, list) {
	const frames = new Map(); // name -> "starting" | "code": the page's iframes
	const ownedOf = (name) => (typeof name === "string" && list.find((c) => c.name.toLowerCase() === name.toLowerCase())) || null;
	game.start_character_runner = function (name, slot) {
		const owned = ownedOf(name);
		if (!owned) return game.rejecting_promise({ reason: "character_not_found" });
		name = owned.name;
		if (game.character && name == game.character.name) return game.rejecting_promise({ reason: "already_running", name: name });
		if (frames.get(name) === "code") return game.resolving_promise({ name: name });
		if (frames.has(name)) return game.push_deferred(name);
		if (owned.online) return game.rejecting_promise({ reason: "already_running", name: name, server: owned.server });
		if (!sim) return game.rejecting_promise({ reason: "sim_threads_only", name: name });
		frames.set(name, "starting");
		sim.request({ op: "start", name: name, slot: slot || "" });
		return game.push_deferred(name);
	};
	game.stop_character_runner = function (name) {
		name = (ownedOf(name) || {}).name || name;
		if (game.deferreds[name] && game.deferreds[name].length) game.reject_deferreds(name, { reason: "interrupted", name: name });
		if (!frames.delete(name) || !sim) return;
		sim.request({ op: "stop", name: name });
	};
	game.get_active_characters = function () {
		const out = {};
		if (!game.character) return out;
		out[game.character.name] = "self";
		for (const [name, st] of frames) out[name] = st;
		return out;
	};
	game.character_code_eval = function (name, snippet) {
		if (!frames.has(name)) return void game.add_log(game.phrase.html("client.character_code_eval.character_not_found") + " ", "#993D42");
		if (frames.get(name) !== "code") return void game.add_log(game.phrase.html("client.character_code_eval.code_is_warming_up"), "#DC9E48");
		sim.request({ op: "eval", name: name, snippet: String(snippet) });
	};
	state.onSim = function (m) {
		if (m.op === "started") {
			if (frames.has(m.name)) frames.set(m.name, "code");
			game.character_started_runner(m.name, m.name);
		} else if (m.op === "failed") {
			frames.delete(m.name);
			game.character_start_failed_runner(m.name, { reason: m.reason, message: m.message });
		} else if (m.op === "gone") {
			// its page closed (stopped with a page above it): as a failed start while it was starting
			if (frames.get(m.name) === "starting") game.character_start_failed_runner(m.name, { reason: m.reason, message: m.reason });
			frames.delete(m.name);
		} else if (m.op === "eval") {
			// command_character on this page's CODE (as the browser's character_code_eval does it)
			if (game.code_active) game.call_code_function("eval", m.snippet);
		}
	};
}

function startRunner(env, game, code, label, state) {
	const r = makeWindow(env, {
		upper: game,
		label: label + " CODE",
		scripts: true,
		onError: (e) => (state.errors++, game.add_log && game.add_log(String(e), "#FF0000"), console.error(`[sim ${label} CODE]`, e && e.message)),
	});
	r.console = game.console;
	r.phrase = game.phrase;
	for (const f of RUNNER_FILES) run(r, env.root, f);
	exec(r, `(function () {
		// runner_functions.js re-runs proxy() for every character property every 50ms; identical logic, O(1) membership.
		var seen = new Set(character.properties);
		proxy = function (name) {
			if (seen.has(name)) return;
			seen.add(name);
			character.properties.push(name);
			Object.defineProperty(character, name, {
				get: function () { return parent.character[name]; },
				set: function (value) {
					delete this[name];
					if (character.read_only.includes(name)) game_log(parent.phrase("code.readonly_character", { property: name }), colors.code_error);
					else parent.character[name] = value;
				},
				enumerable: true,
			});
		};
	})();`);
	exec(r, 'var active=false,catch_errors=true,Place="code",is_bot=parent.is_bot,Dev=parent.Dev,Staging=parent.Staging,Prod=parent.Prod,Local=parent.Local;');
	exec(r, 'active=true;parent.code_active=true;if(parent.socket&&typeof parent.socket.emit=="function")parent.socket.emit("code",{run:1});');
	exec(r, code, label + ".CODE.js");
	exec(r, 'if(character.rip) character.trigger("death",{past:true});');
	return r;
}

// entries { <key>: <text>, or null: removed } into a Web Storage
function putStorage(st, entries) {
	for (const [k, v] of Object.entries(entries || {})) v === null ? st.removeItem(k) : st.setItem(k, v);
	return st;
}

// (makeWindow, run, exec, RUNNER_FILES: for a host's own client thread script that builds its CODE runner itself)
module.exports = { startClient, clientInfo, makeStorage, putStorage, makeWindow, run, exec, RUNNER_FILES };
