/**
 * effort-level-button (PATCHES.md): when the window asks for a chat's levels. A new socket replays the page's
 * startup commands first, and the server refuses anything sent during that replay ("A startup command was not
 * processed"), so an ask then was lost and the button never showed. The window asks only once the session is
 * initialized, and asks again for the chat it shows at that moment.
 */
import { afterEach, describe, expect, it } from "vitest";
import { setAppSend } from "../../web/src/app-globals";
import { effortLevelsSession, showEffortLevelsChat } from "../../web/src/effort-level-state";
import type { ClientMessage } from "../../web/src/types";

function capture(): ClientMessage[] {
	const sent: ClientMessage[] = [];
	setAppSend((m) => {
		sent.push(m);
		return true;
	});
	return sent;
}
const asks = (sent: ClientMessage[]) =>
	sent.filter((m) => m.type === "get_effort_levels").map((m) => (m as { conversationId: string }).conversationId);

afterEach(() => {
	setAppSend(null);
	showEffortLevelsChat(undefined);
	effortLevelsSession(false);
});

describe("effort levels: when the window asks", () => {
	it("asks nothing while a new socket's startup commands replay", () => {
		const sent = capture();
		effortLevelsSession(false);
		showEffortLevelsChat("c1");
		showEffortLevelsChat("c2");
		expect(asks(sent)).toEqual([]);
	});

	it("asks for the chat shown once the session is initialized", () => {
		const sent = capture();
		effortLevelsSession(false);
		showEffortLevelsChat("c1");
		showEffortLevelsChat("c2");
		effortLevelsSession(true);
		expect(asks(sent)).toEqual(["c2"]);
	});

	it("asks at once when the chat changes on an initialized session", () => {
		const sent = capture();
		effortLevelsSession(true);
		showEffortLevelsChat("c3");
		showEffortLevelsChat("c3");
		showEffortLevelsChat("c4");
		expect(asks(sent)).toEqual(["c3", "c4"]);
	});

	it("asks again after a reconnect, only once it is initialized again", () => {
		const sent = capture();
		effortLevelsSession(true);
		showEffortLevelsChat("c5");
		effortLevelsSession(false);
		expect(asks(sent)).toEqual(["c5"]);
		effortLevelsSession(true);
		expect(asks(sent)).toEqual(["c5", "c5"]);
	});

	it("asks nothing when no chat is shown", () => {
		const sent = capture();
		effortLevelsSession(true);
		expect(asks(sent)).toEqual([]);
	});
});
