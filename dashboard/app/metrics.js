// What the pages show of runs, worked out from their snapshots (no drawing): each character's totals and the party's,
// the metrics (the Runs table's columns, the headline tiles, Compare's rows), the Recount meters' breakdowns, the
// grid's and history's rows over time, groups of runs, a run's short label, the settings runs differ in.
import { H, fmtN, fmtG, fmtSpan, parseSpan, pct, num, clamp01, tot, ratio, jp, seedOf, wageOf, codeOf, membersOf, agg, api, load, save } from "./lib.js";
import { S, grids, setupOf, redraw, onPoll } from "./store.js";
import { ART, icon, iconFit, skIcon, mon, weaponOf, FF } from "./art.js";

// ---- one character's totals over the measured part. Raw everywhere: every amount is what the server reported
// (overkill and overheal included); overkill and overheal are their own numbers.
// gold flows: in (>= 0) chest (a chest's own gold), egold (the monster's), enc (encouragement receipts), sold, stand,
// received, other; out (>= 0) bought (NPCs, bank packs), traded (stands, buy orders), craft, sent, other_out; banked =
// deposits - withdrawals
export const GOLD_IN = ["chest", "egold", "enc", "sold", "stand", "received", "other"];
const flows = (g) => (g && typeof g === "object" ? g : null);
// gold now minus at the base, less what the named flows explain (0 when the ledger closes); null without gold_start
export const residual = (p, f) => (f && Number.isFinite(p.gold_start) && Number.isFinite(p.gold) ? p.gold - p.gold_start - GOLD_IN.reduce((a, k) => a + num(f[k]), 0) + ["bought", "traded", "craft", "sent", "other_out", "banked"].reduce((a, k) => a + num(f[k]), 0) : null);
// potions drunk since the base: items.consumed
export const potsOf = (p) => Object.fromEntries(Object.entries((p.items && p.items.consumed) || {}).filter(([k, v]) => /pot/.test(k) && Number.isFinite(v)));
const rawOf = (o) => (o && typeof o === "object" && Number.isFinite(o.raw) ? o.raw : null);
function cstat(p) {
	const d = p.dmg, hl = p.heal, g = flows(p.gold_flow), dn = d && d.done, hd = hl && hl.done;
	const overkill = d && Number.isFinite(d.overkill) ? d.overkill : null;
	const overheal = hd && hl.overheal != null ? hl.overheal : null, ohBase = rawOf(hd);
	const sk = d && d.by_skill ? Object.values(d.by_skill).filter((e) => e && typeof e === "object") : [];
	return { p, name: p.name, type: p.type, xp: p.xp_gained || 0, kills: p.kills || 0, credits: p.credits ?? null, deaths: p.deaths || 0, hp: p.hpots || 0, mp: p.mpots || 0,
		dmg: rawOf(dn), overkill, taken: d ? rawOf(d.taken) : null, heal: rawOf(hd), overheal, ohBase, recv: hl ? rawOf(hl.received) : null,
		hits: sk.reduce((a, e) => a + num(e.hits), 0), crits: sk.reduce((a, e) => a + num(e.crits), 0), misses: sk.reduce((a, e) => a + num(e.misses), 0), trips: p.trips || 0,
		mana: p.mana ? p.mana.spent ?? null : null, combat: p.combat_ms != null ? p.combat_ms / 1000 : null, income: g ? num(g.chest) + num(g.egold) + num(g.enc) + num(g.sold) + num(g.stand) : null, spent: g ? num(g.bought) + num(g.traded) + num(g.craft) : null, g };
}
// supply handovers to each character (a finished trip with something or gold sent to it): per_fighter.deliveries
function delivered(w) {
	const pf = w.merchant && w.merchant.per_fighter;
	if (!pf || typeof pf !== "object") return null;
	const out = {};
	for (const [f, x] of Object.entries(pf)) out[f] = (x && x.deliveries) || 0;
	return out;
}
// per run (kept while its snapshot is, store.js): its characters' totals, the party's (everyone's sums), a rate helper,
// the merchant (supply), deliveries per character, potions drunk by item; caches per snapshot (metrics)
const STATS = new WeakMap();
export function statsOf(w) {
	let s = STATS.get(w);
	if (s) return s;
	const hrs = (w.measured_ms || 0) / H, P = membersOf(w).map(cstat), mp = w.players.find((p) => p.type === "merchant");
	s = { hrs, secs: hrs * 3600, per: (v, d = hrs) => (v != null && d > 0 ? v / d : null), P, M: P.find((c) => c.p === mp) || null, party: {}, dv: delivered(w), pots: {} };
	// (the party's sums leave out an account out of the totals: a market account's characters)
	const In = P.filter((c) => !c.p.outside);
	for (const k of ["xp", "kills", "credits", "deaths", "hp", "mp", "dmg", "overkill", "taken", "heal", "overheal", "recv", "mana", "combat", "income", "spent"]) s.party[k] = tot(In, (c) => c[k]);
	for (const c of P) for (const [k, n] of Object.entries(potsOf(c.p))) s.pots[k] = (s.pots[k] || 0) + n;
	STATS.set(w, s);
	return s;
}
export const lwOf = (p, w) => { const c = p.conditions && p.conditions.encouragement_lonewolf, m = w.measured_ms || 0; return c && Number.isFinite(c.ms) && m > 0 ? clamp01(c.ms / m) : p.buffs && Number.isFinite(p.buffs.lonewolf) ? p.buffs.lonewolf : null; };
const topKill = (w) => w.kills && Object.entries(w.kills.by_type || {}).sort((a, b) => b[1] - a[1])[0];
const most = (pots, re, def) => (Object.entries(pots || {}).filter(([k]) => re.test(k)).sort((a, b) => b[1] - a[1])[0] || [def])[0];
// the characters that gained xp or fought: a mean of per-character shares over them (one in town all the run would drag it to 0)
export const activeOf = (s) => s.P.filter((c) => c.xp > 0 || c.dmg > 0);

// ---- The metrics. of(c, w, s): one character's amount (a total; a share for "share" metrics; null: not measured);
// party(w, s): the run's value when it isn't the sum of of() (always for shares: a ratio of sums, never a mean of
// ratios); "rate_h" per game hour, "rate_s" per game second. hcol: the history column(s) of its value over time
// (cumulative; "a+b" adds): a running run's "now". better: 1 more is better, -1 less, 0 neither (no rank). Adding a
// metric is one entry here.
export const REG = [
	{ id: "xph", label: "XP/h", hu: "xp/h", g: "Progress", ic: () => icon("xpbooster"), k: "rate_h", of: (c) => c.xp, hcol: "xp", better: 1, what: "xp per game hour" },
	{ id: "xp", label: "XP gained", hu: "xp", g: "Progress", ic: () => icon("xpbooster"), k: "total", of: (c) => c.xp, hcol: "xp", better: 1, what: "xp gained" },
	{ id: "lvls", label: "Levels gained", hu: "levels", g: "Progress", ic: () => icon("stats"), k: "count", of: (c) => (Number.isFinite(c.p.start_level) ? c.p.level - c.p.start_level : null), better: 1, d: 0, what: "levels gained" },
	{ id: "killsh", label: "Kills/h", hu: "kills/h", g: "Progress", ic: (w) => { const k = w && topKill(w); return (k && mon(k[0], 22)) || icon("quest_monsterhunt"); }, k: "rate_h", of: (c) => c.kills, hcol: "kills", better: 1, what: "kills (last hits) per game hour" },
	{ id: "dps", label: "DPS", hu: "DPS", g: "Combat", ic: () => skIcon("attack"), k: "rate_s", of: (c) => c.dmg, hcol: "dmg_raw", better: 1, what: "damage per game second, raw (overkill included)" },
	{ id: "dmg", label: "Damage", hu: "dmg", g: "Combat", ic: () => skIcon("attack"), k: "total", of: (c) => c.dmg, hcol: "dmg_raw", better: 1, what: "damage done, raw (overkill included)" },
	{ id: "overkill", label: "Overkill", hu: "overkill", g: "Combat", ic: () => skIcon("burst"), k: "share", of: (c) => (c.overkill != null && c.dmg > 0 ? c.overkill / c.dmg : null), party: (w, s) => ratio(s.P.filter((c) => c.overkill != null), (c) => c.overkill, (c) => c.dmg), better: -1, what: "share of the damage past the monster's remaining hp" },
	{ id: "hps", label: "HPS", hu: "HPS", g: "Combat", ic: () => skIcon("heal"), k: "rate_s", of: (c) => c.heal, hcol: "heal_raw", better: 1, what: "healing per game second, raw (overheal included)" },
	{ id: "heal", label: "Healing", hu: "heal", g: "Combat", ic: () => skIcon("heal"), k: "total", of: (c) => c.heal, hcol: "heal_raw", better: 1, what: "healing done, raw (overheal included)" },
	{ id: "overheal", label: "Overheal", hu: "overheal", g: "Combat", ic: () => skIcon("selfheal"), k: "share", of: (c) => (c.overheal != null && c.ohBase > 0 ? c.overheal / c.ohBase : null), party: (w, s) => ratio(s.P.filter((c) => c.overheal != null), (c) => c.overheal, (c) => c.ohBase), better: -1, what: "share of the healing past full hp" },
	{ id: "crit", label: "Crits", hu: "crits", g: "Combat", ic: () => skIcon("3shot"), k: "share", of: (c) => (c.hits > 0 ? c.crits / c.hits : null), party: (w, s) => ratio(s.P, (c) => c.crits, (c) => c.hits), better: 1, what: "critical hits per hit" },
	{ id: "miss", label: "Misses", hu: "misses", g: "Combat", ic: () => icon("condition_bad"), k: "share", of: (c) => (c.hits + c.misses > 0 ? c.misses / (c.hits + c.misses) : null), party: (w, s) => ratio(s.P, (c) => c.misses, (c) => c.hits + c.misses), better: -1, what: "missed attacks per attack" },
	{ id: "combat", label: "In combat", hu: "in combat", g: "Combat", ic: () => skIcon("attack"), k: "share", of: (c, w, s) => (c.combat != null && s.secs > 0 ? clamp01(c.combat / s.secs) : null), party: (w, s) => { const xs = s.P.filter((c) => c.combat > 0); return xs.length && s.secs > 0 ? clamp01(tot(xs, (c) => c.combat) / (s.secs * xs.length)) : null; }, better: 0, what: "share of the time with a hit dealt or taken within 3 s (over the characters that fought)" },
	{ id: "dtps", label: "Taken/s", hu: "taken/s", g: "Survival", ic: () => icon("condition_bad"), k: "rate_s", of: (c) => c.taken, hcol: "taken_raw", better: -1, what: "damage taken per game second, raw" },
	{ id: "recvps", label: "Healed/s", hu: "healed/s", g: "Survival", ic: () => icon("condition_good"), k: "rate_s", of: (c) => c.recv, better: 0, what: "healing received per game second: heals, lifesteal, potions, regen" },
	{ id: "deaths", label: "Deaths", hu: "deaths", g: "Survival", ic: () => mon("gravestone", 20) || icon("condition_bad"), k: "count", of: (c) => c.deaths, hcol: "deaths", better: -1, d: 0, what: "deaths" },
	{ id: "deathsh", label: "Deaths/h", hu: "deaths/h", g: "Survival", ic: () => mon("gravestone", 20) || icon("condition_bad"), k: "rate_h", of: (c) => c.deaths, hcol: "deaths", better: -1, d: 2, what: "deaths per game hour" },
	{ id: "potsh", label: "Potions/h", hu: "pots/h", g: "Survival", ic: () => icon("hpot1"), k: "rate_h", of: (c) => c.hp + c.mp, hcol: "hpots+mpots", better: -1, what: "potions drunk per game hour" },
	{ id: "hpotsh", label: "HP pots/h", hu: "HP pots/h", g: "Survival", ic: (w) => icon(w ? most(statsOf(w).pots, /^hpot/, "hpot0") : "hpot0"), k: "rate_h", of: (c) => c.hp, hcol: "hpots", better: -1, what: "HP potions drunk per game hour" },
	{ id: "mpotsh", label: "MP pots/h", hu: "MP pots/h", g: "Survival", ic: (w) => icon(w ? most(statsOf(w).pots, /^mpot/, "mpot0") : "mpot0"), k: "rate_h", of: (c) => c.mp, hcol: "mpots", better: -1, what: "MP potions drunk per game hour" },
	{ id: "manas", label: "Mana/s", hu: "mp/s", g: "Survival", ic: () => skIcon("use_mp"), k: "rate_s", of: (c) => c.mana, better: 0, what: "mana spent per game second" },
	{ id: "incomeh", label: "Income/h", hu: "gold/h", g: "Economy", ic: () => icon("gold"), k: "rate_h", of: (c) => c.income, hcol: "income", better: 1, what: "gold income per game hour: loot, NPC and stand sales" },
	{ id: "goldh", label: "Net gold/h", hu: "net gold/h", g: "Economy", ic: () => icon("gold"), k: "rate_h", of: (c) => (Number.isFinite(c.p.gold_start) && Number.isFinite(c.p.gold) ? c.p.gold - c.p.gold_start : null), party: (w, s) => (Number.isFinite(w.gold.now) && Number.isFinite(w.gold.start) ? s.per(w.gold.now - w.gold.start) : null), better: 1, what: "the account's gold (every character's plus the bank) now vs at the start, per game hour" },
	{ id: "spenth", label: "Spent/h", hu: "spent/h", g: "Economy", ic: () => icon("gold"), k: "rate_h", of: (c) => c.spent, better: -1, what: "gold spent per game hour: NPC buys and crafting" },
	{ id: "looth", label: "Items looted/h", hu: "items/h", g: "Economy", ic: () => icon("inventory"), k: "rate_h", of: (c) => (c.p.items && c.p.items.looted ? Object.values(c.p.items.looted).reduce((a, v) => a + num(v), 0) : null), better: 1, what: "items looted per game hour" },
	{ id: "chestsh", label: "Chests/h", hu: "chests/h", g: "Economy", ic: () => icon("gold"), k: "rate_h", of: (c) => (c.p.chests ? num(c.p.chests.opened) : null), better: 1, what: "chests opened per game hour" },
	{ id: "tripsh", label: "Supply trips/h", hu: "trips/h", g: "Supply", ic: () => icon("travel"), k: "rate_h", of: (c, w) => (w.trips_available === false ? null : c.trips), hcol: "trips", better: 1, what: "supply trips per game hour (out of town, met a character, back)" },
	{ id: "delivh", label: "Deliveries/h", hu: "deliveries/h", g: "Supply", ic: () => icon("inventory"), k: "rate_h", of: (c, w, s) => (s.dv ? (c === s.M ? Object.values(s.dv).reduce((a, n) => a + num(n), 0) : 0) : null), better: 1, what: "supply handovers per game hour: a trip that handed a character something or gold" },
	{ id: "lonewolf", label: "Lone Wolf", hu: "Lone Wolf", g: "Buffs", ic: () => icon("encouragement_lonewolf"), k: "share", of: (c, w) => lwOf(c.p, w), party: (w, s) => { const xs = activeOf(s).map((c) => lwOf(c.p, w)).filter((v) => v != null); return xs.length ? xs.reduce((a, v) => a + v, 0) / xs.length : null; }, better: 0, what: "share of the time with Lone Wolf (x3 xp, gold and luck), the mean over the characters that gained xp or fought" },
	{ id: "inparty", label: "In party", hu: "in party", g: "Buffs", ic: () => icon("citizens"), k: "share", of: (c, w) => (c.p.party && Number.isFinite(c.p.party.ms) && w.measured_ms > 0 ? clamp01(c.p.party.ms / w.measured_ms) : null), party: (w) => (w.party && Number.isFinite(w.party.party_ms) && w.measured_ms > 0 ? clamp01(w.party.party_ms / w.measured_ms) : null), better: 0, what: "share of the time the run's party was together in one server party" },
	{ id: "errors", label: "CODE errors", hu: "errors", g: "Run", ic: () => icon("condition_bad"), k: "count", of: (c) => (c.p.log_n ? c.p.log_n.errors : null), better: -1, d: 0, what: "CODE errors in the game log: uncaught errors, the game's code_error lines (since the start)" },
	{ id: "speed", label: "Sim speed", hu: "x", g: "Run", ic: () => FF(), k: "count", party: (w) => (Number.isFinite(w.speed.avg) ? w.speed.avg : null), better: 1, d: 0, what: "average speed: game time per real time" },
	{ id: "hours", label: "Game time", hu: "", g: "Run", ic: () => icon("stats"), k: "total", party: (w) => (w.measured_ms || 0) / H, fmt: (v) => fmtG(v * H), better: 0, what: "measured game time" },
];
export const MET = Object.fromEntries(REG.map((m) => [m.id, m]));
export const isRate = (m) => m.k === "rate_h" || m.k === "rate_s";
// a metric's value for a run: the party's, and each character's (a Map by name)
export function mval(m, w) {
	const s = statsOf(w), key = "m:" + m.id;
	if (s[key]) return s[key];
	const conv = (v) => (v == null || !isFinite(v) ? null : m.k === "rate_h" ? s.per(v) : m.k === "rate_s" ? s.per(v, s.secs) : v), by = new Map();
	let sum = null;
	if (m.of) for (const c of s.P) { const v = m.of(c, w, s); by.set(c.name, conv(v)); if (v != null && isFinite(v)) sum = (sum || 0) + v; }
	const party = m.party ? m.party(w, s) : conv(sum);
	return (s[key] = { party: party != null && isFinite(party) ? party : null, by });
}
export const fmtM = (m, v) => (v == null || !isFinite(v) ? "-" : m.k === "share" ? (v > 0 && v < 0.1 ? (100 * v).toFixed(1) + "%" : pct(v)) : m.fmt ? m.fmt(v) : fmtN(v, m.d ?? 1));
export const fmtMS = (m, a) => (!a || !a.n ? "-" : fmtM(m, a.mean) + (a.sd != null ? " ± " + fmtM(m, a.sd) : ""));
export const cunit = (m) => (m.id === "speed" ? "x" : m.k === "rate_h" ? "/h" : m.k === "rate_s" ? "/s" : "");
export const aggOf = (m, s) => agg(s.runs.map((w) => mval(m, w).party));

// ---- the metrics shown (Columns, Metrics): the headline (the rank's), up to 6 more; saved on the dashboard
// (api/settings), cached in this browser. CARDS.v: changed by a redraw's (what a drawing of them depends on)
const DEF_CARDS = { hero: "xph", chips: ["dps", "hps", "dtps", "hpotsh", "mpotsh", "killsh"] };
const normCards = (c) => ({ hero: c && MET[c.hero] ? c.hero : "xph", chips: [...new Set(((c && c.chips) || []).filter((id) => MET[id]))].slice(0, 6) });
export const CARDS = { ...normCards(load("dash_cards", null, JSON.parse) || DEF_CARDS), v: 0, note: "" };
export const heroM = () => MET[CARDS.hero] || MET.xph;
// the headline tiles' metrics: the headline's, deaths, the chips'
export const kpiMs = () => { const hm = heroM(); return [hm, ...(hm.id === "deaths" || hm.id === "deathsh" ? [] : [MET.deaths]), ...REG.filter((m) => CARDS.chips.includes(m.id) && m !== hm && m.id !== "deaths")]; };
// the Data tab's panels in columns (cols, 1-4): a metric each, shown as meters, its breakdown (by: by what) or over
// time, in its column (col; the list's order within it); saved with the cards
export const VIEWS = [["meters", "Meters"], ["by", "Breakdown"], ["time", "Over time"]];
export const MAXCOLS = 4;
const DEF_DATA = { cols: 1, panels: [{ id: "p1", m: "dps", view: "meters", col: 0 }, { id: "p2", m: "xph", view: "time", col: 0 }, { id: "p3", m: "dmg", view: "by", by: "skill", col: 0 }, { id: "p4", m: "dtps", view: "time", col: 0 }] };
const normData = (d) => {
	if (!d || typeof d !== "object" || !Array.isArray(d.panels)) return null;
	const cols = Number.isInteger(d.cols) ? Math.min(MAXCOLS, Math.max(1, d.cols)) : 1, ids = new Set(), out = [];
	for (const p of d.panels) if (p && typeof p.id === "string" && /^[a-z0-9]{1,12}$/.test(p.id) && !ids.has(p.id) && DATA.some((x) => x.id === p.m) && VIEWS.some(([v]) => v === p.view) && out.length < 12)
		(ids.add(p.id), out.push({ id: p.id, m: p.m, view: p.view, ...(typeof p.by === "string" && /^[a-z]{1,16}$/.test(p.by) ? { by: p.by } : {}), col: Number.isInteger(p.col) ? Math.min(cols - 1, Math.max(0, p.col)) : 0 }));
	return { cols, panels: out };
};
export const PANELS = { cols: DEF_DATA.cols, list: DEF_DATA.panels, v: 0 }; // (this browser's: once DATA is, below)
const dataNow = () => ({ cols: PANELS.cols, panels: PANELS.list });
let cfgRev = null, cfgTimer = null, cfgDirty = false, cfgAt = 0;
// (each poll, every 5 s: another page's change; nothing stored on the dashboard yet, rev 0: this browser's choice stays)
onPoll(async () => {
	if (Date.now() - cfgAt < 5000) return;
	cfgAt = Date.now();
	try {
		const r = await fetch("api/settings");
		if (!r.ok) return;
		const o = await r.json();
		if (o.rev !== cfgRev && !cfgDirty) {
			cfgRev = o.rev;
			if (o.cards && o.rev) { const c = normCards(o.cards); if (c.hero !== CARDS.hero || c.chips.join() !== CARDS.chips.join()) (Object.assign(CARDS, c), CARDS.v++, save("dash_cards", JSON.stringify(c))); }
			const d = o.rev ? normData(o.data) : null;
			if (d && JSON.stringify(d) !== JSON.stringify(dataNow())) (PANELS.cols = d.cols), (PANELS.list = d.panels), PANELS.v++, save("dash_panels", JSON.stringify(d)), redraw();
		}
	} catch (e) {}
});
// a change (every page at once): saved on the dashboard (debounced), else in this browser only
function saveCfg() {
	cfgDirty = true;
	clearTimeout(cfgTimer);
	redraw();
	cfgTimer = setTimeout(async () => {
		try {
			const r = await api("api/settings", "PUT", { v: 1, cards: { hero: CARDS.hero, chips: CARDS.chips }, data: dataNow() }), o = await r.json().catch(() => ({}));
			if (r.ok) (cfgRev = o.rev ?? cfgRev), (CARDS.note = "Saved for this dashboard");
			else CARDS.note = "Saved in this browser only (the dashboard answered " + r.status + ")";
		} catch (e) { CARDS.note = "Saved in this browser only (" + e.message + ")"; }
		cfgDirty = false;
		redraw();
	}, 300);
}
export function setCards(c) {
	Object.assign(CARDS, normCards(c));
	CARDS.v++;
	save("dash_cards", JSON.stringify({ hero: CARDS.hero, chips: CARDS.chips }));
	saveCfg();
}
// the panels (and the columns: fewer, the panels of the ones gone in the last one)
export function setPanels(list, cols = PANELS.cols) {
	const d = normData({ cols, panels: list }) || DEF_DATA;
	PANELS.cols = d.cols;
	PANELS.list = d.panels;
	PANELS.v++;
	save("dash_panels", JSON.stringify(d));
	saveCfg();
}
export const resetPanels = () => setPanels(DEF_DATA.panels, DEF_DATA.cols);
export const resetCards = () => setCards(DEF_CARDS);
// rank by the headline's metric (in its better direction; none when neither is better); equal values share a rank
const RANKS = new WeakMap();
export function ranksOf(data) {
	const hm = heroM(), c = RANKS.get(data);
	if (c && c.hm === hm) return c;
	const V = new Map(data.map((w) => [w.id, mval(hm, w).party])), rank = new Map();
	const ranked = hm.better ? data.filter((w) => V.get(w.id) != null).sort((a, b) => hm.better * (V.get(b.id) - V.get(a.id)) || Date.parse(b.started) - Date.parse(a.started)) : [];
	ranked.forEach((w, i) => rank.set(w.id, i && V.get(w.id) === V.get(ranked[i - 1].id) ? rank.get(ranked[i - 1].id) : i + 1));
	const out = { hm, V, rank };
	RANKS.set(data, out);
	return out;
}

// ---- over time: the characters' history rows (one per snapshot write), the rolling window, rates
// the rolling window: ~1/30 of the run, never under 2 min nor under 2 row steps (game s)
const WINS = [120, 300, 600, 900, 1200, 1800, 3600, 7200];
export const autoWin = (T, step) => WINS.find((x) => x >= Math.max(T / 30, 2 * (step || 0), 120)) || 7200;
// per unit s of cumulative values v at times t over the trailing window, aligned to t: the average since the first row
// until the window is full, then over the window (v interpolated at its start); the first row takes the second's value
export function rateAt(t, v, win, unit) {
	const out = new Array(t.length).fill(null), I = [];
	for (let i = 0; i < t.length; i++) if (v[i] != null) I.push(i);
	for (let n = 1, j = 0; n < I.length; n++) {
		const i = I[n], a = t[i] - win, i0 = I[0];
		if (a <= t[i0]) { if (t[i] > t[i0]) out[i] = ((v[i] - v[i0]) / (t[i] - t[i0])) * unit; continue; }
		while (j + 1 < n && t[I[j + 1]] <= a) j++;
		const p = I[j], q = I[j + 1], va = v[p] + ((v[q] - v[p]) * (a - t[p])) / (t[q] - t[p]);
		out[i] = ((v[i] - va) / win) * unit;
	}
	if (I.length > 1) out[I[0]] = out[I[1]];
	return out;
}
// the sum of several columns per row (null where one is missing)
export const sumCols = (vs) => { const xs = vs.filter(Boolean); return xs.length ? xs[0].map((_, i) => (xs.every((v) => v[i] != null) ? xs.reduce((a, v) => a + v[i], 0) : null)) : null; };
// a running run's rate metric now: the party's over the last window of its history rows ({ now, win }), else null
export function nowOf(w, m) {
	const s = statsOf(w), key = "n:" + m.id;
	if (key in s) return s[key];
	const hs = w.players.filter((p) => Array.isArray(p.history) && p.history.length), names = m.hcol ? m.hcol.split("+") : null, cols = w.history_cols || [];
	if (!hs.length || !names || !names.every((n) => cols.includes(n))) return (s[key] = null);
	const cnt = new Map();
	for (const p of hs) for (const r of new Set(p.history.map((r) => r[0]))) cnt.set(r, (cnt.get(r) || 0) + 1);
	const t = [...cnt].filter(([x, n]) => n === hs.length && Number.isFinite(x)).map(([x]) => x).sort((a, b) => a - b);
	if (t.length < 2) return (s[key] = null);
	const rows = new Map(hs.map((p) => [p.name, new Map(p.history.map((r) => [r[0], r]))]));
	const by = (name, c) => { const i = cols.indexOf(c), x = rows.get(name); return t.map((y) => { const r = x.get(y); return r && Number.isFinite(r[i]) ? r[i] : null; }); };
	const d = t.slice(1).map((x, i) => x - t[i]).sort((a, b) => a - b), T = Math.max(t[t.length - 1], (w.measured_ms || 0) / 1000);
	const win = autoWin(T, d.length ? d[d.length >> 1] : 0), v = sumCols(hs.map((p) => sumCols(names.map((c) => by(p.name, c)))));
	const r = v ? rateAt(t, v, win, m.k === "rate_h" ? 3600 : 1).filter((x) => x != null) : [];
	return (s[key] = r.length ? { now: r[r.length - 1], win } : null);
}
// the rows as { src, t: [game s], step, col(name, column) -> values per row (null: not there), or null; cAt(name) ->
// the grid's cumulative ms on per condition per row, or null }: the run's grid, else its history rows (coarser, fewer
// columns)
export function timeData(w) {
	const g = grids.get(w.id);
	if (g && g.cols && g.rows.length >= 2) {
		const ix = new Map(g.cols.map((c, i) => [c, i])), hasC = g.rows.some((r) => r.c);
		return { src: "grid", t: g.rows.map((r) => r.t), step: (g.step || 30000) / 1000, col: (name, c) => {
			const i = ix.get(c);
			if (i == null) return null;
			const v = g.rows.map((r) => { const x = r.r[name]; return Array.isArray(x) && Number.isFinite(x[i]) ? x[i] : null; });
			return v.some((x) => x != null) ? v : null;
		}, cAt: hasC ? (name) => g.rows.map((r) => (r.c && r.c[name]) || (r.c ? {} : null)) : null };
	}
	const hs = w.players.filter((p) => Array.isArray(p.history) && p.history.length > 1);
	if (!hs.length) return null;
	const ts = [...new Set(hs.flatMap((p) => p.history.map((r) => r[0])))].filter(Number.isFinite).sort((a, b) => a - b), cols = w.history_cols || [];
	const byT = new Map(hs.map((p) => [p.name, new Map(p.history.map((r) => [r[0], r]))])), d = ts.slice(1).map((t, i) => t - ts[i]).sort((a, b) => a - b);
	return { src: "history", t: ts, step: d.length ? d[d.length >> 1] : 0, col: (name, c) => {
		const i = cols.indexOf(c), m = byT.get(name);
		if (i < 1 || !m) return null;
		const v = ts.map((t) => { const r = m.get(t); return r && Number.isFinite(r[i]) ? r[i] : null; });
		return v.some((x) => x != null) ? v : null;
	}, cAt: null };
}
// level + the share of it done, per row: back from the character's level and xp now through the xp it gained since
export function levelOf(D, p) {
	const L = D.col(p.name, "level"), X = D.col(p.name, "xp"), lv = ART.levels || {};
	if (!L) return null;
	return L.map((l, i) => {
		if (l == null || !X || X[i] == null || !Number.isFinite(p.xp) || !Number.isFinite(p.xp_gained) || !lv[l]) return l;
		let a = p.xp - (p.xp_gained - X[i]), k = p.level;
		while (a < 0 && k > l) (k--), (a += lv[k] || 0);
		return k === l && a >= 0 ? l + Math.min(0.999, a / lv[l]) : l;
	});
}
// every death: its time from the deaths list (the last 10) where it has one, else the row that counted it
export function deathsOf(w, D) {
	const out = [], rec = w.deaths && Array.isArray(w.deaths.recent) ? w.deaths.recent.filter((d) => d && Number.isFinite(d.t)) : [];
	for (const p of w.players) {
		const mine = rec.filter((d) => d.name === p.name), used = new Set(), dc = D && D.col(p.name, "deaths");
		const take = (a, b) => { const j = mine.findIndex((d, k) => !used.has(k) && d.t > a - 1 && d.t <= b + 1); if (j >= 0) used.add(j); return j >= 0 ? mine[j] : null; };
		if (dc) for (let i = 1; i < dc.length; i++) for (let k = 0; k < (dc[i] != null && dc[i - 1] != null ? dc[i] - dc[i - 1] : 0); k++) { const e = take(D.t[i - 1], D.t[i]); out.push({ p, t: e ? e.t : D.t[i], by: e && e.by }); }
		mine.forEach((d, k) => used.has(k) || (dc && d.t <= D.t[D.t.length - 1]) || out.push({ p, t: d.t, by: d.by }));
	}
	return out.sort((a, b) => a.t - b.t);
}
// the steering the run applied (the snapshot's steer): { t, i, name, why, at, character, what, note, did, errors }
export const steersOf = (w) => (Array.isArray(w.steer) ? w.steer.filter((s) => s && Number.isFinite(s.t)) : []);
// a character's deaths at a replay's moment v (virtual ms): the grid's (else history's) row at or before it; none before
// the run's start (the warm-up isn't counted); null while the run's grid isn't loaded
// a run's monsters by type: its kills (last hits), the server's other kills (its fighting NPCs), the deaths each caused,
// how many there were and their levels at the base and at the end (world.mlevels: per map, summed: n, avg, max; maps);
// the hunted ones first, then by deaths caused
export function monstersOf(w) {
	const rows = new Map(), row = (t) => rows.get(t) || rows.set(t, { t, kills: 0, others: 0, deaths: 0, maps: new Set(), base: null, end: null }).get(t), k = w.kills || {};
	for (const [t, n] of Object.entries(k.by_type || {})) row(t).kills += num(n);
	for (const [t, n] of Object.entries((k.others && k.others.by_type) || {})) row(t).others += num(n);
	for (const g of (w.deaths && w.deaths.groups) || []) row(g.by || "?").deaths += num(g.n);
	const ml = w.world && w.world.mlevels;
	for (const at of ["base", "end"]) for (const [map, ts] of Object.entries((ml && ml[at]) || {})) for (const [t, v] of Object.entries(ts || {})) {
		if (!v || !Number.isFinite(v.avg) || !(v.n > 0)) continue;
		const r = row(t), x = r[at] || (r[at] = { n: 0, sum: 0, max: -Infinity });
		r.maps.add(map); x.n += v.n; x.sum += v.avg * v.n; x.max = Math.max(x.max, v.max);
	}
	for (const r of rows.values()) for (const at of ["base", "end"]) if (r[at]) r[at].avg = r[at].sum / r[at].n;
	return [...rows.values()].sort((a, b) => b.kills - a.kills || b.deaths - a.deaths || b.others - a.others || a.t.localeCompare(b.t));
}
export function deathsAt(w, name, v, base) {
	const td = timeData(w), col = td && td.col(name, "deaths");
	if (base == null || !col) return null;
	let out = 0;
	td.t.forEach((t, i) => { if (t * 1000 <= v - base && col[i] != null) out = col[i]; });
	return out;
}

// ---- Recount-style meters: per meter a character's value (null: not measured), the second column, its breakdowns
// (by: a character's and the party's, pby: the party's only)
const perS = (c, s, v) => s.per(v, s.secs), perH = (c, s, v) => s.per(v);
export const METERS = [
	{ k: "dmg", f: "dmg", label: "Damage", ic: () => skIcon("attack"), v: (c) => c.dmg, cols: ["total", "per s"], c2: perS, u2: "/s", by: ["skill", "target"], what: "damage done, raw (overkill included)", none: "no damage done in this run" },
	{ k: "dps", f: "dmg", label: "DPS", ic: () => skIcon("supershot"), v: (c, s) => s.per(c.dmg, s.secs), cols: ["per s", "in combat"], c2: (c, s) => (c ? s.per(c.dmg, c.combat) : null), u2: "/s", u: "/s", by: ["skill", "target"], rate: "s", what: "damage per game second, raw (in combat: per second a hit was dealt or taken within 3 s)", none: "no damage done in this run" },
	{ k: "overkill", f: "overkill", label: "Overkill", ic: () => skIcon("burst"), v: (c) => c.overkill, cols: ["total", "of dmg"], c2: (c) => (c && c.dmg > 0 && c.overkill != null ? c.overkill / c.dmg : null), u2: "%", by: ["skill", "target"], what: "overkill: damage past the monster's remaining hp", none: "no overkill in this run" },
	{ k: "taken", f: "taken", label: "Damage taken", ic: () => icon("condition_bad"), v: (c) => c.taken, cols: ["total", "per s"], c2: perS, u2: "/s", by: ["source"], what: "damage taken, raw", none: "no damage taken in this run" },
	{ k: "heal", f: "heal", label: "Healing", ic: () => skIcon("heal"), v: (c) => c.heal, cols: ["total", "per s"], c2: perS, u2: "/s", by: ["skill", "target"], pby: ["healer"], what: "healing done, raw (overheal included)", none: "nobody healed in this run" },
	{ k: "hps", f: "heal", label: "HPS", ic: () => skIcon("partyheal"), v: (c, s) => s.per(c.heal, s.secs), cols: ["per s", "in combat"], c2: (c, s) => (c ? s.per(c.heal, c.combat) : null), u2: "/s", u: "/s", by: ["skill", "target"], pby: ["healer"], rate: "s", what: "healing per game second, raw", none: "nobody healed in this run" },
	{ k: "over", f: "over", label: "Overheal", ic: () => skIcon("selfheal"), v: (c) => c.overheal, cols: ["total", "of heal"], c2: (c) => (c && c.ohBase > 0 && c.overheal != null ? c.overheal / c.ohBase : null), u2: "%", by: ["skill", "target"], pby: ["healer"], what: "overheal: healing past full hp", none: "no overheal in this run" },
	{ k: "recv", f: "recv", label: "Healed", ic: () => icon("condition_good"), v: (c) => c.recv, cols: ["total", "per s"], c2: perS, u2: "/s", by: ["source"], what: "healing received: heals, lifesteal, potions, regen", none: "nothing healed in this run" },
	{ k: "xp", f: "xp", label: "XP", ic: () => icon("xpbooster"), v: (c) => c.xp, cols: ["total", "per h"], c2: perH, u2: "/h", by: [], pby: ["character"], what: "xp gained", none: "no xp gained in this run" },
	{ k: "mana", f: "mana", label: "Mana spent", ic: () => skIcon("use_mp"), v: (c) => c.mana, cols: ["spent", "per s"], c2: perS, u2: "/s", by: ["skill", "source"], what: "mana spent (by skill), gained (by source)", none: "no mana spent in this run" },
	{ k: "kills", f: "kills", label: "Kills", ic: () => icon("quest_monsterhunt"), v: (c) => c.kills, cols: ["last hits", "credits"], c2: (c) => (c ? c.credits : null), u2: "", d: 0, by: [], pby: ["monster"], what: "kills: last hits, and kill credits (every party member gets one per kill)", none: "no kills in this run" },
	{ k: "pots", f: "pots", label: "Potions", ic: () => icon("hpot1"), v: (c) => c.hp + c.mp, d: 0, cols: ["drunk", "per h"], c2: perH, u2: "/h", by: ["item"], what: "potions drunk", none: "no potions drunk in this run" },
	{ k: "gold", f: "gold", label: "Gold", ic: () => icon("gold"), v: (c) => c.income, cols: ["income", "per h"], c2: perH, u2: "/h", by: ["cause"], what: "gold income: loot, NPC and stand sales", none: "no gold income in this run" },
	{ k: "items", f: "items", label: "Items", ic: () => icon("inventory"), what: "items looted, used, bought, sold, sent and received" },
];
const DMG = /^(dmg|overkill)$/, HEAL = /^(heal|over)$/;
// a breakdown's entries over characters cs: { k, v, hits, crits, misses, casts, raw, parts: { name: v } }, biggest
// first; raw amounts (overkill and overheal: raw - net); gold flows out (and deposits) negative
export function drillEntries(w, s, m, cs, by) {
	const per = m.rate === "h" ? s.hrs || 1 : m.rate ? s.secs || 1 : 1, f = m.f;
	if (by === "monster") return w.kills ? Object.entries(w.kills.by_type || {}).filter(([, v]) => Number.isFinite(v) && v).map(([k, v]) => ({ k, v: v / per })).sort((a, b) => b.v - a.v) : [];
	const acc = new Map();
	const put = (k, v, e, who) => { const x = acc.get(k) || acc.set(k, { k, v: 0, hits: 0, crits: 0, misses: 0, casts: 0, raw: 0, parts: {} }).get(k); x.v += v; x.parts[who] = (x.parts[who] || 0) + v; if (e && typeof e === "object") for (const f of ["hits", "crits", "misses", "casts", "raw"]) x[f] += num(e[f]); };
	if (by === "healer" || by === "character") { for (const c of cs) { const v = m.v(c, s); if (v) put(c.name, v, null, c.name); } return [...acc.values()].sort((a, b) => b.v - a.v); }
	for (const c of cs) {
		const p = c.p, d = p.dmg, hl = p.heal;
		const src = DMG.test(f) ? d && (by === "skill" ? d.by_skill : d.by_target) : HEAL.test(f) ? hl && (by === "skill" ? hl.by_skill : hl.by_target) : f === "taken" ? d && d.taken_by : f === "recv" ? hl && hl.received_by
			: f === "pots" ? potsOf(p) : f === "gold" ? c.g : f === "mana" ? p.mana && (by === "skill" ? p.mana.by_skill : p.mana.gained) : null;
		for (const [k, e] of Object.entries(src && typeof src === "object" ? src : {})) {
			if (e == null) continue;
			if (f === "overkill" || f === "over") { if (e.net != null && e.raw != null && e.raw !== e.net) put(k, e.raw - e.net, { hits: e.hits, raw: e.raw }, c.name); }
			else if (f === "pots" || f === "mana") { if (Number.isFinite(e)) put(k, e, null, c.name); }
			else if (f === "gold") { if (Number.isFinite(e) && e) put(k, GOLD_IN.includes(k) ? e : -e, null, c.name); }
			else if (Number.isFinite(e.raw)) put(k, e.raw, e, c.name);
		}
	}
	const es = [...acc.values()].filter((e) => e.v);
	if (m.rate) for (const e of es) { e.v /= per; for (const n in e.parts) e.parts[n] /= per; }
	return es.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
}
// an entry's icon: a character's weapon, a monster, a skill or condition, an item
export function entryIcon(w, k) {
	const p = w.players.find((x) => x.name === k);
	return p ? weaponOf(p, 22) : ART.monsters[k] ? mon(k, 22) : ART.skills[k === "burn" ? "burned" : k] ? skIcon(k, 20) : ART.items[k] ? iconFit(k, 22) : k === "chest" || k === "egold" || k === "enc" ? icon("gold") : k === "regen" ? skIcon("regen_mp") : k === "pots" ? icon("mpot1") : null;
}
// ---- the Data tab's metrics: per family its total and its rate, each named as itself (DPS: damage per second); m: its
// meter (per character, its breakdowns; none: not as meters), g: its column over time (charts.js; none: not over time),
// rate: per 1 s or 3600 s; then Level (over time only) and Items (a table)
const FAMS = [["xp", "XP", "xph", "XP/h", 3600, "xp"], ["dmg", "Damage", "dps", "DPS", 1, "dmg"], ["taken", "Damage taken", "dtps", "Taken/s", 1, "taken"], ["heal", "Healing", "hps", "HPS", 1, "heal"],
	["recv", "Healed", "recvs", "Healed/s", 1, null], ["overkill", "Overkill", "overkills", "Overkill/s", 1, "overkill"], ["over", "Overheal", "overs", "Overheal/s", 1, "overheal"], ["mana", "Mana spent", "manas", "Mana/s", 1, "mana"],
	["kills", "Kills", "killsh", "Kills/h", 3600, "kills"], ["pots", "Potions", "potsh", "Potions/h", 3600, "pots"], ["gold", "Gold", "goldh", "Gold/h", 3600, "gold"], ["loot", "Loot", "looth", "Loot/h", 3600, "loot"]];
// a total meter's rate: per s or per h, the total its second column
const rateM = (m, rate, k, label) => ({ ...m, k, label, v: (c, s) => (rate === 3600 ? s.per(m.v(c, s)) : s.per(m.v(c, s), s.secs)), cols: ["per " + (rate === 3600 ? "h" : "s"), "total"], c2: (c, s) => (c ? m.v(c, s) : null), u2: "", u: rate === 3600 ? "/h" : "/s", d: 1, rate: rate === 3600 ? "h" : "s" });
export const DATA = [];
for (const [f, tl, rk, rl, rate, g] of FAMS) {
	const m = METERS.find((x) => x.k === f), ic = m ? m.ic : () => icon("inventory");
	DATA.push({ id: f, f, label: tl, ic, m: m ? { ...m, label: tl } : null, g, rate: null });
	const rm = METERS.find((x) => x.k === rk);
	DATA.push({ id: rk, f, label: rl, ic, m: rm ? { ...rm, label: rl } : m ? rateM(m, rate, rk, rl) : null, g, rate });
}
DATA.push({ id: "level", f: "level", label: "Level", ic: () => icon("stats"), m: null, g: "level", rate: null }, { id: "items", f: "items", label: "Items", ic: () => icon("inventory"), m: METERS.find((x) => x.k === "items"), g: null, rate: null });
export const dataM = (id) => DATA.find((d) => d.id === id) || DATA[0];
{ const d = normData(load("dash_panels", null, JSON.parse)) || DEF_DATA; PANELS.cols = d.cols; PANELS.list = d.panels; }
// the views a metric has: meters (per character), its breakdown (the party's, by skill, target...), over time
export const viewsOf = (d) => [d.m ? "meters" : null, d.m && [...(d.m.by || []), ...(d.m.pby || [])].some((b) => b !== "character") ? "by" : null, d.g ? "time" : null].filter(Boolean);

// ---- Groups: the runs of one setup (setup_key: the setup with its CODE, world and version; not its seed), planned
// duration, warm-up and until, two or more; their numbers come from the runs that didn't fail, a seed once (a run is
// deterministic per seed and CODE: the newest complete run of each seed)
const gkeyOf = (w) => (w.setup_key ? [w.setup_key, (w.run && w.run.duration_ms) ?? "", (w.run && w.run.warmup_ms) || 0, (w.run && w.run.until) || ""].join("|") : null);
function statRuns(runs) {
	const out = [], bySeed = new Map(), score = (x) => (x.end && x.end.reason === "complete" ? 2 : x.done ? 1 : 0);
	for (const w of runs.filter((x) => x.state !== "failed")) {
		const sd = seedOf(w), o = sd == null ? null : bySeed.get(sd);
		if (sd == null) out.push(w);
		else if (!o || score(w) > score(o) || (score(w) === score(o) && Date.parse(w.started) > Date.parse(o.started))) bySeed.set(sd, w);
	}
	return [...out, ...bySeed.values()];
}
// a group's name: its runs' tag without the seed ("party-stoneworm s2": "party-stoneworm"), the most common one
function gname(runs) {
	const c = new Map();
	for (const w of runs) { const t = String(w.tag || w.id).replace(/ s\d+(?= |$)/g, "").replace(/\s+/g, " ").trim(); c.set(t, (c.get(t) || 0) + 1); }
	return [...c].sort((a, b) => b[1] - a[1])[0][0];
}
const GRS = new WeakMap();
export function groupsOf(data) {
	let out = GRS.get(data);
	if (out) return out;
	const m = new Map(), groups = new Map(), byRun = new Map();
	for (const w of data) { const k = gkeyOf(w); if (k) (m.get(k) || m.set(k, []).get(k)).push(w); }
	for (const [k, runs] of m) {
		if (runs.length < 2) continue;
		const g = { id: "g:" + k, key: k, runs, name: gname(runs), stat: statRuns(runs) };
		groups.set(g.id, g);
		for (const w of runs) byRun.set(w.id, g);
	}
	GRS.set(data, (out = { groups, byRun }));
	return out;
}
// ---- Colours of runs and groups: one per picked run or group, the same on every page, kept while it is picked (the
// categorical palette's slots in order, never cycled; past 8: grey)
const slotOf = new Map();
function slot(id) {
	if (!slotOf.has(id)) { const used = new Set(slotOf.values()); let i = 0; while (used.has(i)) i++; slotOf.set(id, i < 8 ? i : -1 - slotOf.size); }
	return slotOf.get(id);
}
export const scol = (id) => { const i = slot(id); return i >= 0 ? "var(--s" + (i + 1) + ")" : "var(--muted)"; };
export const slotsKeep = (keep) => { for (const k of [...slotOf.keys()]) if (!keep.has(k)) slotOf.delete(k); };
// ---- Series: runs and groups by id ({ id, label, color, runs: the ones its numbers come from, all, group, w }), in
// their order: Compare's first one is the baseline, every change is from it
export function seriesOf(ids) {
	const out = [], GR = groupsOf(S.data);
	for (const id of ids) {
		const g = GR.groups.get(id), w = g ? null : S.data.find((x) => x.id === id);
		if (g) out.push({ id, label: g.name, group: g, runs: g.stat, all: g.runs });
		else if (w) out.push({ id, label: w.tag || w.id, runs: [w], all: [w], w });
	}
	for (const s of out) s.color = scol(s.id);
	return out;
}
export const cmpRuns = (ss) => ss.reduce((a, s) => a + s.runs.length, 0);

// ---- A run's short label: its setup's name without what the tools add (chronal new's variant in [...]; a rerun's tag
// tokens: seed, duration, current CODE, account age, world age, ping, level target, replay; words the user added stay),
// then what sets it apart from the other runs of that name and source: the variant's items and CODE set; the items,
// CODE, sim version, warm-up, world age, a rerun's ping or account age, a replay where it differs from most of them.
// Seed and duration have their columns; the full tag is in the Run tab.
const TOK = /^ (s\d+|\d+(?:\.\d+)?[smhd]|current [0-9a-f]{8}(?:\/[0-9a-f]{8})*|age \d+(?:\.\d+)?d|world \d+(?:\.\d+)?[smhd]|ping \d+(?:\.\d+)?|L\d+|\(\d+(?:\.\d+)?x replay\))(?= |$)/;
export function nameOf(w) {
	// (a tag stops at 80 characters: one that is the start of the setup's name is that name; a word it cut is dropped)
	const tag = String(w.tag || w.id), sn = w.setup && w.setup.name ? String(w.setup.name) : "", pre = sn && (tag.startsWith(sn) || sn.startsWith(tag));
	let name = pre ? sn : tag.split(" ")[0], rest = tag.slice(name.length), m;
	const toks = [];
	while (rest) {
		if ((m = TOK.exec(rest))) (toks.push(m[1]), (rest = rest.slice(m[0].length)));
		else ((m = /^ *\S+/.exec(rest)), (rest = rest.slice(m[0].length)), rest || tag.length < 80 ? (name += m[0]) : 0);
	}
	// chronal new's variant: "<name> [<who> <slot>=<item>[+<level>][:<stat>] | CODE <set>, ...]", all of it or none
	const vs = [], b = /^(.+) \[([^\]]+)\]$/.exec(name);
	if (b && b[2].split(", ").every((p) => ((m = /^CODE (\S+)$/.exec(p)) ? vs.push({ set: m[1] }) : (m = /^(\S{1,12}) ([a-z0-9]+)=(\S+)$/.exec(p)) && vs.push({ who: m[1], slot: m[2], spec: m[3] })))) name = b[1];
	else vs.length = 0;
	return { name, vs, toks };
}
// the tokens that make chips: ping, account age, level target, replay
const TK = [/^ping /, /^age /, /^L\d+$/, /replay\)$/];
// run id -> its label's parts ({ name, vs, toks, gear, code, sim, warm, wage, tk, sets }); CODE hash -> the set name a
// variant gave it
const LBS = new WeakMap();
export let CODESETS = new Map();
export function labelsOf(data) {
	let out = LBS.get(data);
	if (out) return out;
	const fam = new Map(), sets = new Map();
	out = new Map();
	for (const w of [...data].sort((a, b) => (Date.parse(a.started) || 0) - (Date.parse(b.started) || 0))) {
		const L = { ...nameOf(w), gear: [], code: false, sim: null, warm: false, wage: false, tk: [] };
		out.set(w.id, L);
		(fam.get(L.name) || fam.set(L.name, []).get(L.name)).push(w);
		for (const v of L.vs) if (v.set && codeOf(w)) sets.set(codeOf(w), v.set);
	}
	const gearOf = (w, n) => { const r = (w.roster || []).find((x) => x.name === n); return r ? r.gear_hash : undefined; };
	for (const runs of fam.values()) {
		if (runs.length < 2) continue;
		// the value most of them have (a tie: the oldest run's); undefined when they all have it
		const most = (f) => { const c = new Map(); for (const w of runs) c.set(f(w), (c.get(f(w)) || 0) + 1); return c.size > 1 ? [...c].sort((a, b) => b[1] - a[1])[0][0] : undefined; };
		const simOf = (w) => ((w.versions && w.versions.sim) || "") + (w.versions && w.versions.game ? " game " + w.versions.game : ""), msim = most(simOf), mc = most(codeOf), mw = most((w) => (w.run && w.run.warmup_ms) || 0), ma = most(wageOf), tok = (w, re) => out.get(w.id).toks.find((t) => re.test(t)) || "";
		const mt = TK.map((re) => [re, most((w) => tok(w, re))]).filter(([, v]) => v !== undefined);
		const mg = [...new Set(runs.flatMap((w) => (w.roster || []).map((r) => r.name)))].map((n) => [n, most((w) => gearOf(w, n))]).filter(([, x]) => x !== undefined);
		for (const w of runs) {
			const L = out.get(w.id);
			if (mc !== undefined && codeOf(w) !== mc && !L.vs.some((v) => v.set)) L.code = true;
			if (msim !== undefined && simOf(w) !== msim) L.sim = msim;
			if (mw !== undefined && ((w.run && w.run.warmup_ms) || 0) !== mw) L.warm = true;
			if (ma !== undefined && wageOf(w) !== ma) L.wage = true;
			for (const [re, v] of mt) if (tok(w, re) && tok(w, re) !== v) L.tk.push(tok(w, re));
			for (const [n, x] of mg) if (gearOf(w, n) !== undefined && gearOf(w, n) !== x && !L.vs.some((v) => v.who === n)) L.gear.push({ who: n, ref: runs.find((y) => gearOf(y, n) === x) });
		}
	}
	for (const L of out.values()) L.sets = sets;
	CODESETS = sets;
	LBS.set(data, out);
	return out;
}
export const labelOf = (w) => labelsOf(S.data).get(w.id) || { ...nameOf(w), gear: [], tk: [], sets: new Map() };
// an item's spec ("bow+8:dex") as { name, level, stat }
export const itemSpec = (s) => { const m = /^(\w+?)(?:\+(\d+))?(?::([a-z]+))?$/.exec(s); return m && m[1] !== "none" ? { name: m[1], level: +(m[2] || 0), stat: m[3] || "" } : null; };
export const typeOf = (w, n) => { const r = (w.roster || []).find((x) => x.name === n) || membersOf(w).find((p) => p.name === n); return r && r.type; };
export const slotItem = (x) => (x && x.name ? { name: x.name, level: x.level || 0, stat: x.stat_type || "" } : null);
export const sameItem = (a, b) => (a ? a.name + "+" + a.level + ":" + a.stat : "") === (b ? b.name + "+" + b.level + ":" + b.stat : "");
// a custom world's spawns as a line: count x monster at the spot, level, stats, hp, respawn, cleared
export const spawnsText = (sps) => sps.map((x) => (x.count > 1 ? x.count + " x " : "") + x.monster + " at " + x.at + [x.level && "L" + x.level, x.stats && Object.entries(x.stats).map(([k, v]) => k + " " + v).join(", "), x.hp === "endless" && "endless hp", x.respawn && "respawn " + x.respawn, x.clear && "cleared " + x.clear + " px"].filter(Boolean).map((t) => ", " + t).join("")).join("; ");

// ---- A run's (resolved) settings as flat keys: its setup file (not when and how it was resolved, where its CODE came
// from), else what the snapshot says of how it ran; undefined while its setup file loads
export function settingsOf(w) {
	const flat = (o, p, out) => {
		if (o && typeof o === "object" && !Array.isArray(o)) { for (const [k, v] of Object.entries(o)) flat(v, p ? p + "." + k : k, out); if (!Object.keys(o).length) out[p] = "{}"; }
		else if (Array.isArray(o) && o.some((x) => x && typeof x === "object")) o.forEach((x, i) => flat(x, p + "[" + (x && x.name ? x.name : i) + "]", out));
		else out[p] = JSON.stringify(o);
		return out;
	};
	// (a run and world setting its setup file leaves out: the default, as the setup format reads it; api/control)
	const D = S.cst && S.cst.setup_defaults;
	if (w.setup) { const s = setupOf(w); if (s === undefined) return undefined; if (s) { const { resolved, source, ...rest } = s; if (D) (rest.run = { ...D.run, ...rest.run }), (rest.world = { ...D.world, ...rest.world }); return flat(rest, "", {}); } }
	const r = w.run || {};
	return flat({ script: r.script, roster: (w.roster || []).map((c) => ({ name: c.name, type: c.type, level: c.level, role: c.role, code: c.code })), run: { seed: seedOf(w), duration_ms: r.duration_ms, warmup_ms: r.warmup_ms }, world: { age_ms: wageOf(w) }, strategy: w.strategy }, "", {});
}
// the one setting the series differ in (their first runs' setups without the run knobs, names and notes): a sweep;
// null while loading, or when they differ in none or several
export function sweepOf(ss) {
	if (ss.length < 2) return null;
	const sets = ss.map((s) => { const x = settingsOf(s.runs[0] || s.all[0]); return x && Object.fromEntries(Object.entries(x).filter(([k]) => !/^(run\.|name$|strategy$|notes|characters\[[^\]]+\]\.note$)/.test(k))); });
	if (sets.some((x) => !x)) return null;
	const keys = [...new Set(sets.flatMap(Object.keys))].filter((k) => new Set(sets.map((x) => x[k])).size > 1);
	if (keys.length !== 1) return null;
	// (a setting one of them lacks: null, shown "-")
	const vals = sets.map((x) => { const r = x[keys[0]]; if (r === undefined) return null; try { return JSON.parse(r); } catch (e) { return r; } });
	// in order: numbers, game time ("30m", "2h") by its length, else by name
	const ord = (v) => (typeof v === "number" ? v : parseSpan(v) ?? null), n = vals.every((v) => ord(v) != null);
	return { key: keys[0], vals, num: n, x: (v) => (n ? ord(v) : v), txt: (v) => (v == null ? "-" : typeof v === "string" ? v : JSON.stringify(v)) };
}
// ---- What a series changes from the baseline: the settings its first run differs in from the baseline's first run
// (settingsOf without the seed, names and notes; with the sim's version), grouped as a veteran reads them: a character in
// or out, the item in a slot, its CODE, inventory or start; an account's bank; else a setting each
const CHG_SKIP = /^(run\.seed$|name$|strategy$|notes|characters\[[^\]]+\]\.note$)/;
export function setsOf(s) {
	const w = s.runs[0] || s.all[0], x = w && settingsOf(w);
	return x && { ...Object.fromEntries(Object.entries(x).filter(([k]) => !CHG_SKIP.test(k))), sim: JSON.stringify((w.versions && w.versions.sim) || null), chronal: JSON.stringify((w.versions && w.versions.chronal) || null), game: JSON.stringify((w.versions && w.versions.game) || null) };
}
const slotAt = (x, who, sl) => { const b = "characters[" + who + "].state.slots." + sl + ".", n = jp(x[b + "name"]); return n ? { name: n, level: +jp(x[b + "level"]) || 0, stat: jp(x[b + "stat_type"]) || "", p: jp(x[b + "p"]) || "" } : null; };
const atOf = (x, who) => { const b = "characters[" + who + "].at."; return [jp(x[b + "map"]), jp(x[b + "x"]), jp(x[b + "y"])].filter((v) => v != null).join(" "); };
// null while a setup loads
export function changes(a, b) {
	if (!a || !b) return null;
	const out = new Map(), add = (g, o) => out.get(g) || out.set(g, o).get(g), has = (x, who) => x["characters[" + who + "].name"] !== undefined;
	for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
		if (a[k] === b[k]) continue;
		let m = /^characters\[([^\]]+)\]\./.exec(k);
		const who = m && m[1];
		if (who && has(a, who) !== has(b, who)) add("who|" + who, { kind: "who", who, on: has(b, who) });
		else if ((m = /^characters\[[^\]]+\]\.state\.slots\.(\w+)\./.exec(k))) add("slot|" + who + "|" + m[1], { kind: "slot", who, slot: m[1], from: slotAt(a, who, m[1]), to: slotAt(b, who, m[1]) });
		else if (/^characters\[[^\]]+\]\.code\./.test(k)) add("code|" + who, { kind: "code", who, from: jp(a["characters[" + who + "].code.hash"]), to: jp(b["characters[" + who + "].code.hash"]) });
		else if ((m = /^characters\[[^\]]+\]\.state\.items\[([^\]]+)\]/.exec(k))) add("inv|" + who, { kind: "inv", who, items: new Set() }).items.add(/^\d+$/.test(m[1]) ? "slot " + m[1] : m[1]);
		else if (/^characters\[[^\]]+\]\.at\./.test(k)) add("at|" + who, { kind: "at", who, from: atOf(a, who), to: atOf(b, who) });
		else if ((m = /^accounts\.([^.]+)\.bank\./.exec(k))) add("bank|" + m[1], { kind: "bank", who: m[1], n: 0 }).n++;
		else if (valTxt(k, jp(a[k])) !== valTxt(k, jp(b[k]))) add(k, { kind: "set", key: k, who, from: jp(a[k]), to: jp(b[k]) }); // (not two that read the same)
	}
	const rank = { who: 0, slot: 1, code: 2, inv: 3, at: 4, set: 5, bank: 6 };
	return [...out.values()].sort((x, y) => rank[x.kind] - rank[y.kind]);
}
// a change's group (the headings of a series' full list of changes, in this order), and the ones never shown inline: the
// versions, CODE names, the world's start date, account ages, notes (they rarely explain a difference in results)
export const CHG_GROUPS = ["Characters", "Gear", "CODE", "World and run", "Accounts", "Settings", "Versions"];
export function chgGroup(c) {
	if (c.kind === "who" || c.kind === "inv" || c.kind === "at") return "Characters";
	if (c.kind === "slot") return "Gear";
	if (c.kind === "code") return "CODE";
	if (c.kind === "bank") return "Accounts";
	if (/^(sim|chronal|game)$/.test(c.key)) return "Versions";
	if (/^code_names\./.test(c.key)) return "CODE";
	if (/^(world|run|party)\./.test(c.key)) return "World and run";
	if (/^accounts\./.test(c.key)) return "Accounts";
	return c.who ? "Characters" : "Settings";
}
export const chgLow = (c) => c.kind === "set" && /^(sim|chronal|world\.start|code_names\..*|.*age_days|.*\.note|notes.*)$/.test(c.key);
// a setting's name and value as they read (the setup's keys; the snapshot's when a run has no setup file)
const KEYN = { "run.duration": "duration", "run.duration_ms": "duration", "run.warmup": "warm-up", "run.warmup_ms": "warm-up", "run.until": "until", "run.grid_ms": "grid", "world.age": "world age", "world.age_ms": "world age", "world.ping": "ping", "world.threads": "threads", "party.members": "party", "party.leader": "leader", "party.form": "party form", sim: "sim", chronal: "chronal", game: "game" };
export const keyName = (k) => KEYN[k] || k.replace(/^characters\[([^\]]+)\]\.state\.slots\.(\w+)\.(\w+)$/, (x, n, sl, f) => n + "'s " + sl + ({ name: "", level: " level", stat_type: " stat", p: " title" }[f] ?? " " + f)).replace(/^accounts\.([^.]+)\.age_days$/, "$1's account age").replace(/^characters\[([^\]]+)\]\.(state\.)?/, "$1 ").replace(/^roster\[([^\]]+)\]\./, "$1 ").replace(/_ms$/, "");
export const valTxt = (k, v) => (v == null ? (k === "world.anniversary" ? "as the game ships it" : "none") : /_ms$/.test(k) && typeof v === "number" ? fmtSpan(v) : /age_days$/.test(k) ? +(+v).toFixed(1) + " days" : k === "sim" ? String(v).replace(/\+(\w{3})\w*$/, "+$1") : k === "chronal" ? String(v).replace(/\.(\w{3})\w*$/, ".$1") : Array.isArray(v) ? v.join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v));
const itemTxt = (it) => (it ? it.name + (it.level ? " +" + it.level : "") + (it.stat ? " " + it.stat : "") + (it.p ? " " + it.p : "") : "none");
export const codeTxt = (x) => (x ? CODESETS.get(x) || x : "none");
export function chgTxt(c) {
	if (c.kind === "who") return c.who + (c.on ? " is in (not in the baseline)" : " is out (in the baseline)");
	if (c.kind === "slot") return c.who + "'s " + c.slot + ": " + itemTxt(c.from) + " → " + itemTxt(c.to);
	if (c.kind === "code") return c.who + "'s CODE: " + codeTxt(c.from) + " → " + codeTxt(c.to);
	if (c.kind === "inv") return c.who + "'s inventory: " + [...c.items].join(", ");
	if (c.kind === "at") return c.who + "'s start: " + (c.from || "none") + " → " + (c.to || "none");
	if (c.kind === "bank") return c.who + "'s bank (" + c.n + " setting" + (c.n === 1 ? "" : "s") + ")";
	return keyName(c.key) + ": " + valTxt(c.key, c.from) + " → " + valTxt(c.key, c.to);
}

// ---- a character sheet's stats as the game shows them: the share of damage a defense takes off (the game's
// damage_multiplier(), as its sheet shows it)
const DEF_POS = [[0, 100, 0.001], [100, 100, 0.001], [200, 100, 0.00095], [300, 100, 0.0009], [400, 100, 0.00082], [500, 100, 0.0007], [600, 100, 0.0006], [700, 100, 0.0005], [800, Infinity, 0.0004]],
	DEF_NEG = [[0, 50, 0.001], [50, 50, 0.00075], [100, 50, 0.0005], [150, Infinity, 0.00025]];
const cut = (d) => { const pos = DEF_POS.reduce((a, [o, n, f]) => a + Math.max(0, Math.min(n, d - o)) * f, 0), neg = DEF_NEG.reduce((a, [o, n, f]) => a + Math.max(0, Math.min(n, -o - d)) * f, 0); return Math.trunc((1 - Math.min(1.32, Math.max(0.05, 1 - pos + neg))) * 10000) / 100; };
const fmtI = (v) => (Number.isFinite(v) ? Math.round(v).toLocaleString("en-US") : "-"), pc2 = (v) => +(+v).toFixed(2) + "%";
// the main ones always, the rest in a fold every sheet shares ("More": the XP, the attributes, the percentages); each
// [label, value, tip]
export function sheetStats(p, st, now) {
	const main = [], more = [], has = (k) => typeof st[k] === "number";
	const row = (to, l, v, tip) => to.push([l, v, tip]);
	const xp = now ? now.xp : p.xp, mx = now ? now.max_xp : p.max_xp; // (HP, MP and XP: the sheet's bars)
	if (has("attack")) row(main, "Atk", st.attack, "attack");
	if (has("frequency")) row(main, "Atk spd", Math.round(st.frequency * 100), "attack speed");
	if (has("armor")) row(main, "Armor", st.armor, "takes off " + cut(st.armor) + "% of physical damage");
	if (has("resistance")) row(main, "Resist", st.resistance, "resistance: takes off " + cut(st.resistance) + "% of magical damage");
	if (has("speed")) row(main, "Speed", st.speed, "movement speed");
	if (p.type === "priest" && has("heal")) row(main, "Heal", st.heal);
	if (st.crit) row(main, "Crit", pc2(st.crit), "critical hit chance");
	if (p.type !== "merchant" && mx) row(more, "Death", "-" + fmtN(Math.floor(Math.min(Math.max(mx * 0.01, xp * 0.02), xp))), "xp lost on death");
	row(more, "Gold", fmtN(now ? now.gold : p.gold), fmtI(now ? now.gold : p.gold));
	if (!now && p.party && p.party.name && p.party.share != null) row(more, "Party", pct(p.party.share), "its share of the party's loot and xp");
	if (p.type === "merchant" && has("tax")) row(more, "Tax", pc2(st.tax * 100));
	for (const [k, l, t] of [["str", "Str", "strength"], ["int", "Int", "intelligence"], ["dex", "Dex", "dexterity"], ["vit", "Vit", "vitality"]]) if (has(k)) row(more, l, st[k], t);
	if (has("for")) row(more, "For", st.for, "fortitude: takes off " + cut(st.for * 5) + "% of damage");
	if (has("courage")) row(more, "Courage", [st.courage, st.mcourage, st.pcourage].map((v) => v ?? "-").join("|"), "courage | magical | pure");
	if (has("mp_cost")) row(more, "MP cost", st.mp_cost, "mp per attack");
	for (const [k, l, t] of [["lifesteal", "Lifesteal"], ["manasteal", "Manasteal"], ["dreturn", "D. return", "damage return"], ["reflection", "Reflect", "reflection"], ["evasion", "Evasion"], ["miss", "Miss"]]) if (st[k]) row(more, l, pc2(st[k]), t);
	if (st.critdamage) row(more, "Crit dmg", pc2(200 + st.critdamage), "critical hit damage");
	if (st.apiercing) row(more, "A. pierce", st.apiercing, "armor piercing");
	if (st.rpiercing) row(more, "R. pierce", st.rpiercing, "resistance piercing");
	for (const [k, l] of [["goldm", "Gold"], ["xpm", "XP"], ["luckm", "Luck"]]) if (has(k) && st[k] !== 1) row(more, l + " x", Math.round(st[k] * 100) + "%", l.toLowerCase() + " found");
	return { main, more };
}
// what was on at the end of the run (the open intervals of the snapshot's timeline)
export const condsAtEnd = (p) => { const on = new Map(); for (const r of (p.timeline && p.timeline.rows) || []) if (r[2] == null) on.set(r[0], r[3]); else on.delete(r[0]); return [...on].map(([k, v]) => ({ k, v })); };
