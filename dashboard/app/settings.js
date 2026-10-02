// The Settings page (#/settings): the live account's API token, set up step by step (create it on the game's site,
// paste it, test it, save it, pull the account), and the folders and port of config/local.json (dashboard/settings.js).
import { h } from "./vendor/preact.js";
import { useState, useEffect } from "./vendor/hooks.js";
import htm from "./vendor/htm.js";
import { api, call, why } from "./lib.js";
import { pollSoon } from "./store.js";

const html = htm.bind(h);
const SITE = "https://adventure.land/vscode";


export function SettingsPage() {
	const [cfg, setCfg] = useState(null);
	const load = async () => {
		const r = await call("api/config");
		setCfg(r.ok ? r.body : { error: why(r) });
	};
	useEffect(() => void load(), []);
	return html`<div class="page">
		<h2>Settings</h2>
		${!cfg ? html`<p class="mnote">loading...</p>` : cfg.error ? html`<p class="nbad">${cfg.error}</p>` : html`<${Token} cfg=${cfg} reload=${load} /><${Paths} cfg=${cfg} reload=${load} />`}
	</div>`;
}

// the characters an account has, as chips
const Chars = ({ list }) => html`<span class="fw">${list.map((c) => html`<span class="chip">${c.name}<span class="gu">${c.class} L${c.level}</span></span>`)}</span>`;

// ---- the live account: where its token comes from; the steps to set one up; a test; Pull now
function Token({ cfg, reload }) {
	const t = cfg.token, set = t.source !== "none";
	const [open, setOpen] = useState(!set);
	const [text, setText] = useState("");
	const [busy, setBusy] = useState("");
	const [tested, setTested] = useState(null); // { list, of: the text tested } or { error }
	const [msg, setMsg] = useState(null); // { text, bad }
	const [pulled, setPulled] = useState(null);
	const where = t.source === "env" ? "from CHRONAL_AL_TOKEN (the environment)" : t.source === "file" ? "in " + t.file + (t.ours ? " (only you can read it)" : " (yours: config al_token_file)") : "none yet";
	const test = async (tok) => {
		setBusy("test"); setMsg(null);
		const r = await call("api/config/token", "POST", tok == null ? { action: "test" } : { action: "test", token: tok });
		setBusy("");
		setTested(r.ok ? { list: r.body.characters, of: tok } : { error: why(r), of: tok });
	};
	const save = async () => {
		setBusy("save");
		const r = await call("api/config/token", "POST", { action: "save", token: text });
		setBusy("");
		if (!r.ok) return setMsg({ text: why(r), bad: true });
		setText(""); setTested({ list: r.body.characters, of: null }); setOpen(false);
		setMsg({ text: "Saved in " + t.file + ": only you can read it. New sim's Pull now uses it." });
		reload();
	};
	const forget = async () => {
		const r = await call("api/config/token", "DELETE");
		setMsg(r.ok ? { text: "Forgotten: " + t.file + " removed." } : { text: why(r), bad: true });
		setTested(null); setOpen(true); reload();
	};
	const pull = async () => {
		setBusy("pull"); setPulled(null);
		const r = await call("api/new/pull", "POST", {});
		setBusy("");
		setPulled(r.ok ? r.body : { error: why(r) });
		if (r.ok) pollSoon();
	};
	const ok = tested && tested.list && tested.of === text.trim();
	return html`<section class="paf card">
		<h3>Live account</h3>
		<p class="gu">The game's token API reads your account (characters, bank, CODE) for New sim's Pull now. Read-only: nothing is sent to your characters.</p>
		<div class="frow"><span class="fl">Token</span><span>${where}</span>
			${set && html`<button type="button" class="cb" disabled=${!!busy} onClick=${() => test(null)}>${busy === "test" && !open ? "Testing..." : "Test it"}</button>`}
			${set && !open && t.writable !== false && html`<button type="button" class="cb" onClick=${() => (setOpen(true), setTested(null))}>Replace</button>`}
			${t.ours && t.source === "file" && html`<button type="button" class="lnk sm" onClick=${forget}>Forget it</button>`}
		</div>
		${tested && !open && (tested.list ? html`<div class="frow"><span class="fl"></span><span class="gu">${tested.list.length} characters:</span><${Chars} list=${tested.list} /></div>` : html`<div class="frow"><span class="fl"></span><span class="nbad">${tested.error}</span></div>`)}
		${open && (t.writable ? html`<ol class="steps">
			<li><b>Create a token</b> on the game's site, logged in: <a class="lnk" href=${SITE} target="_blank" rel="noopener noreferrer">adventure.land/vscode ↗</a>, then copy it.</li>
			<li><b>Paste it</b> here and test it: the game says which account it is.
				<div class="frow"><input type="password" class="tag" autocomplete="off" spellcheck="false" placeholder="the token" aria-label="The token" value=${text} onInput=${(e) => (setText(e.target.value), setMsg(null))} />
					<button type="button" class="cb" disabled=${!text.trim() || !!busy} onClick=${() => test(text.trim())}>${busy === "test" ? "Testing..." : "Test"}</button></div>
				${tested && tested.of === text.trim() && (tested.list ? html`<div class="frow"><span class="gu">${tested.list.length} characters:</span><${Chars} list=${tested.list} /></div>` : html`<p class="nbad">${tested.error}</p>`)}</li>
			<li><b>Save it</b> in ${t.file} (only you can read it${t.ours ? "; git ignores it" : ""}).
				<div class="frow"><button type="button" class="go" disabled=${!ok || !!busy} onClick=${save}>${busy === "save" ? "Saving..." : "Save"}</button>${set && html`<button type="button" class="cb" onClick=${() => (setOpen(false), setText(""), setTested(null))}>Keep the one set</button>`}</div></li>
		</ol>` : html`<p class="nbad">${t.source === "env" ? "The token comes from CHRONAL_AL_TOKEN: change it there." : !t.file ? "Config al_token_file is none: set it below first." : t.file + " is your token file (config al_token_file): ChronAL doesn't overwrite it. Change it there, or clear Token file below to keep the token in config/al_token."}</p>`)}
		${msg && html`<p class=${msg.bad ? "nbad" : "hint"}>${msg.text}</p>`}
		${set && html`<div class="frow"><span class="fl">Pull</span><button type="button" class="cb" disabled=${!!busy} onClick=${pull}>${busy === "pull" ? "Pulling (about 15 s)..." : "Pull now"}</button>
			<span class="gu">the account as it is now: a starting point for New sim</span></div>`}
		${pulled && (pulled.error ? html`<p class="nbad">${pulled.error}</p>` : html`<div class="frow"><span class="fl"></span><span>Pulled ${pulled.id}.</span><a class="cb go" href="#/new">Compose a sim from it</a></div>
			${(pulled.warnings || []).map((w) => html`<p class="nwarn">${w}</p>`)}`)}
	</section>`;
}

// ---- the folders and port: config/local.json's, else the defaults'; env ones read-only
const KEYS = [
	["live_dir", "Runs", "the runs' snapshots, recordings and setup files (the dashboard's runs)"],
	["setups_dir", "Setups", "the templates New sim starts from, where it saves setups"],
	["pulls_dir", "Pulls", "the live account pulled (Pull now, chronal pull)"],
	["players_dir", "Players' pages", "other players' public pages taken (Add player)"],
	["library_dir", "CODE library", "others' CODE added (Add CODE, chronal library)"],
	["accounts_dir", "Crafted accounts", "the accounts made here (Accounts, New sim's Save as account)"],
	["gear_sets_dir", "Gear sets", "your gear sets (New sim's Gear set: Save the sheet)"],
	["code_sets", "CODE sets file", "your CODE sets (chronal-code-sets/1); none: just the library, pulls and folders"],
	["al_root", "The game", "the game the sim runs (chronal install's copy)"],
	["upstream", "The game's repos", "where chronal install clones the game"],
	["g_data", "G data", "the game data the tooltips read; none: the newest cache/G-*.json"],
	["al_token_file", "Token file", "the live account's API token (Live account, above)"],
	["port", "Port", "chronal dash's port (--port overrides it)"],
];
function Paths({ cfg, reload }) {
	const s = cfg.settings;
	const [edit, setEdit] = useState({});
	const [msg, setMsg] = useState(null);
	const val = (k) => (k in edit ? edit[k] : s[k].from === "local" ? String(s[k].local ?? "") : "");
	const changed = Object.keys(edit).filter((k) => edit[k] !== (s[k].from === "local" ? String(s[k].local ?? "") : ""));
	const save = async () => {
		const set = Object.fromEntries(changed.map((k) => [k, edit[k].trim() === "" ? null : k === "port" ? Number(edit[k]) : edit[k].trim()]));
		const r = await api("api/config", "PUT", { set }).then(async (x) => ({ ok: x.ok, status: x.status, body: await x.json().catch(() => ({})) }), (e) => ({ ok: false, status: 0, body: { reason: e.message } }));
		if (!r.ok) return setMsg({ text: why(r), bad: true });
		setEdit({});
		setMsg({ text: "Saved in " + cfg.local_file + ". Restart chronal dash for it to apply." });
		reload();
	};
	return html`<section class="paf card">
		<h3>Folders and port</h3>
		<p class="gu">${cfg.local_file} (empty: the default). Paths are relative to ${cfg.root}. They apply when chronal dash starts again.</p>
		<table class="itab ktab"><tbody>
			${KEYS.map(([k, label, tip]) => {
				const x = s[k], env = x.from === "env";
				return html`<tr>
					<th scope="row" data-tip=${tip}>${label}<div class="gu">${k}</div></th>
					<td>${env ? html`<span>${String(x.value)}</span>` : html`<input type="text" aria-label=${label} value=${val(k)} placeholder=${x.default == null ? "none" : String(x.default)} onInput=${(e) => (setEdit({ ...edit, [k]: e.target.value }), setMsg(null))} />`}</td>
					<td><span class="gu">${env ? "from " + x.env : x.from === "local" ? "set here" : "default"}</span></td>
				</tr>`;
			})}
		</tbody></table>
		<div class="frow"><button type="button" class="go" disabled=${!changed.length} onClick=${save}>Save</button>${changed.length ? html`<button type="button" class="cb" onClick=${() => setEdit({})}>Undo</button>` : ""}
			${msg && html`<span class=${msg.bad ? "nbad" : "hint"}>${msg.text}</span>`}</div>
	</section>`;
}
