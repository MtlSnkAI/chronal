"use strict";
// rec.js: the recorder's members (each one's "S" state = everything before it folded) and fold()
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs"),
	os = require("node:os"),
	path = require("node:path"),
	zlib = require("node:zlib");
const { Recorder, fold, emptyState, readIndex, recordingsOf, playerAt, logAt } = require("../lib/rec");

const p = (name, data) => JSON.stringify([name, data]);
const ent = (type, players, monsters) => p("entities", { type, in: "main", map: "main", players, monsters });

test("fold: a start's entities, deltas merged per id, gone on death, disappear or dead; chests; an entities 'all' starts over; the last player packet and move", () => {
	const st = emptyState();
	fold(st, 1, "p", p("start", { map: "main", in: "main", x: 10, y: 20, m: 3, entities: { type: "all", players: [{ id: "Bob", x: 1 }], monsters: [{ id: "7", type: "goo", hp: 100, x: 5 }] } }));
	fold(st, 2, "p", ent("xy", [], [{ id: "7", x: 6, events: [["hit", {}]] }, { id: "8", type: "goo", hp: 90 }]));
	fold(st, 3, "p", p("death", { id: "8" }));
	fold(st, 4, "p", p("drop", { id: "c1", x: 1, y: 2 }));
	fold(st, 5, "p", p("drop", { id: "c2", x: 1, y: 2 }));
	fold(st, 6, "p", p("chest_opened", { id: "c1" }));
	fold(st, 7, "p", p("player", { x: 11 }));
	fold(st, 8, "P", p("move", { x: 11, going_x: 50 }));
	fold(st, 9, "P", p("attack", { id: "7" })); // not a move: ignored
	fold(st, 10, "p", ent("xy", [], [{ id: "9", dead: true }]));
	fold(st, 11, "p", p("entities", { type: "xy", in: "elsewhere", players: [{ id: "Zed" }], monsters: [] })); // another instance: stale
	assert.deepStrictEqual(st.map, { name: "main", in: "main", x: 10, y: 20, m: 3 });
	assert.deepStrictEqual(st.ents.monsters, { 7: { id: "7", type: "goo", hp: 100, x: 6, _at: 2 } });
	assert.deepStrictEqual(Object.keys(st.ents.players), ["Bob"]);
	assert.deepStrictEqual(Object.keys(st.chests), ["c2"]);
	assert.deepStrictEqual([st.player, st.move], [[7, p("player", { x: 11 })], [8, p("move", { x: 11, going_x: 50 })]]);
	fold(st, 12, "p", p("disappear", { id: "Bob" }));
	fold(st, 13, "p", ent("all", [], [{ id: "20", type: "bee" }]));
	assert.deepStrictEqual([Object.keys(st.ents.players), Object.keys(st.ents.monsters)], [[], ["20"]]);
	fold(st, 14, "p", p("new_map", { name: "cave", in: "cave", x: 0, y: 0, entities: { type: "all", players: [], monsters: [] } }));
	assert.deepStrictEqual([st.map.name, Object.keys(st.ents.monsters)], ["cave", []]);
});

test("Recorder: gzip members of member_ms each, an index line per member; each member's S line is the state folded from everything before it", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-test-"));
	try {
		const r = new Recorder(path.join(dir, "run--1.rec"), "Ran1", { memberMs: 1000 }),
			recs = [[100, "a", "sock1"], [120, "p", p("start", { map: "main", in: "main", x: 0, y: 0, entities: { type: "all", players: [], monsters: [] } })]];
		for (let t = 200; t < 3500; t += 100) recs.push([t, "p", ent("xy", [], [{ id: String(t % 700), type: "goo", x: t }])], [t + 10, "P", p("move", { x: t, going_x: t + 5 })]);
		recs.push([3400, "p", p("death", { id: "0" })], [3450, "p", p("player", { x: 1 })]);
		for (const [at, k, d] of recs) r.add(at, k, d);
		r.close();
		assert.deepStrictEqual(recordingsOf(dir, "run--1"), ["Ran1"]);
		const { header, members } = readIndex(path.join(dir, "run--1.rec", "Ran1.rec.idx"));
		assert.deepStrictEqual([header.format, header.name, header.member_ms], ["chronal-rec/1", "Ran1", 1000]);
		assert.deepStrictEqual(members.map((m) => m.first), [100, 1100, 2100, 3100]);
		const gz = fs.readFileSync(path.join(dir, "run--1.rec", "Ran1.rec.gz"));
		assert.strictEqual(members.reduce((a, m) => a + m.len, 0), gz.length);
		let seen = 0;
		for (const m of members) {
			const lines = zlib.gunzipSync(gz.subarray(m.off, m.off + m.len)).toString("utf8").split("\n").filter(Boolean);
			const [at, k, s] = lines[0].split("\t");
			assert.deepStrictEqual([Number(at), k], [m.first, "S"]);
			const want = emptyState();
			for (const [a, kk, d] of recs.slice(0, seen)) fold(want, a, kk, d);
			assert.deepStrictEqual(JSON.parse(s), JSON.parse(JSON.stringify(want)));
			const rest = lines.slice(1).map((l) => { const i = l.indexOf("\t"), j = l.indexOf("\t", i + 1); return [Number(l.slice(0, i)), l.slice(i + 1, j), l.slice(j + 1)]; });
			assert.deepStrictEqual(rest, recs.slice(seen, seen + rest.length));
			assert.strictEqual(m.last, Math.max(...rest.map((x) => x[0])));
			seen += rest.length;
		}
		assert.strictEqual(seen, recs.length);
		r.add(4000, "p", p("player", {})); // after close: nothing
		assert.strictEqual(readIndex(path.join(dir, "run--1.rec", "Ran1.rec.idx")).members.length, 4);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("playerAt: the last player packet at a moment, from its member (the S line's before the member's first), a few ms out of order; null before any", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-at-"));
	try {
		const rd = path.join(dir, "run--1.rec"),
			r = new Recorder(rd, "Ran1", { memberMs: 1000 });
		r.add(100, "p", p("start", { map: "main", in: "main", x: 0, y: 0 }));
		r.add(500, "p", p("player", { attack: 1 }));
		r.add(1200, "p", ent("xy", [], []));
		r.add(1600, "p", p("player", { attack: 2 }));
		r.add(1590, "p", p("player", { attack: 3 })); // arrived after, stamped before
		r.close();
		const cache = new Map();
		assert.deepStrictEqual([50, 499, 500, 1199, 1595, 5000].map((v) => playerAt(rd, "Ran1", v, cache)), [null, null, [500, { attack: 1 }], [500, { attack: 1 }], [1590, { attack: 3 }], [1600, { attack: 2 }]]);
		assert.strictEqual(cache.size, 2);
		assert.throws(() => playerAt(rd, "Nobody", 1000), { code: "ENOENT" });
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("logAt: the last n game log and chat lines at a moment, across members, in time order", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-log-"));
	try {
		const rd = path.join(dir, "run--1.rec"),
			r = new Recorder(rd, "Ran1", { memberMs: 1000 });
		r.add(100, "p", p("game_log", { message: "You killed a Goo", color: "gray" }));
		r.add(900, "p", p("game_log", "Welcome"));
		r.add(1300, "p", p("chat_log", { owner: "Pri1", message: "hi", id: "Pri1" }));
		r.add(1250, "p", p("server_message", { message: "Event!" }));
		r.add(1400, "p", p("game_response", "upgrade_success")); // (not a log line)
		r.close();
		assert.deepStrictEqual(logAt(rd, "Ran1", 1350, 3), [[900, "log", "Welcome"], [1250, "log", "Event!"], [1300, "chat", "Pri1: hi"]]);
		assert.deepStrictEqual(logAt(rd, "Ran1", 950), [[100, "log", "You killed a Goo"], [900, "log", "Welcome"]]);
		assert.deepStrictEqual(logAt(rd, "Ran1", 50), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
