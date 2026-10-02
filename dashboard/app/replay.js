// Replay: a recorded run (w.rec: its recorded characters, lib/rec.js) in the viewer's /replay, the game's own page,
// above the run's tabs. A frame per recorded character, kept: the one shown plays; the others load in the background
// (one at a time), paused, and a switch shows one at the same moment (a seek), at the same speed. The frame's messages
// give the replay's time: a dashed line over the charts, the Characters tab at that moment. The game folded away keeps
// playing (clipped to a pixel), driven from a bar here.
import { h } from "./vendor/preact.js";
import { useState, useEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { hms, membersOf, load, save, api } from "./lib.js";
import { S, signal, useSignal, redraw, viewerAsk, gridLoad, baseOf } from "./store.js";
import { weaponOf } from "./art.js";
import { Status } from "./ui.js";

const html = htm.bind(h);
// the replay's time (its frame's messages: virtual ms; base: the run's 0:00 on that clock), the character shown, the
// sheets at that moment
export const rp = { time: signal(null), shown: signal(null), sheets: signal(new Map()) };
const frames = new Map(); // name -> its iframe
let rpId = null, who = null; // the run replayed; the character picked
let lvMin = load("dash_lvmin", false, (x) => x === "1"); // the game folded away
// Replay is on for a run with recordings, while the dashboard can serve the viewer
export const rpMode = (w) => !!(w && Array.isArray(w.rec) && w.rec.length && S.cst && S.cst.viewer);
// the character the frame watches: the one picked, else the first fighter (of the recorded ones)
const watchedOf = (w) => { const ms = membersOf(w).filter((p) => w.rec.includes(p.name)); return ms.find((p) => p.name === who) || ms.find((p) => p.type !== "merchant") || ms[0]; };
const post = (f, m) => f && f.contentWindow && f.contentWindow.postMessage(m, "*");
// the replay plays from v (virtual ms)
export function rpSeek(v) {
	const t = rp.time.v;
	post(frames.get(rp.shown.v), { replay: "seek", v });
	if (t) rp.time.set({ ...t, v });
}
// the replay as that character (a run's lane: only while that run is replayed)
export function rpWatch(name, w) {
	if ((w && w.id !== rpId) || !rpId || name === rp.shown.v) return;
	const x = S.data.find((y) => y.id === rpId);
	if (x && x.rec.includes(name)) (who = name), redraw();
}

export function ReplayFrame({ w }) {
	const [list, setList] = useState([]), ready = useRef(new Set()), based = useRef(new Map()), [, bump] = useState(0);
	const me = watchedOf(w), up = !!(S.cst && S.cst.viewer && S.cst.viewer.up);
	useEffect(() => { viewerAsk(); gridLoad(w); }); // (the viewer runs while asked for; the replay's base: the grid's)
	// a frame per character, made once: at the moment shown, paused unless it is the one shown
	const src = (name, shown) => { const t = rp.time.v; return "replay/" + encodeURIComponent(w.id) + "/" + encodeURIComponent(name) + "?" + (t ? "v=" + Math.round(t.v) : shown ? "" : "t=0") + (t && t.speed > 1 ? "&speed=" + t.speed : "") + (!shown || (t && t.paused) ? "&paused=1" : ""); };
	// another run, or gone: none kept
	useEffect(() => {
		rpId = w.id;
		return () => { frames.clear(); rpId = null; sheetV = null; rp.time.set(null); rp.shown.set(null); rp.sheets.set(new Map()); };
	}, [w.id]);
	// the one to watch shown (made if it isn't yet), the one before paused
	useEffect(() => {
		if (!up || !me || rp.shown.v === me.name) return;
		const old = frames.get(rp.shown.v), had = frames.has(me.name), t = rp.time.v;
		if (!had) setList((l) => (l.some((x) => x.name === me.name) ? l : [...l, { name: me.name, src: src(me.name, true) }]));
		else if (t) post(frames.get(me.name), { replay: "seek", v: t.v }), post(frames.get(me.name), { replay: "speed", f: t.speed, paused: t.paused });
		if (old) post(old, { replay: "speed", paused: true });
		rp.shown.set(me.name);
	}, [up, me && me.name]);
	// the frames' messages: the run's base to each once known (its clock then reads as the charts'); once one is ready,
	// the next character's frame loads; the shown one's time
	useEffect(() => {
		const f = (e) => {
			const m = e.data, fe = [...frames].find(([, x]) => x.contentWindow === e.source);
			if (!m || m.replay !== "time" || !fe) return;
			const [name, el] = fe, base = baseOf(w);
			if (base != null && based.current.get(name) !== base) post(el, { replay: "base", v: base }), based.current.set(name, base);
			if (m.ready && !ready.current.has(name)) {
				ready.current.add(name);
				bump((n) => n + 1);
				setList((l) => { const next = w.rec.find((n) => !l.some((x) => x.name === n) && membersOf(w).some((p) => p.name === n)); return next ? [...l, { name: next, src: src(next, false) }] : l; });
			}
			if (name === rp.shown.v) rp.time.set({ id: w.id, v: m.v, speed: m.speed, paused: m.paused, max: m.max, first: m.first, last: m.last, base });
		};
		addEventListener("message", f);
		return () => removeEventListener("message", f);
	}, [w.id]);
	if (!me) return null;
	if (!up) return html`<div class="lvf"><div class="lvwait"><${Status} dot="stopped" text="starting the viewer (the game's page)..." /></div></div>`;
	const ms = membersOf(w).filter((p) => w.rec.includes(p.name)), shown = rp.shown.v;
	return html`<div class=${"lvf" + (lvMin ? " min" : "")}>
		<div class="lvh">
			${lvMin ? null : html`<span class="seg sm" role="group" aria-label="Watch">${ms.map((p) => html`<button type="button" aria-pressed=${p === me} onClick=${() => ((who = p.name), redraw())}>${weaponOf(p, 18)}${p.name}</button>`)}</span>`}
			<button type="button" class="cb" aria-pressed=${lvMin} onClick=${() => { lvMin = !lvMin; save("dash_lvmin", lvMin ? "1" : "0"); redraw(); }}>${lvMin ? "Show the game" : "Hide the game"}</button>
		</div>
		<${Bar} w=${w} />
		<div class="lvfs">${list.map((x) => html`<iframe key=${x.name} src=${x.src} title=${"the replay: " + x.name} class=${x.name === shown ? "" : ready.current.has(x.name) ? "off" : "pre"} ref=${(el) => el && frames.set(x.name, el)}></iframe>`)}</div>
	</div>`;
}
// the bar of a folded replay (the frame's own, here): play/pause, the time, a scrubber over the recording, the speed;
// a slider held: its updates wait
const speedOf = (v, max) => Math.max(1, Math.round(Math.pow(max || 2, v / 1000)));
function Bar({ w }) {
	const m = useSignal(rp.time), [seekV, setSeek] = useState(null), [spd, setSpd] = useState(null), at = useRef(0);
	if (!m) return html`<div class="rpc"><button type="button" class="cb" disabled>pause</button><span class="rpt">-</span></div>`;
	const base = baseOf(w), z = base != null ? base : m.first, f = () => frames.get(rp.shown.v), v = seekV ?? m.v;
	const sv = spd ?? Math.round((1000 * Math.log(Math.max(1, m.speed))) / Math.log(Math.max(2, m.max || 2)));
	return html`<div class="rpc">
		<button type="button" class="cb" data-rpp="1" onClick=${() => post(f(), { replay: "speed", f: m.speed, paused: !m.paused })}>${m.paused ? "play" : "pause"}</button>
		<span class="rpt">${hms(Math.max(0, v - z)) + " / " + hms(Math.max(0, m.last - z))}</span>
		<input type="range" data-rpseek="1" min=${m.first} max=${m.last} value=${v} aria-label="The replay's time"
			onInput=${(e) => { const x = Number(e.currentTarget.value); setSeek(x); if (Date.now() - at.current > 120) (at.current = Date.now()), rpSeek(x); }} onChange=${(e) => { rpSeek(Number(e.currentTarget.value)); setSeek(null); }} />
		<span class="rps">${(spd != null ? speedOf(spd, m.max) : m.speed) + "x"}</span>
		<input type="range" data-rpspd="1" min="0" max="1000" value=${sv} aria-label="The replay's speed"
			onInput=${(e) => { const x = Number(e.currentTarget.value); setSpd(x); post(f(), { replay: "speed", f: speedOf(x, m.max), paused: m.paused }); }} onChange=${() => setSpd(null)} />
	</div>`;
}
// the Characters tab of a replay: each recorded character's sheet at the replay's moment (api/rec), fetched again once
// the moment has moved a game second or more (at most twice a real second)
let sheetV = null, sheetAt = 0;
export function useRpSheets(w, on) {
	const t = useSignal(rp.time), sheets = useSignal(rp.sheets);
	useEffect(() => {
		if (!on || !t || t.id !== w.id || (sheetV != null && Math.abs(t.v - sheetV) < 1000) || Date.now() - sheetAt < 500) return;
		const v = Math.round(t.v), id = w.id;
		sheetV = v; sheetAt = Date.now();
		Promise.all(w.rec.map((n) => api("api/rec/" + encodeURIComponent(id) + "/" + encodeURIComponent(n) + "/sheet?v=" + v).then((r) => (r.ok ? r.json() : null)).catch(() => null))).then((xs) => {
			if (rpId !== id) return;
			rp.sheets.set(new Map(w.rec.map((n, i) => [n, xs[i]])));
		});
	});
	return { sheets, now: t && t.id === w.id ? t : null };
}
