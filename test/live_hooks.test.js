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

test("census: a trade slot's buy order (b: true) is not an item held; a listed item is", () => {
	const p = { items: [{ name: "hpot0", q: 5 }, null], slots: { trade1: { name: "coat", q: 2, price: 9, b: true }, trade2: { name: "bow", level: 3, price: 5 }, mainhand: { name: "blade", level: 0 } } };
	assert.deepEqual(Live.prototype.census.call({}, p), { hpot0: 5, bow: 1, blade: 1 });
});

test("upgrade events: an ingot's roll with no scroll is a shiny event at the item's level, not a +1 upgrade", () => {
	const events = [],
		run = (p) => {
			const m = { items: { upgraded: {}, compounded: {} } };
			Live.prototype.closeReq.call({ req: { p, m, method: "upgrade", ours: [], g: [], qu: null, pot: null, used: null }, sim: { server: {} }, G: { skills: {} }, itemEvent: (e) => events.push(e) });
			return m;
		};
	const ph = (scroll, offering) => [{ name: "placeholder", p: { scroll, offering, name: "blade", level: 3 } }];
	const shiny = run({ name: "M", q: { upgrade: { num: 0 } }, items: ph(null, "goldingot"), p: { u_type: "normal", u_item: { name: "blade", level: 3, p: "shiny" } } });
	run({ name: "M", q: { upgrade: { num: 0 } }, items: ph(null, "goldnugget"), p: { u_type: "normal", u_item: { name: "blade", level: 3 }, u_fail: true } });
	run({ name: "M", q: { upgrade: { num: 0 } }, items: ph("scroll0", null), p: { u_type: "normal", u_item: { name: "blade", level: 4 } } });
	assert.deepEqual(events, [
		{ k: "shiny", who: "M", item: "blade", level: 3, offering: "goldingot", ok: true },
		{ k: "shiny", who: "M", item: "blade", level: 3, offering: "goldnugget", ok: false },
		{ k: "upgrade", who: "M", item: "blade", from: 3, to: 4, ok: true },
	]);
	assert.deepEqual(shiny.items.upgraded, {}); // (not an upgrade try)
});
