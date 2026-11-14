// Ops108's routing guard: these live files may change only with a re-pin that says no Ops108 routing line
// changed. Moved unchanged from tests/unit/roles-contact.test.ts ("Ops108 routing bytes are unchanged and nothing
// in production imports O0") by roles-inert-cleanup (2026-10-31), which removed the inert O0 modules that file
// tested; only the half about O0 importers and server/roles-contact.ts went with them.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("Ops108 baseline", () => {
	it("Ops108 routing bytes are unchanged", () => {
		const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
		// Re-pinned by roles-requester (owner 2026-10-17, Roles D2): it only adds display-only requester
		// collection (collectRequesterInput, RoleTurnRecord extends RequesterTurn); no Ops108 routing line
		// changed (its diff removes none). Was 4df90a6f….
		// Re-pinned by restart-requester (owner 2026-10-18, "The three bugs"; Ops #236): it only lets a carried-on
		// turn take the cut-off turn's saved requester inputs (RoleTurnInput.carried, display-only); its diff
		// changes just the requester import and the collectRequesterInput line, no Ops108 routing line
		// (causes, ids, forOwner, owner). Was db3c7c90….
		// Re-pinned by owner-question-coo (Ops #686): carry-on restores only checked host-generated oqc-UUID
		// receipt ids for COO's turn-end safety net. No Ops108 routing line changed: causes, forOwner,
		// owner and transport authority are untouched; receipt ids never grant those. Was 014cba7d….
		expect(sha("server/role-replies.ts")).toBe("9c68ca4aa85a3f44b852014d182227d3b1dcd57311aa79f1e420707f97d2b849");
		// Re-pinned by reconnect-trace (Ops #157, Ops decision on its plugin route): it only adds
		// host.connNotices (plugins.ts) and the reconnect-notice handler (telegram); no Ops108 routing line
		// changed (its diff removes none). Was b3f0f42f… and 9bd0faeb….
		// Re-pinned by roles-tracker (owner 2026-10-17, Roles D3): it only adds the display-only send result
		// host.roles.noteSent (plugins.ts) and its call after a reply's send (telegram); no Ops108 routing line
		// changed (its diff removes none). Was 94663529… and 7e7deac6….
		// Re-pinned by telegram-send (Ops #627, owner via Architecture rm-34a975b1): it only adds the
		// telegram_send tool and the "telegram:send" bus listener (telegram); its diff removes only the bridge
		// record `{ bridge, chat }` (now also carries the notice's client) and the unload's offSettings call
		// (now in one loop with the tool's and the listener's); no Ops108 routing line changed. Was 8875cff0….
		// Re-pinned by owner-question-wiring (Ops #685, owner via COO rm-fbbc87f6 and rm-79d1a979): it only adds the
		// ownerSeesAskEvent import and one line in host.asks.on that keeps an ask held for COO, and its held, released
		// and returned events, from plugins (with the switch off no ask is held, so every event goes out as before);
		// its diff removes no line; no Ops108 routing line changed. Was 553e809d….
		// Re-pinned by plugin-participant-routes conversationId (Ops #779, Backend rm-9025819f): it only adds
		// PluginParticipantRoute.conversationId (metadata, the id run events already carry) and passes it through
		// host.participantRoutes()'s field list; its diff removes only that list's destructuring line (now with the
		// field); no Ops108 routing line changed. Was ee2f3e0d….
		// Re-pinned by script-notify-cli (Ops #783, Systems rm-e2634da5): it only adds PluginManager.agentToolOf (one
		// plugin's registered agent tool by name, read-only, for the control socket's telegram_send); its diff removes
		// no line; no Ops108 routing line changed. Was b89c7f63….
		// Re-pinned by scheduler-fold-wake (Ops #788, owner via COO rm-efb868f4): it only adds PluginToolCallerContext
		// (conversationId, sessionFile, cwd, role) on PluginAgentTool.execute; no Ops108 routing line changed.
		// Was 1b94c3fe….
		// Re-pinned by showtell-owner-answer (Ops #883, COO rm-f03ad615): it only adds the optional host.ownerActions
		// (the owner front door, server/owner-front-door.ts) and PluginManager.ownerFrontDoor, and moves the proxy prefix
		// helpers unchanged to server/plugin-proxy.ts (imported back); no Ops108 routing line changed. Was f30f2f46….
		expect(sha("server/plugins.ts")).toBe("aec29bdbdf7f53a6180c4932cf64ce74ef20ca122cc718dd2705a9b676f1e50e");
		// Re-pinned by owner-card-brief (Ops #682, owner via COO rm-d2c1f9b2): it only adds the display-only
		// renderBrief and puts its lines first in renderAsk's message and short form; its diff removes only renderAsk's
		// doc comment and the two joined part lists (now with the brief); no Ops108 routing line changed. Was 91637612….
		// Re-pinned by grant-card-brief (Ops #683, owner via COO rm-d2c1f9b2): renderBrief, display only, shows the
		// brief of any card that has one (continuation-grant cards too), not only a stuck task's; its diff changes only
		// that line and renderBrief's doc comment; no Ops108 routing line changed. Was f33f4073….
		// Re-pinned by owner-question-wiring (Ops #685, owner via COO rm-fbbc87f6 and rm-79d1a979): it only adds the
		// display-only renderRoute (which way an ask came, COO's note and recommendation) and puts it after the head in
		// renderAsk's message; its diff removes only renderAsk's doc comment and its joined part list (now with the
		// route); no Ops108 routing line changed. Was af8c8cce….
		// Re-pinned by telegram-once (Ops #763, owner in Ops home chat 2026-11-03 ~00:15 PST): it only moves stuckTask
		// to plugins/telegram/question-identity.mjs, matches ask entries in createBridge by stable question identity across
		// restarts/chat reopens and silent unanswered repeats, and logs question identity hashes and notice sender/length;
		// no Ops108 routing line (replyMayGoToTelegram, createChat, onRoleTurnEnd) changed. Was 5a065c5c….
		expect(sha("plugins/telegram/index.mjs")).toBe("fc40ca098faeb854129dc948f70f123eae810487a83917363c92fad282ee9239");
	});
});
