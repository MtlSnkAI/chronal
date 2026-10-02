"use strict";
// One virtual timeline shared by the server, every client and every CODE runner.
// Nothing sleeps: run() jumps straight to the next due timer, so speed = CPU headroom.
const vm = require("node:vm");
const { promiseHooks } = require("node:v8");
const realSetImmediate = setImmediate;
const drain = () => new Promise((r) => realSetImmediate(r)); // runs every queued microtask at this virtual instant
// The same, synchronously (~0.05 us when there's nothing to run): only works outside a microtask checkpoint
// (runSync callers run in a macrotask)
const drainSync = process._tickCallback;
// run() only: microtasks only exist if a promise was created or settled (settling one queues its reactions: e.g. a
// socket handler resolving a CODE promise, whose await continuation must run right after that event, as in a
// browser). Skip the (costly) macrotask hop when a callback did neither. (queueMicrotask/nextTick aren't seen.)
let promiseActivity = true,
	promises = 0; // promises made on this thread so far (report.js guarded(): a read that makes one is not pure)
promiseHooks.onInit(() => ((promiseActivity = true), promises++));
promiseHooks.onSettled(() => (promiseActivity = true));

/** A seeded generator; f.state() / f.restore(s) save and put back where its sequence is (report.js guarded()). */
function mulberry32(seed) {
	const f = function () {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	f.state = () => seed;
	f.restore = (s) => void (seed = s);
	return f;
}

/** A heap entry (timer, message or internal callback). One class, all fields set up front: the heap and the event
 * loop only ever see one object shape (entries built as literals with optional fields made their accesses megamorphic). */
class Timer {
	constructor(id, at, seq, sub, fn, args, repeat, nesting, label, tag, onError) {
		this.id = id;
		this.at = at;
		this.seq = seq;
		this.sub = sub; // messages only
		this.fn = fn;
		this.args = args;
		this.repeat = repeat;
		this.nesting = nesting;
		this.label = label;
		this.tag = tag; // messages only
		this.onError = onError;
		this.cancelled = false;
		this.due = 0; // a browser interval's nominal time (0: none)
	}
}
const NO_ARGS = Object.freeze([]);

// `sub` only breaks ties between messages taken in at the same lockstep boundary (see VirtualClock.mark). Keys are
// unique, so the pop order doesn't depend on the heap's layout.
const less = (x, y) => x.at < y.at || (x.at === y.at && (x.seq < y.seq || (x.seq === y.seq && x.sub < y.sub)));

class Heap {
	constructor() {
		this.a = [];
	}
	get size() {
		return this.a.length;
	}
	push(t) {
		const a = this.a;
		let i = a.length;
		a.push(t);
		while (i > 0) {
			const p = (i - 1) >> 1,
				q = a[p];
			if (!less(t, q)) break;
			a[i] = q;
			i = p;
		}
		a[i] = t;
	}
	peek() {
		return this.a[0];
	}
	pop() {
		const a = this.a,
			top = a[0],
			last = a.pop(),
			n = a.length;
		if (n) {
			let i = 0;
			for (;;) {
				const l = 2 * i + 1,
					r = l + 1;
				let j = i,
					m = last;
				if (l < n && less(a[l], m)) (j = l), (m = a[l]);
				if (r < n && less(a[r], m)) (j = r), (m = a[r]);
				if (j === i) break;
				a[i] = m;
				i = j;
			}
			a[i] = last;
		}
		return top;
	}
}

const emptyFns = new WeakMap();
const EMPTY_FN = /^(?:function\s*[\w$]*\s*\(\s*\)\s*\{\s*\}|\(\s*\)\s*=>\s*\{\s*\})$/;

// The virtual Date, built inside the context it's installed into: a function from another realm is never inlined
// (the server makes a Date per mssince() call, several per monster per tick).
const DATE_SRC = `(function (RealDate, clock) {
	"use strict";
	var floor = Math.floor, toString = Object.prototype.toString;
	function Date(a, b, c, d, e, f, g) {
		if (!new.target) return new RealDate(floor(clock.now)).toString();
		switch (arguments.length) {
			case 0: return new RealDate(floor(clock.now));
			case 1: return new RealDate(a);
			case 2: return new RealDate(a, b);
			case 3: return new RealDate(a, b, c);
			default: return new RealDate(a, b, c, d === undefined ? 0 : d, e === undefined ? 0 : e, f === undefined ? 0 : f, g === undefined ? 0 : g);
		}
	}
	Object.setPrototypeOf(Date, RealDate);
	Date.prototype = RealDate.prototype;
	Date.now = () => floor(clock.now);
	Object.defineProperty(Date, Symbol.hasInstance, { value: (x) => x instanceof RealDate || toString.call(x) === "[object Date]" });
	return Date;
})`;

// Node timer handles: the same own properties, without 5 new closures per setTimeout
const H = { ref() { return this; }, unref() { return this; }, hasRef: () => true, refresh() { return this; }, [Symbol.toPrimitive]() { return this.id; } };

class VirtualClock {
	/**
	 * @param {object} o
	 * @param {number} [o.start]     epoch ms the simulation starts at
	 * @param {number} [o.seed]      seeds timer lateness + Math.random in installed contexts
	 * @param {(rng:()=>number, profile:string)=>number} [o.lateness]  extra ms each timer fires late.
	 *   Default 1–3ms: live timers never fire exactly on time, and the server relies on that
	 *   (instance_loop reschedules at 75ms but only updates when mssince(last_update) > 75).
	 */
	constructor(o = {}) {
		this.start = o.start ?? Date.parse("2026-01-01T00:00:00Z");
		this.now = this.start;
		this.seed = o.seed ?? 1;
		this.rng = mulberry32(this.seed);
		this.lateness = o.lateness ?? ((rng) => 1 + rng() * 2);
		this.heap = new Heap();
		this.live = new Map();
		this.seq = 0;
		this.marks = []; // lockstep boundaries passed: [end, seq]
		this.pending = []; // messages sent in a window whose boundary this thread hasn't reached yet
		this.nextId = 1;
		this.events = 0;
		this.current = null;
		this.contexts = 0;
		this.onError = o.onError ?? ((e) => console.error("[sim] uncaught in timer:", e));
	}
	nowMs() {
		return Math.floor(this.now);
	}

	/** Internal scheduling at an absolute virtual time (used by the transport / workers). */
	at(time, fn, label) {
		const t = new Timer(this.nextId++, Math.max(time, this.now), this.seq++, 0, fn, NO_ARGS, 0, 0, label, 0, undefined);
		this.heap.push(t);
		this.live.set(t.id, t);
		return t.id;
	}

	/**
	 * Lockstep: this thread passes the boundary at the end of the window that ends at `end`. A window-by-window
	 * lockstep took in every message sent in a window right there, so among events at the same virtual time such a
	 * message ran after every timer scheduled before the boundary and before every one scheduled after it: it gets
	 * the boundary's seq (messages of one boundary are then ordered by `sub`: sender, send order).
	 */
	mark(end) {
		const seq = this.seq++;
		this.marks.push([end, seq]);
		if (this.marks.length > 1024) (this.marks = this.marks.slice(-512)), (this.pruned = true);
		if (!this.pending.length) return;
		const later = [];
		for (const m of this.pending) {
			if (m.tag > end) later.push(m);
			else (m.seq = seq), this.heap.push(m);
		}
		this.pending = later;
	}

	/**
	 * A message delivery (lockstep mode), sent in the window that ends at `tag`: never cancelled, takes no timer id.
	 * @param {number} sub  orders the messages of one boundary (sender, then send order)
	 */
	msg(time, fn, tag, sub, label) {
		if (time < this.now) throw new Error(`[sim] message for ${time} taken in at ${this.now}: a thread ran ahead of its peers`);
		const m = new Timer(0, time, 0, sub, fn, NO_ARGS, 0, 0, label, tag, undefined),
			marks = this.marks;
		let i = marks.length;
		if (!i || marks[i - 1][0] < tag) return void this.pending.push(m);
		while (i > 1 && marks[i - 2][0] >= tag) i--; // the first boundary at or after the window's end
		if (i === 1 && this.pruned) throw new Error(`[sim] message from a window long gone (${tag}, now ${this.now})`);
		m.seq = marks[i - 1][1];
		this.heap.push(m);
	}

	timer(fn, delay, args, repeat, profile, onError) {
		if (typeof fn !== "function") throw new TypeError("callback must be a function");
		delay = Number(delay);
		const nesting = (this.current ? this.current.nesting : 0) + 1;
		if (profile === "node") {
			if (!(delay >= 1 && delay <= 2147483647)) delay = 1; // Node coerces to 1ms
		} else {
			if (!(delay >= 0)) delay = 0;
			if (nesting > 5 && delay < 4) delay = 4; // HTML spec clamp for nested timers
		}
		const id = this.nextId++;
		// No-op keep-alive intervals (e.g. server_worker.js setInterval(function(){},10)) are unobservable: skip them.
		let empty = emptyFns.get(fn);
		if (empty === undefined) emptyFns.set(fn, (empty = EMPTY_FN.test(Function.prototype.toString.call(fn))));
		if (empty) return id;
		const t = new Timer(id, this.now + delay + this.lateness(this.rng, profile), this.seq++, 0, fn, args, repeat ? delay : 0, nesting, undefined, 0, onError);
		if (repeat && profile !== "node") t.due = this.now + delay;
		if (this.profile && !fn.name) {
			const site = (new Error().stack.split("\n")[3] || "").trim().replace(/^at /, "").replace(/.*\((.*)\)$/, "$1");
			t.label = "anon@" + site.split("/").slice(-2).join("/");
		}
		this.heap.push(t);
		this.live.set(id, t);
		return id;
	}
	cancel(handle) {
		const id = handle && typeof handle === "object" ? handle.id : handle;
		const t = this.live.get(id);
		if (t) (t.cancelled = true), this.live.delete(id);
	}

	/**
	 * Advance virtual time. Returns stats.
	 * @param {object} o
	 * @param {number} [o.forMs]   virtual ms to advance
	 * @param {number} [o.until]   absolute virtual epoch ms
	 * @param {()=>boolean} [o.stop] checked after every event
	 */
	async run(o = {}) {
		const until = o.forMs != null ? this.now + o.forMs : (o.until ?? Infinity);
		const v0 = this.now,
			e0 = this.events,
			r0 = performance.now();
		await drain();
		while (this.events_(o, until, false)) {
			await drain();
			promiseActivity = false;
			if (o.stop && o.stop()) break;
		}
		if (until !== Infinity && this.now < until && !(o.stop && o.stop())) this.now = until;
		const real = performance.now() - r0,
			virt = this.now - v0;
		return { virtualMs: virt, realMs: real, speed: virt / Math.max(real, 1e-9), events: this.events - e0 };
	}

	/**
	 * One lockstep window, synchronously: every event before `before` (exclusive: events at exactly `before` belong to
	 * the next window). Microtasks are drained after every event, as a browser does after every task, without a
	 * macrotask hop (~5 us), so it must be called from a macrotask, not from a promise continuation.
	 * @param {object} o
	 * @param {number} o.before
	 * @param {import('./fake_io').Gate} [o.gate]  run an event only once no other thread can still send something that
	 *   arrives before it
	 */
	runSync(o) {
		let nested = true;
		queueMicrotask(() => (nested = false));
		drainSync();
		if (nested) throw new Error("[sim] runSync inside a promise continuation: microtasks can't be drained");
		while (this.events_(o, o.before, true, true)) drainSync();
		if (this.now < o.before) this.now = o.before;
	}

	/** Run due events; returns true after one that made promises (or after every one: `each`), false when none is due. */
	events_(o, until, exclusive, each) {
		const gate = o.gate;
		for (;;) {
			const t = this.heap.peek(),
				at = t ? t.at : Infinity,
				due = t !== undefined && (exclusive ? at < until : at <= until);
			if (gate) {
				// an event needs everything that arrives before it; the end of the window, everything before `until`
				if (due ? !(at < gate.bound) : gate.bound < until) {
					gate.block(due ? at : until);
					continue;
				}
				if (due) gate.publish(at);
			}
			if (!due) return false;
			this.heap.pop();
			if (t.cancelled) continue;
			if (t.at > this.now) this.now = t.at;
			if (!t.repeat) this.live.delete(t.id);
			this.current = t;
			const p0 = this.profile ? performance.now() : 0;
			try {
				const fn = t.fn,
					args = t.args;
				if (args.length === 0) fn();
				else fn.apply(undefined, args);
			} catch (e) {
				(t.onError || this.onError)(e);
			}
			if (this.profile) {
				const k = t.label || t.fn.name || "<anonymous>", e = this.profile.get(k) || { n: 0, ms: 0 };
				e.n++, (e.ms += performance.now() - p0), this.profile.set(k, e);
			}
			this.current = null;
			this.events++;
			if (t.repeat && !t.cancelled) {
				// A browser keeps an interval on its nominal cadence unless a whole period was missed; Node restarts it
				// from the callback (so it drifts by each firing's lateness)
				if (t.due) (t.due = this.now - t.due < t.repeat ? t.due + t.repeat : this.now + t.repeat), (t.at = t.due + this.lateness(this.rng, "repeat"));
				else t.at = this.now + t.repeat + this.lateness(this.rng, "repeat");
				t.seq = this.seq++;
				this.heap.push(t);
			}
			if (each || promiseActivity) return true;
			if (o.stop && o.stop()) return false;
		}
	}

	/** Install Date / timers / performance (and rAF for browsers) into a contextified global. */
	installInto(ctx, { profile = "node", onError, vmContext = ctx } = {}) {
		const clock = this,
			RealDate = vm.runInContext("Date", vmContext),
			origin = this.now;
		const Date = vm.runInContext(DATE_SRC, vmContext, { filename: "vclock.js:Date" })(RealDate, clock);

		// defineProperty: jsdom exposes some of these as getter-only accessors.
		const def = (k, v) => Object.defineProperty(ctx, k, { value: v, writable: true, configurable: true, enumerable: true });
		const wrap = (fn) => (typeof fn === "string" ? () => vm.runInContext(fn, vmContext) : fn);
		const handle = (id) => (profile === "node" ? { id, ref: H.ref, unref: H.unref, hasRef: H.hasRef, refresh: H.refresh, [Symbol.toPrimitive]: H[Symbol.toPrimitive] } : id);
		def("Date", Date);
		def("setTimeout", (fn, delay, ...args) => handle(clock.timer(wrap(fn), delay, args, false, profile, onError)));
		def("setInterval", (fn, delay, ...args) => handle(clock.timer(wrap(fn), delay, args, true, profile, onError)));
		def("clearTimeout", (h) => clock.cancel(h));
		def("clearInterval", (h) => clock.cancel(h));
		def("performance", { now: () => clock.now - origin, timeOrigin: origin, mark() {}, measure() {}, getEntriesByName: () => [] });
		if (profile === "browser") {
			const frame = 1000 / 60;
			def("requestAnimationFrame", (cb) => {
				const next = origin + Math.ceil((clock.now - origin + 0.001) / frame) * frame;
				return clock.at(next, () => cb(clock.now - origin));
			});
			def("cancelAnimationFrame", (id) => clock.cancel(id));
		}
		// Deterministic Math.random per context (seed + install order).
		vm.runInContext("Math", vmContext).random = mulberry32(this.seed * 7919 + ++this.contexts);
		return ctx;
	}
}

module.exports = { VirtualClock, mulberry32, promiseCount: () => promises };
