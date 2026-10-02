// The game's art as the pages draw it: sprites, item and skill icons, monsters (trimmed to their pixels), the upgrade
// level's badge, a character's gear as the game's sheet and its inventory; the dashboard's own small icons.
import { h } from "./vendor/preact.js";
import { useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { redraw, useTipOpen } from "./store.js";

const html = htm.bind(h);
// the game's art (sprites, icons, condition names): the page's own JSON, filled in by the server
export const ART = JSON.parse(document.getElementById("art").textContent);
// game art: [file, x, y, w, h] drawn at scale s
export function sprite(a, s = 1, tip) {
	if (!a) return null;
	const [f, x, y, w, ht] = a, [W, H] = ART.files[f];
	return html`<i class="spr" data-tip=${tip || null} style=${"width:" + w * s + "px;height:" + ht * s + "px;background-image:url(art/" + f + ".png);background-position:-" + x * s + "px -" + y * s + "px;background-size:" + W * s + "px " + H * s + "px"}></i>`;
}
const base = (item) => String(item || "").replace(/\+\d+$/, "");
export const icon = (item, tip, s = 1) => sprite(ART.items[base(item)], s, tip);
// scaled to fit a box of n px: whole-pixel upscale (crisp pixel art), else shrink
const fit = (a, n, tip) => { if (!a) return null; const s = n / Math.max(a[3], a[4]); return sprite(a, s >= 1 ? Math.floor(s) : s, tip); };
export const iconFit = (item, n, tip) => fit(ART.items[base(item)], n, tip);
// a skill's (or condition's) icon by the name a hit reports; burn ticks are the "burned" condition's
export const skIcon = (k, n = 20, tip) => fit(ART.skills[k === "burn" ? "burned" : k], n, tip);
// a character's weapon, else its class's first skill
export const CLASS_SKILL = { ranger: "3shot", priest: "heal", paladin: "selfheal", warrior: "cleave", mage: "burst", rogue: "quickstab", merchant: "mluck" };
export const weaponOf = (p, n) => iconFit(p.gear && p.gear.mainhand, n) || skIcon(CLASS_SKILL[p.type], n);
// a monster frame (or the gravestone) is mostly empty: trimmed to its opaque pixels, measured once in a canvas (none
// until then)
const trimmed = new Map();
function trim(type) {
	const a = ART.monsters[type];
	trimmed.set(type, null);
	if (!a) return;
	const img = new Image();
	img.src = "art/" + a[0] + ".png";
	img.decode().then(() => {
		const c = document.createElement("canvas"), [, x, y, w, ht] = a;
		c.width = w; c.height = ht;
		const g = c.getContext("2d");
		g.drawImage(img, x, y, w, ht, 0, 0, w, ht);
		const d = g.getImageData(0, 0, w, ht).data;
		let x0 = w, y0 = ht, x1 = -1, y1 = -1;
		for (let j = 0; j < ht; j++) for (let i = 0; i < w; i++) if (d[(j * w + i) * 4 + 3] > 16) (x0 = Math.min(x0, i), x1 = Math.max(x1, i), y0 = Math.min(y0, j), y1 = Math.max(y1, j));
		if (x1 < 0) return;
		trimmed.set(type, [a[0], x + x0, y + y0, x1 - x0 + 1, y1 - y0 + 1]);
		artVer++;
		redraw();
	}).catch(() => {});
}
// what a drawing with monsters depends on (they come as they are trimmed)
export let artVer = 0;
// fit into a box of n px: whole-pixel upscale, else shrink
export const mon = (type, n = 26, tip) => { if (!trimmed.has(type)) trim(type); const a = trimmed.get(type); if (!a) return null; const s = n / Math.max(a[3], a[4]); return sprite(a, s >= 1 ? Math.floor(s) : s, tip); };

// the upgrade level as the game writes it (10-12: X Y Z; compounds 5-7: V S R) and its colour
const LV = { 10: "X", 11: "Y", 12: "Z" }, CLV = { 5: "V", 6: "S", 7: "R" };
export function badge(name, level) {
	if (!level) return null;
	const k = ART.kind[name], c = k === "c";
	const cls = (c ? "c" + Math.min(level, 7) : "u" + Math.min(level, 12)) + ((k === "u" && level > 8) || (c && level > 4) ? " hi" : "");
	return html`<b class=${"lvb " + cls}>${(c && CLV[level]) || LV[level] || level}</b>`;
}
export const SHEET = [["earring1", "helmet", "earring2", "amulet"], ["mainhand", "chest", "offhand", "cape"], ["ring1", "pants", "ring2", "orb"], ["belt", "shoes", "gloves", "elixir"]];
export const SHADE = { earring1: "shade_earring", earring2: "shade_earring", ring1: "shade_ring", ring2: "shade_ring", cape: "shade20_cape", orb: "shade20_orb", elixir: "shade20_elixir" };
export const shadeOf = (slot) => (ART.items[SHADE[slot] || "shade_" + slot] ? html`<span class="shade">${iconFit(SHADE[slot] || "shade_" + slot, 40)}</span>` : null);
// an item in a slot: hovered or focused, the game's tooltip (a click keeps it); a stack's size at the bottom right
export function ItemSlot({ name, level, stat, title, q }) {
	const ref = useRef(null);
	return html`<button type="button" class="gs" ref=${ref} data-item=${name} data-level=${level} data-stat=${stat || ""} aria-expanded=${useTipOpen(ref)} aria-label=${title}>
		${iconFit(name, 40) || name.slice(0, 4)}${badge(name, level)}${q > 1 ? html`<b class="qb">${q}</b>` : null}</button>`;
}
export function Sheet({ p }) {
	return html`<div class="sheet">${SHEET.flat().map((slot) => {
		const it = p.gear && p.gear[slot];
		if (!it) return html`<span class="gs">${shadeOf(slot)}</span>`;
		const m = /^(.*)\+(\d+)$/.exec(it) || [it, it, "0"], name = m[1], level = Number(m[2]), stat = p.gear_stat && p.gear_stat[slot];
		return html`<${ItemSlot} name=${name} level=${level} stat=${stat} title=${slot + ": " + name + " +" + level + (stat ? ", " + stat + " scroll" : "")} />`;
	})}</div>`;
}
// the character's items as in the game's inventory
export const Inventory = ({ items }) => html`<div class="inv">${items.map((it) => !it || !it.name ? html`<span class="gs"></span>`
	: html`<${ItemSlot} name=${it.name} level=${Number(it.level) || 0} stat=${it.stat_type} q=${it.q} title=${it.name + (it.level ? " +" + it.level : "") + (it.q > 1 ? " x" + it.q : "") + (it.stat_type ? ", " + it.stat_type + " scroll" : "") + (it.l ? ", locked" : "") + (it.p ? ", " + it.p : "")} />`)}</div>`;

// ---- conditions: a key's name, subtitle and icon (the game's name, else the producers' pseudo keys'); buff, debuff or
// other (as the producer wrote it, v2.2, else the game's flags, ART.cflag, else these lists: the game's flags plus the
// pseudo keys)
export const PSEUDO = { citizen0aura: ["Kane's aura", "luck +200", (v, n = 22) => mon("Kane", n) || iconFit("citizens", n)], citizen4aura: ["Angel's aura", "gold +200", (v, n = 22) => mon("Angel", n) || iconFit("citizens", n)],
	party: ["Party", "xp, luck, gold", (v, n = 22) => iconFit("citizens", n)], elixir: ["Elixir", "", (v, n = 20) => iconFit(v, n)], booster: ["Booster", "", (v, n = 20) => iconFit(v, n)], fear: ["Fear", "attack and speed down", (v, n = 22) => iconFit("condition_bad", n)],
	encouragement_lonewolf: ["Lone Wolf", "x3 xp, gold, luck", (v, n = 20) => skIcon("encouragement_lonewolf", n) || iconFit("encouragement_lonewolf", n)] };
const BUFF = /^(citizen\d+aura|encouragement_\w+|party|elixir|booster|newcomersblessing|mluck|paladin_aura_\w+|mshield|aether_shield|warcry|darkblessing|rspeed|mlifesteal|patronsgrace|holidayspirit|easterluck|halloween\d|power|xpower|energized|mcourage|mfrenzy|hardshell|reflection|guardians_oath|purifier|massproduction\w*|massexchange\w*|sugarrush|rimeshell|fullguardx?|sanguine|invis)$/;
const DEBUFF = /^(fear|realmfatigue|poisoned|cursed|burned|slowness|stunned|frozen|deepfreezed|marked|dampened|weakness|tangled|shocked|woven|eburn|penalty_cd|notverified|authfail|hopsickness|stoned|charmed|sleeping|rimeexposed|withdrawal|xshotted)$/;
export function kindOf(w, k) {
	for (const p of w.players) { const c = p.conditions && p.conditions[k]; if (c && c.kind) return c.kind; }
	const f = ART.cflag && ART.cflag[k];
	return f === "b" ? "buff" : f === "d" ? "debuff" : BUFF.test(k) ? "buff" : DEBUFF.test(k) ? "debuff" : "other";
}
export const condName = (k) => ART.cnames[k] || (PSEUDO[k] && PSEUDO[k][0]) || k.replace(/_/g, " ");
// a condition's icon: the producers' pseudo keys', else the game's skill or item art
export const condIcon = (k, v, w, n = 20) => (PSEUDO[k] ? PSEUDO[k][2](v, n) : null) || skIcon(k, n) || iconFit(k, n) || iconFit(w && kindOf(w, k) === "debuff" ? "condition_bad" : "condition_good", n);
// a condition as a button (its game tooltip on hover, kept on a click)
export function Cond({ k, v, cls, label, children }) {
	const ref = useRef(null);
	return html`<button type="button" class=${"cond" + (cls ? " " + cls : "")} ref=${ref} data-cond=${k} data-v=${v ?? ""} aria-label=${label || null} aria-expanded=${useTipOpen(ref)}>${children}</button>`;
}

// ---- the dashboard's own icons
export const BOLT = () => html`<svg class="bolt" viewBox="0 0 10 14" aria-hidden="true"><path d="M6 0L0 8h4l-1 6 7-9H6z" fill="currentColor" /></svg>`;
export const FF = () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1 3l7 5-7 5zM8 3l7 5-7 5z" fill="currentColor" /></svg>`;
export const STOP = () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" /></svg>`;
export const AGAIN = () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2a6 6 0 1 0 6 6h-2a4 4 0 1 1-1.2-2.8L8.6 7.4H14V2l-1.8 1.8A6 6 0 0 0 8 2z" fill="currentColor" /></svg>`;
export const PLAY = () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.5v11l9.5-5.5z" fill="currentColor" /></svg>`;
export const GRPI = () => html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="2" width="9" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.6" /><rect x="2" y="6" width="9" height="8" rx="1.5" fill="currentColor" /></svg>`;
export const CODEI = () => html`<svg class="cdi" viewBox="0 0 16 16" aria-label="CODE"><path d="M5.5 3.5L1.5 8l4 4.5M10.5 3.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
