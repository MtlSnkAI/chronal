// Replays of recorded runs (lib/rec.js recordings; docs/reference/recording.md): the game's own page of the recorded
// character, from the viewer's backend (server.js), with its socket replaced by one that plays the recording on the
// page's own clock (timewarp.js: speed, pause, seek). View only.
//   /replay/<run id>/<name>[?t=<s from the recording's start> | ?v=<virtual ms>][&base=<virtual ms>][&max=<speed>][&speed=<x>][&paused=1]
//   /__rec/<run id>/<name>/idx      the recording's index (JSON)
//   /__rec/<run id>/<name>/<k>      its member k (gzip)
// A page in a frame (the dashboard) takes postMessage { replay: "seek", v | t }, { replay: "speed", f, paused }
// and { replay: "base", v }, and posts { replay: "time", v, first, last, speed, max, paused, ready } to its parent every 250 ms
// (max: the top of its speed slider).
"use strict";
const fs = require("fs");
const path = require("path");
const { readIndex, fold } = require("../lib/rec");
const { initScript } = require("./timewarp");

const RUN_ID = require("../lib/runs").RUN_ID,
	NAME = /^[\w-]{1,40}$/;
const VERSION = 2 ** 50; // the replay's clock versions start here

// The replay, in the page (stringified: self-contained). o: { id, name, first, max, t, v, base }; fold: lib/rec.js
// fold (its source)
function replay(o, fold) {
	const w = window, tw = w.__timewarp;
	const realNow = () => tw.real.timeOrigin + tw.real.perfNow();
	// the page's own clock: the recording's time from its first packet; speed and pause change it here
	// (paused=1: it pauses once the game is in and at its moment: a stopped clock would stop the game's loading too)
	let ver = o.version, speed = Math.max(1, Math.min(Math.max(2, o.max), o.speed || 1)), paused = false, pauseWhenIn = !!o.paused;
	const setClock = (v, f) => tw.setClock({ version: ++ver, segments: [{ r: realNow(), v, f }] });
	setClock(o.first, 1);
	const play = () => setClock(tw.now(), paused ? 0 : speed);
	class Sock {
		constructor() { this._h = Object.create(null); this.connected = false; this.disconnected = true; this.id = undefined; this.io = { opts: {}, engine: { transport: { name: "websocket" } }, on() {}, off() {} }; }
		on(e, f) { (this._h[e] = this._h[e] || []).push(f); return this; }
		addEventListener(e, f) { return this.on(e, f); }
		once(e, f) { const g = (...a) => (this.off(e, g), f.apply(this, a)); g.f = f; return this.on(e, g); }
		off(e, f) { if (e === undefined) this._h = Object.create(null); else if (!f) delete this._h[e]; else if (this._h[e]) this._h[e] = this._h[e].filter((x) => x !== f && x.f !== f); return this; }
		removeListener(e, f) { return this.off(e, f); }
		removeAllListeners(e) { return this.off(e); }
		listeners(e) { return (this._h[e] || []).slice(); }
		_fire(e, ...a) { for (const f of (this._h[e] || []).slice()) f.apply(this, a); }
		emit(e) { if (e === "loaded") this.loaded = true; return this; } // (loaded: the page has its resources)
		send() { return this; }
		onevent(p) { this._fire(...(p.data || [])); }
		_packet(p) { if (this.connected) this.onevent({ type: 2, nsp: "/", data: p }); }
		_onconnect(id) { this.id = id; this.connected = true; this.disconnected = false; this._fire("connect"); }
		disconnect() { this.connected = false; this.disconnected = true; return this; }
		close() { return this.disconnect(); }
		destroy() { return this.disconnect(); }
		open() { return this; }
		connect() { return this; }
	}
	let sock = null;
	Object.defineProperty(w, "io", { configurable: true, get: () => () => (sock = new Sock()), set() {} });
	// the game server the page connects to and the character it logs in: neither needed (the socket is the
	// recording's), but the page loads none without both, and the viewer's backend names neither (no servers, no
	// accounts): this address and the recorded name instead
	Object.defineProperty(w, "url_address", { configurable: true, get: () => w.location.host, set() {} });
	Object.defineProperty(w, "url_character", { configurable: true, get: () => o.name, set() {} });

	// the recording: its index (again every 5 s while the end is near: a run still recording grows), members on demand
	const base = "/__rec/" + encodeURIComponent(o.id) + "/" + encodeURIComponent(o.name) + "/";
	let members = [], idxAt = 0;
	const index = () => fetch(base + "idx", { cache: "no-store" }).then((r) => r.json()).then((x) => ((members = x.members), (idxAt = tw.real.perfNow())));
	const got = new Map(), asked = new Map();
	const load = (k) => {
		if (!asked.has(k))
			asked.set(k, fetch(base + k).then((r) => r.text()).then((text) => {
				let S = null;
				const recs = [];
				for (const l of text.split("\n")) {
					if (!l) continue;
					const a = l.indexOf("\t"), b = l.indexOf("\t", a + 1), rec = [Number(l.slice(0, a)), l.slice(a + 1, b), l.slice(b + 1)];
					if (rec[1] === "S") S = JSON.parse(rec[2]);
					else recs.push(rec);
				}
				recs.sort((x, y) => x[0] - y[0]); // packets in arrival order are a few ms apart at most
				const m = { S, recs };
				got.set(k, m);
				// a few members around the one playing
				for (const j of [...got.keys()]) if (Math.abs(j - k) > 3 && j !== cur.k) got.delete(j), asked.delete(j);
				return m;
			}).catch((e) => (asked.delete(k), Promise.reject(e))));
		return asked.get(k);
	};

	// its own character: a live client moves it itself (move()), so the server's packets never move it. The moves the
	// recorded client sent ("P") move it here as its move() did; the server's position in "player" packets only
	// corrects a real jump (a respawn, a blink: more than 60 px off)
	const ownMove = (d) => {
		const c = w.character;
		if (!c || !d || d.going_x == null) return;
		if (Math.hypot(c.real_x - d.x, c.real_y - d.y) > 2) (c.real_x = d.x), (c.real_y = d.y);
		c.from_x = c.real_x; c.from_y = c.real_y; c.going_x = d.going_x; c.going_y = d.going_y; c.moving = true;
		w.calculate_vxy(c);
	};
	const serverPos = (d) => {
		const c = w.character;
		if (!c || !d || d.x == null || Math.hypot(c.real_x - d.x, c.real_y - d.y) <= 60) return;
		(c.real_x = d.x), (c.real_y = d.y), (c.moving = !!d.moving);
		if (d.moving && d.going_x != null) (c.from_x = d.x), (c.from_y = d.y), (c.going_x = d.going_x), (c.going_y = d.going_y), w.calculate_vxy(c);
	};
	let started = null, welcomed = false; // the recording's time of the "start" packet (a seek goes no earlier)
	const deliver = ([at, k, d]) => {
		try {
			if (k === "a") sock._onconnect(d);
			else if (k === "p") {
				const p = JSON.parse(d);
				sock._packet(p);
				if (p[0] === "player") serverPos(p[1]);
				if (p[0] === "start" && started == null) started = at;
				if (p[0] === "welcome") welcomed = true;
			} else if (k === "P") ownMove(JSON.parse(d)[1]);
			else if (k === "d") sock.disconnect();
		} catch (e) {
			console.error("replay:", e);
		}
	};
	// the recording's time: the page's clock less off (a seek moves the recording against the page's clock, which only
	// runs forward: the game's own timers are due in its time)
	let off = 0;
	const recNow = () => Date.now() - off;
	const cur = { k: 0, i: 0, m: null };
	// every packet whose time has come, polled on a real timer
	const pump = () => {
		if (sock && members.length) {
			const now = recNow();
			for (;;) {
				if (!cur.m) {
					if (!got.has(cur.k)) { load(cur.k).catch(() => {}); break; }
					cur.m = got.get(cur.k);
					cur.i = 0;
				}
				const rs = cur.m.recs;
				while (cur.i < rs.length) {
					const r = rs[cur.i];
					// after "welcome" the game loads its resources and says "loaded" (the server waits for that too): until
					// then the recording waits
					if (welcomed && !sock.loaded) { off = Date.now() - r[0]; break; }
					// a seek waiting for the game to start: the packets up to its start at once (then the seek)
					if (!(r[0] <= now || (pending != null && started == null))) break;
					deliver(r);
					cur.i++;
				}
				if (cur.i < rs.length || cur.k + 1 >= members.length) break;
				cur.k++;
				cur.m = null;
			}
			if (cur.k + 1 < members.length && pending == null) load(cur.k + 1).catch(() => {});
			if (cur.k + 2 >= members.length && tw.real.perfNow() - idxAt > 5000) (idxAt = tw.real.perfNow()), index().catch(() => {});
			if (pending != null && ready()) { const v = pending; pending = null; seek(v); }
			// the end of what is recorded: paused there, never past it (a run still recording plays on once more arrives)
			const end = members[members.length - 1].last;
			if (!paused && !pauseWhenIn && started != null && pending == null && recNow() >= end) (off = Date.now() - end), (paused = true), play(), ui && ui();
			if (pauseWhenIn && pending == null && ready()) (pauseWhenIn = false), (paused = true), play(), ui && ui();
			else if (!pauseWhenIn && started != null && tw.factor() !== (paused ? 0 : speed)) play(); // (the speed asked for, from the start)
		}
		tw.real.setTimeout(pump, 16);
	};
	index().then(pump, () => console.error("replay: no index at " + base + "idx"));

	// a seek hands the client what it would know at that moment: the state at the start of the member (its "S" line),
	// folded on to the moment; its map, the entities in view (moved on along their paths), the chests on the ground,
	// its last "player" packet and its position along its last move
	const ready = () => started != null && w.character && w.current_map;
	let pending = o.v != null ? o.v : o.t != null ? o.first + o.t * 1000 : null, gen = 0;
	const along = (x, y, gx, gy, sp, ms) => {
		const dx = gx - x, dy = gy - y, dist = Math.hypot(dx, dy), s = Math.min(dist, (sp * Math.max(0, ms)) / 1000);
		return dist ? { x: x + (dx * s) / dist, y: y + (dy * s) / dist, moving: s < dist } : { x, y, moving: false };
	};
	const seek = async (T0) => {
		if (!ready()) return void (pending = T0);
		const my = ++gen, last = members.length ? members[members.length - 1].last : T0;
		const T = Math.max(started + 1, Math.min(T0, last));
		let k = 0;
		while (k + 1 < members.length && members[k + 1].first <= T) k++;
		const m = await load(k);
		if (my !== gen) return;
		const st = structuredClone(m.S);
		let j = 0;
		for (; j < m.recs.length && m.recs[j][0] <= T; j++) fold(st, m.recs[j][0], m.recs[j][1], m.recs[j][2]);
		Object.assign(cur, { k, i: j, m });
		off = Date.now() - T;
		const c = w.character, pkt = (d) => { const p = JSON.parse(d); if (p[1]) delete p[1].hitchhikers; return p; };
		if (st.map.name !== w.current_map || st.map.in !== w.current_in)
			sock._packet(["new_map", { name: st.map.name, in: st.map.in, x: st.map.x, y: st.map.y, m: st.map.m, direction: 0, entities: { type: "all", in: st.map.in, map: st.map.name, players: [], monsters: [] } }]);
		// the entities on screen go at once (no death fades); the folded ones come back
		for (const id in w.entities) {
			const e = w.entities[id];
			try { w.destroy_sprite(e, e.drawn ? undefined : "just"); } catch (err) {}
			delete w.entities[id];
		}
		const speedOf = (e) => e.speed || (w.G.monsters[e.type] || {}).speed;
		const ahead = (e) => (e.moving && e.going_x != null && speedOf(e) ? Object.assign(e, along(e.x, e.y, e.going_x, e.going_y, speedOf(e), T - e._at)) : e);
		w.future_entities = { players: {}, monsters: {} };
		sock._packet(["entities", { type: "xy", in: st.map.in, map: st.map.name, players: Object.values(st.ents.players).map(ahead), monsters: Object.values(st.ents.monsters).map(ahead) }]);
		for (const id in w.chests) if (!st.chests[id]) { try { w.destroy_sprite(w.chests[id]); } catch (err) {} delete w.chests[id]; }
		for (const id in st.chests) if (!w.chests[id]) w.add_chest(st.chests[id]);
		if (st.party) sock._packet(pkt(st.party));
		if (st.info) sock._packet(pkt(st.info));
		if (st.player) {
			const d = pkt(st.player[1])[1];
			sock._packet(["player", d]);
			// along its last move; the server's position when that is newer and far off (a respawn, a blink)
			let p = { x: d.x, y: d.y, moving: false }, g = null;
			if (st.move) {
				const mv = JSON.parse(st.move[1])[1];
				p = along(mv.x, mv.y, mv.going_x, mv.going_y, d.speed, T - st.move[0]);
				g = mv;
				if (st.player[0] > st.move[0] && Math.hypot(p.x - d.x, p.y - d.y) > 60) (p = { x: d.x, y: d.y, moving: false }), (g = null);
			}
			c.real_x = p.x; c.real_y = p.y; c.moving = p.moving;
			if (p.moving) (c.from_x = p.x), (c.from_y = p.y), (c.going_x = g.going_x), (c.going_y = g.going_y), w.calculate_vxy(c);
		}
		cam = null;
	};
	// the time shown: from the run's base when the page knows it (?base=, or { replay: "base", v } from the frame's
	// parent), else from the recording's start
	let zero = o.base != null ? o.base : o.first;
	w.__replay = { get v() { return recNow(); }, seek: (v) => seek(v) }; // (for tests and the console)
	w.addEventListener("message", (e) => {
		const m = e.data;
		if (m && m.replay === "seek") seek(m.v != null ? Number(m.v) : o.first + Number(m.t || 0) * 1000);
		if (m && m.replay === "base" && Number.isFinite(m.v)) zero = m.v;
		// { replay: "speed", f, paused } (the dashboard: a character's frame takes over the one shown before)
		if (m && m.replay === "speed") {
			if (Number.isFinite(m.f) && m.f >= 1) speed = Math.min(Math.max(2, o.max), Math.round(m.f));
			// (told to play while it still loads paused, as a frame in the background does: it plays once in; told to pause
			// then: it pauses once in, as it would)
			if (m.paused === false) pauseWhenIn = false;
			if (m.paused != null && !pauseWhenIn) paused = !!m.paused;
			play();
			if (ui) ui();
		}
	});
	let ui = null; // the bar's controls, redrawn from speed and paused

	// a lazy camera: the game centres its own character every frame (position_map); here the camera eases toward it over
	// ~250 ms of real time (the same feel at any speed), jumps on a map change or past 600 px, and the character is drawn
	// where it really is (manual_centering: the screen centre plus the camera's lag)
	let cam = null, camMap = null, camLast = 0, smooth = true;
	const wrapCamera = () => {
		const orig = w.position_map;
		w.position_map = function () {
			const c = w.character;
			if (!c || !smooth) return orig.apply(this, arguments);
			const t = tw.real.perfNow(), dt = camLast ? Math.min(t - camLast, 200) : 0, rx = c.real_x, ry = c.real_y;
			camLast = t;
			if (!cam || camMap !== w.current_map || Math.hypot(rx - cam.x, ry - cam.y) > 600) cam = { x: rx, y: ry };
			else { const k = 1 - Math.exp(-dt / 250); cam.x += (rx - cam.x) * k; cam.y += (ry - cam.y) * k; }
			camMap = w.current_map;
			c.real_x = cam.x; c.real_y = cam.y;
			try { orig.apply(this, arguments); } finally { c.real_x = rx; c.real_y = ry; }
			if (w.manual_centering) (c.x = w.c_round(w.width / 2 + w.ch_disp_x + (rx - cam.x) * w.scale)), (c.y = w.c_round(w.height / 2 + w.ch_disp_y + (ry - cam.y) * w.scale));
			else (c.x = w.c_round(rx)), (c.y = w.c_round(ry));
		};
	};
	// effects in game time: the game's fades (dying monsters, hit lines) are chains of draw_timeouts, one step per drawn
	// frame, so at 25x a 0.6 s fade still takes 20 frames and they pile up as trails. Here every step whose game time has
	// come runs in the same frame, each timed from the one before; steps that time themselves (damage numbers) as they
	// were. Monsters fading in (+0.05 alpha a frame) get the frames the playback skipped.
	let rate = 1;
	const wrapTimeouts = () => {
		const orig = w.draw_timeout, origLogic = w.draw_timeouts_logic, origFx = w.effects_logic;
		let due = null, lastV = 0, lastR = 0;
		w.draw_timeout = function (fn, ms, important) {
			if (due == null || String(fn).includes("last_fade")) return orig.apply(this, arguments);
			w.draw_timeouts.push([fn, new Date(due + ms), important, new Date(due), ms]);
		};
		w.draw_timeouts_logic = function (mode) {
			const rNow = tw.real.perfNow(), vNow = Date.now();
			if (lastR && rNow > lastR) rate = Math.max(1, (vNow - lastV) / (rNow - lastR));
			lastV = vNow; lastR = rNow;
			const now = new Date();
			for (let round = 0; round < 60; round++) {
				const ready = w.draw_timeouts.filter((t) => !(mode && mode == 2 && t[2] != 2) && now >= t[1]);
				if (!ready.length) break;
				w.draw_timeouts = w.draw_timeouts.filter((t) => !ready.includes(t));
				for (const t of ready) {
					w.DTM = 1; w.DMS = t[4] || 0; due = +t[1];
					try { t[0](); } catch (e) { console.log("draw_timeout_error: " + e); } finally { due = null; }
				}
			}
		};
		w.effects_logic = function (sp) {
			origFx.apply(this, arguments);
			if (rate > 1 && sp.type == "monster" && sp.real_alpha < 1 && !sp.dead && !Object.keys(sp.fx).length && !(sp.appearing || sp.disappearing || sp.fading_out))
				sp.real_alpha = Math.min(1, sp.real_alpha + 0.05 * (rate - 1));
		};
	};
	// the answers to the recorded client's calls (its CODE's) find no promise in this page: quiet, not a console error
	// each ("Weird resolve_deferred issue")
	const quietDeferreds = () => {
		for (const f of ["resolve_deferred", "reject_deferred"]) {
			const orig = w[f];
			w[f] = function (name) { return w.deferreds && w.deferreds[name] && w.deferreds[name].length ? orig.apply(this, arguments) : undefined; };
		}
	};
	const waitGame = () => (["position_map", "draw_timeouts_logic", "effects_logic", "resolve_deferred", "reject_deferred"].every((f) => typeof w[f] === "function") ? (wrapCamera(), wrapTimeouts(), quietDeferreds()) : tw.real.setTimeout(waitGame, 50));
	waitGame();

	// the bar: the time (measured from the run's base when the page knows it, else from the recording's start), the
	// speed (1x to the run's own, log scale), pause, the smooth camera, then the scrubber over the whole recording
	document.addEventListener("DOMContentLoaded", () => {
		const el = (tag, props, css) => Object.assign(document.createElement(tag), props, css ? { style: css } : {});
		const btn = "font:inherit;color:inherit;background:#2c313a;border:0;border-radius:6px;padding:2px 8px;cursor:pointer";
		const bar = el("div", { id: "replay-panel" });
		bar.style.cssText = "position:fixed;top:8px;left:8px;right:8px;z-index:100000;display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 10px;background:rgba(23,26,32,.9);color:#e8eaed;border-radius:8px;font:600 13px system-ui,sans-serif";
		const time = el("span", {}, "min-width:6.5em;font-variant-numeric:tabular-nums");
		const max = Math.max(2, o.max), toSpeed = (v) => Math.max(1, Math.round(Math.pow(max, v / 1000)));
		const range = el("input", { type: "range", min: 0, max: 1000, value: 0, title: "speed" }, "width:140px");
		const val = el("b", { textContent: "1x" }, "min-width:3em");
		const pause = el("button", { type: "button", textContent: "pause" });
		pause.style.cssText = btn;
		range.oninput = () => { speed = toSpeed(range.value); val.textContent = speed + "x"; play(); };
		pause.onclick = () => { paused = !paused; pause.textContent = paused ? "play" : "pause"; play(); };
		ui = () => { range.value = Math.round((1000 * Math.log(speed)) / Math.log(max)); val.textContent = speed + "x"; pause.textContent = paused ? "play" : "pause"; };
		const cb = el("label", { innerHTML: '<input type="checkbox" checked style="margin:0 4px 0 0;vertical-align:-2px">smooth camera' });
		cb.querySelector("input").onchange = (e) => { smooth = e.target.checked; cam = null; };
		const scrub = el("input", { type: "range", min: 0, max: 1, step: 0.1, value: 0, title: "seek" }, "flex:1 1 200px;min-width:120px");
		const len = el("span", {}, "font-variant-numeric:tabular-nums");
		bar.append(time, range, val, pause, cb, scrub, len);
		document.body.append(bar);
		const hms = (ms) => { const s = Math.round(ms / 1000), a = Math.abs(s); return (s < 0 ? "-" : "") + Math.floor(a / 3600) + ":" + String(Math.floor((a % 3600) / 60)).padStart(2, "0") + ":" + String(a % 60).padStart(2, "0"); };
		let dragging = false, lastSeek = 0;
		scrub.oninput = () => {
			dragging = true;
			time.textContent = hms(Number(scrub.value) - zero);
			const r = tw.real.perfNow();
			if (r - lastSeek > 120) (lastSeek = r), seek(Number(scrub.value));
		};
		scrub.onchange = () => { seek(Number(scrub.value)); dragging = false; };
		tw.real.setInterval(() => {
			const v = recNow(), first = members.length ? members[0].first : o.first, last = members.length ? members[members.length - 1].last : o.first;
			scrub.min = first; scrub.max = last; len.textContent = hms(last - zero);
			if (!dragging) (scrub.value = v), (time.textContent = hms(v - zero));
			if (w.parent !== w) w.parent.postMessage({ replay: "time", v, first, last, speed, max: Math.max(2, o.max), paused, ready: !!ready() && pending == null }, "*");
		}, 250);
	});
}

// View only: nothing but the game's canvas and the replay's bar (#replay-panel), and no input reaches the game; the bar
// takes the mouse. The wheel keeps its default: in a frame (a run page's Replay on the dashboard) it scrolls the page around it.
function viewOnly() {
	const bar = (e) => !e.type.startsWith("key") && e.target instanceof Element && e.target.closest("#replay-panel");
	for (const t of ["keydown", "keyup", "keypress", "mousedown", "mouseup", "click", "dblclick", "wheel", "contextmenu", "touchstart"])
		window.addEventListener(t, (e) => bar(e) || (e.stopImmediatePropagation(), t === "wheel" || e.preventDefault()), { capture: true, passive: false });
	document.addEventListener("DOMContentLoaded", () => {
		const style = document.createElement("style");
		style.textContent = "body > *:not(canvas):not(#replay-panel) { display: none !important } canvas { pointer-events: none }";
		document.head.appendChild(style);
	});
}

// The routes (server.js): dir() the live dir; page(name) the character's game page (path)
function routes({ dir, page }) {
	const recFile = (id, name, ext) => (RUN_ID.test(id) && NAME.test(name) ? path.join(dir(), id + ".rec", name + ".rec." + ext) : null);
	const send = (res, code, type, body, extra = {}) => (res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...extra }), res.end(body));
	// the run's own speed (the slider's end): game time over real time
	const speedOf = (id) => {
		try {
			const s = JSON.parse(fs.readFileSync(path.join(dir(), id + ".json"), "utf8"));
			return s.virtual_ms > 0 && s.real_ms > 0 ? Math.max(2, Math.round(s.virtual_ms / s.real_ms)) : 100;
		} catch (e) {
			return 100;
		}
	};
	return {
		// /replay/... and /__rec/...: true when handled
		handle(req, res, url) {
			let m = /^\/replay\/([^/]+)\/([^/]+)\/?$/.exec(url.pathname);
			if (m) {
				const [id, name] = [decodeURIComponent(m[1]), decodeURIComponent(m[2])], f = recFile(id, name, "idx");
				if (!f || !fs.existsSync(f)) return send(res, 404, "text/plain", `no recording of ${name} in run ${id}`), true;
				const q = new URLSearchParams(url.search);
				q.set("chronal_replay", id);
				return res.writeHead(302, { location: page(name) + "?" + q }).end(), true;
			}
			m = /^\/__rec\/([^/]+)\/([^/]+)\/(idx|\d+)$/.exec(url.pathname);
			if (!m) return false;
			const [id, name, what] = [decodeURIComponent(m[1]), decodeURIComponent(m[2]), m[3]], idx = recFile(id, name, "idx");
			if (!idx || !fs.existsSync(idx)) return send(res, 404, "text/plain", "no such recording"), true;
			const x = readIndex(idx);
			if (what === "idx") return send(res, 200, "application/json", JSON.stringify(x)), true;
			const mb = x.members[Number(what)];
			if (!mb) return send(res, 404, "text/plain", "no such member"), true;
			const fd = fs.openSync(recFile(id, name, "gz"), "r"), buf = Buffer.alloc(mb.len);
			try {
				fs.readSync(fd, buf, 0, mb.len, mb.off);
			} finally {
				fs.closeSync(fd);
			}
			return send(res, 200, "text/plain; charset=utf-8", buf, { "content-encoding": "gzip", "cache-control": "private, max-age=3600" }), true;
		},
		// the scripts of a replay's page (?chronal_replay=<run id>, the query /replay/ passed on): the time warp on a
		// clock of its own, view only, the replay; null: no such recording
		script(url) {
			const q = url.searchParams, id = q.get("chronal_replay"), name = decodeURIComponent(url.pathname.split("/")[2] || "");
			const idx = recFile(id, name, "idx");
			if (!idx || !fs.existsSync(idx)) return null;
			const x = readIndex(idx), first = x.members.length ? x.members[0].first : 0;
			const num = (k) => (q.get(k) != null && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : null);
			const o = { id, name, first, version: VERSION, max: num("max") || speedOf(id), t: num("t"), v: num("v"), base: num("base"), paused: q.get("paused") === "1", speed: num("speed") };
			const clock = { version: VERSION, segments: [{ r: performance.timeOrigin + performance.now(), v: first, f: 1 }] };
			return `<script>${initScript(clock)}</script><script>(${viewOnly})();(${replay})(${JSON.stringify(o)}, ${fold});</script>`;
		},
	};
}

module.exports = { routes };
