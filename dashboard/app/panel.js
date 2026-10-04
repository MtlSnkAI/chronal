// The page of runs (main.js's #/runs, #/runs/<run or group>[/<tab>][?replay], #/compare): its title and actions (the
// replay, Rerun, stop, remove: each asked first in a popover at its button), its tabs (they stay at the top, a replay's
// frame under them), its body: the Runs table, a run's tabs (Characters, Data, Buffs and debuffs, Supply, Monsters,
// Run), a group's or Compare's (compare.js).
import { h } from "./vendor/preact.js";
import { useState, useEffect, useLayoutEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtN, fmtG, fmtSpan, hms, pct, num, tot, ratio, dur, cvar, live_, seedOf, membersOf, api, short } from "./lib.js";
import { S, nav, runHash, launchesOf, activeL, stopAt, notes, dropRuns, setupOf, baseOf, redraw, pollSoon, itemLogs, itemsLoad } from "./store.js";
import { icon, iconFit, mon, weaponOf, Sheet, Inventory, Cond, condName, condIcon, kindOf, BOLT, STOP, AGAIN, PLAY } from "./art.js";
import { closeTip } from "./tips.js";
import { Fold, Log, LogBox, Status, Swatch, RunLabel, whatTip, SeedPill, StateMark, LwBadge, Kt, Ktv, Ask, useWidth } from "./ui.js";
import { statsOf, mval, fmtM, cunit, isRate, nowOf, kpiMs, heroM, ranksOf, MET, drillEntries, entryIcon, residual, spawnsText, sheetStats, condsAtEnd, deathsAt, groupsOf, seriesOf, monstersOf } from "./metrics.js";
import { RunCharts, GW } from "./charts.js";
import { ReplayFrame, rpMode, useRpSheets } from "./replay.js";
import { V, setV, DTABS } from "./view.js";
import { CmpBody, CmpHead, nameSeries } from "./compare.js";
import { DataPanels, panelsFor } from "./data.js";
import { RunsTable, picks, setPicks, launchRun } from "./runs.js";

const html = htm.bind(h);
// the page's subject: the Runs table (all), a run (w), a group (its one series, g), Compare (the series in the URL),
// a launch not yet a listed run (l), a run or group no longer listed (missing)
function target(route) {
	if (route.page === "compare") return { cmp: nameSeries(seriesOf(route.ids)) };
	if (route.page === "run") {
		const s = seriesOf([route.id])[0], l = !s && launchesOf().find((x) => x.key === route.id);
		return s ? (s.group ? { cmp: nameSeries([s]), g: s.group } : { w: s.w }) : l ? { l } : { missing: route.id };
	}
	return { all: true };
}
export function Panel({ route }) {
	const t = target(route), ref = useRef(null), wt = useRef(null), pb = useRef(null), pbW = useWidth(pb) || 540;
	const [ask, setAsk] = useState(null); // the question asked: { what: remove | clear | stop | force, id }
	const btns = useRef({}), at = (k) => () => btns.current[k];
	// a tab in the URL: remembered; another page: no question open, no tooltip
	useEffect(() => {
		const k = route.tab && route.tab !== "summary" && DTABS.some(([x]) => x === route.tab) ? route.tab : null;
		if (k && k !== V.dtab) setV({ dtab: k });
		if (route.page === "compare") setPicks(route.ids);
	}, [route.page, route.tab, (route.ids || []).join()]);
	useEffect(() => { closeTip(); setAsk(null); }, [route.page, route.id, (route.ids || []).join()]);
	// a launch's page: its run's Run tab once the run is listed (the launch's log stays open there)
	const ran = t.l && t.l.run && S.data.some((w) => w.id === t.l.run) ? t.l.run : null;
	useEffect(() => { if (ran) nav(runHash(ran, "run"), true); }, [ran]);
	// the panels' breakdowns stay (a party's), a character's only when that character is in this run too
	useEffect(() => panelsFor(route.page === "run" ? t.w || null : null), [route.page, route.id]);
	// the page's tabs stick to the top, a replay's frame under them
	useLayoutEffect(() => { document.documentElement.style.setProperty("--wth", (wt.current ? wt.current.offsetHeight : 0) + "px"); });
	const rpOk = !!(t.w && rpMode(t.w)), ws = route.replay && (rpOk || !S.loaded) ? "replay" : "detail";
	const tab = route.page === "compare" && route.tab === "summary" ? "summary" : V.dtab;
	const asked = (k, id) => !!ask && ask.what === k && (id == null || ask.id === id);
	const toggleAsk = (what, id) => setAsk(asked(what, id) ? null : { what, id });
	let head, acts = null, tabs = null, body;
	if (t.all) {
		head = html`<h2 class="ttl">Runs</h2>`;
		acts = S.data.some((w) => !live_(w)) ? html`<button type="button" class="cb" id="clear" ref=${(e) => (btns.current.clear = e)} aria-haspopup="dialog" aria-expanded=${asked("clear")} data-tip="every finished and stopped run to live/removed/ (move them back to restore them)" onClick=${() => toggleAsk("clear")}>Remove finished</button>` : null;
		body = S.loaded ? html`<${RunsTable} />` : html`<p class="mnote">loading...</p>`;
	} else if (t.missing) {
		head = html`<h2 class="ttl">${S.loaded ? "Not found" : "Loading..."}</h2>`;
		body = S.loaded ? html`<p class="mnote">${t.missing} is not among the runs: removed, or its group has changed. <a href="#/runs">All runs</a></p>` : null;
	} else if (t.l) {
		const { w, what } = launchRun(t.l);
		head = html`<div class="tw"><h2 class="ttl" data-tip=${what || null}><${RunLabel} w=${w} /></h2></div>`;
		tabs = html`<nav class="seg dt" aria-label="Tabs"><a href=${runHash(t.l.key, "run")} aria-current="page" data-tip="the other tabs come with its run">Run</a></nav>`;
		body = html`<div class="body run"><section><h4>Launch</h4>${what ? html`<p class="gu">${what}</p>` : null}<${LaunchStatus} l=${t.l} sel=${t.l.key} /></section></div>`;
	} else if (t.w) {
		const w = t.w, rank = ranksOf(S.data).rank.get(w.id);
		head = [picks.has(w.id) ? html`<${Swatch} id=${w.id} />` : null, html`<div class="tw"><div class="pills"><${SeedPill} w=${w} /><${StateMark} w=${w} /></div><h2 class="ttl" data-tip=${whatTip(w)}><${RunLabel} w=${w} /></h2></div>`,
			rank ? html`<span class=${"rank" + (rank <= 3 ? " r" + rank : "")}>#${rank}</span>` : null];
		acts = [rpOk ? html`<button type="button" class="cb" aria-pressed=${ws === "replay"} data-tip=${ws === "replay" ? "hide the game" : "watch the run in the game's own page, from any moment: the tabs follow it"} onClick=${() => nav(runHash(w.id, V.dtab, ws !== "replay"), true)}>${PLAY()}Replay</button>` : null,
			html`<${RerunBtn} w=${w} />`, html`<${RunControls} w=${w} ask=${ask} toggleAsk=${toggleAsk} btns=${btns} />`, html`<${RemoveBtn} runs=${[w]} on=${asked("remove")} set=${(e) => (btns.current.remove = e)} toggle=${() => toggleAsk("remove")} />`];
		tabs = html`<${Tabs} route=${route} tab=${tab} replay=${ws === "replay"} />`;
		body = html`<${RunBody} w=${w} tab=${tab} replay=${ws === "replay"} pbW=${pbW} />`;
	} else {
		const g = t.g;
		head = html`<${CmpHead} ss=${t.cmp} />`;
		if (g) { const w = [...g.runs].sort((a, b) => (Date.parse(b.started) || 0) - (Date.parse(a.started) || 0)).find((x) => x.ctl && x.ctl.rerun); acts = [html`<${RerunBtn} w=${w} />`, html`<${RemoveBtn} runs=${g.runs} on=${asked("remove")} set=${(e) => (btns.current.remove = e)} toggle=${() => toggleAsk("remove")} />`]; }
		tabs = html`<${Tabs} route=${route} tab=${tab} />`;
		body = !t.cmp.length ? html`<p class="mnote">${S.loaded ? html`Nothing to compare: pick 2 or more runs or groups in the list, then Compare. <a href="#/runs">All runs</a>` : "loading..."}</p>` : html`<${CmpBody} ss=${t.cmp} route=${route} tab=${tab} pbW=${pbW} />`;
	}
	const err = notes.get("tools");
	// the questions: remove (the run or a group's runs), every finished run, stop, force stop
	const runs = t.w ? [t.w] : t.g ? t.g.runs : [], live = runs.filter(live_), cant = live.filter((x) => !(x.ctl && x.ctl.stop));
	const done = () => setAsk(null);
	const q = !ask ? null : ask.what === "remove" ? html`<${Ask} at=${at("remove")} onClose=${done} text=${(runs.length === 1 ? (live.length ? "Still running: stop it and remove it?" : "Remove this run?") : "Remove the group's " + runs.length + " runs?" + (live.length ? " " + live.length + " running: stopped first." : "")) + (cant.length ? " " + cant.length + " can't be stopped from here." : "") + " They move to live/removed/."}
			go=${[live.length ? "Stop and remove" : "Remove", () => (done(), removeRuns(runs, route)), { "data-trm": "1" }]} no=${["Keep", { "data-tno": "1" }]} />`
		: ask.what === "clear" ? html`<${Ask} at=${at("clear")} onClose=${done} text="Move all finished and stopped runs to live/removed/?" go=${["Remove", async () => { done(); await api("api/clear-finished", "POST"); dropRuns(live_); }, { id: "clear-yes" }]} no=${["Keep", { id: "clear-no" }]} />`
		: ask.what === "stop" || ask.what === "force" ? html`<${Ask} at=${at(ask.what)} onClose=${done} text=${ask.what === "stop" ? "Stop this run? It ends at the next game minute and writes its final numbers." : "Force stop? The process is killed at once: no final snapshot."}
			go=${[ask.what === "stop" ? "Stop" : "Force stop", async () => { const id = ask.id, f = ask.what === "force"; done(); await stopRun(id, f); redraw(); const b = ref.current && ref.current.querySelector(".pab button"); if (b) b.focus({ preventScroll: true }); }]} no=${[ask.what === "stop" ? "Keep running" : "Wait"]} />` : null;
	return html`<div id="panel" ref=${ref} class=${ws === "replay" && rpOk ? "rp" : null}>
		<div class="ph"><div class="hph">${head}</div><div class="pab" role="toolbar" aria-label="Actions">${acts}${err ? html`<${Status} dot="bad" text=${err} />` : null}</div></div>
		<div class="wt" ref=${wt}>${tabs}</div>
		${t.w && ws === "replay" && rpOk ? html`<${ReplayFrame} key=${t.w.id} w=${t.w} />` : null}
		<div class="pb" ref=${pb} onScroll=${closeTip}>${body}</div>
		${q}
	</div>`;
}
// the page's tabs: a run's or a group's, Compare's (its summary first); a link each (the URL keeps the tab; a click
// replaces it, as the same page)
function Tabs({ route, tab, replay }) {
	const cmp = route.page === "compare", href = (k) => (cmp ? "#/compare" + (k !== "summary" ? "/" + k : "") + "?ids=" + route.ids.map(encodeURIComponent).join(",") : runHash(route.id, k, replay));
	const go = (e) => { if (e.ctrlKey || e.metaKey || e.shiftKey) return; e.preventDefault(); closeTip(); nav(e.currentTarget.getAttribute("href"), true); };
	return html`<nav class="seg dt" aria-label="Tabs">${(cmp ? [["summary", "Summary"]] : []).concat(DTABS).map(([k, l]) => html`<a href=${href(k)} aria-current=${tab === k ? "page" : null} onClick=${go}>${l}</a>`)}</nav>`;
}

// ---- run control: Rerun (the New sim page, from its setup), stop, force stop, remove
const RerunBtn = ({ w }) => (w && w.ctl && w.ctl.rerun ? html`<a class="cb" href=${"#/new?from=" + encodeURIComponent(w.id)} data-tip="its setup again, as you change it: the New sim page">${AGAIN()}Rerun</a>`
	: w && w.ctl && w.ctl.rerun_why ? html`<button type="button" class="cb" disabled data-tip=${w.ctl.rerun_why}>${AGAIN()}Rerun</button>` : null);
function RemoveBtn({ runs, on, set, toggle }) {
	const cant = runs.filter((x) => live_(x) && !(x.ctl && x.ctl.stop));
	return html`<button type="button" class="cb" data-tremove="1" ref=${set} aria-haspopup="dialog" aria-expanded=${on} disabled=${cant.length && cant.length === runs.length} data-tip=${cant.length && cant.length === runs.length ? "running, and it can't be stopped from here: stop it where it runs" : null} onClick=${toggle}>Remove</button>`;
}
const askedAt = (x) => (x == null ? null : typeof x === "number" ? x : Date.parse(x) || null);
function RunControls({ w, ask, toggleAsk, btns }) {
	const c = w.ctl || {}, err = notes.get(w.id), out = [];
	const on = (k) => !!ask && ask.what === k && ask.id === w.id;
	if (live_(w) && c.stop) {
		const at = stopAt.get(w.id) || askedAt(c.pending && c.pending.stop ? c.pending.at : null);
		if (at) { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); out.push(html`<${Status} dot="stopped" text=${s < 30 ? "Stopping... (asked " + s + " s ago)" : "Not stopped after " + s + " s."}>${s >= 30 && c.force ? html`<button type="button" class="cb stop" ref=${(e) => (btns.current.force = e)} aria-haspopup="dialog" aria-expanded=${on("force")} onClick=${() => toggleAsk("force", w.id)}>Force stop</button>` : null}</${Status}>`); }
		else out.push(html`<button type="button" class="cb stop" ref=${(e) => (btns.current.stop = e)} aria-haspopup="dialog" aria-expanded=${on("stop")} onClick=${() => toggleAsk("stop", w.id)}>${STOP()}Stop run</button>`);
		const st = w.state || {}, pending = st.pending || exportAt.get(w.id);
		out.push(html`<button type="button" class="cb" disabled=${!!pending} data-tip=${"every character's state now (gear, items, bank, server state) to " + w.id + ".state/: chronal continue, a setup's state.from" + (st.exports && st.exports.length ? " (" + st.exports.length + " so far)" : "")} onClick=${() => exportRun(w.id)}>${pending ? "Exporting..." : "Export state"}</button>`);
	}
	if (err) out.push(html`<${Status} dot="bad" text=${err} />`);
	return out;
}
const exportAt = new Map(); // id -> the label asked for, until the snapshot lists it
async function exportRun(id) {
	notes.delete(id);
	try {
		const r = await api("api/runs/" + encodeURIComponent(id) + "/export", "POST", {}), o = await r.json().catch(() => ({}));
		if (r.ok) { exportAt.set(id, o.label); setTimeout(() => (exportAt.delete(id), redraw()), 10000); } else notes.set(id, "Not exported: " + (o.reason || "HTTP " + r.status));
	} catch (x) { notes.set(id, "Not exported: " + x.message); }
	redraw();
}
async function stopRun(id, force) {
	notes.delete(id);
	try {
		const r = await api("api/runs/" + encodeURIComponent(id) + "/stop", "POST", force ? { force: true } : {}), o = await r.json().catch(() => ({}));
		if (r.ok) stopAt.set(id, stopAt.get(id) || Date.now()); else notes.set(id, "Not stopped: " + (o.reason || (r.status === 403 ? "not allowed from here" : "HTTP " + r.status)));
	} catch (x) { notes.set(id, "Not stopped: " + x.message); }
}
// the runs a page's Remove acts on: moved to live/removed/ (a running one stopped first)
async function removeRuns(runs, route) {
	notes.delete("tools");
	const gone = new Set();
	for (const w of runs) {
		if (live_(w) && !(w.ctl && w.ctl.stop)) continue;
		try {
			const r = await api("api/live/" + encodeURIComponent(w.id) + (live_(w) ? "?stop=1" : ""), "DELETE"), o = await r.json().catch(() => ({}));
			if (r.status === 202) stopAt.set(w.id, Date.now());
			else if (r.ok) gone.add(w.id);
			else notes.set("tools", "Not removed: " + (o.reason || "HTTP " + r.status));
		} catch (e) { notes.set("tools", "Not removed: " + e.message); }
	}
	dropRuns((w) => !gone.has(w.id));
	if (route.page === "run" && !S.data.some((x) => x.id === route.id) && !groupsOf(S.data).groups.has(route.id)) nav("#/runs");
}
// a launch's progress: in the Run tab of the run it started
function LaunchStatus({ l, sel }) {
	const run = l.run && S.data.find((w) => w.id === l.run), tag = (run ? run.tag : l.tag) || "the rerun";
	const [dot, text] = l.state === "queued" ? ["stopped", tag + ": queued, it starts when sim threads free up"]
		: l.state === "starting" ? ["stopped", tag + ": starting (building CODE, booting the world)..."]
		: l.state === "running" ? (run && !live_(run) ? ["stopped", tag + ": ended, its process is finishing..."] : ["running", tag + ": running"]) : l.state === "exited" ? ["", tag + ": ended"]
		: l.state === "failed" ? ["bad", tag + " failed: " + (l.reason || (l.exit != null ? "exit " + l.exit : "?"))] : l.state === "cancelled" ? ["", tag + ": cancelled"] : ["", tag + ": " + l.state];
	return html`<${Status} dot=${dot} text=${text}>${run && run.id !== sel ? html`<a class="cb" href=${runHash(run.id)}>Show it</a>` : null}
		${activeL(l) ? html`<button type="button" class="cb" onClick=${async () => { try { await api("api/launch/" + encodeURIComponent(l.key), "DELETE"); } catch (x) {} pollSoon(); }}>Cancel</button>` : null}<${LogBox} l=${l} /></${Status}>`;
}

// ---- a run's tabs
function RunBody({ w, tab, replay, pbW }) {
	const W = pbW - 32;
	if (tab === "buffs") return html`<${RunCharts} w=${w} part="buffs" W=${Math.max(160, W - (W >= 700 ? 190 + 12 : 0) - 84 - 50 - 16) + GW.g + GW.r} none=${html`<p class="mnote">- no conditions recorded in this run</p>`} />`;
	if (tab === "supply") return statsOf(w).M ? [html`<${SupplyBox} w=${w} />`, html`<${RunCharts} w=${w} part="supply" W=${W} />`] : html`<p class="mnote">- no merchant in this run</p>`;
	if (tab === "run") return html`<${RunInfo} w=${w} />`;
	if (tab === "monsters") return html`<${Monsters} w=${w} />`;
	if (tab === "data") return [html`<${KpiStrip} w=${w} />`, html`<${DataPanels} w=${w} W=${W} />`];
	return html`<${Chars} w=${w} replay=${replay} />`;
}

// the headline numbers: the headline's metric (its "now" while running), deaths, the chips'
function KpiStrip({ w }) {
	const S1 = statsOf(w), hm = heroM(), running = live_(w), deaths = S1.party.deaths || 0, who = w.players.filter((p) => p.deaths).map((p) => p.name + " " + p.deaths).join(", ");
	const n = running && isRate(hm) ? nowOf(w, hm) : null;
	const sub = running && (n || w.speed.now != null) ? [n ? "now " + fmtM(hm, n.now) : "", w.speed.now != null ? [BOLT(), w.speed.now + "x"] : null] : null;
	return html`<div class="kpis">${kpiMs().map((m, i) => {
		const v = m === MET.deaths ? deaths : mval(m, w).party, t = v == null ? null : m.k === "rate_h" ? v * S1.hrs : m.k === "rate_s" ? v * S1.secs : null, val = html`<${Ktv} v=${fmtM(m, v)} unit=${v != null ? cunit(m) : ""} />`;
		if (!i) return html`<${Kt} key=${m.id} ic=${m.ic()} label=${m.label} cls="khero" sub=${sub} tip=${n ? "now: over the last " + dur(n.win) + " of game time" : null}>${val}</${Kt}>`;
		if (m === MET.deaths) return html`<${Kt} key=${m.id} ic=${m.ic()} label=${m.label} cls=${deaths ? "bad" : ""} tip=${who || null}>${val}</${Kt}>`;
		return html`<${Kt} key=${m.id} ic=${m.ic()} label=${m.label} cls=${v == null ? "na" : ""} tip=${v == null ? "not measured in this run" : t != null ? fmtN(t, m.d ?? 1) + " in all" : null}>${val}</${Kt}>`;
	})}</div>`;
}

// ---- Recount-style meters: the party's total on top (everyone's sum, a click opens its breakdown), then a row per
// character, biggest first (none or 0: dimmed, last); a row with a chevron opens its breakdown in place of the list.
// Every amount raw; overkill and overheal their own meters. m: the meter (a Data panel's metric); drill: the breakdown
// shown ({ who, by }; a Breakdown panel's: the party's, fixed), go(drill): another one (null: back to the list)
// after a drill in or out, the focus on its Back button (or the "by" picked), or on its row; Esc (within it) goes back
export function useDrillFocus(ref, back) {
	const want = useRef(null), backR = useRef(back);
	backR.current = back;
	useLayoutEffect(() => { if (want.current && ref.current) { const b = ref.current.querySelector(want.current); want.current = null; if (b) b.focus(); } });
	useEffect(() => {
		const key = (e) => { if (e.key === "Escape" && !e.defaultPrevented && backR.current && ref.current && ref.current.contains(document.activeElement)) { e.preventDefault(); want.current = "[data-drill]"; backR.current(); } };
		document.addEventListener("keydown", key);
		return () => document.removeEventListener("keydown", key);
	}, []);
	return (sel) => (want.current = sel);
}
export function Meters({ w, m, drill, go, fixed }) {
	const S1 = statsOf(w), ref = useRef(null), focus = useDrillFocus(ref, drill && !fixed ? () => go(null) : null);
	const has = (x) => (x.k === "items" ? S1.P.some((c) => c.p.items || c.p.pots) : S1.P.some((c) => x.v(c, S1) != null)); // not measured in this run
	// with gold: the account's gold (every character's plus the bank), now vs at the start, and whether the flows explain
	// each character's gold (now - at the base)
	const res = m.f === "gold" ? S1.P.map((c) => [c, residual(c.p, c.g)]).filter(([, r]) => r != null) : [], odd = res.filter(([, r]) => Math.abs(r) >= 1);
	const acct = [m.f === "gold" && w.gold && w.gold.now != null ? html`<p class="mnote" data-tip="every character's gold plus the bank, now vs at the start">${icon("gold")} account ${(w.gold.now >= w.gold.start ? "+" : "") + fmtN(w.gold.now - w.gold.start)} net, ${fmtN(S1.per(w.gold.now - w.gold.start))}/h</p>` : null,
		!res.length ? null : odd.length ? html`<p class="mnote w" data-tip=${"gold now - gold at the base - the flows, per character:\n" + odd.map(([c, r]) => c.name + " " + (r > 0 ? "+" : "") + fmtN(r, 0)).join("\n")}>${icon("condition_bad")} unexplained ${odd.map(([c, r]) => c.name + " " + (r > 0 ? "+" : "") + fmtN(r, 0)).join(", ")}</p>`
			: html`<p class="mnote" data-tip="every character's gold now = its gold at the base + these flows">${icon("condition_good")} the gold ledger closes</p>`];
	if (m.k === "items") return html`<section class="meters" ref=${ref}><${ItemsWho} w=${w} /></section>`;
	if (!has(m)) return html`<section class="meters" ref=${ref}><p class="mnote">- not measured in this run</p></section>`;
	// every character has a row: the ones with any, biggest first, then the rest dimmed (0, or "-": not measured)
	const all = S1.P.map((c) => [c, m.v(c, S1)]), rows = all.filter(([, v]) => v != null && v !== 0).sort((a, b) => b[1] - a[1]), rest = all.filter(([, v]) => v == null || v === 0), total = tot(all, ([, v]) => v) || 0;
	const max = Math.max(0, ...rows.map(([, v]) => v)), f2 = (v) => (v == null ? "-" : m.u2 === "%" ? pct(v) : fmtN(v, m.d) + m.u2), f1 = (v) => fmtN(v, m.d); // m.d: counts have no decimals
	const c2of = (xs) => { if (m.u2 === "%") return m.k === "over" ? ratio(xs.map(([c]) => c).filter((c) => c.overheal != null), (c) => c.overheal, (c) => c.ohBase) : ratio(xs.map(([c]) => c).filter((c) => c.overkill != null), (c) => c.overkill, (c) => c.dmg); return tot(xs, ([c, v]) => m.c2(c, S1, v)); };
	const bysOf = (party) => [...(m.by || []), ...(party ? m.pby || [] : [])];
	const canDrill = (cs, party) => bysOf(party).some((b) => drillEntries(w, S1, m, cs, b).length);
	const cols = html`<div class="mrow cols" aria-hidden="true"><span></span><span></span><span class="r">${m.cols[0]}</span><span class="r">${m.cols[1]}</span><span class="p">share</span><span></span></div>`;
	const cv = (dr) => (dr ? html`<i class="cv" aria-hidden="true"></i>` : html`<span></span>`);
	const drillTo = (who) => { focus(".back"); go(drill && drill.who === who ? null : { who, by: drill && drill.by }); };
	const hsum = [f1(total), m.u2 && m.u2 !== "%" && c2of(rows) != null ? " · " + f2(c2of(rows)) : m.u2 === "%" && c2of(rows) != null ? " · " + pct(c2of(rows)) : ""].join("");
	const dc = drill && (drill.who === "*" ? { name: "*" } : (rows.find(([c]) => c.name === drill.who) || [])[0]);
	if (dc) {
		// the breakdown in place of the list: back, whose and what, by what, its rows (the party's split by character)
		const party = dc.name === "*", cs = party ? S1.P : [dc], bys = bysOf(party).filter((b) => (!fixed || b !== "character") && drillEntries(w, S1, m, cs, b).length), by = bys.includes(drill.by) ? drill.by : bys[0];
		const es = by ? drillEntries(w, S1, m, cs, by) : [], dmax = Math.max(0, ...es.map((e) => Math.abs(e.v))), dtot = es.reduce((a, e) => a + Math.max(0, e.v), 0);
		const clr = (k) => { const p = w.players.find((x) => x.name === k); return p ? cvar(p.type) : party ? "--c:var(--line)" : cvar(dc.type); };
		const tot1 = (v) => (m.rate === "h" ? v * S1.hrs : m.rate ? v * S1.secs : v);
		const sec = (e) => (m.rate ? (e.hits || e.casts ? fmtN(e.hits || e.casts, 0) + (e.hits ? " hits" : " casts") : "") : m.u2 === "%" ? (e.raw > 0 ? pct(e.v / e.raw) : "") : by === "monster" ? fmtN(S1.per(e.v)) + "/h" : f2(m.c2(null, S1, e.v)));
		const info = (e) => [e.hits && e.hits + " hits", e.crits && pct(e.crits / e.hits) + " crits", e.misses && e.misses + " misses", e.hits && "avg " + fmtN(tot1(e.v) / e.hits) + " per hit", e.casts && e.casts + " casts"].filter(Boolean).join(", ");
		const split = (e) => (party && e.parts && Object.keys(e.parts).length > 1 ? S1.P.filter((c) => e.parts[c.name]).map((c) => c.name + " " + pct(e.parts[c.name] / e.v)).join(", ") : "");
		// the party's rows: a fill per character in its class colour, side by side
		const fills = (e) => {
			if (!party || !e.parts || by === "healer" || by === "character" || e.v < 0) return html`<i class="fill" style=${"width:" + (dmax > 0 ? (100 * Math.abs(e.v)) / dmax : 0).toFixed(1) + "%"}></i>`;
			let left = 0;
			return S1.P.map((c) => { const pv = e.parts[c.name]; if (!(pv > 0) || !(dmax > 0)) return null; const wd = (100 * pv) / dmax, x = html`<i class="fill" style=${cvar(c.type) + ";left:" + left.toFixed(1) + "%;width:" + wd.toFixed(1) + "%"}></i>`; left += wd; return x; });
		};
		// the kills by monster are every last hit in the world (a kill by no run character too): their own total
		const kin = by === "monster" ? es.reduce((a, e) => a + e.v, 0) : null;
		const one = rows.find(([c]) => c === dc);
		return html`<section class="meters" ref=${ref}><div class="drill">
			<div class="dh">${fixed ? null : html`<button type="button" class="back" onClick=${() => { focus("[data-drill]"); go(null); }}><i class="chev"></i>Back</button>`}${party ? icon("citizens") : weaponOf(dc.p, 22)}<span>${(party ? "Party" : dc.name) + " - " + m.label}</span><span class="sum">${party ? hsum : f1(one[1]) + (m.u2 !== "%" ? " · " + f2(m.c2(dc, S1, one[1])) : "")}</span></div>
			${bys.length > 1 ? html`<span class="seg sm" role="group" aria-label="Breakdown by">${bys.map((b) => html`<button type="button" data-dby=${b} aria-pressed=${b === by} onClick=${() => go({ ...drill, by: b })}>by ${b}</button>`)}</span>` : by ? html`<p class="mnote">by ${by}</p>` : null}
			${kin != null ? html`<p class="mnote">every last hit in the world: ${fmtN(kin, m.d)}${m.rate ? "" : kin !== tot(cs, (c) => c.kills) ? ", the run's " + fmtN(tot(cs, (c) => c.kills), 0) : ""}</p>` : null}
			<div class="mlist">${cols}${es.length ? es.map((e) => html`<div key=${e.k} class="mrow" style=${e.v < 0 ? "--c:var(--muted)" : clr(e.k)} data-tip=${e.k + ": " + fmtN(e.v) + (info(e) ? ", " + info(e) : "") + (split(e) ? "\n" + split(e) : "")}>${fills(e)}
				<span class="ic">${entryIcon(w, e.k)}</span><span class="nm">${e.k}</span><span class="v">${f1(e.v)}</span><span class="r">${sec(e)}</span><span class="p">${e.v > 0 && dtot > 0 ? pct(e.v / dtot) : ""}</span><span></span></div>`) : html`<p class="mnote">- not measured</p>`}</div>
		</div>${acct}</section>`;
	}
	const row = (c, v) => {
		const p = c.p, dr = !!v && canDrill([c], false), Tag = dr ? "button" : "div";
		const mult = (k, ic, what) => (p.buffs && Number.isFinite(p.buffs[k]) && p.buffs[k] !== 1 ? html`<span class="bdg" data-tip=${what + " multiplier now (party bonus, gear, elixirs, auras...)"}>${ic}x${+p.buffs[k].toFixed(2)}</span>` : null);
		const extra = m.f === "xp" ? [html`<${LwBadge} v=${p.buffs && p.buffs.lonewolf} />`, p.party && p.party.share != null && S1.P.length > 1 ? html`<span class="bdg" data-tip="party xp share (the server's split)">${icon("citizens")}${pct(p.party.share)}</span>` : null, mult("xpm", icon("xpbooster"), "xp")]
			: m.f === "gold" ? mult("goldm", icon("gold"), "gold") : null;
		return html`<${Tag} key=${c.name} type=${dr ? "button" : null} data-drill=${dr ? c.name : null} class=${"mrow" + (v ? "" : " z")} style=${cvar(c.type)} onClick=${dr ? () => drillTo(c.name) : null}><i class="fill" style=${"width:" + (max > 0 ? (100 * Math.max(0, v)) / max : 0).toFixed(1) + "%"}></i>
			<span class="ic">${weaponOf(p, 22)}</span><span class="nm">${c.name}${extra}</span><span class="v">${f1(v)}</span><span class="r">${f2(m.c2(c, S1, v))}</span><span class="p">${v != null && total > 0 ? pct(v / total) : "-"}</span>${cv(dr)}</${Tag}>`;
	};
	// the party: everyone's sum, on top, always a way into its breakdown when there is one
	const pdr = canDrill(S1.P, true), PTag = pdr ? "button" : "div";
	return html`<section class="meters" ref=${ref}><div class="mlist">${cols}
		<${PTag} type=${pdr ? "button" : null} data-drill=${pdr ? "*" : null} class="mrow party" onClick=${pdr ? () => drillTo("*") : null}><span class="ic">${icon("citizens")}</span><span class="nm">Party</span><span class="v">${f1(total)}</span><span class="r">${f2(c2of(rows))}</span><span class="p">${total > 0 ? "100%" : "-"}</span>${cv(pdr)}</${PTag}>
		${[...rows, ...rest].map(([c, v]) => row(c, v))}</div>${total ? null : html`<p class="mnote">${m.none}</p>`}${acct}</section>`;
}
// items per item: looted, used (drunk, scrolls...), bought, sold (NPCs), traded in and out (stands, buy orders), sent,
// received; the party's or one character's
const ICOLS = ["looted", "consumed", "bought", "sold", "stand_bought", "stand_sold", "sent", "received"];
function ItemsWho({ w }) {
	const S1 = statsOf(w), who = S1.P.some((c) => c.name === V.itemsWho) ? V.itemsWho : "party", cs = who === "party" ? S1.P : S1.P.filter((c) => c.name === who);
	const seg = html`<div class="seg sm iwho" role="group" aria-label="Whose items"><button type="button" aria-pressed=${who === "party"} onClick=${() => setV({ itemsWho: "party" })}>${icon("citizens")}Party</button>
		${S1.P.map((c) => html`<button type="button" aria-pressed=${who === c.name} style=${cvar(c.type)} onClick=${() => setV({ itemsWho: c.name })}>${weaponOf(c.p, 20)}${c.name}</button>`)}</div>`;
	const rows = new Map(), tip = new Map(), known = new Set(), q = (v) => (v && typeof v === "object" ? ("q" in v ? v.q : Object.values(v).reduce((a, b) => a + b, 0)) : v || 0);
	for (const c of cs) {
		const it = c.p.items;
		if (it) for (const [i, k] of ICOLS.entries()) {
			known.add(k);
			for (const [name, v] of Object.entries(it[k] || {})) {
				(rows.get(name) || rows.set(name, ICOLS.map(() => 0)).get(name))[i] += q(v);
				// who it went to or came from, the gold of a buy or sale
				const t = tip.get(name + k) || tip.set(name + k, []).get(name + k);
				if (v && typeof v === "object") t.push("q" in v ? c.name + ": " + v.q + " for " + fmtN(v.gold) + " gold" : Object.entries(v).map(([x, n]) => c.name + (k === "sent" ? " to " : " from ") + x + ": " + n).join(", "));
			}
		}
	}
	if (!rows.size) return [seg, html`<p class="mnote">- no items measured</p>`];
	const body = [...rows].sort((a, b) => b[1].reduce((x, y) => x + y, 0) - a[1].reduce((x, y) => x + y, 0)).map(([name, r]) => html`<tr><td><span>${iconFit(name, 22)}${name}</span></td>
		${r.map((v, i) => { const t = tip.get(name + ICOLS[i]); return html`<td data-tip=${t && t.length ? t.join("\n") : null}>${!known.has(ICOLS[i]) ? html`<span class="z">-</span>` : v ? fmtN(v, 0) : ""}</td>`; })}</tr>`);
	return [seg, html`<div class="iscroll"><table class="itab"><tbody><tr><th>item</th><th>looted</th><th>used</th><th>bought</th><th>sold</th><th data-tip="bought from a merchant's stand, or a buy order filled">traded in</th><th data-tip="sold at its stand, or into a buy order">traded out</th><th>sent</th><th>received</th></tr>${body}</tbody></table></div>`];
}
// the items, from the run's items' events (store.js itemsLoad): what was upgraded, compounded or given a stat (per item
// and step: succeeded, failed, lost; then each try) and each loot (who, what, when); the newest first
export const ItemsSeg = ({ n }) => html`<span class="seg sm" role="tablist" aria-label="Items"><button role="tab" aria-selected=${V.itab === "up"} onClick=${() => setV({ itab: "up" })}>Upgraded${n ? " " + n[0] : ""}</button><button role="tab" aria-selected=${V.itab === "loot"} onClick=${() => setV({ itab: "loot" })}>Looted${n ? " " + n[1] : ""}</button><button role="tab" aria-selected=${V.itab === "trade"} onClick=${() => setV({ itab: "trade" })}>Traded${n && n[2] ? " " + n[2] : ""}</button></span>`;
function useItems(w) {
	useEffect(() => void itemsLoad(w), [w]);
	return w.items_log ? itemLogs.get(w.id) || { ev: [], busy: true } : null;
}
// an item (hovered: the game's tooltip at its level; bare: the level not written), a character in its class colour
const Itm = ({ name, level, bare }) => html`<span class="itm" data-item=${name} data-level=${level || 0}>${iconFit(name, 20)}${name}${level && !bare ? html`<b class="lvt">+${level}</b>` : null}</span>`;
const Who = ({ w, name }) => { const p = w.players.find((x) => x.name === name); return html`<span class="itm" style=${p ? cvar(p.type) : null}>${p ? weaponOf(p, 18) : null}${name}</span>`; };
const when = (e) => html`<td>${hms(e.t * 1000)}</td>`;
// past LIST rows, the rest behind a button
const LIST = 100;
function Rows({ rows, cols, row }) {
	const [all, setAll] = useState(false), n = rows.length;
	return [(all ? rows : rows.slice(0, LIST)).map(row), !all && n > LIST ? html`<tr><td colspan=${cols}><button type="button" class="cb" onClick=${() => setAll(true)}>Show all ${fmtN(n, 0)}</button></td></tr>` : null];
}
// what an event log lacks: none recorded, still loading, cut at its size limit
function evNote(w, L) {
	if (!L) return html`<p class="mnote">- no item events recorded in this run</p>`;
	if (L.missing) return html`<p class="mnote">- the run's items' events file is gone</p>`;
	if (L.busy && !L.ev.length) return html`<p class="mnote">loading...</p>`;
	return null;
}
const capNote = (ev) => { const c = ev.length && ev[ev.length - 1].k === "cap" ? ev[ev.length - 1] : null; return c ? html`<p class="mnote w">${icon("condition_bad")} the record stopped at ${hms(c.t * 1000)} (16 MB): nothing after it here</p>` : null; };
const stepOf = (e) => (e.k === "stat" ? (e.stat || "stat") + " scroll" : e.k === "shiny" ? "shiny (" + e.offering + ")" : "+" + e.from + " → +" + e.to);
const levelOf = (e) => (e.k === "stat" ? 0 : e.k === "shiny" ? e.level : e.from);
const outcome = (e) => (e.ok ? html`<span class="ok">succeeded</span>` : html`<span class="ko">${e.lost ? "failed, item lost" : "failed"}</span>`);
function ItemsBox({ w }) {
	const L = useItems(w), ev = L ? L.ev : [], tries = ev.filter((e) => e.k === "upgrade" || e.k === "compound" || e.k === "stat" || e.k === "shiny"), loot = ev.filter((e) => e.k === "loot"), trades = ev.filter((e) => e.k === "trade");
	const seg = html`<div class="gh"><${ItemsSeg} n=${[fmtN(tries.filter((e) => e.ok).length, 0), fmtN(loot.reduce((a, e) => a + num(e.q), 0), 0), trades.length ? fmtN(trades.length, 0) : ""]} /><span class="gu">${V.itab === "up" ? "each try: its levels and how it went" : V.itab === "trade" ? "each sale at a stand or into a buy order: the price before the seller's tax" : "who looted what, and when"}</span></div>`;
	const none = evNote(w, L);
	let body;
	if (none) body = none;
	else if (V.itab === "trade") {
		// per item: units and gold each way; then each trade
		const per = new Map();
		for (const e of trades) { const r = per.get(e.item) || per.set(e.item, { q: 0, gold: 0, tax: 0, n: 0 }).get(e.item); (r.q += num(e.q)), (r.gold += num(e.price)), (r.tax += num(e.tax)), r.n++; }
		body = !trades.length ? html`<p class="mnote">no trades in this run</p>` : [html`<div class="iscroll"><table class="itab"><tbody><tr><th>item</th><th>trades</th><th>units</th><th>gold</th><th data-tip="the sellers' tax">tax</th></tr>
			${[...per].sort((a, b) => b[1].gold - a[1].gold).map(([k, r]) => html`<tr><td><${Itm} name=${k} /></td><td>${fmtN(r.n, 0)}</td><td>${fmtN(r.q, 0)}</td><td>${fmtN(r.gold, 0)}</td><td>${fmtN(r.tax, 0)}</td></tr>`)}</tbody></table></div>`,
			html`<${Fold} k="+trades" title=${"Each trade (" + fmtN(trades.length, 0) + ")"}><div class="iscroll"><table class="itab"><tbody><tr><th>when</th><th class="l">seller</th><th class="l">buyer</th><th class="l">item</th><th>units</th><th>price</th><th>tax</th><th class="l">how</th></tr>
				<${Rows} rows=${trades.slice().reverse()} cols=${8} row=${(e) => html`<tr>${when(e)}<td class="l"><${Who} w=${w} name=${e.who} /></td><td class="l"><${Who} w=${w} name=${e.to} /></td><td class="l"><${Itm} name=${e.item} level=${e.level} /></td><td>${fmtN(num(e.q), 0)}</td><td>${fmtN(num(e.price), 0)}</td><td>${fmtN(num(e.tax), 0)}</td><td class="l">${e.via === "wish" ? "buy order" : "stand"}</td></tr>`} /></tbody></table></div></${Fold}>`];
	}
	else if (V.itab === "up") {
		// per item and step: the tries, who tried, how they went
		const steps = new Map();
		for (const e of tries) {
			const key = e.k + "|" + e.item + "|" + (e.k === "stat" ? e.stat : levelOf(e));
			const r = steps.get(key) || steps.set(key, { e, ok: 0, fail: 0, lost: 0, by: new Set() }).get(key);
			e.ok ? r.ok++ : r.fail++;
			if (e.lost) r.lost++;
			r.by.add(e.who);
		}
		const list = [...steps.values()].sort((a, b) => a.e.item.localeCompare(b.e.item) || a.e.k.localeCompare(b.e.k) || (a.e.from ?? 0) - (b.e.from ?? 0));
		body = !tries.length ? html`<p class="mnote">no upgrades or compounds in this run</p>` : [html`<div class="iscroll"><table class="itab"><tbody><tr><th>item</th><th class="l">step</th><th class="l">by</th><th>succeeded</th><th>failed</th><th data-tip="items lost with a failed upgrade">lost</th><th>success</th></tr>
			${list.map((r) => html`<tr><td><${Itm} name=${r.e.item} level=${levelOf(r.e)} bare /></td><td class="l">${stepOf(r.e)}${r.e.k === "compound" ? html` <small class="gu">compound</small>` : null}</td><td class="l">${[...r.by].map((x) => html`<${Who} w=${w} name=${x} />`)}</td><td>${r.ok || ""}</td><td>${r.fail || ""}</td><td>${r.lost || ""}</td><td>${pct(r.ok / (r.ok + r.fail))}</td></tr>`)}</tbody></table></div>`,
			html`<${Fold} k="+tries" title=${"Each try (" + fmtN(tries.length, 0) + ")"}><div class="iscroll"><table class="itab"><tbody><tr><th>when</th><th class="l">character</th><th class="l">item</th><th class="l">step</th><th class="l">outcome</th></tr>
				<${Rows} rows=${tries.slice().reverse()} cols=${5} row=${(e) => html`<tr>${when(e)}<td class="l"><${Who} w=${w} name=${e.who} /></td><td class="l"><${Itm} name=${e.item} level=${levelOf(e)} bare /></td><td class="l">${stepOf(e)}${e.k === "compound" ? html` <small class="gu">compound</small>` : null}</td><td class="l">${outcome(e)}</td></tr>`} /></tbody></table></div></${Fold}>`];
	} else {
		// what was looted (a chip per item: its count), then each loot
		const per = new Map();
		for (const e of loot) per.set(e.item, (per.get(e.item) || 0) + num(e.q));
		body = !loot.length ? html`<p class="mnote">nothing looted in this run</p>` : [html`<div class="iql">${[...per].sort((a, b) => b[1] - a[1]).map(([k, n]) => html`<span class="iq" data-item=${k}>${iconFit(k, 20)}${fmtN(n, 0)}</span>`)}</div>`,
			html`<div class="iscroll"><table class="itab"><tbody><tr><th>when</th><th class="l">character</th><th class="l">item</th><th>quantity</th></tr>
				<${Rows} rows=${loot.slice().reverse()} cols=${4} row=${(e) => html`<tr>${when(e)}<td class="l"><${Who} w=${w} name=${e.who} /></td><td class="l"><${Itm} name=${e.item} level=${e.level} /></td><td>${fmtN(num(e.q), 0)}</td></tr>`} /></tbody></table></div>`];
	}
	return html`<section class="its">${seg}${body}${L ? capNote(ev) : null}</section>`;
}

// ---- Characters: a sheet per character (in the roster's order) as the game shows its own (the "c" window: the gear;
// the XP bar's panel: the stats), its conditions, where it spent its time, its inventory and game log. A run's: the
// snapshot (the end of the run; the latest while it runs). The Replay's: level, gear, stats, conditions, inventory and
// game log from the recording at the replay's moment (api/rec: the last player packet then, the log lines up to it)
function Chars({ w, replay }) {
	const { sheets, now } = useRpSheets(w, replay);
	return [html`<div class="chars">${membersOf(w).map((p) => html`<${CharCard} key=${p.name} w=${w} p=${p} now=${replay ? sheets.get(p.name) || null : null} rp=${replay} v=${now && now.v} />`)}</div>`,
		html`<${Fold} k="items" title="Items"><section class="box"><${ItemsBox} w=${w} /></section></${Fold}>`];
}
// the conditions as the game shows them: icons (buffs first, debuffs last); hovering or a click shows what one is
const CondIcons = ({ w, cs }) => { const ord = { buff: 0, other: 1, debuff: 2 }; return html`<div class="cic">${cs.map((c) => ({ ...c, kind: kindOf(w, c.k) })).sort((a, b) => (ord[a.kind] ?? 1) - (ord[b.kind] ?? 1) || a.k.localeCompare(b.k)).map((c) => html`<${Cond} k=${c.k} v=${c.v} cls=${"cs" + (c.kind === "debuff" ? " bad" : "")} label=${condName(c.k)}>${condIcon(c.k, c.v, w, 26)}</${Cond}>`)}</div>`; };
const Sr = ({ r, wide }) => html`<div class=${"sr" + (wide ? " wide" : "")} data-tip=${r[2] || null}><span>${r[0]}</span><b>${r[1]}</b></div>`;
// HP, MP and XP as the game's bars: filled to the value's share of its max, the numbers on them
function Bars({ hp, mhp, mp, mmp, xp, mxp, dead }) {
	const bar = (k, label, v, mx, text) => (Number.isFinite(v) && mx > 0 ? html`<div class=${"vbar " + k} role="meter" aria-label=${label} aria-valuemin="0" aria-valuemax=${mx} aria-valuenow=${v} data-tip=${label + " " + Math.round(v).toLocaleString("en") + " / " + Math.round(mx).toLocaleString("en")}>
		<i style=${"width:" + (100 * Math.max(0, Math.min(1, v / mx))).toFixed(1) + "%"}></i><span>${label}</span><b>${text}</b></div>` : null);
	return html`<div class="vbars">${bar("hp", "HP", dead ? 0 : hp, mhp, dead ? "dead" : Math.round(hp) + " / " + Math.round(mhp))}${bar("mp", "MP", mp, mmp, Math.round(mp) + " / " + Math.round(mmp))}${bar("xp", "XP", xp, mxp, fmtN(xp) + " / " + fmtN(mxp) + " · " + (xp > 0 && xp < mxp / 1000 ? +((100 * xp) / mxp).toPrecision(2) : ((100 * xp) / mxp).toFixed(1)) + "%")}</div>`;
}
function CharCard({ w, p, now, rp, v }) {
	const gear = now ? { gear: now.gear, gear_stat: now.gear_stat, type: p.type } : p, st = now ? now.stats || {} : p.stats || null;
	const conds = now ? Object.keys(now.s || {}).map((k) => ({ k })) : condsAtEnd(p), lv = now ? now.level : p.level, xp = now ? now.xp : p.xp, mx = now ? now.max_xp : p.max_xp;
	const where = Object.entries(p.maps || {}).filter(([, x]) => x >= 0.005).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, x]) => k + " " + pct(x)).join(", ");
	const x = st ? sheetStats(p, st, now) : null, end = rp && !now ? " (the end)" : "", inv = now ? now.items : p.inventory;
	// in a replay, the facts only the whole run has say so
	const whole = rp ? " (the run)" : "", deaths = rp ? (v != null ? deathsAt(w, p.name, v, baseOf(w)) : null) : p.deaths;
	const facts = [html`<div class="sr"><span>Free slots${end}</span><b>${now && now.free != null ? now.free : p.free}</b></div>`, where ? html`<div class="sr wide"><span>Time on${whole}</span><b>${where}</b></div>` : null,
		p.trips || p.outings ? [html`<div class="sr"><span>Trips${whole}</span><b>${p.trips}/${p.outings}</b></div>`, html`<div class="sr"><span>Out${whole}</span><b>${pct(p.out_share)}</b></div>`] : p.town_visits != null ? html`<div class="sr"><span>Town visits${whole}</span><b>${p.town_visits}</b></div>` : null];
	return html`<section class="ch" style=${cvar(p.type)}><div class="whohd"><span class="slot">${weaponOf(gear, 24)}</span><span class="chn"><b>${p.name}</b><span class="gu">L${lv} ${p.type}</span></span><${Grave} n=${deaths} /><${Errs} p=${p} /></div>
		<${Bars} hp=${now ? now.hp : p.hp} mhp=${now ? now.max_hp : st && st.max_hp} mp=${now ? now.mp : p.mp} mmp=${now ? now.max_mp : st && st.max_mp} xp=${xp} mxp=${mx} dead=${now ? now.rip : p.rip} />
		<${Sheet} p=${gear} />${conds.length ? html`<${CondIcons} w=${w} cs=${conds} />` : null}
		${x ? html`<div class="cst">${x.main.map((r) => html`<${Sr} r=${r} />`)}</div>` : html`<p class="mnote">no stats in this snapshot (recorded since 2026-09-26)</p>`}
		<${Fold} k="+sheet" title="More"><div class="cst">${x ? x.more.map((r) => html`<${Sr} r=${r} />`) : null}${facts}</div></${Fold}>
		${inv ? html`<${Fold} k="+inv" title=${"Inventory" + end}><${Inventory} items=${inv} /></${Fold}>` : null}
		${now ? (now.log ? html`<${Fold} k="+log" title="Game log"><${RecLog} w=${w} lines=${now.log} /></${Fold}>` : null) : Array.isArray(p.log) ? html`<${Fold} k="+log" title=${"Game log" + end}><${GameLog} w=${w} p=${p} /></${Fold}>` : null}
	</section>`;
}
const Grave = ({ n, s = 18 }) => (n ? html`<span class="dth">${mon("gravestone", s)}${n}</span>` : null);
// its CODE's errors in the game log (uncaught errors, the game's code_error lines) and console errors and warnings
const Errs = ({ p }) => { const n = p.log_n; return n && (n.errors || n.console) ? html`<span class="dth" data-tip=${(n.errors || 0) + " CODE errors in its game log, " + (n.console || 0) + " console errors and warnings (Game log, below)"}>${icon("condition_bad")}${n.errors || 0}</span>` : null; };
// the game log, newest last; times are game time from the start of the measured part (the chart's 0h00), given the
// world's virtual clock at the snapshot; else the virtual time of day
function GameLog({ w, p }) {
	const t0 = w.world && typeof w.world.clock === "number" ? w.world.clock - (w.measured_ms || 0) : null;
	return html`<${Log}>${p.log.map((e) => {
		const [v, kind, text] = Array.isArray(e) ? e : [null, "", e], ok = Number.isFinite(v) && Math.abs(v) < 8.64e15; // else no time (Date would throw)
		return html`<div class=${/^(chat|pageerror|console)$/.test(kind) ? kind : null}><time>${!ok ? "" : t0 == null ? new Date(v).toISOString().slice(11, 19) : (v < t0 ? "-" : "") + hms(Math.abs(v - t0))}</time>${text}</div>`;
	})}</${Log}>`;
}
// a replay's game log: the lines its client got up to the replay's moment (api/rec), newest last, at the charts' time
function RecLog({ w, lines }) {
	const base = baseOf(w);
	return html`<${Log}>${lines.length ? lines.map(([v, kind, text]) => html`<div class=${kind === "chat" ? "chat" : null}><time>${base == null ? "" : (v < base ? "-" : "") + hms(Math.abs(v - base))}</time>${text}</div>`) : html`<div class="gu">nothing yet</div>`}</${Log}>`;
}

// ---- supply: the merchant's trips and deliveries per hour, its gold, what it brought each character (each item at its
// level, from the items' events), the supply balance (potions each character received vs drank), each handover
function SupplyBox({ w }) {
	const S1 = statsOf(w), c = S1.M, p = c.p, pf = (w.merchant && w.merchant.per_fighter) || {}, dv = S1.dv || {}, others = S1.P.filter((x) => x !== c), deliv = S1.dv ? Object.values(dv).reduce((a, n) => a + num(n), 0) : null, sum = (o) => Object.values(o || {}).reduce((a, b) => a + num(b), 0);
	const L = useItems(w), evs = L && !evNote(w, L) ? L.ev : null, hand = evs ? evs.filter((e) => (e.k === "give" || e.k === "gold") && (e.who === c.name || e.to === c.name)) : [];
	// what the merchant gave a character: per item and level
	const gave = (to) => { const m = new Map(); for (const e of hand) if (e.k === "give" && e.who === c.name && e.to === to) { const k = e.item + "|" + (e.level || 0); m.set(k, { item: e.item, level: e.level || 0, q: ((m.get(k) || {}).q || 0) + num(e.q) }); } return [...m.values()].sort((a, b) => a.item.localeCompare(b.item) || a.level - b.level); };
	const tile = (ic, label, v, unit, tip) => html`<${Kt} ic=${ic} label=${label} tip=${tip}><${Ktv} v=${v} unit=${unit} /></${Kt}>`;
	const rows = others.map((f) => {
		const x = pf[f.name] || {}, it = f.p.items || {}, pots = [...new Set([...Object.keys(it.received || {}), ...Object.keys(it.consumed || {})])].filter((k) => /pot/.test(k)).sort();
		const sent = evs ? gave(f.name).map((g) => html`<span class="iq" data-item=${g.item} data-level=${g.level}>${iconFit(g.item, 18)}${g.level ? html`<b class="lvt">+${g.level}</b>` : null}${g.level && g.q < 2 ? "" : (g.level ? "×" : "") + fmtN(g.q, 0)}</span>`)
			: Object.entries(x.sent || {}).map(([i, q]) => html`<span class="iq">${iconFit(i, 18, i)}${fmtN(num(q), 0)}</span>`);
		const bal = pots.map((k) => { const got = sum((it.received || {})[k]), used = (it.consumed || {})[k] || 0, r = used > 0 ? got / used : null; return html`<span class=${"iq" + (r != null && r < 0.9 ? " lo" : "")} data-tip=${k + ": received " + got + ", drank " + used}>${iconFit(k, 18)}${r == null ? "unused" : pct(r)} <span class="gu">${fmtN(got, 0)}/${fmtN(used, 0)}</span></span>`; });
		return html`<tr><td><span style=${cvar(f.type)}>${weaponOf(f.p, 18)}${f.name}</span></td><td class="wrap">${sent.length ? sent : html`<span class="z">-</span>`}</td><td>${fmtN(sum(x.received), 0)}</td><td>${fmtN(num(x.gold_received))}</td><td data-tip=${(x.meetings != null ? x.meetings + " approaches, " : "") + num(dv[f.name]) + " handed it something"}>${x.trips ?? "-"}</td><td>${bal.length ? bal : html`<span class="z">-</span>`}</td></tr>`;
	});
	const ups = p.items ? [...Object.entries(p.items.upgraded || {}), ...Object.entries(p.items.compounded || {})].filter(([, o]) => o && num(o.ok) + num(o.fail) > 0) : [];
	return html`<section class="merch"><div class="whohd" style=${cvar(p.type)}><span class="slot">${weaponOf(p, 24)}</span><b>${p.name}</b>L${p.level}<${Grave} n=${p.deaths} /></div>
		<div class="kpis">${tile(icon("travel"), "Trips", fmtN(w.trips_available === false ? null : S1.per(c.trips)), "/h", c.trips + " trips that met a character, of " + p.outings + " outings; out of town " + pct(p.out_share))}
			${deliv != null ? tile(icon("inventory"), "Deliveries", fmtN(S1.per(deliv)), "/h", deliv + " trips that handed a character something or gold") : null}
			${c.income != null ? [tile(icon("gold"), "Income", fmtN(S1.per(c.income)), "/h", "loot, NPC and stand sales: " + fmtN(c.income) + " gold"), tile(icon("gold"), "Spent", fmtN(S1.per(c.spent)), "/h", "NPC buys and crafting: " + fmtN(c.spent) + " gold")] : null}</div>
		${others.length ? html`<div class="iscroll"><table class="itab sup"><tbody><tr><th></th><th class="l">delivered</th><th>loot taken</th><th>gold taken</th><th>trips met</th><th>potions received / drunk</th></tr>${rows}</tbody></table></div>` : null}
		${ups.length ? html`<div class="gh"><b>Upgrades</b>${ups.map(([k, o]) => html`<span class="iq" data-tip=${k + ": " + o.ok + " succeeded, " + o.fail + " failed"}>${iconFit(k, 18) || k}${o.ok}<span class="gu">/${o.fail}</span></span>`)}</div>` : null}
		${hand.length ? html`<${Fold} k="+hand" title=${"Each handover (" + fmtN(hand.length, 0) + ")"}><div class="iscroll"><table class="itab"><tbody><tr><th>when</th><th class="l">from</th><th class="l">to</th><th class="l">what</th><th>quantity</th></tr>
			<${Rows} rows=${hand.slice().reverse()} cols=${5} row=${(e) => html`<tr>${when(e)}<td class="l"><${Who} w=${w} name=${e.who} /></td><td class="l"><${Who} w=${w} name=${e.to} /></td><td class="l">${e.k === "gold" ? html`<span class="itm">${icon("gold")}gold</span>` : html`<${Itm} name=${e.item} level=${e.level} />`}</td><td>${fmtN(num(e.k === "gold" ? e.amount : e.q), 0)}</td></tr>`} /></tbody></table></div></${Fold}>` : null}</section>`;
}

// ---- Run: the party, the facts (tag, runner, seed, world, events, CODE, versions, times, speed), notes, its launch,
// its setup file, the threads' load
function RunInfo({ w }) {
	const done = !live_(w), v = w.versions || {}, e = w.end, r = w.run || {}, pr = w.proc, rr = w.launch && w.launch.rerun_of, src = rr && S.data.find((x) => x.id === rr);
	const hs = (w.roster || []).filter((c) => c.code_hash);
	const fact = (k, val, tip, wide) => (val == null || val === "" ? null : html`<div class=${"fact" + (wide ? " wide" : "")} data-tip=${tip || null}><span class="fk">${k}</span><span class="fv">${val}</span></div>`);
	const ended = e ? (e.reason === "complete" ? "finished" : e.reason === "stopped" ? "stopped early" + (r.duration_ms ? " at " + fmtG(w.measured_ms || 0) + " of " + fmtG(r.duration_ms) : "") : "failed") + (e.detail ? " (" + e.detail + ")" : "") : live_(w) ? "running" : "";
	const wd = w.world || {}, x = wd;
	const at = (t) => (t == null ? "before the run" : hms(t * 1000));
	const events = [...(x.forced || []).map((f) => f.event + " forced at " + fmtG(f.at_ms)), ...Object.entries(x.events || {}).map(([k, y]) => k + " on " + at(y.from) + "-" + at(y.to))].join("; ");
	const facts = html`<div class="facts">${fact("Tag", w.setup && w.setup.name && String(w.setup.name).startsWith(w.tag || w.id) ? w.setup.name : w.tag || w.id, "the run's full name", true)}
		${fact("Runner", r.script || "")}${fact("Seed", seedOf(w) != null ? String(seedOf(w)) : "")}${fact("Planned", r.duration_ms ? fmtG(r.duration_ms) : "")}${fact("Warm-up", r.warmup_ms > 0 ? fmtSpan(r.warmup_ms) : "", "game time with the characters online before measuring")}
		${fact("World", Number.isFinite(x.age_ms) ? (x.age_ms > 0 ? "aged " + fmtSpan(x.age_ms) + " with no characters before they logged in" : "age 0 (the characters logged in at once)") : "", "how its world started: aged with no characters first, or not")}
		${fact("Starts", wd.start ? wd.start.slice(0, 16).replace("T", " ") + " UTC (the server's " + String((new Date(wd.start).getUTCHours() + 19) % 24).padStart(2, "0") + wd.start.slice(13, 16) + ")" : "", "the world's clock as it booted: the server's hour (UTC - 5), its night, dailies and nightlies follow it")}
		${fact("Seasons", wd.seasons && wd.seasons.length ? wd.seasons.join(", ") : "", "server switches on: not as on live now")}
		${fact("Custom world", wd.spawns && wd.spawns.length ? spawnsText(wd.spawns) : "", "monsters the setup put in the world (world.spawns): not as on live", true)}
		${fact("Events", events, "the dailies and nightlies on during the run (from when to when, game time of the run); forced: started by the setup, not the server's schedule")}
		${fact("CODE", hs.length ? hs.map((c, i) => [i ? ", " : "", c.name + " ", html`<span class="hash">${c.code_hash}</span>`]) : html`<span class="hash">${v.code_hash || "?"}</span>`, "each character's CODE hash; the run's: " + (v.code_hash || "?"))}${fact("Versions", "CODE git " + (v.code || "?") + ", sim " + String(v.sim || "?"))}
		${fact("Game time", hms(w.measured_ms))}${fact("Real time", hms(w.real_ms))}${fact("Speed", [!done && w.speed.now != null && "now " + w.speed.now + "x", w.speed.avg != null && "avg " + w.speed.avg + "x", w.speed.median != null && "median " + w.speed.median + "x", w.speed.min != null && w.speed.min + "-" + w.speed.max + "x"].filter(Boolean).join(", ") || "-")}
		${fact("Ended", ended)}${fact("Rerun of", rr ? (src ? html`<a class="lnk" href=${runHash(src.id)}>${src.tag}</a>` : rr) : "")}${fact("Process", pr && pr.pid ? "pid " + pr.pid + (pr.host ? " on " + pr.host : "") : "")}</div>`;
	const loadRows = (o, label) => Object.entries(o || {}).map(([k, y]) => [html`<span>${k === "server" ? "server" : k}${label}</span>`, html`<div class="bar"><i style=${"width:" + Math.round(y * 100) + "%"}></i></div>`, html`<span>${pct(y)}</span>`]);
	const sec = (hd, b) => (b && (!Array.isArray(b) || b.some(Boolean)) ? html`<section><h4>${hd}</h4>${b}</section>` : null);
	const own = launchesOf().filter((l) => l.run === w.id);
	// what the run was composed from (its notes; a character's CODE conditions start with its name), a line each
	const segs = String(w.strategy || "").split(/ \| |\. (?=Template notes: )/).filter((y) => y.trim()), conds = segs.some((y) => w.players.some((p) => y.startsWith(p.name + ": ")));
	const notes1 = segs.length ? html`<${Fold} k="+notes" title=${conds ? "Notes and CODE conditions" : "Notes"}><div class="log notes">${segs.map((y) => html`<div>${y}</div>`)}</div></${Fold}>` : null;
	return html`<div class="body run">${sec("Run", [html`<${PartyLine} w=${w} />`, facts, notes1])}${sec("Launch", own.map((l) => html`<${LaunchStatus} l=${l} sel=${w.id} />`))}<${SetupInfo} w=${w} />
		${w.load ? html`<section><h4 data-tip="share of real time each thread was busy; the busiest one limits the speed">Thread load</h4><div class="load">${done ? loadRows(w.load.avg, "") : [loadRows(w.load.now, " now"), loadRows(w.load.avg, " avg")]}</div></section>` : null}</div>`;
}
// the characters in one line: weapon, name, level (and the levels gained), deaths; on hover, the class, the role and
// the party
function PartyLine({ w }) {
	const pt = w.party && Array.isArray(w.party.members) && w.party.members.length ? w.party : null, leads = new Set(Object.keys((pt && pt.groups) || {}));
	return html`<div class="pline">${membersOf(w).map((p) => {
		const r = (w.roster || []).find((x) => x.name === p.name) || {}, g = Number.isFinite(p.start_level) ? p.level - p.start_level : 0;
		const tip = p.name + ", " + p.type + " L" + p.level + (g > 0 ? " (from L" + p.start_level + ")" : "") + (r.role ? ", " + r.role : "") + (pt ? (!pt.members.includes(p.name) ? "; not in the party" : leads.has(p.name) ? "; leads the party" : "; in the party") : "");
		return html`<span class="pm" style=${cvar(p.type)} data-tip=${tip}>${weaponOf(p, 20)}<b>${p.name}</b>L${p.level}${g > 0 ? html`<span class="gain">+${g}</span>` : null}<${Grave} n=${p.deaths} /></span>`;
	})}</div>`;
}
// ---- Monsters: a row per monster type (metrics.js monstersOf): the run's kills (last hits) and per game hour, the
// server's other kills, how many there were and their levels at the base and at the end, the deaths it caused; the
// hunted ones first, past 6 rows (or the hunted ones) the rest folded when more than 2. Then who killed the others, and
// the deaths: where, by what, when.
function Monsters({ w }) {
	const S1 = statsOf(w), list = monstersOf(w), ko = w.kills && w.kills.others, dg = (w.deaths && w.deaths.groups) || [], top = (o) => Object.entries(o || {}).sort((a, b) => b[1] - a[1]);
	if (!list.length) return html`<p class="mnote">- no monsters recorded in this run</p>`;
	const lv = (v, up) => (v ? [html`<td>${fmtN(v.n, 0)}</td>`, html`<td class=${up ? "up" : null} data-tip=${up ? "higher than at the base" : null}>${v.avg.toFixed(1)}</td>`, html`<td>${v.max}</td>`] : [html`<td class="z">-</td>`, html`<td class="z">-</td>`, html`<td class="z">-</td>`]);
	const tr = (r) => html`<tr class=${r.kills ? "hunt" : null}><td><span data-tip=${r.t + (r.maps.size ? " on " + [...r.maps].join(", ") : "")}>${mon(r.t, 20)}${r.t}${r.maps.size ? html` <small>${[...r.maps].join(", ")}</small>` : null}</span></td>
		<td>${r.kills ? fmtN(r.kills, 0) : ""}</td><td>${r.kills ? fmtN(S1.per(r.kills)) : ""}</td><td>${r.others ? fmtN(r.others, 0) : ""}</td>${lv(r.base)}${lv(r.end, r.base && r.end && r.end.avg > r.base.avg + 0.05)}<td class=${r.deaths ? "ko" : null}>${r.deaths || ""}</td></tr>`;
	const table = (rs) => html`<div class="iscroll"><table class="itab mlv"><tbody><tr><th rowspan="2">monster</th><th rowspan="2" data-tip="the run's last hits">kills</th><th rowspan="2">per h</th><th rowspan="2" data-tip="the server's fighting NPCs' (not the run's)">by others</th><th colspan="3" data-tip="after the world age">at the base</th><th colspan="3">${live_(w) ? "at the end (when it ends)" : "at the end"}</th><th rowspan="2" data-tip="the run's characters it killed">deaths caused</th></tr>
		<tr><th>n</th><th>avg level</th><th>max</th><th>n</th><th>avg level</th><th>max</th></tr>${rs.map(tr)}</tbody></table></div>`;
	const k = Math.max(6, list.filter((r) => r.kills || r.deaths).length), n = list.length - k > 2 ? k : list.length, rest = list.slice(n);
	const others = ko && ko.total ? html`<p class="gu" data-tip=${top(ko.by_type).map(([t, x]) => t + " " + x).join(", ")}>${"Killed by others on the server: " + ko.total + " (" + top(ko.by).map(([t, x]) => t + " " + x).join(", ") + ")"}</p>` : null;
	const deaths = dg.length ? html`<section><h4>Deaths</h4><div class="iscroll"><table class="itab"><tbody><tr><th>deaths</th><th class="l">character</th><th class="l">where</th><th class="l">killer</th><th>when</th></tr>${dg.slice(0, 12).map((g) => html`<tr><td>${g.n}</td><td class="l">${g.name + " L" + g.level}</td><td class="l">${g.map + " " + g.x + "," + g.y}</td><td class="l"><span class="itm">${mon(g.by, 20)}${g.by}</span></td><td>${fmtG(g.first * 1000) + (g.n > 1 ? "-" + fmtG(g.last * 1000) : "")}</td></tr>`)}</tbody></table></div>${dg.length > 12 ? html`<p class="gu">${dg.length - 12} more places</p>` : null}</section>` : null;
	return html`<div class="body run"><section><h4>Monsters</h4>${table(list.slice(0, n))}${rest.length ? html`<${Fold} k="+mlv" title=${rest.length + " more"}>${table(rest)}</${Fold}>` : null}${others}</section>${deaths}</div>`;
}
// a run of a setup: its setup file (api/setup/<id>): each character's class, account, start state, CODE (entry, hash,
// appended files), params, extras and role; the party; the accounts' age and bank, storage; the steering and what the
// run did of it; a link to save it (a starting point for a new setup)
const baseName = (p) => String(p || "").split(/[\\/]/).pop();
// why a step fires (steer.js whyOf); a steering entry or an account's storage as a line (setup.js steerText)
const stWhy = (e) => (e.when != null ? "when " + e.when + (e.for ? " for " + e.for : "") + (e.repeat ? " (each time)" : "") : e.after != null ? (e.at ?? "0s") + " after " + e.after : "at " + e.at);
const stText = (e) => [...Object.entries(e.storage || {}).map(([k, v]) => k + "=" + JSON.stringify(v)), ...Object.entries(e.local_storage || {}).map(([k, v]) => "localStorage " + k + "=" + JSON.stringify(v)), ...(e.code != null ? ["run " + short(String(e.code).replace(/\s+/g, " ").trim(), 60)] : [])].join(", ");
function SetupInfo({ w }) {
	if (!w.setup) return null;
	const s = setupOf(w);
	if (!s) return html`<section><h4>Setup</h4><p>${s === undefined ? "loading..." : "no setup file " + (w.setup.file || w.id + ".setup.json")}</p></section>`;
	const src = (s.source && s.source.characters) || {}, roster = w.roster || [];
	const rows = s.characters.map((c) => {
		const so = src[c.name] || {}, st = c.state || null, code = c.code || {}, ex = so.extra || [], app = (so.append || []).map(baseName), slot = so.entry && so.entry !== code.entry ? so.entry : null;
		const start = (st && st.level != null ? "L" + st.level + ", " : "") + (so.state_from ? "export " + baseName(so.state_from) : c.state ? "inline" : "-");
		const params = Object.entries(c.params || {}).map(([k, v]) => (k === "farm" && v && typeof v === "object" ? "farm " + ((v.monsters || []).join("/") || "any") + (v.map ? " @ " + v.map + " " + v.x + "," + v.y : "") : k + " " + short(JSON.stringify(v), 40))).join("; ");
		const tip = ((app.length ? "appended: " + app.join(", ") : "") + (so.prelude ? (app.length ? "; " : "") + "a prelude" : "") + (ex.length ? (app.length || so.prelude ? "; " : "") + ex.length + " extras: " + short(ex.join(" ").replace(/\s+/g, " ").trim()) : "") || "the CODE's entry and hash") + (slot ? "; its slot " + slot + ", named " + code.entry + " in the run" : "");
		return html`<tr><td><span style=${cvar(c.class)}><b>${c.name}</b></span></td><td>${c.class}</td><td>${c.account}</td><td>${start}</td><td><span data-tip=${tip}>${slot || code.entry || "?"} <span class="hash">${code.hash || "?"}</span></span></td><td>${c.role || (roster.find((r) => r.name === c.name) || {}).role || "-"}</td><td class="wrap">${params || "-"}</td></tr>`;
	});
	const p = s.party, party = p ? p.members.map((n) => n + (n === p.leader ? " (leader)" : "")).join(", ") + (p.form === "harness" ? ", formed by the harness" : p.form === "code" ? ", formed by the CODE" : ", no invites") : "none";
	const accts = Object.entries(s.accounts || {}).map(([k, a]) => {
		const b = a.bank, packs = b ? Object.keys(b).filter((x) => /^items\d+$/.test(x)) : [], items = packs.reduce((n, x) => n + (b[x] || []).filter(Boolean).length, 0);
		return html`<div class="fact"><span class="fk">Account ${k}</span><span class="fv">${(a.age_days ? a.age_days + " days old" : "new (0 days)") + ", bank " + (b ? fmtN(b.gold || 0) + " gold, " + packs.length + " packs, " + items + " items" : "a new account's")}</span></div>`;
	});
	const from = s.resolved && s.resolved.from;
	// the CODE's names of characters as the run's (code_names), and the ones it kept
	const cn = Object.entries(s.code_names || {}), moved = cn.filter(([a, b]) => a !== b), kept = cn.filter(([a, b]) => a === b).map(([a]) => a);
	const names = cn.length ? html`<div class="fact wide" data-tip="the names of characters in the CODE, as the run's characters (strings and property names; comments and longer strings as they were)"><span class="fk">Names in CODE</span><span class="fv">${[moved.map(([a, b]) => a + " as " + b).join(", "), kept.length ? "unchanged: " + kept.join(", ") : ""].filter(Boolean).join("; ")}</span></div>` : null;
	// each account's storage at the start; the steering, with what the run did (the snapshot's steer)
	const store = Object.entries(s.accounts || {}).filter(([, a]) => a.storage || a.local_storage).map(([k, a]) => html`<div class="fact wide" data-tip="what its CODE's get(key) and localStorage read at the start (its browser's storage)"><span class="fk">Storage ${k}</span><span class="fv">${stText(a)}</span></div>`);
	const did = Array.isArray(w.steer) ? w.steer : []; // (each firing, with its step's index i)
	const steer = (s.steer || []).length ? html`<div class="fact wide" data-tip="the setup's steering: at a game time (since the run's start, after the warm-up), when a condition holds, or a while after another step, a storage key set or CODE run in a character's CODE; marked on the charts"><span class="fk">Steering</span><span class="fv">${(s.steer || []).map((e, i) => {
		const ds = did.filter((d) => d.i === i), errs = [...new Set(ds.flatMap((d) => d.errors || []))];
		return [i ? html`<br />` : null, (e.name ? e.name + ": " : "") + stWhy(e) + ", " + (e.character || "everyone") + ": " + stText(e) + (e.note ? " (" + e.note + ")" : "") + (ds.length ? "; fired at " + hms(ds[0].t * 1000) + (ds.length > 1 ? " and " + (ds.length - 1) + " more times" : "") + (errs.length ? "; not run: " + errs.join(", ") : "") : live_(w) ? "" : "; never fired")];
	})}</span></div>` : null;
	return html`<section><h4>Setup</h4><div class="iscroll"><table class="itab stp"><tbody><tr><th>character</th><th>class</th><th>account</th><th>start</th><th>CODE</th><th>role</th><th>params</th></tr>${rows}</tbody></table></div>
		<div class="facts"><div class="fact"><span class="fk">Party</span><span class="fv">${party}</span></div>${names}${accts}${store}${steer}</div><p><a class="dl" href=${"api/setup/" + encodeURIComponent(w.id) + "?download=1"} download=${w.id + ".setup.json"}>Download setup.json</a>${from ? html`<span class="gu"> made from ${baseName(from)}</span>` : null}</p></section>`;
}
export { Grave, ItemsBox };
