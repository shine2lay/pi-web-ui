// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement, type ComponentProps, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react-dom/test-utils";
import { afterEach, describe, expect, it } from "vitest";
import type { UiSettingsState } from "../../server/protocol.js";
import { resetAppGlobals, setAppGlobals, setAppSend } from "../../web/src/app-globals.js";
import { ChatInput } from "../../web/src/components/ChatInput.js";
import { SettingsModal } from "../../web/src/components/SettingsModal.js";
import { LanguageProvider, en } from "../../web/src/i18n.js";
import { DEFAULT_SOUND_SETTINGS } from "../../web/src/sounds.js";
import { DEFAULT_TTS_SETTINGS } from "../../web/src/tts.js";

/**
 * no-quick-phrases (PATCHES.md): the phrase buttons above the message box and their Settings section
 * are gone from the page. The server still keeps and sends `quickPhrases` / `quickPhrasesEnabled`, so
 * these checks give the page settings that do have phrases and make sure nothing shows them.
 */

const PHRASES = ["Continue", "Summarize", "Explain in detail"];

const SETTINGS: UiSettingsState = {
	promptMode: "append",
	customSystemPrompt: "",
	promptTemplate: "",
	promptOverrides: {},
	disabledSkills: [],
	disabledExtensions: [],
	disabledAgentTools: [],
	disabledPluginTools: [],
	terminalToolsEnabled: true,
	terminalBash: false,
	terminalBashIdleMs: 0,
	terminalBashMaxForegroundMs: 0,
	toolWatchdogTimeoutMs: 0,
	readDirEnabled: true,
	editSoftEnabled: false,
	questionnaireEnabled: true,
	toolApprovalEnabled: false,
	approvalPolicy: { allowAll: false, categories: [] },
	approvalRules: [],
	parallelReminderEnabled: true,
	goalModeEnabled: true,
	thinkingWrap: true,
	toolsWrap: true,
	toolImagesEnabled: true,
	skillsFullText: [],
	visionBridgeEnabled: false,
	visionBridgeModel: null,
	visionBridgePromptMode: "append",
	visionBridgePrompt: "",
	scmCommitMsgPromptMode: "append",
	scmCommitMsgPrompt: "",
	reviewPrompt: "",
	reviewDisabledSkills: [],
	disabledPlugins: [],
	uiLayout: {},
	effectiveSystemPrompt: "",
	promptSourceDefaults: {},
	toolsSchema: "",
	visionBridgeDefaultPrompt: "",
	scmCommitMsgDefaultPrompt: "",
	visionModels: [],
	skills: [],
	reviewSkills: [],
	extensions: [],
	presets: [],
	markersEnabled: true,
	disabledMarkers: [],
	markers: [],
	subagentTemplates: [],
	subagentDefaultModel: null,
	retryMaxAttempts: 2,
	softCapTokens: 0,
	softCapByModel: {},
	quickPhrases: PHRASES,
	quickPhrasesEnabled: true,
	quickPhrasesSeeded: true,
	subagentModels: [],
	subagentDefaultTemplates: [],
};

let root: Root | null = null;

function render(el: ReactElement) {
	const container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container);
	act(() => {
		root!.render(createElement(LanguageProvider, null, el));
	});
	return container;
}

function buttonTexts(scope: ParentNode) {
	return [...scope.querySelectorAll("button")].map((b) => (b.textContent ?? "").trim());
}

afterEach(() => {
	resetAppGlobals();
	setAppSend(null);
	if (root) {
		act(() => root!.unmount());
		root = null;
	}
	document.body.innerHTML = "";
});

describe("no-quick-phrases", () => {
	it("the message box shows no phrase row, even when the settings have phrases", () => {
		setAppGlobals({ ready: true });
		setAppSend(() => true);
		// App no longer passes phrases; pass them anyway, the way an old caller or a sync might.
		const props = {
			streaming: false,
			messages: [],
			slashCommands: [],
			modelState: null,
			models: [],
			modelsLoading: false,
			attachments: [],
			onRemoveAttachment: () => {},
			onAddImageFiles: () => {},
			onAddLocalFiles: () => {},
			onNotice: () => {},
			onSent: () => {},
			onManageModels: () => {},
			providerKeys: {},
			quickPhrases: PHRASES,
			quickPhrasesEnabled: true,
		} as unknown as ComponentProps<typeof ChatInput>;
		const c = render(createElement(ChatInput, props));

		expect(c.querySelector(".inputbox"), "the message box is there").not.toBeNull();
		expect(c.querySelector(".quick-row")).toBeNull();
		expect(c.querySelector(".quick-chip")).toBeNull();
		const texts = buttonTexts(document.body);
		for (const p of PHRASES) expect(texts).not.toContain(p);
	});

	it("Settings has no Quick phrases section, even when the settings have phrases", () => {
		// jsdom has no layout, so Settings' scroll calls need something to call.
		Element.prototype.scrollTo = () => {};
		Element.prototype.scrollIntoView = () => {};
		setAppGlobals({ ready: true });
		setAppSend(() => true);
		render(
			createElement(SettingsModal, {
				chat: {
					settings: SETTINGS,
					plugins: [],
					pluginCatalog: [],
					pluginJobs: {},
					catalogSync: null,
					installInspect: null,
					pluginsEpoch: 0,
					pluginGrants: [],
					pluginPermissions: [],
					dshPatches: null,
					dshPresets: null,
					dshPermission: null,
					terminals: [],
					state: null,
					activeConversationId: null,
					schedulerTasks: [],
				},
				terminal: { create: () => {}, restart: () => {}, select: () => {} },
				onSwitchToTerminal: () => {},
				onClose: () => {},
				sound: DEFAULT_SOUND_SETTINGS,
				onSoundChange: () => {},
				tts: DEFAULT_TTS_SETTINGS,
				onTtsChange: () => {},
			}),
		);

		const tabs = [...document.body.querySelectorAll(".settings-tab")].map((el) => el.getAttribute("data-tab"));
		expect(tabs, "the list of sections is there").toContain("display");
		expect(tabs).toContain("sound");
		expect(tabs).not.toContain("quick");
		expect(document.body.textContent).not.toContain("Quick phrases");
		// The section's words are gone from the word list as well.
		expect(Object.keys(en).filter((k) => k.startsWith("quickPhrases"))).toEqual([]);
	});

	it("the page never fills in default phrases", () => {
		// The seeding effect in App.tsx sent `quickPhrases` + `quickPhrasesSeeded`; nothing in the page does now.
		const app = readFileSync(join(__dirname, "..", "..", "web", "src", "App.tsx"), "utf8");
		expect(app).not.toMatch(/quickPhrases|QUICK_PHRASE/);
	});
});
