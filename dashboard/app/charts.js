// The charts over game time from 0:00 (a run's Data panels over time, Buffs and Supply; Compare's timeline): a metric
// (metrics.js DATA) per chart, every character (the merchant too; none or 0: its key dimmed) and the party's sum, as a
// rate over an automatic window or its total so far; the buffs as lanes per condition and character. From the run's grid (store.js gridLoad), else its
// history rows. A crosshair and readout follow the pointer over a box of charts; a replay's moment is a dashed line
// (a click on a chart of the replayed run plays it from there). Compare's strip plot and sweep chart too.
import { h } from "./vendor/preact.js";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtN, hms, hm, pct, pctU, num, clamp01, tick, dur, cvar, agg, load, save } from "./lib.js";
import { signal, useSignal, redraw, gridLoad, gridVer, grids, baseOf } from "./store.js";
import { mon, icon, condName, condIcon, kindOf, PSEUDO, Cond, artVer } from "./art.js";
import { statsOf, activeOf, timeData, levelOf, deathsOf, steersOf, rateAt, sumCols, autoWin, fmtMS, keyName, aggOf } from "./metrics.js";
import { Fold } from "./ui.js";
import { rp, rpSeek, rpWatch } from "./replay.js";

const html = htm.bind(h);
// remembered in this browser: the series hidden in the graphs
let ghide = new Set(load("dash_ghide", [], JSON.parse)), ghideV = 0;
const toggleSeries = (id) => { ghide.has(id) ? ghide.delete(id) : ghide.add(id); ghideV++; save("dash_ghide", JSON.stringify([...ghide])); redraw(); };
// what a drawing of charts depends on besides its runs: the series hidden, the monsters' art
export const chartsVer = () => ghideV + "/" + artVer;

// ---- geometry: y labels left of the plot, a unit label above them, the time labels under it
export const GW = { g: 52, r: 14, top: 18, h: 220, bottom: 22 };
// the characters' lines: the class colour, and a pattern by their place among the lines, so lines on top of each other
// (a party shares its xp evenly) still show every colour; a key in that pattern beside each name
const DASH = ["", "7 4", "2 3", "9 3 2 3", "4 2"];
export const Lkey = ({ i, css, wd }) => html`<svg class="lk" viewBox="0 0 20 8" aria-hidden="true" style=${css || null}><line x1="1" y1="4" x2="19" y2="4" stroke-width=${wd || null} stroke-dasharray=${DASH[i % DASH.length] || "none"} /></svg>`;
const xTicks = (T, pw) => { const st = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200, 10800, 21600, 43200, 86400].find((x) => (pw * x) / T >= 56) || 86400, out = []; for (let x = 0; x <= T + 1e-6; x += st) out.push(x); return out; };
function yTicks(lo, hi, n, int) {
	if (!(hi > lo)) hi = lo + 1;
	const raw = (hi - lo) / n, e = 10 ** Math.floor(Math.log10(raw)), st = Math.max(int ? 1 : 0, (int ? [1, 2, 5, 10] : [1, 2, 2.5, 5, 10]).map((m) => m * e).find((x) => x >= raw * 0.999));
	const out = [];
	for (let v = Math.floor(lo / st + 1e-9) * st; v < hi + st - 1e-9 && out.length < 12; v += st) out.push(+v.toPrecision(12));
	return out;
}
// a box of charts on one time axis: { T: game s, pw: the plot's width, W, t: the rows' times, xt: the ticks, gap (no
// line across a hole in the rows longer than it), w: the run (its crosshair readout, its replay) }, and the crosshair's
// time there (a signal its charts and lanes follow)
const box = (T, W, pw, t, gap, w, hov) => ({ T, pw, W, t, xt: xTicks(T, pw), gap, w, hov: hov || signal(null) });
// a box's crosshair, kept while its charts are drawn again (a running run's, each second)
const useHov = () => { const r = useRef(null); return (r.current ||= signal(null)); };
// the time labels at x (px) along a plot pw wide from left: h:mm, the first from its start, the last to its end, none
// on top of the one before
function xLabels(G, X, pw, left, y) {
	let right = -1e9;
	return G.xt.map((x) => {
		const px = X(x), s = hm(x), wd = s.length * 7.2, a = x === 0 ? "start" : px > left + pw - wd / 2 ? "end" : "middle", l = a === "start" ? px : a === "end" ? px - wd : px - wd / 2;
		if (l < right + 6) return null;
		right = l + wd;
		return html`<text x=${px.toFixed(1)} y=${y} text-anchor=${a}>${s}</text>`;
	});
}
// the crosshair in a chart or lane of the box (x0: where its plot starts)
function Cross({ G, x0, y1, y2 }) {
	const t = useSignal(G.hov);
	if (t == null) return null;
	const x = (x0 + (G.pw * t) / G.T).toFixed(1);
	return html`<line class="gx" x1=${x} x2=${x} y1=${y1} y2=${y2} />`;
}
// the replay's moment, when the box is of the replayed run
function Playhead({ G, x0, y1, y2 }) {
	const r = useSignal(rp.time);
	if (!r || !G.w || r.id !== G.w.id || r.base == null) return null;
	const t = (r.v - r.base) / 1000;
	if (t < 0 || t > G.T) return null;
	const x = (x0 + (G.pw * Math.min(G.T, Math.max(0, t))) / G.T).toFixed(1);
	return html`<line class="gp" x1=${x} x2=${x} y1=${y1} y2=${y2} />`;
}
// the readout under the pointer (one for the page)
const tipS = signal(null); // { x, y, body }
export function ChartTip() {
	const t = useSignal(tipS), ref = useRef(null);
	useLayoutEffect(() => {
		const e = ref.current;
		if (!t || !e) return;
		e.style.left = Math.max(4, t.x + 16 + e.offsetWidth > innerWidth - 4 ? t.x - 16 - e.offsetWidth : t.x + 16) + "px";
		e.style.top = Math.max(4, Math.min(innerHeight - e.offsetHeight - 4, t.y + 18)) + "px";
	});
	return html`<div id="tip" hidden=${!t} ref=${ref}>${t ? t.body : null}</div>`;
}
const hoverOff = (G) => { if (G.hov.v != null) G.hov.set(null); if (tipS.v) tipS.set(null); };
// the pointer's last place over a plot: the readout again there once the charts are drawn anew (a running run's,
// each second); none once they go
let ptr = null;
function useReadout(drawn) {
	useLayoutEffect(() => {
		const e = ptr && tipS.v && document.elementFromPoint(ptr.x, ptr.y);
		if (e && e.closest("svg")) e.dispatchEvent(new PointerEvent("pointermove", { clientX: ptr.x, clientY: ptr.y, bubbles: true }));
	}, [drawn]);
	useEffect(() => () => tipS.v && tipS.set(null), []);
}
// the pointer over a plot (x0: where its plot starts in el): the crosshair at the row nearest it (a chart's: on that
// row), the readout of what(t, i) under it; a mark with its own tooltip (a death, a step) takes none. -> the row (-1:
// none)
function hover(e, G, x0, what, who) {
	const d = e.target.closest("[data-tip]");
	if (d && d !== e.currentTarget && e.currentTarget.contains(d)) return hoverOff(G), -1;
	const b = e.currentTarget.getBoundingClientRect(), px = e.clientX - b.left - x0;
	if (px < -6 || px > G.pw + 6) return hoverOff(G), -1;
	const tt = Math.min(G.T, Math.max(0, (px / G.pw) * G.T)), ts = G.t;
	let i = -1, t = tt;
	if (ts.length) {
		let lo = 0, hi = ts.length - 1;
		while (hi - lo > 1) { const m = (lo + hi) >> 1; ts[m] < tt ? (lo = m) : (hi = m); }
		i = Math.abs(ts[lo] - tt) <= Math.abs(ts[hi] - tt) ? lo : hi;
		if (x0) t = ts[i];
	}
	G.hov.set(t);
	ptr = { x: e.clientX, y: e.clientY };
	const r = rp.time.v, here = G.w && r && r.id === G.w.id && baseOf(G.w) != null;
	tipS.set({ x: e.clientX, y: e.clientY, body: [what(t, i), here ? html`<br /><span class="gu">click: the replay plays from here${who && who !== rp.shown.v && G.w.rec.includes(who) ? ", as " + who : ""}</span>` : null] });
	return i;
}
// a click on a plot of the replayed run: the replay plays from that moment (a character's lane: as that character)
function seek(e, G, x0, who) {
	const r = rp.time.v, base = G.w && baseOf(G.w);
	if (!r || r.id !== G.w.id || base == null) return;
	const b = e.currentTarget.getBoundingClientRect(), t = Math.min(G.T, Math.max(0, ((e.clientX - b.left - x0) / G.pw) * G.T));
	rpSeek(base + t * 1000);
	if (who && G.w.rec.includes(who)) rpWatch(who);
}

// ---- one chart: a legend of its series (a click hides one in every chart), y ticks with gridlines, the time axis;
// series [{ id, label, lh (its label drawn), css, di (its pattern), w, vals, lo, hi (a band), tip(i), zero }]; o: { fmt,
// axis, level, deaths, steers (the snapshot's steer: a mark at the top and a dotted line), aria, from (the y-scale fits
// the values from then on) }. A series under the pointer (its line within 12 px of it, or its key) stands out: drawn
// on top, wider, the others faded
const NEAR = 12;
export function GChart({ G, unit, series, o = {} }) {
	const [foc, setFoc] = useState(null), focR = useRef(null), focus = (id) => { focR.current = id; if (foc !== id) setFoc(id); };
	const all = series.filter(Boolean), shown = all.filter((s) => s.vals && s.vals.some((v) => v != null));
	const vis = shown.filter((s) => !ghide.has(s.id)), { T, pw, W, t } = G, Ht = GW.top + GW.h + GW.bottom, f = (v) => v.toFixed(1), fmt = o.fmt || ((v) => fmtN(v));
	// the y-scale: the values from o.from (game s) on, where there are any (a rate over its first rows spikes with one
	// early kill); the ones before past its top run along it, a mark there saying how high they went
	const i0 = o.from != null ? t.findIndex((x) => x >= o.from) : -1, body = i0 > 0 && vis.some((s) => s.vals.slice(i0).some((v) => v != null)) ? i0 : 0;
	let lo = Infinity, hi = -Infinity;
	for (const s of vis) for (const xs of [s.vals, s.lo, s.hi]) if (xs) for (let i = body; i < xs.length; i++) if (xs[i] != null) (lo = Math.min(lo, xs[i])), (hi = Math.max(hi, xs[i]));
	if (!(hi >= lo)) (lo = 0), (hi = 1);
	const yt = o.level ? yTicks(Math.floor(lo), Math.max(Math.ceil(hi), Math.floor(lo) + 1), 4, true) : yTicks(Math.min(0, lo), Math.max(0, hi), 4), y0 = yt[0], y1 = yt[yt.length - 1];
	const X = (x) => GW.g + (pw * x) / T, Y = (v) => GW.top + GW.h - (GW.h * (Math.min(y1, Math.max(y0, v)) - y0)) / (y1 - y0);
	let off = null;
	for (const s of vis) for (let i = 0; i < body; i++) if (s.vals[i] > y1 && (!off || s.vals[i] > off.v)) off = { s, i, v: s.vals[i] };
	// more rows than pixels (a long run): a pixel column's lowest and highest point, so spikes stay
	const thin = t.length > 2 * pw;
	const path = (vals) => {
		let d = "", n = 0, col = null, a = null, b = null;
		const put = (i) => { d += (n++ ? "L" : "M") + f(X(t[i])) + "," + f(Y(vals[i])); };
		const flush = () => { if (a != null) { put(Math.min(a, b)); if (b !== a) put(Math.max(a, b)); } a = b = null; };
		for (let i = 0; i <= vals.length; i++) {
			if (i === vals.length || vals[i] == null || (n + (a != null) && t[i] - t[i - 1] > G.gap)) { flush(); if (n === 1) d += "h0.5"; n = 0; col = null; if (i === vals.length || vals[i] == null) continue; } // no line across a gap; a lone point: a dot
			if (!thin) { put(i); continue; }
			const c = Math.round(X(t[i]));
			if (c !== col) flush(), (col = c);
			if (a == null || vals[i] < vals[a]) a = i;
			if (b == null || vals[i] > vals[b]) b = i;
		}
		return d;
	};
	// a band (mean +/- sd over runs) under a series that has one, in its stretches with both edges
	const band = (s) => {
		let d = "", seg = [];
		const P = (i, v) => f(X(t[i])) + "," + f(Y(v)), flush = () => { if (seg.length > 1) d += "M" + seg.map((i) => P(i, s.hi[i])).join("L") + "L" + [...seg].reverse().map((i) => P(i, s.lo[i])).join("L") + "Z"; seg = []; };
		for (let i = 0; i < t.length; i++) s.lo[i] != null && s.hi[i] != null ? seg.push(i) : flush();
		flush();
		return d;
	};
	// the pointer over the plot: the readout, and the series whose line is nearest it there
	const move = (e) => {
		const i = hover(e, G, GW.g, what);
		if (i < 0) return focus(null);
		const py = e.clientY - e.currentTarget.getBoundingClientRect().top;
		let best = null, dmin = NEAR;
		for (const s of vis) if (s.vals[i] != null && Math.abs(Y(s.vals[i]) - py) <= dmin) (dmin = Math.abs(Y(s.vals[i]) - py)), (best = s.id);
		if (best === focR.current) return;
		focus(best);
		hover(e, G, GW.g, what); // (the readout again, that series' row standing out)
	};
	const on = vis.some((s) => s.id === foc) ? foc : null, cls = (base, s) => base + (on ? (s.id === on ? " on" : " fade") : "");
	const what = (x, i) => [html`<b>${hms(x * 1000)}</b>`, ...(i >= 0 ? vis.map((s) => [html`<br />`, html`<span class=${focR.current && vis.some((v) => v.id === focR.current) ? (s.id === focR.current ? "ton" : "tfade") : null}><${Lkey} i=${s.di} css=${s.css} wd=${s.w} />${" "}<b>${s.vals[i] == null ? "-" : fmt(s.vals[i])}</b>${" " + s.label + (s.tip ? s.tip(i) : "")}</span>`]) : [])];
	return [
		// every series' key; one with no values or all 0 dimmed (its line, if any, lies on 0)
		html`<div class="lgs">${all.map((s) => html`<button type="button" class=${cls("lg" + (s.zero ? " z" : ""), s)} style=${s.css} aria-pressed=${!ghide.has(s.id)} data-tip=${s.zero ? (s.vals && s.vals.some((v) => v != null) ? "0" : "none") + " in this run" : null} onClick=${() => toggleSeries(s.id)}
			onPointerEnter=${() => focus(s.id)} onPointerLeave=${() => focus(null)} onFocus=${() => focus(s.id)} onBlur=${() => focus(null)}><${Lkey} i=${s.di} css=${s.css} wd=${s.w} />${s.lh || s.label}</button>`)}</div>`,
		html`<svg class="gsvg" width=${W} height=${Ht} viewBox=${"0 0 " + W + " " + Ht} role="img" aria-label=${o.aria || ""} onPointerMove=${move} onPointerLeave=${() => (hoverOff(G), focus(null))} onClick=${(e) => seek(e, G, GW.g)}>
			<text class="un" x="0" y="11">${unit}</text>
			${yt.map((v) => [html`<line class="gl" x1=${GW.g} x2=${GW.g + pw} y1=${f(Y(v))} y2=${f(Y(v))} />`, html`<text x=${GW.g - 6} y=${f(Y(v) + 4)} text-anchor="end">${(o.axis || tick)(v)}</text>`])}
			${G.xt.map((x) => html`<line class="gl" x1=${f(X(x))} x2=${f(X(x))} y1=${GW.top} y2=${GW.top + GW.h} />`)}${xLabels(G, X, pw, GW.g, GW.top + GW.h + 17)}
			${vis.filter((s) => s.lo && s.hi).map((s) => html`<path class=${cls("gband", s)} style=${s.css} d=${band(s)} />`)}
			${[...vis.filter((s) => s.id !== on), ...vis.filter((s) => s.id === on)].map((s) => html`<path key=${s.id} class=${cls("gs", s)} style=${s.css} stroke-width=${(s.w || 2) + (s.id === on ? 1.5 : 0)} stroke-dasharray=${DASH[s.di % DASH.length] || null} d=${path(s.vals)} />`)}
			${(o.deaths || []).map((d) => html`<circle class="gd" cx=${f(X(d.t))} cy=${GW.top + GW.h} r="4.5" data-tip=${d.p.name + " died at " + hms(d.t * 1000) + (d.by ? ", killed by " + d.by : "")} />`)}
			${(o.steers || []).map((s) => html`<g class="gst" data-tip=${"steered at " + hms(s.t * 1000) + (s.name ? " (" + s.name + ")" : "") + (s.character ? ", " + s.character : "") + ": " + (s.what || "") + (s.note ? " (" + s.note + ")" : "") + (s.why ? "\n" + s.why : "") + (s.errors && s.errors.length ? "\nnot run: " + s.errors.join(", ") : "")}><line x1=${f(X(s.t))} x2=${f(X(s.t))} y1=${GW.top} y2=${GW.top + GW.h} /><path d=${"M" + f(X(s.t) - 5) + "," + (GW.top - 8) + "h10l-5,7z"} /></g>`)}
			${off ? html`<path class="goff" d=${"M" + f(X(t[off.i]) - 6) + "," + (GW.top - 2) + "l6,-9l6,9z"} data-tip=${"off the scale at the start: " + fmt(off.v) + " " + unit + " (" + off.s.label + " at " + hms(t[off.i] * 1000) + "), a rate over its first rows; the scale fits the rest"} />` : null}
			<${Cross} G=${G} x0=${GW.g} y1=${GW.top - 4} y2=${GW.top + GW.h} /><${Playhead} G=${G} x0=${GW.g} y1=${GW.top - 4} y2=${GW.top + GW.h} />
		</svg>`,
	];
}

// ---- a run's charts: a metric over time (its rate or its total), the buffs' lanes and the auras on vs off, the supply
// trips. W: the box's width. Per metric (DATA's g): its cumulative column per character, its unit
const C = {
	xp: [(D, p) => D.col(p.name, "xp"), "xp"], dmg: [(D, p) => D.col(p.name, "dmg_raw"), "dmg"], overkill: [(D, p) => diff(D.col(p.name, "dmg_raw"), D.col(p.name, "dmg")), "dmg"], taken: [(D, p) => D.col(p.name, "taken_raw"), "taken"],
	heal: [(D, p) => D.col(p.name, "heal_raw"), "heal"], overheal: [(D, p) => diff(D.col(p.name, "heal_raw"), D.col(p.name, "heal")), "heal"], mana: [(D, p) => D.col(p.name, "mana"), "mp"], kills: [(D, p) => D.col(p.name, "kills"), "kills"],
	pots: [(D, p) => sumCols([D.col(p.name, "hpots"), D.col(p.name, "mpots")]), "pots"], gold: [(D, p) => D.col(p.name, "income"), "gold"], level: [(D, p) => D.col(p.name, "level"), "level"], loot: [(D, p) => D.col(p.name, "loot_items"), "items"],
};
// a metric's unit over time: its total's, or per s or h
const unitOf = (d) => C[d.g][1] + (d.rate === 1 ? "/s" : d.rate ? "/h" : "");
const diff = (a, b) => (a && b ? a.map((x, i) => (x != null && b[i] != null ? x - b[i] : null)) : null);
const nz = (v) => !!v && v.some((x) => x);
const WHY = { overkill: "overkill over time needs a net damage column", overheal: "overheal over time needs a net healing column", supply: "no supply trips in this run", buffs: "no conditions recorded in this run" };
// what a run has over time (the timeline's categories, the buffs, the supply)
function hasOf(w, D, P) {
	const trips = w.merchant && Array.isArray(w.merchant.trips) && w.merchant.trips.length && statsOf(w).M;
	return (k) => (k === "buffs" ? P.some((p) => (p.timeline && p.timeline.rows && p.timeline.rows.length) || Object.keys(p.conditions || {}).length) : k === "supply" ? !!trips : !!D && P.some((p) => nz(C[k][0](D, p))));
}
// a run's grid loaded as it grows (its rows: the charts')
export const useGrid = (w) => useEffect(() => void (w && gridLoad(w)), [w]);
export function RunCharts({ w, part, W, none, d }) {
	useGrid(w);
	const gv = gridVer(w), hov = useHov(), drawn = useMemo(() => runCharts(w, part, W, hov, d), [w, part, W, d && d.id, gv, chartsVer()]);
	useReadout(drawn);
	return drawn || none || null;
}
function runCharts(w, part, Wd, hov, d) {
	const S = statsOf(w), D = timeData(w), W = Math.max(280, Math.floor(Wd || 540)), P = S.P.map((c) => c.p);
	const T = Math.max(D && D.t.length ? D.t[D.t.length - 1] : 0, (w.measured_ms || 0) / 1000) || 1, pw = W - GW.g - GW.r, win = autoWin(T, D ? D.step : 0);
	const G = box(T, W, pw, D ? D.t : [], Math.max(10 * (D ? D.step : 0), 1800), w, hov), has = hasOf(w, D, P);
	if (part === "buffs") return has("buffs") ? html`<div class="gv">${lanes(w, S, D, G)}${onoff(w, S)}</div>` : null;
	if (part === "supply") return has("supply") ? html`<div class="gv">${supplyLane(w, S, G)}</div>` : null;
	const k = d.g, unit = d.rate, ul = unitOf(d);
	const src = !D ? html`<span class="gsrc">no time series in this run</span>` : D.src === "grid" ? html`<span class="gsrc">a row per ${Math.round(D.step)} game s</span>` : html`<span class="gsrc">history: a row per ~${dur(D.step)}</span>`;
	if (!has(k)) return html`<div class="gv"><section class="gc"><p class="mnote">- ${WHY[k] || "not measured in this run"}</p></section>${src}</div>`;
	const [get] = C[k], level = k === "level", rate = (v, u) => v && rateAt(G.t, v, win, u);
	// a line per character (the merchant too; none or all 0: its key dimmed), the party's sum when 2+ have any
	const vs = P.map((p) => get(D, p)), idx = P.map((p, i) => i).filter((i) => nz(vs[i]));
	const per = (v) => (v && unit ? rate(v, unit) : v), pu = unit === 3600 ? "/h" : unit ? "/s" : "";
	const tips = { kills: (p) => { const c = per(D.col(p.name, "credits")); return c ? (i) => ", " + fmtN(c[i]) + " credits" + pu : null; }, pots: (p) => { const a = per(D.col(p.name, "hpots")), b = per(D.col(p.name, "mpots")); return (i) => " (HP " + fmtN(a ? a[i] : null, 0) + ", MP " + fmtN(b ? b[i] : null, 0) + ")"; } };
	const series = P.map((p, i) => ({ id: p.name, label: p.name, css: cvar(p.type), di: i, vals: level ? levelOf(D, p) : unit ? rate(vs[i], unit) : vs[i], tip: vs[i] && tips[k] && tips[k](p) }));
	for (const s of series) s.zero = !(s.vals && s.vals.some((v) => v));
	if (idx.length > 1 && !level) { const s = sumCols(idx.map((i) => vs[i])); series.unshift({ id: "Party", label: "Party", css: "--c:var(--line)", di: 0, w: 3, vals: unit ? rate(s, unit) : s }); }
	const note = level ? null : unit ? html`<span class="gu" data-tip="the rolling window: about a thirtieth of the run (the average since 0h00 until it is full)">${"per " + (unit === 3600 ? "game hour" : "game second") + ", over the last " + dur(win)}</span>` : html`<span class="gu">the total so far</span>`;
	const o = level ? { level: true, axis: (v) => "L" + v, fmt: (v) => "L" + Math.floor(v) + " " + Math.floor((v % 1) * 100) + "%", deaths: deathsOf(w, D), steers: steersOf(w), aria: "level and progress through it" }
		: { fmt: (v) => fmtN(v, unit === 1 ? 0 : 1), deaths: deathsOf(w, D), steers: steersOf(w), aria: d.label + " over game time", from: unit ? D.t[0] + win : null };
	const any = series.some((s) => s.vals && s.vals.some((v) => v != null));
	return html`<div class="gv"><section class="gc">${note ? html`<div class="gh">${note}</div>` : null}${any ? html`<${GChart} G=${G} unit=${ul} series=${series} o=${o} />` : html`<p class="mnote">- not measured in this run</p>`}</section>${src}</div>`;
}

// ---- Buffs: a block per condition key any character had (buffs, debuffs, the rest; the most on first): its icon and
// name (hovered: the game's tooltip), then a lane per character of the run, the bars as the meters': the timeline's
// exact intervals (from timeline.since[key] on, where the producer dropped older ones), and before them its uptime per
// stretch from the grid's cumulative ms per key (fainter, as tall as the share); its uptime over the run at the lane's
// end. The crosshair says who had it at that time.
const LANE_H = 16;
function lanes(w, S, D, G) {
	const { T, pw } = G, ps = S.P.map((c) => c.p), msr = w.measured_ms || 0, f = (v) => v.toFixed(1), X = (t) => (pw * Math.min(T, Math.max(0, t))) / T, spp = T / pw, ht = LANE_H;
	const rows = new Map(); // key -> Map(name -> [[t on, t off, value, still on]])
	for (const p of ps) for (const r of p.timeline && Array.isArray(p.timeline.rows) ? p.timeline.rows : []) {
		if (!Array.isArray(r) || typeof r[0] !== "string" || !Number.isFinite(r[1])) continue;
		const m = rows.get(r[0]) || rows.set(r[0], new Map()).get(r[0]);
		(m.get(p.name) || m.set(p.name, []).get(p.name)).push([r[1], Number.isFinite(r[2]) ? r[2] : T, r[3], !Number.isFinite(r[2])]);
	}
	// per character and key: the game s on and covered per pixel column
	const bins = new Map(); // key -> Map(name -> { on: Float64Array, cov: Float64Array })
	if (D && D.cAt) for (const p of ps) {
		const c = D.cAt(p.name);
		if (!c) continue;
		for (let i = 0; i < c.length; i++) {
			const a = i ? D.t[i - 1] : 0, b = D.t[i], c0 = i ? c[i - 1] : {}, c1 = c[i];
			if (!(b > a) || !c0 || !c1) continue;
			for (const k of Object.keys(c1)) {
				const sh = Math.min(1, Math.max(0, (num(c1[k]) - num(c0[k])) / 1000 / (b - a)));
				const m = bins.get(k) || bins.set(k, new Map()).get(k), o = m.get(p.name) || m.set(p.name, { on: new Float64Array(pw), cov: new Float64Array(pw) }).get(p.name);
				for (let x = Math.max(0, Math.floor(X(a))); x <= Math.min(pw - 1, Math.floor(X(b) - 1e-9)); x++) { const ov = Math.min(b, (x + 1) * spp) - Math.max(a, x * spp); if (ov > 0) (o.on[x] += sh * ov), (o.cov[x] += ov); }
			}
		}
	}
	const keys = new Set([...rows.keys(), ...bins.keys()]);
	for (const p of ps) for (const [k, c] of Object.entries(p.conditions || {})) if (c && c.ms > 0) keys.add(k);
	const since = (p, k) => (p.timeline && p.timeline.since && Number.isFinite(p.timeline.since[k]) ? p.timeline.since[k] : null);
	const share = (p, k) => { const c = p.conditions && p.conditions[k]; if (c && Number.isFinite(c.ms)) return clamp01(msr > 0 ? c.ms / msr : 0); const r = rows.get(k) && rows.get(k).get(p.name); return clamp01(msr > 0 && r ? r.reduce((a, [x, y]) => a + (y - x) * 1000, 0) / msr : 0); };
	// the conditions on at t per character (the lanes' hover): the exact intervals, else the stretch's share
	const at = (t, k) => {
		const col = Math.min(pw - 1, Math.max(0, Math.floor((pw * t) / T)));
		if (k) return w.players.map((p) => {
			const tl = p.timeline || {}, on = (Array.isArray(tl.rows) ? tl.rows : []).some((r) => Array.isArray(r) && r[0] === k && r[1] <= t && (r[2] == null || r[2] > t));
			const o = !on && bins.get(k) && bins.get(k).get(p.name), sh = o && o.cov[col] > 0 ? o.on[col] / o.cov[col] : 0;
			return [html`<br />`, p.name + ": " + (on ? "on" : sh > 0 ? "on " + pctU(sh) + " of that stretch" : "off")];
		});
		const out = w.players.map((p) => {
			const tl = p.timeline || {}, on = new Map();
			for (const r of Array.isArray(tl.rows) ? tl.rows : []) if (Array.isArray(r) && r[1] <= t && (r[2] == null || r[2] > t)) on.set(r[0], condName(r[0]));
			for (const [x, m] of bins) { const o = m.get(p.name); if (o && !on.has(x) && o.cov[col] > 0 && o.on[col] > 0) on.set(x, condName(x) + " " + pctU(o.on[col] / o.cov[col])); }
			return on.size ? [html`<br />`, p.name + ": " + [...on.values()].join(", ")] : null;
		}).filter(Boolean);
		return out.length ? out : [html`<br />`, "nothing on"];
	};
	const track = (k, p, marks) => html`<svg class="lt" width=${pw} height=${ht} viewBox=${"0 0 " + pw + " " + ht} onPointerMove=${(e) => hover(e, G, 0, (t) => [html`<b>${k ? condName(k) + " at " : ""}${hms(t * 1000)}</b>`, ...at(t, k)], p.name)} onPointerLeave=${() => hoverOff(G)} onClick=${(e) => seek(e, G, 0, p.name)}>
		<rect class="tbg" x="0" y="0" width=${pw} height=${ht} rx="3" />${marks}<${Cross} G=${G} x0=${0} y1=${0} y2=${ht} /><${Playhead} G=${G} x0=${0} y1=${0} y2=${ht} /></svg>`;
	// a lane: its character's name (a click: the replay as that character), the track, the uptime
	const lane = (k, p, marks, up) => html`<div class="blane" data-who=${p.name} style=${cvar(p.type)}><span class="bn" onClick=${() => rpWatch(p.name, G.w)}>${p.name}</span>${track(k, p, marks)}<span class="bu">${up}</span></div>`;
	const groups = { buff: [], debuff: [], other: [] }, always = [];
	const sum = (k) => ps.reduce((a, p) => a + share(p, k), 0);
	for (const k of [...keys].sort((a, b) => sum(b) - sum(a) || (a < b ? -1 : 1))) {
		if (!ps.some((p) => share(p, k) > 0 || (rows.get(k) && rows.get(k).has(p.name)) || (bins.get(k) && bins.get(k).has(p.name)))) continue;
		const r = rows.get(k), last = r ? [...r.values()].flat().sort((a, b) => a[0] - b[0]).pop() : null, v = last && last[2], pz = PSEUDO[k], nm = condName(k), sub = (k === "elixir" || k === "booster") && v ? String(v) : pz ? pz[1] : "";
		// on all the run for everyone who had it (New Player, the party): an icon in the "Always on" row, not lanes
		const who = ps.filter((p) => share(p, k) > 0);
		if (who.length && who.every((p) => share(p, k) >= 0.995)) { always.push({ k, v, who, kind: kindOf(w, k) }); continue; }
		const ls = ps.map((p) => {
			const b = bins.get(k) && bins.get(k).get(p.name), rs = (r && r.get(p.name)) || [], s0 = since(p, k), sh = share(p, k), marks = [];
			// uptime per stretch where the timeline kept no intervals: a column's share of the time on, as a bar's height
			if (b) for (let x = 0; x < pw; ) {
				const q = b.cov[x] > 0 ? Math.ceil((8 * b.on[x]) / b.cov[x] - 1e-9) / 8 : 0;
				let y = x + 1;
				while (y < pw && (b.cov[y] > 0 ? Math.ceil((8 * b.on[y]) / b.cov[y] - 1e-9) / 8 : 0) === q) y++;
				if (q > 0 && (s0 == null || x * spp < s0 || !rs.length)) marks.push(html`<rect class="bin" x=${x} y=${f(ht - ht * q)} width=${y - x} height=${f(ht * q)} />`);
				x = y;
			}
			// the exact intervals, merged when closer than a pixel
			const iv = rs.filter(([a]) => s0 == null || a >= s0 - 1e-6).sort((a, b2) => a[0] - b2[0]), merged = [];
			for (const x of iv) { const l = merged[merged.length - 1]; if (l && x[0] - l[1] < spp) l[1] = Math.max(l[1], x[1]); else merged.push([x[0], x[1]]); }
			for (const [a, b2] of merged) marks.push(html`<rect class="on" x=${f(X(a))} y="0" width=${f(Math.max(2, X(b2) - X(a)))} height=${ht} rx="3" />`);
			return lane(k, p, marks, sh > 0 ? pctU(sh) : "");
		});
		(groups[kindOf(w, k)] || groups.other).push(html`<div class="blk"><${Cond} k=${k} v=${v} cls="cbig"><span class="ci">${condIcon(k, v, w, 32)}</span><span class="cn"><b>${nm}</b>${sub ? html`<span class="gu">${sub}</span>` : null}</span></${Cond}><div class="bls">${ls}</div></div>`);
	}
	const out = [], ord = { buff: 0, other: 1, debuff: 2 };
	// (who had it under its icon, when not everyone)
	if (always.length) out.push(html`<div class="blk aon"><span class="cn"><b>Always on</b></span><div class="cic">${always.sort((a, b) => ord[a.kind] - ord[b.kind]).map((a) => html`<span class="aoi"><${Cond} k=${a.k} v=${a.v} cls=${"cs" + (a.kind === "debuff" ? " bad" : "")} label=${condName(a.k)}>${condIcon(a.k, a.v, w, 26)}</${Cond}>
		${a.who.length < ps.length ? html`<span class="aow" data-tip=${condName(a.k) + ": " + a.who.map((p) => p.name).join(", ")}>${a.who.map((p) => html`<i style=${cvar(p.type)}></i>`)}</span>` : null}</span>`)}</div></div>`);
	for (const [g, hd] of [["buff", "Buffs"], ["debuff", "Debuffs"], ["other", "Other conditions"]]) if (groups[g].length) out.push(html`<h4>${hd}</h4>`, ...groups[g]);
	const ds = deathsOf(w, D);
	if (ds.length) out.push(html`<h4>Deaths</h4>`, html`<div class="blk"><span class="cond cbig"><span class="ci">${mon("gravestone", 32)}</span><span class="cn"><b>Deaths</b></span></span><div class="bls">
		${ps.map((p) => lane("", p, ds.filter((d) => d.p === p).map((d) => html`<circle class="gd" cx=${f(X(d.t))} cy=${ht / 2} r="5" data-tip=${p.name + " died at " + hms(d.t * 1000) + (d.by ? ", killed by " + d.by : "")} />`), ds.filter((d) => d.p === p).length || ""))}</div></div>`);
	const axis = html`<div class="blk ax"><span></span><div class="blane"><span></span><svg width=${pw} height="16" viewBox=${"0 0 " + pw + " 16"} aria-hidden="true">${xLabels(G, (t) => (pw * Math.min(T, Math.max(0, t))) / T, pw, 0, 12)}</svg><span></span></div></div>`;
	return out.length ? html`<section class="lanes">${out}${axis}<p class="gu">Faint bars: the share of that stretch it was on, where the run kept no exact times.</p></section>` : null;
}
// the merchant's supply trips, out of town until back
function supplyLane(w, S, G) {
	const trips = w.merchant && Array.isArray(w.merchant.trips) ? w.merchant.trips.filter((x) => x && Number.isFinite(x.t_out)) : [], T = G.T, W = G.W - GW.g, X = (t) => (G.pw * Math.min(T, Math.max(0, t))) / T, f = (v) => v.toFixed(1);
	if (!S.M || !trips.length) return null;
	const all = S.M.p.trips, what = (x) => Object.entries((x && x.served) || {}).map(([n, s]) => n + ": " + [Object.entries(s.sent || {}).map(([i, q]) => q + " " + i).join(", "), s.gold_received ? fmtN(s.gold_received) + " gold" : ""].filter(Boolean).join(", ")).filter((x) => !/: $/.test(x)).join("; ");
	const on = (t) => w.players.map((p) => {
		const on = new Map();
		for (const r of (p.timeline && Array.isArray(p.timeline.rows) ? p.timeline.rows : [])) if (Array.isArray(r) && r[1] <= t && (r[2] == null || r[2] > t)) on.set(r[0], condName(r[0]));
		return on.size ? [html`<br />`, p.name + ": " + [...on.values()].join(", ")] : null;
	}).filter(Boolean);
	return html`<section class="lanes"><div class="lane"><div class="lh"><span><span class="ic">${icon("travel")}</span><b>Trips</b>${all > trips.length ? html`<span class="gu">the last ${trips.length} of ${all}</span>` : null}</span></div>
		<div class="trk" style=${cvar(S.M.p.type)}><svg width=${W} height="8" viewBox=${"0 0 " + W + " 8"} onPointerMove=${(e) => hover(e, G, 0, (t) => { const x = on(t); return [html`<b>${hms(t * 1000)}</b>`, ...(x.length ? x : [html`<br />`, "nothing on"])]; })} onPointerLeave=${() => hoverOff(G)} onClick=${(e) => seek(e, G, 0)}>
			<rect class="tbg" x="0" y="0" width=${G.pw} height="8" />
			${trips.map((x) => html`<rect x=${f(X(x.t_out))} y="0" width=${f(Math.max(2, X(Number.isFinite(x.t_back) ? x.t_back : T) - X(x.t_out)))} height="8" rx="2" data-tip=${hms(x.t_out * 1000) + " to " + (Number.isFinite(x.t_back) ? hms(x.t_back * 1000) : "now") + (what(x) ? "\n" + what(x) : "")} />`)}
			<${Cross} G=${G} x0=${0} y1=${0} y2=${8} /><${Playhead} G=${G} x0=${0} y1=${0} y2=${8} /></svg></div></div>
		<div class="trk ax"><svg width=${W} height="16" viewBox=${"0 0 " + W + " 16"} aria-hidden="true">${xLabels(G, X, G.pw, 0, 12)}</svg></div></section>`;
}
// Kane's and Angel's auras on vs off, over the characters that gained xp or fought (the sums over them; per hour of
// their time): Angel's gold goes by the chest opener's aura, Kane's luck by the kill's drop target's. xp is the
// control: no aura changes it, so a gap there means something else differed while it was on. With what else could
// explain a gap.
function onoff(w, S) {
	const F = activeOf(S).map((c) => c.p), msr = w.measured_ms || 0, all = F.length * msr, sum = (xs, fn) => xs.reduce((a, x) => a + num(fn(x)), 0), on = (k) => F.map((p) => (p.on && p.on[k]) || null);
	const r = (a, b) => (a > 0 && b > 0 ? "x" + (a / b).toFixed(a / b >= 10 ? 0 : 1) : ""), perH = (v, ms) => (ms > 0 ? (v * 3600e3) / ms : null), per100 = (v, n) => (n > 0 ? (100 * v) / n : null);
	// a row: on, off, and their ratio for a rate (cls "n": counts, no ratio); n: the fewer of the chests or kills behind
	// the two rates (under 30: "~", too few to tell)
	const row = (label, a, b, fa, title, cls, n) => { const few = n != null && n < 30;
		return html`<tr class=${cls || null} data-tip=${title ? title + (few ? "; only " + n + " behind one of them: too few to tell" : "") : null}><td>${label}</td><td>${a == null ? "-" : fa(a)}</td><td>${b == null ? "-" : fa(b)}</td><td>${a != null && b != null && cls !== "n" && r(a, b) ? (few ? "~" : "") + r(a, b) : ""}</td></tr>`; };
	const xpOn = (os) => sum(os, (o) => o && o.xp), msOn = (os) => sum(os, (o) => o && o.ms), xpAll = sum(F, (p) => p.xp_gained);
	const control = (os) => { const ms = msOn(os), a = perH(xpOn(os), ms), b = perH(xpAll - xpOn(os), all - ms), odd = a > 0 && b > 0 && Math.abs(a / b - 1) > 0.15;
		return row("xp/h (control)", a, b, (v) => fmtN(v), odd ? "xp doesn't depend on the aura: something else differed while it was on (the spot, deaths, the party...)" : "xp doesn't depend on the aura: about equal, as it should be", odd ? "odd" : "ctl"); };
	const chips = [], dry = sum(F, (p) => p.chests && num(p.chests.dry) + num(p.chests.stale)), opened = sum(F, (p) => p.chests && p.chests.opened);
	if (opened) chips.push(html`<span class="cfc" data-tip="chests opened too far (over 400 px) or too old (over 8 min) pay with goldm 1, aura or not">${icon("gold")}x1 chests ${fmtN(dry, 0)} of ${fmtN(opened, 0)}</span>`);
	const share = F.length > 1 && F[0].party && F[0].party.share;
	if (share) chips.push(html`<span class="cfc" data-tip="each member's share of a kill's xp and of a chest's gold">${icon("citizens")}share ${pct(share)}</span>`);
	const enc = [...new Set(F.flatMap((p) => Object.entries(p.conditions || {}).filter(([k]) => /^encouragement_/.test(k)).map(([k, c]) => condName(k) + " " + (c.v ?? ""))))];
	for (const e of enc) chips.push(html`<span class="cfc" data-tip="encouragement: extra xp, gold and drop rolls by each one's contribution, not through the multipliers">${icon("encouragement_lonewolf")}${e}</span>`);
	if (w.world && Number.isFinite(w.world.night_ms) && msr) chips.push(html`<span class="cfc" data-tip="server night: monsters slower">night ${pct(clamp01(w.world.night_ms / msr))}</span>`);
	const cards = [], th = html`<tr><th></th><th>on</th><th>off</th><th></th></tr>`;
	// the whole run's drop-target kills and their items (off = all - on) come from a key that was on all the measured
	// time (e.g. the party, Lone Wolf, New Player); looted items are no stand-in (encouragement rolls add to them)
	const all1 = (p) => Object.values(p.on || {}).find((o) => o && o.ms >= msr * 0.999), base = F.length && F.every(all1) ? F.map(all1) : null;
	const offNote = base ? "" : " (off: needs a condition on all the run to count the rest)";
	const A = on("citizen4aura");
	if (msOn(A) > 0) {
		const ms = msOn(A), ch = sum(A, (o) => o && o.chests), g = sum(A, (o) => o && o.loot_gold), gAll = sum(F, (p) => { const f = p.gold_flow; return f && typeof f === "object" ? num(f.chest) + num(f.egold) + num(f.enc) : null; }), x10 = sum(A, (o) => o && o.x10), x50 = sum(A, (o) => o && o.x50), ex = F.filter((p) => p.exact && Number.isFinite(p.exact.angel_gold));
		cards.push(html`<section class="ocard"><div class="lh"><span class="ic">${mon("Angel", 22) || icon("citizens")}</span><b>Angel</b><span class="gu">gold +200 for the chest opener</span></div><table class="itab otab"><tbody>${th}
			${row("time", ms / all, 1 - ms / all, (v) => pctU(clamp01(v)), "share of the characters' time with Angel's aura", "n")}${row("chests", ch, opened - ch, (v) => fmtN(v, 0), "chests the characters opened with and without the aura (n)", "n")}
			${row("gold/chest", ch > 0 ? g / ch : null, opened - ch > 0 ? (gAll - g) / (opened - ch) : null, (v) => fmtN(v), "chest gold paid to the party per chest opened", "", Math.min(ch, opened - ch))}
			${row("gold/h", perH(g, ms), perH(gAll - g, all - ms), (v) => fmtN(v), "chest gold per hour of the opener's time with and without the aura", "", Math.min(ch, opened - ch))}
			<tr data-tip="x10 and x50 chests carry about a third of the expected gold: a few of them swing the rates"><td>x10 / x50</td><td>${x10} / ${x50}</td><td>${base ? sum(base, (o) => o.x10) - x10 + " / " + (sum(base, (o) => o.x50) - x50) : "-"}</td><td></td></tr>
			${ex.length ? html`<tr data-tip="exact: the gold paid only because the opener had the aura"><td>Angel paid</td><td colspan="3">${fmtN(sum(ex, (p) => p.exact.angel_gold))} gold in ${fmtN(sum(ex, (p) => p.exact.angel_chests), 0)} chests</td></tr>` : null}${control(A)}</tbody></table></section>`);
	}
	const K = on("citizen0aura");
	if (msOn(K) > 0) {
		const ms = msOn(K), known = K.every((o) => !o || o.rkills != null), rk = sum(K, (o) => o && o.rkills), it = sum(K, (o) => o && o.items), kb = base && base.every((o) => o.rkills != null) ? base : null, kAll = kb && sum(kb, (o) => o.rkills), iAll = kb && sum(kb, (o) => o.items);
		const cr = sum(K, (o) => o && o.credits), cAll = sum(F, (p) => p.credits);
		cards.push(html`<section class="ocard"><div class="lh"><span class="ic">${mon("Kane", 22) || icon("citizens")}</span><b>Kane</b><span class="gu">luck +200 for the drop target</span></div><table class="itab otab"><tbody>${th}
			${row("time", ms / all, 1 - ms / all, (v) => pctU(clamp01(v)), "share of the characters' time with Kane's aura", "n")}
			${known ? [row("kills", rk, kb ? kAll - rk : null, (v) => fmtN(v, 0), "kills whose drop target (the monster's target) had the aura, and the rest (n)" + (kb ? "" : offNote), "n"), row("items/100 kills", per100(it, rk), kb ? per100(iAll - it, kAll - rk) : null, (v) => fmtN(v), "items rolled in those kills' chests per 100 kills" + (kb ? "" : offNote), "", kb ? Math.min(rk, kAll - rk) : rk)]
				: html`<tr><td colspan="4" class="z">items per kill: the drop target is known only in 1-fighter runs</td></tr>`}
			${row("credits/h", perH(cr, ms), perH(cAll - cr, all - ms), (v) => fmtN(v), "kill credits per hour of a character's time with and without the aura")}${control(K)}</tbody></table></section>`);
	}
	return cards.length ? html`<${Fold} k="+buffs:onoff" title="Auras: on vs off"><section class="oo"><div class="ocards">${cards}</div>${chips.length ? html`<div class="cf">${chips}</div>` : null}</section></${Fold}>` : null;
}

// ---- Compare's timeline: a metric's party's cumulative column per run (grid, else history rows), as a rate over one
// window for all or its total so far, on one time axis; per series the mean and, with 2+ runs there, mean +/- sd. head:
// what goes before its note (the Summary's metric picker)
function partyCum(w, D, k) {
	if (!D || !C[k] || k === "level") return null;
	const vs = w.players.map((p) => C[k][0](D, p)).filter((v) => v && v.some((x) => x));
	return vs.length ? sumCols(vs) : null;
}
// values at t by straight lines between rows (null outside them)
function resample(ts, vs, at) {
	const out = new Array(at.length).fill(null);
	let j = 0;
	for (let i = 0; i < at.length; i++) {
		const x = at[i];
		while (j + 1 < ts.length && ts[j + 1] < x) j++;
		const a = j, b = Math.min(j + 1, ts.length - 1);
		if (x < ts[0] || x > ts[ts.length - 1] || vs[a] == null || vs[b] == null) continue;
		out[i] = ts[b] > ts[a] ? vs[a] + ((vs[b] - vs[a]) * (x - ts[a])) / (ts[b] - ts[a]) : vs[a];
	}
	return out;
}
export function CmpTimeline({ ss, W, bands, d, head }) {
	const runs = ss.flatMap((s) => s.runs);
	useEffect(() => { for (const w of runs) gridLoad(w); }, [runs.map((w) => w.updated + w.id).join()]);
	const gv = runs.map(gridVer).join(), hov = useHov();
	const drawn = useMemo(() => cmpTimeline(ss, W, bands, hov, d, head), [ss.map((s) => s.id + s.label + s.color + s.runs.map((w) => w.id + w.updated).join(",")).join("|"), W, bands, d.id, head, gv, chartsVer()]);
	useReadout(drawn);
	return drawn;
}
function cmpTimeline(ss, W, bands, hov, d, head) {
	const k = d.g, unit = d.rate, ul = unitOf(d);
	if (k === "level") return html`<div class="gv">${head ? html`<div class="gh">${head}</div>` : null}<section class="gc"><p class="mnote">- level over time: on a run's page (one run at a time)</p></section></div>`;
	const per = ss.map((s) => s.runs.map((w) => { const D = timeData(w); return { w, D, v: partyCum(w, D, k) }; }));
	const all = per.flat().filter((r) => r.D && r.v), T = Math.max(1, ...all.map((r) => r.D.t[r.D.t.length - 1])), step = Math.max(30, ...all.map((r) => r.D.step || 0), T / 1500), win = autoWin(T, step);
	const at = [];
	for (let x = 0; x <= T + 1e-6; x += step) at.push(+x.toFixed(3));
	const G = box(T, W, W - GW.g - GW.r, at, 1e9, null, hov);
	const series = ss.map((s, si) => {
		const rs = per[si].filter((r) => r.D && r.v).map((r) => resample(r.D.t, unit ? rateAt(r.D.t, r.v, win, unit) : r.v, at));
		const lh = s.lh ? [ss.length > 1 && !si ? html`<b class="bln">Baseline</b>` : null, s.lh] : null;
		if (!rs.length) return { id: s.id, label: s.label, lh, css: "--c:" + s.color, di: si, vals: null, zero: true };
		const m = at.map((_, i) => { const xs = rs.map((r) => r[i]).filter((v) => v != null); return xs.length ? agg(xs) : null; });
		const sd = (i) => (m[i] && m[i].sd != null ? m[i].sd : null);
		return { id: s.id, label: s.label, lh, css: "--c:" + s.color, di: si, w: 2, vals: m.map((a) => (a ? a.mean : null)), lo: bands && rs.length > 1 ? m.map((a, i) => (sd(i) != null ? a.mean - sd(i) : null)) : null, hi: bands && rs.length > 1 ? m.map((a, i) => (sd(i) != null ? a.mean + sd(i) : null)) : null,
			tip: rs.length > 1 ? (i) => (m[i] ? (m[i].sd != null ? " ± " + fmtN(m[i].sd) : "") + " (" + m[i].n + " runs)" : "") : null };
	});
	const note = html`<span class="gu" data-tip=${(unit ? "each run's rate over one window, about a thirtieth of the longest run (the average since 0h00 until it is full)" : "each run's total so far") + "; the series' mean at each time" + (bands ? ", the band mean +/- sd over the runs there" : "")}>${unit ? "per " + (unit === 3600 ? "game hour" : "game second") + ", over the last " + dur(win) : "the total so far"}${bands ? ", mean ± sd" : ""}</span>`;
	const loading = ss.some((s) => s.runs.some((w) => w.grid && (!grids.get(w.id) || (!grids.get(w.id).rows.length && !grids.get(w.id).missing))));
	const any = series.some((s) => s.vals && s.vals.some((v) => v != null));
	return html`<div class="gv"><div class="gh">${head}${note}</div><section class="gc">${any ? html`<${GChart} G=${G} unit=${ul} series=${series} o=${{ fmt: (v) => fmtN(v, unit === 1 ? 0 : 1), aria: d.label + " over game time, per series", from: unit && all.length ? Math.max(...all.map((r) => r.D.t[0])) + win : null }} />` : html`<p class="mnote">${loading ? "loading..." : "- no " + d.label + " over time in these runs"}</p>`}</section></div>`;
}

// ---- a strip per series: every run a dot at its value (a click opens it), the mean as a tick, +/- sd as a bar; the
// series' tags in a column beside it. A run in its series: its seed (else when it started)
export function DotPlot({ ss, label, fm, W, get, open, tag, runOf }) {
	const rows = ss.map((s) => { const xs = (get ? get(s) : []).filter((r) => r.v != null && isFinite(r.v)); return { s, xs, a: agg(xs.map((x) => x.v)) }; });
	const vs = rows.flatMap((r) => [...r.xs.map((x) => x.v), ...(r.a.sd != null ? [r.a.mean - r.a.sd, r.a.mean + r.a.sd] : [])]);
	if (!vs.length) return html`<p class="mnote">- ${label} not measured in these runs</p>`;
	const L = W >= 640 ? 220 : 150, P = 24, pw = Math.max(120, W - L - 2 * P), SW = pw + 2 * P, rh = 26, Ht = rows.length * rh + 22;
	let lo = Math.min(...vs), hi = Math.max(...vs);
	const pad = (hi - lo) * 0.08 || Math.abs(hi) * 0.05 || 1;
	(lo -= pad), (hi += pad);
	const yt = yTicks(lo, hi, 4), x0 = yt[0], x1 = yt[yt.length - 1], X = (v) => P + (pw * (v - x0)) / (x1 - x0), f = (v) => v.toFixed(1);
	// tick labels with as many digits as their step needs (a narrow spread of big numbers)
	const st = yt.length > 1 ? yt[1] - yt[0] : 1, big = Math.max(Math.abs(x0), Math.abs(x1)), div = big >= 1e9 ? 1e9 : big >= 1e6 ? 1e6 : big >= 1e4 ? 1e3 : 1, sfx = { 1e9: "B", 1e6: "M", 1e3: "k", 1: "" }[div];
	const dt = (v) => (v / div).toFixed(Math.min(3, Math.max(0, -Math.floor(Math.log10(st / div) + 1e-9)))) + sfx;
	return html`<div class="dpl" style=${"grid-template-columns:" + L + "px auto"}><div class="dpn">${rows.map((r, i) => html`<div class="dpr">${tag(r.s, !i && ss.length > 1)}</div>`)}</div>
		<svg class="gsvg dplot" width=${SW} height=${Ht} viewBox=${"0 0 " + SW + " " + Ht} role="img" aria-label=${label + " per run, per series"}>
			${yt.map((v) => [html`<line class="gl" x1=${f(X(v))} x2=${f(X(v))} y1="0" y2=${rows.length * rh} />`, html`<text x=${f(X(v))} y=${rows.length * rh + 15} text-anchor="middle">${dt(v)}</text>`])}
			${rows.map((r, i) => { const y = i * rh + rh / 2;
				return html`<g style=${"--c:" + r.s.color}>${r.a.sd != null ? html`<line class="dsd" x1=${f(X(r.a.mean - r.a.sd))} x2=${f(X(r.a.mean + r.a.sd))} y1=${y} y2=${y} data-tip=${r.s.label + ": mean ± sd " + fm(r.a.mean) + " ± " + fm(r.a.sd)} />` : null}
					${r.a.n ? html`<line class="dmean" x1=${f(X(r.a.mean))} x2=${f(X(r.a.mean))} y1=${y - 8} y2=${y + 8} />` : null}
					${r.xs.map((x) => { const t = runOf(x.w) + ": " + fm(x.v); return html`<circle class="dot1" data-dot=${x.w.id} cx=${f(X(x.v))} cy=${y} r="5" tabindex="0" role="button" aria-label=${t} data-tip=${t + " (a click opens it)"} onClick=${() => open(x.w.id)} onKeyDown=${(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), open(x.w.id))} />`; })}</g>`; })}
		</svg></div>`;
}
// the metric against the swept setting: per series its mean with +/- sd, on the setting's values in order
export function SweepChart({ ss, sw, m, W }) {
	const pts = ss.map((s, i) => ({ s, v: sw.vals[i], a: aggOf(m, s) })).filter((p) => p.a.n);
	if (pts.length < 2) return null;
	const order = sw.num ? [...new Set(pts.map((p) => sw.x(p.v)))].sort((a, b) => a - b) : [...new Set(pts.map((p) => JSON.stringify(p.v)))].map((x) => JSON.parse(x));
	const lab = new Map(pts.map((p) => [sw.num ? sw.x(p.v) : JSON.stringify(p.v), sw.txt(p.v)]));
	const L = GW.g, R = 24, pw = W - L - R, Ht = 200, T = 14, B = 34, ht = Ht - T - B, f = (v) => v.toFixed(1);
	const vs = pts.flatMap((p) => [p.a.mean - (p.a.sd || 0), p.a.mean + (p.a.sd || 0)]), pad = (Math.max(...vs) - Math.min(...vs)) * 0.15 || Math.abs(vs[0]) * 0.05 || 1, yt = yTicks(Math.min(...vs) - pad, Math.max(...vs) + pad, 4), y0 = yt[0], y1 = yt[yt.length - 1];
	const X = (v) => { if (sw.num) v = sw.x(v); if (sw.num && order.length > 1) return L + (pw * (v - order[0])) / (order[order.length - 1] - order[0]); const i = order.findIndex((o) => JSON.stringify(o) === JSON.stringify(v)); return L + (order.length > 1 ? (pw * i) / (order.length - 1) : pw / 2); };
	const Y = (v) => T + ht - (ht * (v - y0)) / (y1 - y0);
	return [html`<div class="gh"><b>${m.label} by ${keyName(sw.key)}</b><span class="gu" data-tip=${sw.key}>the setting these series differ in: mean ± sd</span></div>`,
		html`<svg class="gsvg" width=${W} height=${Ht} viewBox=${"0 0 " + W + " " + Ht} role="img" aria-label=${m.label + " against " + keyName(sw.key)}><text class="un" x="0" y="11">${m.hu}</text>
			${yt.map((v) => [html`<line class="gl" x1=${L} x2=${L + pw} y1=${f(Y(v))} y2=${f(Y(v))} />`, html`<text x=${L - 6} y=${f(Y(v) + 4)} text-anchor="end">${tick(v)}</text>`])}
			${order.map((v) => { const x = sw.num ? L + (order.length > 1 ? (pw * (v - order[0])) / (order[order.length - 1] - order[0]) : pw / 2) : X(v); return html`<text x=${f(x)} y=${Ht - B + 16} text-anchor="middle">${sw.num ? lab.get(v) : sw.txt(v)}</text>`; })}
			${sw.num ? html`<path class="gs" style="--c:var(--ink2)" stroke-width="1.5" d=${pts.slice().sort((a, b) => sw.x(a.v) - sw.x(b.v)).map((p, i) => (i ? "L" : "M") + f(X(p.v)) + "," + f(Y(p.a.mean))).join("")} />` : null}
			${pts.map((p) => html`<g style=${"--c:" + p.s.color} data-tip=${p.s.label + ": " + fmtMS(m, p.a) + " (" + p.a.n + " runs)"}>${p.a.sd != null ? html`<line class="dsd" x1=${f(X(p.v))} x2=${f(X(p.v))} y1=${f(Y(p.a.mean - p.a.sd))} y2=${f(Y(p.a.mean + p.a.sd))} />` : null}<circle class="dot1" cx=${f(X(p.v))} cy=${f(Y(p.a.mean))} r="5" /></g>`)}
			<text x=${L + pw / 2} y=${Ht - 2} text-anchor="middle" class="un">${keyName(sw.key)}</text></svg>`];
}
