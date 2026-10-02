// The Gear sets page (#/gearsets[/<name>]): every gear set (lib/gear_sets.js) by class: the built-in ones (early, mid
// and late game, as shared on the game's Discord) and yours. A set opens as the game's sheet: yours edited there (a
// slot's click: the items its class may wear there, then the level, stat scroll and title; saved as you go), renamed,
// copied or removed (asked again first); a built-in one copied as yours. New sim wears a set on a character, compares
// sets, or puts them in its inventory (a character's Gear set, under its sheet).
import { h } from "./vendor/preact.js";
import { useState, useEffect, useLayoutEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { call, why, cvar, CLASSES } from "./lib.js";
import { nav } from "./store.js";
import { iconFit, skIcon, CLASS_SKILL, SHEET, badge, shadeOf } from "./art.js";
import { tipAhead } from "./tips.js";
import { Del } from "./accounts.js";

const html = htm.bind(h);
const NAME = /^[A-Za-z0-9_-]{1,24}$/;
const enc = encodeURIComponent;
// an item spec ("bow+8:dex#shiny", "none") as the item (null: empty), and back; an item's tooltip attributes (the game's,
// at its level and stat scroll)
export const unspec = (x) => { if (!x || x === "none") return null; const m = /^([^+:#]+)(?:\+(\d+))?(?::([^#]+))?(?:#(.+))?$/.exec(x) || [, x]; return { name: m[1], ...(m[2] ? { level: Number(m[2]) } : {}), ...(m[3] ? { stat_type: m[3] } : {}), ...(m[4] ? { p: m[4] } : {}) }; };
export const spec = (it) => (it ? it.name + (it.level ? "+" + it.level : "") + (it.stat_type ? ":" + it.stat_type : "") + (it.p ? "#" + it.p : "") : "none");
export const hi = (it) => ({ "data-hi": it.name, "data-level": it.level || 0, "data-stat": it.stat_type || "" });
// a set as a small sheet (the game's layout; the elixir's cell blank)
export const miniSheet = (gear) => html`<span class="gmini">${SHEET.flat().map((k) => { const it = k !== "elixir" && unspec(gear[k]); return it ? html`<span class="gs" ...${hi(it)}>${iconFit(it.name, 26)}${badge(it.name, it.level || 0)}</span>` : html`<span class="gs"></span>`; })}</span>`;
const setName = (s) => s.label || s.name;

// the game's items (api/new/items: [name, type, wtype, highest level, takes a stat scroll, classes, stack]), the stat
// scrolls and titles; what fits a class's slot (api/new/fits), once each
let CAT = null;
const FITS = new Map();

export function GearSetsPage({ name }) {
	const [d, setD] = useState(null), [cls, setCls] = useState("all"), [msg, setMsg] = useState(null), [mk, setMk] = useState(null);
	// (the classes in the dashboard's order)
	const load = () => call("api/gearsets").then((r) => setD(r.ok ? { ...r.body, classes: r.body.classes.sort((a, b) => (CLASSES.indexOf(a) + 1 || 99) - (CLASSES.indexOf(b) + 1 || 99)) } : { error: why(r) }));
	useEffect(() => { load(); if (!CAT) call("api/new/items").then((r) => { if (r.ok) (CAT = r.body), load(); }); }, []);
	// a set opened: its sheet in view
	useEffect(() => { const e = document.getElementById("gsed"); if (e) e.scrollIntoView({ block: "nearest" }); }, [name, !!d]);
	if (!d) return html`<div class="page"><h2>Gear sets</h2><p class="mnote">loading...</p></div>`;
	if (d.error) return html`<div class="page"><h2>Gear sets</h2><p class="nbad">${d.error}</p></div>`;
	const ok = d.sets.filter((s) => !s.problems), cur = name ? ok.find((s) => s.name === name) : null;
	const has = d.classes.filter((c) => ok.some((s) => s.class === c)), shown = has.filter((c) => cls === "all" || c === cls);
	// a new set of yours: empty, of a class
	const create = async () => {
		const n = mk.name.trim();
		if (!NAME.test(n)) return setMk({ ...mk, err: "its name: 1-24 letters, digits, _ or -" });
		if (d.sets.some((s) => s.name === n)) return setMk({ ...mk, err: "a gear set " + n + " exists already" });
		const r = await call("api/gearsets/" + enc(n), "PUT", { set: { name: n, class: mk.class, gear: {} } });
		if (!r.ok) return setMk({ ...mk, err: why(r) });
		setMk(null); setMsg(null); await load(); nav("#/gearsets/" + enc(n));
	};
	const group = (t, xs, note) => (xs.length ? html`<div class="gsg"><h5>${t}${note ? html` <span class="gu">${note}</span>` : null}</h5><div class="gsl">${xs.map((s) => html`<a class="gset" href=${"#/gearsets/" + enc(s.name)} aria-current=${cur === s ? "page" : null} aria-label=${s.class + " " + setName(s)}><b>${setName(s)}</b>${miniSheet(s.gear)}</a>`)}</div></div>` : null);
	return html`<div class="page" id="gsets">
		<div class="frow"><h2>Gear sets</h2>${!mk && html`<button type="button" class="cb" onClick=${() => setMk({ class: cls !== "all" ? cls : (cur && cur.class) || d.classes[0], name: "" })}>New set</button>`}</div>
		<p class="gu">A class's gear in every slot but the elixir. New sim wears one on a character, compares them or puts them in its inventory: a character's Gear set, under its sheet.</p>
		${mk && html`<div class="frow"><select aria-label="Its class" value=${mk.class} onChange=${(e) => setMk({ ...mk, class: e.target.value })}>${d.classes.map((c) => html`<option value=${c}>${c}</option>`)}</select>
			<input type="text" maxlength="24" placeholder="its name" aria-label="Its name" value=${mk.name} onInput=${(e) => setMk({ ...mk, name: e.target.value, err: null })} onKeyDown=${(e) => e.key === "Enter" && create()} />
			<button type="button" class="go" onClick=${create}>Create</button><button type="button" class="cb" onClick=${() => setMk(null)}>Cancel</button>${mk.err && html`<span class="nbad">${mk.err}</span>`}</div>`}
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${d.sets.filter((s) => s.problems).map((s) => html`<p class="nbad">${s.name}: ${s.problems.join("; ")}</p>`)}
		${name && !cur ? html`<p class="nbad">No gear set ${name}.</p>` : cur ? html`<${SetEd} key=${cur.name} s=${cur} d=${d} reload=${load} say=${setMsg} />` : null}
		${has.length > 1 && html`<span class="seg sm" role="group" aria-label="Class">${["all", ...has].map((c) => html`<button type="button" aria-pressed=${cls === c} onClick=${() => setCls(c)}>${c === "all" ? "All" : c}</button>`)}</span>`}
		${shown.map((c) => { const xs = ok.filter((s) => s.class === c); return html`<section class="gscls" style=${cvar(c)}><h3>${skIcon(CLASS_SKILL[c], 20)}<span>${c}</span></h3>
			${group("Discord's", xs.filter((s) => s.builtin), "a community list: it may be out of date")}${group("Yours", xs.filter((s) => !s.builtin))}</section>`; })}
		${!has.length && html`<p class="mnote">No gear sets.</p>`}
		${CAT && html`<datalist id="gs-stats">${CAT.stats.map((x) => html`<option value=${x} />`)}</datalist><datalist id="gs-titles">${CAT.titles.map((x) => html`<option value=${x} />`)}</datalist>`}
	</div>`;
}

// a stat scroll or title typed: the one called that, else the first that starts so, else the first holding it ("":
// none; null: nothing matches)
const pickOf = (vals, t) => { const q = String(t || "").trim().toLowerCase(); if (!q) return ""; return vals.find((v) => v === q) || vals.find((v) => v.startsWith(q)) || vals.find((v) => v.includes(q)) || null; };
// a level typed: a number (12, +12) or the game's letter (X Y Z: 10-12; a compound's V S R: 5-7), within max
const lvParse = (t, max) => { const m = /^\+?\s*(\d{1,2}|[xyzvsr])$/i.exec(String(t).trim()); if (!m) return null; const v = /\d/.test(m[1]) ? Number(m[1]) : { x: 10, y: 11, z: 12, v: 5, s: 6, r: 7 }[m[1].toLowerCase()]; return Math.max(0, Math.min(max, v)); };

// ---- a set open: its sheet (yours: a slot's click opens the items that fit there; its red x or Delete empties it),
// saved 400 ms after the last change; yours renamed or removed, any copied as yours
function SetEd({ s, d, reload, say }) {
	const own = !s.builtin;
	const [gear, setGear] = useState(() => ({ ...s.gear })), [pick, setPick] = useState(null); // { slot, q }
	const [nm, setNm] = useState(s.name), [cp, setCp] = useState(""), [state, setState] = useState(null), [, redraw] = useState(0);
	const timer = useRef(null), root = useRef(null), focusNext = useRef(null), drafts = useRef(new Map()), at = useRef("mainhand"), pickRef = useRef(null);
	pickRef.current = pick;
	const slots = Object.fromEntries(SHEET.flat().map((k) => [k, unspec(gear[k])]));
	const max = (k) => (CAT && CAT.items[k] ? CAT.items[k][3] : 0), takesStat = (k) => !!(CAT && CAT.items[k] && CAT.items[k][4]);
	const put = (g) => {
		clearTimeout(timer.current); setState({ text: "saving..." });
		timer.current = setTimeout(async () => {
			const r = await call("api/gearsets/" + enc(s.name), "PUT", { set: { name: s.name, class: s.class, gear: g } });
			setState(r.ok ? { text: "saved" } : { text: why(r), bad: true });
			if (r.ok) reload();
		}, 400);
	};
	const setSlot = (sl, f) => { const g = { ...gear, [sl]: spec(f(slots[sl])) }; setGear(g); put(g); };
	const focus = (sel) => { focusNext.current = sel; redraw((x) => x + 1); };
	const close = (keys) => { const sl = pick && pick.slot; drafts.current.clear(); setPick(null); if (keys && sl) focus('[data-gslot="' + sl + '"]'); };
	useLayoutEffect(() => {
		if (focusNext.current && root.current) { const e = root.current.querySelector(focusNext.current); focusNext.current = null; if (e) e.focus(); }
		if (root.current) tipAhead(root.current);
	});
	// a click outside the picker closes it
	useEffect(() => {
		const out = (e) => { if (pickRef.current && e.target.closest && !e.target.closest(".ipk, [data-gslot], #itip")) (drafts.current.clear(), setPick(null)); };
		document.addEventListener("click", out, true);
		return () => document.removeEventListener("click", out, true);
	}, []);

	const sheet = html`<div class="sheet">${SHEET.flat().map((sl) => {
		const it = slots[sl];
		if (sl === "elixir") return html`<span class="gs gsx" aria-hidden="true"></span>`;
		const inner = [it ? [iconFit(it.name, 40) || it.name.slice(0, 4), badge(it.name, it.level || 0)] : shadeOf(sl), own && it ? html`<span class="rmx" aria-hidden="true" onClick=${(e) => { e.stopPropagation(); setSlot(sl, () => null); }}>×</span>` : null];
		const lab = sl + ": " + (it ? spec(it) : "empty");
		return own ? html`<button type="button" class="gs ge" data-gslot=${sl} tabIndex=${sl === at.current ? 0 : -1} aria-haspopup="dialog" aria-expanded=${!!(pick && pick.slot === sl)} aria-label=${lab + (it ? " (Delete: empty it)" : "")} ...${it ? hi(it) : {}}
			onFocus=${() => (at.current = sl)} onClick=${(e) => { const same = pick && pick.slot === sl; drafts.current.clear(); setPick(same ? null : { slot: sl, q: "" }); focus(same ? (e.detail ? null : '[data-gslot="' + sl + '"]') : "[data-gpq]"); }}>${inner}</button>`
			: html`<span class="gs" data-gslot=${sl} tabIndex=${sl === at.current ? 0 : -1} aria-label=${lab} ...${it ? hi(it) : {}} onFocus=${() => (at.current = sl)}>${inner}</span>`;
	})}</div>`;

	// the picker of a slot: the item there (its red x empties the slot), a search, the items that fit (the class's own
	// first; another class's dimmed: worn with none of its stats); under them the level, stat scroll and title
	let picker = null, apply = null, step = null; // (apply, step: its fields' own; the keys use them while it's open)
	if (own && pick) {
		const sl = pick.slot, cur = slots[sl], I = (CAT && CAT.items) || {}, q = String(pick.q || "").toLowerCase();
		const key = [s.class, sl, (sl === "offhand" && slots.mainhand && slots.mainhand.name) || "", (sl === "mainhand" && slots.offhand && slots.offhand.name) || ""].join("|");
		if (!FITS.has(key)) { FITS.set(key, null); const [, , mh, oh] = key.split("|"); call("api/new/fits?" + new URLSearchParams({ class: s.class, slot: sl, mainhand: mh, offhand: oh })).then((r) => { if (r.ok) FITS.set(key, r.body.items); else FITS.delete(key); redraw((x) => x + 1); }); }
		const all = FITS.get(key), hit = (k) => { const n = String((I[k] || [])[0] || "").toLowerCase(); return k === q || n === q ? 0 : n.startsWith(q) || k.startsWith(q) ? 1 : 2; };
		const list = all && all.filter(([k]) => !q || k.includes(q) || String((I[k] || [])[0]).toLowerCase().includes(q)).map((x, i) => [x, i]).sort((a, b) => (q ? hit(a[0][0]) - hit(b[0][0]) : 0) || a[1] - b[1]).map(([x]) => x);
		const lvOf = (k) => Math.min(cur ? cur.level || 0 : 0, max(k));
		const choose = (k, e) => {
			setSlot(sl, (y) => ({ name: k, ...(lvOf(k) ? { level: lvOf(k) } : {}), ...(y && y.stat_type && takesStat(k) ? { stat_type: y.stat_type } : {}), ...(y && y.p ? { p: y.p } : {}) }));
			if (!e.detail) focus(".ipk .ift input");
		};
		const level = (v) => setSlot(sl, (it) => (it ? { ...it, level: v } : null));
		const field = (k, list, what) => { const id = k, f = k === "title" ? "p" : "stat_type"; return html`<input type="text" class="cmb" list=${list} data-gk=${k} value=${drafts.current.get(id) ?? (cur && cur[f]) ?? ""} placeholder=${what} aria-label=${what} autocomplete="off"
			onInput=${(e) => drafts.current.set(id, e.currentTarget.value)} onChange=${(e) => apply(e.currentTarget)} />`; };
		apply = (t) => {
			const k = t.dataset.gk;
			if (k === "lv") { const v = lvParse(drafts.current.get("lv") ?? t.value, max(cur.name)); drafts.current.delete("lv"); return v != null ? level(v) : redraw((x) => x + 1); }
			const v = pickOf(k === "title" ? CAT.titles : CAT.stats, drafts.current.has(k) ? drafts.current.get(k) : t.value), f = k === "title" ? "p" : "stat_type";
			drafts.current.delete(k);
			if (v == null) return redraw((x) => x + 1);
			setSlot(sl, (it) => { if (!it) return null; const o = { ...it }; v ? (o[f] = v) : delete o[f]; return o; });
		};
		step = (dir) => { const v = Math.max(0, Math.min(max(cur.name), (cur.level || 0) + dir)); drafts.current.delete("lv"); level(v); };
		const foot = cur ? html`<div class="ift">
			${max(cur.name) ? html`<span class="lvs"><button type="button" tabIndex="-1" aria-label="Level down" onClick=${() => step(-1)}>-</button><input type="text" class="lvi" data-gk="lv" role="spinbutton" aria-label="Level" aria-valuemin="0" aria-valuemax=${max(cur.name)} aria-valuenow=${cur.level || 0}
				value=${drafts.current.get("lv") ?? "+" + (cur.level || 0)} onInput=${(e) => drafts.current.set("lv", e.currentTarget.value)} onChange=${(e) => apply(e.currentTarget)} onFocus=${(e) => e.currentTarget.select()} /><button type="button" tabIndex="-1" aria-label="Level up" onClick=${() => step(1)}>+</button></span>` : null}
			${takesStat(cur.name) ? field("stat", "gs-stats", "stat scroll") : null}${field("title", "gs-titles", "title")}</div>` : null;
		const cells = !list ? html`<p class="hint">loading...</p>` : !list.length ? html`<p class="hint">nothing fits${q ? ' "' + pick.q + '"' : ""}</p>`
			: html`<div class="igrid" role="listbox" aria-label=${"Items for the " + sl}>${list.map(([k, other]) => html`<button type="button" class=${"gs" + (other ? " oth" : "")} role="option" tabIndex="-1" data-gpick=${k} aria-pressed=${!!(cur && cur.name === k)} aria-label=${(I[k] || [k])[0] + (other ? " (another class: none of its stats)" : "")}
				...${hi({ name: k, level: lvOf(k), stat_type: cur && cur.stat_type && takesStat(k) ? cur.stat_type : "" })} data-note=${other ? "another class: worn with none of its stats" : null} onClick=${(e) => choose(k, e)}>${iconFit(k, 40) || k.slice(0, 4)}${badge(k, lvOf(k))}</button>`)}</div>`;
		picker = html`<div class="ipk gear" role="dialog" aria-label=${"Items for the " + sl} style=${"--r:" + SHEET.findIndex((x) => x.includes(sl))}><button type="button" class="x cls" aria-label="Close" onClick=${(e) => close(!e.detail)}>×</button>
			<div class="ih"><span class="gs hx" ...${cur ? hi(cur) : {}}>${cur ? [iconFit(cur.name, 40), badge(cur.name, cur.level || 0), html`<button type="button" class="rmx" tabIndex="-1" aria-label="Empty the slot" onClick=${() => { setSlot(sl, () => null); focus("[data-gpq]"); }}>×</button>`] : null}</span><span class="inm">${sl}</span></div>
			<input type="search" data-gpq="1" value=${pick.q} placeholder=${"find an item for the " + sl} aria-label="Find an item" onInput=${(e) => setPick({ ...pick, q: e.currentTarget.value })} />${cells}${foot}</div>`;
	}

	// the keys: the sheet's arrows (4 wide), Delete or X empties a slot; the picker's search Down (Enter: the first item)
	// into its grid, the arrows through it (Up past its top row: back to the search), a letter back to the search; Enter
	// in its level, stat scroll or title applies and closes; Esc closes, back on the slot
	const keys = (e) => {
		const t = e.target, dt = t.dataset || {};
		if (pick && e.key === "Escape") { e.preventDefault(); return close(true); }
		if (dt.gslot) {
			if (own && slots[dt.gslot] && (e.key === "Delete" || e.key === "x" || e.key === "X")) { e.preventDefault(); return setSlot(dt.gslot, () => null); }
			const i = SHEET.flat().indexOf(dt.gslot), to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - 4, ArrowDown: i + 4 }[e.key];
			if (to != null) { e.preventDefault(); const b = root.current.querySelector('[data-gslot="' + SHEET.flat()[to] + '"]'); if (b) b.focus(); }
			return;
		}
		const pk = t.closest(".ipk");
		if (!pk) return;
		if (dt.gk === "lv" && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); return step(e.key === "ArrowUp" ? 1 : -1); }
		if (dt.gk && e.key === "Enter") { e.preventDefault(); apply(t); return close(true); }
		const cells = [...pk.querySelectorAll("[data-gpick]")], i = cells.indexOf(t), g = pk.querySelector(".igrid");
		if (dt.gpq != null) { if ((e.key === "ArrowDown" || e.key === "Enter") && cells.length) { e.preventDefault(); e.key === "Enter" ? cells[0].click() : cells[0].focus(); } return; }
		if (i < 0) return;
		const cols = Math.max(1, Math.round(g.clientWidth / 52)), to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols }[e.key];
		if (to != null) { e.preventDefault(); if (to < 0 && e.key === "ArrowUp") return pk.querySelector("[data-gpq]").focus(); const c = cells[Math.max(0, Math.min(cells.length - 1, to))]; c.focus(); return c.scrollIntoView({ block: "nearest" }); }
		if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) pk.querySelector("[data-gpq]").focus(); // (the letter goes on into the search)
	};
	const write = async (n, was) => {
		if (!NAME.test(n)) return setState({ text: "its name: 1-24 letters, digits, _ or -", bad: true });
		if (!was && d.sets.some((x) => x.name === n)) return setState({ text: "a gear set " + n + " exists already", bad: true });
		clearTimeout(timer.current);
		const r = await call("api/gearsets/" + enc(n), "PUT", { set: { name: n, class: s.class, gear }, ...(was ? { was } : {}) });
		if (!r.ok) return setState({ text: why(r), bad: true });
		say({ text: (was ? "Renamed " + was + " to " : "Copied as ") + n });
		await reload(); nav("#/gearsets/" + enc(n), !!was);
	};
	const del = async () => {
		clearTimeout(timer.current);
		const r = await call("api/gearsets/" + enc(s.name), "DELETE");
		say(r.ok ? { text: "Removed " + s.name } : { text: why(r), bad: true });
		await reload(); if (r.ok) nav("#/gearsets", true);
	};
	return html`<section class="card1 gsed" id="gsed" ref=${root} style=${cvar(s.class)} onKeyDown=${keys}>
		<div class="frow"><span class="ncl">${skIcon(CLASS_SKILL[s.class], 20)}</span><b class="gsnm">${setName(s)}</b><span class="gu">${s.class + (own ? ", yours" : ", Discord's: a community list, it may be out of date")}</span>
			${state && html`<span class=${state.bad ? "nbad" : "gu"}>${state.text}</span>`}</div>
		<div class="nedg"><div class="shw"><div class="ivh"><h5>Equipment</h5>${own ? html`<span class="gu">a slot's click: what fits there</span>` : null}</div>${sheet}</div>${picker}</div>
		<div class="frow">
			${own && html`<input type="text" maxlength="24" aria-label="Its name" value=${nm} onInput=${(e) => setNm(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && nm.trim() !== s.name && write(nm.trim(), s.name)} /><button type="button" class="cb" disabled=${nm.trim() === s.name} onClick=${() => write(nm.trim(), s.name)}>Rename</button>`}
			<input type="text" maxlength="24" placeholder="a name" aria-label="Copy as yours, named" value=${cp} onInput=${(e) => setCp(e.target.value)} onKeyDown=${(e) => e.key === "Enter" && write(cp.trim(), null)} /><button type="button" class="cb" onClick=${() => write(cp.trim(), null)}>Copy as yours</button>
			${own && html`<${Del} what=${"Remove " + s.name} go=${del} />`}</div>
	</section>`;
}
