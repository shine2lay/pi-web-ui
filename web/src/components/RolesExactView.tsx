import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppField } from "../app-globals";
import { liveVisibleAt, subscribePageLive } from "../page-live";
import { exactRolesFonts } from "../roles-exact-fonts";
import { projectExactRoles } from "../roles-exact-model";
import { createExactRolesView } from "../roles-exact-view";
import { reloadRoles, useRoles } from "../roles-state";
import { bindRolesSurface, prepareRolesDocument, type FontBytes } from "../roles-u0/surface";
import type { NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import { RoleAnswerDialog } from "./RoleAnswerDialog";

/** The actual Roles surface, not a preview. The supplied template is isolated from app themes;
 * data comes from the existing safe projections, never the design's fictional example records.
 * Exact, approved font bytes are a dependency of mounting, not a silent system-font substitution.
 */
export function RolesExactView({
	active,
	fonts = exactRolesFonts,
	onOpen,
	onAbout,
}: {
	active: boolean;
	fonts?: FontBytes;
	onOpen: (target: UsefulOpenTarget) => void;
	onAbout: (roleId: string) => void;
}) {
	const state = useRoles(active ? "full" : "off");
	const connection = useAppField("status");
	const [now, setNow] = useState(() => Date.now());
	const [failed, setFailed] = useState(false);
	const [answer, setAnswer] = useState<{ item: NeedsYouItem; from: HTMLElement } | null>(null);
	const host = useRef<HTMLDivElement>(null);
	// pages-live: an alarm waits for fresh data, counted in visible time from when the tab came back.
	const visibleAt = useSyncExternalStore(subscribePageLive, liveVisibleAt, liveVisibleAt);
	const model = useMemo(
		() => projectExactRoles(state, connection, now, { visibleAt }),
		[state, connection, now, visibleAt],
	);
	const current = useRef({ model, onOpen, onAbout });
	current.current = { model, onOpen, onAbout };
	const redraw = useRef<(() => void) | null>(null);
	const hide = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active, visibleAt]);
	// pages-live: look again the moment the "Updating" wait ends (its alarm shows then if no check came).
	const graceUntil = model.graceUntil;
	useEffect(() => {
		if (!active || graceUntil === null) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, graceUntil - Date.now()) + 20);
		return () => clearTimeout(timer);
	}, [active, graceUntil]);
	useEffect(() => {
		redraw.current?.();
	}, [model]);
	useEffect(() => {
		if (!active) {
			hide.current?.();
			setAnswer(null);
		}
	}, [active]);
	useEffect(() => {
		const container = host.current;
		if (!container) return;
		setFailed(false);
		let disposed = false;
		let release: (() => void) | null = null;
		const frame = document.createElement("iframe");
		frame.title = "Roles";
		frame.setAttribute("sandbox", "allow-same-origin");
		frame.referrerPolicy = "no-referrer";
		frame.style.cssText = "display:block;width:100%;height:100%;border:0";
		container.appendChild(frame);
		const fail = () => {
			if (disposed) return;
			release?.();
			release = null;
			frame.remove();
			setAnswer(null);
			setFailed(true);
		};
		async function mount() {
			const doc = frame.contentDocument;
			const win = frame.contentWindow;
			if (!doc || !win) throw new Error("Roles frame unavailable");
			doc.open();
			doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8"></head><body></body></html>');
			doc.close();
			await prepareRolesDocument(doc, fonts);
			if (disposed) return;
			let queued: number | null = null;
			let wasOpen = false;
			// roles-phone: below 1024 px of the app's viewport the cards stack in one column.
			const narrow = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1023.98px)") : null;
			let binding: ReturnType<typeof bindRolesSurface> | null = null;
			const update = () => {
				if (disposed || queued !== null) return;
				queued = window.requestAnimationFrame(() => {
					queued = null;
					if (disposed) return;
					try {
						binding?.update();
						// roles-small-fixes: the header or graph changed size while the values were applied; plan again before paint.
						for (let pass = 0; pass < 3 && view.refit(); pass++) binding?.update();
						for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href^="#exact-route:"]')) {
							const enabled = view.canNavigate((link.getAttribute("href") ?? "").slice("#exact-route:".length));
							link.setAttribute("aria-disabled", String(!enabled));
							link.tabIndex = enabled ? 0 : -1;
							link.style.opacity = enabled ? "1" : "0.45";
						}
						const open = view.isOpen();
						if (open && !wasOpen) doc.querySelector<HTMLButtonElement>('[role="region"] button')?.focus();
						wasOpen = open;
					} catch {
						fail();
					}
				});
			};
			const view = createExactRolesView(
				() => current.current.model,
				{
					open: (target) => current.current.onOpen(target),
					about: (id) => current.current.onAbout(id),
					answer: (item, from) => setAnswer({ item, from }),
					reload: reloadRoles,
				},
				{
					// The host owns execution; script-disabled child timers cannot settle the panel.
					raf: (fn) => window.requestAnimationFrame(fn),
					cancelRaf: (id) => window.cancelAnimationFrame(id as number),
					setTimeout: (fn, ms) => window.setTimeout(fn, ms),
					clearTimeout: (id) => window.clearTimeout(id as number),
				},
				update,
				() => narrow?.matches === true,
			);
			try {
				binding = bindRolesSurface(doc, () => view.values());
			} catch (error) {
				view.dispose();
				if (queued !== null) window.cancelAnimationFrame(queued);
				throw error;
			}
			const click = (event: MouseEvent) => {
				const element = event.target as Element | null;
				const link = element?.closest?.('a[href^="#exact-route:"]');
				if (!link) return;
				event.preventDefault();
				view.navigate((link.getAttribute("href") ?? "").slice("#exact-route:".length));
			};
			const key = (event: KeyboardEvent) => {
				if (!view.isOpen()) return;
				if (event.key === "Escape") {
					event.preventDefault();
					view.close(false, true);
					return;
				}
				if (event.key !== "Tab") return;
				const region = doc.querySelector('[role="region"]');
				const controls = Array.from(
					region?.querySelectorAll<HTMLElement>(
						'button:not([disabled]), a[href]:not([aria-disabled="true"]), [tabindex="0"]',
					) ?? [],
				);
				const first = controls[0],
					last = controls[controls.length - 1];
				if (!first || !last) return;
				if (event.shiftKey && (doc.activeElement === first || !region?.contains(doc.activeElement))) {
					event.preventDefault();
					last.focus();
				} else if (!event.shiftKey && (doc.activeElement === last || !region?.contains(doc.activeElement))) {
					event.preventDefault();
					first.focus();
				}
			};
			// Host-owned observation also catches a warning appearing or a status line wrapping.
			const chrome = doc.querySelector("[data-roles-chrome]");
			const chromeObserver = chrome && typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
			if (chrome) chromeObserver?.observe(chrome);
			doc.addEventListener("click", click);
			doc.addEventListener("keydown", key);
			win.addEventListener("resize", update);
			narrow?.addEventListener("change", update);
			redraw.current = update;
			hide.current = () => view.close(true);
			release = () => {
				if (queued !== null) window.cancelAnimationFrame(queued);
				redraw.current = null;
				hide.current = null;
				chromeObserver?.disconnect();
				doc.removeEventListener("click", click);
				doc.removeEventListener("keydown", key);
				win.removeEventListener("resize", update);
				narrow?.removeEventListener("change", update);
				view.dispose();
				binding?.dispose();
			};
		}
		void mount().catch(fail);
		return () => {
			disposed = true;
			release?.();
			frame.remove();
		};
	}, [fonts]);
	return (
		<>
			<div ref={host} style={{ width: "100%", height: "100%", minHeight: 0 }}>
				{failed && (
					<p role="alert">
						The exact Roles surface could not be loaded. No fallback design or sample data has been substituted.
					</p>
				)}
			</div>
			{active && answer && (
				<RoleAnswerDialog
					item={answer.item}
					needs={model.needs}
					connected={connection === "open"}
					onOpen={onOpen}
					onClose={(back) => {
						const from = answer.from;
						setAnswer(null);
						if (back && from.isConnected)
							requestAnimationFrame(() => {
								if (from.isConnected) from.focus();
							});
					}}
				/>
			)}
		</>
	);
}
