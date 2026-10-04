"use strict";
// live.js wrap(): the server hooks on a fake server context (no game needed).
//   node --test test/live_hooks.test.js
const test = require("node:test"),
	assert = require("node:assert/strict");
const { Live } = require("../sim/live");

// a Live with only what the hooks under test read, wrapped around S
function wrapped(S) {
	const live = { mx: { A: { casts: {} } }, req: null, merchant: { per_fighter: {} } };
	Live.prototype.wrap.call(live, S);
	return live;
}

test("casts: a skill's reuse call (invis on reappearing, a pickpocket/fishing/mining success) is not another cast", () => {
	const calls = [],
		S = { G: {}, consume_skill: (p, name, reuse) => calls.push([name, !!reuse]) },
		live = wrapped(S),
		A = { name: "A" };
	S.consume_skill(A, "invis");
	S.consume_skill(A, "invis", true);
	S.consume_skill(A, "fishing");
	S.consume_skill(A, "fishing", true);
	S.consume_skill(A, "quickstab");
	assert.deepEqual(live.mx.A.casts, { invis: 1, fishing: 1, quickstab: 1 });
	assert.equal(calls.length, 5); // the server's own calls all happen
});
