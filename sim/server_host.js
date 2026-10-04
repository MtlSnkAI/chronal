"use strict";
// Runs the unmodified AL game server (node/server.js) inside a vm context on the virtual clock.
// Repo-local modules load inside the context too, so every Date/timer they touch is virtual.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const Module = require("node:module");
const { EventEmitter } = require("node:events");
const { createMongoModule, Db, setOutputCloner } = require("./fake_mongo");
const { realm } = require("./realm");
const { mulberry32 } = require("./vclock");

// node:crypto with its random sources drawn from the run's seed (cave_of_many_dreams, the tavern's games, generated
// maps and the cave's boot id call randomInt / randomBytes): a stream of its own, so Math.random's sequences don't
// move. Everything else (hashes, hmacs, ciphers) is the real module's.
function seededCrypto(seed) {
	const real = require("node:crypto"),
		rng = mulberry32((Math.imul(seed, 104729) + 0x5eed) | 0),
		u32 = () => Math.floor(rng() * 0x100000000),
		unit = () => (u32() * 0x200000 + (u32() >>> 11)) / 0x20000000000000; // 53 bits in [0, 1)
	const fill = (view, offset = 0, size) => {
		const b = new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
			end = size == null ? b.length : Math.min(b.length, offset + size);
		for (let i = offset; i < end; i++) b[i] = u32() & 0xff;
		return view;
	};
	const later = (cb, ...a) => queueMicrotask(() => cb(...a));
	const randomInt = (min, max, cb) => {
		if (typeof max !== "number") (cb = max), (max = min), (min = 0);
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max <= min) throw new RangeError(`randomInt: bad range [${min}, ${max})`);
		const v = min + Math.floor((max - min <= 0x100000000 ? rng() : unit()) * (max - min));
		return typeof cb === "function" ? void later(cb, null, v) : v;
	};
	const randomBytes = (n, cb) => {
		const b = fill(Buffer.alloc(n));
		return typeof cb === "function" ? void later(cb, null, b) : b;
	};
	const randomUUID = () => {
		const b = fill(new Uint8Array(16));
		(b[6] = (b[6] & 0x0f) | 0x40), (b[8] = (b[8] & 0x3f) | 0x80);
		const h = Buffer.from(b).toString("hex");
		return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
	};
	const getRandomValues = (view) => fill(view);
	const webcrypto = Object.create(real.webcrypto, { getRandomValues: { value: getRandomValues }, randomUUID: { value: randomUUID }, subtle: { value: real.webcrypto.subtle } });
	// (as own properties: the real module has getters for some of them)
	const own = { randomInt, randomBytes, randomFillSync: fill, randomUUID, getRandomValues, webcrypto };
	return Object.create(real, Object.fromEntries(Object.entries(own).map(([k, value]) => [k, { value, enumerable: true }])));
}

function makeEnv({ clock, hub, root, db = new Db(), workerLatency = 2 }) {
	const real = (p) => (fs.existsSync(p) ? fs.realpathSync(p) : p);
	const roots = [root, path.join(root, "common"), path.join(root, "secretsandconfig")].map(real);
	return { clock, hub, root, roots, db, mongo: createMongoModule(db), workerLatency, workerSeq: 0, contexts: [], crypto: seededCrypto(clock.seed) };
}

function isLocal(env, file) {
	return file.endsWith(".js") && !file.includes(`${path.sep}node_modules${path.sep}`) && env.roots.some((r) => file.startsWith(r + path.sep));
}

function makeRequire(env, ctx, fromFile, cache, intercepts) {
	const real = Module.createRequire(fromFile);
	function require(id) {
		if (Object.prototype.hasOwnProperty.call(intercepts, id)) return intercepts[id];
		const resolved = real.resolve(id);
		if (Module.isBuiltin(resolved) || !isLocal(env, resolved)) return real(id);
		if (cache.has(resolved)) return cache.get(resolved).exports;
		const module = { exports: {}, id: resolved, filename: resolved, loaded: false, children: [], paths: [] };
		cache.set(resolved, module);
		const src = fs.readFileSync(resolved, "utf8").replace(/^#!.*/, "");
		const fn = vm.runInContext("(function (exports, require, module, __filename, __dirname) {" + src + "\n})", ctx, { filename: resolved });
		fn.call(module.exports, module.exports, makeRequire(env, ctx, resolved, cache, intercepts), module, resolved, path.dirname(resolved));
		module.loaded = true;
		if (env.patch) env.patch(resolved, module.exports);
		return module.exports;
	}
	require.resolve = real.resolve;
	require.cache = {};
	return require;
}

function fakeProcess(argv) {
	const p = Object.create(process);
	const self = () => p;
	Object.defineProperties(p, {
		argv: { value: argv, writable: true },
		exit: { value: (c) => { throw new Error(`[sim] server called process.exit(${c})`); } },
		on: { value: self },
		once: { value: self },
		off: { value: self },
		removeListener: { value: self },
		addListener: { value: self },
	});
	return p;
}

/**
 * worker_threads.Worker, in-process on the virtual clock. The server starts 8 identical pathfinding workers; they
 * share one context (their handlers are synchronous, replies go back to the worker that got the request).
 * Saves ~8s of boot and ~1GB per sim.
 */
class FakeWorker extends EventEmitter {
	constructor(env, file, opts = {}) {
		super();
		this.env = env;
		this.threadId = ++env.workerSeq;
		this._toServer = env.serverRealm ? env.serverRealm.clone : structuredClone;
		const key = String(file) + "|" + Object.keys(opts.workerData || {}).sort().join(",");
		env.sharedWorkers ||= new Map();
		if (!env.sharedWorkers.has(key)) {
			const port = new EventEmitter(),
				entry = { port, current: null, toWorker: (x) => x, members: [] };
			port.postMessage = (m) => {
				for (const w of entry.current ? [entry.current] : entry.members) w._reply(m);
			};
			port.close = port.ref = port.unref = () => {};
			const workerData = structuredClone(opts.workerData);
			env.clock.at(env.clock.now, () => {
				const ctx = runNodeFile(env, String(file), { argv: [process.execPath, String(file)], worker: { workerData, parentPort: port, threadId: this.threadId } });
				entry.toWorker = realm(ctx).clone;
			});
			env.sharedWorkers.set(key, entry);
		}
		this._shared = env.sharedWorkers.get(key);
		this._shared.members.push(this);
		env.clock.at(env.clock.now, () => this.emit("online"));
	}
	_reply(m) {
		const c = structuredClone(m);
		this.env.clock.at(this.env.clock.now + this.env.workerLatency, () => this._dead || this.emit("message", this._toServer(c)), "worker reply");
	}
	postMessage(m) {
		const c = structuredClone(m),
			sh = this._shared;
		this.env.clock.at(this.env.clock.now + this.env.workerLatency, () => {
			if (this._dead) return;
			sh.current = this;
			try {
				sh.port.emit("message", sh.toWorker(c));
			} finally {
				sh.current = null;
			}
		}, "worker job");
	}
	terminate() {
		this._dead = true;
		return Promise.resolve(1);
	}
	ref() {}
	unref() {}
}

function intercepts(env, worker, ctx) {
	const http = require("node:http");
	const fakeHttp = { ...http, createServer: () => Object.assign(new EventEmitter(), { listen() { return this; }, close() {}, address: () => ({ port: 0 }) }) };
	const Worker = function (file, opts) {
		return new FakeWorker(env, file, opts);
	};
	return {
		crypto: env.crypto,
		"node:crypto": env.crypto,
		"socket.io": env.hub.socketIoModule(realm(ctx).JSON),
		mongodb: env.mongo,
		"geoip-lite": { lookup: () => null }, // 5s to load; the sim only ever sees 127.0.0.1
		http: fakeHttp,
		"node:http": fakeHttp,
		https: fakeHttp,
		worker_threads: worker
			? { isMainThread: false, workerData: worker.workerData, parentPort: worker.parentPort, threadId: worker.threadId, SHARE_ENV: Symbol("SHARE_ENV") }
			: { isMainThread: true, workerData: null, parentPort: null, threadId: 0, Worker, SHARE_ENV: Symbol("SHARE_ENV") },
	};
}

function runNodeFile(env, file, { argv, worker } = {}) {
	// DONT_CONTEXTIFY: an ordinary global object. A contextified sandbox routes every global access through
	// C++ interceptors, which made AL's global-heavy code ~8x slower than in a normal global.
	const ctx = vm.createContext(vm.constants.DONT_CONTEXTIFY);
	Object.assign(ctx, {
		console, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, AbortController, AbortSignal, queueMicrotask, atob, btoa,
		crypto: env.crypto,
		fetch: async () => { throw new Error("[sim] network disabled"); },
		process: fakeProcess(argv || [process.execPath, file]),
		__dirname: path.dirname(file),
		__filename: file,
	});
	ctx.global = ctx;
	ctx.structuredClone = realm(ctx).clone;
	if (worker) worker.workerData = realm(ctx).clone(worker.workerData);
	env.clock.installInto(ctx, { profile: "node", onError: (e) => console.error("[sim server] timer error:", e) });
	ctx.setImmediate = (fn, ...a) => ({ id: env.clock.at(env.clock.now, () => fn(...a)) });
	ctx.clearImmediate = (h) => env.clock.cancel(h && h.id);
	ctx.module = { exports: {}, id: ".", filename: file, loaded: false };
	ctx.exports = ctx.module.exports;
	ctx.require = makeRequire(env, ctx, file, new Map(), intercepts(env, worker, ctx));
	env.contexts.push(ctx);
	if (!worker && !env.serverRealm) (env.serverRealm = realm(ctx)), setOutputCloner(env.serverRealm.clone);
	let source = fs.readFileSync(file, "utf8");
	if (!worker && env.sourcePatches) for (const patch of env.sourcePatches) source = patch(source, file);
	vm.runInContext(source, ctx, { filename: file });
	return ctx;
}

/** Map geometry bundled in the repo -> in-memory DB, routed with the repo's own get_kind_from_id(). */
function seedMaps(env) {
	const scratch = vm.createContext({});
	vm.runInContext(fs.readFileSync(path.join(env.root, "common/mongodb_functions.js"), "utf8"), scratch);
	const { seedMaps } = require(path.join(env.root, "scripts/seed_mongodb.js"));
	env.db.seed(seedMaps, (d) => scratch.get_kind_from_id(d._id));
	env.kindOf = (id) => scratch.get_kind_from_id(id);
	return seedMaps.length;
}

/** Insert `line` right after the first `anchor` found inside `function fnName(`; throws if the server code changed. */
function insertAfter(source, fnName, anchor, line) {
	const start = source.indexOf("function " + fnName + "(");
	const at = start < 0 ? -1 : source.indexOf(anchor, start);
	if (at < 0) throw new Error(`[sim] can't apply patch: "${anchor}" not found in ${fnName}() — server code changed`);
	return source.slice(0, at + anchor.length) + line + source.slice(at + anchor.length);
}

// seasons: the server's season switches on (a setup's world.seasons), set once its script ran, before it boots (it reads
// them building its drops and monsters, as its own var events would have them); valentines' goo and holidayseason's
// snowman every 60 minutes, as server.js sets them for those seasons
async function startServer(env, { serverKey = "local", timeoutMs = 60000, seasons = [], anniversary = true } = {}) {
	const prev = env.patch;
	env.patch = (file, exports) => {
		if (file.endsWith(`${path.sep}options.js`) && exports.servers && exports.servers[serverKey]) {
			const s = exports.servers[serverKey];
			s.msgpack_path ||= "/socket.io.msgpack/"; // required by current server.js, missing from the config template
		}
		if (prev) prev(file, exports);
	};
	const file = path.join(env.root, "node/server.js");
	const ctx = runNodeFile(env, file, { argv: [process.execPath, file, serverKey] });
	// its own /eval: realm_broadcast() reaches every realm through servers_eval() (L80, blessings, a first login), this
	// one included; run here as the route runs it (the code in the server's scope, its data parsed), a ms later as a
	// request comes back. Any other address stays unreachable (the callers log one line: the error has no stack).
	const evalRoute = vm.runInContext(`(async function (code, data) { var output = ""; try { eval(code); output = await output; } catch (e) { console.log("\\n" + code); log_trace("chttp_eval", e); } return JSON.stringify(output); })`, ctx);
	ctx.fetch = async (url, opts = {}) => {
		const def = ctx.server_def,
			u = new URL(String(url));
		if (!def || u.host !== def.address || u.pathname !== def.api_path + "eval") {
			const e = new Error(`[sim] network disabled: ${opts.method || "GET"} ${url}`);
			e.stack = e.message;
			throw e;
		}
		const body = new URLSearchParams(String(opts.body || ""));
		await new Promise((done) => env.clock.at(env.clock.now + 1, done));
		const text = await evalRoute(body.get("code"), JSON.parse(body.get("data") || "{}"));
		return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
	};
	for (const s of seasons) ctx.events[s] = true;
	// the anniversary event: on in the server's own events ("remains on until manually disabled"); off: its baker, gift
	// and slice drops never come (the server checks it as it runs: anniversary_is_active)
	ctx.events.anniversary = !!anniversary;
	if (seasons.includes("valentines")) ctx.events.pinkgoo = 60;
	if (seasons.includes("holidayseason")) ctx.events.snowman = 60;
	const t0 = env.clock.now;
	while (!(ctx.server && ctx.server.live) && env.clock.now - t0 < timeoutMs) await env.clock.run({ forMs: 100 });
	if (!(ctx.server && ctx.server.live)) throw new Error("[sim] server did not go live");
	return ctx;
}

module.exports = { makeEnv, seedMaps, startServer, insertAfter, seededCrypto };
