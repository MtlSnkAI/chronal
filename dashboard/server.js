// The dashboard: every run in the live dir and its folders (one level: <folder>/<id>), live (chronal run writes <id>.json
// about once a real second: sim/live.js);
// this serves a page that polls them (dashboard/app: index.html, and main.js with its modules: the app, in Preact).
// It runs in its own process, so it costs the runs nothing.
//   chronal dash [--port 8089] [--host 127.0.0.1] [--dir live]
//   chronal dash --gc-code [--dir live]   (deletes the CODE in <dir>/code/ no run's setup file uses)
// From another machine: ssh -N -L 8089:localhost:8089 <user>@<this machine>, then open http://localhost:8089/
// Paths from lib/config.js: the live dir (--dir, else config live_dir), the game (al_root), the G of the item tooltips
// (g_data, else the newest cache/G-*.json).
// A run is running, stalled (alive, but no update for 15 s), stopped, failed or done. Alive: its writer (the snapshot's
// proc: pid, start time, cwd) runs on this host; on another host the file's age decides.
// Stop requests go to <id>.ctl beside the snapshot, which the run polls and acks (control.ack). Removing a run moves a
// run's files to the removed/ beside them (live/removed/, live/<folder>/removed/; restore by moving them back); a
// running one is stopped first and moved once it has ended (live/.remove-when-done.json), never hidden.
// Launches (api/launch; registry live/.launches.json, logs in live/logs/): a run of a setup (<id>.setup.json beside its
// snapshot, api/setup/<id>) again from that file: its stored CODE and start states (or the CODE its source gives now:
// current_code), a new duration, seed, account age, warm-up, world age and ping (chronal run <file>; CHRONAL_THREADS_MAX
// sim threads at once, default cores - 4: the rest wait in a queue); its tag says what changed. New runs from no run
// (api/new, dashboard/new.js): the New sim page composes a setup (lib/compose.js: its pulls, CODE sets, the CODE
// library, templates in setups_dir), checks it, saves it or starts it (chronal run per variant and seed); others' CODE
// once its version is trusted. The metrics shown (the headline, the columns) in live/.dash.json.
// Recorded runs (chronal run --record: <id>.rec/, lib/rec.js, listed as w.rec) play in the game's own page, served on
// this port by the viewer (viewer/server.js: /replay/<id>/<name>; POST api/viewer starts its backend), framed by
// a run page's Replay and seeked from its charts (docs/reference/recording.md).
// Icons are the game's own art, read-only from the client (config al_root).
// createDashboard({ dir, appDir, root, host }).handle(req, res): root, the checkout whose chronal.js runs the launches;
// host, a name besides localhost and addresses that may change things (e.g. the one it listens on).
// Runs are parties: 1..N fighters (their sums are the party's numbers) and 0..1 merchant. Snapshots
// (docs/reference/snapshot.md) have the ledgers behind the meters (damage, healing, mana, items, gold), each
// character's conditions and a fixed game-time grid in <id>.grid.ndjson beside the snapshot (the panel's graphs).
const http = require("node:http"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	vm = require("node:vm"),
	net = require("node:net"),
	crypto = require("node:crypto"),
	{ spawn, execFile, execFileSync } = require("node:child_process");
const SETTINGS = require("./settings");
const SCHEDULE = require("../lib/schedule");
const CODE = require("./code");
const APP_TYPES = { ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8", ".txt": "text/plain; charset=utf-8" };
const { recordingsOf, playerAt, logAt } = require("../lib/rec");
const { STATS, GEAR } = require("../sim/live");
const { cfg, config, gData, ROOT } = require("../lib/config");
const SETUP = require("../lib/setup");
const { newRuns } = require("./new");
const { createViewer } = require("../viewer/server");
// a run's process (verified by pid, start time and cwd), its state, its control requests (lib/runs.js: the CLI's too)
const RUNS = require("../lib/runs"),
	{ HOST, RUN_FILE, procStart, identify, alive, stateOf, liveDirs } = RUNS;

const VIEWER_IDLE_MS = 5 * 60e3, // the viewer's backend unused this long: closed
	SIDE = [".json", ".grid.ndjson", ".items.ndjson", ".ctl", ".setup.json", ".rec", ".state"], // a run's files, moved together (.rec: its replay recordings, .state: its state exports; dirs)
	ON = new Set(["running", "stalled"]),
	RANK = { running: 0, stalled: 0, stopped: 1, failed: 1, done: 2 },
	ACTIVE = new Set(["queued", "starting", "running"]);
// the env a launch's process doesn't inherit from the dashboard's (it sets its own)
const OWN_ENV = ["CHRONAL_LIVE_DIR", "CHRONAL_LAUNCH_KEY", "CHRONAL_RERUN_OF", "CHRONAL_NO_BUILD", "NODE_OPTIONS"];
const UNITS = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 };
const CARDS = { hero: "xph", chips: ["dps", "hps", "dtps", "hpotsh", "mpotsh", "killsh"] }; // today's card

const stamp = () => new Date().toISOString().replace(/[-:]|\.\d+/g, ""); // 20260924T224001Z
function readJson(f, def) {
	try {
		return JSON.parse(fs.readFileSync(f, "utf8"));
	} catch (e) {
		return def;
	}
}
function writeJson(f, o) {
	const tmp = f + "." + process.pid + ".tmp";
	fs.writeFileSync(tmp, JSON.stringify(o));
	fs.renameSync(tmp, f);
}
function real(p) {
	try {
		return fs.realpathSync(p);
	} catch (e) {
		return path.resolve(p);
	}
}
// game time: "90s", "30m", "2h", "1d" or a bare number in `unit`, 1 minute to 7 days; null when not
function durationMs(s, unit) {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/.exec(String(s));
	const ms = m ? +m[1] * UNITS[m[2] || unit] : NaN;
	return ms >= 60e3 && ms <= 7 * 86400e3 ? Math.round(ms) : null;
}
const fmtMs = (ms) => (["d", "h", "m"].map((u) => ms % UNITS[u] === 0 && ms / UNITS[u] + u).find(Boolean) || +(ms / 1e3).toFixed(3) + "s");
// a warm-up or world age: game time from 0 to `max` ms ("0", "90s", "2m", "2h", or a number in `unit`); null when not
function spanMs(s, unit, max) {
	const m = /^\s*(\d+(?:\.\d+)?)\s*([smhd]?)\s*$/.exec(String(s));
	const ms = m ? Math.round(+m[1] * UNITS[m[2] || unit]) : NaN;
	return ms >= 0 && ms <= max ? ms : null;
}
const fmtSpan = (ms) => (ms === 0 ? "0m" : fmtMs(ms));
const tagOk = (t) => typeof t === "string" && /^[^-\x00-\x1f\x7f][^\x00-\x1f\x7f]{0,79}$/.test(t);
// " <old>" in a tag becomes " <now>" (a rerun's seed or duration), else " <now>" is added
function retag(t, old, now) {
	const re = old != null && new RegExp(" " + String(old).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "(?= |$)");
	return re && re.test(t) ? t.replace(re, " " + now) : t + " " + now;
}
// a rerun's CODE ("current <hash>[/<hash>...]": each character's) and account age ("age <days>d") in its tag
const CUR_TOK = / (current [0-9a-f]{8}(?:\/[0-9a-f]{8})*)(?= |$)/,
	AGE_TOK = / (age \d+(?:\.\d+)?d)(?= |$)/,
	WORLD_TOK = / (world \d+(?:\.\d+)?[smhd])(?= |$)/, // a new world age ("world 2h")
	PING_TOK = / (ping \d+(?:\.\d+)?)(?= |$)/; // a new ping ("ping 5")
const retok = (t, re, now) => retag(t, (re.exec(t) || [])[1], now);

// git head, plus a hash of the uncommitted diff (as live.js writes versions.sim / versions.code)
const git = (dir, ...a) => new Promise((resolve) => execFile("git", ["-C", dir, ...a], { encoding: "utf8", maxBuffer: 64 << 20 }, (e, out) => resolve(e ? null : out)));
async function gitVersion(dir, paths = []) {
	const head = await (paths.length ? git(dir, "log", "-1", "--format=%h", "HEAD", ...paths) : git(dir, "rev-parse", "--short", "HEAD")),
		diff = head == null ? null : await git(dir, "diff", "HEAD", ...paths);
	return diff == null ? "?" : diff ? head.trim() + "+" + crypto.createHash("sha1").update(diff).digest("hex").slice(0, 6) : head.trim();
}
const simVersion = (dir) => gitVersion(dir, SETUP.SIM_PATHS); // (lib/setup.js simVersion's)
// the last n lines of a log (at most its last 256 KB)
function tail(f, n) {
	let fd;
	try {
		fd = fs.openSync(f, "r");
		const size = fs.fstatSync(fd).size,
			b = Buffer.alloc(Math.min(size, 256 << 10));
		fs.readSync(fd, b, 0, b.length, size - b.length);
		const lines = b.toString("utf8").split("\n");
		if (b.length < size) lines.shift();
		while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
		return lines.slice(-n);
	} catch (e) {
		return null;
	} finally {
		if (fd != null) fs.closeSync(fd);
	}
}
const lastLine = (f) => ((tail(f, 20) || []).reverse().find((l) => l.trim()) || "").trim().slice(0, 500) || null;
function lastJson(f) {
	try {
		return JSON.parse((tail(f, 200) || []).reverse().find((l) => l.startsWith("{")));
	} catch (e) {
		return null;
	}
}
function readBody(req, max, cb) {
	const chunks = [];
	let n = 0;
	req.on("data", (c) => ((n += c.length) <= max && chunks.push(c)))
		.on("end", () => {
			if (n > max) return cb(413);
			const s = Buffer.concat(chunks).toString("utf8").trim();
			try {
				const b = s ? JSON.parse(s) : {};
				cb(b && typeof b === "object" && !Array.isArray(b) ? null : 400, b);
			} catch (e) {
				cb(400);
			}
		})
		.on("error", () => cb(400));
}

// defaults from lib/config.js: dir its live_dir, appDir its al_root; root: the checkout whose chronal.js runs the
// launches (default this one; a test's own)
function createDashboard({ dir, appDir, root = ROOT, host = "localhost", viewerIdleMs = VIEWER_IDLE_MS } = {}) {
	const c = config();
	dir = path.resolve(dir || c.live_dir);
	appDir = appDir || c.al_root;
	root = path.resolve(root);
	const cli = path.join(root, "chronal.js");
	const rwdFile = path.join(dir, ".remove-when-done.json"),
		launchFile = path.join(dir, ".launches.json"),
		settingsFile = path.join(dir, ".dash.json");
	const readSet = (f) => new Set([].concat(readJson(f, [])).filter((x) => typeof x === "string"));
	// recorded runs played in the game's own page (viewer/server.js), on this port
	const viewer = createViewer({ dir: () => dir, appDir, idleMs: viewerIdleMs });

	// a run's files to the removed/ beside them: never a live run's (the callers check); removedOf(id): its path there
	const removedOf = (id) => path.join(path.dirname(path.join(dir, id)), "removed", path.basename(id));
	function moveAway(id) {
		fs.mkdirSync(path.dirname(removedOf(id)), { recursive: true });
		for (const s of SIDE)
			try {
				fs.renameSync(path.join(dir, id + s), removedOf(id) + s);
			} catch (e) {}
	}
	// runs hidden while they ran (.hidden.json, the orphans): shown again, removed once they have ended; no stop request
	try {
		const h = readSet(path.join(dir, ".hidden.json"));
		if (h.size) writeJson(rwdFile, [...new Set([...readSet(rwdFile), ...h])]);
		fs.rmSync(path.join(dir, ".hidden.json"), { force: true });
	} catch (e) {}

	// Launches: { key, of (the run it reruns; null: New sim's), tag, args: { duration, seed, code, age_days, warmup,
	// world_age, ping, record }, state: "queued" | "starting" | "running" | "exited" (its run and its process have ended) |
	// "failed" | "cancelled", need (sim threads), pid, proc (the child: pid, host, start, cwd), log, started, exit (its
	// code or signal; "gone": it ended while this dashboard wasn't its parent), run (the new run's id), reason, cancel,
	// spawn (a queued one's cwd, arguments and env) }. Kept (the last 50 ended ones) in .launches.json.
	const launches = [].concat(readJson(launchFile, [])).filter((l) => l && l.key);
	const children = new Map(); // key -> this dashboard's child process
	function saveLaunches() {
		for (let i; launches.filter((l) => !ACTIVE.has(l.state)).length > 50 && (i = launches.findIndex((l) => !ACTIVE.has(l.state))) >= 0; ) launches.splice(i, 1);
		try {
			writeJson(launchFile, launches);
		} catch (e) {
			console.warn("dashboard: launches:", e.message);
		}
	}
	// the launch that started a run: by the snapshot's launch key
	const linkOf = (w, keys) => (w.launch && w.launch.key && keys.get(w.launch.key)) || null;

	const cache = new Map(); // file -> { mtimeMs, size, w }
	function worlds() {
		// <id>.json, <folder>/<id>.json
		const files = [],
			recs = new Set();
		for (const { sub, dir: d } of liveDirs(dir))
			try {
				const all = fs.readdirSync(d).map((f) => (sub ? sub + "/" : "") + f);
				files.push(...all.filter((f) => RUN_FILE.test(path.basename(f))));
				for (const f of all) if (f.endsWith(".rec")) recs.add(f);
			} catch (e) {}
		const names = new Set(files),
			rwd = readSet(rwdFile),
			keys = new Map(launches.map((l) => [l.key, l])),
			out = [];
		let moved = false,
			linked = false;
		for (const f of files) {
			const id = f.slice(0, -5);
			try {
				const st = fs.statSync(path.join(dir, f));
				let c = cache.get(f);
				if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) cache.set(f, (c = { mtimeMs: st.mtimeMs, size: st.size, w: JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) }));
				const w = c.w;
				w.id = id; // its files are named so
				const L = linkOf(w, keys);
				if (L && !L.run) {
					L.run = id;
					linked = true;
					if (L.cancel) {
						if (ctlOk(w) && w.control.stop && !w.done) request(w, { stop: true });
						else L.reason = "cancelled, but the run takes no stop requests: stop it where it runs";
						L.state = "cancelled";
					} else if (L.state === "starting") L.state = "running";
				}
				const a = w.done ? null : alive(w.proc);
				w.state = stateOf(w, a);
				if (rwd.has(id) && !ON.has(w.state)) {
					(moveAway(id), rwd.delete(id), cache.delete(f), names.delete(f), (moved = true));
					continue;
				}
				w.ctl = ctlOf(w, a, rwd.has(id));
				w.rec = recs.has(id + ".rec") ? recordingsOf(dir, id) : []; // its replay recordings: the characters (rec.js)
				out.push(w);
			} catch (e) {}
		}
		for (const f of cache.keys()) if (!names.has(f)) cache.delete(f);
		for (const id of rwd) if (!names.has(id + ".json")) (rwd.delete(id), (moved = true));
		if (moved)
			try {
				writeJson(rwdFile, [...rwd]);
			} catch (e) {}
		if (linked) saveLaunches();
		return out.sort((a, b) => RANK[a.state] - RANK[b.state] || Date.parse(b.started) - Date.parse(a.started));
	}
	// What the page may do with a run (sent as w.ctl, not stored): stop (a control-file request), force (signal its
	// verified process), rerun (or why not: rerun_why), pending (a request not acked yet), remove_when_done;
	// rerun_setup: a run of a setup, what its rerun starts from ({ code: "stored", age_days: its accounts' age, null
	// when they differ }); recorded: the warm-up, world age and ping a rerun keeps unless given others (recordedOf)
	function ctlOf(w, a, rwd) {
		const on = ON.has(w.state),
			k = ctlOk(w) ? w.control : {},
			r = rerunOf(w),
			sd = r.side ? { file: r.setup, s: r.side } : null;
		return {
			alive: a,
			stop: !!(on && k.stop),
			force: on && a === true,
			rerun: !r.why,
			rerun_why: r.why,
			rerun_setup: sd ? { code: "stored", age_days: ageOf(sd.s) } : null,
			recorded: sd ? recordedOf(sd.s) : null,
			pending: on && k.file ? pendingOf(w) : null,
			remove_when_done: rwd,
		};
	}
	function remove(id, stop) {
		const w = worlds().find((x) => x.id === id);
		if (!w) return [404, { reason: `no run ${id}` }];
		if (!ON.has(w.state)) return (moveAway(id), [200, { removed: id }]);
		// a running one: stopped, and moved once it has ended; never hidden
		const rwd = readSet(rwdFile);
		if (stop && w.ctl.stop) request(w, { stop: true });
		else if (!rwd.has(id)) return [409, { reason: "running", can_stop: w.ctl.stop }];
		rwd.add(id);
		writeJson(rwdFile, [...rwd]);
		return [202, { stopping: id }];
	}

	// Requests to a run: <id>.ctl { seq, stop?, at }, written whole (tmp + rename); the run polls it and acks
	// (control.ack = seq). A request not acked yet is kept in the next one.
	const ctlOk = (w) => !!(w.control && typeof w.control.file === "string" && path.basename(w.control.file) === path.basename(w.id) + ".ctl");
	const ctlPath = (id) => path.join(dir, id + ".ctl");
	function pendingOf(w) {
		const q = readJson(ctlPath(w.id), null);
		return q && q.seq > (+w.control.ack || 0) ? { seq: q.seq, stop: !!q.stop, at: q.at ?? null } : null;
	}
	const request = (w, patch) => RUNS.ctlRequest(ctlPath(w.id), +w.control.ack || 0, patch);
	function stopRun(id, force) {
		const w = worlds().find((x) => x.id === id);
		if (!w) return [404, { reason: `no run ${id}` }];
		if (!ON.has(w.state)) return [409, { reason: `not running (${w.state})` }];
		if (!force) {
			if (!w.ctl.stop) return [409, { reason: "this run takes no stop requests (no control file): stop it where it runs" }];
			return [202, { seq: request(w, { stop: true }).seq }];
		}
		// force: a signal, only to the very process (pid, start time, cwd) that writes this run
		const p = w.proc;
		if (!w.ctl.force || identify(p) !== true) return [403, { reason: "can't verify its process on this host (pid, start time, cwd)" }];
		process.kill(p.pid, "SIGKILL");
		return [200, { signal: "SIGKILL" }];
	}

	// an export of a running run's state now (sim/export.js: <id>.state/<label>/), taken at its next chunk
	function exportRun(id, label) {
		const w = worlds().find((x) => x.id === id);
		if (!w) return [404, { reason: `no run ${id}` }];
		if (!ON.has(w.state)) return [409, { reason: `not running (${w.state})` }];
		if (!w.ctl.stop) return [409, { reason: "this run takes no requests (no control file)" }];
		const name = String(label || "").replace(/[^\w.-]+/g, "_").slice(0, 60) || "at-" + new Date().toISOString().slice(0, 19).replace(/[-:]/g, "");
		return [202, { seq: request(w, { export: name }).seq, label: name }];
	}

	// what a rerun starts from unless told otherwise: its setup file's warm-up, world age and ping
	function recordedOf(s) {
		return { warmup_ms: SETUP.parseDuration(s.run.warmup) || 0, age_ms: SETUP.parseDuration(s.world.age) || 0, ping: s.world.ping };
	}
	// A run's resolved setup (<id>.setup.json beside its snapshot), in the live dir or removed/; parsed once per change of
	// the file. null: none, or not a setup file
	const sides = new Map(); // file -> { mtimeMs, size, s }
	function sideOf(id, dirs = [dir]) {
		for (const d of dirs) {
			const f = path.join(d, id + ".setup.json");
			let st;
			try {
				st = fs.statSync(f);
			} catch (e) {
				continue;
			}
			let c = sides.get(f);
			if (!c || c.mtimeMs !== st.mtimeMs || c.size !== st.size) {
				if (sides.size > 500) sides.clear();
				sides.set(f, (c = { mtimeMs: st.mtimeMs, size: st.size, s: readJson(f, null) }));
			}
			const s = c.s;
			return s && s.format === SETUP.FORMAT && Array.isArray(s.characters) && s.characters.every((x) => x && typeof x.name === "string" && x.code) ? { file: f, s } : null;
		}
		return null;
	}
	// its accounts' age in days: the one they share, else null (each as recorded)
	const agesOf = (s) => Object.values(s.accounts || {}).map((a) => (a && a.age_days) || 0);
	const ageOf = (s) => {
		const a = agesOf(s);
		return a.length && a.every((x) => x === a[0]) ? a[0] : null;
	};
	// sim threads: one per character plus the server's (a setup's world.threads false: one), over this host's live runs
	// and starting launches
	const need = (w) => {
		const sd = w.setup && sideOf(w.id);
		if (sd) return sd.s.world && sd.s.world.threads === false ? 1 : sd.s.characters.length + 1;
		return Math.max(1, (w.roster || w.players || []).length) + 1;
	};
	function threads(ws) {
		const busy = ws.filter((w) => ON.has(w.state) && (!w.proc || w.proc.host === HOST)).reduce((s, w) => s + need(w), 0) + launches.filter((l) => l.state === "starting").reduce((s, l) => s + (l.need || 1), 0);
		return { threads_busy: busy, threads_max: Math.max(1, Number(process.env.CHRONAL_THREADS_MAX) || os.cpus().length - 4) };
	}

	// Whether a run can run again (chronal run with its setup file, from any checkout: the file holds everything: stored
	// CODE, states, accounts), else why not
	function rerunOf(w) {
		if (!w.setup) return { why: "not a run of a setup: nothing to run it again from" };
		const sd = sideOf(w.id);
		if (!sd) return { why: `no setup file ${w.id}.setup.json beside the snapshot` };
		return { why: null, setup: sd.file, side: sd.s };
	}

	// POST api/launch { of, duration, seed?, tag?, current_code?, code_set?, age_days?, warmup?, world_age?, ping?, record?,
	// dry? }: dry, the plan and its warnings; else the launch, started (202), or queued past the free sim threads. A run
	// launches from its setup file (chronal run <file>): its stored CODE (current_code: the CODE its source gives now,
	// build hook included; code_set: a CODE set's, e.g. a new version of the one it ran; the stored never builds) and
	// each account's recorded age (age_days: every account's, 0 = a new account). warmup, world_age: game time ("2m",
	// "2h", minutes; the recorded one passes nothing); ping: the round trip in ms. The plan's world: what the launch runs
	// with. record: replay recordings of the run's characters (<id>.rec/ beside its snapshot, chronal run --record); an
	// identical run then still says so, but it is what a recording of a run needs.
	async function launch(b) {
		const dry = !!b.dry,
			ws = worlds(),
			w = typeof b.of === "string" && ws.find((x) => x.id === b.of);
		if (!w) return [404, { reason: `no run ${b.of}` }];
		const r = rerunOf(w);
		if (r.why) return [400, { reason: r.why }];
		if (b.tag != null && b.tag !== "" && !tagOk(b.tag)) return [400, { reason: "tag: 1-80 characters, not starting with -" }];
		if (b.record != null && typeof b.record !== "boolean") return [400, { reason: "record: true or false" }];
		const record = b.record === true;
		const given = (v) => v != null && v !== "",
			key = "l-" + stamp() + "-" + crypto.randomBytes(2).toString("hex"),
			warnings = [];
		const L = { key, of: w.id, tag: null, args: {}, state: "starting", pid: null, proc: null, log: null, started: Date.now(), exit: null, run: null, reason: null, cancel: false };
		// its setup file, the stored CODE or the current one, an account age
		const sd = { file: r.setup, s: r.side },
			set = given(b.code_set) ? b.code_set : null,
			cur = b.current_code === true || set != null;
		if (b.current_code != null && typeof b.current_code !== "boolean") return [400, { reason: "current_code: true or false" }];
		if (set != null && (typeof set !== "string" || set.length > 400 || /^-|[\0\n]/.test(set))) return [400, { reason: "code_set: a CODE set's name (name, name@rev, dir:<path>)" }];
		if (set != null && b.current_code === true) return [400, { reason: "current_code or code_set, not both" }];
		let age = null;
		if (given(b.age_days)) {
			// days, fractions too
			age = typeof b.age_days === "number" || (typeof b.age_days === "string" && /^\d+(?:\.\d+)?$/.test(b.age_days)) ? Number(b.age_days) : NaN;
			if (!(age >= 0 && age <= 3650)) return [400, { reason: "age_days: a number of days from 0 (a new account) to 3650" }];
		}
		const aged = age != null && agesOf(sd.s).some((a) => a !== age),
			stored = SETUP.codeHash(sd.s),
			setupArgs = [...(set != null ? ["--code-set", set] : cur ? ["--current-code"] : []), ...(aged ? ["--age-days", String(age)] : [])];
		// the world knobs: a warm-up, world age or ping other than the recorded one (recordedOf)
		const rec = recordedOf(sd.s);
		let warm = null,
			wage = null,
			ping = null;
		if (given(b.warmup) && (warm = spanMs(b.warmup, "m", 86400e3)) == null) return [400, { reason: `warmup "${b.warmup}": 0 to 1 day of game time, e.g. 90s, 2m, 1h, or a number of minutes` }];
		if (given(b.world_age) && (wage = spanMs(b.world_age, "m", 7 * 86400e3)) == null) return [400, { reason: `world_age "${b.world_age}": 0 to 7 days of game time, e.g. 30m, 2h, 1d, or a number of minutes` }];
		if (given(b.ping) && !((ping = Number(b.ping)) > 0 && ping <= 1000)) return [400, { reason: `ping "${b.ping}": a round trip in ms, above 0 and at most 1000` }];
		// the world's clock: another start (an ISO time with its zone)
		const start0 = (sd.s.world && sd.s.world.start) || SCHEDULE.DEFAULT_START,
			start = given(b.start) ? String(b.start) : null;
		if (start != null && !Number.isFinite(Date.parse(start))) return [400, { reason: `start "${b.start}": a time with its zone, e.g. 2026-10-31T18:00Z` }];
		const startCh = start != null && Date.parse(start) !== Date.parse(start0);
		const warmCh = warm != null && warm !== rec.warmup_ms,
			ageCh = wage != null && wage !== rec.age_ms,
			pingCh = ping != null && ping !== rec.ping;
		const worldArgs = [...(warmCh ? ["--warmup", fmtSpan(warm)] : []), ...(ageCh ? ["--world-age", fmtSpan(wage)] : []), ...(pingCh ? ["--ping", String(ping)] : []), ...(startCh ? ["--start", start] : [])],
			worldPlan = { warmup_ms: warmCh ? warm : rec.warmup_ms, age_ms: ageCh ? wage : rec.age_ms, ping: pingCh ? ping : rec.ping, start: startCh ? start : start0 },
			worldTag = (tag) => ((tag = ageCh ? retok(tag, WORLD_TOK, "world " + fmtSpan(wage)) : tag), pingCh ? retok(tag, PING_TOK, "ping " + ping) : tag);
		const worldWarn = () => [
			...(warmCh ? [`warm-up ${fmtSpan(warm)} (the original: ${fmtSpan(rec.warmup_ms)})`] : []),
			...(pingCh ? [`ping ${ping} ms: the round trip to the server (the original: ${rec.ping} ms)`] : []),
			...(startCh ? [`the world's clock starts at ${start} (the original: ${start0})`] : []),
			...(ageCh ? [wage ? `world age ${fmtSpan(wage)}: the world runs ${fmtSpan(wage)} of game time with no characters before they log in, its monsters levelling up (the original: ${fmtSpan(rec.age_ms)})` : `world age 0: the characters log in at once (the original: ${fmtSpan(rec.age_ms)})`] : []),
		];
		// each character's CODE, as the Setup fold shows it: { name, stored, hash: the launch's (null: not resolved) },
		// given the current CODE's hash by name (chronal run --check's)
		const perChar = (hashOf) => sd.s.characters.map((c) => ({ name: c.name, stored: c.code.hash, hash: cur ? (hashOf && hashOf(c.name)) || null : c.code.hash }));
		const checked = (res) => (res && res.ok ? (n) => ((res.characters || []).find((c) => c.name === n) || {}).code_hash : null);
		// the plan's setup block (code_hash: the run's, versions.code_hash) and its warnings
		const setupPlan = (cs) => ({ file: sd.file, code: set != null ? "set " + set : cur ? "current" : "stored", code_hash: cs.every((c) => c.hash) ? SETUP.codeHash({ characters: cs.map((c) => ({ name: c.name, code: { hash: c.hash } })) }) : null, code_hash_stored: stored, age_days: age ?? ageOf(sd.s), characters: cs });
		const setupWarn = (cs) => {
			const was = ageOf(sd.s),
				changed = cs.filter((c) => c.hash !== c.stored).map((c) => c.name);
			return [
				!cur ? "the stored CODE (the original's)" : !cs.every((c) => c.hash) ? (set != null ? `CODE set ${set}: not resolved` : "current CODE: not resolved") : (set != null ? `CODE set ${set}: ` : "current CODE: ") + (changed.length ? `differs from the stored (${changed.join(", ")})` : "the same as the stored"),
				...(aged ? [`account age ${age} days (the original: ${was != null ? was + " days" : Object.entries(sd.s.accounts).map(([k, a]) => k + " " + (a.age_days || 0)).join(", ")})`] : []),
			];
		};
		// the tag of a rerun of a setup: the current CODE's hashes when they differ from the stored, a new account age
		const setupTag = (tag, cs) => {
			if (cur && cs.every((c) => c.hash) && cs.some((c) => c.hash !== c.stored)) tag = retok(tag, CUR_TOK, "current " + cs.map((c) => c.hash).join("/"));
			return aged ? retok(tag, AGE_TOK, `age ${age}d`) : tag;
		};

		const run0 = sd.s.run || {},
			v = w.versions || {};
		let dur = null;
		if (given(b.duration) && (dur = durationMs(b.duration, "m")) == null) return [400, { reason: `duration "${b.duration}": 1 minute to 7 days of game time, e.g. 90s, 30m, 2h, 1d, or a number of minutes` }];
		const seed0 = Number(run0.seed ?? 1),
			seed = given(b.seed) ? Number(b.seed) : seed0;
		if (!Number.isInteger(seed) || seed < 1 || seed > 2 ** 31 - 1) return [400, { reason: "seed: a whole number from 1" }];
		const dur0 = SETUP.parseDuration(run0.duration),
			ms = dur ?? dur0;
		const args = [cli, "run", sd.file, ...(ms != null ? ["--duration", fmtMs(ms)] : []), "--seed", String(seed), ...worldArgs, ...setupArgs, ...(record ? ["--record"] : [])],
			n = need(w);
		Object.assign(L, { args: { duration: ms != null ? fmtMs(ms) : null, seed, code: set != null ? "set " + set : cur ? "current" : "stored", age_days: aged ? age : null, warmup: warmCh ? fmtSpan(warm) : null, world_age: ageCh ? fmtSpan(wage) : null, ping: pingCh ? ping : null, start: startCh ? start : null, ...(record ? { record } : {}) }, need: n, log: path.join(dir, "logs", key + ".log") });
		// chronal run --check: the same arguments resolved (the current CODE built), nothing run: the plan, and the current
		// CODE's hashes for the tag; then the threads busy (after it: other launches may have started meanwhile)
		const [res, sim] = await Promise.all([dry || cur ? check(args.slice(2)) : null, dry ? simVersion(root) : null]),
			cs = perChar(checked(res)),
			t = threads(res ? worlds() : ws);
		if (dry) warnings.push(...queueWarn(t, n));
		let tag = w.tag || w.id;
		if (seed !== seed0) tag = retag(tag, "s" + seed0, "s" + seed);
		if (dur != null && dur !== dur0) tag = retag(tag, dur0 != null ? fmtMs(dur0) : null, fmtMs(dur));
		tag = L.tag = given(b.tag) ? b.tag : worldTag(setupTag(tag, cs)).slice(0, 80);
		if (dry) {
			if (!res.ok) warnings.push("can't run: " + [].concat(res.problems || res.reason || "no answer").join("; "));
			warnings.push(...setupWarn(cs), ...worldWarn());
			if (v.sim && sim !== "?" && v.sim !== sim) warnings.push(`the sim: the original ran ${v.sim}, ${root} is now ${sim}`);
			// identical only to a run that ran its whole duration, with its stored CODE, age and this sim
			const complete = !!w.done && (!w.end || w.end.reason === "complete"),
				f = (x) => +(x / 60e3).toFixed(1);
			if (!complete && dur0 && ms === dur0) warnings.push(`the original ${ON.has(w.state) ? "is still running" : w.end && w.end.reason === "stopped" ? "was stopped early" : "did not finish"} at ${f(w.measured_ms || 0)} of ${f(dur0)} game min: the rerun runs the full ${f(dur0)} game min`);
			if (complete && seed === seed0 && ms === dur0 && !cur && !aged && !warmCh && !ageCh && !pingCh && !startCh && v.sim === sim) warnings.push("same seed, stored CODE and duration: an identical run (deterministic)");
			return [200, { plan: { tag, ok: !!res.ok, command: ["chronal", ...args.slice(1)], cwd: root, need: n, ...t, setup: setupPlan(cs), world: worldPlan, ...(record ? { record } : {}), warnings } }];
		}
		startSim(L, root, [...args, "--tag", tag], { CHRONAL_LIVE_DIR: dir, CHRONAL_LAUNCH_KEY: key, CHRONAL_RERUN_OF: w.id });
		return (launches.push(L), saveLaunches(), [202, { launch: L }]);
	}
	const lastJsonOf = (out) => {
		try {
			return JSON.parse(String(out || "").trim().split("\n").reverse().find((l) => l.startsWith("{")));
		} catch (e) {
			return null;
		}
	};
	function baseEnv() {
		const e = { ...process.env };
		for (const k of OWN_ENV) delete e[k];
		return e;
	}
	// chronal run <setup file> [args] --check: validates and resolves it (the current CODE: built), runs nothing; its
	// JSON line ({ ok, code_hash, code_hash_stored?, problems? })
	const check = (args) =>
		new Promise((resolve) => execFile(process.execPath, [cli, "run", ...args, "--check"], { cwd: root, env: baseEnv(), timeout: 120e3, maxBuffer: 16 << 20 }, (e, out, err) => resolve(lastJsonOf(out) || { ok: false, problems: [String(err || "").trim().split("\n").pop() || (e && e.message) || "no answer"] })));
	// node <args> in cwd, detached (it outlives the dashboard), stdout and stderr to the launch's log
	function start(L, cwd, args, env) {
		fs.mkdirSync(path.dirname(L.log), { recursive: true });
		const fd = fs.openSync(L.log, "a");
		let child;
		try {
			child = spawn(process.execPath, args, { cwd, env, detached: true, stdio: ["ignore", fd, fd] });
		} finally {
			fs.closeSync(fd);
		}
		child.on("error", (e) => L.exit == null && ((L.exit = -1), (L.reason = e.message)));
		if (!child.pid) return fail(L, `could not start ${args[0]}`);
		L.pid = child.pid;
		L.proc = { pid: child.pid, host: HOST, start: procStart(child.pid), cwd: real(cwd) };
		L.exit = L.ended = null;
		children.set(L.key, child);
		child.on("exit", (code, sig) => {
			children.delete(L.key);
			(L.exit = code ?? sig), (L.ended = Date.now());
			saveLaunches();
		});
		child.unref();
	}
	const fail = (L, reason) => ((L.state = "failed"), (L.reason = String(reason).slice(0, 500)));
	// A launch starts when its threads are free and none queued is ahead of it; else it waits its turn (state "queued";
	// L.spawn: its cwd, arguments and env past the dashboard's own), started in order by the tick as threads free up
	// (after a restart of the dashboard too: .launches.json keeps it). A cancel drops it.
	// (one that needs more threads than the host has starts when none are busy)
	const fits = (t, n) => t.threads_busy + n <= t.threads_max || !t.threads_busy;
	function startSim(L, cwd, args, env) {
		if (!launches.some((l) => l.state === "queued") && fits(threads(worlds()), L.need || 1)) return start(L, cwd, args, { ...baseEnv(), ...env });
		(L.state = "queued"), (L.spawn = { cwd, args, env });
	}
	function unqueue(ws) {
		const t = threads(ws);
		for (const L of launches.filter((l) => l.state === "queued")) {
			if (!fits(t, L.need || 1)) break;
			t.threads_busy += L.need || 1;
			const s = L.spawn;
			delete L.spawn;
			(L.state = "starting"), (L.started = Date.now());
			start(L, s.cwd, s.args, { ...baseEnv(), ...s.env });
		}
	}
	// a dry run's: whether it would wait, behind how many
	const queueWarn = (t, n) => { const q = launches.filter((l) => l.state === "queued").length; return q || !fits(t, n) ? [`CPU: ${t.threads_busy} of ${t.threads_max} sim threads busy${q ? `, ${q} queued` : ""}; this run needs ${n}: it waits in the queue`] : []; };
	// every second while a launch is under way: link new runs (worlds()), start what waited, notice what failed
	function tick() {
		if (!launches.some((l) => ACTIVE.has(l.state))) return;
		const ws = worlds(),
			before = JSON.stringify(launches);
		unqueue(ws);
		for (const L of launches) {
			const w = L.run && ws.find((x) => x.id === L.run);
			if (L.state === "starting" && (L.exit != null || (!children.has(L.key) && alive(L.proc) === false))) {
				// its process has ended and no run showed up
				if (L.exit == null) (L.exit = "gone"), (L.ended = Date.now());
				fail(L, lastLine(L.log) || `exited (${L.exit}) before its run showed up`);
			} else if (L.state === "running" && (!w || !ON.has(w.state))) {
				// its run has ended; the launch once its process has too: its exit code, "gone" when it ended out of this
				// dashboard's sight
				if (L.exit == null && !children.has(L.key) && alive(L.proc) !== true) (L.exit = "gone"), (L.ended = Date.now());
				if (L.exit != null) L.state = "exited";
			}
		}
		if (JSON.stringify(launches) !== before) saveLaunches();
	}
	const timer = setInterval(tick, 1000);
	timer.unref();
	// POST api/viewer (a run page's Replay, before it frames a replay): the viewer's backend started; 202 while it starts
	function viewerUse() {
		if (viewer.up()) return [200, { up: true }];
		viewer.start().catch(() => {});
		return [202, { up: false, starting: true }];
	}
	// DELETE api/launch/<key>: before its run shows up, the launch stops (SIGTERM to its verified process); an ended
	// launch is dropped from the list
	function cancel(key) {
		const L = launches.find((l) => l.key === key);
		if (!L) return [404, { reason: `no launch ${key}` }];
		if (L.state === "running") return [409, { reason: "already running: stop its run" }];
		if (!ACTIVE.has(L.state)) return (launches.splice(launches.indexOf(L), 1), saveLaunches(), [200, { launch: L, dismissed: true }]);
		if (L.state === "queued") (L.state = "cancelled"), delete L.spawn;
		else if (identify(L.proc) === true) (process.kill(L.proc.pid, "SIGTERM"), (L.state = "cancelled"));
		else L.cancel = true;
		saveLaunches();
		return [200, { launch: L }];
	}
	// a launch's log: its run's own (proc.log) once it has one, else the launch's; only these paths, never a requested one
	function launchLog(key, n) {
		const L = launches.find((l) => l.key === key);
		if (!L) return [404, { reason: `no launch ${key}` }];
		const w = L.run && worlds().find((x) => x.id === L.run),
			own = w && w.proc && typeof w.proc.log === "string" && /\.log$/.test(w.proc.log) && fs.existsSync(w.proc.log) && fs.statSync(w.proc.log).isFile() ? w.proc.log : null,
			f = own || L.log,
			lines = f && tail(f, Math.min(200, Math.max(1, n || 60)));
		return lines ? [200, { path: f, lines }] : [404, { reason: `no log yet${f ? " at " + f : ""}` }];
	}
	function controlInfo() {
		const ws = worlds();
		return { viewer: { up: viewer.up() }, sims: threads(ws), launches: [...launches].reverse() };
	}

	// the metrics' settings (the headline, the columns) and the Data tab's panels for every page on this live dir
	const okId = (s) => typeof s === "string" && /^[a-z0-9_]{1,24}$/.test(s);
	function cardsOf(c) {
		if (!c || typeof c !== "object" || !okId(c.hero) || !Array.isArray(c.chips)) return null;
		const chips = [...new Set(c.chips)];
		return chips.length <= 6 && chips.every(okId) ? { hero: c.hero, chips } : null;
	}
	// the panels: { cols (1-4), panels: [{ id, m (a metric), view, by?, col (its column) }] }, 12 at most
	function dataOf(d) {
		if (!d || typeof d !== "object" || !Number.isInteger(d.cols) || d.cols < 1 || d.cols > 4 || !Array.isArray(d.panels) || d.panels.length > 12) return null;
		const ok = (p) => p && typeof p === "object" && /^[a-z0-9]{1,12}$/.test(p.id) && okId(p.m) && ["meters", "by", "time"].includes(p.view) && (p.by == null || /^[a-z]{1,16}$/.test(p.by)) && Number.isInteger(p.col) && p.col >= 0 && p.col < d.cols;
		return d.panels.every(ok) && new Set(d.panels.map((p) => p.id)).size === d.panels.length ? { cols: d.cols, panels: d.panels.map((p) => ({ id: p.id, m: p.m, view: p.view, ...(p.by != null ? { by: p.by } : {}), col: p.col })) } : null;
	}
	function settings() {
		let rev = 0;
		try {
			rev = fs.statSync(settingsFile).mtimeMs;
		} catch (e) {}
		const f = readJson(settingsFile, {}) || {};
		return { v: 1, cards: cardsOf(f.cards) || CARDS, data: dataOf(f.data), rev };
	}
	// either or both: the cards, the panels (the other kept)
	function putSettings(b) {
		if (b.cards === undefined && b.data === undefined) return [400, { reason: "cards, data or both" }];
		const cards = b.cards !== undefined ? cardsOf(b.cards) : settings().cards, data = b.data !== undefined ? dataOf(b.data) : settings().data;
		if (!cards) return [400, { reason: "cards: { hero, chips (at most 6) }, ids of 1-24 characters a-z 0-9 _" }];
		if (b.data !== undefined && !data) return [400, { reason: "data: { cols (1-4), panels: at most 12 { id (a-z 0-9, 1-12), m (a metric id), view (meters, by or time), by?, col (0 to cols - 1) }, ids distinct }" }];
		writeJson(settingsFile, { v: 1, cards, ...(data ? { data } : {}) });
		return [200, settings()];
	}

	// A run's fixed game-time grid (<id>.grid.ndjson: a header line, then one line per instant), read from byte `from`
	// on: whole lines only, at most 2 MB per answer (more: ask again from next). A rewritten file (the producer thins it
	// and bumps grid.gen) or a shorter one starts over at 0 (reset).
	// A run's items' events (<id>.items.ndjson, only appended to) the same way, with no generations.
	function gridRead(id, from, gen, kind = "grid") {
		const w = worlds().find((x) => x.id === id);
		if (!w) return [404, { reason: `no run ${id}` }];
		const cur = kind === "grid" ? (w.grid && w.grid.gen) || 0 : 0, f = path.join(dir, id + "." + kind + ".ndjson");
		if (kind !== "grid") gen = 0;
		let fd;
		try {
			fd = fs.openSync(f, "r");
		} catch (e) {
			return [404, { reason: `no ${kind} file for ${id}` }];
		}
		try {
			const size = fs.fstatSync(fd).size, reset = String(gen) !== String(cur) || !(from >= 0) || from > size;
			if (reset) from = 0;
			const b = Buffer.alloc(Math.min(size - from, 2 << 20)), n = fs.readSync(fd, b, 0, b.length, from), end = b.lastIndexOf(10, n - 1) + 1;
			return [200, { gen: cur, from, next: from + end, more: from + end < size && end > 0, reset, text: b.toString("utf8", 0, end) }];
		} finally {
			fs.closeSync(fd);
		}
	}

	// Game art by name as [file, x, y, w, h] in the images served at art/<file>.png: every item's icon (via its skin), a
	// few other icons (Lone Wolf, the skill bar's), every skill's and condition's icon by its name (skills), the standing
	// frame of every monster and the gravestone. Read once from the client's design files; without them, no icons.
	const APP = path.resolve(appDir);
	const art = { files: [], items: {}, skills: {}, monsters: {}, kind: {}, levels: {}, cnames: {} },
		artPaths = [];
	try {
		const ctx = vm.createContext({});
		for (const f of ["sprites", "dimensions", "multipliers", "items", "monsters"]) vm.runInContext(fs.readFileSync(path.join(APP, "design", f + ".js"), "utf8"), ctx);
		try {
			for (const f of ["conditions", "skills", "levels", "npcs"]) vm.runInContext(fs.readFileSync(path.join(APP, "design", f + ".js"), "utf8"), ctx);
		} catch (e) {}
		const { imagesets, sprites, positions, items, monsters } = vm.runInContext("({ imagesets, sprites, positions, items, monsters })", ctx),
			named = vm.runInContext("({ skills: typeof skills == 'object' ? skills : {}, conditions: typeof conditions == 'object' ? conditions : {}, levels: typeof levels == 'object' ? levels : {}, npcs: typeof npcs == 'object' ? npcs : {} })", ctx);
		art.levels = named.levels; // xp per level: the level progress graph
		const file = (url) => {
			const p = path.join(APP, url.split("?")[0]);
			let i = artPaths.indexOf(p);
			if (i < 0)
				try {
					const b = Buffer.alloc(24),
						fd = fs.openSync(p, "r");
					(fs.readSync(fd, b, 0, 24, 0), fs.closeSync(fd));
					art.files.push([b.readUInt32BE(16), b.readUInt32BE(20)]); // PNG width, height
					i = artPaths.push(p) - 1;
				} catch (e) {}
			return i;
		};
		for (const [name, d] of Object.entries(items)) if (d.upgrade || d.compound) art.kind[name] = d.compound ? "c" : "u";
		const at = (skin) => {
			const p = positions[skin],
				set = Array.isArray(p) && imagesets[p[0] || "pack_20"],
				f = set ? file(set.file) : -1;
			return f >= 0 ? [f, p[1] * set.size, p[2] * set.size, set.size, set.size] : null;
		};
		const OTHER = ["gold", "encouragement_lonewolf", "citizens", "travel", "inventory", "condition_good", "condition_bad", "quest_monsterhunt", "stats", "schedule_clock"];
		for (const name of [...Object.keys(items), ...OTHER, ...Object.keys(positions).filter((k) => /^shade/.test(k))]) {
			const a = at((items[name] && items[name].skin) || name);
			if (a) art.items[name] = a;
		}
		for (const src of [named.conditions, named.skills]) for (const [name, d] of Object.entries(src)) if (d && d.skin && at(d.skin)) art.skills[name] = at(d.skin);
		for (const [name, d] of Object.entries(named.conditions)) if (d && typeof d.name === "string") art.cnames[name] = d.name; // the lanes' names
		// the citizens with an aura, Kane and Angel, by name (their skins are on character sheets)
		const npc = Object.fromEntries(["citizen0", "citizen4"].filter((k) => named.npcs[k]).map((k) => [named.npcs[k].skin, named.npcs[k].name]));
		for (const s of Object.values(sprites)) {
			const one = s.type === "gravestone"; // one frame per cell; a monster's cell is 3 frames x 4 directions
			if (s.skip || !s.matrix || !(one || (!s.type && (s.file.includes("/monsters/") || s.matrix.some((r) => r.some((n) => npc[n])))))) continue;
			const f = file(s.file);
			if (f < 0) continue;
			const cw = art.files[f][0] / s.columns,
				ch = art.files[f][1] / s.rows,
				w = one ? cw : cw / 3;
			s.matrix.forEach((row, i) => row.forEach((name, j) => name && (s.file.includes("/monsters/") || one || npc[name]) && (art.monsters[npc[name] || name] = [f, j * cw + (one ? 0 : w), i * ch, w, one ? ch : ch / 4])));
		}
		for (const [name, m] of Object.entries(monsters)) if (m.skin && art.monsters[m.skin]) art.monsters[name] = art.monsters[m.skin];
	} catch (e) {
		console.warn("dashboard: no game icons (" + e.message + ")");
	}

	// The game's own item tooltip: render_item() from the client's html.js, run here on the client's files (G, the common
	// functions, the phrases with the English strings). Built on first use; answers are cached. Its onclick handlers are
	// dropped: the game's UI isn't on this page; its images point to images/ next to the page. G: config's g_data (a
	// *.json G or a "var G = {...}" script), else the newest cache/G-<version>.json; none: no tooltips.
	const G_DATA = gData(c);
	let tipCtx = null;
	const tipCache = new Map();
	function tipContext() {
		if (!tipCtx) {
			const chain = new Proxy(function () {}, { get: (t, k) => (k === Symbol.toPrimitive ? () => "" : chain), apply: () => chain });
			const ctx = { console: { log() {}, warn() {}, error() {} }, $: () => chain, jQuery: chain, navigator: { userAgent: "" }, location: { href: "", search: "" },
				document: { createElement: () => ({ style: {}, getContext: () => null }), getElementById: () => null, querySelector: () => null, addEventListener() {} },
				localStorage: { getItem: () => null, setItem() {} }, setTimeout() {}, clearTimeout() {}, setInterval() {}, clearInterval() {},
				character: 0 }; // no character here (falsy), yet render_item reads it bare: a cash price, a stand
			ctx.window = ctx.self = ctx;
			vm.createContext(ctx);
			const g = fs.readFileSync(G_DATA, "utf8");
			if (/\.json$/i.test(G_DATA)) (ctx.__g = g), vm.runInContext("this.G = JSON.parse(__g); delete this.__g", ctx);
			else vm.runInContext(g + ";this.G=G", ctx);
			for (const f of ["js/old_common_functions.js", "js/phrases.js", "js/html.js"]) vm.runInContext(fs.readFileSync(path.join(APP, f), "utf8"), ctx, { filename: f });
			const en = {};
			for (const f of fs.readdirSync(path.join(APP, "languages/en"))) if (f.endsWith(".js")) Object.assign(en, require(path.join(APP, "languages/en", f)));
			ctx.phrase.load("en", en);
			tipCtx = ctx;
		}
		return tipCtx;
	}
	const clean = (html) => html.replace(/\son[a-z]+=("[^"]*"|'[^']*')/gi, "").replace(/class='clickable'/g, "").replace(/(src=['"])\/images\//g, "$1images/");
	function itemTip(name, level, stat) {
		if (!G_DATA) return null;
		tipContext();
		if (!tipCtx.G.items[name]) return null;
		const key = name + "|" + level + "|" + stat;
		if (!tipCache.has(key)) {
			tipCtx.__tip = { name, level, ...(stat ? { stat_type: stat } : {}) };
			const html = vm.runInContext("render_item('html', { item: G.items[__tip.name], actual: __tip })", tipCtx);
			tipCache.set(key, clean(html));
		}
		return tipCache.get(key);
	}
	// A condition's tooltip as the game shows it on a click (render_condition(): G.conditions' definition, its English
	// name and explanation, through render_item()), without a target (no time left)
	function conditionTip(name) {
		if (!G_DATA) return null;
		tipContext();
		if (!tipCtx.G.conditions || !tipCtx.G.conditions[name]) return null;
		const key = "c|" + name;
		if (!tipCache.has(key)) {
			tipCtx.__tip = name;
			const html = vm.runInContext("(function (n) { var d = G.conditions[n]; d = Object.assign({}, d, { name: phrase.definition('condition', n, 'name', d.name), explanation: phrase.definition('condition', n, 'explanation', d.explanation) }); return render_item('html', { skin: d.skin, item: d, prop: d }); })(__tip)", tipCtx);
			tipCache.set(key, clean(html));
		}
		return tipCache.get(key);
	}
	const FONT = (() => {
		try {
			const d = path.join(APP, "css/fonts/pixel"), f = fs.readdirSync(d).find((x) => /^base\..*\.woff2$/.test(x));
			return f && path.join(d, f);
		} catch (e) {
			return null;
		}
	})();
	const artJson = JSON.stringify(art).replace(/</g, "\\u003c"),
		page = fs.readFileSync(path.join(__dirname, "app", "index.html"), "utf8").replace("__ART__", () => artJson);
	const recCache = new Map(); // api/rec: the recording members read last (rec.js playerAt)
	const NEW = newRuns({
		dir, cli, root, worlds, threads, startSim, stamp,
		addLaunch: (L) => (launches.push(L), saveLaunches()),
	});

	/** Serves the page, what it loads, and the viewer's paths (viewer.claims) */
	function handle(req, res) {
		const url = new URL(req.url, "http://x"),
			json = (o, code = 200) => (res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }), res.end(JSON.stringify(o))),
			safeJson = (fn) => {
				try {
					const [code, o] = fn();
					return json(o, code);
				} catch (e) {
					return json({ reason: e.message }, 500);
				}
			};
		// (a run's id in a path: the page encodes a folder's run as <folder>%2F<id>)
		const p = url.pathname.replace(/%2F/gi, "/");
		if (viewer.claims(req, p)) return viewer.handle(req, res);
		let m;
		// without the grid's inline tail: the page reads the grid file
		if (p === "/api/live" && req.method === "GET") return json(worlds().map((w) => (w.grid && w.grid.tail ? { ...w, grid: { ...w.grid, tail: undefined } } : w)));
		if (p === "/api/control" && req.method === "GET") return json(controlInfo());
		if (p === "/api/settings" && req.method === "GET") return json(settings());
		if (p === "/api/config" && req.method === "GET") return safeJson(SETTINGS.info);
		// the CODE page (dashboard/code.js)
		if (p === "/api/code" && req.method === "GET") return safeJson(CODE.list);
		if (p === "/api/code/files" && req.method === "GET") return safeJson(() => CODE.files(url.searchParams));
		if (p === "/api/code/file" && req.method === "GET") return safeJson(() => CODE.read(url.searchParams));
		if (p === "/api/code/runs" && req.method === "GET") return safeJson(() => CODE.runs(url.searchParams, dir));
		// the game's CODE editor (CodeMirror, from the game's own copy) for the CODE page
		if ((m = /^\/cm\/([\w.]+\/)?[\w.-]+\.(js|css)$/.exec(p)) && req.method === "GET") {
			const base = path.join(APP, "js", "codemirror"),
				f = path.join(base, path.normalize(p.slice(4)));
			if (!f.startsWith(base + path.sep)) return res.writeHead(404).end();
			return fs.readFile(f, (e, b) => (e ? res.writeHead(404).end() : (res.writeHead(200, { "content-type": m[2] === "js" ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", "cache-control": "max-age=86400" }), res.end(b))));
		}
		// a run's resolved setup file as it is (beside its snapshot, else in the removed/ there); ?download=1: as a file to save
		if ((m = /^\/api\/setup\/((?:[\w-][\w.-]*\/)?[\w.-]+--\d+)$/.exec(p)) && req.method === "GET") {
			const id = m[1],
				f = [path.join(dir, id), removedOf(id)].map((x) => x + ".setup.json").find((x) => fs.existsSync(x));
			if (!f) return json({ reason: `no setup file for ${id}` }, 404);
			return fs.readFile(f, (e, b) => (e ? json({ reason: `no setup file for ${id}` }, 404) : (res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", ...(url.searchParams.get("download") === "1" ? { "content-disposition": `attachment; filename="${path.basename(id)}.setup.json"` } : {}) }), res.end(b))));
		}
		if ((m = /^\/api\/launch\/(l-[\w-]+)\/log$/.exec(p)) && req.method === "GET") {
			const [code, o] = launchLog(m[1], Number(url.searchParams.get("tail") || 60));
			return json(o, code);
		}
		const gm = /^\/api\/(grid|items)\/((?:[\w-][\w.-]*\/)?[\w.-]+)$/.exec(p);
		if (gm && req.method === "GET") {
			const [code, o] = gridRead(gm[2], Number(url.searchParams.get("from") || 0), url.searchParams.get("gen"), gm[1]);
			return json(o, code);
		}
		if (p === "/api/item" && req.method === "GET") {
			const name = url.searchParams.get("name") || "", level = Number(url.searchParams.get("level") || 0), stat = url.searchParams.get("stat") || "";
			if (!/^\w{1,40}$/.test(name) || !Number.isInteger(level) || level < 0 || level > 20 || !/^[a-z]{0,12}$/.test(stat)) return res.writeHead(400).end();
			try {
				const html = itemTip(name, level, stat);
				return html == null ? res.writeHead(404).end() : json({ html });
			} catch (e) {
				return (console.warn("dashboard: item tooltip:", e.message), res.writeHead(500).end());
			}
		}
		// GET api/rec/<run id>/<name>/sheet?v=<virtual ms>: the character's sheet at that moment of its recording (the last
		// "player" packet its client had): { at, level, xp, max_xp, hp, max_hp, mp, max_mp, gold, type, rip, gear,
		// gear_stat, stats, s: its conditions, items: its inventory (as players[].inventory), free: its empty slots, log:
		// the last 100 lines of its game log and chat (rec.js logAt) }; null before its first one (a character recorded
		// from later on); 404 without a recording
		if ((m = /^\/api\/rec\/((?:[\w-][\w.-]*\/)?[\w.-]+--\d+)\/([\w-]{1,40})\/sheet$/.exec(p)) && req.method === "GET") {
			const q = url.searchParams.get("v"),
				v = q ? Number(q) : NaN,
				rd = path.join(dir, m[1] + ".rec");
			if (!Number.isFinite(v)) return json({ reason: "v: virtual ms" }, 400);
			let at, log;
			try {
				at = playerAt(rd, m[2], v, recCache);
				log = at && logAt(rd, m[2], v, 100, recCache);
			} catch (e) {
				return json({ reason: e.code === "ENOENT" ? `no recording of ${m[2]} in ${m[1]}` : e.message }, e.code === "ENOENT" ? 404 : 500);
			}
			if (!at) return json(null);
			const [t, d] = at,
				gear = {},
				gear_stat = {};
			for (const k of GEAR) if (d.slots && d.slots[k]) (gear[k] = d.slots[k].name + (d.slots[k].level != null ? "+" + d.slots[k].level : "")), d.slots[k].stat_type && (gear_stat[k] = d.slots[k].stat_type);
			return json({ at: t, level: d.level, xp: d.xp, max_xp: d.max_xp, hp: d.hp, max_hp: d.max_hp, mp: d.mp, max_mp: d.max_mp, gold: d.gold, type: d.ctype, rip: !!d.rip, gear, gear_stat,
				stats: Object.fromEntries(STATS.filter((k) => typeof d[k] === "number").map((k) => [k, d[k]])), s: d.s || {},
				items: Array.isArray(d.items) ? d.items.map((it) => (it ? { name: it.name, q: it.q, level: it.level, stat_type: it.stat_type, l: it.l, p: typeof it.p === "string" ? it.p : undefined } : null)) : null, free: d.esize ?? null, log });
		}
		// GET api/condition?name=<key>: a condition's tooltip ({ html }), 404 for a key the game doesn't define
		if (p === "/api/condition" && req.method === "GET") {
			const name = url.searchParams.get("name") || "";
			if (!/^\w{1,40}$/.test(name)) return res.writeHead(400).end();
			try {
				const html = conditionTip(name);
				return html == null ? res.writeHead(404).end() : json({ html });
			} catch (e) {
				return (console.warn("dashboard: condition tooltip:", e.message), res.writeHead(500).end());
			}
		}
		if (p === "/font/pixel.woff2" && FONT) return fs.readFile(FONT, (e, b) => (e ? res.writeHead(404).end() : (res.writeHead(200, { "content-type": "font/woff2", "cache-control": "max-age=86400" }), res.end(b))));
		// the item images a tooltip may show (e.g. what an item dismantles into)
		if (p.startsWith("/images/") && req.method === "GET") {
			const f = path.join(APP, path.normalize(p));
			if (!f.startsWith(path.join(APP, "images") + path.sep) || !/\.(png|jpg|gif)$/.test(f)) return res.writeHead(404).end();
			return fs.readFile(f, (e, b) => (e ? res.writeHead(404).end() : (res.writeHead(200, { "content-type": "image/" + f.split(".").pop().replace("jpg", "jpeg"), "cache-control": "max-age=86400" }), res.end(b))));
		}
		const a = /^\/art\/(\d+)\.png$/.exec(p);
		if (a && artPaths[a[1]] && req.method === "GET")
			return fs.readFile(artPaths[a[1]], (e, b) => (e ? res.writeHead(404).end() : (res.writeHead(200, { "content-type": "image/png", "cache-control": "max-age=86400" }), res.end(b))));
		if (req.method === "DELETE" || req.method === "POST" || req.method === "PUT") {
			// only the page itself: a custom header (a cross-site form or simple request can't send one) and a same-host Origin,
			// on a Host that is localhost, an address or the host it listens on (a DNS-rebinding page's Host is its own name)
			const origin = req.headers.origin;
			let ok = req.headers["x-dashboard"] === "1",
				name = null;
			try {
				name = new URL("http://" + req.headers.host).hostname;
				if (ok && origin) ok = new URL(origin).host === req.headers.host;
			} catch (e) {
				ok = false; // e.g. "Origin: null"
			}
			if (ok && !(name === "localhost" || name === host.toLowerCase() || net.isIP(name.replace(/^\[(.*)\]$/, "$1"))))
				return json({ reason: `not from Host ${req.headers.host || "(none)"}: open the dashboard by its address or localhost` }, 403);
			if (!ok) return res.writeHead(403).end();
			// the JSON body (at most 4 KB), then the answer
			const act = (fn, max = 4096) => {
				readBody(req, max, (err, body) => {
					if (err) return json({ reason: err === 413 ? `body over ${Math.round(max / 1024)} KB` : "body: a JSON object" }, err);
					Promise.resolve()
						.then(() => fn(body))
						.then(([code, o]) => json(o, code), (e) => json({ reason: e.message }, 500));
				});
			};
			if ((m = /^\/api\/live\/((?:[\w-][\w.-]*\/)?[\w.-]+)$/.exec(p)) && req.method === "DELETE") return act(() => remove(m[1], url.searchParams.get("stop") === "1"));
			if (p === "/api/clear-finished" && req.method === "POST") return act(() => [200, worlds().filter((w) => !ON.has(w.state)).map((w) => (moveAway(w.id), { removed: w.id }))]);
			if ((m = /^\/api\/runs\/((?:[\w-][\w.-]*\/)?[\w.-]+)\/stop$/.exec(p)) && req.method === "POST") return act((b) => stopRun(m[1], b.force === true));
			if ((m = /^\/api\/runs\/((?:[\w-][\w.-]*\/)?[\w.-]+)\/export$/.exec(p)) && req.method === "POST") return act((b) => exportRun(m[1], b.label));
			if (p === "/api/launch" && req.method === "POST") return act(launch);
			if (p === "/api/viewer" && req.method === "POST") return act(viewerUse);
			if ((m = /^\/api\/launch\/(l-[\w-]+)$/.exec(p)) && req.method === "DELETE") return act(() => cancel(m[1]));
			if (p === "/api/settings" && req.method === "PUT") return act(putSettings);
			// Settings: the token, config/local.json (dashboard/settings.js)
			if (p === "/api/config" && req.method === "PUT") return act(SETTINGS.put);
			if (p === "/api/config/token" && req.method === "POST") return act(SETTINGS.token);
			if (p === "/api/config/token" && req.method === "DELETE") return act(SETTINGS.forget);
			// the New run form (dashboard/new.js)
			if (p === "/api/new/pull" && req.method === "POST") return act(() => NEW.pull());
			if (p === "/api/new/export" && req.method === "POST") return act((b) => NEW.addExport(b), 8 << 20);
			if (p === "/api/new/player" && req.method === "POST") return act((b) => NEW.player(b));
			if (p === "/api/new/compose" && req.method === "POST") return act((b) => NEW.compose(b), 256 << 10);
			if (p === "/api/new/code" && req.method === "POST") return act((b) => NEW.code(b), 12 << 20);
			if (p === "/api/code/file" && req.method === "POST") return act((b) => CODE.write(b), 3 << 20);
			// crafted accounts (lib/accounts.js)
			if ((m = /^\/api\/accounts\/([\w-]{1,24})$/.exec(p)) && req.method === "PUT") return act((b) => NEW.accountPut(m[1], b), 64 << 10);
			if ((m = /^\/api\/accounts\/([\w-]{1,24})$/.exec(p)) && req.method === "DELETE") return act(() => NEW.accountDel(m[1]));
			// gear sets (lib/gear_sets.js): yours written and removed
			if ((m = /^\/api\/gearsets\/([\w-]{1,24})$/.exec(p)) && req.method === "PUT") return act((b) => NEW.gearSetPut(m[1], b), 16 << 10);
			if ((m = /^\/api\/gearsets\/([\w-]{1,24})$/.exec(p)) && req.method === "DELETE") return act(() => NEW.gearSetDel(m[1]));
			// your pulls (all of an account's, or all but its newest), other players' pages taken
			if ((m = /^\/api\/pulls\/([\w.-]{1,40})$/.exec(p)) && req.method === "DELETE") return act(() => NEW.pullDel(m[1], url.searchParams.get("older") === "1"));
			if ((m = /^\/api\/players\/([\w.-]{1,40})$/.exec(p)) && req.method === "DELETE") return act(() => NEW.playerDel(m[1]));
		}
		if (p === "/api/new" && req.method === "GET") return safeJson(() => NEW.info());
		if (p === "/api/gearsets" && req.method === "GET") return safeJson(() => NEW.gearSets());
		if (p === "/api/new/items" && req.method === "GET") return safeJson(() => NEW.items());
		if (p === "/api/new/snippet" && req.method === "GET") return safeJson(() => NEW.snippet());
		if (p === "/api/new/fits" && req.method === "GET") return safeJson(() => NEW.fits(url.searchParams));
		if (p === "/api/new/code" && req.method === "GET") return safeJson(() => NEW.codeInfo(url.searchParams));
		if (p === "/api/new/top" && req.method === "GET") return void NEW.top().then(([code, o]) => json(o, code), (e) => json({ reason: e.message }, 500));
		if (p === "/" || p === "/index.html") {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" });
			return res.end(page);
		}
		// the page's modules, styles and the libraries it carries (dashboard/app)
		if (p.startsWith("/app/") && req.method === "GET") {
			const f = path.join(__dirname, path.normalize(p));
			if (!f.startsWith(path.join(__dirname, "app") + path.sep) || !APP_TYPES[path.extname(f)]) return res.writeHead(404).end();
			return fs.readFile(f, (e, b) => (e ? res.writeHead(404).end() : (res.writeHead(200, { "content-type": APP_TYPES[path.extname(f)], "cache-control": "no-cache" }), res.end(b))));
		}
		res.writeHead(404).end();
	}
	return { handle, worlds, close: () => (clearInterval(timer), viewer.close()) };
}


// The CODE store's garbage: <dir>/code/<sha>.json (slot maps) and <sha>.js (entries) that no setup file in dir or
// dir/removed/ uses (a folder of runs has its own: chronal dash --gc-code does each). A blob younger than 10 minutes stays (a run that stored its CODE and is about to write its setup
// file); an unreadable setup file stops it (nothing deleted). -> { kept, deleted, bytes, files } (files: deleted names)
function gcCode(dir) {
	const store = path.join(dir, "code"),
		used = new Set(),
		ls = (d) => {
			try {
				return fs.readdirSync(d);
			} catch (e) {
				return [];
			}
		};
	for (const d of [dir, path.join(dir, "removed")])
		for (const f of ls(d).filter((x) => x.endsWith(".setup.json"))) {
			const s = readJson(path.join(d, f), null);
			if (!s || !Array.isArray(s.characters)) throw new Error(`can't read ${path.join(d, f)}: nothing deleted`);
			for (const c of s.characters) if (c && c.code) used.add(c.code.slots + ".json").add(c.code.text + ".js");
		}
	const out = { kept: 0, deleted: 0, bytes: 0, files: [] };
	for (const f of ls(store)) {
		if (!/^[0-9a-f]{16}\.(json|js)$/.test(f)) continue;
		const p = path.join(store, f),
			st = fs.statSync(p);
		if (used.has(f) || Date.now() - st.mtimeMs < 600e3) {
			out.kept++;
			continue;
		}
		fs.unlinkSync(p);
		out.deleted++;
		out.bytes += st.size;
		out.files.push(f);
	}
	return out;
}

// chronal dash [--port N (config ports.dash)] [--host H] [--dir LIVE] [--gc-code]
function cli(argv) {
	const arg = (name, def) => {
		const i = argv.indexOf("--" + name);
		return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
	};
	const port = Number(arg("port", cfg.port)),
		host = arg("host", "127.0.0.1"),
		dir = config({ cli: { live_dir: arg("dir", null) } }).live_dir;
	if (argv.includes("--gc-code")) {
		try {
			for (const { dir: d } of liveDirs(dir)) {
				if (!fs.existsSync(path.join(d, "code"))) continue;
				const r = gcCode(d);
				console.log(`${path.join(d, "code")}: deleted ${r.deleted} unused CODE files (${(r.bytes / 1024).toFixed(0)} KB), kept ${r.kept}`);
			}
			process.exit(0);
		} catch (e) {
			console.error("gc-code: " + e.message);
			process.exit(1);
		}
	}
	const d = createDashboard({ dir, host });
	// the viewer's backend (a child process) ends with the dashboard
	for (const sig of ["SIGINT", "SIGTERM"]) process.once(sig, () => (d.close(), process.exit(0)));
	http.createServer(d.handle).listen(port, host, () => {
		console.log(`chronal dashboard on http://${host}:${port}/ (reading ${dir})`);
		console.log(`from another machine: ssh -N -L ${port}:localhost:${port} <user>@<this machine>, then open http://localhost:${port}/`);
	});
}

module.exports = { cli, createDashboard, gcCode };
