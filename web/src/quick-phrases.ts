/**
 * 快捷短语内置默认值（按界面语言，与 i18n Locale 对齐；ja/ko/fr/de/es/ru/pt 为机器翻译占位）。
 *
 * 服务端对新客户端只给空列表（不知道浏览器语言），由 App 在首次看到空列表时
 * 按当前 locale seed 一次（见 App 的 seeding effect + isQuickSeeded，按浏览器
 * 全局只 seed 一次）；seed 后即为普通用户数据，可在设置里增删改、恢复默认、关闭。
 * 约束与服务端归一化对齐：
 * 单条 ≤200 字、最多 30 条、无空项无重名。
 */
import type { Locale } from "./i18n";

export const QUICK_PHRASE_DEFAULTS: Record<Locale, string[]> = {
	en: ["Continue", "Summarize", "Explain in detail", "Check and fix issues", "Add test coverage", "Publish release"],
};
