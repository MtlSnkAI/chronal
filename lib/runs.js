"use strict";
// A live dir's runs and their processes, for the dashboard and the CLI (chronal ps, chronal stop): its runs and those
// one folder down (e.g. live/fidelity/: run ids <folder>/<id>), which run is still
// running (its process, verified by pid, start time and cwd: never another process that took the pid), and the run
// control requests (<id>.ctl: { seq, stop?, by?, export?, at }) a run takes at its next poll (live.js).
//   chronal ps [--dir LIVE] [--all]
//   chronal stop <run id | --tag T | --all> [--dir LIVE] [--force [--wait S]]
// stop: asks each run to stop (it ends at its next game minute, with its final numbers); --force: SIGTERM to its
// process (verified), then SIGKILL after --wait seconds (default 10) if it hasn't ended. A tag that matches several
// runs needs --all.
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");

const STALE_MS = 15_000, // a snapshot not written for this long: stalled (or stopped)
	HOST = os.hostname(),
	RUN_FILE = /^[\w.-]+--\d+\.json$/,
	RUN_ID = /^(?:[\w-][\w.-]*\/)?[\w.-]+--\d+$/, // <id> or <folder>/<id>
	NOT_RUNS = new Set(["removed", "logs", "code"]);

// The live dir and the folders in it (one level; not removed/, logs/, code/, a run's <id>.rec/ and <id>.state/):
// [{ sub: "" | <folder>, dir }]. A folder's runs are <folder>/<id>; removed, they go to its own removed/.
function liveDirs(dir) {
	const out = [{ sub: "", dir }];
	let es = [];
	try {
		es = fs.readdirSync(dir, { withFileTypes: true });
	} catch (e) {}
	for (const e of es) {
		if (!/^[\w-][\w.-]*$/.test(e.name) || NOT_RUNS.has(e.name) || /\.(rec|state)$/.test(e.name)) continue;
		const d = path.join(dir, e.name);
		try {
			if (e.isDirectory() || (e.isSymbolicLink() && fs.statSync(d).isDirectory())) out.push({ sub: e.name, dir: d });
		} catch (x) {}
	}
	return out;
}

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

// A process by pid on this host: the start time in /proc/<pid>/stat (field 22, clock ticks since boot) tells it from a
// later one with the same pid; its cwd is checked too before anything is signalled.
function procStart(pid) {
	try {
		const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
		return s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
	} catch (e) {
		return null;
	}
}
// true: that very process runs here; false: it has ended; null: can't tell (no proc, another host or user, no /proc)
function identify(p) {
	if (!p || !(p.pid > 0) || p.host !== HOST) return null;
	try {
		process.kill(p.pid, 0);
	} catch (e) {
		return e.code === "EPERM" ? null : false;
	}
	try {
		if (p.start != null) {
			if (procStart(p.pid) !== String(p.start)) return false;
		} else if (p.cmdline && fs.readFileSync(`/proc/${p.pid}/cmdline`, "latin1") !== p.cmdline) return false;
		if (p.cwd && fs.readlinkSync(`/proc/${p.pid}/cwd`).replace(/ \(deleted\)$/, "") !== p.cwd) return false;
	} catch (e) {
		return e.code === "ENOENT" ? false : null;
	}
	return true;
}
const seen = new Map(); // "host pid start cwd" -> { t, v }: one look per second
function alive(p) {
	if (!p || !p.pid) return null;
	const k = [p.host, p.pid, p.start, p.cwd, p.cmdline].join(" "),
		c = seen.get(k);
	if (c && Date.now() - c.t < 1000) return c.v;
	if (seen.size > 500) seen.clear();
	const v = identify(p);
	seen.set(k, { t: Date.now(), v });
	return v;
}
function stateOf(w, a) {
	const failed = !!(w.end && w.end.reason === "failed");
	if (w.done) return failed ? "failed" : "done";
	const stale = !(Date.now() - Date.parse(w.updated) <= STALE_MS);
	if (a === true) return stale ? "stalled" : "running";
	if (a === false || failed) return failed ? "failed" : "stopped";
	return stale ? "stopped" : "running";
}

// A run control request on top of what the run has acknowledged (an open stop or export stays asked)
function ctlRequest(file, ack, patch) {
	const cur = readJson(file, null) || {},
		open = +cur.seq > ack,
		q = { seq: Math.max(+cur.seq || 0, ack) + 1 };
	if (patch.stop || (open && cur.stop)) q.stop = true;
	if (q.stop && (patch.by || (open && cur.by))) q.by = patch.by || cur.by; // (who asked: the run's end detail)
	if (patch.export || (open && cur.export)) q.export = patch.export || cur.export;
	q.at = Date.now();
	writeJson(file, q);
	return q;
}

/** The runs of a live dir and its folders: { id, tag, state, pid, speed, started, updated, virtual_ms, file, w } */
function runsIn(dir) {
	const out = [];
	for (const { sub, dir: d } of liveDirs(dir)) {
		let files = [];
		try {
			files = fs.readdirSync(d).filter((f) => RUN_FILE.test(f));
		} catch (e) {}
		for (const f of files) {
			const w = readJson(path.join(d, f), null);
			if (!w || !w.started) continue; // (a run that just reserved its file)
			const id = (sub ? sub + "/" : "") + f.slice(0, -5);
			out.push({ id, tag: w.tag, state: stateOf(w, w.done ? null : alive(w.proc)), pid: (w.proc && w.proc.pid) || null, speed: w.speed ? w.speed.now ?? w.speed.avg : null, started: w.started, updated: w.updated, virtual_ms: w.virtual_ms, file: path.join(d, f), w });
		}
	}
	return out.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
}

const ON = new Set(["running", "stalled"]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cli(cmd, argv) {
	const opt = (k) => {
		const i = argv.indexOf("--" + k);
		return i >= 0 ? argv[i + 1] : null;
	};
	const dir = path.resolve(opt("dir") || require("./config").config().live_dir),
		runs = runsIn(dir);
	if (cmd === "ps") {
		const list = argv.includes("--all") ? runs : runs.filter((r) => ON.has(r.state));
		if (!list.length) return void console.log(`no ${argv.includes("--all") ? "" : "running "}runs in ${dir}`);
		for (const r of list) console.log(`${r.id}  ${r.state.padEnd(8)} pid ${String(r.pid ?? "-").padEnd(8)} ${r.speed != null ? Math.round(r.speed) + "x" : "-"}  ${((r.virtual_ms || 0) / 60e3).toFixed(1)} game min  ${r.tag}`);
		return;
	}
	// stop
	const tag = opt("tag"),
		ids = argv.filter((a, i) => !a.startsWith("--") && !["dir", "tag", "wait"].includes((argv[i - 1] || "").slice(2)));
	// an id as ps lists it, or its snapshot's path
	const is = (r, id) => r.id === id.replace(/\.json$/, "") || r.file === path.resolve(id.endsWith(".json") ? id : id + ".json");
	let pick = runs.filter((r) => ON.has(r.state) && (ids.length ? ids.some((id) => is(r, id)) : tag ? r.tag === tag : argv.includes("--all")));
	if (!pick.length) return void (console.error(`chronal stop: no running run${ids.length ? " " + ids.join(", ") : tag ? " tagged " + tag : ""} in ${dir}`), process.exit(1));
	if (tag && pick.length > 1 && !argv.includes("--all")) return void (console.error(`chronal stop: ${pick.length} running runs tagged ${tag} (${pick.map((r) => r.id).join(", ")}): --all to stop them all`), process.exit(2));
	let failed = 0;
	for (const r of pick) {
		if (!argv.includes("--force")) {
			if (!(r.w.control && r.w.control.stop)) (console.error(`${r.id}: takes no stop requests (no control file): --force`), failed++);
			else console.log(`${r.id}: stop asked (seq ${ctlRequest(path.join(path.dirname(r.file), path.basename(r.w.control.file)), +r.w.control.ack || 0, { stop: true, by: "chronal stop" }).seq}): it ends at its next game minute`);
			continue;
		}
		if (identify(r.w.proc) !== true) {
			console.error(`${r.id}: can't verify its process on this host (pid, start time, cwd): not signalled`);
			failed++;
			continue;
		}
		process.kill(r.pid, "SIGTERM");
		const until = Date.now() + 1000 * (+opt("wait") || 10);
		while (Date.now() < until && identify(r.w.proc) === true) await sleep(200);
		if (identify(r.w.proc) === true) process.kill(r.pid, "SIGKILL"), console.log(`${r.id}: SIGKILL (pid ${r.pid})`);
		else console.log(`${r.id}: ended (SIGTERM, pid ${r.pid})`);
	}
	process.exit(failed ? 1 : 0);
}

module.exports = { HOST, STALE_MS, RUN_FILE, RUN_ID, liveDirs, procStart, identify, alive, stateOf, ctlRequest, runsIn, cli };
