// The dashboard's page (chronal dash): the sidebar to go anywhere (the runs list under it), the page open beside it,
// each at its own URL: #/runs, #/runs/<run or group>[/<tab>][?replay], #/compare[/<tab>]?ids=a,b, #/new[?from=<run>],
// #/code, #/gearsets, #/accounts, #/settings. Everything is drawn here (Preact), again on each poll of the runs (store.js).
import { h, render } from "./vendor/preact.js";
import { useState, useEffect } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { S, start, useRedraw, useSignal, lastError } from "./store.js";
import { save } from "./lib.js";
import { icon, mon } from "./art.js";
import { HoverTip, ItemTip } from "./tips.js";
import { ChartTip } from "./charts.js";
import { Panel } from "./panel.js";
import { RunsSide, keepPicks } from "./runs.js";
import { NewSim } from "./newsim.js";
import { SettingsPage } from "./settings.js";
import { AccountsPage } from "./accounts.js";
import { CodePage } from "./code.js";
import { GearSetsPage } from "./gearsets.js";

const html = htm.bind(h);

// the URL's page: { page, ... } (an unknown one: the Runs table)
function parseRoute(hash) {
	const raw = String(hash || "").replace(/^#\/?/, ""), i = raw.indexOf("?"), q = new URLSearchParams(i >= 0 ? raw.slice(i + 1) : "");
	const parts = (i >= 0 ? raw.slice(0, i) : raw).split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch (e) { return x; } });
	const [top, a, b] = parts;
	if (top === "code") return { page: "code", set: a || null, file: parts.slice(2).join("/") || null };
	if (top === "runs" && a) return { page: "run", id: a, tab: b || null, replay: q.has("replay") };
	if (top === "compare") return { page: "compare", ids: (q.get("ids") || "").split(",").filter(Boolean), tab: a || "summary" };
	if (top === "new") return { page: "new", from: q.get("from") || null, runs: q.get("runs") || null, pull: q.get("pull") || null, account: q.get("account") || null, player: q.get("player") || null };
	if (top === "gearsets") return { page: "gearsets", name: a || null };
	if (top === "accounts") return { page: "accounts", name: a || null };
	if (top === "settings") return { page: "settings", step: a || null };
	return { page: "runs" };
}

const NAV = [
	["runs", "Runs", "every run, a run's page, Compare"],
	["new", "New sim", "compose a run and start it"],
	["code", "CODE", "your CODE sets, the library's, pulls': read, edit, run again"],
	["gearsets", "Gear sets", "a class's gear for every slot: the Discord list's and yours; New sim wears them"],
	["accounts", "Accounts", "yours, crafted ones, other players': who a run can play"],
	["settings", "Settings", "the live account's token, the folders and port"],
];
const ICONS = {
	runs: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h12M2 13h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>`,
	new: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" /></svg>`,
	code: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5.5 3.5L1.5 8l4 4.5M10.5 3.5l4 4.5-4 4.5" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round" /></svg>`,
	gearsets: html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6l5.4 2v4.1c0 3.2-2.3 5.6-5.4 6.7-3.1-1.1-5.4-3.5-5.4-6.7V3.6z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /><path d="M8 4.6v6.6M5.2 7.6h5.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`,
	accounts: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="6" cy="5.5" r="2.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M1.5 14c.4-2.6 2.2-4 4.5-4s4.1 1.4 4.5 4M11 3.2a2.4 2.4 0 0 1 0 4.6M12.6 10.2c1.1.6 1.8 1.9 1.9 3.8" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`,
	settings: html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.3" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M8 1.5v2.2M8 12.3v2.2M1.5 8h2.2M12.3 8h2.2M3.4 3.4l1.6 1.6M11 11l1.6 1.6M3.4 12.6L5 11M11 5l1.6-1.6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`,
};
// the colours: light, dark or the system's (as it changes), kept in this browser; ?theme=light|dark in the address sets
// one for that page (index.html applies either before the page draws)
const THEME = [
	["light", "Light colours", html`<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M8 1v1.6M8 13.4V15M1 8h1.6M13.4 8H15M3 3l1.1 1.1M11.9 11.9L13 13M3 13l1.1-1.1M11.9 4.1L13 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`],
	["dark", "Dark colours", html`<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 9.6A5.8 5.8 0 0 1 6.4 2.5a5.8 5.8 0 1 0 7.1 7.1z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" /></svg>`],
	["system", "Your system's colours", html`<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.8" y="2.5" width="12.4" height="8.5" rx="1.3" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M5.5 14h5M8 11v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`],
];
function ThemeSwitch() {
	const [t, setT] = useState(() => document.documentElement.dataset.theme || "system");
	const pick = (k) => { if (k === "system") delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = k; save("dash_theme", k); setT(k); };
	return html`<span class="seg sm thm" role="group" aria-label="Colours">${THEME.map(([k, label, ic]) => html`<button type="button" aria-pressed=${t === k} aria-label=${label} data-tip=${label} onClick=${() => pick(k)}>${ic}</button>`)}</span>`;
}
// the last error of the polls (none: hidden)
const Sum = () => html`<span id="sum" role="status">${useSignal(lastError)}</span>`;

function App() {
	useRedraw();
	const [route, setRoute] = useState(() => parseRoute(location.hash));
	useEffect(() => {
		const f = () => { const r = parseRoute(location.hash); setRoute((was) => { if (r.page !== was.page) scrollTo(0, 0); return r; }); };
		addEventListener("hashchange", f);
		return () => removeEventListener("hashchange", f);
	}, []);
	useEffect(() => { const t = { new: route.from ? "Rerun" : "New sim", settings: "Settings", accounts: "Accounts", code: "CODE", gearsets: "Gear sets" }[route.page]; document.title = (t ? t + " - " : "") + "ChronAL"; }, [route.page, route.from]);
	keepPicks(route);
	const sect = route.page === "run" || route.page === "compare" ? "runs" : route.page;
	const page = route.page === "new" ? html`<${NewSim} key=${"new|" + [route.from, route.runs, route.pull, route.account, route.player].map((x) => x || "").join("|")} route=${route} />`
		: route.page === "settings" ? html`<${SettingsPage} />`
		: route.page === "accounts" ? html`<${AccountsPage} />`
		: route.page === "gearsets" ? html`<${GearSetsPage} name=${route.name} />`
		: route.page === "code" ? html`<${CodePage} set=${route.set} file=${route.file} />`
		: html`<${Panel} route=${route} />`;
	return [html`<div class="app">
		<aside class="side" aria-label="Navigation">
			<div class="brand"><span id="logo">${icon("schedule_clock", null, 1) || mon("goo", 24)}</span><b>ChronAL</b><${Sum} /><${ThemeSwitch} /></div>
			<nav class="nav">${NAV.map(([k, label, tip]) => html`<a href=${"#/" + k} aria-current=${sect === k ? "page" : null} data-tip=${tip}>${ICONS[k]}${label}</a>`)}</nav>
			${S.cst && S.cst.game && S.cst.game.text ? html`<p class="gwarn" role="status" data-tip=${S.cst.game.text}>${"The game installed isn't the one this chronal is tested with (" + S.cst.game.pinned + "): run chronal install"}</p>` : null}
			<${RunsSide} route=${route} />
		</aside>
		<main id="main">${page}</main>
	</div>`, html`<${HoverTip} />`, html`<${ItemTip} />`, html`<${ChartTip} />`];
}

render(html`<${App} />`, document.getElementById("app"));
start();
