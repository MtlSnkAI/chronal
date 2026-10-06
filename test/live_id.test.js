"use strict";
// live.js reserveId(): a run's id is its tag and start ms, or the next free ms; never a running or a removed run's.
//   node --test test/live_id.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawn } = require("node:child_process");
const { reserveId } = require("../sim/live");

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "live-id-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

test("run ids: the same tag in the same ms from 8 processes -> 8 distinct ids; a removed run's id is skipped", async () => {
	const dir = tmp(),
		live = path.join(__dirname, "..", "sim", "live.js");
	const one = () =>
		new Promise((done, fail) => {
			let out = "";
			const p = spawn(process.execPath, ["-e", `process.stdout.write(require(${JSON.stringify(live)}).reserveId(${JSON.stringify(dir)}, "x", 1000))`]);
			p.stdout.on("data", (d) => (out += d));
			p.on("exit", (code) => (code === 0 ? done(out) : fail(new Error("exit " + code))));
		});
	const ids = await Promise.all(Array.from({ length: 8 }, one));
	assert.deepEqual([...ids].sort(), Array.from({ length: 8 }, (_, i) => "x--" + (1000 + i)).sort());
	for (const id of ids) assert.ok(fs.existsSync(path.join(dir, id + ".json")));
	fs.mkdirSync(path.join(dir, "removed"));
	fs.writeFileSync(path.join(dir, "removed", "x--5.json"), "{}");
	assert.equal(reserveId(dir, "x", 5), "x--6");
	assert.equal(reserveId(dir, "x", 5), "x--7");
});
