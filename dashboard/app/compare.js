// A group's page and Compare: the picked runs and groups (series), from the baseline (the first; a click on another
// makes it the baseline). Compare's summary: the verdict (a row per headline metric: the baseline's value, each other
// series' value and change), per character, the timeline (a mean line and sd band per series), every run as a dot (a
// click opens it), the metric against the one setting the series differ in (a sweep). The run tabs with statistics:
// the headline numbers as mean +/- sd, the Recount meters as paired bars (they still drill in; a bar's runs as dots on a
// click), the items as how many runs reached each, the buffs' uptime, the supply, the monsters, the settings they
// differ in.
import { h } from "./vendor/preact.js";
import { useRef } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { fmtN, fmtG, pct, pctU, num, clamp01, mean, agg, cvar, tot, seedOf, catOf, startedText, CATDOT, stateText } from "./lib.js";
import { nav, runHash, cmpHash } from "./store.js";
import { icon, iconFit, weaponOf, mon, Cond, condName, condIcon, kindOf, CODEI } from "./art.js";
import { Fold, Select, Swatch, Label, RunLabel, chip, Kt, Ktv, Delta, MetricsButton } from "./ui.js";
import { statsOf, monstersOf, activeOf, mval, fmtM, fmtMS, cunit, aggOf, kpiMs, heroM, REG, MET, dataM, drillEntries, entryIcon, sweepOf, settingsOf, setsOf, changes, chgTxt, keyName, valTxt, codeTxt, nameOf, typeOf, cmpRuns } from "./metrics.js";
import { CmpTimeline, DotPlot, SweepChart } from "./charts.js";
import { V, setV } from "./view.js";
import { ItemsSeg, useDrillFocus } from "./panel.js";
import { DataPanels, MetricPick } from "./data.js";

const html = htm.bind(h);
const open = (id) => nav(runHash(id));
const runsTxt = (s) => s.runs.length + (s.runs.length === 1 ? " run" : " runs");
const runOf = (w) => (seedOf(w) != null ? "seed " + seedOf(w) : "started " + startedText(w));

// ---- the series named: the baseline (the first) by its short label, every other one by what it changes from it, as
// chips (s.lh), as text (s.label: the charts' readouts, tooltips); its own name first when it isn't the baseline's; no
// setting changed: its seed (a group: the same setup)
const ARW = () => html`<i class="arw" aria-hidden="true">→</i>`;
const itemRest = (it) => ["+" + it.level, it.stat ? html`<small>${it.stat}</small>` : null, it.p ? html`<small>${it.p}</small>` : null];
const itemMini = (it) => (it ? [iconFit(it.name, 18) || it.name, it.level ? "+" + it.level : "", it.stat ? html`<small>${it.stat}</small>` : null, it.p ? html`<small>${it.p}</small>` : null] : "none");
const cut16 = (v) => (v.length > 16 ? v.slice(0, 16) + "..." : v);
function chgChip(c, wa, wb) {
	const ty = c.who && (typeOf(wb, c.who) || typeOf(wa, c.who)), mk = (body) => chip("c|" + chgTxt(c), chgTxt(c), body, "chg" + (ty ? " it" : ""), ty ? cvar(ty) : null);
	if (c.kind === "who") return mk((c.on ? "+ " : "- ") + c.who);
	if (c.kind === "slot") return mk(c.from && c.to && c.from.name === c.to.name ? [iconFit(c.to.name, 18) || c.to.name, itemRest(c.from), ARW(), itemRest(c.to)] : [itemMini(c.from), ARW(), itemMini(c.to)]);
	if (c.kind === "code") return mk([CODEI(), html`<span class="hx">${codeTxt(c.to)}</span>`]);
	if (c.kind === "inv") return mk("inventory");
	if (c.kind === "at") return mk("start");
	if (c.kind === "bank") return mk("bank");
	return mk([(c.who ? keyName(c.key).slice(c.who.length + 1) : keyName(c.key)) + " ", cut16(valTxt(c.key, c.from)), ARW(), cut16(valTxt(c.key, c.to))]);
}
export function nameSeries(ss) {
	const b = ss[0], wb = b && (b.runs[0] || b.all[0]);
	if (!wb) return ss;
	const nb = nameOf(wb).name, sb = ss.length > 1 ? setsOf(b) : null;
	// several series: the changes the fewest of them make first (what sets one apart)
	const chs = ss.slice(1).map((s) => changes(sb, setsOf(s))), all = chs.map((cs) => new Set((cs || []).map(chgTxt)));
	const ord = (cs) => cs && cs.map((c, i) => ({ c, i, n: all.filter((x) => x.has(chgTxt(c))).length })).sort((x, y) => x.n - y.n || x.i - y.i).map((x) => x.c);
	b.lh = html`<${RunLabel} w=${wb} />`; b.label = nb; b.chg = [];
	ss.slice(1).forEach((s, j) => {
		const w = s.runs[0] || s.all[0], nm = nameOf(w).name, cs = (s.chg = all.length > 1 ? ord(chs[j]) : chs[j]), c = [], t = [];
		if (nm !== nb) c.push(chip("nm", "its name: " + nm, nm)), t.push(nm);
		if (!cs) c.push(chip("ld", "loading...", "loading...")), t.push("loading...");
		else if (cs.length) for (const x of cs) c.push(chgChip(x, wb, w)), t.push(chgTxt(x));
		else { const x = s.group ? "same setup" : "seed " + seedOf(w); c.push(chip("same", "no setting differs from the baseline", x)), t.push(x); }
		s.lh = html`<${Label} chips=${c} />`; s.label = t.join("; ");
	});
	return ss;
}
// a series as a tag: its swatch, "Baseline" on the first of several, its label (the chips that don't fit fold into "+N")
const SerTag = ({ s, base }) => html`<span class="stg"><${Swatch} id=${s.id} />${base ? html`<b class="bln">Baseline</b>` : null}${s.lh || html`<span class="lb"><span class="lbn">${s.label}</span></span>`}</span>`;
// a table column's: the baseline's swatch and "Baseline" (its label is over the tabs), another's tag, at most 14em
const colTag = (ss, i) => (i || ss.length < 2 ? html`<${SerTag} s=${ss[i]} />` : html`<span class="stg"><${Swatch} id=${ss[0].id} /><b class="bln">Baseline</b></span>`);
const HELP = "Each series: the mean ± sd over its runs (a group's: one run per seed). A change is the % from the baseline, in colour only past the noise (Welch's t-test, p < 0.05), which needs 2 or more runs on each side: with 1 run the noise is unknown, more seeds tell. A click on a series makes it the baseline.";
const Help = () => html`<button type="button" class="ib hlp" aria-label="How the numbers compare" data-tip=${HELP}>?</button>`;
// a series made the baseline (Compare's URL in that order)
const baseline = (route, id) => nav(cmpHash([id, ...route.ids.filter((x) => x !== id)], route.tab), true);
// the title of a group's page (its tag and runs) or Compare's (the series' swatches; their names in its tooltip)
export function CmpHead({ ss }) {
	if (!ss.length) return html`<h2 class="ttl">Compare</h2>`;
	if (ss.length === 1) return html`<div class="shd one"><${SerTag} s=${ss[0]} /><span class="gu">${runsTxt(ss[0])}</span><${Help} /></div>`;
	return html`<div class="shd one"><h2 class="ttl">Compare</h2><span class="sws" data-tip=${ss.map((s, i) => (i ? "" : "baseline: ") + s.label + " (" + runsTxt(s) + ")").join("\n")}>${ss.map((s) => html`<${Swatch} id=${s.id} />`)}<span class="gu">${ss.length} series, ${cmpRuns(ss)} runs</span></span><${Help} /></div>`;
}
// the series over Compare's tabs: each one's tag (a click makes it the baseline) and its runs
const SeriesKey = ({ ss, route }) => html`<div class="skey">${ss.map((s, i) => html`<button key=${s.id} type="button" class="skb" aria-pressed=${!i} data-tip=${i ? "a click makes it the baseline" : null} onClick=${() => i && baseline(route, s.id)}><${SerTag} s=${s} base=${!i} /><span class="gu">${runsTxt(s)}</span></button>`)}</div>`;

// ---- the body: Compare's summary, else a run tab with statistics (the series' key over it on Compare)
export function CmpBody({ ss, route, tab, pbW }) {
	const W = pbW - 32 - 26;
	if (tab === "summary") return html`<${Summary} ss=${ss} route=${route} W=${W} />`;
	const key = ss.length > 1 ? html`<${SeriesKey} ss=${ss} route=${route} />` : null;
	if (tab === "buffs") return [key, html`<${BuffsCmp} ss=${ss} />`];
	if (tab === "supply") return [key, html`<${SupplyCmp} ss=${ss} />`];
	if (tab === "monsters") return [key, html`<${MonstersCmp} ss=${ss} />`];
	if (tab === "run") return [key, html`<${RunCmp} ss=${ss} />`];
	if (tab === "data") return [key, html`<${MultiKpis} ss=${ss} />`, html`<${DataPanels} ss=${ss} W=${W + 26} />`];
	return [key, html`<section class="card1"><${RosterCmp} ss=${ss} /></section>`, html`<${Fold} k="items" title="Items"><section class="box"><${ItemsReach} ss=${ss} /></section></${Fold}>`];
}
// Compare: the verdict, per character, the timeline, every run as a dot, the metric against the one setting the series
// differ in
function Summary({ ss, route, W }) {
	const m = MET[V.cmet] || heroM(), sweep = sweepOf(ss), d = dataM(V.stime);
	const pick = html`<${MetricPick} id=${d.id} only=${(x) => x.g && x.g !== "level"} onPick=${(k) => setV({ stime: k })} />`;
	return [html`<${Verdict} ss=${ss} route=${route} W=${W + 26} />`, html`<${PerChar} ss=${ss} />`, html`<section class="box"><${CmpTimeline} ss=${ss} W=${W} bands=${true} d=${d} head=${pick} /></section>`,
		html`<section class="box"><div class="gh"><label class="dd"><span class="ic">${m.ic()}</span><${Select} aria-label="Metric" value=${m.id} onChange=${(e) => setV({ cmet: e.currentTarget.value })}>${REG.map((x) => html`<option value=${x.id}>${x.label}</option>`)}</${Select}></label><span class="gu">each run a dot (a click opens it), the mean a tick, ± sd a bar</span></div>
			<${DotPlot} ss=${ss} label=${m.label} fm=${(v) => fmtM(m, v)} W=${W} get=${(s) => s.runs.map((w) => ({ w, v: mval(m, w).party }))} open=${open} runOf=${runOf} tag=${(s, base) => html`<${SerTag} s=${s} base=${base} />`} /></section>`,
		sweep ? html`<section class="box"><${SweepChart} ss=${ss} sw=${sweep} m=${m} W=${W} /></section>` : null];
}
// the verdict: a row per headline metric (the tiles': the headline's, deaths, the chips'), the baseline's value (mean
// +/- sd), then every other series' value and its change from the baseline (in colour only past the noise; the test on
// hover). The series head the columns: a click makes one the baseline; under each, how many runs are behind it, with
// fewer than 2 on a side "noise unknown" and more seeds (a rerun of its setup from the next seeds). As many series side
// by side as fit, then the next block under them.
function Verdict({ ss, route, W }) {
	const ms = kpiMs(), B = ss[0], vs = ss.slice(1), per = Math.max(1, Math.floor((W - 280) / 140)), blocks = [];
	for (let i = 0; i < Math.max(1, vs.length); i += per) blocks.push(vs.slice(i, i + per));
	const more = (s) => { const w = s.runs[0] || s.all[0], n = s.runs.length; return n < 2 && w && w.ctl && w.ctl.rerun ? html`<a class="lnk sm" href=${"#/new?from=" + encodeURIComponent(w.id) + "&runs=" + (3 - n)} data-tip=${"its setup again from the next seed: " + (3 - n) + " more, 3 runs in all (on the New sim page, to change first)"}>more seeds</a>` : null; };
	const head = (s, j) => html`<th key=${s.id} scope="col" class="vsh"><button type="button" class="vsb" aria-pressed=${!j} data-tip=${j ? "a click makes it the baseline" : null} onClick=${() => j && baseline(route, s.id)}>${j ? html`<${SerTag} s=${s} />` : html`<span class="stg"><${Swatch} id=${s.id} />${vs.length ? html`<b class="bln">Baseline</b>` : null}</span>`}</button>
		<span class="vrn">${runsTxt(s)}${j && (B.runs.length < 2 || s.runs.length < 2) ? html`<span class="nu" data-tip="fewer than 2 runs on a side: the noise of this change is unknown">noise unknown</span>` : null}${more(s)}</span></th>`;
	const val = (m, a) => (a.n ? fmtM(m, a.mean) : "-");
	const pad = (vb) => (blocks.length > 1 ? per - vb.length : 0), fill = (vb, T) => (pad(vb) ? html`<${T} colspan=${pad(vb)}></${T}>` : null);
	const row = (m, vb) => { const a0 = aggOf(m, B);
		return html`<tr><th scope="row" data-tip=${m.what}><span class="ico">${m.ic()}</span>${m.label}</th><td class="vb">${val(m, a0)}${a0.sd != null ? html`<small class="sd">± ${fmtM(m, a0.sd)}</small>` : null}</td>
			${vb.map((s) => { const a = aggOf(m, s); return html`<td><span class="vv">${val(m, a)}</span><${Delta} m=${m} a=${a0} b=${a} pre=${s.label + ": " + fmtMS(m, a) + cunit(m) + " vs " + fmtMS(m, a0) + cunit(m) + "; "} /></td>`; })}${fill(vb, "td")}</tr>`; };
	return html`<section class="box vd">${vs.length ? html`<div class="vcap"><${SerTag} s=${B} base=${true} /></div>` : null}
		${blocks.map((vb, bi) => html`<table class="vt"><colgroup><col class="vcm" /><col class="vcb" />${vb.map(() => html`<col />`)}${pad(vb) ? html`<col span=${pad(vb)} />` : null}</colgroup>
			<thead><tr><th>${bi ? null : html`<${MetricsButton} label="Metrics" cls="cb" tip="the rows: the big number's metric, deaths and the chips'" />`}</th>${head(B, 0)}${vb.map((s) => head(s, ss.indexOf(s)))}${fill(vb, "th")}</tr></thead>
			<tbody>${ms.map((m) => row(m, vb))}</tbody></table>`)}</section>`;
}
// a character's key across the series: its name, but for a name one series has alone while another has a character of
// its class no other series has (other players' builds): its class (and place among its class)
function charKey(ss) {
	const names = ss.map((s) => new Map(s.runs.flatMap((w) => w.players.map((p) => [p.name, p.type])))), shared = (n) => names.filter((x) => x.has(n)).length > 1;
	const lone = (n, t) => names.length > 1 && !shared(n) && names.some((x) => !x.has(n) && [...x].some(([o, ty]) => ty === t && !shared(o)));
	return (w, c) => { if (!lone(c.name, c.type)) return c.name; const same = statsOf(w).P.filter((x) => x.type === c.type); return c.type + (same.length > 1 ? " " + (same.indexOf(c) + 1) : ""); };
}
// per character: its change from the baseline in each headline metric a character has (a line per other series, none
// where both are 0, or a side hasn't it); a gear change mostly moves one character. A character a change touches is
// marked (what changed on hover).
function PerChar({ ss }) {
	if (ss.length < 2) return null;
	const ms = kpiMs().filter((m) => m.of), ck = charKey(ss), rows = new Map(), vs = ss.slice(1);
	ss.forEach((s, si) => s.runs.forEach((w) => { for (const c of statsOf(w).P) { const k = ck(w, c), r = rows.get(k) || rows.set(k, { k, p: c.p, v: ms.map(() => ss.map(() => [])) }).get(k); ms.forEach((m, mi) => { const x = mval(m, w).by.get(c.name); if (x != null && isFinite(x)) r.v[mi][si].push(x); }); } }));
	const cell = (m, r, mi) => { const a0 = agg(r.v[mi][0]);
		return html`<td>${vs.map((s, j) => { const a = agg(r.v[mi][j + 1]);
			return a0.n && a.n && (a0.mean || a.mean) ? html`<span class="pcl">${vs.length > 1 ? html`<${Swatch} id=${s.id} />` : null}<${Delta} m=${m} a=${a0} b=${a} pre=${r.k + ", " + m.label + ": " + fmtMS(m, a0) + " → " + fmtMS(m, a) + "; "} /></span>` : null; })}</td>`; };
	return html`<section class="box pch"><div class="gh"><b>Per character</b><span class="gu">the change from the baseline${vs.length > 1 ? ", a line per series" : ""}</span></div>
		<table class="itab pct"><tbody><tr><th></th>${ms.map((m) => html`<th data-tip=${m.what}><span class="ico">${m.ic()}</span>${m.label}</th>`)}</tr>
		${[...rows.values()].map((r) => { const tc = vs.flatMap((s) => (s.chg || []).filter((c) => c.who === r.k));
			return html`<tr key=${r.k}><th scope="row" style=${cvar(r.p.type)}><span>${weaponOf(r.p, 20)}${r.k}${tc.length ? html`<i class="chd" data-tip=${"changed: " + [...new Set(tc.map(chgTxt))].join("\n")}></i>` : null}</span></th>${ms.map((m, mi) => cell(m, r, mi))}</tr>`; })}</tbody></table></section>`;
}
// the headline numbers: the run's tiles, with per series its mean +/- sd (and the change from the baseline); one series
// (a group) as a run's, its mean with "± sd" under it; several, a line each: its swatch, mean, the change from the
// first, the baseline (± sd on hover)
function KtSeries({ ic, label, m, ss, get, cls = "" }) {
	const as = ss.map((s) => agg(s.runs.map(get))), a = as[0], u = cunit(m), of = (x) => (x.n ? (x.sd != null ? "mean ± sd of " : "the mean of ") + x.n + " run" + (x.n === 1 ? "" : "s") : "not measured in these runs");
	if (ss.length === 1) return html`<${Kt} ic=${ic} label=${label} cls=${[cls, !a.n ? "na" : m.id === "deaths" && a.mean > 0 ? "bad" : ""].filter(Boolean).join(" ")} sub=${a.sd != null ? "± " + fmtM(m, a.sd) : ""} tip=${of(a)}><${Ktv} v=${fmtM(m, a.mean)} unit=${a.n ? u : ""} /></${Kt}>`;
	return html`<${Kt} ic=${ic} label=${label} cls=${cls}><span class="ktrs">${as.map((x, i) => html`<span class="ktr" data-tip=${ss[i].label + ": " + fmtMS(m, x) + u + ", " + of(x)}><${Swatch} id=${ss[i].id} /><b>${fmtM(m, x.mean)}${x.n ? u : ""}</b>${i ? html`<${Delta} m=${m} a=${a} b=${x} />` : html`<span></span>`}</span>`)}</span></${Kt}>`;
}
const MultiKpis = ({ ss }) => html`<div class="kpis">${kpiMs().map((m, i) => html`<${KtSeries} key=${m.id} ic=${m.ic()} label=${m.label} m=${m} ss=${ss} get=${(w) => mval(m, w).party} cls=${i ? "" : "khero"} />`)}</div>`;

// ---- the meters with statistics: the meter's rows over the series: the party and a row per character, or the
// breakdown drilled into (an entry a run lacks counts 0 there); per row and series the runs' values ({ w, v }) and their
// agg(). Past 4 series of a sweep the meter turns: a row per value of the swept setting, for one character or entry.
function statRows(ss, m, drill) {
	const ck = charKey(ss), rows = new Map();
	const row = (key, label, ic, css) => rows.get(key) || rows.set(key, { key, label, ic, css, runs: ss.map(() => []) }).get(key);
	ss.forEach((s, si) => s.runs.forEach((w) => {
		const S1 = statsOf(w);
		if (!drill) {
			row("*", "Party", icon("citizens"), "--c:var(--line)").runs[si].push({ w, v: tot(S1.P, (c) => m.v(c, S1)) });
			for (const c of S1.P) row(ck(w, c), ck(w, c), weaponOf(c.p, 22), cvar(c.type)).runs[si].push({ w, v: m.v(c, S1) });
			return;
		}
		const cs = drill.who === "*" ? S1.P : S1.P.filter((c) => ck(w, c) === drill.who);
		if (!cs.length) return;
		const es = drillEntries(w, S1, m, cs, drill.by);
		for (const e of es) row(e.k, e.k, entryIcon(w, e.k), "").runs[si].push({ w, v: e.v });
		for (const r of rows.values()) if (!es.some((e) => e.k === r.key)) r.runs[si].push({ w, v: 0 });
	}));
	const out = [...rows.values()];
	for (const r of out) { for (const xs of r.runs) for (let i = xs.length - 1; i >= 0; i--) if (xs[i].v == null || !isFinite(xs[i].v)) xs.splice(i, 1); r.a = r.runs.map((xs) => agg(xs.map((x) => x.v))); }
	return out.filter((r) => r.a.some((a) => a.n && a.mean)).sort((a, b) => (b.key === "*") - (a.key === "*") || Math.max(...b.a.map((x) => x.mean || 0)) - Math.max(...a.a.map((x) => x.mean || 0)));
}
// m: a Data panel's metric; st: its state ({ drill, dotFor, mrow }; a Breakdown panel's drill: the party's, fixed),
// set(o): a change of it
export function StatMeters({ ss, m, st, set, fixed, W }) {
	const ck = charKey(ss), sw = sweepOf(ss), flip = !!sw && ss.length > 4, ref = useRef(null);
	let drill = st.drill;
	const focus = useDrillFocus(ref, drill && !fixed ? () => set({ drill: null }) : null);
	if (m.k === "items") return html`<section class="meters" ref=${ref}><${ItemsReach} ss=${ss} /></section>`;
	// per what: character, or the party's breakdowns any run has; a character drilled into: its breakdowns
	const any = (by, who) => ss.some((s) => s.runs.some((w) => { const S1 = statsOf(w), cs = who === "*" ? S1.P : S1.P.filter((c) => ck(w, c) === who); return cs.length && drillEntries(w, S1, m, cs, by).length; }));
	const pers = [...new Set([...(m.by || []), ...(m.pby || [])])].filter((b) => b !== "character" && any(b, "*"));
	const bysOf = (who) => (who === "*" ? pers : (m.by || []).filter((b) => any(b, who)));
	if (drill) { const bys = bysOf(drill.who); drill = !bys.length ? null : !bys.includes(drill.by) ? { ...drill, by: bys[0] } : drill; }
	const head = [];
	if (drill) { const bys = bysOf(drill.who); head.push(html`<div class="dh">${fixed ? null : html`<button type="button" class="back" onClick=${() => { focus("[data-drill]"); set({ drill: null }); }}><i class="chev"></i>Back</button>`}<span>${(drill.who === "*" ? "Party" : drill.who) + " - " + m.label}</span></div>`,
		bys.length > 1 ? html`<span class="seg sm" role="group" aria-label="Breakdown by">${bys.map((b) => html`<button type="button" aria-pressed=${b === drill.by} onClick=${() => set({ drill: { ...drill, by: b } })}>by ${b}</button>`)}</span>` : html`<p class="mnote">by ${drill.by}</p>`); }
	const rows = statRows(ss, m, drill), fm = (v) => fmtN(v, m.d) + (m.u || ""), fa = (a) => (a.n ? fm(a.mean) + (a.sd != null ? " ± " + fmtN(a.sd, m.d) : "") : "-");
	if (!rows.length) return html`<section class="meters" ref=${ref}>${head}<p class="mnote">- ${m.none || "not measured in these runs"}</p></section>`;
	const mm = { ...m, better: m.f === "taken" || m.f === "over" || m.f === "overkill" || m.f === "pots" ? -1 : m.f === "recv" || m.f === "mana" ? 0 : 1, k: "total", fmt: fm };
	// a bar per series: the mean, a whisker +/- sd (a click shows the row's runs as dots)
	const max = Math.max(...rows.flatMap((x) => x.a.map((a) => (a.mean || 0) + (a.sd || 0))), 1e-9), P = (v) => (100 * Math.max(0, Math.min(v, max))) / max;
	const bars = (r, idx, ref0 = 0) => idx.map((i) => { const a = r.a[i], s = ss[i];
		return html`<button type="button" class="pbr" style=${"--c:" + s.color} data-tip=${s.label + ": " + a.n + " run" + (a.n === 1 ? "" : "s") + "; a click shows them"} onClick=${() => set({ dotFor: st.dotFor === r.key ? null : r.key })}><span class="ptrack"><i class="pbar" style=${"width:" + P(a.mean || 0).toFixed(1) + "%"}></i>
			${a.sd != null ? html`<i class="pwh" style=${"left:" + P(a.mean - a.sd).toFixed(1) + "%;width:" + (P(a.mean + a.sd) - P(a.mean - a.sd)).toFixed(1) + "%"}></i>` : null}</span><span class="pv">${fa(a)}</span><span class="pd">${i !== ref0 ? html`<${Delta} m=${mm} a=${r.a[ref0]} b=${a} />` : null}</span></button>`; });
	let list;
	if (flip) {
		// turned: a row per series in the order of the swept setting, for one character or entry
		const r = rows.find((x) => x.key === st.mrow) || rows[0], order = ss.map((s, i) => i).sort((a, b) => (sw.num ? sw.x(sw.vals[a]) - sw.x(sw.vals[b]) : String(sw.vals[a]).localeCompare(String(sw.vals[b]))));
		head.push(html`<label class="dd">for <${Select} aria-label="Row" value=${r.key} onChange=${(e) => set({ mrow: e.currentTarget.value, dotFor: null })}>${rows.map((x) => html`<option value=${x.key}>${x.label}</option>`)}</${Select}></label>`, html`<p class="gu">a row per value of ${keyName(sw.key)}</p>`);
		list = order.map((i) => html`<div class="srow"><span class="sn"><${Swatch} id=${ss[i].id} />${sw.txt(sw.vals[i])}</span><div class="sbars">${bars(r, [i], order[0])}</div></div>`);
	} else list = rows.map((r) => {
		const can = !drill && bysOf(r.key).length > 0;
		const nm = [html`<span class="ic">${r.ic}</span>`, r.label, can ? html`<i class="cv" aria-hidden="true"></i>` : null];
		return html`<div key=${r.key} class="srow">${can ? html`<button type="button" data-drill=${r.key} class="sn" style=${r.css} onClick=${() => { focus(".back"); set({ drill: { who: r.key, by: st.drill && st.drill.by } }); }}>${nm}</button>` : html`<span class="sn" style=${r.css}>${nm}</span>`}<div class="sbars">${bars(r, ss.map((_, i) => i))}</div></div>`;
	});
	const dr = st.dotFor != null && rows.find((x) => x.key === st.dotFor);
	return html`<section class="meters" ref=${ref}>${head}<div class="slist">${list}</div>
		${dr ? html`<div class="sdots"><div class="gh"><b>${dr.label + " - " + m.label}</b><span class="gu">per run: a click opens its page</span><button type="button" class="lnk sm" onClick=${() => set({ dotFor: null })}>close</button></div>
			<${DotPlot} ss=${ss} label=${dr.label + ": " + m.label} fm=${(v) => fmtN(v, m.d)} W=${W} get=${(s) => dr.runs[ss.indexOf(s)]} open=${open} runOf=${runOf} tag=${(s, base) => html`<${SerTag} s=${s} base=${base} />`} /></div>` : null}</section>`;
}
// the items per series: how many of its runs upgraded (or looted) each one; the snapshots record no times
function ItemsReach({ ss }) {
	const reached = (w) => {
		const out = new Map();
		for (const p of w.players) {
			const it = p.items;
			if (!it) continue;
			if (V.itab === "up") { for (const o of [it.upgraded, it.compounded]) for (const [k, e] of Object.entries(o || {})) if (e && num(e.ok) > 0) out.set(k, (out.get(k) || 0) + num(e.ok)); }
			else for (const [k, n] of Object.entries(it.looted || {})) if (num(n) > 0) out.set(k, (out.get(k) || 0) + num(n));
		}
		return out;
	};
	const per = ss.map((s) => s.runs.map(reached)), items = new Map();
	per.forEach((rs, si) => rs.forEach((r) => { for (const [k, q] of r) { const e = items.get(k) || items.set(k, ss.map(() => ({ x: 0, q: 0 }))).get(k); e[si].x++; e[si].q += q; } }));
	const seg = html`<div class="gh"><${ItemsSeg} /><span class="gu" data-tip="per series: how many of its runs upgraded (or looted) each item; a cell's tooltip: how many in all">runs that ${V.itab === "up" ? "upgraded" : "looted"} each item</span></div>`;
	if (!items.size) return html`<section class="its">${seg}<p class="mnote">${V.itab === "up" ? "no upgrades or compounds in these runs" : "nothing looted in these runs"}</p></section>`;
	const list = [...items].sort((a, b) => b[1].reduce((s, e) => s + e.x, 0) - a[1].reduce((s, e) => s + e.x, 0) || b[1].reduce((s, e) => s + e.q, 0) - a[1].reduce((s, e) => s + e.q, 0));
	const tr = ([k, es]) => html`<tr><td><span>${iconFit(k, 22)}${k}</span></td>${es.map((e, i) => html`<td data-tip=${ss[i].label + ": " + e.x + " of " + ss[i].runs.length + " runs, " + fmtN(e.q, 0) + " in all" + (e.x ? " (" + fmtN(e.q / e.x) + " per run that had it)" : "")}>${e.x ? e.x + "/" + ss[i].runs.length : html`<span class="z">0/${ss[i].runs.length}</span>`}</td>`)}</tr>`;
	const head = html`<tr><th>item</th>${ss.map((s) => html`<th data-tip=${s.label}><${Swatch} id=${s.id} />runs</th>`)}</tr>`;
	return html`<section class="its">${seg}<div class="iscroll"><table class="itab"><tbody>${head}${list.slice(0, 25).map(tr)}</tbody></table></div>
		${list.length > 25 ? html`<${Fold} k="+reach" title=${list.length - 25 + " more items"}><div class="iscroll"><table class="itab"><tbody>${head}${list.slice(25).map(tr)}</tbody></table></div></${Fold}>` : null}</section>`;
}
// the characters across the series: per series its level at the end and levels gained (means), its value of the headline
function RosterCmp({ ss }) {
	const ck = charKey(ss), hm = heroM().of ? heroM() : MET.xph, rows = new Map();
	ss.forEach((s, si) => s.runs.forEach((w) => { const mv = mval(hm, w); for (const c of statsOf(w).P) { const k = ck(w, c), r = rows.get(k) || rows.set(k, { k, p: c.p, per: ss.map(() => ({ g: [], v: [], lv: [] })) }).get(k); r.per[si].g.push(c.p.level - c.p.start_level); r.per[si].v.push(mv.by.get(c.name)); r.per[si].lv.push(c.p.level); } }));
	return html`<div class="roster rc">${[...rows.values()].map((r) => html`<div class="mem" style=${cvar(r.p.type)}><span class="slot">${weaponOf(r.p, 24)}</span><span class="nm">${r.k}</span>
		${r.per.map((x, i) => { if (!x.lv.length) return html`<span class="rcs"></span>`; const g = agg(x.g); return html`<span class="rcs"><${Swatch} id=${ss[i].id} /><span class="lvl" data-tip="the level at the end and the levels gained (means)">L${Math.round(mean(x.lv))}${g.mean > 0 ? html`<span class="gain">+${+g.mean.toFixed(1)}</span>` : null}</span><b>${fmtMS(hm, agg(x.v))}</b></span>`; })}</div>`)}</div>`;
}
// the series' buffs and debuffs: each condition's share of the time (the characters that fought), mean +/- sd over the runs
function BuffsCmp({ ss }) {
	const share = (w, k) => { const S1 = statsOf(w), ps = activeOf(S1).length ? activeOf(S1) : S1.P, m = w.measured_ms || 0; return m > 0 && ps.length ? mean(ps.map((c) => { const x = c.p.conditions && c.p.conditions[k]; return x && Number.isFinite(x.ms) ? clamp01(x.ms / m) : 0; })) : null; };
	const keys = new Set();
	for (const s of ss) for (const w of s.runs) for (const p of w.players) for (const [k, c] of Object.entries(p.conditions || {})) if (c && c.ms > 0) keys.add(k);
	if (!keys.size) return html`<p class="mnote">- no conditions recorded in these runs</p>`;
	const w0 = ss[0].runs[0] || ss[0].all[0], um = { k: "share", better: 0, label: "uptime" }, groups = { buff: [], debuff: [], other: [] };
	const rows = [...keys].map((k) => ({ k, a: ss.map((s) => agg(s.runs.map((w) => share(w, k)))) })).sort((x, y) => Math.max(...y.a.map((a) => a.mean || 0)) - Math.max(...x.a.map((a) => a.mean || 0)));
	for (const r of rows) (groups[kindOf(w0, r.k)] || groups.other).push(r);
	const head = html`<tr><th></th>${ss.map((s, i) => html`<th>${colTag(ss, i)}</th>`)}</tr>`;
	const tr = (r) => html`<tr><td><${Cond} k=${r.k}><span class="ic">${condIcon(r.k, null, w0)}</span>${condName(r.k)}</${Cond}></td>${r.a.map((a, i) => html`<td>${a.n ? pctU(a.mean) + (a.sd != null ? " ± " + pct(a.sd) : "") : "-"}${i ? [" ", html`<${Delta} m=${um} a=${r.a[0]} b=${a} />`] : null}</td>`)}</tr>`;
	return [html`<p class="gu">Each condition's share of the time (the characters that fought), mean ± sd over the runs. A click on a name shows what it does.</p>`,
		...[["buff", "Buffs"], ["debuff", "Debuffs"], ["other", "Other conditions"]].filter(([g]) => groups[g].length).map(([g, hd]) => html`<section><h4>${hd}</h4><div class="iscroll"><table class="itab ctab"><tbody>${head}${groups[g].map(tr)}</tbody></table></div></section>`)];
}
// the series' supply: the merchant's numbers per game hour, mean +/- sd
function SupplyCmp({ ss }) {
	const M = (w) => { const S1 = statsOf(w); return S1.M ? { S1, c: S1.M } : null; };
	if (!ss.some((s) => s.runs.some(M))) return html`<p class="mnote">- no merchant in these runs</p>`;
	const defs = [["Trips", icon("travel"), 1, (w) => { const x = M(w); return x && w.trips_available !== false ? x.S1.per(x.c.trips) : null; }], ["Deliveries", icon("inventory"), 1, (w) => { const x = M(w); return x && x.S1.dv ? x.S1.per(Object.values(x.S1.dv).reduce((a, n) => a + num(n), 0)) : null; }],
		["Income", icon("gold"), 1, (w) => { const x = M(w); return x && x.c.income != null ? x.S1.per(x.c.income) : null; }], ["Spent", icon("gold"), -1, (w) => { const x = M(w); return x && x.c.spent != null ? x.S1.per(x.c.spent) : null; }]];
	return [html`<p class="gu">The merchant's numbers per game hour, mean ± sd over the runs.</p>`, html`<div class="kpis">${defs.map(([l, ic, better, get]) => html`<${KtSeries} ic=${ic} label=${l} m=${{ k: "rate_h", better, label: l }} ss=${ss} get=${get} />`)}</div>`];
}
// the series' monsters (metrics.js monstersOf), the ones the runs hunted or died to: per type its kills per game hour,
// the deaths it caused per run, its average level at the end; mean +/- sd over the runs (a run without it: 0 kills and
// deaths, no level)
function MonstersCmp({ ss }) {
	const runs = ss.map((s) => s.runs.map((w) => ({ S1: statsOf(w), ms: new Map(monstersOf(w).map((r) => [r.t, r])) }))), types = new Set();
	for (const rs of runs) for (const x of rs) for (const r of x.ms.values()) if (r.kills || r.deaths) types.add(r.t);
	if (!types.size) return html`<p class="mnote">- no monsters killed or killing in these runs</p>`;
	const col = (t, f) => runs.map((rs) => agg(rs.map(({ S1, ms }) => f(S1, ms.get(t)))));
	const rows = [...types].map((t) => ({ t, kh: col(t, (S1, r) => S1.per(r ? r.kills : 0)), d: col(t, (S1, r) => (r ? r.deaths : 0)), lv: col(t, (S1, r) => (r && r.end ? r.end.avg : null)) })).sort((a, b) => Math.max(...b.kh.map((x) => x.mean || 0)) - Math.max(...a.kh.map((x) => x.mean || 0)) || a.t.localeCompare(b.t));
	const head = html`<tr><th></th>${ss.map((s, i) => html`<th>${colTag(ss, i)}</th>`)}</tr>`;
	const table = (hd, f, m, rs) => (!rs.length ? null : html`<section><h4>${hd}</h4><div class="iscroll"><table class="itab ctab"><tbody>${head}${rs.map((r) => html`<tr><td><span>${mon(r.t, 20)}${r.t}</span></td>${r[f].map((a, i) => html`<td>${fmtMS(m, a)}${i ? [" ", html`<${Delta} m=${m} a=${r[f][0]} b=${a} />`] : null}</td>`)}</tr>`)}</tbody></table></div></section>`);
	return [html`<p class="gu">Each monster the runs hunted or died to, mean ± sd over the runs.</p>`,
		table("Kills per game hour", "kh", { k: "rate_h", better: 1 }, rows.filter((r) => r.kh.some((a) => a.mean > 0))),
		table("Deaths caused per run", "d", { k: "n", better: -1, d: 1 }, rows.filter((r) => r.d.some((a) => a.mean > 0))),
		table("Average level at the end", "lv", { k: "n", better: 0, d: 1 }, rows.filter((r) => r.lv.some((a) => a.n)))];
}
// the series' runs: the settings they differ in (each series' first run's), how many they share; every run
function RunCmp({ ss }) {
	const sets = ss.map((s) => settingsOf(s.runs[0] || s.all[0]));
	let diff = html`<p class="mnote">loading the setups...</p>`;
	if (sets.every((x) => x !== undefined)) {
		const keys = [...new Set(sets.flatMap(Object.keys))].filter((k) => k !== "run.seed").sort(), ch = keys.filter((k) => new Set(sets.map((x) => x[k])).size > 1), same = keys.length - ch.length, v = (x) => (x === undefined ? "-" : x.length > 48 ? x.slice(0, 48) + "..." : x);
		diff = [ch.length ? html`<div class="iscroll"><table class="itab ctab stab"><tbody><tr><th>setting</th>${ss.map((s, i) => html`<th>${colTag(ss, i)}</th>`)}</tr>${ch.map((k) => html`<tr><td class="hash">${k}</td>${sets.map((x) => html`<td data-tip=${x[k] ?? "-"}>${v(x[k])}</td>`)}</tr>`)}</tbody></table></div>` : html`<p class="mnote">${ss.length > 1 ? "no setting differs" : "one setup"}</p>`,
			html`<p class="gu">+ ${same} identical setting${same === 1 ? "" : "s"}${ss.some((x) => x.group) ? " (each series' first run)" : ""}</p>`];
	}
	const runs = html`<div class="iscroll"><table class="itab"><tbody><tr><th></th><th>run</th><th>seed</th><th>status</th><th>game time</th><th>started</th></tr>
		${ss.flatMap((x) => x.all.map((w) => html`<tr><td><${Swatch} id=${x.id} /></td><td class="wrap"><a class="lnk" href=${runHash(w.id)}>${w.tag || w.id}</a></td><td>${seedOf(w) ?? ""}</td><td><i class=${"dot " + CATDOT[catOf(w)]} data-tip=${stateText(w)}></i>${catOf(w)}</td><td>${fmtG(w.measured_ms || 0)}</td><td>${startedText(w)}</td></tr>`))}</tbody></table></div>`;
	return [html`<section><h4>Settings that differ</h4>${diff}</section>`, html`<section><h4>Runs</h4>${runs}</section>`];
}
