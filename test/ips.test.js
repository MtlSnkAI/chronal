"use strict";
// accounts.<k>.ip: accounts of one label play from one IP (default "local", 127.0.0.1); another label is another IP:
// the server's is_same() tells them apart (merchant trade xp, the send-gold fee, aggro), and the per-IP fighter limit
// counts each IP's own.
//   node --test test/ips.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path");
const S = require("../lib/setup");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

const dirs = [],
	tmp = () => (dirs.push(fs.mkdtempSync(path.join(os.tmpdir(), "ips-test-"))), dirs[dirs.length - 1]);
test.after(() => {
	for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});
const setupOf = (d, o) => {
	const f = path.join(d, "setup.json");
	fs.writeFileSync(f, JSON.stringify({ format: "chronal-setup/1", name: "ips", ...o }));
	return f;
};

test("the per-IP fighter limit counts each ip label's own; a bad label is a problem", () => {
	const d = tmp(),
		idle = path.join(__dirname, "..", "codes", "idle.js"),
		f = (n, acc) => Array.from({ length: n }, (_, i) => ({ name: acc + i, class: "ranger", account: acc, code: { file: idle } }));
	S.loadSetup(setupOf(d, { accounts: { a: {}, b: { ip: "other" } }, characters: [...f(3, "a"), ...f(3, "b")] })); // 3 per IP
	assert.throws(() => S.loadSetup(setupOf(d, { accounts: { a: {}, b: {} }, characters: [...f(3, "a"), ...f(1, "b")] })), /b0 would be refused/);
	assert.throws(() => S.loadSetup(setupOf(d, { accounts: { a: { ip: "a b" } }, characters: f(1, "a") })), /accounts\.a\.ip/);
});

test("ip labels on a real sim: one label is_same, another not; a trade with another IP's player gives the merchant xp", { skip, timeout: 180000 }, async () => {
	const { startSetup } = require("../sim/start");
	const d = tmp(),
		idle = path.join(d, "idle.js"),
		buyer = path.join(d, "buyer.js");
	fs.writeFileSync(idle, "");
	fs.writeFileSync(buyer, 'setTimeout(() => parent.socket.emit("trade_buy", { id: "Mer", slot: "trade1", q: 2 }), 3000);');
	const { resolved, bundles } = S.resolveSetup(S.loadSetup(setupOf(d, {
		accounts: { me: {}, me2: {}, them: { ip: "them" } },
		characters: [
			{ name: "Mer", class: "merchant", account: "me", at: "main:0:0", code: { file: idle }, state: { level: 30, slots: { trade1: { name: "hpot0", q: 10, price: 1000 } } } },
			{ name: "Alt", class: "ranger", account: "me2", at: "main:20:0", code: { file: idle } },
			{ name: "Buy", class: "ranger", account: "them", at: "main:10:0", code: { file: buyer }, state: { gold: 10000 } },
		],
	})), { build: false });
	const { sim } = await startSetup(resolved, bundles, { live: false });
	try {
		const P = (n) => Object.values(sim.server.players).find((p) => p.name === n);
		const xp0 = P("Mer").xp;
		await sim.run(8000);
		assert.equal(sim.server.is_same(P("Mer"), P("Alt")), true, "one IP");
		assert.equal(sim.server.is_same(P("Mer"), P("Buy")), false, "another IP");
		assert.equal(P("Buy").socket.handshake.address, "10.1.0.1");
		const tax = 2000 - Math.round(2000 * (1 - P("Mer").tax));
		assert.equal(P("Mer").xp - xp0, tax * 3.2, "merchant trade xp");
	} finally {
		await sim.close();
	}
});
