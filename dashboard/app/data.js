// The Data tab (a run's, a group's, Compare's): panels you compose in 1 to 4 columns, the same on every page
// (metrics.js PANELS, saved on the dashboard): a metric each (metrics.js DATA: picked by what it measures, then its
// total or its rate, each named as itself: Damage, DPS), shown as meters (per character; a click on a row: its
// breakdown), its breakdown (the party's, by skill, target...) or over time (the rate over a window, or the total so
// far). Added, removed, dragged by their grip to another place (the places to drop marked while dragging; the arrow
// keys on the grip move it too).
import { h } from "./vendor/preact.js";
import { useState, useRef, useLayoutEffect } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { redraw } from "./store.js";
import { Select, IbX } from "./ui.js";
import { DATA, dataM, viewsOf, VIEWS, MAXCOLS, PANELS, CARDS, setPanels, resetPanels, statsOf } from "./metrics.js";
import { RunCharts, CmpTimeline } from "./charts.js";
import { Meters } from "./panel.js";
import { StatMeters } from "./compare.js";

const html = htm.bind(h);
// ---- a metric picked: what it measures (one entry per family), then Total or its rate (per second or hour) when it
// has both; only: the metrics allowed, has: the ones measured (the rest marked)
const FAMS = [];
for (const d of DATA) {
	let f = FAMS.find((x) => x.f === d.f);
	if (!f) FAMS.push((f = { f: d.f, label: d.label, total: null, rate: null }));
	d.rate ? (f.rate = d) : ((f.total = d), (f.label = d.label));
}
export function MetricPick({ id, onPick, only = () => true, has = () => true }) {
	const d = dataM(id), ok = (x) => !!x && only(x), fs = FAMS.filter((f) => ok(f.total) || ok(f.rate)), f = FAMS.find((x) => x.f === d.f);
	const pickF = (k) => { const g = FAMS.find((x) => x.f === k), want = d.rate ? g.rate : g.total; onPick((ok(want) ? want : ok(g.total) ? g.total : g.rate).id); };
	return [html`<label class="dd"><span class="ic">${d.ic()}</span><${Select} aria-label="Metric" value=${f.f} onChange=${(e) => pickF(e.currentTarget.value)}>${fs.map((x) => html`<option value=${x.f}>${x.label + (has(x.total || x.rate) ? "" : " (not measured)")}</option>`)}</${Select}></label>`,
		ok(f.total) && ok(f.rate) ? html`<span class="seg sm" role="group" aria-label=${f.label + ": its total or its rate"}><button type="button" aria-pressed=${!d.rate} onClick=${() => d.rate && onPick(f.total.id)}>Total</button><button type="button" aria-pressed=${!!d.rate} data-tip=${f.rate.label} onClick=${() => !d.rate && onPick(f.rate.id)}>${f.rate.rate === 3600 ? "Per hour" : "Per second"}</button></span>` : null];
}

// each panel's own state while pages show (not saved): its meters' breakdown, Compare's dots and turned row
const PS = new Map();
const psOf = (id) => PS.get(id) || PS.set(id, { drill: null, dotFor: null, mrow: null }).get(id);
const setPs = (id, o) => (Object.assign(psOf(id), o), redraw());
// another page: a character's breakdown kept only when that character is in the run shown
export function panelsFor(w) {
	for (const st of PS.values()) {
		if (st.drill && st.drill.who !== "*" && !(w && w.players.some((p) => p.name === st.drill.who))) st.drill = null;
		st.dotFor = st.mrow = null;
	}
}
// a panel moved to column col, i-th there (counted without it)
function moveTo(id, col, i) {
	const p = PANELS.list.find((x) => x.id === id), rest = PANELS.list.filter((x) => x.id !== id), inCol = rest.filter((x) => x.col === col);
	const at = i < inCol.length ? rest.indexOf(inCol[i]) : inCol.length ? rest.indexOf(inCol[inCol.length - 1]) + 1 : rest.length;
	rest.splice(at, 0, { ...p, col });
	if (rest.some((x, k) => x.id !== PANELS.list[k].id || x.col !== PANELS.list[k].col)) setPanels(rest);
}
// the place under the pointer: the column it is over (else the nearest), before the first panel (not the dragged one)
// whose middle is below it
function placeAt(root, x, y, id) {
	const cols = [...root.querySelectorAll(":scope > .dcol")], rs = cols.map((el) => el.getBoundingClientRect());
	let c = rs.findIndex((r) => x >= r.left && x <= r.right);
	if (c < 0) c = rs.reduce((b, r, i) => { const d = x < r.left ? r.left - x : x - r.right; return d < b[1] ? [i, d] : b; }, [0, Infinity])[0];
	const ps = [...cols[c].querySelectorAll(":scope > .dp")].filter((el) => el.dataset.id !== id);
	return { col: c, i: ps.filter((el) => { const r = el.getBoundingClientRect(); return r.top + r.height / 2 < y; }).length };
}
// what scrolls the page: the panel's first scrolling ancestor, else the window
function scroller(el) {
	for (let e = el.parentElement; e; e = e.parentElement) { const o = getComputedStyle(e).overflowY; if ((o === "auto" || o === "scroll") && e.scrollHeight > e.clientHeight) return e; }
	return document.scrollingElement;
}
const GAP = 12, newId = () => "p" + Math.random().toString(36).slice(2, 9);
let focusGrip = null; // (a panel moved by the keys: its grip keeps the focus)
// W: the panels' width (the columns' and the gaps between them)
export function DataPanels({ w, ss, W }) {
	const { cols, list } = PANELS, S1 = w && statsOf(w), root = useRef(null), [drag, setDrag] = useState(null); // { id, col, i }: where it would go
	useLayoutEffect(() => { if (focusGrip && root.current) { const g = root.current.querySelector('[data-grip="' + focusGrip + '"]'); focusGrip = null; if (g) g.focus(); } });
	// (a run's metrics it doesn't measure: marked in the pickers)
	const has = (x) => !w || !x.m || (x.m.k === "items" ? S1.P.some((c) => c.p.items) : S1.P.some((c) => x.m.v(c, S1) != null));
	const cw = Math.floor((W - GAP * (cols - 1)) / cols);
	// a new panel: in the column with the fewest
	const add = () => { const n = Array.from({ length: cols }, (_, c) => list.filter((p) => p.col === c).length); setPanels([...list, { id: newId(), m: "dps", view: "meters", col: n.indexOf(Math.min(...n)) }]); };
	// dragged by its grip: the place under the pointer marked, dropped there; near the window's top or bottom, the page
	// scrolls; Esc puts it back
	const grab = (e, p) => {
		if (e.button !== 0) return;
		e.preventDefault();
		const g = e.currentTarget, sc = scroller(root.current), at = (x, y) => placeAt(root.current, x, y, p.id);
		let pt = { x: e.clientX, y: e.clientY }, cur = { id: p.id, ...at(pt.x, pt.y) };
		g.setPointerCapture(e.pointerId);
		setDrag(cur);
		const upd = () => { const s = at(pt.x, pt.y); if (s.col !== cur.col || s.i !== cur.i) setDrag((cur = { id: p.id, ...s })); };
		const move = (ev) => { pt = { x: ev.clientX, y: ev.clientY }; upd(); };
		const tick = setInterval(() => { const r = sc === document.scrollingElement ? { top: 0, bottom: innerHeight } : sc.getBoundingClientRect(), d = pt.y < r.top + 48 ? -18 : pt.y > r.bottom - 48 ? 18 : 0; if (d) (sc.scrollTop += d), upd(); }, 30);
		const end = (drop) => {
			clearInterval(tick);
			g.removeEventListener("pointermove", move); g.removeEventListener("pointerup", up); g.removeEventListener("pointercancel", no); removeEventListener("keydown", key, true);
			setDrag(null);
			if (drop) moveTo(p.id, cur.col, cur.i);
		};
		const up = () => end(true), no = () => end(false), key = (ev) => { if (ev.key === "Escape") (ev.preventDefault(), ev.stopPropagation(), end(false)); };
		g.addEventListener("pointermove", move); g.addEventListener("pointerup", up); g.addEventListener("pointercancel", no); addEventListener("keydown", key, true);
	};
	// the arrow keys on a grip: up and down in its column, left and right to the next column
	const keys = (e, p) => {
		const k = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0] }[e.key];
		if (!k) return;
		e.preventDefault();
		const inCol = list.filter((x) => x.col === p.col), i = inCol.indexOf(p), c = p.col + k[0], j = i + k[1];
		if (k[0] ? c < 0 || c >= cols : j < 0 || j >= inCol.length) return;
		focusGrip = p.id;
		moveTo(p.id, c, k[0] ? Math.min(i, list.filter((x) => x.col === c).length) : j);
	};
	const columns = Array.from({ length: cols }, (_, c) => {
		const ps = list.filter((p) => p.col === c), others = drag ? ps.filter((p) => p.id !== drag.id) : ps;
		const slot = (key, k, end) => html`<div key=${key} class=${"dslot" + (end ? " end" : "") + (drag && drag.col === c && drag.i === k ? " on" : "")} aria-hidden="true"></div>`;
		const out = ps.flatMap((p) => [slot("s" + p.id, others.indexOf(p)), html`<${Panel} key=${p.id} p=${p} n=${list.length} cols=${cols} w=${w} ss=${ss} W=${cw - 26} has=${has} grab=${grab} keys=${keys} dragged=${!!drag && drag.id === p.id} />`]);
		return html`<div class="dcol" data-col=${c}>${out}${!ps.length ? html`<p class="dempty">${drag ? "Drop it here" : "An empty column: drag a panel here by its grip"}</p>` : null}${slot("end", others.length, true)}</div>`;
	});
	return html`<div class="dpw"><div class=${"dps" + (drag ? " dragging" : "")} ref=${root} style=${"grid-template-columns:repeat(" + cols + ", minmax(0, 1fr))"}>${columns}</div>
		${!list.length ? html`<p class="mnote">No panels: add one.</p>` : null}
		<div class="dpa"><button type="button" class="cb" disabled=${list.length >= 12} data-tip=${list.length >= 12 ? "12 panels at most" : "a panel: a metric as meters, its breakdown or over time"} onClick=${add}>Add a panel</button>
			<span class="fl">Columns</span><span class="seg sm" role="group" aria-label="Columns">${Array.from({ length: MAXCOLS }, (_, i) => html`<button type="button" aria-pressed=${cols === i + 1} data-tip=${i + 1 < cols ? "the panels of the columns past " + (i + 1) + " go to the last one" : null} onClick=${() => setPanels(list, i + 1)}>${i + 1}</button>`)}</span>
			<button type="button" class="lnk sm" onClick=${resetPanels}>Defaults</button><span class="gu">the same panels on every run, group and Compare page${CARDS.note ? "; " + CARDS.note.toLowerCase() : ""}</span></div></div>`;
}
function Panel({ p, n, cols, w, ss, W, has, grab, keys, dragged }) {
	const d = dataM(p.m), vs = viewsOf(d), view = vs.includes(p.view) ? p.view : vs[0], st = psOf(p.id);
	const change = (o) => setPanels(PANELS.list.map((x) => (x.id === p.id ? { ...x, ...o } : x)));
	const pick = html`<${MetricPick} id=${d.id} has=${has} onPick=${(m) => { const nv = viewsOf(dataM(m)); setPs(p.id, { drill: null, dotFor: null, mrow: null }); change({ m, view: nv.includes(view) ? view : nv[0] }); }} />`;
	const seg = html`<span class="seg sm" role="group" aria-label="Shown as">${VIEWS.map(([v, l]) => html`<button type="button" aria-pressed=${v === view} disabled=${!vs.includes(v)} data-tip=${vs.includes(v) ? null : d.label + ": not " + l.toLowerCase()} onClick=${() => change({ view: v })}>${l}</button>`)}</span>`;
	const grip = html`<button type="button" class="grip" data-grip=${p.id} aria-label=${"Move the " + d.label + " panel"} data-tip=${"drag to move it" + (n > 1 || cols > 1 ? "; or the arrow keys" : "")} onPointerDown=${(e) => grab(e, p)} onKeyDown=${(e) => keys(e, p)}></button>`;
	let body;
	if (view === "time") body = w ? html`<${RunCharts} w=${w} part="timeline" W=${W} d=${d} />` : html`<${CmpTimeline} ss=${ss} W=${W} bands=${true} d=${d} />`;
	else {
		// a Breakdown panel's: the party's, by the panel's "by" (kept with it)
		const fixed = view === "by", drill = fixed ? { who: "*", by: p.by } : st.drill;
		body = w ? html`<${Meters} w=${w} m=${d.m} drill=${drill} go=${(x) => (fixed ? x && change({ by: x.by }) : setPs(p.id, { drill: x }))} fixed=${fixed} />`
			: html`<${StatMeters} ss=${ss} m=${d.m} st=${{ ...st, drill }} set=${(o) => (fixed && "drill" in o ? o.drill && change({ by: o.drill.by }) : setPs(p.id, o))} fixed=${fixed} W=${W} />`;
	}
	return html`<section class=${"box dp" + (dragged ? " dragged" : "")} data-id=${p.id} aria-label=${d.label}><div class="gh dph">${grip}${pick}${seg}</div>
		<span class="dpx"><${IbX} what="Remove this panel" onClick=${() => setPanels(PANELS.list.filter((x) => x.id !== p.id))} /></span>${body}</section>`;
}
