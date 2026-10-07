"use strict";
// In-memory socket.io for server <-> clients. Same observable semantics that matter for gameplay:
// per-direction ordering, JSON payload cloning (socket.io's default parser), latency on the virtual clock.
const encode = (packet) => JSON.stringify(packet); // decoded by the receiver's own JSON (its realm)

class Emitter {
	constructor() {
		this._h = Object.create(null);
	}
	on(e, f) {
		(this._h[e] ||= []).push(f);
		return this;
	}
	addEventListener(e, f) {
		return this.on(e, f);
	}
	once(e, f) {
		const g = (...a) => (this.off(e, g), f.apply(this, a));
		g.f = f;
		return this.on(e, g);
	}
	off(e, f) {
		if (e === undefined) this._h = Object.create(null);
		else if (!f) delete this._h[e];
		else if (this._h[e]) this._h[e] = this._h[e].filter((x) => x !== f && x.f !== f);
		return this;
	}
	removeListener(e, f) {
		return this.off(e, f);
	}
	removeAllListeners(e) {
		return this.off(e);
	}
	listeners(e) {
		return (this._h[e] || []).slice();
	}
	_fire(e, ...a) {
		for (const f of (this._h[e] || []).slice()) f.apply(this, a);
	}
}

class Link {
	constructor(hub) {
		this.hub = hub;
		this.last = 0;
	}
	nextTime() {
		const c = this.hub.clock,
			t = Math.max(c.now + this.hub.latency(c.rng), this.last);
		return (this.last = t);
	}
	send(fn, label) {
		this.hub.clock.at(this.nextTime(), fn, label);
	}
}

class ServerIO extends Emitter {
	constructor(hub, path, json) {
		super();
		this.hub = hub;
		this.path = path;
		this.JSON = json || JSON;
		this.sockets = new Map();
		// engine.io: the game (from 98783128) defers each connection's flush to the end of the tick
		// (coalesce_socket_writes); here every packet of a tick leaves at that tick's time anyway: no connections
		this.engine = { on() {}, off() {} };
	}
	emit(e, ...a) {
		for (const s of this.sockets.values()) s.emit(e, ...a);
		return true;
	}
	/** socket.io rooms: every socket is in the room named by its id (emit_fanout sends to id lists); the game joins no
	 * named room (its to("roulette") reaches nobody, live too) */
	to(rooms) {
		const ids = Array.isArray(rooms) ? rooms : [rooms];
		return {
			emit: (e, ...a) => {
				for (const id of ids) {
					const s = this.sockets.get(id);
					if (s) s.emit(e, ...a);
				}
				return true;
			},
		};
	}
	of() {
		return this;
	}
	close() {}
	use() {
		return this;
	}
}

class ServerSocket extends Emitter {
	constructor(io, client, query) {
		super();
		this.nsp = io;
		this.client = client;
		this.id = "s" + io.hub.nextId++ + "x" + Math.floor(io.hub.clock.rng() * 1e9).toString(36);
		// its IP: its account's (a setup's accounts.<k>.ip; the user's own accounts share 127.0.0.1)
		const ip = (client.isRemote ? client.peer && client.peer.ip : client.ip) || "127.0.0.1";
		this.handshake = { query, address: ip, headers: { "user-agent": "chronal", host: "localhost" }, time: "", issued: io.hub.clock.nowMs(), url: io.path, xdomain: false, secure: false };
		this.request = { connection: { remoteAddress: ip }, headers: this.handshake.headers };
		this.conn = { remoteAddress: ip, transport: { name: "websocket" } };
		this.connected = true;
		this.disconnected = false;
		this.data = {};
		this.down = new Link(io.hub);
	}
	emit(e, ...a) {
		if (!this.connected) return false;
		const packet = encode([e, ...a]);
		if (this.client.isRemote) this.client.peer.send(this.down.nextTime(), "p", this.client.cid, packet);
		else this.down.send(() => this.client._packet(this.client.JSON.parse(packet)), "io s2c:" + e);
		return true;
	}
	disconnect() {
		if (!this.connected) return this;
		if (this.client.isRemote) this.client.peer.send(this.down.nextTime(), "d", this.client.cid, "io server disconnect");
		else this.down.send(() => this.client._closed("io server disconnect"));
		this._onclose("server namespace disconnect");
		return this;
	}
	_packet(packet) {
		if (this.connected) this._fire(...packet);
	}
	_onclose(reason) {
		if (!this.connected) return;
		this.connected = false;
		this.disconnected = true;
		this.nsp.sockets.delete(this.id);
		this._fire("disconnecting", reason);
		this._fire("disconnect", reason);
	}
}

class ClientSocket extends Emitter {
	constructor(hub, url, opts = {}, json, ip) {
		super();
		this.hub = hub;
		this.ip = ip || null;
		this.JSON = json || JSON;
		this.connected = false;
		this.disconnected = true;
		this.id = undefined;
		this.sendBuffer = [];
		this.io = { opts, engine: { transport: { name: "websocket" } }, on() {}, off() {} };
		const q = typeof opts.query === "string" ? Object.fromEntries(new URLSearchParams(opts.query)) : { ...(opts.query || {}) };
		this.up = new Link(hub);
		this._open(opts, q);
	}
	_open(opts, q) {
		const hub = this.hub,
			server = hub.servers.get(opts.path) || hub.servers.values().next().value;
		this.up.send(() => {
			if (this._dead || !server) return;
			const s = new ServerSocket(server, this, q);
			this.remote = s;
			server.sockets.set(s.id, s);
			s.down.send(() => this._onconnect(s.id)); // CONNECT ack precedes anything the handler emits
			server._fire("connection", s);
		});
	}
	emit(e, ...a) {
		const packet = encode([e, ...a]);
		if (!this.connected) this.sendBuffer.push(packet);
		else this._send(packet);
		return this;
	}
	send(...a) {
		return this.emit("message", ...a);
	}
	_send(packet) {
		const s = this.remote;
		this.up.send(() => s._packet(s.nsp.JSON.parse(packet)), "io c2s");
	}
	onevent(packet) {
		this._fire(...(packet.data || []));
	}
	_packet(packet) {
		if (this.connected) this.onevent({ type: 2, nsp: "/", data: packet });
	}
	_onconnect(id) {
		if (this._dead) return;
		this.id = id;
		this.connected = true;
		this.disconnected = false;
		for (const p of this.sendBuffer.splice(0)) this._send(p);
		this._fire("connect");
	}
	_closed(reason) {
		if (!this.connected) return;
		this.connected = false;
		this.disconnected = true;
		this._fire("disconnect", reason);
	}
	_drop(reason) {
		const s = this.remote;
		if (s) this.up.send(() => s._onclose(reason));
	}
	disconnect() {
		if (this.connected) this._drop("client namespace disconnect"), this._closed("io client disconnect");
		this._dead = true;
		return this;
	}
	close() {
		return this.disconnect();
	}
	destroy() {
		// socket.io-client: tears down silently; the server sees the transport close.
		if (this.connected) this._drop("transport close");
		this.connected = false;
		this.disconnected = true;
		this._dead = true;
	}
	open() {
		return this;
	}
	connect() {
		return this;
	}
}

// ---- Cross-thread transport (lockstep mode): records are [at, kind, cid, data, window] -------------------------
// client->server: "c" connect {query,path} | "p" packet | "x" drop(reason)   server->client: "a" ack(sid) | "p" | "d"
// client->sim: "r" a request of the page (start_character and co: { op, ... }, hub.onRequest)
// sim->client: "r" the sim's answer or notice ({ op, ... }, hub.onReply)
// `window`: the end of the lockstep window it was sent in (hub.window). A delivery is ordered by that window's
// boundary, sender and send order (VirtualClock.mark/msg), never by when a thread took it in: deterministic, and the
// same order as a window-by-window lockstep.
const PER_SENDER = 2 ** 40;

/** Main-thread side of one client thread. */
class RemotePeer {
	constructor(hub, index = 0) {
		this.hub = hub;
		this.out = [];
		this.sockets = new Map();
		this.sub = index * PER_SENDER;
	}
	send(at, k, cid, data) {
		this.out.push([at, k, cid, data, this.hub.window]);
	}
	take() {
		const o = this.out;
		this.out = [];
		return o;
	}
	receive(records) {
		// a closed page's thread runs on to the end of the game minute unsynchronized: what it still sends is dropped
		if (this.dead) return;
		for (const [at, k, cid, data, win] of records) this.hub.clock.msg(at, () => this.dead || this._handle(k, cid, data), win, this.sub++, "io c2s");
	}
	_handle(k, cid, data) {
		if (k === "r") {
			if (this.hub.onRequest) this.hub.onRequest(this, data);
		} else if (k === "c") {
			const server = this.hub.servers.get(data.path) || this.hub.servers.values().next().value;
			const s = new ServerSocket(server, { isRemote: true, cid, peer: this }, data.query);
			this.sockets.set(cid, s);
			// (before the server's own handlers: the sim learns of a page whose last socket closed, e.g. a limitdc)
			s.on("disconnect", () => this.onClose && this.onClose(this));
			server.sockets.set(s.id, s);
			this.send(s.down.nextTime(), "a", cid, s.id);
			server._fire("connection", s);
		} else {
			const s = this.sockets.get(cid);
			if (s && k === "p") s._packet(s.nsp.JSON.parse(data));
			else if (s && k === "x") s._onclose(data);
		}
	}
}

/** Client-thread side: io() for the client's thread; records queue until the thread posts them. */
class RemoteHub {
	constructor(clock, o = {}) {
		this.clock = clock;
		this.latency = o.latency ?? ((rng) => 20 + rng() * 10);
		this.out = [];
		this.sockets = new Map();
		this.nextCid = 1;
		this.nextId = 1;
		this.sub = 0;
		this.window = null; // end of the window running now; null between runs (the next window's, once it's known)
		this.recorder = o.recorder || null; // rec.js: a copy of what the sockets carry (moves sent, all received)
	}
	send(at, k, cid, data) {
		if (this.recorder && k === "p" && typeof data === "string" && data.startsWith('["move"')) this.recorder.add(at, "P", data);
		this.out.push([at, k, cid, data, this.window]);
	}
	clientIo(json) {
		return (url, opts) => new RemoteClientSocket(this, url, opts, json);
	}
	take() {
		const o = this.out;
		this.out = [];
		return o;
	}
	receive(records) {
		if (this.recorder) for (const [at, k, , data] of records) if (k !== "r") this.recorder.add(at, k, data);
		for (const [at, k, cid, data, win] of records)
			this.clock.msg(at, () => {
				if (k === "r") return void (this.onReply && this.onReply(data));
				const s = this.sockets.get(cid);
				if (!s) return;
				if (k === "a") s._onconnect(data);
				else if (k === "p") s._packet(s.JSON.parse(data));
				else if (k === "d") s._closed(data);
			}, win, this.sub++, "io s2c");
	}
	/** A request of this client's page to the sim (start_character and co), after one link latency */
	request(data) {
		this.link ||= new Link(this);
		this.send(this.link.nextTime(), "r", 0, data);
	}
}

/** Busy-wait while i32[i] === v, at most ms after t0 (hand-offs between threads). */
function spinWhile(i32, i, v, ms, t0 = performance.now()) {
	for (let n = 1; Atomics.load(i32, i) === v; n++) {
		if ((n & 1023) === 0 && performance.now() - t0 > ms) return;
		Atomics.pause();
	}
}

const SLOTS = 64,
	LINE = 64, // bytes per slot: one cache line each, so threads don't contend on each other's fields
	F64 = new Float64Array(1),
	BITS = new BigInt64Array(F64.buffer);

/**
 * Conservative sync of threads that only talk through messages taking >= L ms (lockstep mode). Each thread publishes
 * its progress P: every message it will still send is sent at a virtual time >= P, so arrives at >= P + L. A thread may
 * run any event earlier than min(peers' P) + L; it publishes P before each event, so a peer stuck in a long event
 * still lets the others run up to L past it.
 * Shared buffer (Gate.buffer()), one cache line per thread slot: P (float64 bits, atomic), then int32s at 4: wake-up
 * counter, 5: waiting, 6: asleep.
 */
class Gate {
	static buffer() {
		return new SharedArrayBuffer(SLOTS * LINE);
	}
	/**
	 * @param {object} o
	 * @param {SharedArrayBuffer} o.shared
	 * @param {number} o.self          this thread's slot
	 * @param {number[]} o.peers       slots of the threads it exchanges messages with
	 * @param {number} o.L             minimum latency (ms)
	 * @param {number} o.spin          ms to busy-wait before sleeping
	 * @param {() => void} o.flush     post everything sent so far
	 * @param {() => void} o.receive   take in everything the peers posted
	 * @param {() => void} [o.check]   called while waiting long: throws if a peer is gone
	 * @param {(slot: number) => string} [o.name]  a slot's thread, for the error when a peer stops making progress
	 * @param {number} [o.patience]    real ms without the peers moving before that error (the server's is shorter, so
	 *                                 the error names the thread that is stuck, not one waiting on the server)
	 */
	constructor(o) {
		Object.assign(this, o);
		if (!(o.self < SLOTS)) throw new Error(`[sim] at most ${SLOTS - 1} client threads`);
		this.prog = new BigInt64Array(o.shared);
		this.i32 = new Int32Array(o.shared);
		this.p = this.read(o.self);
		this.bound = -Infinity;
		this.waited = 0; // ms blocked (spinning or asleep)
		this.patience ??= 120000;
	}
	/** The error when the peers stopped moving: the ones furthest behind (stuck in one event: a synchronous loop). */
	stalled() {
		const low = Math.min(...this.peers.map((slot) => this.read(slot))),
			who = this.peers.filter((slot) => this.read(slot) === low).map((slot) => (this.name ? this.name(slot) : `thread ${slot}`));
		return new Error(`[sim] a thread stopped making progress: ${who.join(", ")} (no virtual time passed in ${Math.round(this.patience / 1000)} s of real time: stuck in one synchronous event, e.g. a loop in its CODE)`);
	}
	read(slot) {
		BITS[0] = Atomics.load(this.prog, slot * (LINE / 8));
		return F64[0];
	}
	/** Set a slot's progress directly (a new thread starts at the current virtual time). */
	init(slot, p) {
		F64[0] = p;
		Atomics.store(this.prog, slot * (LINE / 8), BITS[0]);
	}
	publish(p) {
		if (!(p > this.p)) return;
		this.flush();
		this.p = F64[0] = p;
		Atomics.store(this.prog, this.self * (LINE / 8), BITS[0]);
		const i32 = this.i32;
		for (const slot of this.peers) {
			const at = slot * (LINE / 4);
			if (!Atomics.load(i32, at + 5)) continue; // not waiting: it reads P when it needs it
			Atomics.add(i32, at + 4, 1);
			if (Atomics.load(i32, at + 6)) Atomics.notify(i32, at + 4);
		}
	}
	/** Nothing left to run below the bound: publish progress up to `p` and wait until the peers move the bound. */
	block(p) {
		const i32 = this.i32,
			me = this.self * (LINE / 4),
			prev = this.bound;
		this.publish(Math.min(p, prev));
		Atomics.store(i32, me + 5, 1);
		for (let t0 = 0; ; ) {
			const seen = Atomics.load(i32, me + 4);
			let b = Infinity;
			for (const slot of this.peers) b = Math.min(b, this.read(slot) + this.L);
			this.receive(); // after reading P: everything sent before it has been posted
			if (b > prev) {
				this.bound = b;
				if (t0) this.waited += performance.now() - t0;
				break;
			}
			if (!t0) t0 = performance.now();
			if (this.spin) spinWhile(i32, me + 4, seen, this.spin, t0);
			if (Atomics.load(i32, me + 4) !== seen) continue;
			Atomics.store(i32, me + 6, 1);
			const r = Atomics.wait(i32, me + 4, seen, 1000);
			Atomics.store(i32, me + 6, 0);
			if (r === "timed-out") {
				if (this.check) this.check();
				if (performance.now() - t0 > this.patience) throw this.stalled();
			}
		}
		Atomics.store(i32, me + 5, 0);
	}
}

class RemoteClientSocket extends ClientSocket {
	_open(opts, q) {
		this.cid = this.hub.nextCid++;
		this.hub.sockets.set(this.cid, this);
		this.hub.send(this.up.nextTime(), "c", this.cid, { query: q, path: opts.path });
	}
	_send(packet) {
		this.hub.send(this.up.nextTime(), "p", this.cid, packet);
	}
	_drop(reason) {
		this.hub.send(this.up.nextTime(), "x", this.cid, reason);
	}
}

class Hub {
	/** @param {import('./vclock').VirtualClock} clock  @param {{latency?:(rng:()=>number)=>number}} o one-way ms */
	constructor(clock, o = {}) {
		this.clock = clock;
		this.latency = o.latency ?? ((rng) => 20 + rng() * 10); // ~50ms RTT
		this.servers = new Map();
		this.nextId = 1;
	}
	/** Drop-in for require("socket.io") inside the server context. */
	socketIoModule(json) {
		const hub = this;
		function Server(http, opts = {}) {
			const s = new ServerIO(hub, opts.path || "/socket.io/", json);
			hub.servers.set(s.path, s);
			return s;
		}
		return { Server };
	}
	/** The global `io(url, opts)` for a client context (ip: its sockets' address, default 127.0.0.1). */
	clientIo(json, ip) {
		return (url, opts) => new ClientSocket(this, url, opts, json, ip);
	}
}

module.exports = { Hub, Link, ServerIO, ServerSocket, RemotePeer, RemoteHub, Gate, spinWhile };
