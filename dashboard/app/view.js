// What the pages of runs show, as picked (a run's, a group's and Compare's alike): the tab, whose items, the items'
// table, Compare's metric (its dot plot) and its timeline's; the tab, the items' table and the timeline's metric
// remembered in this browser. (The Data tab's panels: metrics.js PANELS, data.js.)
import { load, save } from "./lib.js";
import { redraw } from "./store.js";

export const DTABS = [["chars", "Characters"], ["data", "Data"], ["buffs", "Buffs and debuffs"], ["supply", "Supply"], ["monsters", "Monsters"], ["run", "Run"]];
export const V = { dtab: load("dash_dtab", "chars", (x) => (DTABS.some(([k]) => k === x) ? x : "chars")), itemsWho: "party", itab: load("dash_itab", "up", (x) => (x === "loot" ? "loot" : "up")), cmet: null, stime: load("dash_stime", "xph") };
const KEEP = { dtab: "dash_dtab", itab: "dash_itab", stime: "dash_stime" };
// a change: remembered if it is one of those, then the page drawn again
export function setV(o) {
	Object.assign(V, o);
	for (const k in o) if (KEEP[k]) save(KEEP[k], o[k]);
	redraw();
}
