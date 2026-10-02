// The dashboard's state that every page shares: the runs (api/live, polled each second), the dashboard's own state
// (api/control: the viewer, sim threads, the launches it started), the run control's requests, each run's grid and
// setup file as they load; the page drawn again when any of it changes (redraw: the App's, main.js).
import { useState, useLayoutEffect } from "./vendor/hooks.js";
import { api, live_ } from "./lib.js";

// ---- a value its components follow (redrawn when it is set), and the App's (everything) as one of them
export function signal(v) {
	const s = { v, subs: new Set(), set(x) { s.v = x; for (const f of [...s.subs]) f(); } };
	return s;
}
export function useSignal(s) {
	const [, bump] = useState(0), seen = s.v;
	useLayoutEffect(() => {
		const f = () => bump((n) => n + 1);
		s.subs.add(f);
		if (s.v !== seen) f(); // (set between the render and now)
		return () => s.subs.delete(f);
	}, [s]);
	return s.v;
}
// the game's tooltip open (tips.js: { key, el, form, html, ... }); the item or condition it is of shows it is open
// (aria-expanded: that one, not the others of its kind: ref, its element)
export const itip = signal(null);
export const useTipOpen = (ref) => { const t = useSignal(itip); return !!t && !t.form && !!ref.current && t.el === ref.current; };
const app = signal(0);
export const redraw = () => app.set(app.v + 1);
export const useRedraw = () => useSignal(app);

// ---- the runs and the dashboard's state
export const S = { data: [], cst: null, loaded: false };
let readyNow;
export const ready = new Promise((r) => (readyNow = r)); // (once the first answer of api/live has come)
export const getData = () => S.data, getCst = () => S.cst;
export const launchesOf = () => (S.cst && Array.isArray(S.cst.launches) ? S.cst.launches : []);
export const activeL = (l) => l.state === "starting" || l.state === "queued";
// the run control's requests: stops asked (run id -> when), notes (a run's or "tools": why an action failed), the open
// logs of launches (key -> their last lines), failed launches dismissed
export const stopAt = new Map(), notes = new Map(), logs = new Map(), dismissed = new Set();
const hurry = () => launchesOf().some((l) => l.state === "starting") || S.data.some((w) => w.ctl && w.ctl.pending) || stopAt.size > 0;
let cstAt = 0;
export async function ctlLoad() {
	cstAt = Date.now();
	try { const r = await fetch("api/control"); S.cst = r.ok ? await r.json() : null; } catch (e) {}
	await Promise.all([...logs.keys()].map(async (k) => { try { const r = await fetch("api/launch/" + encodeURIComponent(k) + "/log?tail=60"); if (r.ok && logs.has(k)) logs.set(k, (await r.json()).lines || []); } catch (e) {} }));
}
// the next poll at once (a launch started: its row comes sooner)
export const pollSoon = () => ((cstAt = 0), ctlLoad().then(redraw));
// a run as it was (the same object, so what is worked out from it stays) while its snapshot, state, control and
// recordings are; else the new one
const sigOf = (w) => w.updated + "|" + w.state + "|" + JSON.stringify(w.ctl || null) + "|" + JSON.stringify(w.rec || null);
const sigs = new WeakMap();
const before = []; // (each poll's: what else is due, e.g. the cards' settings)
export const onPoll = (f) => before.push(f);
export const lastError = signal("");
async function poll() {
	let got = false;
	if (!document.hidden) try {
		for (const f of before) await f();
		const fresh = await (await fetch("api/live")).json(), old = new Map(S.data.map((w) => [w.id, w]));
		got = true;
		const next = fresh.map((w) => {
			for (const k of ["players", "speed", "gold"]) w[k] ||= k === "players" ? [] : {};
			const o = old.get(w.id), s = sigOf(w);
			if (o && sigs.get(o) === s) return o;
			sigs.set(w, s);
			return w;
		});
		const same = next.length === S.data.length && next.every((w, i) => w === S.data[i]);
		if (!same) S.data = next;
		S.loaded = true;
		readyNow();
		for (const id of [...stopAt.keys()]) { const w = S.data.find((x) => x.id === id); if (!w || !live_(w)) stopAt.delete(id); }
		if (Date.now() - cstAt >= (hurry() ? 0 : 5000)) await ctlLoad();
		lastError.set("");
		redraw();
		dispatchEvent(new Event("chronal:poll")); // (the pages that follow the runs)
	} catch (e) {
		lastError.set((got ? "dashboard error: " : "dashboard unreachable: ") + e.message);
	}
	setTimeout(poll, 1000);
}
let started = false;
export function start() { if (!started) (started = true), poll(); }
// a run gone from the list (removed here)
export const dropRuns = (keep) => { S.data = S.data.filter(keep); redraw(); };

// ---- the URL: to another page (a new history entry), or the same page changed (its tab, the replay, Compare's series:
// replaced)
export function nav(hash, replace) {
	if (location.hash === hash) return;
	if (!replace) return void (location.hash = hash);
	history.replaceState(null, "", hash);
	dispatchEvent(new HashChangeEvent("hashchange"));
}
export const runHash = (id, tab, replay) => "#/runs/" + encodeURIComponent(id) + (tab ? "/" + tab : "") + (replay ? "?replay" : "");
export const cmpHash = (ids, tab) => "#/compare" + (tab && tab !== "summary" ? "/" + tab : "") + "?ids=" + ids.map(encodeURIComponent).join(",");

// ---- a run's fixed game-time grid (<id>.grid.ndjson: every character's ledgers each 30 game s, read by byte offset
// from api/grid as the file grows): run id -> { gen, next, cols, step, rows, busy, missing, sig }
export const grids = new Map();
export async function gridLoad(w) {
	const gi = w.grid;
	if (!gi || typeof gi !== "object") return;
	let g = grids.get(w.id);
	if (!g) grids.set(w.id, (g = { gen: gi.gen || 0, next: 0, cols: Array.isArray(gi.cols) ? gi.cols : null, step: gi.step_ms || null, rows: [], busy: false, missing: false, sig: "" }));
	const sig = w.updated + "|" + (gi.gen || 0) + "|" + gi.lines;
	if (g.busy || g.missing || g.sig === sig) return;
	g.busy = true;
	let ok = true;
	try {
		for (let i = 0; i < 64; i++) {
			const r = await fetch("api/grid/" + encodeURIComponent(w.id) + "?from=" + g.next + "&gen=" + encodeURIComponent(g.gen));
			if (r.status === 404) { g.missing = true; break; }
			if (!r.ok) { ok = false; break; }
			const o = await r.json();
			if (o.reset) (g.rows = []), (g.gen = o.gen);
			for (const line of o.text.split("\n")) {
				if (!line) continue;
				try {
					const x = JSON.parse(line);
					if (Array.isArray(x.cols)) (g.cols = x.cols), (g.step = x.step_ms || g.step);
					else if (x && x.r && typeof x.r === "object" && Number.isFinite(x.t) && (!g.rows.length || x.t > g.rows[g.rows.length - 1].t)) g.rows.push(x);
				} catch (e) {}
			}
			g.next = o.next;
			if (!o.more) break;
		}
	} catch (e) { ok = false; }
	g.busy = false;
	if (ok) g.sig = sig;
	g.ver = (g.ver || 0) + 1;
	redraw();
}
// what a drawing from a run's grid depends on (its rows as loaded)
export const gridVer = (w) => { const g = grids.get(w.id); return g ? g.ver + "/" + g.rows.length + "/" + g.gen + g.missing : ""; };
// the run's base on the replay's clock: a grid row's v less its t (the charts' 0:00)
export const baseOf = (w) => { const g = grids.get(w.id), r = g && g.rows.find((x) => Number.isFinite(x.v) && Number.isFinite(x.t)); return r ? r.v - r.t * 1000 : null; };

// ---- a run's items' events (<id>.items.ndjson: loot, upgrade and compound tries, handovers, a line each, read by byte
// offset from api/items as the file grows): run id -> { next, ev, busy, missing, sig }
export const itemLogs = new Map();
export async function itemsLoad(w) {
	const li = w.items_log;
	if (!li || typeof li !== "object") return;
	let g = itemLogs.get(w.id);
	if (!g) itemLogs.set(w.id, (g = { next: 0, ev: [], busy: false, missing: false, sig: "" }));
	const sig = w.updated + "|" + li.lines;
	if (g.busy || g.missing || g.sig === sig) return;
	g.busy = true;
	let ok = true;
	try {
		for (let i = 0; i < 64; i++) {
			const r = await fetch("api/items/" + encodeURIComponent(w.id) + "?from=" + g.next);
			if (r.status === 404) { g.missing = true; break; }
			if (!r.ok) { ok = false; break; }
			const o = await r.json();
			if (o.reset) g.ev = [];
			for (const line of o.text.split("\n")) {
				if (!line) continue;
				try { const x = JSON.parse(line); if (x && typeof x.k === "string" && Number.isFinite(x.t)) g.ev.push(x); } catch (e) {}
			}
			g.next = o.next;
			if (!o.more) break;
		}
	} catch (e) { ok = false; }
	g.busy = false;
	if (ok) g.sig = sig;
	redraw();
}

// ---- a run of a setup: its setup file (api/setup/<id>, fetched once per run): run id -> { s: the file, null (none)
// or undefined (loading) }
const setups = new Map();
export function setupOf(w) {
	let e = setups.get(w.id);
	if (!e) {
		setups.set(w.id, (e = { s: undefined }));
		fetch("api/setup/" + encodeURIComponent(w.id)).then((r) => (r.ok ? r.json() : null)).catch(() => null).then((s) => {
			if (s === null && e.s) return;
			e.s = s;
			redraw();
		});
	}
	return e.s;
}
export const setupVer = (w) => (setups.get(w.id) && setups.get(w.id).s !== undefined ? "s" : "");

// ---- the viewer (the game's page that plays recordings, served here) runs on demand: asked for while a Replay frame
// shows; the ask starts its backend and counts as its use (about once a minute; every 3 s while it starts); unused,
// the dashboard closes it
let viewerAt = 0;
export function viewerAsk() {
	const v = S.cst && S.cst.viewer;
	if (!v || Date.now() - viewerAt < (v.up ? 60e3 : 3e3)) return;
	viewerAt = Date.now();
	api("api/viewer", "POST", {}).then((r) => r.json()).then((o) => { if (o && !!o.up !== !!v.up) (v.up = !!o.up), redraw(); }).catch(() => {});
}
