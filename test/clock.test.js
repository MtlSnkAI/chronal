"use strict";
// vclock.js timers: a page's setInterval keeps its nominal cadence (a browser's), a Node context's restarts from each
// callback (it drifts by the firings' lateness); sim.js lockstepWindow: the window a ping gives.
//   node --test test/clock.test.js
const test = require("node:test"),
	assert = require("node:assert/strict"),
	vm = require("node:vm");
const { VirtualClock } = require("../sim/vclock");
const { lockstepWindow } = require("../sim/sim");

async function firings(profile, delay, n) {
	const clock = new VirtualClock({ seed: 3 }),
		ctx = vm.createContext({}),
		t0 = clock.now,
		at = [];
	clock.installInto(ctx, { profile });
	ctx.setInterval(() => at.push(clock.now - t0), delay);
	await clock.run({ forMs: delay * n * 1.1 });
	return at.slice(0, n);
}

test("setInterval: a page keeps the nominal cadence, Node drifts by each firing's lateness", async () => {
	const page = await firings("browser", 100, 50);
	page.forEach((t, i) => assert.ok(t >= (i + 1) * 100 + 1 && t <= (i + 1) * 100 + 3, `page firing ${i}: ${t}`));
	const node = await firings("node", 100, 50);
	// 1-3 ms late each time, and each period starts from the last firing
	for (let i = 1; i < node.length; i++) assert.ok(node[i] - node[i - 1] >= 101 && node[i] - node[i - 1] <= 103, `node period ${i}`);
	assert.ok(node[49] >= 5000 + 50, `node drifted: ${node[49]}`);
});

test("setInterval: a page's interval shorter than its lateness restarts from the firing (a missed period), never fires twice at once", async () => {
	const page = await firings("browser", 1, 40);
	for (let i = 1; i < page.length; i++) assert.ok(page[i] > page[i - 1], `firing ${i}: ${page[i - 1]} -> ${page[i]}`);
});

test("lockstepWindow: the largest whole ms at most the minimum latency that divides a game minute, else 1/2^n ms", () => {
	assert.deepEqual([20, 7.2, 3.6, 2, 1.2, 0.8, 0.3].map(lockstepWindow), [20, 6, 3, 2, 1, 0.5, 0.25]);
	for (const lo of [20, 7.2, 3.6, 1.2, 0.8]) assert.equal(60_000 % lockstepWindow(lo), 0, String(lo));
});
