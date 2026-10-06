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

test("readIndex: a line that isn't four numbers is left out (an earlier run's last member written over by its next session, with NULs before it)", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-idx-"));
	try {
		const f = path.join(dir, "Ran1.rec.idx");
		fs.writeFileSync(f, JSON.stringify({ format: "chronal-rec/1", name: "Ran1", member_ms: 1000 }) + "\n100\t900\t0\t50\n1000\t1900\t50\t60\n" + "\0".repeat(40) + "500\t600\t20\t70\n");
		assert.deepStrictEqual(readIndex(f).members, [{ first: 100, last: 900, off: 0, len: 50 }, { first: 1000, last: 1900, off: 50, len: 60 }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Recorder, a character's next session: append goes on after what is there (offsets, no second header) from the state the last one ended in; wait holds the records until open(); a start clears the chests", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-next-"));
	try {
		const rd = path.join(dir, "run--1.rec"),
			first = new Recorder(rd, "Ran1", { memberMs: 1000 });
		first.add(100, "a", "s1");
		first.add(120, "p", p("start", { map: "main", in: "main", x: 0, y: 0, entities: { type: "all", players: [], monsters: [{ id: "7", type: "goo" }] } }));
		first.add(500, "p", p("drop", { id: "c1", x: 1, y: 2 }));
		first.add(900, "p", p("player", { x: 5 }));
		// the next session's thread starts before the last one's has closed its files: it holds what comes in
		const next = new Recorder(rd, "Ran1", { memberMs: 1000, append: true, wait: true });
		next.add(3500, "a", "s2");
		next.add(3600, "p", p("start", { map: "halloween", in: "halloween", x: 9, y: 9, entities: { type: "all", players: [], monsters: [] } }));
		first.add(950, "d", "s1");
		first.close();
		next.open();
		next.add(4700, "p", p("player", { x: 9 }));
		next.close();
		const head = fs.readFileSync(path.join(rd, "Ran1.rec.idx"), "utf8").split("\n").filter((l) => l.startsWith("{"));
		assert.strictEqual(head.length, 1);
		const { members } = readIndex(path.join(rd, "Ran1.rec.idx")),
			gz = fs.readFileSync(path.join(rd, "Ran1.rec.gz"));
		assert.deepStrictEqual(members.map((m) => [m.first, m.last]), [[100, 950], [3500, 3600], [4700, 4700]]);
		assert.deepStrictEqual(members.map((m) => m.off), [0, members[0].len, members[0].len + members[1].len]);
		assert.strictEqual(members.reduce((a, m) => a + m.len, 0), gz.length);
		const S = (m) => JSON.parse(zlib.gunzipSync(gz.subarray(m.off, m.off + m.len)).toString("utf8").split("\n")[0].split("\t")[2]);
		// the next session's first member starts from where the last one ended: its map, monsters, chest and player
		const s1 = S(members[1]);
		assert.deepStrictEqual([s1.map.name, Object.keys(s1.ents.monsters), Object.keys(s1.chests), s1.player[0]], ["main", ["7"], ["c1"], 900]);
		// its start: the new page's map, no entities, no chests (the player packet is the last one's until a new one)
		const s2 = S(members[2]);
		assert.deepStrictEqual([s2.map.name, Object.keys(s2.ents.monsters), s2.chests], ["halloween", [], {}]);
		assert.deepStrictEqual(playerAt(rd, "Ran1", 4800), [4700, { x: 9 }]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("a recorded run: a character whose page loads again (its CODE's disconnect() every 60 s) has every session in one recording, in time order", { timeout: 180000 }, (t) => {
	const { config } = require("../lib/config");
	if (!fs.existsSync(path.join(config().al_root, "design"))) return t.skip(`no game at ${config().al_root}`);
	const { execFileSync } = require("node:child_process");
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rec-run-"));
	try {
		fs.writeFileSync(path.join(dir, "dc.js"), "setTimeout(() => disconnect(), 60000);\n");
		fs.writeFileSync(path.join(dir, "setup.json"), JSON.stringify({ format: "chronal-setup/1", name: "recdc", run: { seed: 3 }, world: { threads: true }, characters: [{ name: "Rec1", class: "ranger", code: { file: "dc.js" } }] }));
		const live = path.join(dir, "live");
		execFileSync(process.execPath, [path.join(__dirname, "..", "chronal.js"), "run", path.join(dir, "setup.json"), "--duration", "4m", "--record", "--live", live, "--no-export"], { stdio: "pipe" });
		const id = fs.readdirSync(live).find((f) => /^recdc--\d+\.json$/.test(f)).slice(0, -5),
			snap = JSON.parse(fs.readFileSync(path.join(live, id + ".json"), "utf8")),
			sessions = snap.players.find((x) => x.name === "Rec1").sessions,
			{ members } = readIndex(path.join(live, id + ".rec", "Rec1.rec.idx")),
			gz = fs.readFileSync(path.join(live, id + ".rec", "Rec1.rec.gz"));
		assert.ok(sessions.length >= 3, JSON.stringify(sessions));
		assert.strictEqual(members.reduce((a, m) => a + m.len, 0), gz.length);
		for (let i = 1; i < members.length; i++) assert.ok(members[i].first > members[i - 1].first, `member ${i} out of order`);
		// from the start of the run to its end, a connect per session
		const t0 = members[0].first, span = (members[members.length - 1].last - t0) / 1000;
		assert.ok(span > 235, `the recording spans ${span} s`);
		let connects = 0;
		for (const m of members) for (const l of zlib.gunzipSync(gz.subarray(m.off, m.off + m.len)).toString("utf8").split("\n")) if (l.split("\t")[1] === "a") connects++;
		assert.strictEqual(connects, sessions.length);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
