// Time warp for the viewer's pages: an init script that runs in every frame before the page's own scripts and puts
// the frame's Date, performance.now, timers and animation frame timestamps on a virtual clock, which the replay script
// sets (replay.js: speed, pause, seek). The clock is a list of segments { r, v, f }: from real time r on, virtual
// time is v + (real now - r) * f; versions only grow (an older clock never replaces a newer one). Timers keep their own
// heap ordered by virtual due time and run one callback per macrotask, as browsers do. Child frames (the CODE iframe)
// share the top frame's clock.
"use strict";

// Runs inside each frame. Keep it self-contained (it is stringified).
function pageInstall(embedded) {
	const w = window;
	if (w.__timewarp) return;
	const real = {
		setTimeout: w.setTimeout.bind(w),
		clearTimeout: w.clearTimeout.bind(w),
		setInterval: w.setInterval.bind(w),
		clearInterval: w.clearInterval.bind(w),
		Date: w.Date,
		perfNow: w.performance.now.bind(w.performance),
		timeOrigin: w.performance.timeOrigin,
	};
	const RealDate = real.Date,
		realNow = () => real.timeOrigin + real.perfNow();
	let top = null;
	try {
		if (w.top !== w && w.top.__timewarp) top = w.top.__timewarp;
	} catch (e) {} // cross-origin top: own state

	// ---------------------------------------------------------- clock
	let segs = [{ r: realNow(), v: realNow(), f: 1 }],
		version = -1;
	const segIndex = (r) => {
		let i = 0;
		while (i + 1 < segs.length && segs[i + 1].r <= r) i++;
		return i;
	};
	const virtualAt = (r) => {
		const s = segs[segIndex(r)];
		return s.v + (r - s.r) * s.f;
	};
	// the frames of one page share `shared` (one thread): a page and its CODE iframe read the same time, never backwards
	const shared = top ? top.shared : { last: -Infinity };
	const now = () => {
		const v = virtualAt(realNow());
		if (v > shared.last) shared.last = v;
		return shared.last;
	};
	// the earliest real time at which the clock reaches v (Infinity: paused before it)
	const realAt = (v) => {
		const rn = realNow();
		if (v <= now()) return rn;
		for (let i = segIndex(rn); i < segs.length; i++) {
			const s = segs[i],
				end = segs[i + 1] ? segs[i + 1].r : Infinity;
			if (s.f > 0) {
				const r = s.r + (v - s.v) / s.f;
				if (r < end) return Math.max(r, rn);
			} else if (v <= s.v) return Math.max(s.r, rn);
		}
		return Infinity;
	};
	const setClock = (c) => {
		if (!c || !Array.isArray(c.segments) || !c.segments.length) return false;
		if (c.version !== undefined && c.version <= version) return false;
		segs = c.segments.map((s) => ({ r: +s.r, v: +s.v, f: +s.f })).sort((a, b) => a.r - b.r);
		version = c.version;
		arm();
		return true;
	};
	const factor = () => segs[segIndex(realNow())].f;

	// ---------------------------------------------------------- Date
	function VDate(a, b, c, d, e, f, g) {
		if (!new.target) return new RealDate(Math.floor(now())).toString();
		const n = arguments.length;
		if (n === 0) return new RealDate(Math.floor(now()));
		if (n === 1) return new RealDate(a);
		return new RealDate(a, b, n > 2 ? c : 1, n > 3 ? d : 0, n > 4 ? e : 0, n > 5 ? f : 0, n > 6 ? g : 0);
	}
	// same prototype: Dates made anywhere are `instanceof Date` and vice versa
	VDate.prototype = RealDate.prototype;
	VDate.now = () => Math.floor(now());
	VDate.parse = RealDate.parse;
	VDate.UTC = RealDate.UTC;
	Object.defineProperty(VDate, "name", { value: "Date" });
	Object.defineProperty(VDate, "length", { value: 7 });
	VDate.toString = () => "function Date() { [native code] }";

	// ---------------------------------------------------------- timers
	const heap = [], // { due, seq, t, gen }, lazy deletion
		byId = new Map();
	let seq = 0,
		nextId = 1,
		nesting = 0; // the running callback's nesting level (HTML: nested timers are clamped to 4 ms past level 5)
	const less = (a, b) => a.due < b.due || (a.due === b.due && a.seq < b.seq);
	function push(e) {
		heap.push(e);
		for (let i = heap.length - 1; i > 0; ) {
			const p = (i - 1) >> 1;
			if (!less(heap[i], heap[p])) break;
			[heap[i], heap[p]] = [heap[p], heap[i]];
			i = p;
		}
	}
	function pop() {
		const first = heap[0],
			end = heap.pop();
		if (heap.length) {
			heap[0] = end;
			for (let i = 0; ; ) {
				const l = 2 * i + 1,
					r = l + 1;
				let m = i;
				if (l < heap.length && less(heap[l], heap[m])) m = l;
				if (r < heap.length && less(heap[r], heap[m])) m = r;
				if (m === i) break;
				[heap[i], heap[m]] = [heap[m], heap[i]];
				i = m;
			}
		}
		return first;
	}
	function peek() {
		while (heap.length) {
			const e = heap[0];
			if (e.t.active && e.gen === e.t.gen) return e;
			pop();
		}
		return null;
	}
	function enqueue(t, due) {
		t.gen++;
		t.due = due;
		push({ due, seq: ++seq, t, gen: t.gen });
	}
	function add(cb, ms, args, repeat) {
		if (typeof cb !== "function") {
			const code = String(cb);
			cb = () => (0, eval)(code);
		}
		ms = Number(ms);
		const t = { id: nextId++, cb, args, delay: ms > 0 && ms <= 2147483647 ? ms : 0, repeat, active: true, gen: 0, due: 0, nesting: nesting + 1 };
		if (t.nesting > 5 && t.delay < 4) t.delay = 4;
		byId.set(t.id, t);
		enqueue(t, now() + t.delay);
		arm();
		return t;
	}
	function cancel(t) {
		if (!t || !t.active) return;
		t.active = false;
		t.gen++;
		byId.delete(t.id);
	}

	// one callback per macrotask; the driver: a real timeout until the earliest due time (at least every 100 ms, to
	// notice clock changes), a message task for what is due now (no 4 ms clamp)
	const ch = new w.MessageChannel();
	ch.port1.onmessage = () => fire();
	let driver = null,
		driverAt = Infinity;
	function arm() {
		const e = peek(),
			rn = realNow(),
			at = e ? realAt(e.due) : Infinity;
		if (driver !== null && driverAt <= at) return;
		if (driver !== null && driver !== "now") real.clearTimeout(driver);
		driver = null;
		driverAt = Infinity;
		if (!e) return;
		const wake = Math.min(at, rn + 100);
		if (wake <= rn) (driver = "now"), ch.port2.postMessage(0);
		else driver = real.setTimeout(fire, wake - rn);
		driverAt = wake;
	}
	function fire() {
		driver = null;
		driverAt = Infinity;
		// a child frame picks up a newer clock from the top frame whenever it wakes
		if (top && top.version() > version) setClock(top.getClock());
		const v = now(),
			e = peek();
		if (!e || e.due > v) return arm();
		pop();
		const t = e.t;
		if (t.repeat) {
			if (++t.nesting > 5 && t.delay < 4) t.delay = 4;
			// the nominal cadence, unless a whole period was missed
			enqueue(t, v - t.due < t.delay ? t.due + t.delay : v + t.delay);
		} else {
			t.active = false;
			byId.delete(t.id);
		}
		arm(); // before the callback: a throwing callback doesn't stall the clock
		nesting = t.nesting;
		try {
			t.cb.apply(w, t.args);
		} finally {
			nesting = 0;
		}
	}

	setClock((top && top.getClock()) || embedded);

	// ---------------------------------------------------------- the frame's own clocks
	w.Date = VDate;
	const vOrigin = virtualAt(real.timeOrigin);
	w.performance.now = () => now() - vOrigin;
	Object.defineProperty(w.performance, "timeOrigin", { get: () => vOrigin, configurable: true });
	w.setTimeout = function setTimeout(cb, ms, ...args) {
		return add(cb, ms, args, false).id;
	};
	w.setInterval = function setInterval(cb, ms, ...args) {
		return add(cb, ms, args, true).id;
	};
	w.clearTimeout = function clearTimeout(id) {
		cancel(byId.get(+id));
	};
	w.clearInterval = function clearInterval(id) {
		cancel(byId.get(+id));
	};
	// the screen's real frames, with virtual timestamps
	const realRaf = w.requestAnimationFrame.bind(w);
	w.requestAnimationFrame = function requestAnimationFrame(cb) {
		return realRaf(() => cb(w.performance.now()));
	};

	Object.defineProperty(w, "__timewarp", {
		enumerable: false,
		value: {
			real, // for libraries that must keep real time (REAL_TIME_LIBS) and the replay's own loop
			now,
			factor,
			shared,
			getClock: () => ({ version, segments: segs.map((s) => ({ ...s })) }),
			version: () => version,
			// also hands the clock to same-origin child frames (found through their elements: the game overwrites the
			// global `frames`)
			setClock(c) {
				setClock(c);
				for (const el of w.document.querySelectorAll("iframe")) {
					try {
						if (el.contentWindow && el.contentWindow.__timewarp) el.contentWindow.__timewarp.setClock(c);
					} catch (e) {}
				}
			},
		},
	});
}

// Scripts that keep real timers: the socket.io client's
const REAL_TIME_LIBS = /\/js\/socket\.io\/[^/]+\/socket\.io(\.min)?\.js/;
const realTimeWrap = (src) =>
	`(function (setTimeout, clearTimeout, setInterval, clearInterval, Date) {\n${src}\n}).call(this, ...(function (r) { return [r.setTimeout, r.clearTimeout, r.setInterval, r.clearInterval, r.Date]; })(window.__timewarp.real));`;

/** The init script of a page (clock: { version, segments: [{ r, v, f }] }, real r: epoch ms) */
const initScript = (clock) => `(${pageInstall})(${JSON.stringify(clock)});`;

module.exports = { initScript, REAL_TIME_LIBS, realTimeWrap };
