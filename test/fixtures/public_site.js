"use strict";
// A fake of the game site's public pages (chronal pull publicPull, topCharacters): /player/<name> (the account of
// that character, any case: its characters, the account's name as the title), /characters (the top: every
// character), else the site's "Not Found" page (HTTP 200, no characters). Its markup as the site's: per character a
// script `var slots<name>=...;` then its skin, Name / Class / Level lines and "Online".
const http = require("node:http");

const block = (c) =>
	`<script>\n\tvar slots${c.name.toLowerCase()}=${JSON.stringify(c.slots || {})};\n</script>\n<div style='width: 600px'>\n` +
	`\t<span class='cskin' data-skin="${c.skin || "marmor12a"}" data-cx="${JSON.stringify(c.cx || {}).replace(/"/g, "&quot;")}" data-rip=""></span>\n` +
	`\t<div style='display: inline-block'>\n\t\t<div><span style='color:gray'>Name:</span> ${c.name}</div>\n\t\t<div><span style='color:gray'>Class:</span> ${c.cls}</div>\n` +
	`\t\t<div><span style='color:gray'>Level:</span> ${c.level}</div>\n\t\t${c.online ? "<div><span style='color:green'>Online</span></div>" : ""}\n\t</div>\n` +
	`\t<span class='slots' data-name="${c.name.toLowerCase()}"></span>\n</div>\n`;
const sitePage = (title, cs) =>
	`<!DOCTYPE html><html><head><title>${title}</title><script>var language_source = "default";</script></head><body>${cs.map(block).join("")}` +
	`<script>$(".slots").each(function(){ render_slots(window["slots" + $(this).data("name")]); });</script></body></html>`;

/** accounts: { <account name>: [{ name, cls: "Priest", level, online, slots, skin, cx }] } -> { site, close, hits } */
function fakeSite(accounts) {
	const hits = [];
	const server = http.createServer((req, res) => {
		hits.push(req.url);
		const m = /^\/player\/([^/?]+)$/.exec(req.url),
			name = m && decodeURIComponent(m[1]).toLowerCase(),
			acct = name && Object.entries(accounts).find(([, cs]) => cs.some((c) => c.name.toLowerCase() === name));
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		if (acct) return res.end(sitePage(acct[0], acct[1]));
		if (req.url === "/characters") return res.end(sitePage("Characters", Object.values(accounts).flat().sort((a, b) => b.level - a.level)));
		res.end(sitePage("Adventure Land", []).replace("</body>", "Not Found</body>"));
	});
	return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ site: `http://127.0.0.1:${server.address().port}`, hits, close: () => server.close() })));
}

module.exports = { fakeSite, sitePage };
