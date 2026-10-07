"use strict";
// One character (client + CODE) on its own thread, in lockstep with the server (main thread) through a Gate.
const { workerData: w, receiveMessageOnPort } = require("node:worker_threads");
const fs = require("node:fs"),
	{ format } = require("node:util");
const { VirtualClock } = require("./vclock");
const { RemoteHub, Gate, spinWhile } = require("./fake_io");
const { startClient, makeStorage, putStorage } = require("./client_host");
const { readMode, readStatus, readRole, guarded, logTap, onceConsole, LOG_TEXT, LOG_KEEP, STATUS_MS } = require("./report");

process.on("unhandledRejection", () => {}); // browsers only log these
// A worker's stdout/stderr are flushed by its event loop, which doesn't turn during a run: write synchronously instead
// (CODE errors and warnings would show up late or never). Warnings and errors print once each (repeats counted, said at
// the thread's stop: a CODE's error in a loop, the game's "Weird resolve_deferred issue" for socket events a page sent
// itself); w.silent: none (the run's game log keeps them).
for (const [k, fd] of [["log", 1], ["info", 1], ["debug", 1]]) console[k] = (...a) => void fs.writeSync(fd, format(...a) + "\n");
const who = (w.fixture && w.fixture.name) || "?",
	out = onceConsole((kind, text) => void fs.writeSync(2, (text.startsWith("[sim") ? text : `[sim ${who} page] ` + text) + "\n"), { silent: !!w.silent, label: who });
for (const k of ["warn", "error"]) console[k] = (...a) => out.say(k, format(...a));
const [lo, hi] = w.latencyRange;
const clock = new VirtualClock({ start: w.start, seed: w.seed });
// w.rec: a replay recording of this character (rec.js), { dir, name, append, wait } (its next session; its last one's
// thread still open: the main thread says when to write, "rec_open")
const recorder = w.rec ? new (require("../lib/rec").Recorder)(w.rec.dir, w.rec.name, { append: w.rec.append, wait: w.rec.wait }) : null;
const hub = new RemoteHub(clock, { latency: (rng) => lo + rng() * (hi - lo), recorder });
// its page's storage: its account's (sim.js writeStorage)
const env = { clock, hub, root: w.root, localStorage: putStorage(makeStorage(), w.storage) };
const ctrl = new Int32Array(w.ctrl),
	f64 = new Float64Array(w.ctrl),
	any = new Int32Array(w.any);
const port = w.port,
	data = w.data;
const gate = new Gate({
	shared: w.shared, self: w.slot, peers: [0], L: w.W, spin: w.spin,
	// longer than the server's: a client stuck in an event holds the server back, and the server's error names it
	patience: 150000, name: () => "the server",
	flush: () => hub.out.length && data.postMessage(hub.take()),
	receive: () => {
		for (let m; (m = receiveMessageOnPort(data)); ) hub.receive(m.message);
	},
});
const quiet = { ...console, log() {}, info() {}, debug() {} };
// the game log's new lines and the page's console errors and warnings, posted with the modes (live.js pollModes):
// { n, err, con, lines: [[v, kind, text]] (the last LOG_KEEP) }
const logOut = { n: 0, err: 0, con: 0, lines: [] };
const logLine = (v, kind, text) => {
	logOut.n++;
	if (kind === "pageerror") logOut.err++;
	if (kind === "console") logOut.con++;
	logOut.lines.push([v, kind, text]);
	if (logOut.lines.length > LOG_KEEP) logOut.lines.shift();
};
for (const k of ["error", "warn"]) {
	const orig = console[k];
	quiet[k] = (...a) => {
		try {
			logLine(clock.now, "console", a.map((x) => (x && x.message ? x.message : String(x))).join(" ").slice(0, LOG_TEXT));
		} catch (e) {}
		return orig.apply(console, a);
	};
}

let replies = 0;
const reply = (msg) => {
	port.postMessage({ ...msg, n: ++replies });
	Atomics.add(ctrl, 1, 1);
	Atomics.add(any, 0, 1);
	Atomics.notify(any, 0);
};
const receive = () => {
	const m = receiveMessageOnPort(port); // posted before the go
	if (!m) throw new Error("[sim] command missing");
	return m.message;
};

// opt-in CPU profile of this thread (sim.profile(true/false)); a same-thread inspector session answers synchronously
let session = null;
const post = (method, params) => {
	let out;
	session.post(method, params || {}, (e, r) => {
		if (e) throw e;
		out = r;
	});
	return out;
};
function profiler(on) {
	if (on) {
		session = new (require("node:inspector").Session)();
		session.connect();
		post("Profiler.enable");
		post("Profiler.setSamplingInterval", { interval: 250 });
		post("Profiler.start");
		return true;
	}
	const { profile } = post("Profiler.stop");
	session.disconnect();
	session = null;
	return JSON.stringify(profile);
}

// LIVE: time per CODE mode, read after every lockstep window, and the CODE's status and role every STATUS_MS virtual ms
// at a window end (report.js: the CODE's chronal object). Every read goes through guarded(): the contexts' random
// sequences are put back, and a getter that scheduled a timer, emitted, made a promise or logged is not called again
// (impure: field -> why; its last value stands). Posted to the main thread about once a virtual second, and after each
// status read (with status and role), with the time and mode it was taken at (live.js)
const modes = w.modes ? {} : null,
	impure = {};
let modeAt = null,
	modeNow = null,
	from = null,
	posted = -Infinity,
	statusAt = -Infinity;
const read = (k, fn) => {
	if (impure[k]) return undefined;
	const r = guarded([state.game, state.runner], clock, hub, fn);
	if (r.impure && r.impure !== "threw") impure[k] = r.impure;
	return r.value;
};
const tap = logTap();
function sampleMode(now) {
	if (state && state.game) for (const [kind, text] of tap(state.game)) logLine(now, kind, text);
	const runner = state && state.runner,
		m = runner ? read("mode", () => readMode(runner)) : null,
		k = m ? m.v : null;
	if (m && m.from) from = m.from;
	if (modeAt != null && k != null) modes[k] = (modes[k] || 0) + now - modeAt;
	(modeAt = now), (modeNow = k);
	if (runner && now - statusAt >= STATUS_MS) {
		statusAt = now;
		const s = read("status", () => readStatus(runner)),
			r = read("role", () => readRole(runner)),
			got = {};
		if (s !== undefined) got.status = s ? s.v : null;
		if (r !== undefined) got.role = r ? r.v : null;
		(posted = now), postModes(got);
	} else if (now - posted >= 1000) (posted = now), postModes();
}
const postModes = (got) => {
	const log = logOut.n ? { ...logOut, lines: logOut.lines.slice() } : null;
	if (log) (logOut.n = logOut.err = logOut.con = 0), (logOut.lines.length = 0);
	w.modes.postMessage({ at: modeAt, cur: modeNow, totals: modes, from, impure: Object.keys(impure).length ? { ...impure } : null, ...got, ...(log ? { log } : {}) });
};

let state,
	fatal = null; // the CODE asked for a slot it doesn't have: in every run reply from then on (sim.fail())
try {
	// the page's character switching (start_character and co) asks the sim (hub.request); its answers come back as notices
	const sim = { request: (data) => hub.request(data), byPage: w.byPage };
	hub.onReply = (data) => state && state.onSim && state.onSim(data);
	state = startClient(env, w.info, { ...w.fixture, code: w.code, fps: w.fps, files: w.files, owned: w.owned, sim, console: quiet, onFatal: (msg) => (fatal ||= msg) });
	reply({ ready: true });
} catch (e) {
	reply({ err: String((e && e.stack) || e) });
}

// Serve the main thread's commands, one per macrotask (runSync drains microtasks itself); in between, this thread's
// event loop turns once (V8 platform tasks, finalizers, anything else queued on it).
let seen = 0;
function serve() {
	if (w.spin) spinWhile(ctrl, 0, seen, w.spin);
	Atomics.wait(ctrl, 0, seen);
	seen = Atomics.load(ctrl, 0);
	const kind = Atomics.load(ctrl, 2);
	try {
		if (kind === 0) {
			// run to f64[2], through the same windows as the server
			const end = f64[2];
			let b0 = performance.now(),
				waited = gate.waited;
			// busy ms, added per window (read by the main thread: per-thread load, also during a long run)
			const busy = () => {
				const now = performance.now();
				f64[3] += now - b0 - (gate.waited - waited);
				(b0 = now), (waited = gate.waited);
			};
			for (let until = Math.min(clock.now + w.W, end); ; until = Math.min(until + w.W, end)) {
				clock.mark(clock.now); // the server's messages sent in the previous window sort here
				for (const r of hub.out) r[4] ??= until; // sent between runs: they go with this window
				hub.window = until;
				clock.runSync({ before: until, gate });
				busy();
				if (modes) sampleMode(until);
				if (until >= end) break;
			}
			if (modes) postModes();
			gate.publish(end);
			hub.window = null;
			busy();
			reply(fatal ? { fatal } : {});
		} else {
			const m = receive();
			if (m.t === "q") reply({ value: state.query(m.expr) });
			else if (m.t === "prof") reply({ value: profiler(m.on) });
			else if (m.t === "rec_open") recorder && recorder.held && recorder.open(), reply({});
			else if (m.t === "stop") return recorder && recorder.close(), out.flush(), reply({}), process.exit(0);
		}
	} catch (e) {
		reply({ err: String((e && e.stack) || e) });
	}
	setImmediate(serve);
}
setImmediate(serve);
