// dashboard/server.js, the server: run states from a live dir with fake pids, requests to runs (control files, stop,
// remove), launches (a fake chronal run), card settings and the request guard. The viewer: test/viewer.test.js.
// node --test test/dashboard_server.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	http = require("node:http");
const { spawn, spawnSync } = require("node:child_process");
const { createDashboard } = require("../dashboard/server");

const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "dash-server-test-")));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (t) => new Date(t).toISOString();
const start = (pid) => {
	const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
	return +s.slice(s.lastIndexOf(")") + 2).split(" ")[19];
};
const procOf = (pid, cwd) => ({ pid, host: os.hostname(), start: start(pid), cwd, cmdline: null, log: null });
const ME = procOf(process.pid, process.cwd());
const DEAD = spawnSync(process.execPath, ["-e", "0"]).pid; // ended (and reaped)
const ctlOf = (id, extra) => ({ file: id + ".ctl", stop: true, ack: 0, ...extra });
let n = 0;
const mkdir = (name) => fs.mkdirSync(path.join(TMP, name + "-" + ++n), { recursive: true }) || path.join(TMP, name + "-" + n);
function snap(dir, id, o = {}) {
	const w = { id, tag: id.replace(/--\d+$/, ""), schema: 2, schema_minor: 2, started: iso(Date.now() - 60e3), updated: iso(Date.now()), done: false, roster: [{ name: "A" }], players: [{ name: "A" }], ...o };
	fs.writeFileSync(path.join(dir, id + ".json"), JSON.stringify(w));
	return w;
}
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
async function until(fn, ms = 8000, what = "condition") {
	for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) {
		const v = await fn();
		if (v) return v;
	}
	throw new Error("timed out waiting for " + what);
}
// a dashboard on an ephemeral port (no game art: appDir is empty)
async function serve(o) {
	const warn = console.warn;
	console.warn = () => {};
	let d;
	try {
		d = createDashboard({ appDir: TMP, root: path.join(TMP, "no-root"), ...o });
	} finally {
		console.warn = warn;
	}
	const srv = http.createServer(d.handle);
	await new Promise((r) => srv.listen(0, "127.0.0.1", r));
	const port = srv.address().port;
	const call = (method, p, { body, headers = {}, raw } = {}) =>
		new Promise((resolve, reject) => {
			const h = method === "GET" ? headers : { "x-dashboard": "1", "content-type": "application/json", ...headers };
			const rq = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, agent: false }, (res) => {
				let s = "";
				res.on("data", (c) => (s += c)).on("end", () => {
					let b = s;
					try {
						b = JSON.parse(s);
					} catch (e) {}
					resolve({ code: res.statusCode, body: b, headers: res.headers, text: s });
				});
			});
			rq.on("error", reject);
			rq.end(raw != null ? raw : body != null ? JSON.stringify(body) : undefined);
		});
	return { d, port, call, get: (p) => call("GET", p), live: async () => (await call("GET", "/api/live")).body, close: () => (d.close(), new Promise((r) => srv.close(r))) };
}
const byId = (ws) => Object.fromEntries(ws.map((w) => [w.id, w]));
// our own children only, by pid after checking their cwd
function killOurs(pid, cwd) {
	try {
		if (fs.readlinkSync(`/proc/${pid}/cwd`) === cwd) process.kill(pid, "SIGKILL");
	} catch (e) {}
}

test("states: pid + start time + cwd on this host; the file's age without one; only <id>.json runs are listed", async () => {
	const dir = mkdir("states"),
		old = iso(Date.now() - 60e3);
	snap(dir, "run--1", { proc: ME });
	snap(dir, "stall--2", { proc: ME, updated: old });
	snap(dir, "dead--3", { proc: { ...ME, pid: DEAD }, updated: old });
	snap(dir, "failed--4", { proc: { ...ME, pid: DEAD }, end: { reason: "failed", detail: "exit 1" } });
	snap(dir, "reused--5", { proc: { ...ME, start: ME.start + 1 } });
	snap(dir, "moved--6", { proc: { ...ME, cwd: "/nowhere" } });
	snap(dir, "far--7", { proc: { ...ME, host: "elsewhere" } });
	snap(dir, "farold--8", { proc: { ...ME, host: "elsewhere" }, updated: old });
	snap(dir, "v21old--9", { updated: old });
	snap(dir, "v21--10", {});
	snap(dir, "done--11", { proc: ME, done: true, end: { reason: "complete" } });
	for (const f of [".dash.json", "x--1.ctl", "y--2.setup.json", "plain.json", "z--3.grid.ndjson", "a--1.json.123.tmp"]) fs.writeFileSync(path.join(dir, f), "{}");
	const s = await serve({ dir });
	try {
		const ws = await s.live(),
			w = byId(ws);
		assert.deepStrictEqual(Object.keys(w).sort(), ["dead--3", "done--11", "failed--4", "far--7", "farold--8", "moved--6", "reused--5", "run--1", "stall--2", "v21--10", "v21old--9"]);
		const st = Object.fromEntries(ws.map((x) => [x.id, [x.state, x.ctl.alive]]));
		assert.deepStrictEqual(st, {
			"run--1": ["running", true], "stall--2": ["stalled", true], "dead--3": ["stopped", false], "failed--4": ["failed", false], "reused--5": ["stopped", false], "moved--6": ["stopped", false],
			"far--7": ["running", null], "farold--8": ["stopped", null], "v21old--9": ["stopped", null], "v21--10": ["running", null], "done--11": ["done", null],
		});
		assert.deepStrictEqual(ws.slice(0, 4).map((x) => x.state).sort(), ["running", "running", "running", "stalled"]); // live ones first
		assert.strictEqual(ws[ws.length - 1].state, "done");
	} finally {
		await s.close();
	}
});

test("w.ctl: stop, force and rerun per run; api/control", async () => {
	const dir = mkdir("ctl");
	snap(dir, "sim--1", { proc: ME, control: ctlOf("sim--1") });
	snap(dir, "plain--3", {}); // no control, not a run of a setup
	snap(dir, "other--4", { proc: ME, control: ctlOf("elsewhere--9") });
	snap(dir, "far--5", { proc: { ...ME, host: "elsewhere" }, control: ctlOf("far--5") });
	const s = await serve({ dir });
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual([w["sim--1"].ctl.stop, w["sim--1"].ctl.force, w["sim--1"].ctl.pending, w["sim--1"].ctl.remove_when_done], [true, true, null, false]);
		assert.deepStrictEqual([w["plain--3"].ctl.stop, w["plain--3"].ctl.force, w["plain--3"].ctl.rerun, w["plain--3"].ctl.rerun_why], [false, false, false, "not a run of a setup: nothing to run it again from"]);
		assert.strictEqual(w["other--4"].ctl.stop, false); // its control file is not <id>.ctl
		assert.deepStrictEqual([w["far--5"].ctl.stop, w["far--5"].ctl.force], [true, false]); // a request, but no signal to another host
		const c = (await s.get("/api/control")).body;
		assert.deepStrictEqual(c.viewer, { up: false });
		assert.ok(c.sims.threads_max >= 1 && Array.isArray(c.launches));
	} finally {
		await s.close();
	}
});

test("stop: requests in <id>.ctl (seq, merged until acked), pending until the run acks", async () => {
	const dir = mkdir("req");
	const sim = snap(dir, "sim--1", { proc: ME, control: ctlOf("sim--1") });
	snap(dir, "plain--3", {}); // no control, not a run of a setup
	snap(dir, "gone--4", { proc: { ...ME, pid: DEAD }, control: ctlOf("gone--4") });
	const s = await serve({ dir });
	try {
		let r = await s.call("POST", "/api/runs/sim--1/stop", { body: {} });
		assert.deepStrictEqual([r.code, r.body], [202, { seq: 1 }]);
		const q = read(path.join(dir, "sim--1.ctl"));
		assert.deepStrictEqual([q.seq, q.stop, typeof q.at], [1, true, "number"]);
		assert.deepStrictEqual(fs.readdirSync(dir).filter((f) => f.endsWith(".tmp")), []);
		assert.deepStrictEqual(byId(await s.live())["sim--1"].ctl.pending, { seq: 1, stop: true, at: q.at });
		r = await s.call("POST", "/api/runs/sim--1/stop", {});
		assert.deepStrictEqual([r.code, r.body], [202, { seq: 2 }]);
		// the run acks seq 2: nothing pending; the next request has the next seq
		fs.writeFileSync(path.join(dir, "sim--1.json"), JSON.stringify({ ...sim, updated: iso(Date.now()), control: { ...sim.control, ack: 2 } }));
		assert.strictEqual(byId(await s.live())["sim--1"].ctl.pending, null);
		assert.deepStrictEqual((await s.call("POST", "/api/runs/sim--1/stop", {})).body, { seq: 3 });
		assert.strictEqual((await s.call("POST", "/api/runs/plain--3/stop", {})).code, 409); // no control file
		assert.strictEqual((await s.call("POST", "/api/runs/gone--4/stop", {})).code, 409); // not running
		assert.strictEqual((await s.call("POST", "/api/runs/nope--5/stop", {})).code, 404);
	} finally {
		await s.close();
	}
});

test("force stop: a signal only to the verified process (pid, start time, cwd)", async () => {
	const dir = mkdir("force");
	const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60e3)"], { cwd: dir, stdio: "ignore" });
	await sleep(100);
	try {
		snap(dir, "sim--1", { proc: procOf(child.pid, dir), control: ctlOf("sim--1") });
		snap(dir, "far--2", { proc: { ...procOf(child.pid, dir), host: "elsewhere" }, control: ctlOf("far--2") });
		const s = await serve({ dir });
		try {
			assert.strictEqual((await s.call("POST", "/api/runs/far--2/stop", { body: { force: true } })).code, 403);
			const exited = new Promise((r) => child.on("exit", (code, sig) => r(sig)));
			const r = await s.call("POST", "/api/runs/sim--1/stop", { body: { force: true } });
			assert.deepStrictEqual([r.code, r.body], [200, { signal: "SIGKILL" }]);
			assert.strictEqual(await exited, "SIGKILL");
		} finally {
			await s.close();
		}
	} finally {
		killOurs(child.pid, dir);
	}
});

test("remove: a finished run moves with its side files; a running one is stopped, stays listed and moves once ended", async () => {
	const dir = mkdir("remove");
	snap(dir, "done--1", { done: true });
	for (const x of [".grid.ndjson", ".ctl", ".setup.json"]) fs.writeFileSync(path.join(dir, "done--1" + x), "x");
	const run = snap(dir, "run--2", { proc: ME, control: ctlOf("run--2") });
	snap(dir, "noctl--3", { proc: ME });
	snap(dir, "stall--4", { proc: ME, updated: iso(Date.now() - 60e3) });
	snap(dir, "failed--5", { proc: { ...ME, pid: DEAD }, end: { reason: "failed" } });
	snap(dir, "stopped--6", { updated: iso(Date.now() - 60e3) });
	const s = await serve({ dir });
	try {
		let r = await s.call("DELETE", "/api/live/done--1");
		assert.deepStrictEqual([r.code, r.body], [200, { removed: "done--1" }]);
		assert.deepStrictEqual(fs.readdirSync(path.join(dir, "removed")).sort(), ["done--1.ctl", "done--1.grid.ndjson", "done--1.json", "done--1.setup.json"]);
		r = await s.call("DELETE", "/api/live/noctl--3?stop=1");
		assert.deepStrictEqual([r.code, r.body], [409, { reason: "running", can_stop: false }]);
		r = await s.call("DELETE", "/api/live/run--2");
		assert.deepStrictEqual([r.code, r.body], [409, { reason: "running", can_stop: true }]);
		r = await s.call("DELETE", "/api/live/run--2?stop=1");
		assert.deepStrictEqual([r.code, r.body], [202, { stopping: "run--2" }]);
		assert.strictEqual(read(path.join(dir, "run--2.ctl")).stop, true);
		let w = byId(await s.live())["run--2"];
		assert.deepStrictEqual([w.state, w.ctl.remove_when_done, w.ctl.pending.stop], ["running", true, true]);
		// clear-finished: failed and stopped go, running and stalled stay
		r = await s.call("POST", "/api/clear-finished");
		assert.deepStrictEqual(r.body.map((x) => x.removed).sort(), ["failed--5", "stopped--6"]);
		// the run ends: moved with its files, off the list
		fs.writeFileSync(path.join(dir, "run--2.json"), JSON.stringify({ ...run, done: true, end: { reason: "stopped", detail: "dashboard" }, updated: iso(Date.now()) }));
		w = byId(await s.live());
		assert.deepStrictEqual(Object.keys(w).sort(), ["noctl--3", "stall--4"]);
		assert.ok(fs.existsSync(path.join(dir, "removed/run--2.json")) && fs.existsSync(path.join(dir, "removed/run--2.ctl")));
		assert.deepStrictEqual(read(path.join(dir, ".remove-when-done.json")), []);
		assert.strictEqual((await s.call("DELETE", "/api/live/nope--9")).code, 404);
	} finally {
		await s.close();
	}
});

test(".hidden.json: its runs show again as remove-when-done (no stop request)", async () => {
	const dir = mkdir("hidden");
	snap(dir, "run--1", { proc: ME, control: ctlOf("run--1") });
	snap(dir, "done--2", { done: true });
	fs.writeFileSync(path.join(dir, ".hidden.json"), JSON.stringify(["run--1", "done--2"]));
	fs.writeFileSync(path.join(dir, ".remove-when-done.json"), JSON.stringify(["done--2"]));
	const s = await serve({ dir });
	try {
		assert.ok(!fs.existsSync(path.join(dir, ".hidden.json")));
		const ws = await s.live();
		assert.deepStrictEqual(ws.map((w) => [w.id, w.ctl.remove_when_done]), [["run--1", true]]);
		assert.ok(fs.existsSync(path.join(dir, "removed/done--2.json")));
		assert.ok(!fs.existsSync(path.join(dir, "run--1.ctl"))); // shown again, not stopped
		assert.deepStrictEqual(read(path.join(dir, ".remove-when-done.json")), ["run--1"]);
	} finally {
		await s.close();
	}
});

test("settings: defaults, PUT validated and kept in .dash.json (the cards, the Data panels)", async () => {
	const dir = mkdir("settings");
	const s = await serve({ dir });
	try {
		let r = await s.get("/api/settings");
		assert.deepStrictEqual(r.body, { v: 1, cards: { hero: "xph", chips: ["dps", "hps", "dtps", "hpotsh", "mpotsh", "killsh"] }, data: null, rev: 0 });
		const cards = { hero: "dps", chips: ["deaths", "xph", "deaths"] };
		r = await s.call("PUT", "/api/settings", { body: { v: 1, cards } });
		assert.strictEqual(r.code, 200);
		assert.deepStrictEqual(r.body.cards, { hero: "dps", chips: ["deaths", "xph"] });
		assert.ok(r.body.rev > 0);
		assert.deepStrictEqual(read(path.join(dir, ".dash.json")).cards, r.body.cards);
		for (const bad of [{ hero: "XPH", chips: [] }, { hero: "xph", chips: ["a", "b", "c", "d", "e", "f", "g"] }, { hero: "xph", chips: "dps" }, { hero: "xph", chips: [1] }, null])
			assert.strictEqual((await s.call("PUT", "/api/settings", { body: { cards: bad } })).code, 400, JSON.stringify(bad));
		// the panels: kept with the cards; a PUT of one keeps the other
		const data = { cols: 2, panels: [{ id: "p1", m: "dps", view: "meters", col: 0 }, { id: "p2", m: "dmg", view: "by", by: "skill", col: 1, x: 1 }] };
		r = await s.call("PUT", "/api/settings", { body: { v: 1, data } });
		assert.strictEqual(r.code, 200);
		assert.deepStrictEqual([r.body.cards, r.body.data], [{ hero: "dps", chips: ["deaths", "xph"] }, { cols: 2, panels: [data.panels[0], { id: "p2", m: "dmg", view: "by", by: "skill", col: 1 }] }]);
		r = await s.call("PUT", "/api/settings", { body: { v: 1, cards: { hero: "xph", chips: [] } } });
		assert.deepStrictEqual([r.body.cards.hero, r.body.data.panels.length], ["xph", 2]);
		const P = (o) => ({ id: "p1", m: "dps", view: "meters", col: 0, ...o });
		for (const bad of [{ cols: 1, panels: [P({ id: "P1" })] }, { cols: 1, panels: [P({ view: "chart" })] }, { cols: 1, panels: [P(), P({ m: "xp" })] }, { cols: 2, panels: [P({ col: 2 })] }, { cols: 5, panels: [] }, { cols: 1, panels: Array.from({ length: 13 }, (_, i) => P({ id: "p" + i })) }, [P()], "x", null])
			assert.strictEqual((await s.call("PUT", "/api/settings", { body: { data: bad } })).code, 400, JSON.stringify(bad));
		assert.strictEqual((await s.call("PUT", "/api/settings", { body: { v: 1 } })).code, 400);
		assert.strictEqual((await s.call("PUT", "/api/settings", { raw: "{nope" })).code, 400);
		assert.strictEqual((await s.call("PUT", "/api/settings", { raw: JSON.stringify({ cards, pad: "x".repeat(5000) }) })).code, 413);
	} finally {
		await s.close();
	}
});

test("guard: every POST/PUT/DELETE needs the page's header, a same-host Origin and a local Host", async () => {
	const dir = mkdir("guard");
	snap(dir, "done--1", { done: true });
	snap(dir, "run--2", { proc: ME, control: ctlOf("run--2") });
	const s = await serve({ dir });
	try {
		const tries = [["DELETE", "/api/live/done--1"], ["POST", "/api/clear-finished"], ["POST", "/api/runs/run--2/stop"], ["POST", "/api/launch"], ["POST", "/api/viewer"], ["DELETE", "/api/launch/l-x"], ["PUT", "/api/settings"]];
		for (const [m, p] of tries) {
			assert.strictEqual((await s.call(m, p, { headers: { "x-dashboard": "" } })).code, 403, `${m} ${p} without the header`);
			assert.strictEqual((await s.call(m, p, { headers: { origin: "http://evil.example" } })).code, 403, `${m} ${p} foreign Origin`);
			assert.strictEqual((await s.call(m, p, { headers: { origin: "null" } })).code, 403, `${m} ${p} Origin null`);
			const h = await s.call(m, p, { headers: { host: "evil.example:" + s.port } });
			assert.deepStrictEqual([h.code, /not from Host/.test(h.body.reason)], [403, true], `${m} ${p} Host`);
		}
		assert.ok(fs.existsSync(path.join(dir, "done--1.json")) && !fs.existsSync(path.join(dir, "run--2.ctl")));
		// a same-host Origin passes
		assert.strictEqual((await s.call("POST", "/api/runs/run--2/stop", { headers: { origin: "http://127.0.0.1:" + s.port } })).code, 202);
	} finally {
		await s.close();
	}
});

// ---------------------------------------------------------------------------------------------------- launches
// a sim run as chronal run writes it: a snapshot (proc, control, launch) every 100 ms, stops on a control-file request; its
// env logged
const RUNNER = `
const fs = require("fs"), os = require("os"), path = require("path");
const env = process.env, dir = env.CHRONAL_LIVE_DIR, tag = process.argv[process.argv.indexOf("--tag") + 1], started = Date.now(), id = tag.replace(/[^\\w.-]+/g, "_").slice(0, 80) + "--" + started;
const file = path.join(dir, id + ".json"), ctl = path.join(dir, id + ".ctl");
console.log("fake runner " + JSON.stringify(env));
const st = fs.readFileSync("/proc/self/stat", "utf8");
const proc = { pid: process.pid, host: os.hostname(), start: +st.slice(st.lastIndexOf(")") + 2).split(" ")[19], cwd: process.cwd(), cmdline: null, log: fs.readlinkSync("/proc/self/fd/1") };
let ack = 0;
function write(end) {
	const o = { id, tag, schema: 2, schema_minor: 2, started: new Date(started).toISOString(), updated: new Date().toISOString(), done: !!end, end: end || null, roster: [{ name: "A" }], players: [{ name: "A" }], proc, control: { file: id + ".ctl", stop: true, ack }, launch: { key: env.CHRONAL_LAUNCH_KEY || null, rerun_of: env.CHRONAL_RERUN_OF || null } };
	fs.writeFileSync(file + ".tmp", JSON.stringify(o));
	fs.renameSync(file + ".tmp", file);
}
write(null);
setInterval(() => {
	let q = null;
	try { q = JSON.parse(fs.readFileSync(ctl, "utf8")); } catch (e) {}
	if (q && q.seq > ack && q.stop) { ack = q.seq; write({ reason: "stopped", detail: "dashboard" }); fs.rmSync(ctl, { force: true }); process.exit(0); }
	write(null);
}, 100);
setTimeout(() => process.exit(0), 60e3);
`;
// a run of a setup: its resolved setup file (<id>.setup.json) beside the snapshot, the snapshot's setup block
const SETUP = require("../lib/setup");
const sideFile = (o = {}) => ({
	format: SETUP.FORMAT, resolved: { at: iso(T0), by: "chronal run", from: "/x/any/setup.json" }, name: "any", strategy: null, run: { duration: "20m", warmup: "1m", seed: 1, until: null, check: "1s", grid_ms: 30000 },
	world: { roi: null, threads: true, age: "0m", ping: 18 }, party: null, accounts: { main: { age_days: 0, bank: null } },
	characters: [{ name: "A", class: "ranger", account: "main", role: null, fps: 10, at: { map: "main", x: 0, y: 0 }, params: null, state: { level: 40, xp: 0, gold: 0, items: [], slots: {} }, code: { entry: "farm.js", slots: "a".repeat(16), text: "b".repeat(16), hash: "12345678" } }],
	source: { characters: { A: { code_dir: null, file: "/x/any/farm.js", append: [], extra: [] } }, accounts: {} }, ...o,
});
const T0 = Date.parse("2026-09-25T00:00:00Z");
function setupRun(dir, id, side, o = {}) {
	fs.writeFileSync(path.join(dir, id + ".setup.json"), JSON.stringify(side));
	return snap(dir, id, { done: true, end: { reason: "complete", detail: null }, tag: side.name, versions: { sim: "?", code: "?", code_hash: SETUP.codeHash(side) }, setup: { format: SETUP.FORMAT, file: id + ".setup.json", name: side.name, from: side.resolved.from, hash: "0" }, ...o });
}
const simSetupRun = (sim, o = {}) => ({ run: { root: sim, script: "chronal run", seed: 1, duration_ms: 20 * 60e3, warmup_ms: 60e3, until: null }, ...o });
// a fake chronal run: --check prints its JSON line (the current CODE: each character's hash c0ffee00, else CURRENT_HASH's),
// else it runs as the fake runner, its arguments logged
const RUNJS = `const a = process.argv.slice(2);
if (a.includes("--check")) {
	const S = require(${JSON.stringify(path.join(__dirname, "../lib/setup"))}), s = JSON.parse(require("fs").readFileSync(a[0], "utf8")), stored = S.codeHash(s), cur = a.includes("--current-code");
	const characters = s.characters.map((c) => ({ name: c.name, code_hash: cur ? process.env.CURRENT_HASH || "c0ffee00" : c.code.hash, ...(cur ? { code_hash_stored: c.code.hash } : {}) }));
	console.log(JSON.stringify({ ok: true, name: s.name, characters, code_hash: S.codeHash({ characters: characters.map((c) => ({ name: c.name, code: { hash: c.code_hash } })) }), ...(cur ? { code_hash_stored: stored } : {}), warnings: [], argv: a }));
	process.exit(0);
}
console.log("fake argv " + JSON.stringify(a));
` + RUNNER;

// a fake checkout (a dashboard's root): its chronal.js runs chronal run as the fake above (kind "sleep": one that boots
// and waits; "fail": one that fails at once)
function checkout(kind) {
	const d = path.join(mkdir("root"), "fake");
	fs.mkdirSync(d);
	fs.writeFileSync(path.join(d, "chronal.js"), 'if (process.argv[2] === "run") process.argv.splice(2, 1), require("./run.js");\n');
	fs.writeFileSync(path.join(d, "run.js"), kind === "sleep" ? 'console.log("booting"); setTimeout(() => {}, 60e3);' : kind === "fail" ? 'console.log("booting"); console.error("FAILED: no such spot"); process.exit(1);' : RUNJS);
	return d;
}
const linked = (s, key) => until(async () => (await s.get("/api/control")).body.launches.find((l) => l.key === key && l.state === "running") || null, 8000, "the launch to link");
// the fake's argv and env, from its launch's log
async function fakeOf(s, key) {
	const lines = (await s.get(`/api/launch/${key}/log`)).body.lines;
	return { argv: JSON.parse(lines.find((l) => l.startsWith("fake argv ")).slice(10)), env: JSON.parse(lines.find((l) => l.startsWith("fake runner ")).slice(12)) };
}

test("sim rerun: plan, thread cap, launch, link by launch key, stop through the API, log", async () => {
	const dir = mkdir("launch"),
		sim = checkout(),
		file = path.join(dir, "bench--1.setup.json");
	setupRun(dir, "bench--1", sideFile({ name: "bench", run: { ...sideFile().run, duration: "30m" } }), simSetupRun(sim, { tag: "bench s1 30m" }));
	snap(dir, "setup--6", simSetupRun(sim, { done: true, end: { reason: "complete" }, setup: { format: "chronal-setup/1", file: "setup--6.setup.json", name: "setup", from: null, hash: "0" } }));
	const s = await serve({ dir, root: sim });
	const keep = { CHRONAL_NO_BUILD: process.env.CHRONAL_NO_BUILD, CHRONAL_THREADS_MAX: process.env.CHRONAL_THREADS_MAX };
	process.env.CHRONAL_NO_BUILD = "1"; // the dashboard's own: not passed on
	let pid = null,
		pid2 = null;
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual([w["bench--1"].ctl.rerun, w["bench--1"].ctl.rerun_why], [true, null]);
		// a run of a setup whose setup file is gone: no rerun
		assert.deepStrictEqual([w["setup--6"].ctl.rerun, w["setup--6"].ctl.rerun_why, w["setup--6"].ctl.rerun_setup], [false, "no setup file setup--6.setup.json beside the snapshot", null]);
		const refused = await s.call("POST", "/api/launch", { body: { of: "setup--6", dry: true } });
		assert.deepStrictEqual([refused.code, refused.body.reason], [400, w["setup--6"].ctl.rerun_why]);
		const L = (body) => s.call("POST", "/api/launch", { body: { of: "bench--1", ...body } });
		let r = await L({ duration: "60m", seed: 2, dry: true });
		assert.strictEqual(r.code, 200);
		assert.deepStrictEqual([r.body.plan.tag, r.body.plan.command], ["bench s2 1h", ["chronal", "run", file, "--duration", "1h", "--seed", "2"]]);
		assert.deepStrictEqual((await L({ duration: "", dry: true })).body.plan.command.slice(3, 5), ["--duration", "30m"]); // no duration: as recorded
		assert.deepStrictEqual((await L({ duration: 90, dry: true })).body.plan.command.slice(3, 5), ["--duration", "90m"]); // a bare number: minutes
		assert.strictEqual((await L({ duration: "1.5h", dry: true })).body.plan.tag, "bench s1 90m");
		for (const bad of [{ duration: "3x" }, { duration: "30s" }, { duration: "8d" }, { seed: 0 }, { seed: 1.5 }, { tag: "-x" }, { tag: "x".repeat(81) }])
			assert.strictEqual((await L({ dry: true, ...bad })).code, 400, JSON.stringify(bad));
		assert.strictEqual((await s.call("POST", "/api/launch", { body: { of: "nope--9" } })).code, 404);
		// the thread cap (1 character + the server thread): with none busy, one bigger than the host still starts alone
		process.env.CHRONAL_THREADS_MAX = "1";
		assert.deepStrictEqual((await L({ dry: true })).body.plan.warnings.filter((x) => /CPU/.test(x)), []);
		process.env.CHRONAL_THREADS_MAX = "3";

		r = await L({ duration: "60m", seed: 2 });
		assert.strictEqual(r.code, 202);
		const key = r.body.launch.key;
		assert.match(key, /^l-\d{8}T\d{6}Z-[0-9a-f]{4}$/);
		const c = await linked(s, key);
		const run = byId(await s.live())[c.run];
		pid = run.proc.pid;
		assert.deepStrictEqual([run.state, run.tag, run.launch.rerun_of, run.ctl.stop, c.pid], ["running", "bench s2 1h", "bench--1", true, pid]);
		// a second one is over the cap now (2 busy + 2 > 3): it waits in the queue, then starts once the first has ended
		assert.ok((await L({ dry: true })).body.plan.warnings.includes("CPU: 2 of 3 sim threads busy; this run needs 2: it waits in the queue"));
		r = await L({ seed: 3 });
		const q = r.body.launch.key;
		assert.deepStrictEqual([r.code, r.body.launch.state], [202, "queued"]);
		assert.ok((await L({ dry: true })).body.plan.warnings.includes("CPU: 2 of 3 sim threads busy, 1 queued; this run needs 2: it waits in the queue"));
		const q2 = (await L({ seed: 4 })).body.launch.key;
		assert.strictEqual(read(path.join(dir, ".launches.json")).find((l) => l.key === q2).state, "queued"); // kept for a restart
		assert.strictEqual((await s.call("DELETE", `/api/launch/${q2}`)).body.launch.state, "cancelled"); // a cancel drops it
		const { argv, env } = await fakeOf(s, key);
		assert.deepStrictEqual(argv, [file, "--duration", "1h", "--seed", "2", "--tag", "bench s2 1h"]);
		assert.deepStrictEqual([env.CHRONAL_LIVE_DIR, env.CHRONAL_LAUNCH_KEY, env.CHRONAL_RERUN_OF, env.CHRONAL_NO_BUILD], [dir, key, "bench--1", undefined]);
		const log = (await s.get(`/api/launch/${key}/log?tail=1`)).body;
		assert.deepStrictEqual([log.path, log.lines.length], [path.join(dir, "logs", key + ".log"), 1]);
		// stop through the API: the run acks and ends; the launch has exited
		r = await s.call("POST", `/api/runs/${c.run}/stop`, { body: {} });
		assert.strictEqual(r.code, 202);
		await until(async () => byId(await s.live())[c.run].state === "done", 5000, "the run to end");
		await until(async () => (await s.get("/api/control")).body.launches.find((l) => l.key === key).state === "exited", 5000, "the launch to exit");
		// the queued one has started meanwhile (its turn: the threads came free); stopped the same way
		const c2 = await until(async () => ((await s.get("/api/control")).body.launches.find((l) => l.key === q && l.state === "running") || null), 8000, "the queued launch to start");
		pid2 = byId(await s.live())[c2.run].proc.pid;
		assert.strictEqual((await s.call("POST", `/api/runs/${c2.run}/stop`, { body: {} })).code, 202);
		await until(async () => byId(await s.live())[c2.run].state === "done", 5000, "the queued run to end");
		assert.strictEqual(read(path.join(dir, ".launches.json")).find((l) => l.key === key).run, c.run);
		assert.strictEqual((await s.call("DELETE", `/api/launch/${key}`)).body.dismissed, true); // an ended launch: dropped
		assert.strictEqual((await s.get("/api/control")).body.launches.find((l) => l.key === key), undefined);
	} finally {
		for (const [k, v] of Object.entries(keep)) v == null ? delete process.env[k] : (process.env[k] = v);
		for (const p of [pid, pid2]) if (p) killOurs(p, sim);
		await s.close();
	}
});

test("replay recordings: w.rec lists a run's recorded characters, which move with it; record: chronal run --record, a boolean", async () => {
	const dir = mkdir("rec"),
		sim = checkout();
	setupRun(dir, "bench--1", sideFile({ name: "bench" }), simSetupRun(sim));
	setupRun(dir, "plain--2", sideFile({ name: "plain" }), simSetupRun(sim));
	fs.mkdirSync(path.join(dir, "bench--1.rec"));
	for (const f of ["Ran1.rec.idx", "Ran1.rec.gz", "Pri1.rec.idx", "Pri1.rec.gz", "notes.txt"]) fs.writeFileSync(path.join(dir, "bench--1.rec", f), "x");
	const s = await serve({ dir, root: sim });
	const keep = { CHRONAL_THREADS_MAX: process.env.CHRONAL_THREADS_MAX };
	process.env.CHRONAL_THREADS_MAX = "8";
	let pids = [];
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual([w["bench--1"].rec, w["plain--2"].rec], [["Pri1", "Ran1"], []]);
		const L = (body) => s.call("POST", "/api/launch", { body: { of: "plain--2", ...body } });
		let r = await L({ record: true, dry: true });
		assert.deepStrictEqual([r.code, r.body.plan.record, r.body.plan.command.slice(-1)], [200, true, ["--record"]]);
		assert.strictEqual((await L({ dry: true })).body.plan.record, undefined);
		assert.deepStrictEqual([(await L({ record: "yes", dry: true })).code, (await L({ record: "yes", dry: true })).body.reason], [400, "record: true or false"]);
		const fake = async (key) => {
			const c = await linked(s, key);
			pids.push(byId(await s.live())[c.run].proc.pid);
			return fakeOf(s, key);
		};
		r = await L({ record: true });
		assert.deepStrictEqual([r.code, r.body.launch.args.record], [202, true]);
		let x = await fake(r.body.launch.key);
		assert.strictEqual(x.argv.includes("--record"), true);
		r = await L({ seed: 3 });
		x = await fake(r.body.launch.key);
		assert.strictEqual(x.argv.includes("--record"), false);
		// removed: its recordings go with it
		r = await s.call("DELETE", "/api/live/bench--1");
		assert.strictEqual(r.code, 200);
		assert.deepStrictEqual(fs.readdirSync(path.join(dir, "removed", "bench--1.rec")).sort(), ["Pri1.rec.gz", "Pri1.rec.idx", "Ran1.rec.gz", "Ran1.rec.idx", "notes.txt"]);
	} finally {
		for (const [k, v] of Object.entries(keep)) v == null ? delete process.env[k] : (process.env[k] = v);
		for (const pid of pids) killOurs(pid, sim);
		await s.close();
	}
});

test("sim rerun dry run: identical only to a run that ran its whole duration; the rest runs the full duration", async () => {
	const dir = mkdir("whole"),
		sim = checkout();
	setupRun(dir, "whole--1", sideFile(), simSetupRun(sim));
	setupRun(dir, "early--2", sideFile({ name: "long", run: { ...sideFile().run, duration: "3000m" } }), simSetupRun(sim, { end: { reason: "stopped", detail: "dashboard" }, measured_ms: 149 * 60e3 }));
	setupRun(dir, "running--3", sideFile(), simSetupRun(sim, { done: false, end: null, proc: ME, measured_ms: 12 * 60e3 }));
	setupRun(dir, "failed--4", sideFile(), simSetupRun(sim, { done: false, end: { reason: "failed", detail: "exit 1" }, measured_ms: 6 * 60e3 }));
	const s = await serve({ dir, root: sim });
	const keep = process.env.CHRONAL_THREADS_MAX;
	process.env.CHRONAL_THREADS_MAX = "8";
	const warn = async (of, body = {}) => (await s.call("POST", "/api/launch", { body: { of, dry: true, ...body } })).body.plan.warnings;
	const STORED = "the stored CODE (the original's)",
		IDENTICAL = "same seed, stored CODE and duration: an identical run (deterministic)",
		EARLY = "the original was stopped early at 149 of 3000 game min: the rerun runs the full 3000 game min";
	try {
		assert.deepStrictEqual(await warn("whole--1"), [STORED, IDENTICAL]);
		assert.deepStrictEqual(await warn("whole--1", { seed: 2 }), [STORED]);
		assert.deepStrictEqual(await warn("early--2"), [STORED, EARLY]);
		assert.deepStrictEqual(await warn("early--2", { seed: 3 }), [STORED, EARLY]);
		assert.deepStrictEqual(await warn("early--2", { duration: "3000" }), [STORED, EARLY]);
		assert.deepStrictEqual(await warn("early--2", { duration: "149" }), [STORED]); // another duration: nothing to say
		assert.deepStrictEqual(await warn("running--3"), [STORED, "the original is still running at 12 of 20 game min: the rerun runs the full 20 game min"]);
		assert.deepStrictEqual(await warn("failed--4"), [STORED, "the original did not finish at 6 of 20 game min: the rerun runs the full 20 game min"]);
	} finally {
		keep == null ? delete process.env.CHRONAL_THREADS_MAX : (process.env.CHRONAL_THREADS_MAX = keep);
		await s.close();
	}
});

test("sim launches: cancel before the run shows up (SIGTERM to its verified process); a run that dies is failed with its last line", async () => {
	const dirs = [mkdir("cancel"), mkdir("cancel")],
		sleep = checkout("sleep"),
		fail = checkout("fail");
	setupRun(dirs[0], "sleep--1", sideFile({ name: "sleep" }), simSetupRun(sleep));
	setupRun(dirs[1], "fail--2", sideFile({ name: "fail" }), simSetupRun(fail));
	const s = await serve({ dir: dirs[0], root: sleep }),
		f = await serve({ dir: dirs[1], root: fail });
	let pid = null;
	try {
		let r = await s.call("POST", "/api/launch", { body: { of: "sleep--1" } });
		const key = r.body.launch.key;
		pid = r.body.launch.pid;
		assert.ok(pid > 0);
		r = await s.call("DELETE", `/api/launch/${key}`);
		assert.deepStrictEqual([r.code, r.body.launch.state], [200, "cancelled"]);
		await until(() => !fs.existsSync(`/proc/${pid}`) || / Z /.test(fs.readFileSync(`/proc/${pid}/stat`, "utf8")), 3000, "the run to end");
		assert.strictEqual((await s.call("DELETE", "/api/launch/l-nope")).code, 404);
		r = await f.call("POST", "/api/launch", { body: { of: "fail--2" } });
		const k2 = r.body.launch.key;
		const l = await until(async () => (await f.get("/api/control")).body.launches.find((x) => x.key === k2 && x.state === "failed"), 5000, "the launch to fail");
		assert.deepStrictEqual([l.reason, l.exit, l.run], ["FAILED: no such spot", 1, null]);
	} finally {
		if (pid) killOurs(pid, sleep);
		await Promise.all([s.close(), f.close()]);
	}
});

test("launch exit: a launch whose run and process ended while no dashboard was its parent: exited, gone", async () => {
	const dir = mkdir("exit");
	snap(dir, "gone--2", { done: true, tag: "gone" });
	const gone = { key: "l-20260925T000000Z-0000", of: null, tag: "gone", args: {}, state: "running", pid: DEAD, proc: { pid: DEAD, host: os.hostname(), start: 1, cwd: dir }, log: null, started: Date.now() - 60e3, exit: null, run: "gone--2", reason: null, cancel: false };
	fs.writeFileSync(path.join(dir, ".launches.json"), JSON.stringify([gone]));
	const s = await serve({ dir });
	try {
		const g = await until(async () => { const l = (await s.get("/api/control")).body.launches.find((x) => x.key === gone.key); return l.state === "exited" && l; }, 5000, "the unseen launch to exit");
		assert.strictEqual(g.exit, "gone");
	} finally {
		await s.close();
	}
});

test("api/setup: a run's setup file from the live dir or removed/, as a download, 404 without one", async () => {
	const dir = mkdir("apisetup"),
		side = sideFile();
	setupRun(dir, "any--1", side);
	snap(dir, "plain--2", { done: true });
	const s = await serve({ dir });
	try {
		let r = await s.get("/api/setup/any--1");
		assert.deepStrictEqual([r.code, r.headers["content-type"], r.headers["content-disposition"], r.body], [200, "application/json", undefined, side]);
		r = await s.get("/api/setup/any--1?download=1");
		assert.deepStrictEqual([r.code, r.headers["content-disposition"], r.text], [200, 'attachment; filename="any--1.setup.json"', fs.readFileSync(path.join(dir, "any--1.setup.json"), "utf8")]);
		assert.deepStrictEqual([(await s.get("/api/setup/plain--2")).code, (await s.get("/api/setup/plain--2")).body], [404, { reason: "no setup file for plain--2" }]);
		assert.strictEqual((await s.get("/api/setup/..%2Fx--1")).code, 404);
		assert.strictEqual((await s.get("/api/setup/nope")).code, 404);
		// the guard: a POST there is refused without the page's header, and there is no such POST
		assert.strictEqual((await s.call("POST", "/api/setup/any--1", { headers: { "x-dashboard": "" } })).code, 403);
		assert.strictEqual((await s.call("POST", "/api/setup/any--1")).code, 404);
		// removed: its setup file moves with it and is still served
		assert.strictEqual((await s.call("DELETE", "/api/live/any--1")).code, 200);
		assert.ok(fs.existsSync(path.join(dir, "removed/any--1.setup.json")));
		assert.deepStrictEqual((await s.get("/api/setup/any--1")).body, side);
	} finally {
		await s.close();
	}
});

test("api/condition: a condition's tooltip from the game's files (render_item of its G.conditions definition); 400 for a bad name, 404 for an unknown one", async () => {
	const dir = mkdir("apicond"),
		app = require("../lib/config").config().al_root,
		s = await serve({ dir }),
		real = fs.existsSync(path.join(app, "js/html.js")) ? await serve({ dir, appDir: app }) : null;
	try {
		assert.strictEqual((await s.get("/api/condition?name=bad-name")).code, 400);
		assert.strictEqual((await s.get("/api/condition")).code, 400);
		if (!real) return;
		const r = await real.get("/api/condition?name=mluck");
		// without the game data (no g_data, no cached G) there is no tooltip
		if (r.code === 404 && (await real.get("/api/item?name=hpot0&level=0")).code === 404) return;
		assert.strictEqual(r.code, 200);
		assert.match(r.body.html, /Good Luck/);
		assert.doesNotMatch(r.body.html, /\sonclick=/);
		assert.strictEqual((await real.get("/api/condition?name=no_such_condition")).code, 404);
	} finally {
		await Promise.all([s.close(), real && real.close()]);
	}
});

test("sim rerun of a run of a setup: chronal run <setup file>, stored CODE or --current-code, --age-days, dry plan from chronal run --check", async () => {
	const dir = mkdir("simsetup"),
		sim = checkout();
	const side = sideFile(),
		stored = SETUP.codeHash(side),
		file = path.join(dir, "any--1.setup.json");
	setupRun(dir, "any--1", side, simSetupRun(sim));
	setupRun(dir, "two--2", sideFile({ name: "two", accounts: { main: { age_days: 0, bank: null }, alt: { age_days: 30, bank: null } }, world: { roi: null, threads: false, age: "0m", ping: 18 } }), simSetupRun("/elsewhere", { end: { reason: "stopped", detail: "dashboard" }, measured_ms: 5 * 60e3 }));
	// a rerun with the current CODE and an age (its side file stores that CODE and age)
	const A = sideFile().characters[0];
	setupRun(dir, "cur--5", sideFile({ name: "any s2 5m current aaaaaaaa age 30d", run: { ...sideFile().run, seed: 2, duration: "5m" }, accounts: { main: { age_days: 30, bank: null } }, characters: [{ ...A, code: { ...A.code, hash: "aaaaaaaa" } }] }), simSetupRun(sim));
	const s = await serve({ dir, root: sim });
	const keep = { CHRONAL_THREADS_MAX: process.env.CHRONAL_THREADS_MAX, CHRONAL_NO_BUILD: process.env.CHRONAL_NO_BUILD };
	Object.assign(process.env, { CHRONAL_THREADS_MAX: "8", CHRONAL_NO_BUILD: "1" });
	const L = (of, body) => s.call("POST", "/api/launch", { body: { of, ...body } });
	let pid = null;
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual([w["any--1"].ctl.rerun, w["any--1"].ctl.rerun_why, w["any--1"].ctl.rerun_setup], [true, null, { code: "stored", age_days: 0 }]);
		// another checkout's run: its setup file holds everything, so it reruns here; the accounts' ages differ: null
		assert.deepStrictEqual([w["two--2"].ctl.rerun, w["two--2"].ctl.rerun_setup], [true, { code: "stored", age_days: null }]);
		// the stored CODE, as recorded: an identical run
		let plan = (await L("any--1", { dry: true })).body.plan;
		assert.deepStrictEqual([plan.ok, plan.command, plan.tag, plan.need], [true, ["chronal", "run", file, "--duration", "20m", "--seed", "1"], "any", 2]);
		// each character's CODE hashes (as the Setup fold shows them), and the run's
		assert.deepStrictEqual(plan.setup, { file, code: "stored", code_hash: stored, code_hash_stored: stored, age_days: 0, characters: [{ name: "A", stored: "12345678", hash: "12345678" }] });
		assert.deepStrictEqual(plan.warnings, ["the stored CODE (the original's)", "same seed, stored CODE and duration: an identical run (deterministic)"]);
		// age 0 as recorded: no --age-days; another seed or duration: not identical
		plan = (await L("any--1", { dry: true, age_days: 0, seed: 2, duration: "5m" })).body.plan;
		assert.deepStrictEqual([plan.command.slice(3), plan.tag, plan.warnings], [["--duration", "5m", "--seed", "2"], "any s2 5m", ["the stored CODE (the original's)"]]);
		// the current CODE and an account age: both in the tag (the current CODE's hash per character)
		plan = (await L("any--1", { dry: true, current_code: true, age_days: 30 })).body.plan;
		assert.deepStrictEqual([plan.command.slice(3), plan.tag], [["--duration", "20m", "--seed", "1", "--current-code", "--age-days", "30"], "any current c0ffee00 age 30d"]);
		assert.deepStrictEqual(plan.setup, { file, code: "current", code_hash: SETUP.codeHash({ characters: [{ name: "A", code: { hash: "c0ffee00" } }] }), code_hash_stored: stored, age_days: 30, characters: [{ name: "A", stored: "12345678", hash: "c0ffee00" }] });
		assert.deepStrictEqual(plan.warnings, ["current CODE: differs from the stored (A)", "account age 30 days (the original: 0 days)"]);
		// days in fractions too (chronal run takes them); the current CODE the same as the stored: no CODE in the tag
		process.env.CURRENT_HASH = "12345678";
		plan = (await L("any--1", { dry: true, current_code: true, age_days: 0.5 })).body.plan;
		delete process.env.CURRENT_HASH;
		assert.deepStrictEqual([plan.command.slice(-3), plan.tag, plan.warnings], [["--current-code", "--age-days", "0.5"], "any age 0.5d", ["current CODE: the same as the stored", "account age 0.5 days (the original: 0 days)"]]);
		// a rerun of that rerun: its CODE and age tokens replaced; its stored CODE and recorded age keep them
		const tagOf = async (body) => (await L("cur--5", { dry: true, ...body })).body.plan.tag;
		assert.deepStrictEqual([await tagOf({ current_code: true, age_days: 41 }), await tagOf({}), await tagOf({ age_days: 30, seed: 3 })], ["any s2 5m current c0ffee00 age 41d", "any s2 5m current aaaaaaaa age 30d", "any s3 5m current aaaaaaaa age 30d"]);
		// world.threads false: one thread; stopped early: the full duration; mixed ages named per account
		plan = (await L("two--2", { dry: true, age_days: 30 })).body.plan;
		assert.deepStrictEqual([plan.need, plan.setup.age_days], [1, 30]);
		assert.deepStrictEqual(plan.warnings.slice(1), ["account age 30 days (the original: main 0, alt 30)", "the original was stopped early at 5 of 20 game min: the rerun runs the full 20 game min"]);
		assert.strictEqual((await L("two--2", { dry: true })).body.plan.setup.age_days, null);
		for (const bad of [{ age_days: -1 }, { age_days: 3651 }, { age_days: "x" }, { age_days: "1e3" }, { age_days: true }, { age_days: [5] }, { current_code: "yes" }, { duration: "30s" }, { seed: 0 }])
			assert.strictEqual((await L("any--1", { dry: true, ...bad })).code, 400, JSON.stringify(bad));
		// the launch: chronal run with the setup file, its env the dashboard's without its own keys, plus the live keys; the tag
		// with the current CODE's hash (chronal run --check first)
		const r = await L("any--1", { seed: 2, duration: "5m", age_days: 30, current_code: true });
		assert.strictEqual(r.code, 202, JSON.stringify(r.body));
		const key = r.body.launch.key;
		assert.deepStrictEqual([r.body.launch.args, r.body.launch.tag], [{ duration: "5m", seed: 2, code: "current", age_days: 30, warmup: null, world_age: null, ping: null, start: null }, "any s2 5m current c0ffee00 age 30d"]);
		const c = await until(async () => ((await s.get("/api/control")).body.launches.find((l) => l.key === key && l.state === "running") || null), 8000, "the launch to link");
		const run = byId(await s.live())[c.run];
		pid = run.proc.pid;
		assert.deepStrictEqual([run.tag, run.launch.rerun_of, run.ctl.stop], ["any s2 5m current c0ffee00 age 30d", "any--1", true]);
		const lines = (await s.get(`/api/launch/${key}/log`)).body.lines,
			argv = JSON.parse(lines.find((l) => l.startsWith("fake argv ")).slice(10)),
			env = JSON.parse(lines.find((l) => l.startsWith("fake runner ")).slice(12));
		assert.deepStrictEqual(argv, [file, "--duration", "5m", "--seed", "2", "--current-code", "--age-days", "30", "--tag", "any s2 5m current c0ffee00 age 30d"]);
		assert.deepStrictEqual([env.CHRONAL_LIVE_DIR, env.CHRONAL_LAUNCH_KEY, env.CHRONAL_RERUN_OF], [dir, key, "any--1"]);
		assert.strictEqual(env.CHRONAL_NO_BUILD, undefined);
		assert.strictEqual((await s.call("POST", `/api/runs/${c.run}/stop`, { body: {} })).code, 202);
		await until(async () => byId(await s.live())[c.run].state === "done", 5000, "the run to end");
	} finally {
		for (const [k, v] of Object.entries(keep)) v == null ? delete process.env[k] : (process.env[k] = v);
		if (pid) killOurs(pid, sim);
		await s.close();
	}
});


test("world knobs, sim: a run of a setup's warm-up, world age and ping (chronal run --warmup, --world-age, --ping), refusals", async () => {
	const dir = mkdir("wsim"),
		sim = checkout(),
		file = path.join(dir, "any--1.setup.json");
	setupRun(dir, "any--1", sideFile(), simSetupRun(sim)); // (warm-up 1m, no world age)
	// an aged world: its setup's world.age
	setupRun(dir, "aged--2", sideFile({ name: "any world 2h", world: { ...sideFile().world, age: "2h" } }), simSetupRun(sim));
	setupRun(dir, "pinged--8", sideFile({ name: "any ping 50", world: { ...sideFile().world, ping: 50 } }), simSetupRun(sim));
	const s = await serve({ dir, root: sim });
	const keep = process.env.CHRONAL_THREADS_MAX;
	process.env.CHRONAL_THREADS_MAX = "8";
	const L = (of, body) => s.call("POST", "/api/launch", { body: { of, dry: true, ...body } });
	let pid = null;
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual([w["any--1"].ctl.recorded, w["aged--2"].ctl.recorded], [{ warmup_ms: 60e3, age_ms: 0, ping: 18 }, { warmup_ms: 60e3, age_ms: 7200e3, ping: 18 }]);
		// the recorded ones pass nothing (an identical run); another warm-up: --warmup, not identical, not in the tag
		let r = await L("any--1", { warmup: "1m", world_age: "0" });
		assert.deepStrictEqual([r.code, r.body.plan.command.slice(3), r.body.plan.world, r.body.plan.warnings], [200, ["--duration", "20m", "--seed", "1"], { warmup_ms: 60e3, age_ms: 0, ping: 18, start: "2026-01-01T00:00:00Z" }, ["the stored CODE (the original's)", "same seed, stored CODE and duration: an identical run (deterministic)"]]);
		// the world's clock: --start, a warning; the same time in other words passes nothing; not a time: refused
		r = await L("any--1", { start: "2026-10-31T18:00Z" });
		assert.deepStrictEqual([r.body.plan.command.slice(-2), r.body.plan.world.start, r.body.plan.warnings.slice(-1)], [["--start", "2026-10-31T18:00Z"], "2026-10-31T18:00Z", ["the world's clock starts at 2026-10-31T18:00Z (the original: 2026-01-01T00:00:00Z)"]]);
		assert.deepStrictEqual((await L("any--1", { start: "2026-01-01T00:00Z" })).body.plan.command.slice(3), ["--duration", "20m", "--seed", "1"]);
		assert.strictEqual((await L("any--1", { start: "soon" })).code, 400);
		r = await L("any--1", { warmup: "5m" });
		assert.deepStrictEqual([r.body.plan.command.slice(3), r.body.plan.tag, r.body.plan.warnings], [["--duration", "20m", "--seed", "1", "--warmup", "5m"], "any", ["the stored CODE (the original's)", "warm-up 5m (the original: 1m)"]]);
		r = await L("any--1", { world_age: "2h", warmup: "0" });
		assert.deepStrictEqual([r.body.plan.command.slice(3), r.body.plan.tag, r.body.plan.world], [["--duration", "20m", "--seed", "1", "--warmup", "0m", "--world-age", "2h"], "any world 2h", { warmup_ms: 0, age_ms: 7200e3, ping: 18, start: "2026-01-01T00:00:00Z" }]);
		assert.deepStrictEqual(r.body.plan.warnings.slice(1), ["warm-up 0m (the original: 1m)", "world age 2h: the world runs 2h of game time with no characters before they log in, its monsters levelling up (the original: 0m)"]);
		// an aged one: its tag's world token replaced; 0 passed as 0m; the same age in other words passes nothing
		r = await L("aged--2", { world_age: "30m" });
		assert.deepStrictEqual([r.body.plan.command.slice(-2), r.body.plan.tag], [["--world-age", "30m"], "any world 30m"]);
		r = await L("aged--2", { world_age: "0m" });
		assert.deepStrictEqual([r.body.plan.command.slice(-2), r.body.plan.tag, r.body.plan.warnings.slice(-1)], [["--world-age", "0m"], "any world 0m", ["world age 0: the characters log in at once (the original: 2h)"]]);
		assert.deepStrictEqual((await L("aged--2", { world_age: "120" })).body.plan.command.slice(3), ["--duration", "20m", "--seed", "1"]);
		// ping: --ping N, a tag token and a warning
		r = await L("any--1", { ping: "5" });
		assert.deepStrictEqual([r.body.plan.command.slice(3), r.body.plan.tag, r.body.plan.world.ping, r.body.plan.warnings.slice(-1)], [["--duration", "20m", "--seed", "1", "--ping", "5"], "any ping 5", 5, ["ping 5 ms: the round trip to the server (the original: 18 ms)"]]);
		// its setup's world.ping: recorded; the same passes nothing, another replaces the tag's token
		assert.strictEqual(w["pinged--8"].ctl.recorded.ping, 50);
		assert.deepStrictEqual((await L("pinged--8", { ping: 50 })).body.plan.command.slice(3), ["--duration", "20m", "--seed", "1"]);
		r = await L("pinged--8", { ping: 18 });
		assert.deepStrictEqual([r.body.plan.command.slice(-2), r.body.plan.tag, r.body.plan.warnings.slice(-1)], [["--ping", "18"], "any ping 18", ["ping 18 ms: the round trip to the server (the original: 50 ms)"]]);
		for (const bad of [0, -3, 1001, "x"]) assert.strictEqual((await L("any--1", { ping: bad })).code, 400, String(bad));
		for (const [of, body, reason] of [
			["any--1", { warmup: "2d" }, 'warmup "2d": 0 to 1 day of game time, e.g. 90s, 2m, 1h, or a number of minutes'],
			["any--1", { world_age: "8d" }, 'world_age "8d": 0 to 7 days of game time, e.g. 30m, 2h, 1d, or a number of minutes'],
			["any--1", { world_age: "soon" }, 'world_age "soon": 0 to 7 days of game time, e.g. 30m, 2h, 1d, or a number of minutes'],
		])
			assert.deepStrictEqual([(await L(of, body)).code, (await L(of, body)).body.reason], [400, reason], JSON.stringify(body));
		// the launch: chronal run gets them, the launch's args and tag say them
		r = await s.call("POST", "/api/launch", { body: { of: "any--1", world_age: "2h", warmup: "3m" } });
		assert.deepStrictEqual([r.code, r.body.launch.args, r.body.launch.tag], [202, { duration: "20m", seed: 1, code: "stored", age_days: null, warmup: "3m", world_age: "2h", ping: null, start: null }, "any world 2h"]);
		const key = r.body.launch.key;
		const c = await until(async () => ((await s.get("/api/control")).body.launches.find((l) => l.key === key && l.state === "running") || null), 8000, "the launch to link");
		pid = byId(await s.live())[c.run].proc.pid;
		const argv = JSON.parse((await s.get(`/api/launch/${key}/log`)).body.lines.find((l) => l.startsWith("fake argv ")).slice(10));
		assert.deepStrictEqual(argv, [file, "--duration", "20m", "--seed", "1", "--warmup", "3m", "--world-age", "2h", "--tag", "any world 2h"]);
		assert.strictEqual((await s.call("POST", `/api/runs/${c.run}/stop`, { body: {} })).code, 202);
		await until(async () => byId(await s.live())[c.run].state === "done", 5000, "the run to end");
	} finally {
		keep == null ? delete process.env.CHRONAL_THREADS_MAX : (process.env.CHRONAL_THREADS_MAX = keep);
		if (pid) killOurs(pid, sim);
		await s.close();
	}
});


test("--gc-code: deletes the CODE no setup file (live dir or removed/) uses; keeps fresh blobs; an unreadable setup file stops it", () => {
	const dir = mkdir("gc"),
		store = path.join(dir, "code"),
		blob = (c) => c.repeat(16),
		old = (Date.now() - 3600e3) / 1000;
	fs.mkdirSync(store);
	fs.mkdirSync(path.join(dir, "removed"));
	const a = sideFile({ characters: [{ ...sideFile().characters[0], code: { entry: "x", slots: blob("1"), text: blob("2"), hash: "0" } }] }),
		b = sideFile({ characters: [{ ...sideFile().characters[0], code: { entry: "x", slots: blob("3"), text: blob("2"), hash: "0" } }] });
	fs.writeFileSync(path.join(dir, "a--1.setup.json"), JSON.stringify(a));
	fs.writeFileSync(path.join(dir, "removed/b--2.setup.json"), JSON.stringify(b));
	for (const f of [blob("1") + ".json", blob("2") + ".js", blob("3") + ".json", blob("4") + ".json", blob("5") + ".js", blob("6") + ".js", "notes.txt"]) {
		fs.writeFileSync(path.join(store, f), "x".repeat(100));
		if (f !== blob("6") + ".js") fs.utimesSync(path.join(store, f), old, old);
	}
	const { gcCode } = require("../dashboard/server");
	const r = gcCode(dir);
	assert.deepStrictEqual([r.deleted, r.kept, r.bytes, r.files.sort()], [2, 4, 200, [blob("4") + ".json", blob("5") + ".js"]]);
	assert.deepStrictEqual(fs.readdirSync(store).sort(), [blob("1") + ".json", blob("2") + ".js", blob("3") + ".json", blob("6") + ".js", "notes.txt"].sort());
	// the CLI; an unreadable setup file: nothing deleted
	fs.writeFileSync(path.join(store, blob("7") + ".js"), "x");
	fs.utimesSync(path.join(store, blob("7") + ".js"), old, old);
	fs.writeFileSync(path.join(dir, "bad--3.setup.json"), "{nope");
	let p = spawnSync(process.execPath, [path.join(__dirname, "../chronal.js"), "dash", "--gc-code", "--dir", dir], { encoding: "utf8" });
	assert.deepStrictEqual([p.status, /can't read .*bad--3\.setup\.json: nothing deleted/.test(p.stderr), fs.existsSync(path.join(store, blob("7") + ".js"))], [1, true, true]);
	fs.rmSync(path.join(dir, "bad--3.setup.json"));
	p = spawnSync(process.execPath, [path.join(__dirname, "../chronal.js"), "dash", "--gc-code", "--dir", dir], { encoding: "utf8" });
	assert.deepStrictEqual([p.status, p.stdout.trim(), fs.existsSync(path.join(store, blob("7") + ".js"))], [0, `${store}: deleted 1 unused CODE files (0 KB), kept 4`, false]);
});

test("config: the live dir and the game from lib/config.js when not given (CHRONAL_LIVE_DIR, CHRONAL_AL_ROOT)", async () => {
	const dir = mkdir("cfg"),
		keep = { CHRONAL_LIVE_DIR: process.env.CHRONAL_LIVE_DIR, CHRONAL_AL_ROOT: process.env.CHRONAL_AL_ROOT };
	snap(dir, "cfg--1", { done: true });
	Object.assign(process.env, { CHRONAL_LIVE_DIR: dir, CHRONAL_AL_ROOT: TMP });
	try {
		const s = await serve({ appDir: undefined, root: undefined });
		try {
			assert.deepStrictEqual((await s.live()).map((w) => w.id), ["cfg--1"]);
		} finally {
			await s.close();
		}
	} finally {
		for (const [k, v] of Object.entries(keep)) v == null ? delete process.env[k] : (process.env[k] = v);
	}
});

test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));


test("api/rec sheet: a recorded character's sheet at a moment (gear, stats, conditions from its last player packet); 404 before one or without a recording; 400 without v", async () => {
	const dir = mkdir("recsheet"),
		sim = checkout();
	setupRun(dir, "bench--1", sideFile({ name: "bench" }), simSetupRun(sim));
	const { Recorder } = require("../lib/rec"),
		r = new Recorder(path.join(dir, "bench--1.rec"), "Ran1");
	r.add(1000, "p", JSON.stringify(["start", { map: "main", in: "main", x: 0, y: 0 }]));
	r.add(1500, "p", JSON.stringify(["game_log", { message: "You killed a Goo" }]));
	r.add(2000, "p", JSON.stringify(["player", { level: 60, xp: 5, max_xp: 10, ctype: "ranger", attack: 488, frequency: 0.85, rip: false, s: { mluck: { ms: 900 } }, slots: { mainhand: { name: "bow", level: 7, stat_type: "dex" }, helmet: null }, skin: "x", items: [{ name: "hpot0", q: 5, gf: 1 }, null], esize: 41 }]));
	r.close();
	const s = await serve({ dir, root: sim });
	try {
		let x = await s.get("/api/rec/bench--1/Ran1/sheet?v=2500");
		assert.deepStrictEqual([x.code, x.body.at, x.body.type, x.body.gear, x.body.gear_stat, x.body.stats, x.body.s], [200, 2000, "ranger", { mainhand: "bow+7" }, { mainhand: "dex" }, { attack: 488, frequency: 0.85 }, { mluck: { ms: 900 } }]);
		assert.deepStrictEqual([x.body.items, x.body.free, x.body.log], [[{ name: "hpot0", q: 5 }, null], 41, [[1500, "log", "You killed a Goo"]]]);
		assert.strictEqual((await s.get("/api/rec/bench--1/Ran1/sheet?v=1500")).code, 404);
		assert.strictEqual((await s.get("/api/rec/bench--1/Pri1/sheet?v=2500")).code, 404);
		assert.strictEqual((await s.get("/api/rec/bench--1/Ran1/sheet")).code, 400);
	} finally {
		await s.close();
	}
});

test("folders: runs one level down are <folder>/<id> (not removed/, code/, logs/, a run's .rec/.state, deeper); requests, files and removal by that id; ../ never", async () => {
	const dir = mkdir("folders"),
		fid = path.join(dir, "fid");
	fs.mkdirSync(fid);
	snap(dir, "top--1", { proc: ME });
	snap(fid, "a--2", { proc: ME, control: ctlOf("a--2") });
	snap(fid, "b--3", { done: true, end: { reason: "complete" }, grid: { gen: 0 } });
	fs.writeFileSync(path.join(fid, "b--3.setup.json"), JSON.stringify({ name: "b" }));
	fs.writeFileSync(path.join(fid, "b--3.grid.ndjson"), '{"h":1}\n');
	fs.mkdirSync(path.join(fid, "b--3.rec"));
	for (const f of ["Ran1.rec.idx", "Ran1.rec.gz"]) fs.writeFileSync(path.join(fid, "b--3.rec", f), "x");
	for (const d of ["removed", "code", "logs", "top--1.state", "fid/deeper", "fid/removed"]) fs.mkdirSync(path.join(dir, d), { recursive: true });
	for (const d of ["removed", "code", "logs", "top--1.state", "fid/deeper", "fid/removed"]) snap(path.join(dir, d), "no--9");
	fs.writeFileSync(path.join(dir, "..", "esc--1.setup.json"), "{}"); // beside the live dir: never served
	const s = await serve({ dir });
	try {
		const w = byId(await s.live());
		assert.deepStrictEqual(Object.keys(w).sort(), ["fid/a--2", "fid/b--3", "top--1"]);
		assert.deepStrictEqual([w["fid/a--2"].state, w["fid/a--2"].ctl.stop, w["fid/b--3"].rec], ["running", true, ["Ran1"]]);
		// by its id as the page sends it (encoded)
		let r = await s.call("POST", "/api/runs/fid%2Fa--2/stop");
		assert.deepStrictEqual([r.code, r.body], [202, { seq: 1 }]);
		assert.strictEqual(read(path.join(fid, "a--2.ctl")).stop, true);
		assert.ok(!fs.existsSync(path.join(dir, "a--2.ctl")));
		assert.strictEqual(byId(await s.live())["fid/a--2"].ctl.pending.stop, true);
		r = await s.get("/api/setup/fid%2Fb--3?download=1");
		assert.deepStrictEqual([r.code, r.body, r.headers["content-disposition"]], [200, { name: "b" }, 'attachment; filename="b--3.setup.json"']);
		r = await s.get("/api/grid/fid%2Fb--3");
		assert.deepStrictEqual([r.code, r.body.text], [200, '{"h":1}\n']);
		r = await s.get("/replay/fid%2Fb--3/Ran1");
		assert.strictEqual(r.code, 302);
		assert.match(r.headers.location, /chronal_replay=fid%2Fb--3/);
		for (const p of ["/api/setup/..%2Fesc--1", "/api/setup/../esc--1", "/api/grid/..%2Fesc--1", "/replay/..%2Fesc--1/Ran1", "/api/setup/fid%2F..%2F..%2Fesc--1"]) assert.strictEqual((await s.get(p)).code, 404, p);
		assert.strictEqual((await s.call("POST", "/api/runs/..%2Ftop--1/stop")).code, 404);
		// removed: to the folder's own removed/, its setup still served from there
		r = await s.call("DELETE", "/api/live/fid%2Fb--3");
		assert.deepStrictEqual([r.code, r.body], [200, { removed: "fid/b--3" }]);
		assert.deepStrictEqual(fs.readdirSync(path.join(fid, "removed")).sort(), ["b--3.grid.ndjson", "b--3.json", "b--3.rec", "b--3.setup.json", "no--9.json"]);
		assert.deepStrictEqual(Object.keys(byId(await s.live())).sort(), ["fid/a--2", "top--1"]);
		assert.deepStrictEqual((await s.get("/api/setup/fid%2Fb--3")).body, { name: "b" });
	} finally {
		await s.close();
		fs.rmSync(path.join(dir, "..", "esc--1.setup.json"), { force: true });
	}
	// --gc-code: each folder's CODE store against its own setup files
	const blob = (c) => c.repeat(16),
		old = (Date.now() - 3600e3) / 1000;
	for (const d of [dir, fid]) {
		fs.mkdirSync(path.join(d, "code"), { recursive: true });
		fs.writeFileSync(path.join(d, "code", blob("a") + ".js"), "x");
		fs.utimesSync(path.join(d, "code", blob("a") + ".js"), old, old);
	}
	fs.writeFileSync(path.join(fid, "removed", "b--3.setup.json"), JSON.stringify(sideFile())); // (a setup file gc reads)
	const p = spawnSync(process.execPath, [path.join(__dirname, "../chronal.js"), "dash", "--gc-code", "--dir", dir], { encoding: "utf8" });
	assert.deepStrictEqual([p.status, p.stdout.trim().split("\n")], [0, [`${path.join(dir, "code")}: deleted 1 unused CODE files (0 KB), kept 0`, `${path.join(fid, "code")}: deleted 1 unused CODE files (0 KB), kept 0`]]);
});
