"use strict";
// live.js: a stand's sale (trade_buy) and a buy order filled (trade_sell) are recorded: an items' event each, the
// seller's and buyer's ledgers (stand_sold, stand_bought), the gold flows (stand in, traded out); live_check holds.
//   node --test test/trade.test.js      (needs the game: config al_root)
const test = require("node:test"),
	assert = require("node:assert/strict"),
	fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	{ spawnSync } = require("node:child_process");
const { config } = require("../lib/config");
const ROOT = config().al_root,
	skip = !fs.existsSync(path.join(ROOT, "design")) && "no game at " + ROOT;

test("trades: a stand sale and a buy order filled: events, ledgers, gold flows; live_check passes", { skip, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "trade-test-"));
	try {
		const idle = path.join(d, "idle.js"),
			buyer = path.join(d, "buyer.js");
		fs.writeFileSync(idle, "");
		fs.writeFileSync(buyer, 'setTimeout(() => { parent.socket.emit("trade_buy", { id: "Mer", slot: "trade1", q: 3 }); parent.socket.emit("trade_sell", { id: "Mer", slot: "trade2", q: 5 }); }, 5000);');
		const setup = path.join(d, "setup.json");
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "trades", run: { duration: "30s" },
			accounts: { a: {}, b: {} },
			characters: [
				{ name: "Mer", class: "merchant", account: "a", at: "main:0:0", code: { file: idle }, state: { level: 30, gold: 1000, slots: { trade1: { name: "hpot0", q: 10, price: 50, rid: "s1" }, trade2: { name: "mpot0", q: 5, price: 30, b: true, rid: "w1" } } } },
				{ name: "Buy", class: "ranger", account: "b", at: "main:10:0", code: { file: buyer }, state: { level: 30, gold: 5000, items: [{ name: "mpot0", q: 20 }] } },
			],
		}));
		const live = path.join(d, "live"),
			res = path.join(d, "r.json");
		const r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", live, "--result", res, "--no-build", "--no-export"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const file = JSON.parse(fs.readFileSync(res, "utf8")).live,
			snap = JSON.parse(fs.readFileSync(file, "utf8")),
			ev = fs.readFileSync(path.join(live, snap.items_log.file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.k === "trade");
		const strip = ({ t, ...e }) => e;
		assert.deepEqual(ev.map(strip), [
			{ k: "trade", who: "Mer", to: "Buy", item: "hpot0", q: 3, price: 150, tax: ev[0].tax, via: "stand" },
			{ k: "trade", who: "Buy", to: "Mer", item: "mpot0", q: 5, price: 150, tax: ev[1].tax, via: "wish" },
		]);
		const P = (n) => snap.players.find((p) => p.name === n);
		const mer = P("Mer"),
			buy = P("Buy");
		assert.deepEqual(mer.items.stand_sold.hpot0, { q: 3, gold: 150 - ev[0].tax, tax: ev[0].tax });
		assert.deepEqual(mer.items.stand_bought.mpot0, { q: 5, gold: 150 });
		assert.deepEqual(buy.items.stand_bought.hpot0, { q: 3, gold: 150 });
		assert.deepEqual(buy.items.stand_sold.mpot0, { q: 5, gold: 150 - ev[1].tax, tax: ev[1].tax });
		assert.equal(mer.gold_flow.stand, 150 - ev[0].tax);
		assert.equal(mer.gold_flow.traded, 150);
		assert.equal(buy.gold_flow.traded, 150);
		assert.equal(buy.gold_flow.bought, 0);
		const lc = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "live_check.js"), file, "--quiet"], { encoding: "utf8" });
		assert.equal(lc.status, 0, lc.stdout + lc.stderr);
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});

// trade offers: the game from 98783128 (its CODE's trade_offer and trade_swap)
const offers = !skip && !/function trade_swap\b/.test(fs.readFileSync(path.join(ROOT, "js", "runner_functions.js"), "utf8")) && "this game has no trade offers (from 98783128)";
test("a trade offer taken (trade_swap): one event (via swap, what was paid), both ledgers (stand_swapped_out, stand_swapped_in), no gold; live_check passes", { skip: skip || offers, timeout: 180000 }, () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "swap-test-"));
	try {
		const stand = path.join(d, "stand.js"),
			taker = path.join(d, "taker.js");
		// (a listing is out of reach while its stand is closed)
		fs.writeFileSync(stand, "setTimeout(() => open_stand(), 1000);");
		fs.writeFileSync(taker, 'setTimeout(() => trade_swap(get_player("Mer"), "trade1", 0), 5000);');
		const setup = path.join(d, "setup.json");
		fs.writeFileSync(setup, JSON.stringify({
			format: "chronal-setup/1", name: "offers", run: { duration: "30s" },
			accounts: { a: {}, b: {} },
			characters: [
				{ name: "Mer", class: "merchant", account: "a", at: "main:0:0", code: { file: stand }, state: { level: 30, gold: 1000, items: [{ name: "stand0" }], slots: { trade1: { name: "wbook0", q: 1, price: 0, want: { name: "hpot0", q: 5 }, rid: "o1" } } } },
				{ name: "Tak", class: "ranger", account: "b", at: "main:10:0", code: { file: taker }, state: { level: 30, gold: 5000, items: [{ name: "hpot0", q: 20 }] } },
			],
		}));
		const live = path.join(d, "live"),
			res = path.join(d, "r.json");
		const r = spawnSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", setup, "--live", live, "--result", res, "--no-build", "--no-export"], { encoding: "utf8" });
		assert.equal(r.status, 0, r.stderr);
		const file = JSON.parse(fs.readFileSync(res, "utf8")).live,
			snap = JSON.parse(fs.readFileSync(file, "utf8")),
			ev = fs.readFileSync(path.join(live, snap.items_log.file), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((e) => e.k === "trade");
		assert.deepEqual(ev.map(({ t, ...e }) => e), [{ k: "trade", who: "Mer", to: "Tak", item: "wbook0", q: 1, price: 0, tax: 0, via: "swap", for: { item: "hpot0", q: 5 } }]);
		const P = (n) => snap.players.find((p) => p.name === n);
		assert.deepEqual(P("Mer").items.stand_swapped_out, { wbook0: { q: 1, for: { hpot0: 5 } } });
		assert.deepEqual(P("Tak").items.stand_swapped_in, { wbook0: { q: 1, for: { hpot0: 5 } } });
		assert.deepEqual([P("Mer").gold_flow.stand, P("Tak").gold_flow.traded], [0, 0]);
		assert.deepEqual(snap.hook_errors, {});
		const lc = spawnSync(process.execPath, [path.join(__dirname, "..", "tools", "live_check.js"), file, "--quiet"], { encoding: "utf8" });
		assert.equal(lc.status, 0, lc.stdout + lc.stderr);
	} finally {
		fs.rmSync(d, { recursive: true, force: true });
	}
});
