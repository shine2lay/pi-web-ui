#!/usr/bin/env node
// initiatives-exact: extracts the owner's supplied Initiatives design into web/src/initiatives-u0/surface.html.
//
//   node scripts/extract-initiatives-template.mjs           write the template
//   node scripts/extract-initiatives-template.mjs --check   exit 1 if the file in the repo differs
//
// Source: Design #76's extended copy (the owner's upload plus the 8 states he accepted on Oct 16). Both files'
// sha256 are checked first; the bundle is read with the design kit's own reader (parseBundle). Kept: the
// helmet's page style and the markup between </helmet> and </x-dc>; dropped: the font style (the fonts are
// pinned in web/initiatives-design-assets.ts) and the x-dc component script (never run; its logic is ported to
// web/src/initiatives-exact-view.ts). Then the binder's attribute names, event bindings and the three
// additions in docs/initiatives-exact.md. Each edit must match exactly once, so a changed source fails
// loudly instead of extracting something else.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHARED = join(userInfo().homedir, "company-lab/shared");
const DESIGN =
	process.env.PI_INITIATIVES_DESIGN ??
	join(SHARED, "initiatives-missing-states-2026-10-13/design/initiatives-desktop-interactive-extended.html");
const UPLOAD =
	process.env.PI_INITIATIVES_UPLOAD ??
	join(SHARED, "initiatives-reference-2026-10-11/incoming/initiatives-desktop-interactive.html");
const PINS = [
	[DESIGN, "497c180eb2888b4d68c8584b5a5b9290166d267bc5acc85a0447cb6e0471058a"],
	[UPLOAD, "0a1587f48083ef562b6b76fb6b1d4b9144537a28fbf402b0c5732184b88b7c9e"],
];
const READER = join(dirname(dirname(DESIGN)), "scripts/bundle.mjs");
const OUT = join(dirname(fileURLToPath(import.meta.url)), "../web/src/initiatives-u0/surface.html");

for (const [file, pin] of PINS) {
	const sha = createHash("sha256").update(readFileSync(file)).digest("hex");
	if (sha !== pin) throw new Error(`${file}: sha256 ${sha}, expected ${pin}. Not the accepted design.`);
}
const { parseBundle } = await import(pathToFileURL(READER).href);
const { template } = parseBundle(readFileSync(DESIGN, "utf8"));

function between(text, open, close) {
	const a = text.indexOf(open);
	if (a < 0 || text.indexOf(open, a + 1) >= 0) throw new Error(`expected one ${open}`);
	const b = text.indexOf(close, a + open.length);
	if (b < 0) throw new Error(`no ${close} after ${open}`);
	return text.slice(a + open.length, b);
}
const pageStyles = (between(template, "<helmet>", "</helmet>").match(/<style>[\s\S]*?<\/style>/g) ?? []).filter(
	(style) => !style.includes("@font-face"),
);
if (pageStyles.length !== 1) throw new Error(`expected one page style in the helmet, found ${pageStyles.length}`);
let markup = between(template, "</helmet>", "</x-dc>");

// The design tool's camel-case attributes, as the Roles template writes them.
const camel = [
	[' sc-camel-on-click="', ' onClick="', 9],
	[' sc-camel-view-box="', ' viewBox="', 21],
];
for (const [from, to, count] of camel) {
	const found = markup.split(from).length - 1;
	if (found !== count) throw new Error(`${from.trim()}: expected ${count}, found ${found}`);
	markup = markup.replaceAll(from, to);
}
if (markup.includes("sc-camel-")) throw new Error("an sc-camel- attribute is left");

const showIf = (name) => `<sc-if value="{{${name}}}" hint-placeholder-val="{{true}}">`;
// initiatives-page addition 5: a line in the design's own empty-list style (its "Nothing matches this filter.").
const EMPTY =
	"margin: 0; padding: 12px; border-radius: 10px; border: 1px dashed #3A3F46; color: #A9AEB6; font-size: 13px";
const noteIf = (name, style = EMPTY) =>
	`<sc-if value="{{${name}}}" hint-placeholder-val="{{false}}"><p style="${style}">{{${name}}}</p></sc-if>\n`;
// Inside a bordered list box, the line is one of the box's rows.
const rowNote = (name, pad) => noteIf(name, `margin: 0; padding: ${pad}; color: #A9AEB6; font-size: 13px`);
const EDITS = [
	// Controls the design draws without a handler get one; a control whose callback is absent isn't shown.
	[
		"New initiative",
		'<sc-if value="{{ds.showNew}}" hint-placeholder-val="{{true}}"><button type="button" style=',
		'<sc-if value="{{ds.showNew}}" hint-placeholder-val="{{true}}"><button type="button" onClick="{{newInitiative}}" style=',
	],
	[
		"Try again (out of date)",
		'{{ds.staleText}}</p>\n<button type="button" style=',
		'{{ds.staleText}}</p>\n<button type="button" onClick="{{retry}}" style=',
	],
	[
		"Try again (server error)",
		'{{ds.alert}}</p>\n<button type="button" style=',
		'{{ds.alert}}</p>\n<button type="button" onClick="{{retry}}" style=',
	],
	[
		"Resume own work (open)",
		'{{sel.pausedText}}</p>\n<button type="button" style=',
		`{{sel.pausedText}}</p>\n${showIf("sel.canResume")}<button type="button" onClick="{{sel.resume}}" style=`,
	],
	["Resume own work (close)", ">Resume own work</button>", ">Resume own work</button></sc-if>"],
	[
		"Lead's buttons (open)",
		'<div style="display: flex; flex-wrap: wrap; gap: 8px">\n<button type="button" style="min-height: 40px;',
		`${showIf("sel.hasLeadActions")}<div style="display: flex; flex-wrap: wrap; gap: 8px">\n${showIf("sel.canMessage")}<button type="button" onClick="{{sel.messageLead}}" style="min-height: 40px;`,
	],
	[
		"Message the lead / Change lead",
		'>Message {{sel.leadName}}</button>\n<button type="button" style=',
		`>Message {{sel.leadName}}</button></sc-if>\n${showIf("sel.canChangeLead")}<button type="button" onClick="{{sel.changeLead}}" style=`,
	],
	["Lead's buttons (close)", ">Change lead</button>\n</div>", ">Change lead</button></sc-if>\n</div></sc-if>"],
	[
		"Mark as read (open)",
		'<button type="button" onClick="{{dz.markSeen}}"',
		`${showIf("dz.canMark")}<button type="button" onClick="{{dz.markSeen}}"`,
	],
	["Mark as read (close)", ">Mark as read</button>", ">Mark as read</button></sc-if>"],
	[
		"Ask the lead to write it (open)",
		'nothing has been recorded.</p>\n<button type="button" style=',
		`nothing has been recorded.</p>\n${showIf("dz.canAsk")}<button type="button" onClick="{{dz.ask}}" style=`,
	],
	[
		"Ask the lead to write it (close)",
		">Ask {{sel.leadName}} to write it</button>",
		">Ask {{sel.leadName}} to write it</button></sc-if>",
	],
	["Decision source", '<a href="#">{{d.source}}</a>', '<a href="#" onClick="{{d.openSource}}">{{d.source}}</a>'],
	// Addition 1: the "in no initiative" box takes its heading and items from input.
	[
		"No-initiative heading",
		">Roles in no initiative · 1</h2>\n",
		'>{{loose.heading}}</h2>\n<sc-for list="{{loose.items}}" as="lo" hint-placeholder-count="1">\n',
	],
	[
		"No-initiative item",
		'>MA</span>\n<span style="font-weight: 600">Marketing</span>\n<span style="margin-left: auto;',
		`>{{lo.mono}}</span>\n<span style="font-weight: 600">{{lo.name}}</span>\n${showIf("lo.hasOnYou")}<span style="margin-left: auto;`,
	],
	[
		"No-initiative note",
		'ON YOU</span>\n</div>\n<p style="margin: 0; font-size: 13px; color: #B9BEC5">Asked you 4 d ago which initiative to join. Still handles requests meanwhile.</p>',
		`ON YOU</span></sc-if>\n</div>\n${showIf("lo.hasNote")}<p style="margin: 0; font-size: 13px; color: #B9BEC5">{{lo.note}}</p></sc-if>`,
	],
	["No-initiative choices (shown)", '<sc-if value="{{mkOpen}}"', '<sc-if value="{{lo.open}}"'],
	["No-initiative choices (list)", '<sc-for list="{{mkChoices}}"', '<sc-for list="{{lo.choices}}"'],
	[
		"No-initiative answer",
		'<sc-if value="{{mkSent}}" hint-placeholder-val="{{false}}">\n<p style="margin: 0; font-size: 13px; color: #9CC7FF">Sent to Marketing: “{{mkAnswer}}”. Not read yet.</p>\n</sc-if>\n</section></sc-if>',
		'<sc-if value="{{lo.sent}}" hint-placeholder-val="{{false}}">\n<p style="margin: 0; font-size: 13px; color: #9CC7FF">Sent to {{lo.name}}: “{{lo.answer}}”. Not read yet.</p>\n</sc-if>\n</sc-for>\n</section></sc-if>',
	],
	// Addition 2: a "Who's doing what" row's child task rows use the same row, indented 16 px.
	[
		"Row indent",
		"gap: 10px 16px; padding: 14px; background: {{r.bg}}",
		"gap: 10px 16px; padding: {{r.pad}}; background: {{r.bg}}",
	],
	// initiatives-page addition 4: the "in no initiative" box opens like an initiative, outlined like a
	// selected card while open.
	[
		"No-initiative box (opens)",
		'<section aria-labelledby="noinit" style="margin-top: 6px; padding: 14px; border-radius: 12px; border: 1px dashed #3A3F46; display: flex;',
		'<section aria-labelledby="noinit" onClick="{{loose.pick}}" style="margin-top: 6px; padding: 14px; border-radius: 12px; border: 1px dashed {{loose.bd}}; background: {{loose.bg}}; cursor: pointer; display: flex;',
	],
	[
		"No-initiative heading (a button)",
		">{{loose.heading}}</h2>\n",
		'><button type="button" onClick="{{loose.pick}}" aria-current="{{loose.current}}" style="padding: 0; border: 0; background: transparent; color: inherit; font: inherit; letter-spacing: inherit; text-transform: inherit; text-align: left; cursor: pointer">{{loose.heading}}</button></h2>\n',
	],
	// initiatives-page addition 5: a section with nothing connected or recorded yet says so.
	[
		"Outcomes note",
		"Outcomes · {{sel.doneText}}</h3>\n",
		"Outcomes · {{sel.doneText}}</h3>\n" + noteIf("sel.outcomesNote"),
	],
	[
		"Latest updates note",
		'<ol style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px">\n<sc-for list="{{sel.latest}}"',
		noteIf("sel.latestNote") +
			'<ol style="margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 6px">\n<sc-for list="{{sel.latest}}"',
	],
	[
		"Who's doing what note",
		'overflow: hidden">\n<sc-for list="{{sel.roles}}"',
		'overflow: hidden">\n' + rowNote("sel.rowsNote", "14px") + '<sc-for list="{{sel.roles}}"',
	],
	[
		"Done-when note",
		"Done when · {{sel.doneText}}</h3>\n",
		"Done when · {{sel.doneText}}</h3>\n" + noteIf("sel.outcomesNote"),
	],
	["Hand-offs note", "Hand-offs between roles</h3>\n", "Hand-offs between roles</h3>\n" + noteIf("sel.handoffsNote")],
	[
		"Gaps note",
		"Gaps the lead hasn’t covered · {{sel.gapCount}}</h3>\n",
		"Gaps the lead hasn’t covered · {{sel.gapCount}}</h3>\n" + noteIf("sel.gapsNote"),
	],
	[
		"Activity note",
		'overflow: hidden">\n<sc-for list="{{sel.activity}}"',
		'overflow: hidden">\n' + rowNote("sel.activityNote", "11px 14px") + '<sc-for list="{{sel.activity}}"',
	],
	// initiatives-page addition 6: a row can show a plain status chip (the registry's status) instead of
	// the role state chip, in the state chip's own shape.
	[
		"Row status (plain chip)",
		'<dc-import name="StateChip" kind="{{r.kind}}" last-known="{{r.lastKnown}}" hint-size="140px,24px"></dc-import>',
		'<sc-if value="{{r.chip}}" hint-placeholder-val="{{true}}"><dc-import name="StateChip" kind="{{r.kind}}" last-known="{{r.lastKnown}}" hint-size="140px,24px"></dc-import></sc-if><sc-if value="{{r.plain}}" hint-placeholder-val="{{false}}"><span style="display: inline-flex; align-items: center; height: 24px; padding: 0 9px; box-sizing: border-box; border-radius: 999px; font-size: 12px; font-weight: 600; white-space: nowrap; color: {{r.plainFg}}; background: {{r.plainBg}}; border: 1px solid {{r.plainBd}}">{{r.plain}}</span></sc-if>',
	],
];
for (const [why, from, to] of EDITS) {
	const found = markup.split(from).length - 1;
	if (found !== 1) throw new Error(`${why}: expected once, found ${found}`);
	markup = markup.replace(from, () => to);
}
for (const [, expression] of markup.matchAll(/\{\{(.*?)\}\}/g))
	if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(expression.trim()))
		throw new Error(`not a value name: {{${expression}}}`);
for (const sample of ["Marketing", "mkOpen", "mkSent", "mkAnswer", "mkChoices"])
	if (markup.includes(sample)) throw new Error(`design sample left in the template: ${sample}`);

const output = pageStyles[0] + markup;
if (process.argv.includes("--check")) {
	if (readFileSync(OUT, "utf8") !== output) {
		console.error(`${OUT} differs from the extraction; rerun without --check.`);
		process.exit(1);
	}
	console.log(`${OUT} matches the extraction.`);
} else {
	writeFileSync(OUT, output);
	console.log(
		`Wrote ${OUT} (${Buffer.byteLength(output)} bytes, sha256 ${createHash("sha256").update(output).digest("hex")}).`,
	);
}
