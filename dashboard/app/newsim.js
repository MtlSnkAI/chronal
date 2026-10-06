// The New sim page (#/new): a setup composed the way the live game is set up (who is logged in, from what state, which
// CODE), then checked, saved or started (api/new: dashboard/new.js, the sim's compose.js); and Rerun (#/new?from=<run
// id>: rerun.js). The server composes; the form keeps its options (nf, kept for the next time the page shows), what the
// server has to compose from (NF), and the server's preview of what the options make (nfp).
import { h } from "./vendor/preact.js";
import { useEffect, useLayoutEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtN, parseSpan, cvar, api, ago } from "./lib.js";
import { getCst, launchesOf, pollSoon, signal, useSignal, itip } from "./store.js";
import { iconFit, skIcon, CLASS_SKILL, SHEET, badge, shadeOf } from "./art.js";
import { openTip, closeTip, tipKey, tipAhead, tipPlace, tipPinned, tipState } from "./tips.js";
import { KRow, KDur, KAdv, KChip, IbX, IbR, Select, PRESETS } from "./ui.js";
import { Rerun } from "./rerun.js";
import { unspec as nfUnspec, spec as nfSpec, hi, miniSheet } from "./gearsets.js";

const html = htm.bind(h);
export const NewSim = ({ route }) => (route.from ? html`<${Rerun} route=${route} />` : html`<${Compose} route=${route} />`);

// ---- the form's state; drawn again on each change (draw), the focus then put on a field or button (nfFocus)
let nf = null, NF = null, nfp = null, nfItems = null, nfTimer = null, nfSeq = 0, nfOut = null, nfPick = null, nfInv = null, nfWait = "", nfTop = null, nfTaking = false;
const nfv = signal(0), draw = () => nfv.set(nfv.v + 1);
let focusNext = null; // [selector, then(el)]
const nfFocus = (sel, then) => { focusNext = [sel, then]; draw(); };
// the text of a field while it is typed (applied on Enter or on leaving it): field id -> text; gone with its picker or
// item column
const drafts = new Map();
const say = (text, bad) => html`<p class=${bad ? "nbad" : "hint"}>${text}</p>`;
const nfFits = new Map(); // "class|slot|mainhand|offhand" -> [[item, of another class]]
const NF_SEG = [["game", "In game"], ["offline", "Offline"], ["out", "Out"]];
const nfFresh = () => ({ template: "", pull: "", players: [], acct: {}, roster: [], code: "", cnames: {}, store: {}, keys: [], steer: null, bld: null, until: "", compare: [], party: "auto", members: [], leader: "", pform: "code", duration: "30m", warmup: "", seed: "1", runs: "1", ping: "", wage: "", sweeps: [], name: "", missing: {}, open: null, start: "", seasons: [], events: [], spawns: [], farmSpawns: true });
// what the form's CODE is when none is picked: the template's, else the pull's, else the example bot (the built-in set)
const nfDefCode = () => (nf.template ? "the template's" : NF.pulls.length ? "the pull's" : "the example bot");
// (from the Accounts page: { pull: a pull's id, account: a crafted account's name, player: a public page's id })
async function nfOpen(r) {
	nf = nf || nfFresh();
	draw();
	await nfLoad();
	if (NF.ok && r.pull && NF.pulls.some((q) => q.id === r.pull)) (nf.pull = NF.pulls[0].id === r.pull ? "" : r.pull), nfRoster();
	if (NF.ok && (r.account || r.player)) nfAddAccount(r.account ? "c:" + r.account : "p:" + r.player);
	if (r.pull || r.account || r.player) history.replaceState(null, "", "#/new"), draw();
	if (!nfItems) try { nfItems = await (await fetch("api/new/items")).json(); } catch (e) {}
	nfPreview(0);
}
async function nfLoad() {
	try { NF = await (await fetch("api/new")).json(); } catch (e) { NF = { ok: false, reason: e.message }; }
	if (NF.ok) nfRoster();
	draw();
}
const nfPullOf = () => NF && NF.pulls && (NF.pulls.find((p) => p.id === nf.pull) || (!nf.pull ? NF.pulls[0] : null));
const nfTplOf = () => NF && NF.templates && NF.templates.find((t) => t.file === nf.template);
// the players' pages added (chronal pull --player: their accounts' public pages), and the one a character is on
const nfPages = () => nf.players.map((id) => NF && NF.players && NF.players.find((q) => q.id === id)).filter(Boolean);
const nfPageOf = (name) => nfPages().find((q) => q.characters.some((c) => c.name === name)) || null;
// the characters to choose from: the template's, then the pull's, the players'; the new ones; edits kept by name
function nfRoster() {
	const t = nfTplOf(), p = nfPullOf(), old = new Map(nf.roster.map((r) => [r.name, r])), out = [];
	const add = (name, cls, from, on, level0) => { if (out.some((r) => r.name === name)) return; const o = old.get(name); out.push(o && o.from === from ? { ...o, level0 } : { name, class: cls, from, on, level0, level: "", state: "", gold: "", at: "", code: "", entry: "", gear: {}, items: null, account: "" }); };
	if (t) for (const c of t.characters) add(c.name, c.class, "template", c.online ? "game" : "offline", c.level);
	if (p) for (const c of p.characters) add(c.name, c.class, "pull", !t && c.online ? "game" : "out", c.level);
	for (const q of nfPages()) for (const c of q.characters) add(c.name, c.class, "player", "out", c.level);
	for (const r of nf.roster) if (r.from === "new") out.push(r);
	nf.roster = out;
}
// a character's account: the one set for it, else as the preview has it, else its source's (a template's, its page's,
// the pull's)
function nfAcct(r) {
	if (r.account) return r.account;
	const v = nfp && nfp.variants && nfp.variants[0], c = v && v.characters.find((x) => x.name === r.name);
	if (c && c.account) return c.account;
	const q = r.from === "player" && nfPageOf(r.name), t = r.from === "template" && nfTplOf(), tc = t && t.characters.find((x) => x.name === r.name), p = nfPullOf();
	return q ? q.account : tc && tc.account ? tc.account : (p && p.account) || "main";
}
// the runs to start: Runs seeds from Seed up (as Rerun's)
const nfSeeds = () => { const s0 = Math.max(1, Math.floor(Number(nf.seed)) || 1), n = Math.max(1, Math.min(50, Math.floor(Number(nf.runs)) || 1)); return Array.from({ length: n }, (_, i) => s0 + i); };
// the form as compose.js options
function nfOpts() {
	const ro = nf.roster.filter((r) => r.on !== "out"), per = (f) => Object.fromEntries(ro.filter((r) => r[f] !== "" && r[f] != null).map((r) => [r.name, r[f]]));
	const pages = nfPages().filter((q) => ro.some((r) => r.from === "player" && nfPageOf(r.name) === q)), inRun = new Set(ro.map(nfAcct));
	const acct = (f) => Object.fromEntries(Object.entries(nf.acct).filter(([k, a]) => inRun.has(k) && a[f] != null && a[f] !== "").map(([k, a]) => [k, a[f]]));
	const o = {
		template: nf.template || undefined, pull: nf.pull || undefined, players: pages.length ? pages.map((q) => q.id) : undefined,
		account_of: Object.fromEntries(ro.filter((r) => r.from !== "new" && r.account).map((r) => [r.name, r.account])), account_age: acct("age"), account_bank: acct("bank"),
		chars: ro.filter((r) => r.from !== "new").map((r) => r.name).join(","),
		char: ro.filter((r) => r.from === "new").map((r) => ({ name: r.name, class: r.class, level: r.level ? Number(r.level) : r.level0 || 1, account: r.account || undefined })),
		offline: ro.filter((r) => r.on === "offline").map((r) => r.name),
		state: per("state"), at: per("at"), code_sets: per("code"), entries: per("entry"),
		level: Object.fromEntries(ro.filter((r) => r.from !== "new" && r.level !== "").map((r) => [r.name, Number(r.level)])),
		gold: Object.fromEntries(ro.filter((r) => r.gold !== "").map((r) => [r.name, Number(r.gold)])),
		items: Object.fromEntries(ro.filter((r) => r.items).map((r) => [r.name, r.items])),
		gear: ro.flatMap((r) => Object.entries(r.gear).map(([sl, spec]) => r.name + ":" + sl + "=" + spec)),
		code_set: nf.code || undefined,
		// (a name chosen for a character now out: as composed)
		code_names: Object.fromEntries(Object.entries(nf.cnames).filter(([a, b]) => b === a || ro.some((r) => r.name === b))),
		prelude: Object.fromEntries(ro.filter((r) => r.prelude).map((r) => [r.name, r.prelude])),
		...nfStoreOut(inRun), steer: nf.steer ? nfSteerOut(nf.steer) : undefined,
		party: nf.party === "none" ? false : nf.party === "custom" && nf.members.length ? [nf.leader, ...nf.members.filter((n) => n !== nf.leader)].filter(Boolean).join(",") + "/" + nf.pform : undefined,
		duration: nf.duration || undefined, warmup: nf.warmup || undefined, until: nf.until ? nf.until.trim() : undefined, check_every: nf.check ? nf.check.trim() : undefined, ping: nf.ping || undefined, world_age: nf.wage || undefined,
		...nfWorldOut(),
		start: nf.start ? nf.start + ":00Z" : undefined, seasons: nf.seasons.length ? nf.seasons : undefined, events: nf.events.some((e) => e.event && e.at.trim()) ? nf.events.filter((e) => e.event && e.at.trim()).map((e) => ({ event: e.event, at: e.at.trim() })) : undefined,
	};
	if (nf.code && nf.compare.length) o.sweep_code_set = [nf.code, ...nf.compare].join(",");
	const sw = nf.sweeps.filter((x) => x.specs.length && x.slot !== "set"), sets = nf.sweeps.filter((x) => x.specs.length && x.slot === "set");
	if (sw.length) o.sweep_gear = sw.map((x) => x.name + ":" + x.slot + "=" + x.specs.join(","));
	if (sets.length) o.sweep_gear_set = sets.map((x) => x.name + "=" + x.specs.join(","));
	return o;
}
// the server's preview of what the options make: 350 ms after the last change
function nfPreview(ms = 350) {
	clearTimeout(nfTimer);
	nfTimer = setTimeout(async () => {
		const seq = ++nfSeq;
		nfWait = "resolving..."; draw();
		try {
			const r = await api("api/new/compose", "POST", { opts: nfOpts(), missing: nf.missing, action: "preview" }), o = await r.json().catch(() => ({}));
			if (seq !== nfSeq || !nf) return;
			nfp = r.ok ? o : { ok: false, problems: [o.reason || "HTTP " + r.status] };
		} catch (e) { if (seq === nfSeq) nfp = { ok: false, problems: [e.message] }; }
		nfWait = ""; draw();
	}, ms);
}
// a change: drawn, and the server's preview again
const change = () => (draw(), nfPreview());
const variant = () => nfp && nfp.variants && nfp.variants[0];
const nfR = (n) => nf.roster.find((r) => r.name === n);
const nfStart = (n) => { const v = variant(), c = v && v.characters.find((x) => x.name === n); return c && c.start; };

// ---- the page: its title (start over), the form, its sections; the focus where an action put it; the pickers at
// their buttons; the form's item tooltips fetched ahead
const nfTabs = (el) => [...el.querySelectorAll("button, input, select, textarea, [tabindex]")].filter((e) => e.tabIndex >= 0 && !e.disabled && e.offsetParent !== null);
let nfKeyed = false, lastFocus = null; // the last input was a key (not the pointer); the field or button focused last, and its place in the Tab order
function Compose({ route }) {
	useSignal(nfv);
	const root = useRef(null);
	useEffect(() => {
		nfOpen(route);
		const key = () => (nfKeyed = true), ptr = () => (nfKeyed = false);
		// a click outside the open picker closes it (its own buttons, and the cells that open one, do their own)
		const out = (e) => {
			if (!nf || !e.target.closest) return;
			let again = false;
			if (nfPick && !e.target.closest(".ipk, [data-nslot], [data-ninvadd], #itip")) (nfPick = null), drafts.clear(), (again = true);
			if (nfCp && !e.target.closest(".ncpk, .ncp")) (nfCp = null), (again = true);
			if (nfInv != null && !e.target.closest('.idlg, .inv [data-ninv="' + nfInv + '"]')) (nfInv = null), drafts.clear(), closeTip(), (again = true);
			if (again) setTimeout(draw, 0); // (after the form's own handler)
		};
		// the page scrolled: the pickers stay at their buttons; an item's tooltip closes (an inventory item edited: its own
		// moves along)
		const scroll = () => { place(); const T = tipState(); if (T.tipIn === "form" && !(T.tipPin && nfInv != null)) closeTip(); };
		addEventListener("keydown", key, true);
		addEventListener("pointerdown", ptr, true);
		document.addEventListener("click", out, true);
		addEventListener("scroll", scroll, { passive: true });
		return () => {
			removeEventListener("keydown", key, true); removeEventListener("pointerdown", ptr, true); document.removeEventListener("click", out, true); removeEventListener("scroll", scroll);
			nfPick = null; nfInv = null; nfCp = null; clearTimeout(nfTimer); drafts.clear();
			if (tipState().tipIn === "form") closeTip();
		};
	}, []);
	useLayoutEffect(() => {
		const el = root.current, paf = el && el.querySelector(".paf");
		if (!paf) return;
		// the focus an action asked for; from the keyboard, a focused control that went: on what stands in its place
		if (focusNext) {
			const [sel, then] = focusNext, e = paf.querySelector(sel);
			focusNext = null;
			if (e) { e.focus({ preventScroll: !e.closest(".ipk") }); if (then) then(e); }
		} else if (nfKeyed && lastFocus && !lastFocus.el.isConnected && (document.activeElement === document.body || !paf.contains(document.activeElement))) {
			const t = nfTabs(paf), n = t[Math.min(lastFocus.i, t.length - 1)];
			if (n) n.focus({ preventScroll: true });
		}
		// the form's open tooltip: again for the item now there (its level changed), else closed
		const T = tipState(), x = itip.v;
		if (T.tipIn === "form" && x) { if (!x.el.isConnected) closeTip(); else if (tipKey(x.el) !== T.tipFor) { const pin = T.tipPin; closeTip(); tipPinned(pin); openTip(x.el); } }
		tipAhead(paf);
		place();
	});
	const onFocus = (e) => { const paf = root.current && root.current.querySelector(".paf"); if (paf && paf.contains(e.target)) lastFocus = { el: e.target, i: nfTabs(paf).indexOf(e.target) }; };
	return html`<div id="nsim" ref=${root} onKeyDown=${keys} onFocusIn=${onFocus}>
		<div class="drh"><h2>New sim<${IbR} what="start over: no template, nobody in game, nothing changed" onClick=${clean} /></h2></div>
		<div class="paf">${body()}</div>
		<div class="drl" role="status" aria-live="polite"></div>
	</div>`;
}
function clean() {
	nf = nfFresh(); nfp = null; nfPick = null; nfInv = null; nfCp = null; nfAc = null; nfOut = null;
	closeTip(); nfRoster(); draw(); nfPreview(0);
}
// the pickers at their buttons: the inventory item's column beside it (its tooltip kept open), the CODE sets' picker
function place() {
	if (nfInv != null) nfInvPlace();
	if (nfCp) nfCpPlace();
}

// ---- the form
const lvOf = (r) => { const v = variant(), c = v && v.characters.find((x) => x.name === r.name), st = c && c.start; return st ? st.level : r.level || r.level0 || 1; };
function body() {
	if (!NF || !nf) return html`<p class="mnote">loading...</p>`;
	if (!NF.ok) return html`<p class="mnote">${NF.reason || "the New run form isn't available here"}</p>`;
	const v = variant();
	return [fromSec(), whoSec(v), codeSec(v), runSec(v), actSec(), bar(v)];
}
// where it starts from: one line; what the pull says as chips
function fromSec() {
	// a pull's warnings as short chips: its characters online in one ("online: A, B"), each other one by its first
	// part; the whole text on hover
	const pullWarnChips = (ws) => {
		const on = ws.filter((w) => / is online\b/.test(w)), rest = ws.filter((w) => !on.includes(w));
		return [...(on.length ? [html`<${KChip} text=${"online: " + on.map((w) => w.split(" is online")[0]).join(", ")} cls="warn" tip=${on.join("\n")} />`] : []), ...rest.map((w) => html`<${KChip} text=${w.split(": ")[0]} cls="warn" tip=${w} />`)];
	};
	const p = nfPullOf();
	const pinfo = p ? p.characters.length + " characters, bank " + fmtN(p.bank && p.bank.gold) + " gold" + (p.account_age && p.account_age.days != null ? ", account " + p.account_age.days + " days old" : "") + (p.overrides.length ? ", snippet exports: " + p.overrides.join(", ") : "") : "";
	const pchips = !p ? [] : [...(p.game && p.game.differ ? [html`<${KChip} text=${"game data differs: " + p.game.differ} cls="warn" tip=${"Live's game data differs from this checkout's in " + p.game.differ + " entries: runs may not match live (game-diff.json in the pull)"} />`] : []), ...pullWarnChips(p.warnings.filter((w) => !/^live's game data/.test(w)))];
	const pull = async () => {
		NF.pulling = true; nfOut = say("pulling the live account (~15 s)..."); draw();
		let r = null, o = {};
		try { r = await api("api/new/pull", "POST", {}); o = await r.json().catch(() => ({})); } catch (e) { o = { reason: e.message }; }
		nfOut = r && r.ok ? say("Pulled " + o.id) : say(o.reason || "HTTP " + (r && r.status), true);
		nf.pull = "";
		await nfLoad();
		nfPreview();
	};
	const pick = (k) => (e) => { nf[k] = e.currentTarget.value; nfRoster(); nfOut = null; draw(); nfPreview(0); };
	return html`<section class="nsec"><${KRow} label="Start from">
			<${Select} data-nf="template" aria-label="Template" data-tip="a template, or none: who is logged in, as pulled" value=${nf.template} onChange=${pick("template")}><option value="">no template</option>${NF.templates.map((t) => html`<option value=${t.file}>${t.name}</option>`)}</${Select}>
			<${Select} data-nf="pull" aria-label="Account" data-tip=${pinfo || null} value=${nf.pull} onChange=${pick("pull")}>${NF.pulls.length ? NF.pulls.map((q, i) => html`<option value=${i ? q.id : ""}>${q.account + ", " + ago(q.pulled_at)}</option>`) : html`<option value="">no pull yet</option>`}</${Select}>
			<button type="button" class="cb" disabled=${!(NF.token && !NF.pulling)} data-tip=${NF.token ? "the live account now, through the game's token API (read-only): characters, bank, CODE, and a check of the game data against this checkout's" : "no token yet: Settings sets one up"} onClick=${pull}>${NF.pulling ? "Pulling..." : "Pull now"}</button>
			${NF.token ? null : html`<a class="lnk sm" href="#/settings">Set up the token</a>`}
			<button type="button" class="cb" data-nexp="1" aria-expanded=${!!nfExp} data-tip="a character exactly as on live (inventory, gold, gear, conditions; exported inside the bank: the bank too), over its character of this pull: copy the snippet, run it on live, paste what it copies" onClick=${() => { nfExp = nfExp ? null : {}; nfFocus(nfExp ? "[data-nexpcopy]" : "[data-nexp]"); }}>Add export</button>
		</${KRow}>${pchips.length ? html`<${KRow} label="">${pchips}</${KRow}>` : null}${nfExp ? expPanel() : null}</section>`;
}

// ---- who is logged in: by account (its age and bank on its line), a line each; the ones out as a row of chips (a
// click brings one in game)
const setOn = (r, k) => { r.on = k; if (r.on === "out" && nf.open === r.name) nf.open = null; change(); };
function whoSec(v) {
	const pc = (n) => v && v.characters.find((c) => c.name === n), lim = {};
	for (const r of nf.roster) if (r.on === "game") { const k = nfAcct(r); (lim[k] ||= [0, 0])[r.class === "merchant" ? 1 : 0]++; }
	const over = Object.entries(lim).filter(([, [f, m]]) => f > 3 || m > 1).map(([k]) => k), perIp = Object.values(lim).reduce((n, [f]) => n + f, 0);
	const row = (r) => {
		const c = pc(r.name), code = c && c.code;
		const cd = code ? (code.idle ? "no CODE" : (code.set || "template") + ": " + code.entry) : "", sws = nf.sweeps.filter((x) => x.name === r.name && x.specs.length), sw = sws.map((x) => x.specs.length + " " + (x.slot === "set" ? "gear sets" : x.slot));
		const src = (c && c.source) || (r.from === "new" ? "new" : r.from === "template" ? "template" : "");
		return [html`<div class="nrow" style=${cvar(r.class)}><span class="ncl" data-tip=${r.class + (src ? ", " + src : "")}>${skIcon(CLASS_SKILL[r.class], 20)}</span><b class="nnm">${r.name}</b><span class="gu">L${lvOf(r)}</span>
			<span class="gu ncd" data-tip=${cd ? (code.idle ? "no CODE (idle)" : "CODE " + (code.set || "the template's") + ", slot " + code.entry) : null}>${cd}</span>${sw.length ? html`<span class="chip kc" data-tip=${"compares " + sws.map((x) => x.specs.length + (x.slot === "set" ? " gear sets" : " " + x.slot + " items")).join(", ")}>${"compares " + sw.join(", ")}</span>` : null}
			<span class="seg sm" role="group" aria-label=${r.name}>${NF_SEG.map(([k, t]) => html`<button type="button" aria-pressed=${r.on === k} onClick=${() => setOn(r, k)}>${t}</button>`)}</span>
			<button type="button" class="cb" data-nedit=${r.name} aria-expanded=${nf.open === r.name} onClick=${() => { nf.open = nf.open === r.name ? null : r.name; nfPick = null; nfInv = null; draw(); }}>${nf.open === r.name ? "Done" : "Edit"}</button>
			${r.from === "new" ? html`<${IbX} what=${"remove " + r.name} onClick=${() => { nf.roster = nf.roster.filter((x) => x !== r); delete nf.missing[r.name]; change(); }} />` : null}</div>`, nf.open === r.name ? editor(r, c) : null];
	};
	const outChip = (r) => html`<button type="button" class="nochip" style=${cvar(r.class)} data-tip=${"bring " + r.name + " (" + r.class + " L" + lvOf(r) + ") in game"} onClick=${() => setOn(r, "game")}>${skIcon(CLASS_SKILL[r.class], 16)}${r.name}</button>`;
	const groups = [...new Set(nf.roster.map(nfAcct))].map((k) => {
		const rs = nf.roster.filter((r) => nfAcct(r) === k), gi = rs.filter((r) => r.on !== "out"), go = rs.filter((r) => r.on === "out");
		return [acctHead(k, v), gi.map(row), go.length ? html`<div class="nouts"><span class="gu">Out</span>${go.map(outChip)}</div>` : null];
	});
	// the accounts to add: the crafted ones (all their characters: in game as many as the game lets in), the players' pages taken
	const inRoster = (n) => nf.roster.some((r) => r.name.toLowerCase() === n.toLowerCase());
	const crafted = (NF.accounts || []).filter((a) => !a.problems && a.characters.some((c) => !inRoster(c.name))), pages = (NF.players || []).filter((q) => !nf.players.includes(q.id));
	const acctPick = crafted.length || pages.length ? html`<${Select} aria-label="Add an account" value="" onChange=${(e) => { const x = e.currentTarget.value; if (!x) return; nfAddAccount(x); nfOut = null; draw(); nfPreview(0); }}><option value="">Add an account...</option>
		${crafted.length ? html`<optgroup label="Crafted (Accounts)">${crafted.map((a) => html`<option value=${"c:" + a.name}>${a.name + ": " + a.characters.map((c) => c.name).join(", ")}</option>`)}</optgroup>` : null}
		${pages.length ? html`<optgroup label="Players' pages">${pages.map((q) => html`<option value=${"p:" + q.id}>${q.account + ": " + q.characters.map((c) => c.name).join(", ")}</option>`)}</optgroup>` : null}</${Select}>` : null;
	const outRow = html`<div class="nouts"><button type="button" class="cb" data-nadding="1" aria-expanded=${!!nf.adding} onClick=${() => { nf.adding = !nf.adding; nfFocus(nf.adding ? '[data-nf="newname"]' : "[data-nadding]"); }}>New character</button>${acctPick}
		<span class="nply"><input type="text" list="nftop" data-nf="playername" maxlength="12" autocomplete="off" value=${nf.playername || ""} placeholder="a player's character" aria-label="A player's character" onInput=${(e) => (nf.playername = e.currentTarget.value)} onFocus=${topLoad} />
			<button type="button" class="cb" data-nplayer="1" disabled=${nfTaking} data-tip="their account's characters, from the game site's public page (adventure.land/player/<name>): class, level and gear. No inventory, gold or bank shows there: each takes the inventory and gold of your character of its class, else a new one's. They play on their own account" onClick=${addPlayer}>${nfTaking ? "Adding..." : "Add player"}</button></span></div>`;
	const adding = nf.adding ? html`<div class="frow nadd"><input type="text" data-nf="newname" placeholder="Name" maxlength="12" value=${nf.newname || ""} aria-label="Name" onInput=${(e) => (nf.newname = e.currentTarget.value)} />
		<${Select} aria-label="Class" value=${nf.newclass || "ranger"} onChange=${(e) => (nf.newclass = e.currentTarget.value)}>${Object.keys(NF.classes).map((k) => html`<option value=${k}>${k}</option>`)}</${Select}>
		<input type="number" min="1" max="200" placeholder="level" value=${nf.newlevel || ""} aria-label="Level" onInput=${(e) => (nf.newlevel = e.currentTarget.value)} /><button type="button" class="cb" onClick=${addNew}>Add</button></div>` : null;
	const limit = over.length ? html`<${KChip} text=${"over 3 + 1 per account: " + over.join(", ")} cls="warn" tip=${"At most 3 characters and 1 merchant in game per account at the start (" + over.join(", ") + "): put the others offline (CODE may start them) or out"} />`
		: perIp > 3 ? html`<${KChip} text="over 3 in game per IP" cls="warn" tip="At most 3 characters besides merchants in game from one IP, whatever their accounts (a run's characters all play from one): put the others offline or out" />` : null;
	return html`<section class="nsec">${nf.roster.length ? groups : html`<p class="gu">pull the account, pick a template, add a character or a player</p>`}${limit ? html`<div class="frow">${limit}</div>` : null}${outRow}${adding}</section>`;
}
// the player field focused: the site's top characters to pick from (once)
const topLoad = () => { if (nfTop) return; nfTop = []; fetch("api/new/top").then((r) => r.json()).then((o) => { nfTop = o.characters || []; draw(); }, () => {}); };
function addNew() {
	const n = String(nf.newname || "").trim();
	if (!/^[A-Za-z0-9]{1,12}$/.test(n)) return (nfOut = say("a name of 1-12 letters and digits", true)), draw();
	if (nf.roster.some((r) => r.name.toLowerCase() === n.toLowerCase())) return (nfOut = say(n + " is in the list already", true)), draw();
	nf.roster.push({ name: n, class: nf.newclass || "ranger", from: "new", on: "game", level0: Number(nf.newlevel) || 1, level: nf.newlevel || "", state: "", gold: "", at: "", code: "", entry: "", gear: {}, items: null, account: "" });
	nf.newname = ""; nf.adding = false; nf.open = n; nfOut = null;
	change();
}
// a player's account's public page, taken (again: fresh); the one named in game, the others out
async function addPlayer() {
	const n = String(nf.playername || "").trim();
	if (!/^[A-Za-z0-9]{1,12}$/.test(n)) return (nfOut = say("a character's name: 1-12 letters and digits", true)), draw();
	nfTaking = true; nfOut = say("reading the public page of " + n + "'s account..."); draw();
	let r = null, o = {};
	try { r = await api("api/new/player", "POST", { name: n }); o = await r.json().catch(() => ({})); } catch (e) { o = { reason: e.message }; }
	nfTaking = false;
	if (!r || !r.ok) return (nfOut = say(o.reason || "HTTP " + (r && r.status), true)), draw();
	nf.players = nf.players.filter((id) => id.split("/")[0] !== o.account).concat(o.id);
	await nfLoad();
	const x = o.name && nfR(o.name), q = nfPages().find((y) => y.id === o.id);
	if (x && x.on === "out") x.on = "game";
	nf.playername = "";
	nfOut = say("Added " + o.account + "'s account (" + (q ? q.characters.length : "?") + " characters" + (x ? ", " + x.name + " in game" : "") + ")" + (o.warnings && o.warnings.length ? ": " + o.warnings.join("; ") : ""));
	change();
}
// an account into the run: a crafted one's characters as new characters of it, with its gear, CODE and age (in game as
// many as the game lets in at once: 3 and a merchant; the rest out); a player's page (its characters out, to bring in)
function nfAddAccount(v) {
	if (v.startsWith("p:")) { if (!nf.players.includes(v.slice(2))) nf.players.push(v.slice(2)); return nfRoster(); }
	const a = (NF.accounts || []).find((x) => x.name === v.slice(2));
	if (!a || a.problems) return;
	let f = 0, m = 0;
	for (const c of a.characters) {
		if (nf.roster.some((r) => r.name.toLowerCase() === c.name.toLowerCase())) continue;
		const on = c.class === "merchant" ? (m++ ? "out" : "game") : f++ < 3 ? "game" : "out";
		nf.roster.push({ name: c.name, class: c.class, from: "new", on, level0: c.level, level: "", state: "", gold: "", at: "", code: a.code || "", entry: "", gear: { ...(c.gear || {}) }, items: null, account: a.name });
	}
	if (a.age_days != null) (nf.acct[a.name] ||= {}).age = String(a.age_days);
}
// an account of new characters saved as a crafted account (lib/accounts.js): their class, level and gear (as edited
// here), its age and CODE (its characters' one set, else the CODE for all)
async function nfSaveAccount(k) {
	const v = variant(), rs = nf.roster.filter((r) => nfAcct(r) === k && r.from === "new");
	const lv = (r) => { const c = v && v.characters.find((x) => x.name === r.name); return (c && c.start && c.start.level) || Number(r.level) || r.level0 || 1; };
	const codes = [...new Set(rs.map((r) => r.code).filter(Boolean))], set = nf.acct[k] && nf.acct[k].age;
	const age = set != null && set !== "" ? Number(set) : v && v.accounts && v.accounts[k] && v.accounts[k].age_days != null ? v.accounts[k].age_days : 0;
	const account = { name: k, age_days: age, code: codes.length === 1 ? codes[0] : nf.code || null, characters: rs.map((r) => ({ name: r.name, class: r.class, level: lv(r), gear: { ...r.gear } })) };
	let r = null, o = {};
	try { r = await api("api/accounts/" + encodeURIComponent(k), "PUT", { account }); o = await r.json().catch(() => ({})); } catch (e) { o = { reason: e.message }; }
	nfOut = r && r.ok ? say("Saved the account " + k + " (" + rs.length + (rs.length === 1 ? " character" : " characters") + "): on the Accounts page") : say("Not saved: " + (o.reason || "HTTP " + (r && r.status)), true);
	await nfLoad();
}
// an account's line over its characters: whose it is; its age (days: 0 is a new account, with the New Player bonus) and
// bank as the run starts it
function acctHead(k, v) {
	const a = v && v.accounts && v.accounts[k], set = nf.acct[k] || {}, p = nfPullOf(), mine = !!p && p.account === k, page = !mine && nfPages().find((q) => q.account === k);
	const what = mine ? "yours, pulled " + ago(p.pulled_at) : page ? "public page, " + ago(page.pulled_at) : "";
	const banks = [["", mine ? "its bank" : "no bank"], ...(mine ? [["none", "no bank"]] : p && p.bank ? [[p.account, "the bank of " + p.account]] : [])];
	// an account of new characters only (crafted, or made here): saved as a crafted account
	const rs = nf.roster.filter((r) => nfAcct(r) === k), craft = (NF.accounts || []).find((x) => x.name === k);
	return html`<div class="nacc"><b>${k}</b>${what ? html`<span class="gu">${what}</span>` : craft ? html`<span class="gu">crafted</span>` : null}
		<input type="text" inputmode="numeric" value=${set.age || ""} placeholder=${a && a.age_days != null ? String(a.age_days) : ""} aria-label=${k + ": its age in days"} data-tip="the account's age in days: under 40, the New Player bonus (0: a new account)" onInput=${(e) => { (nf.acct[k] ||= {}).age = e.currentTarget.value.trim(); nfPreview(); }} /><span class="gu">days</span>
		${banks.length > 1 ? html`<${Select} aria-label=${k + ": its bank"} value=${set.bank || ""} onChange=${(e) => { (nf.acct[k] ||= {}).bank = e.currentTarget.value; change(); }}>${banks.map(([x, t]) => html`<option value=${x}>${t}</option>`)}</${Select}>` : html`<span class="gu">${banks[0][1]}</span>`}
		${rs.length && rs.every((r) => r.from === "new") ? html`<button type="button" class="lnk sm" data-tip=${(craft ? "update the crafted account " + k : "keep " + k + " as a crafted account") + ": its characters' class, level and gear, its age and CODE (the Accounts page)"} onClick=${() => nfSaveAccount(k)}>${craft ? "Update the account" : "Save as account"}</button>` : null}</div>`;
}

// ---- a character's editor: its gear as the game's sheet (a click: the items it may wear there; hovered: the game's
// tooltip), its inventory (its items, and a cell to add one), its numbers, CODE
const cell = (it, q) => [iconFit(it.name, 40) || it.name.slice(0, 4), badge(it.name, it.level || 0), q != null ? q : it.q > 1 ? html`<b class="qb">${it.q}</b>` : null];
// a character's gear as edited here: at once (the preview's start catches up a moment later)
const nfSlots = (r, st) => { const o = { ...((st && st.slots) || {}) }; for (const [k, x] of Object.entries(r.gear)) o[k] = nfUnspec(x); return o; };
// a character's inventory, as the game's server sets it (player.isize), and a stack's size (the game's s; none: 1)
const NF_ISIZE = 42, nfStack = (k) => ((nfItems && nfItems.items[k]) || [])[6] || 1;
// the cell of the sheet and of the inventory the Tab key goes to (the last one focused there)
const nfAt = { sheet: null, inv: null };
// a character's sweep of a slot, or of gear sets (sl "set"; null: none)
const nfSw = (name, sl) => nf.sweeps.find((x) => x.name === name && x.slot === sl) || null;
// a gear set's slots (all but the elixir); the sets of a class (yours after the built-in ones), the one a sheet wears
// (null: none), a set's name as shown
const NF_GEAR = SHEET.flat().filter((k) => k !== "elixir");
const nfSets = (cls) => ((NF && NF.gear_sets) || []).filter((s) => !s.problems && s.class === cls);
const nfWorn = (r, slots) => nfSets(r.class).find((s) => NF_GEAR.every((k) => nfSpec(slots[k]) === (s.gear[k] || "none"))) || null;
const nfSetName = (s) => s.label || s.name;
// a cell focused: the one Tab comes back to (an inventory item edited: its edit ends once the arrows go on)
const cellFocus = (k, v, e) => { if (nfInv != null && !(k === "inv" && v === String(nfInv)) && !e.target.closest(".idlg")) return nfInvClose(false); if (nfAt[k] !== v) (nfAt[k] = v), draw(); };
function editor(r, c) {
	const st = c && c.start;
	if (!st) return html`<div class="ned"><p class="hint">${nfWait || "its state shows once the form resolves"}</p></div>`;
	const pk = nfPick && nfPick.name === r.name ? nfPick : null, slots = nfSlots(r, st);
	const slotClick = (sl, e) => {
		const same = nfPick && nfPick.name === nf.open && nfPick.slot === sl;
		nfPick = same ? null : { name: nf.open, slot: sl, q: "" };
		drafts.clear();
		if (nfInv != null) (nfInv = null), closeTip();
		same ? (e.detail ? draw() : nfFocus('[data-nslot="' + sl + '"]')) : nfFocus("[data-npq]");
	};
	const sheet = html`<div class="sheet">${SHEET.flat().map((sl) => {
		const it = slots[sl], ed = sl in r.gear, on = pk && pk.slot === sl, x = nfSw(r.name, sl), n = x ? x.specs.length : 0;
		return html`<button type="button" class=${"gs ge" + (ed ? " ed" : "") + (n ? " cmp" : "")} data-nslot=${sl} tabIndex=${sl === (nfAt.sheet || "mainhand") ? 0 : -1} aria-haspopup="dialog" aria-expanded=${!!on}
			aria-label=${sl + ": " + (it ? nfSpec(it) : "empty") + (ed ? " (changed)" : "") + (n ? ", comparing " + n + " items" : "") + (it ? " (Delete: empty it)" : "")} ...${it ? hi(it) : {}} onClick=${(e) => slotClick(sl, e)} onFocus=${(e) => cellFocus("sheet", sl, e)}>${it ? cell(it) : shadeOf(sl)}${n ? html`<b class="swc">${n}</b>` : null}</button>`;
	})}</div>`;
	const mine = nf.sweeps.some((x) => x.name === r.name);
	const gact = html`<div class="ivh"><h5>Equipment</h5>${Object.values(slots).some(Boolean) ? html`<${IbX} what="empty every slot" onClick=${() => { r.gear = Object.fromEntries(SHEET.flat().map((k) => [k, "none"])); nf.sweeps = nf.sweeps.filter((x) => x.name !== r.name); nfPick = null; change(); }} />` : null}
		${Object.keys(r.gear).length || mine ? html`<${IbR} what="the gear as it starts (no items compared)" onClick=${() => { r.gear = {}; nf.sweeps = nf.sweeps.filter((x) => x.name !== r.name); nfPick = null; change(); }} />` : null}</div>`;
	// the inventory: its items (a click or Enter: a stack's size in place, else its level, stat scroll and title beside
	// it, with the game's tooltip), a cell to add one
	const items = r.items || st.items, filled = items.map((it, i) => [it, i]).filter(([it]) => it), at = pk && pk.slot === "inv" ? filled.length : -1;
	const full = filled.length >= NF_ISIZE, iat = filled.some(([, i]) => String(i) === String(nfAt.inv)) ? String(nfAt.inv) : "add";
	const invClick = (i, e) => {
		if (nfInv === i) return nfInvClose(!e.detail);
		nfInv = i; nfPick = null;
		const st1 = nfStack(items[i].name) > 1;
		nfFocus(st1 ? ".qin" : ".idlg input", st1 ? (x) => x.select() : null);
	};
	const qid = "q|" + r.name + "|" + nfInv;
	const inv = [html`<div class="ivh"><h5>Inventory <span class="gu">${filled.length}/${NF_ISIZE}</span></h5>${filled.length ? html`<${IbX} what="empty the inventory" onClick=${() => { nfItemsEdit(nf.open, (xs) => xs.fill(null)); nfPick = null; nfInv = null; closeTip(); change(); }} />` : null}
			${r.items ? html`<${IbR} what="the inventory as it starts" onClick=${() => { r.items = null; nfInv = null; nfPick = null; closeTip(); change(); }} />` : null}</div>`,
		html`<div class="invw"><div class="inv">${filled.map(([it, i]) => {
			const lab = nfSpec(it) + (it.q > 1 ? " x" + it.q : "") + " (Enter: edit it; Delete: remove it)";
			if (nfInv === i && nfStack(it.name) > 1) return html`<div class="gs ge on" data-ninv=${i} ...${hi(it)}>${cell(it, html`<input type="text" class="qin" inputmode="numeric" data-ninvq="1" value=${drafts.get(qid) ?? String(Math.min(it.q || 1, nfStack(it.name)))} aria-label=${"Stack of " + ((nfItems.items[it.name] || [it.name])[0]) + ", at most " + nfStack(it.name)} onInput=${(e) => stackInput(e, i, it)} />`)}</div>`;
			return html`<button type="button" class=${"gs ge" + (nfInv === i ? " on" : "")} data-ninv=${i} tabIndex=${iat === String(i) ? 0 : -1} aria-haspopup="dialog" aria-expanded=${nfInv === i} aria-label=${lab} ...${hi(it)} onClick=${(e) => invClick(i, e)} onFocus=${(e) => cellFocus("inv", String(i), e)}>${cell(it)}<span class="rmx" aria-hidden="true" onClick=${(e) => { e.stopPropagation(); nfInvRemove(i, false); }}>×</span></button>`;
		})}<button type="button" class="gs ge nplus" data-ninvadd="1" tabIndex=${iat === "add" ? 0 : -1} aria-haspopup="dialog" aria-expanded=${at >= 0} disabled=${full} data-tip=${full ? "the inventory is full: " + NF_ISIZE + " items, as in the game" : "add an item"}
			onClick=${() => { const same = nfPick && nfPick.slot === "inv"; if (nfInv != null) (nfInv = null), closeTip(); nfPick = same ? null : { name: nf.open, slot: "inv", q: "" }; nfFocus(same ? "[data-ninvadd]" : "[data-npq]"); }} onFocus=${(e) => cellFocus("inv", "add", e)}>+</button></div>
		${at >= 0 ? invPick(Math.floor(at / 7)) : null}${nfInv != null && items[nfInv] && nfStack(items[nfInv].name) <= 1 ? invDlg(items[nfInv]) : null}</div>`];
	const states = [["", "as composed"], ...(r.from === "template" ? [["template", "the template's"]] : []), ...(r.from === "player" ? [["pull", "as on its page"]] : NF.pulls.some((q) => q.characters.some((x) => x.name === r.name)) ? [["pull", "as pulled"]] : []), ["fresh", "a new character"]];
	// its numbers, state, CODE: label and field pairs in a grid under the sheet and inventory (numbers as text fields)
	const pair = (label, ctl) => html`<label class="nfp"><span>${label}</span>${ctl}</label>`;
	const text = (k, ph, more) => html`<input type="text" value=${r[k] || ""} placeholder=${ph} ...${more || {}} onInput=${(e) => { r[k] = e.currentTarget.value; nfPreview(); }} />`;
	const sel = (k) => (e) => { r[k] = e.currentTarget.value; change(); };
	const fields = [pair("Level", text("level", String(st.level), { inputmode: "numeric" })), pair("Gold", text("gold", String(st.gold), { inputmode: "numeric" })),
		pair("State", html`<${Select} value=${r.state} onChange=${sel("state")}>${states.map(([k, t]) => html`<option value=${k}>${t}</option>`)}</${Select}>`),
		pair("At", text("at", c.at ? c.at.map + ":" + Math.round(c.at.x) + ":" + Math.round(c.at.y) : "map:x:y")),
		pair("CODE", cpBtn("c:" + r.name, r.code, "the run's", r.name + "'s CODE set")),
		pair("Entry", html`<${Select} value=${r.entry} onChange=${sel("entry")}><option value="">${c.code && !r.entry ? c.code.entry + (c.code.entry === r.name ? " (its own)" : " (as composed)") : "its own slot"}</option>${(c.slots || []).map((x) => html`<option value=${x}>${x}</option>`)}</${Select}>`),
		pair("Account", text("account", nfAcct({ ...r, account: "" }), { list: "nfaccts", "data-tip": "the account it plays on: another account of the run, or a new name (an account of its own)" })),
		html`<label class="nfp nfpw"><span>Prelude</span><textarea rows="2" spellcheck="false" placeholder=${(c.code && c.code.prelude) || "CODE run before its entry: globals, a config object its CODE reads"} data-tip="CODE run before its entry, in its CODE (the setup's code.prelude); empty: as composed" value=${r.prelude || ""} onInput=${(e) => { r.prelude = e.currentTarget.value; nfPreview(); }}></textarea></label>`];
	return html`<div class="ned" style=${cvar(r.class)}><div class="nedg"><div class="shw">${gact}${sheet}${setBtn(r, slots, pk)}</div><div class="ivc">${inv}</div>${pk && pk.slot === "set" ? setPicker(pk, r, slots) : pk && pk.slot !== "inv" ? gearPicker(pk, r, c) : null}</div><div class="nedf">${fields}</div>${nfCp && nfCp.target === "c:" + r.name ? cpPicker() : null}</div>`;
}
// a stack's size typed (past the stack's size: its size; empty: being typed)
function stackInput(e, i, it) {
	const t = e.currentTarget, max = nfStack(it.name), id = "q|" + nf.open + "|" + i;
	if (t.value === "") return drafts.set(id, "");
	if (Number(t.value) > max) t.value = max;
	drafts.delete(id);
	const q = Math.min(max, Math.max(1, Math.floor(Number(t.value)) || 1));
	nfItemsEdit(nf.open, (xs) => { if (xs[i]) xs[i].q = q; });
	nfPreview();
}
// the sweeps' combinations: each sweep's items x each CODE set x each seed
function nfCombo() {
	const dims = nf.sweeps.filter((x) => x.specs.length).map((x) => [x.specs.length, x.specs.length + (x.slot === "set" ? " gear sets" : " " + x.slot + " items") + (nf.sweeps.some((y) => y !== x && y.slot === x.slot) ? " (" + x.name + ")" : "")]);
	if (nf.compare.length) dims.push([1 + nf.compare.length, 1 + nf.compare.length + " CODE sets"]);
	const seeds = nfSeeds().length;
	if (seeds > 1) dims.push([seeds, seeds + " seeds"]);
	return { runs: dims.reduce((n, [k]) => n * k, 1), text: dims.length > 1 ? "every combination: " + dims.map(([, t]) => t).join(" x ") : "" };
}
// an item's highest level (0: none), and a level held within it
const nfMax = (k) => ((nfItems && nfItems.items[k]) || [])[3] || 0;
const nfLv = (k, lv) => Math.min(Number(lv) || 0, nfMax(k));
// a sweep's spec of an item: at the sweep's level (as far as the item goes) and stat scroll
const nfSwSpec = (sw, k) => { const lv = nfLv(k, sw.lv), st = sw.stat && ((nfItems && nfItems.items[k]) || [])[4] ? sw.stat : ""; return k + (lv ? "+" + lv : "") + (st ? ":" + st : ""); };
// a stat scroll or a title: typed (the one called that, else the first that starts so, else the first holding it: a
// search, as the items') or picked from its list; empty: none; null: nothing matches
const nfPickOf = (vals, t) => { const q = String(t || "").trim().toLowerCase(); if (!q) return ""; return vals.find((v) => v === q) || vals.find((v) => v.startsWith(q)) || vals.find((v) => v.includes(q)) || null; };
// a stat scroll's or title's field: where (set: the slot's item, inv: the inventory's, sweep: the sweep's) and which
const cmb = (where, k, list, v, what, off) => { const id = "c|" + where + "|" + k; return html`<input type="text" class="cmb" list=${list} data-cmb=${where} data-k=${k} value=${drafts.get(id) ?? v ?? ""} placeholder=${what} aria-label=${what} autocomplete="off" disabled=${off}
	onInput=${(e) => drafts.set(id, e.currentTarget.value)} onChange=${(e) => { const t = e.currentTarget; setTimeout(() => cmbApply(t), 0); }} />`; };
// one typed or picked: the one it matches (else back as it was)
function cmbApply(t) {
	const where = t.dataset.cmb, k = t.dataset.k, id = "c|" + where + "|" + k, x = drafts.has(id) ? drafts.get(id) : t.value;
	drafts.delete(id);
	const v = nfPickOf(k === "title" ? (nfItems && nfItems.titles) || [] : (nfItems && nfItems.stats) || [], x), f = k === "title" ? "p" : "stat_type";
	if (v == null) return draw();
	if (where === "sweep") { const sw = nfPick && nfSw(nfPick.name, nfPick.slot); if (!sw) return draw(); sw.stat = v; sw.specs = sw.specs.map((y) => nfSwSpec(sw, y.replace(/[+:#].*$/, ""))); }
	else if (where === "inv") nfItemsEdit(nf.open, (xs) => { const it = xs[nfInv]; if (!it) return; v ? (it[f] = v) : delete it[f]; });
	else if (nfPick) nfGear(nfPick.name, nfPick.slot, (it) => { if (!it) return null; v ? (it[f] = v) : delete it[f]; return it; });
	change();
}
// ---- gear sets (lib/gear_sets.js, the Gear sets page): the button under the sheet (the set it wears, or how many are
// compared) opens the class's sets, each as a small sheet: a click wears it (every slot but the elixir; edited on top as
// any gear), or (Into the inventory) puts its items in the inventory, as long as they fit (the picker stays: more sets);
// Compare sets: one run per set (a click adds or removes one; the sheet's own edits give way to each); yours removed by
// their x (it asks first); the sheet saved as a set of yours
function setBtn(r, slots, pk) {
	const ws = nfWorn(r, slots), sw = nfSw(r.name, "set"), n = sw ? sw.specs.length : 0;
	return html`<button type="button" class="cb ngs" data-nslot="set" aria-haspopup="dialog" aria-expanded=${!!(pk && pk.slot === "set")} data-tip="gear sets of its class: wear one, compare them, save this sheet as one"
		onClick=${() => { const same = pk && pk.slot === "set"; nfPick = same ? null : { name: r.name, slot: "set", save: "", arm: null, msg: "", bad: false }; drafts.clear(); nfFocus(same ? '[data-nslot="set"]' : "[data-nset], [data-nsetname]"); }}>
		<span>${n ? "Comparing " + n + (n === 1 ? " gear set" : " gear sets") : html`Gear set${ws ? html`: <b>${nfSetName(ws)}</b>` : null}`}</span><i class="cv" aria-hidden="true"></i></button>`;
}
function setPicker(pk, r, slots) {
	const sets = nfSets(r.class), ws = nfWorn(r, slots), sw = nfSw(r.name, "set"), mine = (NF.gear_sets || []).find((s) => !s.builtin && s.name === String(pk.save || "").trim());
	const close = (e) => { nfPick = null; drafts.clear(); e && e.detail ? draw() : nfFocus('[data-nslot="set"]'); };
	const tell = (msg, bad) => { Object.assign(pk, { msg, bad: !!bad }); draw(); };
	const items = r.items || (nfStart(r.name) || {}).items || [], free = NF_ISIZE - items.filter(Boolean).length, inv = !sw && pk.mode === "inv";
	const count = (s) => NF_GEAR.filter((k) => s.gear[k] && s.gear[k] !== "none").length;
	// a set's items into the inventory (each upgradable one at its level, +0 when none is given)
	const putIn = (s) => {
		const add = NF_GEAR.map((k) => nfUnspec(s.gear[k] || "none")).filter(Boolean).map((it) => (nfMax(it.name) && it.level == null ? { ...it, level: 0 } : it));
		if (add.length > free) return tell(nfSetName(s) + ": " + add.length + " items, " + free + " free in the inventory", true);
		nfItemsEdit(r.name, (xs) => { for (const it of add) { const i = xs.indexOf(null); if (i >= 0) xs[i] = it; else xs.push(it); } });
		Object.assign(pk, { msg: nfSetName(s) + ": " + add.length + " items into the inventory", bad: false });
		change();
	};
	const wear = (s, e) => {
		if (inv) return putIn(s);
		if (sw) { const i = sw.specs.indexOf(s.name); i >= 0 ? sw.specs.splice(i, 1) : sw.specs.push(s.name); change(); if (!e.detail) nfFocus('[data-nset="' + CSS.escape(s.name) + '"]'); return; }
		for (const k of NF_GEAR) r.gear[k] = s.gear[k] || "none";
		nfPick = null; change();
		if (!e.detail) nfFocus('[data-nslot="set"]');
	};
	// comparing sets (with the other sweeps: every combination), the one worn first; or not
	const cmpToggle = () => {
		if (sw) nf.sweeps.splice(nf.sweeps.indexOf(sw), 1);
		else nf.sweeps.push({ name: r.name, slot: "set", specs: ws ? [ws.name] : [] });
		change(); nfFocus(sw ? ".ipk .ih .cb" : "[data-nset]");
	};
	const call = async (s, method, body) => {
		let x = null, o = {};
		try { x = await api("api/gearsets/" + encodeURIComponent(s), method, body); o = await x.json().catch(() => ({})); } catch (err) { o = { reason: err.message }; }
		return x && x.ok ? null : o.reason || "HTTP " + (x && x.status);
	};
	const del = async (s) => {
		pk.arm = null; tell("removing " + s.name + "...");
		const bad = await call(s.name, "DELETE");
		if (!bad) for (const y of nf.sweeps) if (y.slot === "set") y.specs = y.specs.filter((n) => n !== s.name);
		await nfLoad();
		if (nfPick === pk) Object.assign(pk, { msg: bad || "removed " + s.name, bad: !!bad }), nfFocus("[data-nset], [data-nsetname]");
		nfPreview();
	};
	const save = async () => {
		const n = String(pk.save || "").trim();
		if (!/^[A-Za-z0-9_-]{1,24}$/.test(n)) return tell("its name: 1-24 letters, digits, _ or -", true);
		tell("saving " + n + "...");
		const bad = await call(n, "PUT", { set: { name: n, class: r.class, gear: Object.fromEntries(NF_GEAR.map((k) => [k, nfSpec(slots[k])])) } });
		await nfLoad();
		if (nfPick !== pk) return;
		if (!bad) pk.save = "";
		tell(bad || "saved " + n, bad);
	};
	const card = (s) => {
		const on = inv ? false : sw ? sw.specs.includes(s.name) : ws === s, n = count(s), off = inv && n > free;
		return html`<div class="gsr"><button type="button" class=${"gset" + (off ? " off" : "")} role="option" data-nset=${s.name} aria-pressed=${on} aria-disabled=${off ? "true" : null} data-tip=${inv ? (off ? n + " items: " + free + " free in the inventory" : n + " items into the inventory") : null}
			aria-label=${nfSetName(s) + (on ? (sw ? " (compared)" : " (worn)") : "") + (inv ? ": " + n + " items into the inventory" + (off ? " (" + free + " free)" : "") : "")} onClick=${(e) => wear(s, e)}>
			<b>${nfSetName(s)}</b>${miniSheet(s.gear)}</button>
			${s.builtin ? null : pk.arm === s.name ? html`<button type="button" class="danger sm" data-nsetdel=${s.name} onClick=${() => del(s)}>Remove</button>` : html`<${IbX} what=${"remove your set " + s.name} onClick=${() => { pk.arm = s.name; nfFocus('[data-nsetdel="' + CSS.escape(s.name) + '"]'); }} />`}</div>`;
	};
	const group = (t, xs, note) => (xs.length ? html`<div class="gsg"><h5>${t}${note ? html` <span class="gu">${note}</span>` : null}</h5><div class="gsl" role="listbox" aria-label=${t}>${xs.map(card)}</div></div>` : null);
	const head = sw
		? html`<div class="ih"><span class="inm">${"Comparing " + sw.specs.length + (sw.specs.length === 1 ? " set" : " sets")}</span><button type="button" class="lnk sm" data-tip="back to the sheet as it is: the sets' sweep goes" onClick=${cmpToggle}>stop comparing</button><button type="button" class="go" onClick=${close}>Done</button></div>`
		: html`<div class="ih"><span class="inm">Gear sets</span>${sets.length ? [html`<span class="seg sm" role="group" aria-label="A click on a set">${[["wear", "Wears it"], ["inv", "Into the inventory"]].map(([k, t]) => html`<button type="button" aria-pressed=${(pk.mode || "wear") === k} onClick=${() => { pk.mode = k; pk.msg = ""; draw(); }}>${t}</button>`)}</span>`,
			inv ? html`<span class="gu">${free} free</span>` : null, html`<button type="button" class="cb" data-tip="one run per set, each worn in place of this sheet: a click on a set adds or removes one" onClick=${cmpToggle}>Compare sets</button>`] : null}</div>`;
	return html`<div class="ipk gear gsp" role="dialog" aria-label="Gear sets"><button type="button" class="x cls" aria-label="Close" onClick=${close}>×</button>${head}
		${group("Discord's", sets.filter((s) => s.builtin), "a community list: it may be out of date")}${group("Yours", sets.filter((s) => !s.builtin))}
		${sets.length ? null : html`<p class="hint">no sets for a ${r.class} yet: save this sheet as one</p>`}
		<div class="ift"><input type="text" data-nsetname="1" maxlength="24" value=${pk.save || ""} placeholder=${"save this sheet as: a name"} aria-label="Save this sheet as a set named" onInput=${(e) => { pk.save = e.currentTarget.value; draw(); }} />
			<button type="button" class="cb" data-tip=${mine ? "replace your set " + mine.name + (mine.class !== r.class ? " (a " + mine.class + "'s)" : "") : "a set of yours: its items, levels, stat scrolls and titles as on this sheet"} onClick=${save}>${mine ? "Replace" : "Save"}</button>
			${pk.msg ? html`<span class=${pk.bad ? "nbad" : "gu"}>${pk.msg}</span>` : null}</div></div>`;
}
// the gear picker of a slot: the item there (its red x empties the slot, the circular arrow puts back the one it starts
// with), Compare items, the close x; a search; the items that fit (api/new/fits, as the game decides: the class's own
// first, by tier and value; another class's dimmed: worn with none of its stats), each tooltip at the level there; under
// them, in a row, the level, stat scroll and title. A pick stays open for them: Enter there (or a click outside, Esc, x)
// closes it
function gearPicker(pk, r, c) {
	const st = c && c.start, slots = nfSlots(r, st), key = r.class + "|" + pk.slot + "|" + ((slots.mainhand && pk.slot === "offhand" && slots.mainhand.name) || "") + "|" + ((slots.offhand && pk.slot === "mainhand" && slots.offhand.name) || "");
	if (!nfFits.has(key)) { nfFits.set(key, null); fetch("api/new/fits?" + new URLSearchParams({ class: r.class, slot: pk.slot, mainhand: key.split("|")[2], offhand: key.split("|")[3] })).then((x) => x.json()).then((o) => { nfFits.set(key, o.items || []); draw(); }, () => nfFits.delete(key)); }
	const all = nfFits.get(key), I = (nfItems && nfItems.items) || {}, q = String(pk.q || "").toLowerCase();
	// searched: the item called that first, then the ones whose name starts so (each in the list's order)
	const hit = (k) => { const n = String((I[k] || [])[0] || "").toLowerCase(); return k === q || n === q ? 0 : n.startsWith(q) || k.startsWith(q) ? 1 : 2; };
	const list = all ? all.filter(([k]) => !q || k.includes(q) || String((I[k] || [])[0]).toLowerCase().includes(q)).map((x, i) => [x, i]).sort((a, b) => (q ? hit(a[0][0]) - hit(b[0][0]) : 0) || a[1] - b[1]).map(([x]) => x) : null;
	const sw = nfSw(r.name, pk.slot), cur = slots[pk.slot], d = cur && I[cur.name];
	const close = (e) => { nfPick = null; drafts.clear(); e && e.detail ? draw() : nfFocus('[data-nslot="' + pk.slot + '"]'); };
	// comparing items in this slot (with the other sweeps: every combination), the item there first, at its level; or not
	const cmpToggle = () => {
		const x = nfSw(pk.name, pk.slot);
		if (x) nf.sweeps.splice(nf.sweeps.indexOf(x), 1);
		else { const y = { name: pk.name, slot: pk.slot, lv: cur ? String(cur.level || 0) : "", stat: (cur && cur.stat_type) || "", specs: [] }; if (cur) y.specs.push(nfSwSpec(y, cur.name)); nf.sweeps.push(y); }
		change(); nfFocus(x ? ".ipk .ih .cb" : "[data-npq]");
	};
	const combo = sw ? nfCombo() : null;
	const head = sw
		? html`<div class="ih"><span class="inm">${"Comparing " + sw.specs.length + (sw.specs.length === 1 ? " item" : " items")}</span><button type="button" class="lnk sm" data-tip="back to one item in this slot: its sweep goes" onClick=${cmpToggle}>stop comparing</button><button type="button" class="go" onClick=${close}>Done</button></div>`
		: html`<div class="ih"><span class="gs hx" ...${cur ? hi(cur) : {}}>${cur ? [cell(cur), html`<button type="button" class="rmx" tabIndex="-1" aria-label="Empty the slot" onClick=${() => { nfGear(pk.name, pk.slot, () => null); change(); nfFocus("[data-npq]"); }}>×</button>`] : null}</span>
			${pk.slot in r.gear ? html`<${IbR} what="the item it starts with" onClick=${() => { nfGear(pk.name, pk.slot, () => undefined); change(); nfFocus("[data-npq]"); }} />` : null}<button type="button" class="cb" data-tip="one run per item in this slot: a click in the grid adds or removes one" onClick=${cmpToggle}>Compare items</button></div>`;
	const foot = sw
		? html`<div class="ift">${lvIn("sweep", Number(sw.lv) || 0, 12)}${cmb("sweep", "stat", "nf-stats", sw.stat, "stat scroll")}${combo.text ? html`<span class="nwarn">${combo.text + " = " + combo.runs + " runs"}</span>` : null}</div>`
		: cur ? html`<div class="ift">${d && d[3] ? lvIn("set", cur.level || 0, d[3]) : null}${d && d[4] ? cmb("set", "stat", "nf-stats", cur.stat_type, "stat scroll") : null}${cmb("set", "title", "nf-titles", cur.p, "title")}</div>` : null;
	// the level a cell's tooltip shows: the sweep's, else the item's there now (as far as each item goes)
	const tlv = nfLvPend ? nfLvPend.v : sw ? sw.lv : cur ? cur.level || 0 : 0, tst = sw ? sw.stat : cur && cur.stat_type;
	// a pick: comparing here, the item in or out of the sweep; else it goes in the slot at the level (and stat scroll)
	// there, the picker staying for its level, stat scroll and title (from the keyboard: the focus on the first of them)
	const pick = (k, e) => {
		const x = nfSw(pk.name, pk.slot);
		if (x) { const i = x.specs.findIndex((y) => y.replace(/[+:#].*$/, "") === k); if (i >= 0) x.specs.splice(i, 1); else x.specs.push(nfSwSpec(x, k)); change(); if (!e.detail) nfFocus('[data-npick="' + CSS.escape(k) + '"]'); return; }
		nfGear(pk.name, pk.slot, (y) => ({ name: k, level: nfLv(k, y && y.level), ...(y && y.stat_type && nfItems.items[k][4] ? { stat_type: y.stat_type } : {}), ...(y && y.p ? { p: y.p } : {}) }));
		change();
		if (!e.detail) nfFocus(".ipk .ift input");
	};
	const cells = !list ? html`<p class="hint">loading...</p>` : !list.length ? html`<p class="hint">nothing fits${q ? ' "' + pk.q + '"' : ""}</p>`
		: html`<div class="igrid" role="listbox" aria-label=${"Items for the " + pk.slot}>${list.map(([k, other]) => {
			const on = sw ? sw.specs.some((x) => x.replace(/[+:#].*$/, "") === k) : cur && cur.name === k, lv = nfLv(k, tlv);
			return html`<button type="button" class=${"gs" + (other ? " oth" : "")} role="option" tabIndex="-1" data-npick=${k} aria-pressed=${!!on} aria-label=${(I[k] || [k])[0] + (other ? " (another class: none of its stats)" : "")} ...${hi({ name: k, level: lv, stat_type: tst && I[k] && I[k][4] ? tst : "" })} data-note=${other ? "another class: worn with none of its stats" : null} onClick=${(e) => pick(k, e)}>${cell({ name: k, level: lv })}</button>`;
		})}</div>`;
	return html`<div class="ipk gear" role="dialog" aria-label=${"Items for the " + pk.slot} style=${"--r:" + Math.max(0, SHEET.findIndex((x) => x.includes(pk.slot)))}><button type="button" class="x cls" aria-label="Close" onClick=${close}>×</button>${head}
		<input type="search" data-npq="1" value=${pk.q || ""} placeholder=${"find an item for the " + pk.slot} aria-label="Find an item" onInput=${(e) => { pk.q = e.currentTarget.value; draw(); }} />${cells}${foot}</div>`;
}
// the level field: +N; the arrow keys (and its - and + buttons) step it at once and apply it once they rest; typed: a
// number (12, +12) or the game's letter (X Y Z: 10-12; a compound's V S R: 5-7), applied on Enter or on leaving it
let nfLvPend = null, nfLvTimer = null, lvSel = null;
function lvIn(kind, v, max) {
	const x = nfLvPend && nfLvPend.kind === kind ? nfLvPend.v : v, id = "lv|" + kind;
	const step = (e, dir) => { const i = e.currentTarget.parentElement.querySelector("[data-nlv]"); nfLvStep(i, dir); i.focus(); };
	return html`<span class="lvs"><button type="button" tabIndex="-1" aria-label="Level down" onClick=${(e) => step(e, -1)}>-</button><input type="text" class="lvi" role="spinbutton" data-nlv=${kind} data-max=${max} aria-label="Level" aria-valuemin="0" aria-valuemax=${max} aria-valuenow=${x} value=${drafts.get(id) ?? "+" + x}
		onInput=${(e) => drafts.set(id, e.currentTarget.value)} onChange=${(e) => { const y = nfLvParse(e.currentTarget.value, max); drafts.delete(id); setTimeout(() => (y != null ? nfLvApply(kind, y) : draw()), 0); }}
		onFocus=${(e) => { e.currentTarget.select(); lvSel = e.currentTarget; }} onMouseUp=${(e) => { if (e.currentTarget === lvSel) e.preventDefault(); lvSel = null; }} /><button type="button" tabIndex="-1" aria-label="Level up" onClick=${(e) => step(e, 1)}>+</button></span>`;
}
function nfLvParse(t, max) {
	const m = /^\+?\s*(\d{1,2}|[xyzvsr])$/i.exec(String(t).trim());
	if (!m) return null;
	const v = /\d/.test(m[1]) ? Number(m[1]) : { x: 10, y: 11, z: 12, v: 5, s: 6, r: 7 }[m[1].toLowerCase()];
	return Math.max(0, Math.min(max, v));
}
// a level to the item in the slot, the sweep's items or the inventory's item edited
function nfLvApply(kind, v) {
	clearTimeout(nfLvTimer); nfLvPend = null;
	const p = nfPick;
	if (kind === "inv") { if (nfInv == null) return draw(); nfItemsEdit(nf.open, (xs) => { if (xs[nfInv]) xs[nfInv].level = v; }); }
	else if (!p) return draw();
	else if (kind === "sweep") { const sw = nfSw(p.name, p.slot); if (!sw) return draw(); sw.lv = String(v); sw.specs = sw.specs.map((x) => nfSwSpec(sw, x.replace(/[+:#].*$/, ""))); }
	else nfGear(p.name, p.slot, (it) => (it ? ((it.level = v), it) : null));
	change();
}
function nfLvStep(input, dir) {
	const kind = input.dataset.nlv, max = Number(input.dataset.max) || 0, id = "lv|" + kind, v = Math.max(0, Math.min(max, (nfLvParse(drafts.get(id) ?? input.value, max) ?? 0) + dir));
	drafts.delete(id);
	nfLvPend = { kind, v };
	draw();
	clearTimeout(nfLvTimer); nfLvTimer = setTimeout(() => nfLvApply(kind, v), 350);
}
// the inventory's add picker, under its last row: a search over every item
function invPick(row) {
	const I = (nfItems && nfItems.items) || {}, q = String(nfPick.q || "").toLowerCase(), list = q.length < 2 ? [] : Object.keys(I).filter((k) => k.includes(q) || String(I[k][0]).toLowerCase().includes(q));
	const add = (k) => {
		const x = I[k];
		nfItemsEdit(nf.open, (xs) => { if (xs.filter(Boolean).length >= NF_ISIZE) return; const it = { name: k, ...(x[3] ? { level: 0 } : {}), ...(x[6] ? { q: 1 } : {}) }, i = xs.indexOf(null); if (i >= 0) xs[i] = it; else xs.push(it); });
		const st = nfStart(nf.open), r = nfR(nf.open);
		if ((r.items || (st && st.items) || []).filter(Boolean).length >= NF_ISIZE) nfPick = null;
		change();
	};
	return html`<div class="ipk ipi" role="dialog" aria-label="Add an item" style=${"--r:" + row}><button type="button" class="x cls" aria-label="Close" onClick=${() => { nfPick = null; nfFocus("[data-ninvadd]"); }}>×</button><div class="ih"><span class="inm">Add an item</span></div>
		<input type="search" data-npq="1" value=${nfPick.q || ""} placeholder="find an item (2+ letters)" aria-label="Find an item" onInput=${(e) => { nfPick.q = e.currentTarget.value; draw(); }} />
		${list.length ? html`<div class="igrid" role="listbox" aria-label="Items">${list.slice(0, 60).map((k) => html`<button type="button" class="gs" role="option" tabIndex="-1" aria-label=${I[k][0]} ...${hi({ name: k })} onClick=${() => add(k)}>${cell({ name: k })}</button>`)}</div>` : q.length >= 2 ? html`<p class="hint">nothing called that</p>` : null}
		${list.length > 60 ? html`<p class="hint">${list.length - 60} more: narrow the search</p>` : null}</div>`;
}
// an inventory item that doesn't stack: its level, stat scroll and title in a small column left of it, as the game's
// windows (placed by nfInvPlace)
function invDlg(it) {
	const d = (nfItems && nfItems.items[it.name]) || [];
	return html`<div class="idlg" role="dialog" aria-label=${(d[0] || it.name) + ": level, stat scroll, title"}>${d[3] ? lvIn("inv", it.level || 0, d[3]) : null}${d[4] ? cmb("inv", "stat", "nf-stats", it.stat_type, "stat scroll") : null}${cmb("inv", "title", "nf-titles", it.p, "title")}</div>`;
}
// the edited item's column beside it (inside the window), and its tooltip kept open
function nfInvPlace() {
	const pg = document.getElementById("nsim"), g = pg && pg.querySelector(".idlg"), c = nfInv != null && pg && pg.querySelector('.inv [data-ninv="' + nfInv + '"]');
	if (g && c) { const b = c.getBoundingClientRect(); g.style.left = Math.max(8, b.left - g.offsetWidth - 8) + "px"; g.style.top = Math.max(8, Math.min(innerHeight - g.offsetHeight - 8, b.top)) + "px"; }
	const T = tipState();
	if (c && !(T.tipFor === tipKey(c) && T.tipPin)) { tipPinned(true); openTip(c); } else if (c) tipPlace(c);
}
// the inventory's item edited no more: its tooltip closes; from the keyboard, the focus back on it
function nfInvClose(keys) {
	const i = nfInv;
	nfInv = null; drafts.clear(); closeTip();
	if (keys && i != null) nfFocus('[data-ninv="' + i + '"]'); else draw();
}
// an item out of the inventory (its mark, Delete or X); from the keyboard, the focus on the cell now there
function nfInvRemove(i, keys) {
	const cells = [...document.querySelectorAll("#nsim .inv > [data-ninv], #nsim .inv > [data-ninvadd]")], at = cells.findIndex((c) => c.dataset.ninv === String(i));
	nfItemsEdit(nf.open, (xs) => { xs[i] = null; });
	if (nfInv === i) (nfInv = null), closeTip();
	change();
	if (keys) nfFocus(".inv > button:not(:disabled)", () => { const now = document.querySelectorAll("#nsim .inv > button:not(:disabled)"), c = now[Math.min(at, now.length - 1)]; if (c) c.focus(); });
}
// the gear of the slot picked: its spec changed (undefined: the item as it starts)
function nfGear(name, sl, f) {
	const r = nfR(name), cur = nfSlots(r, nfStart(name))[sl];
	const it = f(cur ? { ...cur } : null);
	if (it === undefined) delete r.gear[sl]; else r.gear[sl] = nfSpec(it);
}
function nfItemsEdit(name, f) {
	const r = nfR(name), st = nfStart(name);
	if (!st) return;
	const items = r.items ? r.items.map((x) => (x ? { ...x } : null)) : st.items.map((x) => (x ? { ...x } : null));
	f(items); r.items = items;
}

// ---- CODE sets: a picker (the CODE for all, another set to compare, a character's): the sets grouped (yours, the
// library's, the live pulls), searched; a set's revisions (a git repo's branches, tags, newest commits: <set>@<rev>);
// the library's updated or removed. Add CODE (library.js, api/new/code): a link or a folder of this machine, a paste,
// files. Others' CODE runs once its version is trusted: what it is and reaches, a Trust button
const NF_LIBK = { github: "GitHub", gist: "gist", git: "git", url: "link", paste: "pasted", upload: "files", path: "folder" };
// the picker open: { target, q (its search), revs (the set whose revisions show), arm (the set its x asks to remove),
// msg }; the Add CODE row: { mode: link | paste | files, from, name, file, text, files, busy, msg, bad, target (the
// picker's that asked for it) }; a set's revisions as api/new/code answers (null: being read)
let nfCp = null, nfAc = null;
const nfRevs = new Map();
const cpBtn = (target, v, ph, what, off) => html`<button type="button" class="ncp" data-ncp=${target} aria-haspopup="dialog" aria-expanded=${!!(nfCp && nfCp.target === target)} aria-label=${what + ": " + (v || ph)} disabled=${!!off} data-tip=${off ? "pick a set for all first" : null} onClick=${() => nfCpOpen(target)}>${v ? html`<b>${v}</b>` : html`<span class="gu">${ph}</span>`}<i class="cv" aria-hidden="true"></i></button>`;
// what the target has now: a set's name, "" as composed
const nfCpCur = (target) => (target === "all" ? nf.code : target === "cmp" ? "" : (nfR(target.slice(2)) || {}).code || "");
function nfPickSet(target, v) {
	if (target === "all") { nf.code = v; nf.compare = nf.compare.filter((n) => n !== v); }
	else if (target === "cmp") { if (v && v !== nf.code && !nf.compare.includes(v)) nf.compare.push(v); }
	else { const r = nfR(target.slice(2)); if (r) r.code = v; }
}
function cpPicker() {
	const p = nfCp, raw = String(p.q || "").trim(), q = raw.toLowerCase(), cur = nfCpCur(p.target), all = NF.code_sets || [];
	const hit = (s) => !q || [s.name, s.lib && s.lib.label, s.note, s.where].some((x) => String(x || "").toLowerCase().includes(q));
	// typed: any set at a revision (local@HEAD~1), a folder or file (dir:<path>, file:<path>)
	const typed = /^(dir|file):\S|^[\w.:-]+@\S+$/.test(raw) && !all.some((s) => s.name === raw) ? raw : null;
	const choose = (v) => { const tg = p.target; nfPickSet(tg, v); nfCp = null; change(); nfFocus('.ncp[data-ncp="' + CSS.escape(tg) + '"]'); };
	const pick = (v, inner, tip, two) => html`<button type="button" class=${"ncpn" + (two ? " two" : "")} data-ncpick=${v} aria-pressed=${v === cur} data-tip=${tip || null} onClick=${() => choose(v)}>${inner}</button>`;
	// a library set fetched again (Update) or removed (its x asks first)
	const libAct = async (n, act) => {
		Object.assign(p, { msg: (act === "update" ? "fetching " : "removing ") + n + "...", bad: false, arm: null }); draw();
		let r = null, o = {};
		try { r = await api("api/new/code", "POST", { action: act, name: n }); o = await r.json().catch(() => ({})); } catch (x) { o = { reason: x.message }; }
		nfRevs.delete(n);
		if (r && r.ok && act === "remove") { if (nf.code.split("@")[0] === n) nf.code = ""; nf.compare = nf.compare.filter((x) => x.split("@")[0] !== n); for (const x of nf.roster) if (x.code.split("@")[0] === n) x.code = ""; }
		const msg = !r || !r.ok ? o.reason || "HTTP " + (r && r.status) : act === "remove" ? "removed " + n : o.why ? n + ": " + o.why : o.moved ? n + ": " + o.was.slice(0, 7) + " -> " + o.commit.slice(0, 7) + " (" + o.count + (o.count === 1 ? " commit" : " commits") + ")" : n + ": up to date at " + o.commit.slice(0, 7);
		await nfLoad();
		if (nfCp === p) Object.assign(p, { msg, bad: !r || !r.ok }), draw();
		nfPreview();
	};
	const row = (s) => {
		const L = s.lib && s.lib.kind !== "path" ? s.lib : null, git = !!(L || (s.group !== "pulls" && s.kind !== "pull"));
		const kind = s.lib ? NF_LIBK[s.lib.kind] || s.lib.kind : s.kind === "pull" ? "pull" : (s.kind === "file" ? "file" : "folder") + (s.build ? ", built" : "");
		const where = s.lib ? (s.lib.kind === "paste" || s.lib.kind === "upload" ? s.lib.sub || "" : s.lib.label + (s.lib.sub ? " " + s.lib.sub : "")) : s.group === "pulls" ? s.where : s.note || s.where;
		const rev = L ? L.commit.slice(0, 7) + (L.ref && L.follows !== "commit" ? " " + L.ref : "") : "";
		const meta = [rev, s.at ? ago(s.at) : "", s.files != null ? s.files + (s.files === 1 ? " slot" : " slots") : ""].filter(Boolean).join(", ");
		const inner = [html`<span class="ncp1"><b>${s.name}</b><span class="gu">${kind}</span>${L && !L.trusted ? html`<span class="ncpu">not trusted</span>` : null}</span>`, html`<span class="ncp2">${[where, meta].filter(Boolean).join(", ")}</span>`];
		const tip = [s.lib ? s.lib.web : s.where, s.note && s.note !== (s.lib && s.lib.web) ? s.note : "", L && !L.trusted ? "not trusted yet: the form asks before it runs" : ""].filter(Boolean).join("; ");
		return [html`<div class="ncpr">${pick(s.name, inner, tip, true)}
			${git ? html`<button type="button" class="ib ncpv" aria-expanded=${p.revs === s.name} aria-label=${"Revisions of " + s.name} data-tip="a revision of it: a branch, tag or commit" onClick=${() => { nfCpRevs(s.name); draw(); }}>@</button>` : null}
			${L && L.kind !== "paste" && L.kind !== "upload" ? html`<button type="button" class="lnk sm" data-tip=${L.kind === "url" ? "download it again" : "fetch it again and pin the newest commit of " + (L.follows === "commit" ? "(a link to a commit: none)" : L.follows + " " + L.ref)} onClick=${() => libAct(s.name, "update")}>Update</button>` : null}
			${!s.lib ? null : p.arm === s.name ? html`<button type="button" class="danger sm" data-ncpdel2=${s.name} onClick=${() => libAct(s.name, "remove")}>Remove</button>` : html`<${IbX} what=${"remove " + s.name + " from the library" + (s.lib.kind === "paste" || s.lib.kind === "upload" ? " (its CODE goes with it)" : "")} onClick=${() => { p.arm = s.name; nfFocus('[data-ncpdel2="' + CSS.escape(s.name) + '"]'); }} />`}</div>`,
			p.revs === s.name ? revs(s, pick) : null];
	};
	const groups = [["yours", "Your sets"], ["others", "Library"], ["pulls", "Live pulls"], ["builtin", "ChronAL's"]].map(([g, t]) => { const xs = all.filter((s) => s.group === g && hit(s)); return xs.length ? html`<div class="ncpg"><h5>${t}</h5>${xs.map(row)}</div>` : null; }).filter(Boolean);
	const none = p.target === "cmp" || q ? null : html`<div class="ncpr">${pick("", html`<span class="gu">${p.target === "all" ? nfDefCode() : "the run's"}</span>`)}</div>`;
	return html`<div class="ncpk" role="dialog" aria-label="CODE sets"><button type="button" class="x cls" aria-label="Close" onClick=${() => nfCpOpen(p.target)}>×</button>
		<input type="search" data-ncpq="1" value=${p.q || ""} placeholder="find a set; or type set@rev, dir:/a/folder" aria-label="Find a CODE set" onInput=${(e) => { p.q = e.currentTarget.value; draw(); }} />
		<div class="ncpl">${typed ? html`<div class="ncpr">${pick(typed, [html`<b>${typed}</b>`, html`<span class="gu">as typed</span>`])}</div>` : null}${none}${groups.length ? groups : html`<p class="hint">no set holds "${raw}"</p>`}</div>
		<div class="ncpf"><button type="button" class="cb" onClick=${() => { const tg = nfCp ? nfCp.target : "all"; nfCp = null; nfAc = { mode: "link", target: tg }; nfFocus('[data-nac="from"]'); }}>Add CODE</button>${p.msg ? html`<span class=${p.bad ? "nbad" : "gu"}>${p.msg}</span>` : null}</div></div>`;
}
// a set's revisions under it, each a pick (<set>@<rev>): its branches, tags, newest commits (the library's: whether each
// is trusted)
function revs(s, pick) {
	const o = nfRevs.get(s.name);
	if (!o) return html`<p class="hint ncpvs">reading its revisions...</p>`;
	if (o.reason) return html`<p class="nbad ncpvs">${o.reason}</p>`;
	const R = o.revisions || {}, pin = s.lib && s.lib.commit, no = (x) => (x.trusted ? html`<span class="ncpt">trusted</span>` : null);
	const xs = [...(R.branches || []).map((x) => pick(s.name + "@" + x.name, [html`<b>${x.name}</b>`, html`<span class="gu">${"branch, " + x.commit.slice(0, 7)}</span>`, no(x)])),
		...(R.tags || []).map((x) => pick(s.name + "@" + x.name, [html`<b>${x.name}</b>`, html`<span class="gu">tag</span>`, no(x)])),
		...(R.commits || []).map((x) => pick(s.name + "@" + x.commit.slice(0, 7), [html`<b>${x.commit.slice(0, 7)}</b>`, html`<span class="gu">${x.date.slice(0, 10) + (x.commit === pin ? ", pinned" : "")}</span>`, html`<span class="ncpw">${x.subject}</span>`, no(x)]))];
	return xs.length ? html`<div class="ncpvs">${xs}</div>` : html`<p class="hint ncpvs">not in a git repository: no revisions</p>`;
}
// the picker below its button (above it when there's more room there), inside the window
function nfCpPlace() {
	const pg = document.getElementById("nsim"), g = pg && pg.querySelector(".ncpk"), b = nfCp && pg && pg.querySelector('.ncp[data-ncp="' + CSS.escape(nfCp.target) + '"]');
	if (!g || !b) return;
	const r = b.getBoundingClientRect(), w = Math.min(600, innerWidth - 16), below = innerHeight - r.bottom - 12, above = r.top - 12;
	g.style.width = w + "px"; g.style.left = Math.max(8, Math.min(innerWidth - w - 8, r.left)) + "px";
	if (below >= 260 || below >= above) Object.assign(g.style, { top: r.bottom + 4 + "px", bottom: "", maxHeight: Math.max(180, below) + "px" });
	else Object.assign(g.style, { top: "", bottom: innerHeight - r.top + 4 + "px", maxHeight: Math.max(180, above) + "px" });
}
function nfCpOpen(target) {
	nfCp = nfCp && nfCp.target === target ? null : { target, q: "", revs: null, arm: null, msg: "" };
	nfFocus(nfCp ? "[data-ncpq]" : '.ncp[data-ncp="' + CSS.escape(target) + '"]');
}
function nfCpRevs(name) {
	nfCp.revs = nfCp.revs === name ? null : name;
	if (nfCp.revs && !nfRevs.has(name)) { nfRevs.set(name, null); fetch("api/new/code?set=" + encodeURIComponent(name)).then((r) => r.json()).then((o) => { nfRevs.set(name, o); draw(); }, (e) => { nfRevs.set(name, { reason: e.message }); draw(); }); }
}
// Add CODE: from a link or a folder, a paste, files; its name (empty: from where it comes)
function acPanel() {
	const a = nfAc, kb = (n) => Math.max(1, Math.round(n / 1024)) + " KB", set = (k) => (e) => (a[k] = e.currentTarget.value);
	const seg = html`<span class="seg sm" role="group" aria-label="Add CODE from">${[["link", "A link or folder"], ["paste", "Paste"], ["files", "Files"]].map(([k, t]) => html`<button type="button" aria-pressed=${a.mode === k} onClick=${() => { Object.assign(a, { mode: k, msg: "", bad: false }); draw(); }}>${t}</button>`)}</span>`;
	const name = html`<input type="text" class="nacn" data-nac="name" maxlength="40" value=${a.name || ""} placeholder="its name" aria-label="Its name" data-tip="the CODE set's name; empty: from where it comes. A paste or files under the name of one: a new version of it" onInput=${set("name")} />`;
	const go = html`<button type="button" class="cb" disabled=${!!a.busy} onClick=${nfAcGo}>${a.busy ? "Adding..." : "Add"}</button>`;
	const files = async (e) => { const t = e.currentTarget, f = await nfAcRead([...t.files]); t.value = ""; Object.assign(a, { files: f, skipped: f.skipped, msg: f.files.length ? "" : "none of them JS, TS, JSON or text", bad: !f.files.length }); draw(); };
	const body = a.mode === "link" ? html`<input type="text" class="nacl" data-nac="from" value=${a.from || ""} placeholder="https://github.com/... (a repo, folder or file), a gist, a raw file; or /a/folder/here" aria-label="A link, or a folder or file of this machine" data-tip="a link is fetched and pinned to its commit (Update fetches newer ones); a folder or file of this machine is read where it is, as it is when a run starts" onInput=${set("from")} />`
		: a.mode === "paste" ? html`<input type="text" class="nacf" data-nac="file" value=${a.file || "main.js"} aria-label="Its file's name" data-tip="its file's name: the slot it runs as" onInput=${set("file")} />`
		: [html`<label class="cb">Choose files<input type="file" multiple hidden onChange=${files} /></label>`, html`<label class="cb">A folder<input type="file" webkitdirectory hidden onChange=${files} /></label>`, html`<span class="gu">${a.files ? a.files.files.length + (a.files.files.length === 1 ? " file, " : " files, ") + kb(a.files.bytes) + (a.skipped ? ", " + a.skipped + " left out" : "") : "JS, TS, JSON, text"}</span>`];
	return html`<div class="nadc"><${KRow} label="">${seg}<${IbX} what="close: add nothing" onClick=${() => { nfAc = null; nfFocus("[data-nacopen]"); }} /></${KRow}><${KRow} label="">${body}${name}${go}</${KRow}>
		${a.mode === "paste" ? html`<${KRow} label=""><textarea class="nact" rows="6" spellcheck="false" placeholder="its CODE" aria-label="Its CODE" value=${a.text || ""} onInput=${set("text")}></textarea></${KRow}>` : null}
		${a.msg ? html`<${KRow} label=""><span class=${a.bad ? "nbad" : "gu"}>${a.msg}</span></${KRow}>` : null}</div>`;
}
// the files chosen, as text: JS, TS, JSON and text files up to 2 MB each (node_modules, .git left out), 500 and 8 MB in all
async function nfAcRead(list) {
	const files = [];
	let bytes = 0, skipped = 0;
	for (const f of list) {
		const p = f.webkitRelativePath || f.name;
		if (/(^|\/)(node_modules|\.git)\//.test(p) || !/\.(m?js|cjs|tsx?|json|md|txt)$/i.test(p) || f.size > 2 << 20 || files.length >= 500 || bytes + f.size > 8 << 20) { skipped++; continue; }
		files.push({ path: p, text: await f.text() }); bytes += f.size;
	}
	return { files, bytes, skipped };
}
async function nfAcGo() {
	const a = nfAc, body = { action: "add", ...(a.name && a.name.trim() ? { name: a.name.trim() } : {}) };
	if (a.mode === "link") body.from = String(a.from || "").trim();
	else if (a.mode === "paste") body.paste = { text: a.text || "", file: String(a.file || "main.js").trim() };
	else body.files = a.files ? a.files.files : [];
	if ((a.mode === "link" && !body.from) || (a.mode === "paste" && !body.paste.text.trim()) || (a.mode === "files" && !body.files.length)) { a.msg = a.mode === "link" ? "a link, or a folder or file of this machine" : a.mode === "paste" ? "its CODE" : "choose files or a folder"; a.bad = true; return draw(); }
	Object.assign(a, { busy: true, bad: false, msg: a.mode === "link" ? "fetching..." : "adding..." }); draw();
	let r = null, o = {};
	try { r = await api("api/new/code", "POST", body); o = await r.json().catch(() => ({})); } catch (e) { o = { reason: e.message }; }
	if (nfAc !== a) return;
	a.busy = false;
	if (!r || !r.ok) { Object.assign(a, { msg: o.reason || "HTTP " + (r && r.status), bad: true }); return draw(); }
	nfRevs.delete(o.name);
	await nfLoad();
	nfPickSet(a.target || "all", o.name);
	nfOut = say((o.added ? "Added " : "A new version of ") + o.name + (o.commit ? " at " + o.commit.slice(0, 7) : "") + (a.target && a.target.startsWith("c:") ? ", for " + a.target.slice(2) : a.target === "cmp" ? ", to compare" : ", the CODE for all"));
	nfAc = null; draw(); nfPreview(0);
}
// others' CODE in the run at a version not trusted here: what it is (a link to read that version), who runs it, what its
// files reach (chips: their calls on hover), a Trust button; where it runs (risk)
function trustSec() {
	const us = (nfp && nfp.untrusted) || [];
	if (!us.length) return null;
	const xs = (l) => l.map((x) => x.what + (x.n > 1 ? " x" + x.n : "")).join(", "), at = (l) => l.flatMap((x) => x.at).join(", ");
	const trust = async (u) => {
		let r = null, o = {};
		try { r = await api("api/new/code", "POST", { action: "trust", name: u.name, commit: u.commit }); o = await r.json().catch(() => ({})); } catch (x) { o = { reason: x.message }; }
		nfOut = r && r.ok ? say("Trusted " + u.name + " at " + u.commit.slice(0, 7)) : say(o.reason || "HTTP " + (r && r.status), true);
		nfRevs.delete(u.name); await nfLoad(); nfPreview();
	};
	const rows = us.map((u) => {
		const s = u.scan || {}, k = (text, cls, tip) => html`<${KChip} text=${text} cls=${cls} tip=${tip} />`;
		const chips = s.error ? [k("not read: " + s.error, "warn")] : [
			s.network && s.network.length ? k("network: " + xs(s.network), "warn", "calls that reach other servers: " + at(s.network)) : k("no network calls", "", "none of fetch, XMLHttpRequest, WebSocket, $.ajax, import() ... in its files (a call made of text as it runs isn't seen)"),
			s.hosts && s.hosts.length ? k("servers: " + s.hosts.map((x) => x.host).join(", "), "warn", "the servers its files name") : null,
			s.code && s.code.length ? k("runs text as code: " + xs(s.code), "warn", "code it makes as it runs (what that does isn't seen): " + at(s.code)) : null,
			s.node && s.node.length ? k("Node: " + xs(s.node), "bad", "Node's modules: files, processes and the network of this machine, in >>: " + at(s.node)) : null,
			...(s.build || []).map((b) => k("build: " + b, "warn", "a build step its files may need: not run here, its files run as they are")),
			s.unread && s.unread.length ? k(s.unread.length + " not read", "warn", s.unread.join("; ")) : null,
			s.js != null ? html`<span class="gu">${s.js + (s.js === 1 ? " JS file" : " JS files") + ", " + Math.max(1, Math.round(s.bytes / 1024)) + " KB"}</span>` : null,
		];
		const where = u.view ? html`<a class="ncpw" href=${u.view} target="_blank" rel="noopener noreferrer" data-tip=${"read it at this version: " + u.view}>${u.label || u.web}</a>` : html`<span class="ncpw">${u.label || u.web || ""}</span>`;
		return html`<div class="ntr"><${KRow} label=""><b>${u.name}</b><span class="gu">${u.commit ? u.commit.slice(0, 7) : ""}</span>${where}<span class="gu">${"for " + u.who.join(", ")}</span>
			${u.commit ? html`<button type="button" class="cb" onClick=${() => trust(u)}>Trust ${u.commit.slice(0, 7)}</button>` : html`<span class="nbad">${"read at a commit: pick " + u.name + " in the CODE picker"}</span>`}</${KRow}><${KRow} label="">${chips}</${KRow}></div>`;
	});
	return html`<section class="nsec ntrs"><div class="frow"><span class="fl">Others' CODE</span><span class="gu">${"runs once you trust its version. " + (nfp.risk || "")}</span></div>${rows}</section>`;
}
// ---- the CODE for all (and sets to compare it with), Add CODE; the names of characters in the CODE and who each is in
// the run; others' CODE fitted; the party
function codeSec(v) {
	const cprob = NF.code_set_problems.map((x) => html`<${KChip} text=${x} cls="warn" />`);
	const lists = [html`<datalist id="nftop">${(nfTop || []).map((x) => html`<option value=${x.name}>${x.class + " L" + x.level}</option>`)}</datalist>`,
		html`<datalist id="nfaccts">${[...new Set(nf.roster.map(nfAcct))].map((k) => html`<option value=${k}></option>`)}</datalist>`,
		...["stats", "titles"].map((k) => html`<datalist id=${"nf-" + k}>${((nfItems && nfItems[k]) || []).map((x) => html`<option value=${x}></option>`)}</datalist>`)];
	const fighters = nf.roster.filter((r) => r.on !== "out");
	const party = [html`<${KRow} label="Party"><span class="seg sm" role="group" aria-label="Party">${[["auto", "As composed"], ["custom", "Choose"], ["none", "None"]].map(([k, t]) => html`<button type="button" aria-pressed=${nf.party === k} onClick=${() => {
			nf.party = k;
			if (k === "custom" && !nf.members.length) { nf.members = v && v.party ? [...v.party.members] : nf.roster.filter((r) => r.on !== "out" && r.class !== "merchant").map((r) => r.name); nf.leader = nf.members[0] || ""; }
			change(); }}>${t}</button>`)}</span>
			${nf.party === "auto" ? html`<span class="gu">${v ? (v.party ? v.party.members.join(", ") + " (" + (v.party.form === "code" ? "their CODE forms it" : v.party.form) + ")" : "no party") : ""}</span>` : null}</${KRow}>`,
		nf.party === "custom" ? [html`<${KRow} label="">${fighters.map((r) => html`<label class="opt"><input type="checkbox" checked=${nf.members.includes(r.name)} onChange=${(e) => { const n = r.name; nf.members = e.currentTarget.checked ? [...new Set([...nf.members, n])] : nf.members.filter((x) => x !== n); if (!nf.members.includes(nf.leader)) nf.leader = nf.members[0] || ""; change(); }} />${r.name}</label>`)}</${KRow}>`,
			html`<${KRow} label="Leader"><${Select} aria-label="Leader" value=${nf.leader} onChange=${(e) => { nf.leader = e.currentTarget.value; nfPreview(); }}>${nf.members.map((n) => html`<option value=${n}>${n}</option>`)}</${Select}>
				<${Select} aria-label="Formed by" value=${nf.pform} onChange=${(e) => { nf.pform = e.currentTarget.value; nfPreview(); }}><option value="code">their CODE forms it</option><option value="harness">the run invites</option></${Select}></${KRow}>`] : null];
	return html`<section class="nsec">${lists}<${KRow} label="CODE">${cpBtn("all", nf.code, nfDefCode(), "The CODE set for all")}<span class="gu">vs</span>
		${nf.compare.map((n, i) => html`<span class="chip">${n}<button type="button" class="x" aria-label=${"Compare no more with " + n} onClick=${() => { nf.compare.splice(i, 1); change(); }}>×</button></span>`)}
		${cpBtn("cmp", "", "another set", "Compare with another set", !nf.code)}<button type="button" class="cb" data-nacopen="1" aria-expanded=${!!nfAc} data-tip="others' CODE, or yours from elsewhere: a GitHub repo, folder or file, a gist, a raw file's link, pasted CODE, files or a folder of this machine" onClick=${() => { nfAc = nfAc ? null : { mode: "link", target: "all" }; nfFocus(nfAc ? '[data-nac="from"]' : "[data-nacopen]"); }}>Add CODE</button>${cprob}</${KRow}>
		${nfAc ? acPanel() : null}${nfCp && !nfCp.target.startsWith("c:") ? cpPicker() : null}${names(v)}${fit(v)}${party}</section>`;
}
// the names of characters in the CODE and who each is in the run (compose.js namesOf), under the CODE row, when one is
// mapped, chosen or found passed as a name (send_cm, ...): a row per name not in the run (as composed, unchanged, or a
// character of the run); the strings that may be meant as a mapped name, and the files not read, as chips
function names(v) {
	const nm = v && v.names;
	if (!nm) return null;
	const list = nm.names.filter((x) => x.why !== "in the run"), WHY = { inside: "holds", case: "holds in another case", part: "a part of" };
	if (!list.some((x) => x.to !== x.name || x.why === "chosen" || x.ctx) && !nm.flags.length && !nm.errors.length) return null;
	const ro = nf.roster.filter((r) => r.on !== "out");
	const rows = list.map((x, i) => {
		const set = Object.hasOwn(nf.cnames, x.name) ? nf.cnames[x.name] : "";
		const opts = [["", set ? "as composed" : (x.to === x.name ? "unchanged" : x.to) + " (" + x.why + ")"], ...(set || x.to !== x.name ? [[x.name, "unchanged"]] : []), ...ro.filter((r) => r.name !== x.name).map((r) => [r.name, r.name + " (" + r.class + ")"])];
		const tip = x.name + (x.class ? ", a " + x.class : "") + (x.of ? " of the " + x.of : "") + (x.ctx ? ", passed to " + x.ctx.join(", ") : "") + ": " + x.count + (x.count === 1 ? " time" : " times") + " in the CODE";
		return html`<${KRow} label=${i ? "" : "Names"}><span class="ncn" data-tip=${tip}><b>${x.name}</b>${x.class ? html`<span class="gu">${x.class}</span>` : null}</span><span class="gu">as</span>
			<${Select} aria-label=${x.name + " in the run"} value=${set} onChange=${(e) => { const y = e.currentTarget.value; if (y) nf.cnames[x.name] = y; else delete nf.cnames[x.name]; change(); }}>${opts.map(([k, t]) => html`<option value=${k}>${t}</option>`)}</${Select}></${KRow}>`;
	});
	const ft = (f) => f.where + ":" + f.line + " " + f.text, k = (text, tip) => html`<${KChip} text=${text} cls="warn" tip=${tip} />`;
	const chips = [...nm.flags.slice(0, 6).map((f) => k(ft(f), "may be meant as " + f.name + " (" + WHY[f.why] + " it): not mapped. A name inside a longer string, in another case, or built as the CODE runs")),
		nm.flags.length > 6 ? k(nm.flags.length - 6 + " more", nm.flags.slice(6).map((f) => ft(f) + " (" + WHY[f.why] + " " + f.name + ")").join("; ")) : null, ...nm.errors.slice(0, 3).map((e) => k(e, e + ": not read, its names are not mapped")),
		nm.errors.length > 3 ? k(nm.errors.length - 3 + " more not read", nm.errors.slice(3).join("; ")) : null].filter(Boolean);
	return [rows, chips.length ? html`<${KRow} label=${list.length ? "" : "Names"}><span class="gu">may not be mapped</span>${chips}</${KRow}>` : null];
}
// others' CODE fitted (compose.js fitsOf, fit.js), under the Names rows: the entry guessed for a character (by its name
// or class: another slot, idle or out); per CODE of the library, what its load_code / require_code calls load (a number
// or name no slot has: a slot, or nothing; the ones its files' names fit folded), what an entry runs first (helpers it
// calls: a slot's x takes it out, + adds one), its ES modules (bundled), the slots built as it runs (not fitted)
const nfFitOpen = new Set();
// a fit chosen for the library's CODE (api/new/code "fit"), then the form again
async function nfFitSet(lib, b) {
	let r = null, o = {};
	try { r = await api("api/new/code", "POST", { action: "fit", name: lib, ...b }); o = await r.json().catch(() => ({})); } catch (x) { o = { reason: x.message }; }
	if (!(r && r.ok)) nfOut = say(o.reason || "HTTP " + (r && r.status), true);
	change();
}
const missSet = (n, v) => { nf.missing[n] = v; change(); };
function fit(v) {
	if (!v) return null;
	const rows = [], lbl = () => (rows.length ? "" : "Fit"), opt = (val, t) => html`<option value=${val}>${t}</option>`;
	for (const g of v.guessed || [])
		rows.push(html`<${KRow} label=${lbl()}><b>${g.name}</b><span class="gu">runs</span><${Select} aria-label=${g.name + "'s entry slot"} value="" onChange=${(e) => e.currentTarget.value && missSet(g.name, "slot:" + e.currentTarget.value)}>${opt("", g.slot + " (" + g.why + ")")}${g.slots.filter((x) => x !== g.slot).map((x) => opt(x, x))}</${Select}>
			<button type="button" class="cb" onClick=${() => missSet(g.name, "idle")}>Idle</button><button type="button" class="cb" onClick=${() => missSet(g.name, "exclude")}>Leave it out</button></${KRow}>`);
	for (const f of v.fits || []) {
		const call = (c) => c.fn + "(" + (c.number ? c.key : JSON.stringify(c.key)) + ")", at = (c) => c.where.slice(0, 3).join(", ") + (c.where.length > 3 ? ", ..." : "");
		const sel = (c) => html`<${Select} aria-label=${call(c) + " loads"} value="" onChange=${(e) => { const x = e.currentTarget.value; if (x) nfFitSet(f.lib, { calls: { [c.key]: x === "-" ? null : x } }); }}>
			${c.why === "chosen" ? [opt("", (c.to === null ? "nothing" : c.to) + " (chosen)"), opt("auto", "as suggested")] : c.to === undefined ? opt("", "load which slot?") : opt("", c.to + " (" + c.why + ")")}
			${c.to === null && c.why === "chosen" ? null : opt("-", "nothing (skip the call)")}${f.slots.filter((x) => x !== c.to).map((x) => opt(x, x))}</${Select}>`;
		const crow = (c) => html`<${KRow} label=${lbl()}><span class="ncn" data-tip=${call(c) + " at " + at(c)}><b>${call(c)}</b></span><span class="gu">loads</span>${sel(c)}${c.to === undefined ? html`<span class="nbad">${c.why}</span>` : null}</${KRow}>`;
		const open = f.calls.filter((c) => c.to === undefined || c.why === "chosen"), auto = f.calls.filter((c) => !(c.to === undefined || c.why === "chosen")), unfold = nfFitOpen.has(f.lib);
		const k = (text, cls, tip) => html`<${KChip} text=${text} cls=${cls} tip=${tip} />`;
		const head = [html`<b>${f.lib}</b>`, auto.length ? html`<button type="button" class="cb" aria-expanded=${unfold} data-tip=${auto.map((c) => call(c) + " loads " + c.to + " (" + c.why + ")").join("; ")} onClick=${() => { unfold ? nfFitOpen.delete(f.lib) : nfFitOpen.add(f.lib); draw(); }}>${auto.length + (auto.length === 1 ? " call fitted" : " calls fitted") + " by file names"}</button>` : null,
			...f.modules.map((m) => k(m + ": an ES module, bundled", "", m + " imports what it runs (import, export): bundled into one script with what it imports (its folder's files; a package's or a link's are not)")),
			...f.dynamic.slice(0, 3).map((d) => k(d.where + ":" + d.line + " " + d.text, "warn", "loads a slot named or numbered as the CODE runs: not fitted (a number fails in the sims, which know slots by name)")), f.dynamic.length > 3 ? k(f.dynamic.length - 3 + " more loads built as it runs", "warn", f.dynamic.slice(3).map((d) => d.where + ":" + d.line + " " + d.text).join("; ")) : null,
			...f.errors.slice(0, 2).map((e) => k(e, "warn", e + ": not read, nothing in it fitted"))];
		if (!open.length && !auto.length && !f.with.length && !f.modules.length && !f.dynamic.length && !f.errors.length) continue;
		rows.push(html`<${KRow} label=${lbl()}>${head}</${KRow}>`);
		for (const c of [...open, ...(unfold ? auto : [])]) rows.push(crow(c));
		for (const w of f.with) {
			const add = f.slots.filter((x) => x !== w.entry && !w.slots.includes(x));
			rows.push(html`<${KRow} label=${lbl()}><b>${w.entry}</b><span class="gu">runs first</span>${w.slots.length ? null : html`<span class="gu">nothing</span>`}
				${w.slots.map((x) => html`<span class="chip">${x}<button type="button" class="x" aria-label=${w.entry + " runs " + x + " first no more"} onClick=${() => nfFitSet(f.lib, { with: { [w.entry]: w.slots.filter((y) => y !== x) } })}>×</button></span>`)}
				${add.length ? html`<${Select} aria-label=${"a slot " + w.entry + " runs first"} value="" onChange=${(e) => { const x = e.currentTarget.value; if (x) nfFitSet(f.lib, { with: { [w.entry]: [...w.slots, x] } }); }}>${opt("", "+ a slot")}${add.map((x) => opt(x, x))}</${Select}>` : null}
				<span class="gu">${w.why === "chosen" ? "chosen" : w.why}</span>${w.why === "chosen" ? html`<button type="button" class="cb" onClick=${() => nfFitSet(f.lib, { with: { [w.entry]: "auto" } })}>As suggested</button>` : null}</${KRow}>`);
		}
	}
	return rows;
}
// the bar's chip for others' CODE's calls of a slot it has none of (Fit rows)
function fitChip(vs) {
	const open = [...new Set(vs.flatMap((x) => (x.fits || []).flatMap((f) => f.calls.filter((c) => c.to === undefined).map((c) => f.lib + ": " + c.fn + "(" + (c.number ? c.key : JSON.stringify(c.key)) + ")"))))];
	return open.length ? html`<${KChip} text=${open.length + (open.length === 1 ? " call to fit" : " calls to fit")} cls="warn" tip=${"load_code / require_code of a slot its CODE has none of: the run fails there (Fit, above: a slot, or nothing): " + open.join("; ")} />` : null;
}

// ---- the run: duration and seeds; when (start, what it crosses, seasons, events); the world; the rest under Advanced
// (folded: what differs from the defaults, the storage keys set and the steps): warm-up, ping, world age, the storage
// and the steering, check every, until
const field = (label, k, ph, tip) => html`<${KRow} label=${label} id=${"nf-" + k}><input type="text" id=${"nf-" + k} value=${nf[k] || ""} placeholder=${ph != null && ph !== "" ? String(ph) : null} data-tip=${tip || null} onInput=${(e) => { nf[k] = e.currentTarget.value; nfOut = null; nfPreview(); }} /></${KRow}>`;
function runSec(v) {
	const sr = nfSteerRows(v), A = (v && v.accounts) || {}, skeys = [...new Set([...Object.values(A).flatMap((a) => [...Object.keys(a.storage || {}), ...Object.keys(a.local_storage || {})]), ...Object.keys(nf.store).map((id) => id.split("\u0001")[2])])];
	const sum = [nf.check && "checks every " + nf.check, nf.warmup && "warm-up " + nf.warmup, nf.ping && "ping " + nf.ping, nf.wage && "world age " + nf.wage, skeys.length && "storage " + skeys.join(", "), sr.length && sr.length + (sr.length === 1 ? " step" : " steps"), (nf.until || (v && v.run && v.run.until)) && "until " + (nf.until || v.run.until)].filter(Boolean);
	const fighters = nf.roster.filter((r) => r.on !== "out"), set = (k) => (e) => { nf[k] = e.currentTarget.value; nfOut = null; nfPreview(); };
	return html`<section class="nsec">
		<${KRow} label="Duration" id="nf-duration"><${KDur} cur=${nf.duration} list=${PRESETS} onPick=${(x) => { nf.duration = x; change(); }} /><input type="text" id="nf-duration" value=${nf.duration} placeholder="30m" data-tip="game time measured: 90s, 30m, 2h, 1d" onInput=${set("duration")} /></${KRow}>
		<${KRow} label="Seed" id="nf-seed"><input type="number" class="sn" id="nf-seed" min="1" step="1" value=${nf.seed} data-tip="the same seed and CODE give the same run" onInput=${set("seed")} />
			<label for="nf-runs">Runs</label><input type="number" class="sn" id="nf-runs" min="1" max="50" step="1" value=${nf.runs} data-tip="a run for each seed from this one up (the same setup: a group in the list)" onInput=${set("runs")} /></${KRow}>
		<${KRow} label=""><label class="opt" data-tip="a recording of each character, to watch the run afterwards on its page (Replay): about 10 MB per fighter per game hour; a run is ~3% slower"><input type="checkbox" checked=${!!nf.record} onChange=${(e) => { nf.record = e.currentTarget.checked; draw(); }} />Record a replay</label></${KRow}>
		${when(v)}${world()}<${KAdv} open=${!!nf.adv} sum=${sum} none="defaults" onToggle=${() => { nf.adv = !nf.adv; draw(); }} />
		${!nf.adv ? null : [field("Warm-up", "warmup", v && v.run ? v.run.warmup : "0m", "game time with the characters online before measuring"), field("Ping", "ping", v && v.world ? v.world.ping : 18, "ms round trip to the server"),
			field("World age", "wage", v && v.world ? v.world.age : "0m", "the server runs this long with nobody in it first"), store(v),
			field("Check every", "check", v && v.run ? v.run.check : "1s", "game time between checks of the conditions (the steps' and Until): 100ms to 10m; 1s costs a run nothing measurable, 100ms about 5-8%"),
			html`<${KRow} label="Until" id="nf-until"><input type="text" class="ncode" id="nf-until" value=${nf.until || ""} placeholder=${(v && v.run && v.run.until) || "a condition: the run ends once it holds"} data-tip="the run ends once this holds (checked as often as Check every says, in the measured part), as a step's condition: t is game s since the warm-up; empty: as composed" onInput=${set("until")} />
				<button type="button" class="cb" aria-expanded=${!!(nf.bld && nf.bld.target === "until")} onClick=${() => bldToggle("until")}>Pick</button></${KRow}>`,
			nf.bld && nf.bld.target === "until" ? builder("until", fighters, sr.map((r) => r.id)) : null]}
	</section>`;
}
// ---- When: the world's clock as it boots (world.start, UTC; the server's hour is UTC's plus its region's offset), what
// the run's span crosses (the server's night, dailies, nightlies: lib/schedule.js's, from api/new), the seasons on and
// the events forced (not as on live: flagged on the run)
const NF_MIN = 60e3, NF_H = 3600e3;
// game time as typed (90s, 30m, 2h, 1d, or minutes) in ms; null: none
const nfMs = (x) => { const t = String(x || "").trim(); return !t ? 0 : /^\d+(\.\d+)?$/.test(t) ? Number(t) * NF_MIN : parseSpan(t); };
const nfIso = (ms) => new Date(ms).toISOString().slice(0, 16);
const nfHm = (ms) => nfIso(ms).slice(11, 16);
function nfCrossed(from, to) {
	const S = NF.schedule, hour = (t) => (new Date(t).getUTCHours() + 24 + S.time_offset) % 24, out = [];
	let night = null;
	for (let x = Math.floor(from / NF_H) * NF_H; x < to; x += NF_H) {
		const sh = hour(x), isNight = sh >= S.night[0] && sh <= S.night[1];
		if (isNight && !night) night = { kind: "night", from: Math.max(from, x) };
		if (!isNight && night) (night.to = x), out.push(night), (night = null);
		if (x >= from && S.dailies.includes(sh)) out.push({ kind: "daily", at: x });
		if (x >= from && S.nightlies.includes(sh)) out.push({ kind: "nightly", at: x });
	}
	if (night) (night.to = to), out.push(night);
	return out.sort((a, b) => (a.at ?? a.from) - (b.at ?? b.from));
}
const nfStartMs = () => Date.parse(nf.start ? nf.start + ":00Z" : NF.schedule.default_start);
function when(v) {
	const S = NF.schedule;
	if (!S) return null;
	const start = nfStartMs(), age = nfMs(nf.wage || (v && v.world && v.world.age)) || 0, warm = nfMs(nf.warmup || (v && v.run && v.run.warmup)) || 0, dur = nfMs(nf.duration) || 0, base = start + age + warm;
	const sh = (t) => String((new Date(t).getUTCHours() + 24 + S.time_offset) % 24).padStart(2, "0") + nfHm(t).slice(2);
	// the presets: as by default; a daily, a nightly 10 game minutes into the run; the run in the server's night
	const day = Date.parse(S.default_start), first = (k) => nfCrossed(day, day + 48 * NF_H).find((x) => x.kind === k), pre = (t) => (t === day ? "" : nfIso(t));
	const presets = [["", "Jan 1, 00:00 (default)"], [pre(first("daily").at - 10 * NF_MIN - age - warm), "a daily 10 min in"], [pre(first("nightly").at - 10 * NF_MIN - age - warm), "a nightly 10 min in"], [pre(first("night").from - age - warm), "at night"]];
	const at = (t) => (t < start + age ? "in the world age" : t < base ? "in the warm-up" : "at " + Math.floor((t - base) / NF_H) + ":" + String(Math.floor(((t - base) % NF_H) / NF_MIN)).padStart(2, "0") + " of the run");
	const cs = nfCrossed(start, base + dur).map((x) => x.kind === "night" ? "night from " + nfHm(x.from) + " UTC " + at(x.from) + (x.to < base + dur ? " to " + nfHm(x.to) : "")
		: (x.kind === "daily" ? "a daily (" + S.dailies_events.join(", ") + ": the seed's order)" : "a nightly (" + S.nightlies_events.join(", ") + ")") + " at " + nfHm(x.at) + " UTC " + at(x.at));
	const span = "boots " + nfIso(start).replace("T", " ") + " UTC (the server's " + sh(start) + "), measured " + nfHm(base) + "-" + nfHm(base + dur) + " UTC";
	const evs = [...S.dailies_events, ...S.nightlies_events];
	return [html`<${KRow} label="Starts" id="nf-start"><input type="datetime-local" id="nf-start" step="60" value=${nf.start || S.default_start.slice(0, 16)} data-tip=${"the world's clock as it boots, UTC (the server's hour: UTC " + S.time_offset + " h, its night 0-5, dailies at " + S.dailies.join(" and ") + ", a nightly at " + S.nightlies.join(", ") + ", its time)"} onChange=${(e) => { nf.start = e.currentTarget.value; change(); }} /><span class="gu">UTC</span>
			<span class="seg sm kdur" role="group" aria-label="Start presets">${presets.map(([x, l]) => html`<button type="button" aria-pressed=${nf.start === x} onClick=${() => { nf.start = x; change(); }}>${l}</button>`)}</span></${KRow}>`,
		html`<${KRow} label=""><span class="gu">${span + (cs.length ? "; crosses " + cs.join("; ") : "; crosses no night, daily or nightly")}</span></${KRow}>`,
		html`<${KRow} label="Events">${S.seasons.map((x) => html`<button type="button" class=${"chip kc" + (nf.seasons.includes(x) ? " on" : "")} aria-pressed=${nf.seasons.includes(x)} data-tip=${"the season " + x + " on (a server switch: its drops and monsters, from the start); not as on live now: flagged on the run"} onClick=${() => { const i = nf.seasons.indexOf(x); i < 0 ? nf.seasons.push(x) : nf.seasons.splice(i, 1); change(); }}>${x}</button>`)}
			<button type="button" class="cb" data-tip="a daily or nightly started at a game time of the run (as the server's schedule starts them); not as on live: flagged on the run" onClick=${() => { nf.events.push({ event: (NF.schedule && NF.schedule.dailies_events[0]) || "goobrawl", at: "10m" }); change(); nfFocus('[data-nev="' + (nf.events.length - 1) + '"]'); }}>Force an event</button></${KRow}>`,
		nf.events.map((e, i) => html`<${KRow} label=""><${Select} data-nev=${i} aria-label="The event" value=${e.event} onChange=${(x) => { e.event = x.currentTarget.value; change(); }}>${evs.map((x) => html`<option value=${x}>${x}</option>`)}</${Select}><span class="gu">at</span>
			<input type="text" class="sn" value=${e.at} aria-label="At" data-tip="game time after the warm-up: 90s, 20m, 2h" onInput=${(x) => { e.at = x.currentTarget.value; nfPreview(); }} /><span class="gu">of the run</span><${IbX} what="force it no more" onClick=${() => { nf.events.splice(i, 1); change(); }} /></${KRow}>`)];
}
// ---- World: a custom world (world.spawns, sim/world_spawns.js; not as on live: flagged on the run): monsters of the
// game's types at a spot, made by the server as its own: a dummy (endless hp), an arena (respawns); the example bot
// farms them when asked (every character's params.farm: the spot and the types)
const NF_SPAWNS = {
	dummy: { monster: "target", at: "main:0:-150", count: "1", level: "", endless: true, attack: "", armor: "", resistance: "", respawn: "", clear: "200" },
	arena: { monster: "goo", at: "main:-200:300", count: "5", level: "", endless: false, attack: "", armor: "", resistance: "", respawn: "5s", clear: "250" },
};
const nfNum = (x) => (String(x).trim() === "" ? undefined : Number(x));
function nfWorldOut() {
	const sps = nf.spawns.filter((x) => x.monster.trim() && x.at.trim()).map((x) => {
		const stats = Object.fromEntries(["attack", "armor", "resistance"].filter((k) => String(x[k]).trim() !== "").map((k) => [k, Number(x[k])]));
		return { monster: x.monster.trim(), at: x.at.trim(), ...(nfNum(x.count) > 1 ? { count: nfNum(x.count), radius: 40 } : {}), ...(nfNum(x.level) ? { level: nfNum(x.level) } : {}), ...(Object.keys(stats).length ? { stats } : {}), ...(x.endless ? { hp: "endless" } : {}), ...(!x.endless && x.respawn.trim() ? { respawn: x.respawn.trim() } : {}), ...(nfNum(x.clear) ? { clear: nfNum(x.clear) } : {}) };
	});
	if (!sps.length) return {};
	const [map, x, y] = sps[0].at.split(":");
	return { spawns: sps, ...(nf.farmSpawns ? { params: { "*": { farm: { map, x: Number(x), y: Number(y), monsters: [...new Set(sps.map((s) => s.monster))] } } } } : {}) };
}
function world() {
	const f = (x, i, k, ph, cls, tip) => html`<input type="text" class=${cls} data-nsp=${i} data-k=${k} value=${x[k]} placeholder=${ph} aria-label=${k} data-tip=${tip || null} list=${k === "monster" ? "nf-mons" : null} onInput=${(e) => { x[k] = e.currentTarget.value; nfPreview(); }} />`;
	const rows = nf.spawns.map((x, i) => html`<${KRow} label="">${f(x, i, "monster", "monster", "nsv", "a monster type of the game: its look and stats (copied); the ones below set")}<span class="gu">at</span>${f(x, i, "at", "map:x:y", "nsv", "where it stands (map:x:y)")}
		${f(x, i, "count", "1", "sn", "how many")}${f(x, i, "level", "level", "sn", "its level at least (the server's level-up loop levels it on)")}
		<button type="button" class="chip kc" aria-pressed=${!!x.endless} data-tip="it never dies (a target dummy: damage per second, no kills)" onClick=${() => { x.endless = !x.endless; change(); }}>endless hp</button>
		${f(x, i, "attack", "attack", "sn", "its attack (empty: its type's)")}${f(x, i, "armor", "armor", "sn", "its armor (empty: its type's)")}${f(x, i, "resistance", "resist", "sn", "its resistance (empty: its type's)")}
		${x.endless ? null : f(x, i, "respawn", "respawn", "sn", "game time after a death it comes back (5s, 1m; no: never; empty: its type's)")}${f(x, i, "clear", "clear px", "sn", "the map's own monsters within this many px of the spot removed (an arena of its own)")}
		<${IbX} what="remove this spawn" onClick=${() => { nf.spawns.splice(i, 1); change(); }} /></${KRow}>`);
	const add = (k) => { nf.spawns.push({ ...NF_SPAWNS[k] }); change(); nfFocus('[data-nsp="' + (nf.spawns.length - 1) + '"][data-k="monster"]'); };
	return [html`<${KRow} label="World"><span class="gu">${nf.spawns.length ? "custom (not as on live: said on the run)" : "the game's"}</span><button type="button" class="cb" data-tip="one target with endless hp: the damage a party deals" onClick=${() => add("dummy")}>A dummy</button><button type="button" class="cb" data-tip="monsters that come back at a spot, the map's own cleared around it" onClick=${() => add("arena")}>An arena</button>
			<datalist id="nf-mons">${((nfItems && nfItems.monsters) || []).map((m) => html`<option value=${m}></option>`)}</datalist></${KRow}>`, rows,
		nf.spawns.length ? html`<${KRow} label=""><label class="opt" data-tip="every character's params.farm: the first spawn's spot and the spawns' types (the example bot farms them; your CODE: if it reads params)"><input type="checkbox" checked=${nf.farmSpawns} onChange=${(e) => { nf.farmSpawns = e.currentTarget.checked; nfPreview(); }} />the example bot farms them</label></${KRow}>` : null];
}
// ---- storage and steering (setup accounts.<k>.storage and local_storage, steer): a row per key the CODE reads from its
// storage (get(k), localStorage), the setup sets or added here, with a field per account of the run (empty: as
// composed, its placeholder; null: unset; a value: JSON, else text); the reads of a key the CODE builds as it runs as
// chips; then the steering, a row per step (at, who, set a key or run CODE), as composed until one is changed
const nfSK = (k, kind, key) => k + "\u0001" + kind + "\u0001" + key;
const nfJson = (t) => { try { return JSON.parse(t); } catch (e) { return t; } };
function nfStoreOut(inRun) {
	const out = {};
	for (const [id, t] of Object.entries(nf.store)) {
		const [k, kind, key] = id.split("\u0001"), f = kind === "get" ? "storage" : "local_storage";
		if (inRun.has(k)) ((out[f] ||= {})[k] ||= {})[key] = t.trim() === "null" ? null : kind === "get" ? nfJson(t) : t;
	}
	return out;
}
// the steps as rows: { id (its name: the setup's, else s<N>), trig ("at" | "when" | "after"), at, when, for, repeat, after
// (a row's id), who, kind ("set" | "local" | "run"), key, v, code, window, note }; a step with several keys: a row each
const nfSteerRows = (v) => nf.steer || nfSteerFrom((v && v.steer) || []);
const nfSteerEdit = () => (nf.steer ||= nfSteerFrom((variant() || {}).steer || []));
const nfSid = (rows) => { let i = rows.length + 1; while (rows.some((r) => r.id === "s" + i)) i++; return "s" + i; };
function nfSteerFrom(list) {
	const out = [];
	for (const e of list) {
		const b = () => ({ id: out.some((r) => r.id === e.name) || !e.name ? nfSid(out) : e.name, trig: e.when != null ? "when" : e.after != null ? "after" : "at", at: e.at == null ? "" : String(e.at), when: e.when || "", for: e.for || "", repeat: !!e.repeat, after: e.after || "", window: e.window || "", note: e.note || "", who: e.character || "", key: "", v: "", code: "" });
		for (const [k, x] of Object.entries(e.storage || {})) out.push({ ...b(), kind: "set", key: k, v: JSON.stringify(x) });
		for (const [k, x] of Object.entries(e.local_storage || {})) out.push({ ...b(), kind: "local", key: k, v: x === null ? "null" : x });
		if (e.code != null) out.push({ ...b(), kind: "run", code: e.code });
	}
	return out;
}
// the rows as the setup's steer: a step named when another is after it or a condition reads it (steps.<id>); a step
// without its time or condition isn't sent
function nfSteerOut(rows) {
	const used = new Set([...rows.map((r) => r.after), ...[...rows.map((r) => r.when), nf.until || ""].flatMap((x) => [...String(x).matchAll(/\bsteps\.(\w+)/g)].map((m) => m[1]))]);
	const n = (x) => (/^\d+(\.\d+)?$/.test(x.trim()) ? Number(x) : x.trim());
	return rows.filter((s) => (s.trig === "when" ? s.when.trim() : s.trig === "after" ? s.after : s.at.trim())).map((s) => ({
		...(used.has(s.id) ? { name: s.id } : {}),
		...(s.trig === "when" ? { when: s.when.trim(), ...(s.for.trim() ? { for: n(s.for) } : {}), ...(s.repeat ? { repeat: true } : {}), ...(s.window ? { window: s.window } : {}) } : s.trig === "after" ? { after: s.after, ...(s.at.trim() ? { at: n(s.at) } : {}) } : { at: n(s.at) }),
		...(s.who ? { character: s.who } : {}),
		...(s.kind === "run" ? { code: s.code } : { [s.kind === "set" ? "storage" : "local_storage"]: { [s.key]: s.v.trim() === "null" ? null : s.kind === "set" ? nfJson(s.v) : s.v } }),
		...(s.note ? { note: s.note } : {}),
	}));
}
// the condition picker (a step's when, the run's until): what to watch, of whom; [key, label, expression ($N: the
// character, $A: the thing picked, $Q: it quoted), what is picked (a list: nfItems'), yes/no (no comparison), of the
// world, whose (c: a character's only, p: the party's only; none: either: the party's is the characters' summed)]
const NF_MEAS = [
	["kills", "kills of", "c.$N.kills.$A", "monsters"], ["killsall", "kills, all", "c.$N.kills.total"], ["deaths", "deaths", "c.$N.deaths"], ["rip", "is dead", "c.$N.rip", null, 1, 0, "c"],
	["level", "level", "c.$N.level", null, 0, 0, "c"], ["levels", "levels gained", "c.$N.levels"], ["xp", "xp gained", "c.$N.xp_gained"], ["gold", "gold", "c.$N.gold"], ["goldg", "gold gained", "c.$N.gold_gained"],
	["hp", "hp %", "c.$N.hp / c.$N.max_hp * 100", null, 0, 0, "c"], ["since", "s since its last kill", "c.$N.since_kill"],
	["dead", "characters dead", "party.dead", null, 0, 0, "p"], ["ingame", "characters in game", "party.online", null, 0, 0, "p"],
	["xph", "xp/h, last 10 min", "c.$N.rate.xp_h"], ["killsh", "kills/h, last 10 min", "c.$N.rate.kills_h"], ["goldh", "gold/h, last 10 min", "c.$N.rate.gold_h"], ["takens", "damage taken/s, last 10 min", "c.$N.rate.taken_s"],
	["looted", "items looted of", "c.$N.looted.$A", "items"], ["lootall", "items looted, all", "c.$N.looted.total"], ["inv", "held in its bag", "c.$N.items.$A", "items"], ["free", "free bag slots", "c.$N.free"],
	["used", "used or drunk of", "c.$N.used.$A", "items"], ["drunk", "potions drunk", "c.$N.drunk"], ["best", "its highest level of", "c.$N.best.$A", "items"],
	["upok", "upgrades succeeded", "c.$N.upgrades.ok"], ["upfail", "upgrades failed", "c.$N.upgrades.fail"], ["cpok", "compounds succeeded", "c.$N.compounds.ok"], ["cpfail", "compounds failed", "c.$N.compounds.fail"],
	["chests", "chests opened", "c.$N.chests"], ["trips", "supply trips", "c.$N.trips"], ["bankfree", "bank free slots", "c.$N.bank_free"], ["bankgold", "bank gold", "c.$N.bank_gold"],
	["on", "has the condition", "c.$N.s.$A", "conditions", 1, 0, "c"], ["off", "hasn't the condition", "!c.$N.s.$A", "conditions", 1, 0, "c"], ["mode", "its CODE's mode is", "c.$N.mode == $Q", "", 1, 0, "c"],
	["near", "in view: how many", "c.$N.near.$A", "monsters", 0, 0, "c"], ["nearlv", "in view: highest level", "c.$N.near_level.$A", "monsters", 0, 0, "c"], ["log", "log lines matching", "c.$N.log($Q)", "", 0, 0, "c"], ["get", "storage key", "c.$N.get($Q)", "", 0, 0, "c"],
	["party", "is in a party", "!!c.$N.party", null, 1, 0, "c"], ["online", "is in game", "c.$N.online", null, 1, 0, "c"],
	["t", "game time (s)", "t", null, 0, 1], ["alive", "alive on the server", "world.alive.$A", "monsters", 0, 1], ["wlevel", "highest level on the server", "world.level.$A", "monsters", 0, 1],
	["event", "server event on", "world.events.$A", "", 1, 1], ["step", "step fired", "steps.$A", "steps", 1, 1],
];
// the picker's expression: its measure of its character, the comparison (a number as it is; true, false, null; else text)
function nfBuildExpr(b) {
	const m = NF_MEAS.find((x) => x[0] === b.m);
	if (!m) return "";
	const a = String(b.a || "").trim(), prop = /^[A-Za-z_$][\w$]*$/.test(a) ? "." + a : "[" + JSON.stringify(a) + "]";
	let e = m[2].split("c.$N").join(b.who === "@party" ? "party" : "c." + b.who).split(".$A").join(prop).split("$A").join(a).split("$Q").join(JSON.stringify(a));
	if (m[4]) return e;
	const v = String(b.v || "").trim(), val = /^-?\d+(\.\d+)?$/.test(v) || /^(true|false|null)$/.test(v) ? v : JSON.stringify(v);
	if (/[+\-*/]/.test(e) && !/^[\w.$[\]"]+$/.test(e)) e = "(" + e + ")";
	return e + " " + (b.op || ">=") + " " + val;
}
const bldToggle = (target) => { const same = nf.bld && nf.bld.target === target, ro = nf.roster.filter((r) => r.on !== "out"); nf.bld = same ? null : { target, who: (ro[0] || {}).name || "", m: "kills", a: "", op: ">=", v: "" }; draw(); };
function builder(target, ro, steps, pad) {
	const b = nf.bld, ok = (x) => !x[5] && x[6] !== (b.who === "@party" ? "c" : "p"), ms = NF_MEAS.filter((x) => x[5] || ok(x)), m = ms.find((x) => x[0] === b.m) || ms[0], lists = { monsters: (nfItems && nfItems.monsters) || [], items: Object.keys((nfItems && nfItems.items) || {}), conditions: (nfItems && nfItems.conditions) || [], steps };
	b.m = m[0]; // (one the other whose doesn't have: the first it has)
	const sel = (f, opts, then) => html`<${Select} aria-label=${f} value=${String(b[f])} onChange=${(e) => { b[f] = e.currentTarget.value; if (then) then(e.currentTarget.value); draw(); }}>${opts.map(([x, t]) => html`<option value=${x}>${t}</option>`)}</${Select}>`;
	// (whose: a measure the other doesn't have goes to the first one it has)
	const who = (x) => { const y = NF_MEAS.find((z) => z[0] === b.m); if (y && !y[5] && y[6] === (x === "@party" ? "c" : "p")) b.m = x === "@party" ? "killsall" : "kills"; };
	const arg = m[3] != null ? [html`<input type="text" class="nsv" list="nf-bl" value=${b.a || ""} placeholder=${m[3] === "steps" ? "step" : m[3] ? m[3].replace(/s$/, "") : m[0] === "log" ? "pattern" : m[0] === "get" ? "key" : "text"} aria-label="what" onInput=${(e) => (b.a = e.currentTarget.value)} />`,
		html`<datalist id="nf-bl">${(lists[m[3]] || []).map((x) => html`<option value=${x}></option>`)}</datalist>`] : null;
	const cmp = m[4] ? null : [sel("op", [[">=", ">="], [">", ">"], ["<=", "<="], ["<", "<"], ["==", "="], ["!=", "not"]]), html`<input type="text" class="sn" value=${b.v || ""} placeholder="value" aria-label="value" onInput=${(e) => (b.v = e.currentTarget.value)} />`];
	const add = () => {
		const e = nfBuildExpr(nf.bld), join = (x) => (String(x || "").trim() ? String(x).trim() + " && " : "") + e;
		if (!e) return;
		if (target === "until") nf.until = join(nf.until);
		else { const r = nfSteerEdit().find((x) => "s:" + x.id === target); if (r) r.when = join(r.when); }
		nf.bld = { ...nf.bld, a: "", v: "" };
		change();
	};
	return html`<${KRow} label="">${pad ? html`<span class="nsid"></span>` : null}<span class="nbld">${m[5] ? null : sel("who", [["@party", "the party (all)"], ...ro.map((r) => [r.name, r.name])], who)}${sel("m", ms.map((x) => [x[0], x[1]]), () => (b.a = ""))}${arg}${cmp}
		<button type="button" class="cb" data-tip="adds it to the condition (and: a condition that holds already stays with it)" onClick=${add}>Add</button></span></${KRow}>`;
}
function store(v) {
	if (!v) return null;
	const ro = nf.roster.filter((r) => r.on !== "out"), accts = [...new Set(ro.map(nfAcct))], ks = (v.keys && v.keys.keys) || [], A = v.accounts || {};
	const rows = [], seen = new Set(), add = (kind, key, x, mine) => { if (seen.has(kind + "\u0001" + key)) return; seen.add(kind + "\u0001" + key); rows.push({ kind, key, x, mine }); };
	for (const x of ks) add(x.kind, x.key, x);
	for (const k of accts) { for (const key of Object.keys((A[k] || {}).storage || {})) add("get", key); for (const key of Object.keys((A[k] || {}).local_storage || {})) add("local", key); }
	for (const y of nf.keys) add(y.kind, y.key, null, true);
	const composed = (k, kind, key) => { const m = (A[k] || {})[kind === "get" ? "storage" : "local_storage"]; return m && Object.hasOwn(m, key) ? (kind === "get" ? JSON.stringify(m[key]) : m[key]) : null; };
	const kname = (r) => (r.kind === "get" ? 'get("' + r.key + '")' : 'localStorage "' + r.key + '"');
	const lines = rows.map((r, i) => {
		const tip = kname(r) + (r.x ? ": read " + r.x.count + (r.x.count === 1 ? " time" : " times") + " in " + r.x.where.join(", ") + (r.x.set ? "; its CODE sets it too (its value may be its own)" : "") : r.mine ? ": added here" : ": the setup sets it") +
			". A value: JSON (\"text\", 3, true, {...}), else text; null: unset; empty: as composed";
		const fields = accts.map((k) => { const c = composed(k, r.kind, r.key), id = nfSK(k, r.kind, r.key);
			return [accts.length > 1 ? html`<span class="gu">${k}</span>` : null, html`<input type="text" class="nsv" data-nsv=${r.kind + "\u0001" + r.key} value=${nf.store[id] ?? ""} placeholder=${c ?? "unset"} aria-label=${kname(r) + (accts.length > 1 ? " on " + k : "")} onInput=${(e) => { const x = e.currentTarget.value; if (x === "") delete nf.store[id]; else nf.store[id] = x; nfPreview(); }} />`]; });
		return html`<${KRow} label=${i ? "" : "Storage"}><span class="nsk" data-tip=${tip}>${kname(r)}</span>${fields}${r.mine ? html`<${IbX} what=${"remove " + kname(r)} onClick=${() => { const k = r.kind + "\u0001" + r.key; nf.keys = nf.keys.filter((y) => y.kind + "\u0001" + y.key !== k); for (const id of Object.keys(nf.store)) if (id.endsWith("\u0001" + k)) delete nf.store[id]; change(); }} />` : null}</${KRow}>`;
	});
	const dyn = (v.keys && v.keys.dynamic) || [], dchips = [...dyn.slice(0, 4).map((d) => html`<${KChip} text=${d.where + ":" + d.line + " " + d.text} tip="a storage key the CODE builds as it runs: add it by name if it matters" />`), dyn.length > 4 ? html`<${KChip} text=${dyn.length - 4 + " more"} tip=${dyn.slice(4).map((d) => d.where + ":" + d.line + " " + d.text).join("; ")} />` : null];
	const addKey = () => { const k = String(nf.skey || "").trim(), kind = nf.skind === "local" ? "local" : "get"; if (k && !nf.keys.some((y) => y.kind === kind && y.key === k)) nf.keys.push({ kind, key: k }); nf.skey = ""; change(); nfFocus('[data-nsv="' + CSS.escape(kind + "\u0001" + k) + '"]'); };
	const keyRow = html`<${KRow} label=${rows.length ? "" : "Storage"}><input type="text" value=${nf.skey || ""} placeholder="a key" aria-label="A storage key" onInput=${(e) => (nf.skey = e.currentTarget.value)} />
		<${Select} aria-label="Read with" value=${nf.skind === "local" ? "local" : "get"} onChange=${(e) => (nf.skind = e.currentTarget.value)}><option value="get">get()</option><option value="local">localStorage</option></${Select}>
		<button type="button" class="cb" data-tip="a key of the browser storage its CODE reads (get(key): the game's set/get; localStorage), each account's value at the start" onClick=${addKey}>Add key</button>${dyn.length ? [html`<span class="gu">built as it runs</span>`, dchips] : null}</${KRow}>`;
	// the steps: when (its trigger: a time, a condition held for a while or each time, a while after another step), then
	// what it does (who, set a key or run CODE); the picker under a condition when open
	const srows = nfSteerRows(v), ids = srows.map((r) => r.id);
	const steer = srows.map((s, i) => {
		const ed = () => nfSteerEdit()[i];
		const sel = (f, opts) => html`<${Select} data-nst=${f} data-nk=${i} aria-label=${f} value=${String(s[f])} onChange=${(e) => { const r = ed(); r[f] = e.currentTarget.value; if (f === "trig" && nf.bld && nf.bld.target === "s:" + r.id) nf.bld = null; change(); }}>${opts.map(([x, t]) => html`<option value=${x}>${t}</option>`)}</${Select}>`;
		const inp = (f, cls, ph, label, tip) => html`<input type="text" class=${cls} data-nst=${f} data-nk=${i} value=${s[f]} placeholder=${ph} aria-label=${label} data-tip=${tip || null} onInput=${(e) => { ed()[f] = e.currentTarget.value; nfPreview(); }} />`;
		const trig = s.trig === "when"
			? [inp("when", "ncode", "c." + ((ro[0] || {}).name || "Name") + ".kills.goo >= 500", "condition", "a condition, checked as often as Check every says (1 s by default) against the run's numbers (the dashboard's): Pick builds one; c.<Name>.kills.<monster>, looted.<item>, items.<item>, free, bank_free, s.<condition>, rate.xp_h, log(/text/), get(\"key\"), t, world.alive.<monster>, steps.<step> (README)"),
				inp("for", "sn", "for", "held for", "held this long first (90s, 5m); empty: at once"),
				html`<label class="opt" data-tip="again each time it holds anew (after not holding); else once"><input type="checkbox" checked=${s.repeat} onChange=${(e) => { ed().repeat = e.currentTarget.checked; nfPreview(); }} />each time</label>`,
				html`<button type="button" class="cb" aria-expanded=${!!(nf.bld && nf.bld.target === "s:" + s.id)} onClick=${() => bldToggle("s:" + s.id)}>Pick</button>`]
			: s.trig === "after" ? [sel("after", [["", "a step..."], ...ids.filter((x) => x !== s.id).map((x) => [x, x])]), inp("at", "sn", "0s", "later by", "this long after that step fired (each time it fires): 90s, 5m")]
			: inp("at", "sn", "20m", "at", "game time since the run's start, after the warm-up (the charts' 0:00): 90s, 20m, 2h");
		const head = html`<${KRow} label=${i ? "" : "Steering"} cls="nstr"><span class="nsid" data-tip=${"step " + s.id + (s.note ? ": " + s.note : "") + " (a condition reads it as steps." + s.id + ")"}>${s.id}</span>${sel("trig", [["at", "at"], ["when", "when"], ["after", "after"]])}${trig}</${KRow}>`;
		const act = html`<${KRow} label="" cls="nstr nsta"><span class="nsid"></span>${sel("who", [["", "everyone"], ...ro.map((r) => [r.name, r.name])])}${sel("kind", [["set", "set"], ["local", "localStorage"], ["run", "run"]])}
			${s.kind === "run" ? inp("code", "ncode", "CODE, run in its CODE as command_character runs it", "CODE") : [inp("key", "nsv", "key", "key"), inp("v", "nsv", s.kind === "set" ? "JSON, else text" : "text", "value", s.kind === "set" ? "what get(key) returns from then on: JSON (\"text\", 3, true), else text; null: unset" : "the localStorage value from then on; null: removed")]}
			<${IbX} what="remove this step" onClick=${() => { nfSteerEdit().splice(i, 1); change(); }} /></${KRow}>`;
		return [head, nf.bld && nf.bld.target === "s:" + s.id && s.trig === "when" ? builder("s:" + s.id, ro, ids, true) : null, act];
	});
	const stAdd = html`<${KRow} label=${steer.length ? "" : "Steering"}><button type="button" class="cb" data-tip="a step: at a game time, when a condition holds (kills, loot, upgrades, bag or bank full, a buff, the CODE's mode, a log line...), or a while after another step; it sets a storage key (its character's account's, or every account's) or runs CODE in a character's CODE, as a player at their controls would; marked on the charts"
		onClick=${() => { const s = nfSteerEdit(); s.push({ id: nfSid(s), trig: "at", at: "", when: "", for: "", repeat: false, after: "", window: "", note: "", who: "", kind: "set", key: "", v: "", code: "" }); change(); nfFocus('[data-nst="at"][data-nk="' + (s.length - 1) + '"]'); }}>Add a step</button></${KRow}>`;
	return [lines, keyRow, steer, stAdd];
}

// ---- Add export: snippets/export-state.js copied (to run in a character's CODE on live: it copies the export to the
// clipboard, compressed when large; else downloads <Name>.json), then the export pasted or its file dropped here: it
// goes over that character of the pull (api/new/export; exported inside the bank, the bank too)
let nfExp = null, nfSnippet = null; // the panel: { text, msg, bad, busy, copied: true | "manual" }; the snippet's text
function expPanel() {
	const a = nfExp, p = nfPullOf();
	const copy = a.copied === "manual" ? [html`<textarea class="nact" rows="4" readonly data-nexpsnip="1" aria-label="The snippet" value=${nfSnippet || ""}></textarea>`, html`<span class="gu">this browser keeps the clipboard from the page here: select it all and copy</span>`]
		: html`<button type="button" class="cb" data-nexpcopy="1" onClick=${nfExpCopy}>${a.copied ? "Copied: run it on live" : "Copy the snippet"}</button>`;
	const drop = async (e) => { e.preventDefault(); const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (f) nfExpAdd(await f.text(), f.name); else if (e.dataTransfer) nfExpAdd(e.dataTransfer.getData("text")); };
	return html`<div class="nadc nexp" onDragOver=${(e) => e.preventDefault()} onDrop=${drop}>
		<${KRow} label=""><b>Add an export</b><span class="gu">${"over " + (p ? "the pull " + p.id : "a pull: pull the account first")}</span><${IbX} what="close: add nothing" onClick=${() => { nfExp = null; nfFocus("[data-nexp]"); }} /></${KRow}>
		<${KRow} label="1">${copy}</${KRow}>
		<${KRow} label="2"><span>${"On live, paste it into the character's CODE and press ENGAGE. It copies the export to the clipboard (a large one: downloads <Name>.json)."}</span></${KRow}>
		<${KRow} label="3"><textarea class="nact" rows="3" spellcheck="false" placeholder="paste the export here (Ctrl+V), or drop its file on this box" aria-label="The export" value=${a.text || ""} onInput=${(e) => (a.text = e.currentTarget.value)}></textarea></${KRow}>
		<${KRow} label=""><button type="button" class="go" disabled=${a.busy || !p} onClick=${() => nfExpAdd(a.text)}>${a.busy ? "Adding..." : "Add"}</button><label class="cb">Its file<input type="file" accept=".json,application/json,text/plain" hidden onChange=${async (e) => { const t = e.currentTarget, f = t.files && t.files[0]; if (!f) return; t.value = ""; nfExpAdd(await f.text(), f.name); }} /></label>
			${a.msg ? html`<span class=${a.bad ? "nbad" : "hint"}>${a.msg}</span>` : null}</${KRow}></div>`;
}
// the snippet onto the clipboard (else selected in a box, to copy by hand)
async function nfExpCopy() {
	if (nfSnippet == null) try { nfSnippet = (await (await fetch("api/new/snippet")).json()).text; } catch (e) { return Object.assign(nfExp, { msg: e.message, bad: true }), draw(); }
	let ok = false;
	try { await navigator.clipboard.writeText(nfSnippet); ok = true; } catch (e) {
		const t = Object.assign(document.createElement("textarea"), { value: nfSnippet });
		Object.assign(t.style, { position: "fixed", opacity: "0" });
		document.body.append(t); t.select();
		try { ok = document.execCommand("copy"); } catch (x) {}
		t.remove();
	}
	nfExp.copied = ok ? true : "manual";
	if (ok) draw(); else nfFocus("[data-nexpsnip]", (b) => b.select());
}
// an export's text (pasted, a file's): over the pull's character
async function nfExpAdd(text, from) {
	const p = nfPullOf(), a = nfExp || (nfExp = {});
	if (!p) return Object.assign(a, { msg: "pull the account first: an export goes over a character of a pull", bad: true }), draw();
	if (!String(text || "").trim()) return Object.assign(a, { msg: "paste the export first", bad: true }), draw();
	Object.assign(a, { busy: true, msg: "", bad: false }); draw();
	let r = null, o = {};
	try { r = await api("api/new/export", "POST", { pull: p.id, text }); o = await r.json().catch(() => ({})); } catch (e) { o = { reason: e.message }; }
	a.busy = false;
	if (!r || !r.ok) return Object.assign(a, { msg: (from ? from + ": " : "") + (o.reason || "HTTP " + (r && r.status)), bad: true }), draw();
	Object.assign(a, { text: "", msg: o.name + " from the export over " + p.id + (o.warnings && o.warnings.length ? ": " + o.warnings.join("; ") : ""), bad: false });
	await nfLoad(); nfPreview(0);
}

// ---- what it makes: the CODE to choose, what Check or Save said, others' CODE to trust; the bar: the name, problems
// and warnings as chips, the run count (once: on the start button), the actions
function actSec() {
	const miss = nfp && nfp.missing ? nfp.missing.map((m) => html`<div class="frow nmiss"><b>${m.name}</b><span class="gu" data-tip=${(m.code_set ? "the CODE set " + m.code_set : "its CODE") + " has no slot " + m.entry + (/^(live|pull:)/.test(m.code_set || "") ? " (no CODE loaded for it on live)" : "")}>${"no CODE slot " + m.entry}</span>
		${m.slots.length ? html`<${Select} aria-label="A slot of it" value="" onChange=${(e) => e.currentTarget.value && missSet(m.name, "slot:" + e.currentTarget.value)}><option value="">run a slot of it...</option>${m.slots.map((x) => html`<option value=${x}>${x}</option>`)}</${Select}>` : null}
		<button type="button" class="cb" onClick=${() => missSet(m.name, "idle")}>Idle</button><button type="button" class="cb" onClick=${() => missSet(m.name, "exclude")}>Leave it out</button></div>`) : [];
	const chosen = Object.entries(nf.missing).map(([n, c]) => html`<span class="chip">${n + ": " + (c === "idle" ? "idle" : c === "exclude" ? "left out" : "runs " + c.slice(5))}<button type="button" class="x" aria-label="Undo" onClick=${() => { delete nf.missing[n]; change(); }}>×</button></span>`);
	return [miss.length || chosen.length || nfOut ? html`<section class="nsec">${miss}${chosen.length ? html`<div class="frow">${chosen}</div>` : null}${nfOut ? html`<div class="nout">${nfOut}</div>` : null}</section>` : null, trustSec()];
}
async function nfGo(action, force) {
	const seeds = nfSeeds();
	nfOut = say(action === "check" ? "checking (building the CODE)..." : action === "save" ? "saving..." : "starting..."); draw();
	let o = {}, r = null;
	try {
		r = await api("api/new/compose", "POST", { opts: nfOpts(), missing: nf.missing, action, seeds: action === "sim" ? seeds : undefined, name: nf.name || undefined, force: force || undefined, ...(action === "sim" && nf.record ? { record: true } : {}) });
		o = await r.json().catch(() => ({}));
	} catch (e) { o = { reason: e.message }; }
	const bad = (o.problems || []).concat(o.reason ? [o.reason] : []);
	if (action === "check") nfOut = (o.checked || []).length ? o.checked.map((c) => say((c.label ? c.label + ": " : "") + (c.problems.length ? c.problems.join("; ") : "ok, CODE " + Object.entries(c.hashes || {}).map(([n, x]) => n + " " + x).join(", ")) + (c.warnings.length ? " (" + c.warnings.join("; ") + ")" : ""), c.problems.length > 0)) : bad.map((x) => say(x, true));
	else if (action === "save") nfOut = o.files ? say("Saved: " + o.files.join(", ")) : [say(bad.join("; ") || "not saved", true), r && r.status === 409 ? html`<button type="button" class="cb" data-ngo="save" onClick=${() => nfGo("save", true)}>Replace it</button>` : null];
	else {
		const n = (o.launches || []).length, q = (o.launches || []).filter((l) => l.state === "queued").length;
		nfOut = n ? say((n - q ? "Started " + (n - q) + (n - q > 1 ? " runs" : " run") : "") + (q ? (n - q ? ", " : "") + q + " queued" : "") + (nf.record ? ", recorded" : "") + ": they show in the runs list as they begin") : say(bad.join("; ") || "nothing started", true);
		if (n) pollSoon();
	}
	draw();
}
function bar(v) {
	const vs = (nfp && nfp.variants) || [], seeds = nfSeeds(), runs = Math.max(1, vs.length) * Math.max(1, seeds.length), combo = nfCombo(), cst = getCst(), th = cst && cst.sims, free = th && th.threads_max ? Math.max(0, th.threads_max - th.threads_busy) : null;
	// (a run's threads: one per character plus the server's)
	const need = vs.length ? Math.max(...vs.map((x) => (x.characters || []).length + 1)) : 1, now = free == null ? null : launchesOf().some((l) => l.state === "queued") ? 0 : Math.max(th.threads_busy ? 0 : 1, Math.floor(free / need));
	const ok = nfp && nfp.ok && !nfWait, k = (text, cls, tip) => html`<${KChip} text=${text} cls=${cls} tip=${tip} />`;
	const chips = nfWait ? [html`<span class="gu">${nfWait}</span>`] : !nfp ? [] : [...(nfp.problems || []).map((x) => k(x, "bad")), nfp.missing && nfp.missing.length ? k("CODE to choose: " + nfp.missing.map((m) => m.name).join(", "), "bad") : null,
		nfp.untrusted && nfp.untrusted.length ? k("CODE to trust: " + nfp.untrusted.map((u) => u.name).join(", "), "bad", "others' CODE runs once you trust its version (Trust, above)") : null, fitChip(vs),
		...(nfp.warnings || []).concat(vs.flatMap((x) => x.warnings || [])).map((x) => k(x, "warn")), nfp.ok && now != null && runs > now ? k(runs - now + " of " + runs + " queued", "", runs + " runs of " + need + " threads each, " + free + " of " + th.threads_max + " sim threads free: " + (now ? now + " start now, the rest wait" : "they wait") + " in the queue and start as threads free up") : null].filter(Boolean);
	return html`<section class="nbar"><${KRow} label="Name" id="nf-name"><input type="text" class="tag" id="nf-name" maxlength="80" value=${nf.name} placeholder=${v ? v.name.replace(/ \[.*\]$/, "") : ""} onInput=${(e) => (nf.name = e.currentTarget.value)} /></${KRow}>
		${chips.length ? html`<div class="fw">${chips}</div>` : null}
		<div class="frow"><button type="button" class="go" data-ngo="sim" disabled=${!ok} data-tip=${"chronal run" + (runs > 1 ? ": " + (combo.text || (vs.length > 1 ? vs.length + " setups" : seeds.length + " seeds")) + " = " + runs + " runs" : "")} onClick=${() => nfGo("sim")}>Start${runs > 1 ? " " + runs + " runs" : ""}</button>
			<button type="button" class="cb" data-ngo="check" disabled=${!ok} data-tip="resolve every setup and build its CODE, run nothing" onClick=${() => nfGo("check")}>Check</button>
			<button type="button" class="cb" data-ngo="save" disabled=${!ok} data-tip=${"write the setup to " + NF.setups_dir + " (a folder for a sweep): run it again any time, or with chronal run"} onClick=${() => nfGo("save")}>Save</button></div>
		${combo.text ? html`<p class="gu">${combo.text}</p>` : null}</section>`;
}

// ---- the keys: the sheet (4 wide) and the inventory (7 wide, the add cell last): the arrows go from cell to cell,
// Delete or X empties a slot or removes an item; the pickers: the search's Down (or Enter: the first item) into the
// grid, the arrows through it (Up past its top row: back to the search), a letter back to the search; Esc closes the
// picker, back on its slot. Enter in a picker's level, stat scroll or title (or an inventory item's): it applies and
// closes. The CODE picker: its search's Down (Enter: the first set) into its list, Up and Down through it; Esc closes
// it, back on its button. The Add CODE row: Enter in its link adds, Esc closes it. The gear sets: the arrows go from set
// to set; Enter in the name saves the sheet as one
function keys(e) {
	if (!nf) return;
	const t = e.target, d = t.dataset || {}, inEd = t.closest(".idlg, .qin");
	if (d.nsetname && e.key === "Enter") { e.preventDefault(); return void t.parentElement.querySelector(".cb").click(); }
	if (d.nf === "playername" && e.key === "Enter") { e.preventDefault(); const b = t.closest("#nsim").querySelector("[data-nplayer]"); return void (b && !b.disabled && b.click()); }
	if (d.nlv && (e.key === "ArrowUp" || e.key === "ArrowDown")) { e.preventDefault(); return nfLvStep(t, e.key === "ArrowUp" ? 1 : -1); }
	if ((e.key === "Enter" || e.key === "Escape") && (inEd || t.closest(".ipk .ift"))) {
		e.preventDefault(); e.stopPropagation();
		const enter = e.key === "Enter";
		return void setTimeout(() => {
			if (enter && d.nlv) { const v = nfLvParse(drafts.get("lv|" + d.nlv) ?? t.value, Number(d.max) || 0); drafts.delete("lv|" + d.nlv); if (v != null) nfLvApply(d.nlv, v); }
			else if (enter && t.list) cmbApply(t);
			if (inEd) return nfInvClose(true);
			const p = nfPick; nfPick = null; drafts.clear();
			p ? nfFocus('[data-nslot="' + p.slot + '"]') : draw();
		}, 0);
	}
	if (nfAc && e.key === "Enter" && (d.nac === "from" || d.nac === "name" || d.nac === "file")) { e.preventDefault(); return void nfAcGo(); }
	if (nfAc && e.key === "Escape" && t.closest(".nadc")) { e.preventDefault(); e.stopPropagation(); nfAc = null; return nfFocus("[data-nacopen]"); }
	if (nfCp && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); const tg = nfCp.target; nfCp = null; return nfFocus('.ncp[data-ncp="' + CSS.escape(tg) + '"]'); }
	const cpk = nfCp && t.closest(".ncpk");
	if (cpk) {
		const cells = [...cpk.querySelectorAll("[data-ncpick]")], i = cells.indexOf(t), q = cpk.querySelector("[data-ncpq]");
		if (d.ncpq != null) { if ((e.key === "ArrowDown" || e.key === "Enter") && cells.length) { e.preventDefault(); return e.key === "Enter" ? cells[0].click() : cells[0].focus(); } return; }
		if (i < 0) return;
		if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); const to = i + (e.key === "ArrowDown" ? 1 : -1); return void (to < 0 ? q.focus() : cells[Math.min(to, cells.length - 1)].focus()); }
		if (e.key.length === 1 && e.key !== " " && !e.ctrlKey && !e.metaKey && !e.altKey) q.focus(); // (the letter goes on into the search)
		return;
	}
	if (inEd && e.key === "Escape") return;
	const grid = t.closest(".sheet, .inv");
	if (grid && (d.ninv != null || d.nslot) && (e.key === "Delete" || e.key === "x" || e.key === "X")) {
		e.preventDefault();
		if (d.ninv != null) return nfInvRemove(Number(d.ninv), true);
		if (!nfSlots(nfR(nf.open), nfStart(nf.open))[d.nslot]) return;
		nfGear(nf.open, d.nslot, () => null); change(); return nfFocus('.sheet [data-nslot="' + d.nslot + '"]');
	}
	if (grid && !t.closest(".ipk")) {
		const cells = [...grid.children].filter((c) => c.matches("button:not(:disabled), [data-ninv]")), i = cells.indexOf(t), cols = grid.classList.contains("sheet") ? 4 : 7;
		const to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols }[e.key];
		if (i >= 0 && to != null) { e.preventDefault(); if (to >= 0 && to < cells.length) cells[to].focus(); return; }
	}
	if (e.key === "Escape" && nfInv != null) { e.preventDefault(); e.stopPropagation(); return nfInvClose(true); }
	if (!nfPick) return;
	const pk = t.closest(".ipk");
	if (e.key === "Escape") {
		e.preventDefault(); e.stopPropagation(); closeTip();
		const p = nfPick; nfPick = null; drafts.clear();
		return nfFocus(p.slot === "inv" ? "[data-ninvadd]" : '[data-nslot="' + p.slot + '"]');
	}
	if (!pk) return;
	if (pk.classList.contains("gsp")) {
		const cards = [...pk.querySelectorAll("[data-nset]")], j = cards.indexOf(t), by = { ArrowLeft: -1, ArrowUp: -1, ArrowRight: 1, ArrowDown: 1 }[e.key];
		if (j >= 0 && by) { e.preventDefault(); cards[Math.max(0, Math.min(cards.length - 1, j + by))].focus(); }
		return;
	}
	const cells = [...pk.querySelectorAll(".igrid .gs")], i = cells.indexOf(t), g = pk.querySelector(".igrid");
	if (d.npq != null) {
		if ((e.key === "ArrowDown" || e.key === "Enter") && cells.length) { e.preventDefault(); return e.key === "Enter" ? cells[0].click() : cells[0].focus(); }
		return;
	}
	if (i < 0) return;
	const cols = Math.max(1, Math.round(g.clientWidth / 52)), to = { ArrowLeft: i - 1, ArrowRight: i + 1, ArrowUp: i - cols, ArrowDown: i + cols }[e.key];
	if (to != null) { e.preventDefault(); if (to < 0 && e.key === "ArrowUp") return pk.querySelector("[data-npq]") && pk.querySelector("[data-npq]").focus(); const c = cells[Math.max(0, Math.min(cells.length - 1, to))]; c.focus(); return c.scrollIntoView({ block: "nearest" }); }
	if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") { const q = pk.querySelector("[data-npq]"); if (q) q.focus(); } // (the letter goes on into the search)
}
