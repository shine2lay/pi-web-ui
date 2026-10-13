// ---------------------------------------------------------------------------
// initiative-update-tool.ts — initiative_update: an initiative's progress feed (task #85)
// ---------------------------------------------------------------------------
// The owner reads one running progress feed per initiative on the Initiatives page, written by the
// initiative's lead (only he names one) from the roles' own records, each update linked to them.
// new: what was filed under the initiative since the lead's last update, with ids, one line each, plus the
// decisions and changes no update links yet and the decisions missing impact, options or until.
// post: an update (the lead only): changed, next, needs_you; impact, options, until where known; sources =
// the records (dr-…) and decisions (d…, c…) it summarizes. The second-hand check reads it against those
// sources and its reply says what it flagged and what is still unlinked.
// read: the latest updates and their flags.
// Registered in every pi-engine chat like decision_log; it refuses a chat without a role.
// ---------------------------------------------------------------------------

import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ProgressFeed } from "./progress-feed.js";
import type { RoleMessageSender } from "./role-messages.js";
import { INITIATIVE_UPDATE_TOOL_NAME } from "./tool-manager.js";

export { INITIATIVE_UPDATE_TOOL_NAME };

export interface InitiativeUpdateHost {
	/** The calling chat as the server knows it; a string = why it can't use the tool. */
	sender(): RoleMessageSender | string;
	feed(): ProgressFeed | undefined;
}

export interface InitiativeUpdateParams {
	action?: unknown;
	initiative?: unknown;
	page?: unknown;
	id?: unknown;
	changed?: unknown;
	next?: unknown;
	needs_you?: unknown;
	impact?: unknown;
	options?: unknown;
	until?: unknown;
	sources?: unknown;
}

export async function runInitiativeUpdate(
	host: InitiativeUpdateHost,
	p: InitiativeUpdateParams,
): Promise<{ text: string; details: Record<string, unknown> }> {
	const action = typeof p.action === "string" ? p.action.trim().toLowerCase() : "";
	const sender = host.sender();
	if (typeof sender === "string") throw new Error(sender);
	const feed = host.feed();
	if (!feed) throw new Error("The progress feed isn't available in this app.");
	const initiative = typeof p.initiative === "string" ? p.initiative.trim().toLowerCase() : "";
	if (!initiative) throw new Error('Give initiative: its short id (for example "team-in-temper").');
	if (action === "new") {
		const page = typeof p.page === "number" ? p.page : typeof p.page === "string" ? Number(p.page) : 1;
		const r = feed.newList(initiative, page);
		if (!r.ok) throw new Error(r.error);
		return { text: r.text, details: { action, initiative, pages: r.pages } };
	}
	if (action === "post") {
		const r = await feed.post(sender, { ...p, initiative });
		if (!r.ok) throw new Error(r.error);
		return { text: r.text, details: { action, initiative, id: r.id } };
	}
	if (action === "read") {
		const r = feed.read(initiative, typeof p.id === "string" && p.id.trim() ? p.id : undefined);
		if (!r.ok) throw new Error(r.error);
		return { text: r.text, details: { action, initiative } };
	}
	throw new Error('action must be "new", "post" or "read".');
}

export function makeInitiativeUpdateTool(host: InitiativeUpdateHost): ToolDefinition {
	return defineTool({
		name: INITIATIVE_UPDATE_TOOL_NAME,
		label: "Initiative update",
		description:
			"An initiative's progress feed on the Initiatives page, written by its lead (named by the owner) from the roles' records. new: what was filed since your last update, with ids, plus decisions and changes no update links yet and decisions missing impact, options or until. post (lead only): changed, next, needs_you; impact, options, until where the records hold them; sources = record (dr-…) and decision (d…, c…) ids, at least one. Say only what the linked records hold; never that the owner decided unless a linked record holds his words. Each update is checked against its sources; flags show on the page and come back to you. read: the latest updates (or id: one).",
		promptSnippet:
			"initiative_update: an initiative's progress feed: new (what's filed since your last update, with ids), post (the lead only, with sources), read",
		parameters: Type.Object({
			action: Type.String({ description: '"new", "post" or "read".' }),
			initiative: Type.String({ description: 'The initiative\'s short id (for example "team-in-temper").' }),
			page: Type.Optional(Type.Number({ description: "new: which page (default 1)." })),
			id: Type.Optional(Type.String({ description: "read: one update (dr-…) in full, with its sources." })),
			changed: Type.Optional(Type.String({ description: "post: what changed (about 1,500 characters at most)." })),
			next: Type.Optional(Type.String({ description: "post: what's next." })),
			needs_you: Type.Optional(
				Type.String({ description: "post: what needs the owner, one item per line (empty when nothing does)." }),
			),
			impact: Type.Optional(
				Type.String({ description: "post: the impact for the owner, only where the linked records hold it." }),
			),
			options: Type.Optional(
				Type.String({
					description: "post: the other options and their cost, only where the linked records hold them.",
				}),
			),
			until: Type.Optional(
				Type.String({ description: "post: until when it holds, only where the linked records hold it." }),
			),
			sources: Type.Optional(
				Type.Array(Type.String(), {
					description: "post: the ids of the records (dr-…) and decisions (d…, c…) it summarizes; at least one.",
				}),
			),
		}),
		execute: async (_id, p, _signal, _onUpdate, _ctx) => {
			const res = await runInitiativeUpdate(host, p as InitiativeUpdateParams);
			return { content: [{ type: "text", text: res.text }], details: res.details };
		},
	});
}
