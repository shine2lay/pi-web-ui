/**
 * sent-by name label (Ops #1052; Shine 2026-11-20 via COO rm-a411465b: "instead of "You" it shows the
 * sender correctly"). A typed message's header names who sent it (its recorded `sentBy`), the same for
 * every viewer; a message with no recorded sender still reads "You".
 */
import { describe, expect, it } from "vitest";
import type { Translate } from "../../web/src/i18n.js";
import { messageRoleLabel, messageSender, roleLabel } from "../../web/src/message-role-label.js";

const t = ((key: string) => `<${key}>`) as Translate;
const WAI = { name: "Wai", login: "sayswai@gmail.com" };
const SHINE = { name: "Shine", login: "aungshine@gmail.com", owner: true as const };

describe("sent-by: the header names the sender", () => {
	it("a user message sent by Wai reads Wai; one sent by Shine reads Shine (not You)", () => {
		expect(messageRoleLabel({ role: "user", sentBy: WAI }, t)).toBe("Wai");
		expect(messageRoleLabel({ role: "user", sentBy: SHINE }, t)).toBe("Shine");
	});

	it("the sender's login is the tooltip", () => {
		expect(messageSender({ role: "user", sentBy: WAI })?.login).toBe("sayswai@gmail.com");
	});

	it("a user message with no recorded sender still reads You", () => {
		expect(messageRoleLabel({ role: "user" }, t)).toBe("<role.user>");
		expect(messageSender({ role: "user" })).toBeUndefined();
	});

	it("other roles keep their labels, even if a sender were attached", () => {
		expect(messageRoleLabel({ role: "assistant", sentBy: WAI }, t)).toBe("<role.assistant>");
		expect(messageRoleLabel({ role: "toolResult" }, t)).toBe("<role.tool>");
		expect(messageSender({ role: "assistant", sentBy: WAI })).toBeUndefined();
		expect(roleLabel("user", t)).toBe("<role.user>");
	});
});
