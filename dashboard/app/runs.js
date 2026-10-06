// The runs list (the sidebar) and the Runs table (the Runs page): running and finished runs and the launches on their
// way, a row each, a group's runs folded under its row (mean +/- sd); sortable by any column, filtered by status and
// name. A click on a row opens its page; the checkboxes pick runs and groups to compare (8 at most: one colour each).
import { h } from "./vendor/preact.js";
import { useEffect, useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtG, ORD, live_, seedOf, membersOf, catOf, CATDOT, CAT_ORDER, stateText, progOf, startedText, agg, load, save, api } from "./lib.js";
import { S, redraw, nav, runHash, cmpHash, launchesOf, activeL, dismissed, getCst, pollSoon, logs, ctlLoad } from "./store.js";
import { GRPI } from "./art.js";
import { Swatch, RunLabel, whatTip, PartyPips, MetricsButton } from "./ui.js";
import { REG, MET, CARDS, heroM, mval, fmtM, ranksOf, groupsOf, seriesOf, cmpRuns, scol, slotsKeep } from "./metrics.js";

const html = htm.bind(h);
// ---- the picks: run and group ids (Compare's series; on Compare's page, its URL's)
export const MAXPICK = 8;
export const picks = new Set();
export const setPicks = (ids) => { const x = ids.slice(0, MAXPICK); if (x.join() === [...picks].join()) return; picks.clear(); for (const id of x) picks.add(id); redraw(); };
const full = () => picks.size >= MAXPICK;
// a pick changed: on Compare's page, its series follow
function picked(route) {
	if (route.page === "compare") nav(picks.size ? cmpHash([...route.ids.filter((id) => picks.has(id)), ...[...picks].filter((id) => !route.ids.includes(id))], route.tab) : "#/runs", true);
	else redraw();
}
function pick(id, on) {
	if (on && !picks.has(id) && full()) return;
	on ? picks.add(id) : picks.delete(id);
}
// the colours kept: the picked ones' and the open page's; picks gone from the list dropped
export function keepPicks(route) {
	const GR = groupsOf(S.data);
	if (S.loaded) for (const id of [...picks]) if (!S.data.some((x) => x.id === id) && !GR.groups.has(id)) picks.delete(id);
	slotsKeep(new Set([...picks, route.page === "run" ? route.id : null].filter(Boolean)));
}

// ---- filters and sorts (remembered in this browser), the groups shown open
const tsort = load("dash_tsort", { col: null, dir: -1 }, (x) => { const s = JSON.parse(x); return s && (s.col === null || typeof s.col === "string") ? { col: s.col, dir: s.dir === 1 ? 1 : -1 } : { col: null, dir: -1 }; });
const csort = load("dash_csort", { col: null, dir: -1 }, (x) => { const s = JSON.parse(x); return s && (s.col === null || typeof s.col === "string") ? { col: s.col, dir: s.dir === 1 ? 1 : -1 } : { col: null, dir: -1 }; });
// folder: the live dir's folder its runs are in (null: every folder; "": the live dir itself)
const tf0 = load("dash_tfilt", {}, (x) => JSON.parse(x) || {});
const tfilt = { status: [].concat(tf0.status || []), folder: typeof tf0.folder === "string" ? tf0.folder : null, q: "" };
const tsave = () => save("dash_tfilt", JSON.stringify({ status: tfilt.status, folder: tfilt.folder }));
const openG = new Set();
const folderOf = (w) => (w.id.includes("/") ? w.id.slice(0, w.id.indexOf("/")) : "");
const named = (w) => { const q = tfilt.q.trim().toLowerCase(); return (tfilt.folder == null || folderOf(w) === tfilt.folder) && (!q || String(w.tag || w.id).toLowerCase().includes(q)); };
const passes = (w) => (!tfilt.status.length || tfilt.status.includes(catOf(w))) && named(w);
// a group's status: running while any of its runs is, else its runs' when they agree, else done
const grpCat = (g) => { const cs = g.runs.map(catOf); return cs.includes("running") ? "running" : cs.every((c) => c === cs[0]) ? cs[0] : "done"; };
const gmean = (f) => (g) => agg(g.stat.map(f)).mean, seedsOf = (g) => g.runs.map((w) => seedOf(w)).filter((v) => v != null);
const STARTED_COL = { id: "started", label: "Started", num: 1, key: (w) => Date.parse(w.started) || 0, gkey: (g) => Math.max(...g.runs.map((w) => Date.parse(w.started) || 0)) };
const SEED_COL = { id: "seed", label: "Seed", num: 1, key: (w) => seedOf(w), gkey: (g) => (seedsOf(g).length ? Math.min(...seedsOf(g)) : null) };
// the runs list: what each run is: its status, its party (a pip per character), its short label (the setup and CODE in
// its tooltip), its game time
function sideCols() {
	const party = (w) => membersOf(w).map((p) => p.type).join(",");
	return [
		{ id: "state", label: "Status", ic: html`<i class="dot"></i>`, tip: "status", key: (w) => CAT_ORDER[catOf(w)], gkey: (g) => CAT_ORDER[grpCat(g)] },
		{ id: "party", label: "Party", ic: html`<span class="pty"><i class="pp"></i><i class="pp"></i></span>`, tip: "party", key: party, gkey: (g) => party(g.runs[0]) },
		{ id: "name", label: "Run", key: (w) => String(w.tag || w.id).toLowerCase(), gkey: (g) => g.name.toLowerCase() },
		{ id: "time", label: "Time", num: 1, key: (w) => w.measured_ms || 0, gkey: gmean((w) => w.measured_ms || 0), tip: "game time" },
	];
}
// the Runs table: the checkbox, status, party, name (a group's: with its count of runs), rank, the headline's metric,
// the chips' (Columns), deaths, game time, seed, start; key(w) a run's sort value, gkey(g) a group's
function tableCols() {
	const hm = heroM(), ms = [hm, ...REG.filter((m) => CARDS.chips.includes(m.id) && m !== hm)], rank = ranksOf(S.data).rank;
	if (!ms.some((m) => m.id === "deaths")) ms.push(MET.deaths);
	const [state, party] = sideCols();
	return [
		state, party,
		{ id: "name", label: "Run", cnt: 1, key: (w) => String(w.tag || w.id).toLowerCase(), gkey: (g) => g.name.toLowerCase() },
		{ id: "rank", label: "#", num: 1, key: (w) => rank.get(w.id) ?? null, gkey: (g) => { const r = g.runs.map((w) => rank.get(w.id)).filter((v) => v != null); return r.length ? Math.min(...r) : null; }, tip: "the rank by " + hm.label },
		...ms.map((m) => ({ id: "m:" + m.id, m, num: 1, label: m.label, key: (w) => mval(m, w).party, gkey: gmean((w) => mval(m, w).party) })),
		...(ms.includes(MET.hours) ? [] : [{ id: "time", label: "Game time", num: 1, key: (w) => w.measured_ms || 0, gkey: gmean((w) => w.measured_ms || 0) }]),
		SEED_COL, STARTED_COL,
	];
}
// nulls last in either direction
const tcmp = (a, b, dir) => (a == null) - (b == null) || (a == null ? 0 : (typeof a === "string" ? a.localeCompare(b) : a - b) * dir);
// the entries in order: single runs and groups (with the runs that pass the filters)
function entries(cols, sort) {
	const items = [], seen = new Set(), GR = groupsOf(S.data);
	for (const w of S.data) {
		if (seen.has(w.id)) continue;
		const g = GR.byRun.get(w.id);
		if (g) { for (const x of g.runs) seen.add(x.id); const runs = g.runs.filter(passes); if (runs.length) items.push({ id: g.id, g, runs }); }
		else if (passes(w)) items.push({ id: w.id, w });
	}
	const col = cols.find((c) => c.id === sort.col);
	if (!col) return items;
	for (const it of items) if (it.g) it.runs = [...it.runs].sort((a, b) => tcmp(col.key(a), col.key(b), sort.dir));
	return items.sort((a, b) => tcmp(a.g ? col.gkey(a.g) : col.key(a.w), b.g ? col.gkey(b.g) : col.key(b.w), sort.dir));
}

// ---- the rows: a click on one (not on its checkbox, buttons or log) opens its page
const pickTip = (pk) => (!pk && full() ? MAXPICK + " picked, the most: unpick one first" : null);
const Ck = ({ id, label, route }) => { const pk = picks.has(id); return html`<td class="ck" data-tip=${pickTip(pk)}><input type="checkbox" data-ck=${id} checked=${pk} disabled=${!pk && full()} aria-label=${label} onChange=${(e) => (pick(id, e.currentTarget.checked), picked(route))} /></td>`; };
const rowClick = (id, sel) => (e) => { if (e.target.closest("input, select, label, details, a, button")) return; if (id !== sel) nav(runHash(id)); };
function RunRow({ w, cols, member, sel, route, two }) {
	const pk = picks.has(w.id), pr = progOf(w), rank = ranksOf(S.data).rank.get(w.id), hm = heroM();
	const cell = (col) => {
		if (col.id === "state") return html`<td class="stc"><i class=${"dot " + CATDOT[catOf(w)]} data-tip=${stateText(w)}></i></td>`;
		if (col.id === "party") return html`<td class="ptc"><${PartyPips} w=${w} /></td>`;
		if (col.id === "name") return html`<td class="nmc"><span class="nml" data-tip=${whatTip(w)}><${RunLabel} w=${w} two=${two} /></span>${pr != null ? html`<span class="prog" data-tip=${fmtG(w.measured_ms || 0) + " of " + fmtG(w.run.duration_ms)}><i style=${"width:" + (100 * pr).toFixed(1) + "%"}></i></span>` : null}</td>`;
		if (col.id === "seed") return html`<td class="num">${col.key(w) ?? ""}</td>`;
		if (col.id === "rank") return html`<td class="num">${rank ? html`<span class=${"rank" + (rank <= 3 ? " r" + rank : "")}>#${rank}</span>` : null}</td>`;
		if (col.m) { const v = mval(col.m, w).party; return html`<td class=${"num" + (col.m === hm ? " hc" : "") + (v == null ? " na" : "")}>${fmtM(col.m, v)}</td>`; }
		if (col.id === "time") return html`<td class="num">${fmtG(w.measured_ms || 0)}</td>`;
		if (col.id === "started") return html`<td class="num">${startedText(w)}</td>`;
		return html`<td></td>`;
	};
	return html`<tr data-row=${w.id} class=${"run" + (member ? " gmem" : "") + (sel === w.id ? " sel" : "") + (pk ? " pk" : "")} style=${pk ? "--sc:" + scol(w.id) : null} onClick=${rowClick(w.id, sel)}><${Ck} id=${w.id} label=${"Pick " + (w.tag || w.id)} route=${route} />${cols.map(cell)}</tr>`;
}
// a group's seeds: a range when they run on, else listed
function seedRange(g) {
	const v = [...new Set(g.runs.map((w) => seedOf(w)).filter((x) => x != null))].sort((a, b) => a - b);
	return !v.length ? "" : v.length > 1 && v[v.length - 1] - v[0] === v.length - 1 ? v[0] + "-" + v[v.length - 1] : v.length > 4 ? v.slice(0, 3).join(", ") + "..." : v.join(", ");
}
const toggleG = (id) => { openG.has(id) ? openG.delete(id) : openG.add(id); redraw(); };
function GroupRows({ it, cols, sel, route, two }) {
	const g = it.g, open = openG.has(g.id), pk = picks.has(g.id), n = (c) => g.runs.filter((w) => catOf(w) === c).length, hm = heroM();
	const cnt = (g.stat.length === g.runs.length ? g.stat.length : g.stat.length + " of " + g.runs.length) + " runs";
	const cell = (col) => {
		if (col.id === "state") return html`<td class="stc"><i class=${"dot " + CATDOT[grpCat(g)]} data-tip=${["running", "done", "stopped", "failed"].filter(n).map((c) => n(c) + " " + c).join(", ")}></i></td>`;
		if (col.id === "party") return html`<td class="ptc"><${PartyPips} w=${g.runs[0]} /></td>`;
		if (col.id === "name") return html`<td class="nmc"><span class="nml" data-tip=${whatTip(g.runs[0])}><button type="button" class="gt" data-gtog=${g.id} aria-expanded=${open} data-tip=${(open ? "Fold its " : "Show its ") + g.runs.length + " runs"} onClick=${() => toggleG(g.id)}>${GRPI()}</button><${RunLabel} w=${g.runs[0]} count=${col.cnt ? cnt : null} two=${two} /></span></td>`;
		if (col.id === "seed") return html`<td class="num">${seedRange(g)}</td>`;
		if (col.m) { const a = agg(g.stat.map((w) => mval(col.m, w).party)); return html`<td class=${"num" + (col.m === hm ? " hc" : "") + (a.n ? "" : " na")}>${a.n ? [fmtM(col.m, a.mean), a.sd != null ? html`<small class="sd">± ${fmtM(col.m, a.sd)}</small>` : null] : "-"}</td>`; }
		if (col.id === "time") return html`<td class="num">${fmtG(col.gkey(g) || 0)}</td>`;
		if (col.id === "started") return html`<td class="num">${startedText({ started: new Date(col.gkey(g)).toISOString() })}</td>`;
		return html`<td></td>`;
	};
	return [html`<tr data-row=${g.id} class=${"grp" + (sel === g.id ? " sel" : "") + (pk ? " pk" : "")} style=${pk ? "--sc:" + scol(g.id) : null} onClick=${rowClick(g.id, sel)}><${Ck} id=${g.id} label=${"Pick the group " + g.name} route=${route} />${cols.map(cell)}</tr>`,
		open ? it.runs.map((w) => html`<${RunRow} key=${w.id} w=${w} cols=${cols} member=${true} sel=${sel} route=${route} two=${two} />`) : null];
}
// a launch on its way (the run's row replaces it once its run writes); failed: its reason until dismissed
const showPh = (l) => !(l.run && S.data.some((w) => w.id === l.run)) && l.state !== "cancelled" && l.state !== "exited" && (l.state !== "failed" || !dismissed.has(l.key));
const cancel = async (ls) => { for (const l of ls) try { await api("api/launch/" + encodeURIComponent(l.key), "DELETE"); } catch (x) {} pollSoon(); };
// a launch as its run will be: its label (a New sim launch has its setup's name; a rerun, its original's), what it
// reruns with which changes
export function launchRun(l) {
	const src = S.data.find((w) => w.id === l.of), a = l.args || {};
	const what = src ? "rerun of " + src.tag + (a.duration ? ", " + (/^\d+(\.\d+)?$/.test(a.duration) ? a.duration + "m" : a.duration) : "") + (a.seed != null ? ", seed " + a.seed : "") + (a.code === "current" ? ", current CODE" : "") + (a.age_days != null ? ", accounts " + a.age_days + " days old" : "") +
		(a.warmup ? ", warm-up " + a.warmup : "") + (a.world_age ? ", world age " + a.world_age : "") + (a.ping ? ", ping " + a.ping + " ms" : "") : "";
	return { what, w: { id: l.key, tag: l.tag || (src ? src.tag : "") || "launch", setup: { name: l.name || (src && src.setup && src.setup.name) || "" }, roster: src ? src.roster : [], players: src ? src.players : [] } };
}
// a launch's row: a click opens its page (its Run tab: its progress and log; its run's once it runs), "log" too, with
// the log open
function PhRow({ l, cols, sel }) {
	const failed = l.state === "failed", qi = l.state === "queued" ? launchesOf().filter((x) => x.state === "queued").indexOf(l) : -1, { w, what } = launchRun(l);
	const text = failed ? "Failed: " + (l.reason || (l.exit != null ? "exit " + l.exit : "?")) : qi >= 0 ? (qi ? "queued, " + (qi + 1) + ORD(qi + 1) : "queued, next") : l.state === "running" ? "first snapshot soon" : "starting";
	const log = () => { if (!logs.has(l.key)) logs.set(l.key, []), ctlLoad().then(redraw); };
	return html`<tr data-row=${l.key} class=${"lph" + (sel === l.key ? " sel" : "")} onClick=${rowClick(l.key, sel)}><td></td><td class="stc"><i class=${"dot " + (failed ? "bad" : "stopped")} data-tip=${failed ? "failed" : l.state}></i></td><td class="nmc" colspan=${cols.length - 1}><span class="nml" data-tip=${what || null}><${RunLabel} w=${w} /><span class=${"lnote" + (failed ? " bad" : "")} data-tip=${text}>${text}</span>
		${failed ? html`<button type="button" class="lnk sm" onClick=${() => (dismissed.add(l.key), redraw())}>dismiss</button>` : activeL(l) ? html`<button type="button" class="lnk sm" onClick=${() => cancel([l])}>cancel</button>` : null}${l.state === "queued" ? null : html`<a class="lnk sm" href=${runHash(l.key, "run")} data-tip="its progress and log: the Run tab (its run's, once it runs)" onClick=${log}>log</a>`}</span></td></tr>`;
}
// the queue: one row (how many wait, cancel them all; its button shows them, each in its turn)
function QRow({ qd, cols, sel }) {
	const open = openG.has("queue");
	return [html`<tr class="lph qsum"><td></td><td class="stc"><i class="dot stopped" data-tip="queued"></i></td><td class="nmc" colspan=${cols.length - 1}><span class="nml"><button type="button" class="gt" aria-expanded=${open} data-tip=${(open ? "Fold" : "Show") + " the queue"} onClick=${() => toggleG("queue")}>${GRPI()}</button>
		<span class="lnote" data-tip=${qd.map((l) => l.tag).join("\n")}>${qd.length + (qd.length === 1 ? " run waits" : " runs wait") + " for sim threads"}</span><button type="button" class="lnk sm" onClick=${() => cancel(launchesOf().filter((x) => x.state === "queued"))}>cancel ${qd.length === 1 ? "it" : "all"}</button></span></td></tr>`,
		open ? qd.map((l) => html`<${PhRow} key=${l.key} l=${l} cols=${cols} sel=${sel} />`) : null];
}
// a table of runs and groups: sort (again: the other way), the header's checkbox (the list's: picks the first ones
// shown, again none), the launches on their way (the list's), its classes
function Table({ cols, items, sort, onSort, ckall, phs, cls, sel, route }) {
	const hm = heroM(), allPk = items.length > 0 && (full() || items.every((it) => picks.has(it.id)));
	const top = () => items.map((it) => it.id);
	const th = (c) => {
		const on = sort.col === c.id;
		return html`<th scope="col" class=${"c-" + c.id.replace(/:.*/, "") + (c.num ? " num" : "") + (c.m === hm ? " hc" : "") + (c.id === "state" ? " stc" : "")} aria-sort=${on ? (sort.dir > 0 ? "ascending" : "descending") : null}>
			<button type="button" aria-label=${c.ic ? c.label : null} data-tip=${c.m ? c.m.what : c.tip || null} onClick=${() => onSort(c)}>${c.m ? html`<span class="ico">${c.m.ic()}</span>` : null}${c.ic || c.label}${on ? html`<i class=${"sa " + (sort.dir > 0 ? "up" : "dn")}></i>` : null}</button></th>`;
	};
	return html`<table class=${"rt" + (cls ? " " + cls : "")}><thead><tr><th class="ck">${ckall ? html`<input type="checkbox" checked=${allPk} aria-label=${allPk ? "Pick none" : "Pick the first " + MAXPICK + " shown"} data-tip=${allPk ? "pick none" : "pick the first " + MAXPICK + " shown (" + MAXPICK + " at most, one colour each)"}
			onChange=${(e) => { const on = e.currentTarget.checked; if (!on) picks.clear(); for (const id of top()) pick(id, on); picked(route); }} />` : null}</th>${cols.map(th)}</tr></thead>
		<tbody>${phs.map((l) => (Array.isArray(l) ? html`<${QRow} key="queue" qd=${l} cols=${cols} sel=${sel} />` : html`<${PhRow} key=${l.key} l=${l} cols=${cols} sel=${sel} />`))}
			${items.map((it) => (it.g ? html`<${GroupRows} key=${it.id} it=${it} cols=${cols} sel=${sel} route=${route} two=${cls === "cmp"} />` : html`<${RunRow} key=${it.id} w=${it.w} cols=${cols} sel=${sel} route=${route} two=${cls === "cmp"} />`))}</tbody></table>`;
}

// ---- the sidebar: its filters (status, with their counts; the folder; the name), the list, the picked runs' bar
export function RunsSide({ route }) {
	const cols = sideCols(), items = entries(cols, tsort), sel = route.page === "run" ? route.id : null, ref = useRef(null);
	const ph0 = launchesOf().filter(showPh), qd = ph0.filter((l) => l.state === "queued"), phs = [...ph0.filter((l) => l.state !== "queued"), ...(qd.length ? [qd] : [])];
	// the open run's row in view
	useEffect(() => { const r = sel && ref.current && ref.current.querySelector('tr[data-row="' + CSS.escape(sel) + '"]'); if (r) r.scrollIntoView({ block: "nearest" }); }, [sel]);
	// the status filters' counts (of the runs the other filters pass); running: the sims' speed and threads, the
	// launches starting
	const speed = S.data.filter(live_).reduce((s, w) => s + (w.speed.now || 0), 0), starting = launchesOf().filter((l) => l.state === "starting").length, queued = qd.length, th = getCst() && getCst().sims;
	const other = S.data.filter(named);
	const rtip = [speed ? speed.toFixed(0) + "x: the running runs' combined speed" : "", th && th.threads_max ? th.threads_busy + " of " + th.threads_max + " sim threads busy" : "", starting ? starting + " starting" : "", queued ? queued + " queued" : ""].filter(Boolean).join("; ");
	const fst = (k) => { const a = tfilt.status, i = a.indexOf(k); i < 0 ? a.push(k) : a.splice(i, 1); tsave(); redraw(); };
	// the folders with runs (shown when there is one besides the live dir itself)
	const folders = [...new Set(S.data.map(folderOf))].sort();
	if (tfilt.folder != null && !folders.includes(tfilt.folder) && S.data.length) ((tfilt.folder = null), tsave());
	const fsel = folders.some(Boolean) ? html`<select aria-label="Folder" data-tip="the live dir's folder the runs are in" value=${tfilt.folder == null ? "*" : tfilt.folder} onChange=${(e) => ((tfilt.folder = e.currentTarget.value === "*" ? null : e.currentTarget.value), tsave(), redraw())}>
			<option value="*">all folders</option>${folders.map((f) => html`<option value=${f}>${f || "live dir"} (${S.data.filter((w) => folderOf(w) === f).length})</option>`)}</select>` : null;
	const nrun = items.reduce((a, it) => a + (it.g ? it.runs.length : 1), 0);
	const onSort = (c) => { Object.assign(tsort, tsort.col === c.id ? { dir: -tsort.dir } : { col: c.id, dir: c.id === "started" || c.id === "time" ? -1 : 1 }); save("dash_tsort", JSON.stringify(tsort)); redraw(); };
	return html`<div id="runs">
		<div class="rfilt"><span class="seg sm" role="group" aria-label="Status">${[["running", "running"], ["done", ""], ["stopped", "stopped"], ["failed", "bad"]].map(([k, dot]) => html`<button type="button" aria-pressed=${tfilt.status.includes(k)} data-tip=${k === "running" && rtip ? rtip : null} onClick=${() => fst(k)}><i class=${"dot " + dot}></i>${k}<span class="fc">${other.filter((w) => catOf(w) === k).length}</span></button>`)}</span>
			${fsel}<input type="search" id="tq" placeholder="Filter by name" aria-label="Filter by name" value=${tfilt.q} onInput=${(e) => ((tfilt.q = e.currentTarget.value), redraw())} /><span id="rn" class="gu">${nrun === S.data.length ? S.data.length + " runs" : nrun + " of " + S.data.length + " runs"}</span></div>
		<div id="rtab" ref=${ref}>${!S.data.length && !phs.length ? html`<div class="empty"><p>No runs yet.</p></div>` : [html`<${Table} cols=${cols} items=${items} sort=${tsort} onSort=${onSort} ckall=${true} phs=${phs} cls="ov" sel=${sel} route=${route} />`, items.length ? null : html`<div class="empty">No run passes the filters.</div>`]}</div>
		<${PickBar} route=${route} />
	</div>`;
}
// the picked runs and groups: how many, Compare them (2 or more runs), pick none
function PickBar({ route }) {
	if (!picks.size) return html`<div id="pickbar" class="pickbar" hidden></div>`;
	const ss = seriesOf([...picks]), n = cmpRuns(ss);
	return html`<div id="pickbar" class="pickbar"><span class="pkn">${ss.map((s) => html`<${Swatch} id=${s.id} />`)}<b>${picks.size} picked</b>${n !== picks.size ? html`<span class="gu">${n} runs</span>` : null}</span>
		${route.page === "compare" ? html`<span class="gu">compared</span>` : n >= 2 ? html`<a class="cb go" href=${cmpHash([...picks])}>Compare</a>` : html`<button type="button" class="cb" disabled data-tip="pick 2 or more runs (a group counts its runs)">Compare</button>`}
		<button type="button" class="lnk sm" onClick=${() => (picks.clear(), picked(route))}>Pick none</button></div>`;
}
// ---- the Runs page: every entry the list shows (its filters), sorted by its own column (remembered); Columns sets its
// metrics. None yet: New sim (the way to start one), a setup file from a shell below it
export function RunsTable({ route = { page: "runs" } }) {
	if (!S.data.length) return html`<div class="empty"><p>No runs yet. <a class="cb go" href="#/new">New sim</a> composes and starts one.</p><p class="gu">From a shell: <span class="hash">chronal run my.json</span> (<span class="hash">chronal example</span> prints an annotated one).</p></div>`;
	const cols = tableCols(), items = entries(cols, csort), n = items.reduce((a, it) => a + (it.g ? it.runs.length : 1), 0);
	const onSort = (c) => { Object.assign(csort, csort.col === c.id ? { dir: -csort.dir } : { col: c.id, dir: c.m ? (c.m.better < 0 ? 1 : -1) : c.id === "time" || c.id === "started" ? -1 : 1 }); save("dash_csort", JSON.stringify(csort)); redraw(); };
	return [html`<div class="gh"><${MetricsButton} label="Columns" /><span class="gu">${n + (n === 1 ? " run" : " runs") + (n < S.data.length ? " of " + S.data.length + " (the list's filters)" : "")}: a click opens one; pick 2 or more in the list to compare them</span></div>`,
		html`<div class="iscroll"><${Table} cols=${cols} items=${items} sort=${csort} onSort=${onSort} ckall=${false} phs=${[]} cls="cmp" sel=${null} route=${route} /></div>`];
}
