"use strict";
// dashboard/app/*.js (the dashboard's ES modules): each parses, every identifier it reads is declared in it, imported,
// or the browser's (a page only fails at run time otherwise, on the path that reads it), every import names an export
// of its module, and no module assigns to an import.
//   node --test test/app.test.js
const test = require("node:test");
const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "dashboard", "app");
const walk = (n, f, parent) => { if (!n || typeof n.type !== "string") return; f(n, parent); for (const k in n) { const v = n[k]; if (k === "parent") continue; if (Array.isArray(v)) v.forEach((c) => walk(c, f, n)); else if (v && typeof v.type === "string") walk(v, f, n); } };

function scan(file) {
	const acorn = require("acorn");
	const ast = acorn.parse(fs.readFileSync(file, "utf8"), { ecmaVersion: "latest", sourceType: "module", locations: true });
	const declared = new Set(), used = new Map(), imports = [], exports = new Set(), assigned = [];
	const pat = (p) => { if (!p) return; if (p.type === "Identifier") declared.add(p.name); else if (p.type === "ObjectPattern") p.properties.forEach((q) => pat(q.type === "RestElement" ? q.argument : q.value)); else if (p.type === "ArrayPattern") p.elements.forEach(pat); else if (p.type === "AssignmentPattern") pat(p.left); else if (p.type === "RestElement") pat(p.argument); };
	walk(ast, (n, parent) => {
		if (n.type === "ImportDeclaration") for (const s of n.specifiers) { declared.add(s.local.name); imports.push({ from: n.source.value, name: s.type === "ImportSpecifier" ? s.imported.name : s.type === "ImportDefaultSpecifier" ? "default" : "*", local: s.local.name }); }
		if (n.type === "ExportNamedDeclaration") { for (const s of n.specifiers || []) exports.add(s.exported.name); if (n.declaration) { if (n.declaration.id) exports.add(n.declaration.id.name); for (const d of n.declaration.declarations || []) if (d.id.type === "Identifier") exports.add(d.id.name); } }
		if (n.type === "ExportDefaultDeclaration") exports.add("default");
		if (n.type === "VariableDeclarator") pat(n.id);
		if ((n.type === "FunctionDeclaration" || n.type === "FunctionExpression" || n.type === "ClassDeclaration") && n.id) declared.add(n.id.name);
		if (/Function/.test(n.type)) n.params.forEach(pat);
		if (n.type === "CatchClause") pat(n.param);
		if ((n.type === "AssignmentExpression" && n.left.type === "Identifier") || (n.type === "UpdateExpression" && n.argument.type === "Identifier")) assigned.push(n.type === "AssignmentExpression" ? n.left.name : n.argument.name);
		if (n.type === "Identifier") {
			if (parent && ((parent.type === "MemberExpression" && parent.property === n && !parent.computed) || (parent.type === "Property" && parent.key === n && !parent.computed && !parent.shorthand) || (parent.type === "MethodDefinition" && parent.key === n) || parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement" || parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier")) return;
			if (!used.has(n.name)) used.set(n.name, n.loc.start.line);
		}
	});
	return { declared, used, imports, exports, assigned };
}
const files = fs.readdirSync(APP).filter((f) => f.endsWith(".js")).map((f) => path.join(APP, f));
const scans = new Map(files.map((f) => [f, scan(f)]));

test("the app's modules: no identifier read that is neither declared, imported, nor the browser's", () => {
	const { JSDOM } = require("jsdom");
	const win = new JSDOM("").window;
	const globals = new Set([...Object.getOwnPropertyNames(globalThis), ...Object.getOwnPropertyNames(win), "window", "document", "navigator", "location", "fetch", "requestAnimationFrame", "cancelAnimationFrame", "ResizeObserver", "IntersectionObserver", "matchMedia", "localStorage", "sessionStorage", "getComputedStyle", "addEventListener", "removeEventListener", "dispatchEvent", "structuredClone", "performance", "queueMicrotask", "AbortController", "CSS", "Intl", "undefined", "arguments", "devicePixelRatio", "innerWidth", "innerHeight", "scrollX", "scrollY", "screen", "history", "alert", "confirm", "prompt", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "Blob", "URL", "FileReader", "DataTransfer", "DOMParser", "Image", "Path2D", "visualViewport", "scrollTo", "open", "close", "focus", "blur", "getSelection", "crypto", "isSecureContext", "origin", "top", "parent", "self", "frames", "name", "postMessage", "HashChangeEvent", "PointerEvent", "CompressionStream", "DecompressionStream", "TextEncoder", "TextDecoder", "Response", "ClipboardItem"]);
	const bad = [];
	for (const [f, s] of scans) for (const [k, l] of s.used) if (!s.declared.has(k) && !globals.has(k)) bad.push(path.basename(f) + ":" + l + " " + k);
	assert.deepStrictEqual(bad, []);
});

test("the app's modules: every import is an export of its module, and none is assigned to", () => {
	const bad = [];
	for (const [f, s] of scans) {
		for (const i of s.imports) {
			if (i.name === "*" || !i.from.startsWith(".")) continue;
			const to = scans.get(path.join(path.dirname(f), i.from)) || scans.get(path.join(APP, "vendor", path.basename(i.from)));
			if (!to && !fs.existsSync(path.join(path.dirname(f), i.from))) bad.push(path.basename(f) + ": no module " + i.from);
			else if (to && !to.exports.has(i.name)) bad.push(path.basename(f) + ": " + i.name + " is not an export of " + i.from);
		}
		for (const a of s.assigned) if (s.imports.some((i) => i.local === a)) bad.push(path.basename(f) + ": assigns to the import " + a);
	}
	assert.deepStrictEqual(bad, []);
});
