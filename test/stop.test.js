"use strict";
// chronal ps / chronal stop (lib/runs.js): the runs running in a live dir, stop requests through <id>.ctl (by id, by
// tag, --all), --force only to a process verified on this host; chronal run without live snapshots halts on SIGTERM;
// chronal new --run passes a signal on to its runs.
//   node --test test/stop.test.js
// The last tests need the game (config al_root: chronal install); CHRONAL_HALT_E2E=0 skips them.
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawn, spawnSync } = require("node:child_process");
const RUNS = require("../lib/runs");

const DIR = path.join(__dirname, ".."),
	E2E = { skip: process.env.CHRONAL_HALT_E2E === "0" };
const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "stop-test-"))), dirs[dirs.length - 1]),
	kids = [];
test.after(() => {
	for (const c of kids) c.kill("SIGKILL");
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const chronal = (...a) => spawnSync(process.execPath, ["chronal.js", ...a], { cwd: DIR, encoding: "utf8" });
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// a process to stand for a run's: its proc block as live.js writes it
const sleeper = () => {
	const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd: DIR, stdio: "ignore" });
	kids.push(c);
	return c;
};
const procOf = (c) => ({ pid: c.pid, host: RUNS.HOST, start: Number(RUNS.procStart(c.pid)), cwd: DIR });
const until = async (f, ms = 5000) => {
	for (const t = Date.now() + ms; Date.now() < t; await new Promise((r) => setTimeout(r, 50))) if (f()) return true;
	return false;
};

test("ctlRequest: a new seq over the acknowledged one; an open stop (and who asked) or export stays asked", () => {
	const f = path.join(tmp(), "a--1.ctl");
	assert.deepEqual((({ at, ...q }) => q)(RUNS.ctlRequest(f, 0, { stop: true, by: "chronal stop" })), { seq: 1, stop: true, by: "chronal stop" });
	// not acknowledged yet: an export on top keeps the stop
	assert.deepEqual((({ at, ...q }) => q)(RUNS.ctlRequest(f, 0, { export: "x" })), { seq: 2, stop: true, by: "chronal stop", export: "x" });
	// acknowledged: only what is asked now; the seq goes on from the ack when the file is behind it
	assert.deepEqual((({ at, ...q }) => q)(RUNS.ctlRequest(f, 2, { export: "y" })), { seq: 3, export: "y" });
	fs.rmSync(f);
	assert.equal(RUNS.ctlRequest(f, 7, { stop: true }).seq, 8);
});

test("chronal ps / stop on a live dir: running runs only, by id, by tag (several need --all), --force only to a verified process", async () => {
	const dir = tmp(),
		a = sleeper(),
		b = sleeper(),
		now = new Date().toISOString();
	let n = 0;
	const run = (id, tag, proc, more = {}) =>
			fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify({ id, tag, started: new Date(Date.now() - 60e3 + 1000 * n++).toISOString(), updated: now, virtual_ms: 120e3, speed: { now: 40 }, proc, control: { file: id + ".ctl", stop: true, ack: 0 }, ...more }));
	await until(() => RUNS.procStart(a.pid) && RUNS.procStart(b.pid));
	run("one--1", "farm", procOf(a));
	run("two--2", "farm", procOf(b), { control: { file: "two--2.ctl", stop: true, ack: 2 } });
	fs.writeFileSync(path.join(dir, "two--2.ctl"), JSON.stringify({ seq: 3, stop: true, at: 1 })); // asked, not taken yet
	run("done--3", "farm", procOf(a), { done: true, end: { reason: "complete", detail: null } });
	run("gone--4", "farm", { ...procOf(a), start: 1 }); // its pid now another process's
	run("away--5", "other", { pid: a.pid, host: "elsewhere", start: 1, cwd: DIR }); // another host's: can't tell
	fs.writeFileSync(path.join(dir, "half--6.json"), "{}"); // reserved, not written yet

	const ps = chronal("ps", "--dir", dir);
	assert.equal(ps.status, 0, ps.stderr);
	const rows = ps.stdout.trim().split("\n");
	assert.deepEqual(rows.map((l) => l.split(/\s+/)[0]), ["one--1", "two--2", "away--5"]);
	assert.match(rows[0], new RegExp(`running\\s+pid ${a.pid}\\s+40x\\s+2\\.0 game min\\s+farm`));
	assert.deepEqual(chronal("ps", "--dir", dir, "--all").stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]).sort(), ["away--5", "done--3", "gone--4", "one--1", "two--2"]);
	assert.match(chronal("ps", "--dir", tmp()).stdout, /^no running runs in /);

	// by id (the file's name too): a stop request, by chronal stop
	const s1 = chronal("stop", "one--1.json", "--dir", dir);
	assert.equal(s1.status, 0, s1.stderr);
	assert.match(s1.stdout, /one--1: stop asked \(seq 1\)/);
	assert.deepEqual((({ at, ...q }) => q)(read(path.join(dir, "one--1.ctl"))), { seq: 1, stop: true, by: "chronal stop" });
	// a finished run, or none: exit 1, nothing written
	for (const id of ["done--3", "nope--9"]) {
		const r = chronal("stop", id, "--dir", dir);
		assert.equal(r.status, 1);
		assert.match(r.stderr, /no running run/);
	}
	assert.equal(fs.existsSync(path.join(dir, "done--3.ctl")), false);
	// a tag with several running runs: --all to stop them all
	const t = chronal("stop", "--tag", "farm", "--dir", dir);
	assert.equal(t.status, 2);
	assert.match(t.stderr, /2 running runs tagged farm \(one--1, two--2\): --all/);
	assert.equal(read(path.join(dir, "one--1.ctl")).seq, 1);
	const ta = chronal("stop", "--tag", "farm", "--all", "--dir", dir);
	assert.equal(ta.status, 0, ta.stderr);
	assert.equal(read(path.join(dir, "one--1.ctl")).seq, 2);
	assert.deepEqual((({ at, ...q }) => q)(read(path.join(dir, "two--2.ctl"))), { seq: 4, stop: true, by: "chronal stop" });

	// --force: never to a process it can't verify; to a verified one SIGTERM, which ends it
	const f1 = chronal("stop", "away--5", "--force", "--dir", dir);
	assert.equal(f1.status, 1);
	assert.match(f1.stderr, /away--5: can't verify its process/);
	assert.equal(a.exitCode, null);
	assert.equal(a.signalCode, null);
	const f2 = chronal("stop", "two--2", "--force", "--wait", "5", "--dir", dir);
	assert.equal(f2.status, 0, f2.stderr);
	assert.match(f2.stdout, new RegExp(`two--2: ended \\(SIGTERM, pid ${b.pid}\\)`));
	assert.ok(await until(() => b.signalCode === "SIGTERM"), "the sleeper got SIGTERM: " + b.signalCode);
	assert.equal(a.signalCode, null, "no other process signalled");
});

test("chronal ps / stop: a folder's runs (one level down) as <folder>/<id>, by that id or the snapshot's path", async () => {
	const dir = tmp(),
		fid = path.join(dir, "fid"),
		a = sleeper(),
		now = new Date().toISOString();
	await until(() => RUNS.procStart(a.pid));
	for (const d of [fid, path.join(dir, "removed"), path.join(fid, "deeper")]) {
		fs.mkdirSync(d, { recursive: true });
		fs.writeFileSync(path.join(d, "x--1.json"), JSON.stringify({ tag: "x", started: now, updated: now, proc: procOf(a), control: { file: "x--1.ctl", stop: true, ack: 0 } }));
	}
	assert.deepEqual(chronal("ps", "--dir", dir).stdout.trim().split("\n").map((l) => l.split(/\s+/)[0]), ["fid/x--1"]);
	assert.match(chronal("stop", "fid/x--1", "--dir", dir).stdout, /fid\/x--1: stop asked \(seq 1\)/);
	assert.match(chronal("stop", path.join(fid, "x--1.json"), "--dir", dir).stdout, /fid\/x--1: stop asked \(seq 2\)/);
	assert.equal(read(path.join(fid, "x--1.ctl")).seq, 2);
	assert.equal(chronal("stop", "x--1", "--dir", dir).status, 1);
	assert.ok(!fs.existsSync(path.join(dir, "x--1.ctl")) && !fs.existsSync(path.join(dir, "removed", "x--1.ctl")));
});

// a ranger on codes/idle.js in a live dir (or none) for 240 game minutes; resolves with its exit
const longRun = (dir, extra, started) =>
	new Promise((resolve) => {
		const result = path.join(dir, "result.json"),
			c = spawn(process.execPath, ["chronal.js", "run", "--code", path.join("codes", "idle.js"), "--class", "ranger", "--duration", "240m", "--warmup", "0m", "--result", result, ...extra], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });
		kids.push(c);
		let out = "";
		c.stdout.on("data", (d) => ((out += d), started(c, out)));
		c.stderr.on("data", (d) => (out += d));
		c.on("exit", (code) => resolve({ code, out, res: fs.existsSync(result) ? read(result) : null }));
	});

test("chronal run: chronal stop <id> ends it at its next game minute with its numbers (end: stopped, chronal stop)", E2E, async () => {
	const dir = tmp();
	let asked = null;
	const watch = setInterval(() => {
		const g = fs.readdirSync(dir).find((f) => f.endsWith(".grid.ndjson"));
		if (asked || !g || fs.readFileSync(path.join(dir, g), "utf8").split("\n").filter(Boolean).length < 3) return;
		asked = chronal("stop", g.replace(/\.grid\.ndjson$/, ""), "--dir", dir);
	}, 100);
	const r = await longRun(dir, ["--live", dir, "--tag", "stop-e2e"], () => {});
	clearInterval(watch);
	assert.ok(asked, "never asked:\n" + r.out);
	assert.equal(asked.status, 0, asked.stderr);
	assert.equal(r.code, 0, r.out);
	assert.match(r.out, new RegExp(`pid \\d+: SIGINT/SIGTERM or chronal stop stop-e2e--\\d+ stops it`));
	assert.equal(r.res.halted, true);
	assert.ok(r.res.vmin > 0 && r.res.vmin < 240 && Number.isInteger(r.res.vmin), String(r.res.vmin));
	const s = read(path.join(dir, fs.readdirSync(dir).find((f) => /--\d+\.json$/.test(f))));
	assert.equal(s.done, true);
	assert.deepEqual(s.end, { reason: "stopped", detail: "chronal stop" });
});

test("chronal run --no-live: SIGTERM ends it at its next game minute with its numbers; chronal new --run passes it on", E2E, async () => {
	const dir = tmp();
	let sent = 0;
	const r = await longRun(dir, ["--no-live"], (c, out) => {
		if (!sent && /^pid \d+/m.test(out)) (sent = Date.now()), c.kill("SIGTERM");
	});
	assert.ok(sent, r.out);
	assert.equal(r.code, 0, r.out);
	assert.ok(Date.now() - sent < 10_000);
	assert.equal(r.res.halted, true);
	assert.ok(r.res.vmin >= 0 && r.res.vmin < 240 && Number.isInteger(r.res.vmin), String(r.res.vmin));

	// chronal new --run with 2 seeds, 1 job: SIGTERM while the first runs -> it ends with its numbers, the second never starts
	const setup = path.join(dir, "long.json");
	fs.writeFileSync(setup, JSON.stringify({ format: "chronal-setup/1", name: "long", run: { duration: "240m", warmup: "0m" }, characters: [{ name: "Ran1", class: "ranger", code: { file: path.join(DIR, "codes", "idle.js") } }] }));
	const t0 = Date.now();
	const n = await new Promise((resolve) => {
		const c = spawn(process.execPath, ["chronal.js", "new", "--template", setup, "--save", path.join(dir, "saved.json"), "--run", "--seeds", "1,2", "--jobs", "1", "--no-live"], { cwd: DIR, stdio: ["ignore", "pipe", "pipe"] });
		kids.push(c);
		let out = "",
			sent = false;
		const tick = setInterval(() => {
			// the run's own log in chronal new's temp dir: its pid line, then the signal
			if (sent) return;
			const logs = fs.readdirSync(os.tmpdir()).filter((d) => d.startsWith("chronal-new-")).map((d) => path.join(os.tmpdir(), d, "0.log")).filter((f) => fs.existsSync(f) && fs.statSync(f).mtimeMs >= t0);
			if (logs.some((f) => /^pid \d+/m.test(fs.readFileSync(f, "utf8")))) (sent = true), c.kill("SIGTERM");
		}, 100);
		c.stdout.on("data", (d) => (out += d));
		c.stderr.on("data", (d) => (out += d));
		c.on("exit", (code) => (clearInterval(tick), resolve({ code, out, sent })));
	});
	assert.ok(n.sent, n.out);
	assert.match(n.out, /done long-\S+ seed 1: /);
	assert.doesNotMatch(n.out, /seed 2/);
});
