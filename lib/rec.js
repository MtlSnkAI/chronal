"use strict";
// Replay recordings (docs/reference/recording.md): what the server sends one character's client, and the moves that client sends,
// for watching a run afterwards in the real game client (the dashboard's replay, viewer/). Opt-in (chronal run --record);
// outcomes unchanged: the recorder only copies what the sockets carry.
//   <live>/<id>.rec/<name>.rec.gz   gzip members, one per ~30 game s: lines "<virtual ms>\t<kind>\t<data>"; kind "p" a
//                                   packet from the server (["event", data] JSON), "a" / "d" connect / disconnect, "P" a
//                                   move the client sent (["move", data]); every member starts with an "S" line: the
//                                   state folded from everything before it (fold()), so a seek reads one member
//   <live>/<id>.rec/<name>.rec.idx  a JSON header line { format, name, member_ms }, then a line per member:
//                                   "<first ms>\t<last ms>\t<byte offset>\t<bytes>"
const fs = require("node:fs"),
	path = require("node:path"),
	zlib = require("node:zlib");

const FORMAT = "chronal-rec/1";

const emptyState = () => ({ map: null, ents: { players: {}, monsters: {} }, chests: {}, player: null, move: null, party: null, info: null });

// What a client knows at a moment, from the packets so far: its map, the entities in view (every "entities" delta
// since the last full list, merged per id; gone on death or disappear), chests on the ground (drop, not opened), its
// last "party_update" and "server_info" packets (raw), its last "player" packet and move ([ms, raw]). st is changed in
// place. Self-contained: the replay page runs this same function (its source).
function fold(st, at, k, d) {
	if (k === "P") {
		if (d.startsWith('["move"')) st.move = [at, d];
		return;
	}
	if (k !== "p") return;
	const name = d.slice(2, d.indexOf('"', 2));
	if (name === "player") return void (st.player = [at, d]);
	if (name === "party_update") return void (st.party = d);
	if (name === "server_info") return void (st.info = d);
	if (!/^(start|new_map|entities|death|disappear|drop|chest_opened)$/.test(name)) return;
	const x = JSON.parse(d)[1];
	const merge = (e) => {
		for (const kind of ["players", "monsters"])
			for (const o of e[kind] || []) {
				const m = Object.assign(st.ents[kind][o.id] || {}, o);
				delete m.events;
				m._at = at;
				if (m.dead) delete st.ents[kind][o.id];
				else st.ents[kind][o.id] = m;
			}
	};
	if (name === "start" || name === "new_map") {
		st.map = { name: name === "start" ? x.map : x.name, in: x.in, x: x.x, y: x.y, m: x.m };
		st.ents = { players: {}, monsters: {} };
		if (x.entities) merge(x.entities);
	} else if (name === "entities") {
		if (!st.map || x.in !== st.map.in) return;
		if (x.type === "all") st.ents = { players: {}, monsters: {} };
		merge(x);
	} else if (name === "death" || name === "disappear") delete st.ents.players[x.id], delete st.ents.monsters[x.id];
	else if (name === "drop") st.chests[x.id] = x;
	else if (name === "chest_opened") delete st.chests[x.id];
}

class Recorder {
	/** @param {string} dir <live>/<id>.rec  @param {string} name the character */
	constructor(dir, name, { memberMs = 30000, maxBytes = 8 << 20 } = {}) {
		fs.mkdirSync(dir, { recursive: true });
		this.fd = fs.openSync(path.join(dir, name + ".rec.gz"), "w");
		this.ifd = fs.openSync(path.join(dir, name + ".rec.idx"), "w");
		fs.writeSync(this.ifd, JSON.stringify({ format: FORMAT, name, member_ms: memberMs }) + "\n");
		Object.assign(this, { memberMs, maxBytes, st: emptyState(), lines: [], bytes: 0, first: null, last: null, off: 0 });
	}
	add(at, k, data) {
		if (this.fd == null) return;
		const d = typeof data === "string" ? data : JSON.stringify(data);
		if (this.first == null) this.begin(at);
		else if (at >= this.first + this.memberMs || this.bytes >= this.maxBytes) this.flush(), this.begin(at);
		const line = at + "\t" + k + "\t" + d + "\n";
		this.lines.push(line);
		this.bytes += line.length;
		if (at > this.last) this.last = at;
		fold(this.st, at, k, d);
	}
	begin(at) {
		const s = at + "\tS\t" + JSON.stringify(this.st) + "\n";
		Object.assign(this, { first: at, last: at, lines: [s], bytes: s.length });
	}
	flush() {
		if (this.first == null) return;
		const z = zlib.gzipSync(this.lines.join(""), { level: 1 });
		fs.writeSync(this.fd, z);
		fs.writeSync(this.ifd, [this.first, this.last, this.off, z.length].join("\t") + "\n");
		Object.assign(this, { off: this.off + z.length, lines: [], bytes: 0, first: null });
	}
	close() {
		if (this.fd == null) return;
		this.flush();
		fs.closeSync(this.fd);
		fs.closeSync(this.ifd);
		this.fd = this.ifd = null;
	}
}

/** A recording's index: { header, members: [{ first, last, off, len }] } (a run still recording: what is written so far) */
function readIndex(file) {
	const [head, ...lines] = fs.readFileSync(file, "utf8").split("\n");
	const members = [];
	for (const l of lines) {
		const [first, last, off, len] = l.split("\t").map(Number);
		// (a line that isn't four numbers: a recording made before a character's next session appended to it, whose
		// last session's thread wrote its last member over the next one's)
		if ([first, last, off, len].every(Number.isFinite)) members.push({ first, last, off, len });
	}
	return { header: JSON.parse(head), members };
}

// member k of a character's recording (dir: <live>/<id>.rec), digested once (cache: a Map keeping the last 8): ps, its
// player packets ([ms, raw]; the S line's first), and logs, what its client's game log and chat showed from its
// packets ([ms, "log" | "chat", text]: game_log, server_message, chat_log)
function digest(dir, name, k, m, cache) {
	const key = [dir, name, k, m.len].join("|");
	let d = cache && cache.get(key);
	if (d) return d;
	const b = Buffer.alloc(m.len),
		fd = fs.openSync(path.join(dir, name + ".rec.gz"), "r");
	try {
		fs.readSync(fd, b, 0, m.len, m.off);
	} finally {
		fs.closeSync(fd);
	}
	d = { ps: [], logs: [] };
	for (const l of zlib.gunzipSync(b).toString("utf8").split("\n")) {
		const i = l.indexOf("\t"),
			j = l.indexOf("\t", i + 1);
		if (j < 0) continue;
		const kind = l.slice(i + 1, j),
			at = Number(l.slice(0, i));
		if (kind === "S") {
			const st = JSON.parse(l.slice(j + 1));
			if (st.player) d.ps.push(st.player);
		} else if (kind === "p" && l.startsWith('["player"', j + 1)) d.ps.push([at, l.slice(j + 1)]);
		else if (kind === "p" && /^\["(game_log|server_message|chat_log)"/.test(l.slice(j + 1, j + 20))) {
			const [ev, x] = JSON.parse(l.slice(j + 1)),
				text = typeof x === "string" ? x : x && typeof x.message === "string" ? (ev === "chat_log" ? (x.owner || "") + ": " + x.message : x.message) : null;
			if (text) d.logs.push([at, ev === "chat_log" ? "chat" : "log", text]);
		}
	}
	d.logs.sort((a, b) => a[0] - b[0]);
	if (cache) {
		cache.set(key, d);
		if (cache.size > 8) cache.delete(cache.keys().next().value);
	}
	return d;
}
// the member holding v: its index, else -1 (before the recording)
function memberAt(members, v) {
	let k = -1;
	for (let i = 0; i < members.length && members[i].first <= v; i++) k = i;
	return k;
}

/** The last "player" packet a character's client had at v (virtual ms), from its recording in dir (<live>/<id>.rec):
 *  [ms, its data] | null. cache: a Map for the members read (the last 8) */
function playerAt(dir, name, v, cache = null) {
	const { members } = readIndex(path.join(dir, name + ".rec.idx")),
		k = memberAt(members, v);
	if (k < 0) return null;
	let best = null;
	for (const x of digest(dir, name, k, members[k], cache).ps) if (x[0] <= v && (!best || x[0] >= best[0])) best = x; // (a member is a few ms out of order)
	return best && [best[0], JSON.parse(best[1])[1]];
}

/** The last n lines of a character's game log and chat at v, as its client got them: [[ms, "log" | "chat", text]] */
function logAt(dir, name, v, n = 100, cache = null) {
	const { members } = readIndex(path.join(dir, name + ".rec.idx"));
	let out = [];
	for (let k = memberAt(members, v); k >= 0 && out.length < n; k--) out = digest(dir, name, k, members[k], cache).logs.filter((x) => x[0] <= v).concat(out);
	return out.slice(-n);
}

/** The recordings of a run: the names with an index in <live>/<id>.rec/ */
function recordingsOf(dir, id) {
	try {
		return fs.readdirSync(path.join(dir, id + ".rec")).filter((f) => f.endsWith(".rec.idx")).map((f) => f.slice(0, -8)).sort();
	} catch (e) {
		return [];
	}
}

module.exports = { FORMAT, Recorder, fold, emptyState, readIndex, recordingsOf, playerAt, logAt };
