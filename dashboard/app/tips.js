// The tooltips: at once on hovering (or focusing) anything with data-tip, under it (over it near the window's bottom),
// some drawn from the page (rich); and the game's own tooltip of an item or condition (api/item, api/condition: the
// client's render_item), open while hovered, kept on a click; the New sim form's items (data-hi) show it beside the form,
// the Gear sets page's beside the item.
import { h } from "./vendor/preact.js";
import { useEffect, useLayoutEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { signal, useSignal, itip } from "./store.js";
import { condName, PSEUDO } from "./art.js";

const html = htm.bind(h);
// ---- data-tip: its text; a rich one (a function of the element, set by its ref: rich(fn)) drawn instead
const RICH = new WeakMap();
export const rich = (fn) => (el) => { if (el) RICH.set(el, fn); };
const htipS = signal(null); // { el, body }
const tipShow = (el) => htipS.set({ el, body: (RICH.get(el) && RICH.get(el)(el)) || el.dataset.tip });
const tipHide = () => { if (htipS.v) htipS.set(null); };
export function HoverTip() {
	const t = useSignal(htipS), ref = useRef(null);
	useEffect(() => {
		const over = (e) => { const el = e.target.closest && e.target.closest("[data-tip]"); if (!el || !el.dataset.tip) return tipHide(); if (!htipS.v || el !== htipS.v.el) tipShow(el); };
		const on = [["pointerover", over], ["focusin", over], ["pointerdown", tipHide, true], ["scroll", tipHide, true]];
		for (const [k, f, c] of on) document.addEventListener(k, f, !!c);
		return () => { for (const [k, f, c] of on) document.removeEventListener(k, f, !!c); };
	}, []);
	useLayoutEffect(() => {
		const e = ref.current;
		if (!t || !e) return;
		if (!t.el.isConnected) return tipHide();
		const b = t.el.getBoundingClientRect(), w = e.offsetWidth, ht = e.offsetHeight;
		e.style.left = Math.max(6, Math.min(innerWidth - w - 6, b.left + b.width / 2 - w / 2)) + "px";
		e.style.top = (b.bottom + 6 + ht <= innerHeight ? b.bottom + 6 : Math.max(6, b.top - 6 - ht)) + "px";
	});
	return html`<div id="htip" role="tooltip" hidden=${!t} ref=${ref}>${t ? t.body : null}</div>`;
}

// ---- the game's tooltips: an item's (data-item; the form's: data-hi) or a condition's (data-cond, data-v: its value),
// fetched once each (a fetch under way shared)
const TIPS = "#panel [data-item], #panel [data-cond], #nsim [data-hi], #gsets [data-hi]";
const tips = new Map(), tipsP = new Map(), itemOf = (b) => b.dataset.item ?? b.dataset.hi;
export const tipKey = (b) => (b.dataset.cond != null ? "c|" + b.dataset.cond + "|" + (b.dataset.v ?? "") : itemOf(b) + "|" + (b.dataset.level || 0) + "|" + (b.dataset.stat || ""));
const getHtml = async (u) => { try { const r = await fetch(u); return r.ok ? (await r.json()).html : ""; } catch (e) { return ""; } };
function tipHtml(btn) {
	const key = tipKey(btn), { level, stat, cond, v } = btn.dataset, item = itemOf(btn);
	if (tips.has(key)) return Promise.resolve(tips.get(key));
	if (!tipsP.has(key)) tipsP.set(key, (cond != null ? getHtml("api/condition?name=" + encodeURIComponent(cond)).then((x) => x || (v && /^\w+$/.test(v) ? getHtml("api/item?name=" + encodeURIComponent(v) + "&level=0") : ""))
		: getHtml("api/item?name=" + encodeURIComponent(item) + "&level=" + (level || 0) + "&stat=" + encodeURIComponent(stat || ""))).then((x) => (tips.set(key, x), tipsP.delete(key), x)));
	return tipsP.get(key);
}
// the form's items shown: their tooltips fetched ahead (they show at once)
export const tipAhead = (root) => { for (const b of root.querySelectorAll("[data-hi]")) if (!tips.has(tipKey(b))) tipHtml(b); };
// the one open (its key, also while it loads), kept on a click (pinned: hovering others doesn't move it), the page's or
// the form's
let tipFor = null, tipPin = false, tipIn = null;
export const tipState = () => ({ tipFor, tipPin, tipIn });
export const tipPinned = (on) => (tipPin = on); // (the New sim form keeps an edited item's open)
export async function openTip(btn) {
	const { level, cond, v, note } = btn.dataset, item = itemOf(btn), key = tipKey(btn), pin = tipPin, form = btn.dataset.hi != null;
	if (tipFor === key) return;
	closeTip();
	tipPin = pin; tipFor = key; tipIn = form ? "form" : "panel";
	const x = await tipHtml(btn);
	if (tipFor !== key) return; // another one was opened meanwhile
	if (!btn.isConnected) return closeTip();
	itip.set({ key, el: btn, form, html: x, cond, v, item, level, note });
}
export function closeTip() {
	tipPin = false;
	if (!tipFor && !itip.v) return;
	tipFor = tipIn = null;
	itip.set(null);
}
// beside its slot, inside the window; the form's items: left of the character's editor at the height of its equipment
// and inventory (over nothing of the form: nothing there to click by mistake), where the window has room for it
export function tipPlace(btn) {
	const e = document.getElementById("itip");
	if (!e || !btn) return;
	const b = btn.getBoundingClientRect(), w = e.offsetWidth, ht = e.offsetHeight, g = btn.closest("#nsim .ned"), d = g && g.getBoundingClientRect();
	// (held by its right edge: a tooltip that grows as its images load stays in place)
	if (d && d.left - 8 - w >= 8) return void ((e.style.left = "auto"), (e.style.right = innerWidth - d.left + 8 + "px"), (e.style.top = Math.max(8, Math.min(innerHeight - ht - 8, g.querySelector(".nedg").getBoundingClientRect().top)) + "px"));
	e.style.right = "";
	e.style.left = Math.max(8, b.right + 8 + w <= innerWidth ? b.right + 8 : b.left - 8 - w >= 0 ? b.left - 8 - w : innerWidth - w - 8) + "px";
	e.style.top = Math.max(8, Math.min(innerHeight - ht - 8, b.top)) + "px";
}
const raw = (x) => html`<div style="display:contents" dangerouslySetInnerHTML=${{ __html: x }}></div>`;
const box = (a, b) => html`<div class="buyitem" style="background:#000;color:#ddd;border:5px solid gray;padding:14px;font-size:20px">${a}${b ? html`<br /><span style="color:#9a9a9a;font-size:16px">${b}</span>` : null}</div>`;
export function ItemTip() {
	const t = useSignal(itip);
	useEffect(() => {
		const over = (e) => { const g = e.target.closest && e.target.closest(TIPS); if (g && !tipPin && tipFor !== tipKey(g)) openTip(g); };
		const out = (e) => { const g = e.target.closest && e.target.closest(TIPS), to = e.relatedTarget; if (g && tipFor && !tipPin && !(to && (g.contains(to) || (to.closest && to.closest("#itip"))))) closeTip(); };
		// an item focused (the page's, the form's: the arrow keys go through the picker's): its tooltip
		const focus = (e) => { const g = e.target.closest && e.target.closest("#panel [data-item], #nsim [data-hi], #gsets [data-hi]"); if (g && !tipPin) openTip(g); else if (tipFor && !tipPin && !(e.target.closest && e.target.closest("#itip"))) closeTip(); };
		// a click on the page's item or condition keeps its tooltip (again: closes it); elsewhere, closes it
		const click = (e) => {
			if (!e.target.closest) return;
			const b = e.target.closest("#panel button[data-item], #panel button[data-cond]");
			if (b) { const k = tipKey(b); if (tipFor === k && !tipPin) return void (tipPin = true); tipPin = true; return void (tipFor === k ? closeTip() : openTip(b)); }
			if (tipFor && !e.target.closest("#itip") && !e.target.closest("[data-item], [data-cond], [data-hi]")) closeTip();
		};
		const key = (e) => { if (e.key === "Escape" && tipFor) (closeTip(), e.preventDefault()); };
		// scrolled: the page's moves along; the form's closes (an inventory item edited: its own moves along)
		const scroll = () => { const x = itip.v; if (!x) return; if (x.form && !tipPin) closeTip(); else tipPlace(x.el); };
		const on = [["pointerover", over], ["pointerout", out], ["focusin", focus], ["click", click], ["keydown", key, true], ["scroll", scroll, true]];
		for (const [k, f, c] of on) document.addEventListener(k, f, !!c);
		addEventListener("resize", closeTip);
		return () => { for (const [k, f, c] of on) document.removeEventListener(k, f, !!c); removeEventListener("resize", closeTip); };
	}, []);
	useLayoutEffect(() => { if (t) t.el.isConnected && (t.form || tipKey(t.el) === t.key) ? tipPlace(t.el) : closeTip(); });
	const link = t && !t.cond && !t.form ? html`<a href=${"https://adventure.land/docs/guide/all/items/" + encodeURIComponent(t.item)} target="_blank" rel="noopener">adventure.land item page, every level ↗</a>` : null;
	return html`<div id="itip" role="dialog" aria-label="Item" hidden=${!t} class=${t && t.form ? "form" : ""} onPointerLeave=${(e) => { if (!tipPin && !(e.relatedTarget && e.relatedTarget.closest && e.relatedTarget.closest(TIPS))) closeTip(); }}>
		${!t ? null : t.cond != null ? (t.html ? raw(t.html) : box(condName(t.cond) + (t.v ? " (" + t.v + ")" : ""), (PSEUDO[t.cond] && PSEUDO[t.cond][1]) || "no game description for it"))
			: [t.html ? raw(t.html) : box(t.item + " +" + (t.level || 0)), t.note ? html`<div class="itn">${t.note}</div>` : null, link]}
	</div>`;
}
