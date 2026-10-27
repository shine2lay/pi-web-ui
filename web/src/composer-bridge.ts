/// <reference lib="dom" />
/**
 * 输入框注入桥 —— 宿主把内容**放进输入框草稿**的反向通道。
 *
 * 与 plugin-host.ts 的分工：那边是「新建对话并把一段话直接发出去」（startChat）；
 * 这里解决另一半：把外部拾取 / 生成的内容塞进输入框，**让用户补一句话再自己发**。
 * 第一个用户是浏览器元素拾取扩展（plugins/page-picker）：在开发网页上选元素 →
 * 渲染成 Markdown → 注入 pi-web-ui 输入框 → 用户补「这三处间距不一致」再发。
 *
 * 为什么要 sink 注册：草稿文本在 ChatInput 内部 state（text），待发附件在 App state
 * （attachments），两处各自在自己挂载时注册自己那一半。宿主侧只认这一个模块级入口，
 * 不关心谁实现。
 *
 * 与 app-globals 的纪律一致：这里只放**跨边界动作**，不放状态、不吃快照流
 * （store 通知会绕过 memo）。
 */

import type { DraftAttachment } from "./composer-draft";
import { composerRecovery } from "./recovery-composer";

/** 注入内容。 */
export interface ComposerPayload {
	/** 要并入输入框的文本（空 / 全空白 = 只加附件）。 */
	text?: string;
	/** 要追加到待发附件的项（如元素截图）。 */
	attachments?: DraftAttachment[];
}

/** 文本 sink：ChatInput 挂载时注册（自己决定怎么并入，见 mergeRecalledDraft）。 */
type DraftSink = (text: string) => void;
/** 附件 sink：App 挂载时注册（自己决定怎么追加，见 appendDraftAttachments）。 */
type AttachmentSink = (items: DraftAttachment[]) => void;
/** 聚焦 sink：ChatInput 挂载时注册。 */
type FocusSink = () => void;

let draftSink: DraftSink | null = null;
let attachmentSink: AttachmentSink | null = null;
let focusSink: FocusSink | null = null;
let insertSink: ((text: string) => void) | null = null;
let removeMentionSink: ((mention: string) => void) | null = null;

export function registerInsertSink(fn: ((text: string) => void) | null): void {
	insertSink = fn;
}

export function registerRemoveMentionSink(fn: ((mention: string) => void) | null): void {
	removeMentionSink = fn;
}

export function insertTextAtCursor(text: string): boolean {
	if (!insertSink) return false;
	insertSink(text);
	return true;
}

export function removeMentionFromComposer(mention: string): boolean {
	if (!removeMentionSink) return false;
	removeMentionSink(mention);
	return true;
}

/** ChatInput 注册 / 注销（传 null）文本那一半。可重复调用，后注册的覆盖先前的。 */
export function registerDraftSink(fn: DraftSink | null): void {
	draftSink = fn;
}

/** App 注册 / 注销（传 null）附件那一半。 */
export function registerAttachmentSink(fn: AttachmentSink | null): void {
	attachmentSink = fn;
}

/** ChatInput 注册 / 注销（传 null）聚焦 sink。 */
export function registerFocusSink(fn: FocusSink | null): void {
	focusSink = fn;
}

/** 触发输入框聚焦。返回是否有输入框响应。 */
export function focusComposer(): boolean {
	if (!focusSink) return false;
	focusSink();
	return true;
}

/** 有没有输入框在听（页面还没挂载好 = false，宿主该拒收而不是静默丢）。 */
export function isComposerReady(): boolean {
	return composerRecovery().ready();
}

/** 仅供单测：清掉注册表（避免用例之间互相串）。 */
export function resetComposerSinks(): void {
	draftSink = null;
	attachmentSink = null;
	focusSink = null;
	insertSink = null;
	removeMentionSink = null;
}

/** Synchronous boolean compatibility; exact true follows a complete checkpoint AND
 * one owned full-draft placement. Legacy half-sinks are never a recovery fallback. */
export function composeToComposer(payload: ComposerPayload): boolean {
	return composerRecovery().compose(payload);
}
