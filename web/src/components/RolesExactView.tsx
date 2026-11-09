import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppField } from "../app-globals";
import { liveVisibleAt, subscribePageLive } from "../page-live";
import { resolveQuestionAction, type NativeDialogSummary } from "../roles-answer-actions";
import { projectExactRoles } from "../roles-exact-model";
import { createExactRolesView } from "../roles-exact-view";
import { acknowledgeRenderedRolesUsage, reloadRoles, useRoles } from "../roles-state";
import { bindRolesSurface, prepareRolesDocument, type FontBytes } from "../roles-u0/surface";
import type { NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import { useEscapeKey } from "../shortcut-stack";
import {
	buildLiveTasksRolesV8Dataset,
	createReferenceDataset,
	mountTasksRolesV8Surface,
	PAGE_SIZE,
	type MountedTasksRolesV8Controller,
} from "../tasks-roles-v8";
import { reloadWorkPage, useWorkPage } from "../work-page-state";
import { RoleAnswerDialog } from "./RoleAnswerDialog";

/** The real update/refit completion seam, also exercised with a synthetic bound DOM. */
export function updateRolesUsageDOM(
	binding: { update(): void } | null,
	refit: () => boolean,
	finished: () => void,
): void {
	if (!binding) return;
	binding.update();
	for (let pass = 0; pass < 3 && refit(); pass++) binding.update();
	finished();
}

function detectInitialTheme(): "dark" | "light" {
	if (typeof document === "undefined") return "dark";
	const attr = document.documentElement.getAttribute("data-theme");
	return attr === "light" ? "light" : "dark";
}

function shouldUseReferenceDataset(): boolean {
	if (typeof window === "undefined") return false;
	try {
		const params = new URLSearchParams(window.location.search);
		return params.get("v8dataset") === "reference";
	} catch {
		return false;
	}
}

export interface RolesExactViewProps {
	active: boolean;
	dialogs?: readonly NativeDialogSummary[];
	fonts?: FontBytes;
	onOpen: (target: UsefulOpenTarget) => void;
	onAbout: (roleId: string) => void;
}

/**
 * Live Roles surface (v8 Tasks & Roles rework).
 * When explicit `fonts` bytes are passed by legacy font/iframe tests, preserves the iframe seam;
 * in live execution (`fonts === undefined`), mounts `web/src/tasks-roles-v8/` directly.
 */
export function RolesExactView(props: RolesExactViewProps) {
	if (props.fonts !== undefined) {
		return <RolesLegacyFontsFrame {...props} fonts={props.fonts} />;
	}
	return <RolesV8Surface {...props} />;
}

function RolesV8Surface({ active, dialogs = [], onOpen, onAbout }: RolesExactViewProps) {
	const state = useRoles(active ? "full" : "off");
	const work = useWorkPage(active);
	const connection = useAppField("status");
	const [now, setNow] = useState(() => Date.now());
	const [answer, setAnswer] = useState<{ item: NeedsYouItem; from: HTMLElement } | null>(null);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const controllerRef = useRef<MountedTasksRolesV8Controller | null>(null);

	const visibleAt = useSyncExternalStore(subscribePageLive, liveVisibleAt, liveVisibleAt);
	const model = useMemo(
		() => projectExactRoles(state, connection, now, { visibleAt }),
		[state, connection, now, visibleAt],
	);

	const useRefData = shouldUseReferenceDataset();
	const adapted = useMemo(() => {
		if (useRefData) {
			return {
				dataset: createReferenceDataset(),
				mode: "normal" as const,
				asksByTaskId: new Map(),
				chatByTaskId: new Map(),
				chatByRoleId: new Map(),
				tasksById: new Map(),
			};
		}
		return buildLiveTasksRolesV8Dataset({
			rolesState: state,
			workState: work,
			now,
		});
	}, [useRefData, state, work, now]);

	const current = useRef({ model, state, adapted, active, connection, onOpen, onAbout, dialogs });
	current.current = { model, state, adapted, active, connection, onOpen, onAbout, dialogs };

	useEscapeKey(
		() => {
			controllerRef.current?.closeTopOverlay();
		},
		active && overlayOpen && answer === null,
	);

	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active, visibleAt]);

	const graceUntil = model.graceUntil;
	useEffect(() => {
		if (!active || graceUntil === null) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, graceUntil - Date.now()) + 20);
		return () => clearTimeout(timer);
	}, [active, graceUntil]);

	useEffect(() => {
		if (!active) {
			setAnswer(null);
			controllerRef.current?.closeTopOverlay();
		}
	}, [active]);

	useEffect(() => {
		const container = host.current;
		if (!container) return;
		const initialAdapted = current.current.adapted;

		const ctrl = mountTasksRolesV8Surface(container, {
			initialState: {
				page: "initiatives",
				theme: detectInitialTheme(),
				mode: initialAdapted.mode,
				currentPage: 1,
				pageSize: PAGE_SIZE,
			},
			dataset: initialAdapted.dataset,
			syncDocumentTheme: true,
			showPrototypeChrome: useRefData,
			exposeWindowGlobals: true,
			onPageChange: () => {
				const panel = container.querySelector<HTMLElement>(".unified-tasks-panel");
				if (panel && typeof panel.scrollIntoView === "function") {
					panel.scrollIntoView({ block: "nearest" });
				}
			},
			onOpenChat: (chatFile) => {
				const cur = current.current;
				const matchTask = cur.adapted.dataset.tasks.find((t) => t.chat?.file === chatFile);
				const target = (matchTask ? cur.adapted.chatByTaskId.get(matchTask.id) : undefined) ?? { file: chatFile };
				cur.onOpen(target);
			},
			onAnswerQuestion: (taskId, _choice) => {
				const cur = current.current;
				const task = cur.adapted.dataset.tasks.find((t) => t.id === taskId);
				const matchNeed =
					cur.model.needs.items.find((n) => n.link?.focus?.id === String(taskId) || n.key.endsWith(`:${taskId}`)) ??
					(task ? cur.model.needs.items.find((n) => n.roleId === task.role) : undefined);
				const fromEl = document.activeElement instanceof HTMLElement ? document.activeElement : container;
				if (matchNeed) {
					const inlineResolved = resolveQuestionAction(cur.model.needs, matchNeed, cur.dialogs, "inline");
					if (inlineResolved) {
						setAnswer({ item: inlineResolved.item, from: fromEl });
						return;
					}
					const chatResolved = resolveQuestionAction(cur.model.needs, matchNeed, cur.dialogs, "chat");
					if (chatResolved && chatResolved.action.kind === "chat") {
						cur.onOpen(chatResolved.action.target);
						return;
					}
				}
				const fallbackChat = cur.adapted.chatByTaskId.get(taskId) ?? (task?.chat ? { file: task.chat.file } : null);
				if (fallbackChat) {
					cur.onOpen(fallbackChat);
				}
			},
			onRetryLoad: () => {
				reloadRoles();
				reloadWorkPage();
			},
			onOverlayChange: (open) => {
				setOverlayOpen(open);
			},
		});
		controllerRef.current = ctrl;
		return () => {
			controllerRef.current = null;
			ctrl.destroy();
		};
	}, [useRefData]);

	useEffect(() => {
		const ctrl = controllerRef.current;
		if (!ctrl) return;
		ctrl.setDataset(adapted.dataset);
		const urlMode =
			typeof window !== "undefined" && window.location?.search
				? new URLSearchParams(window.location.search).get("mode")
				: null;
		const prevState = ctrl.getState();
		const patch: Partial<ReturnType<MountedTasksRolesV8Controller["getState"]>> = {};
		if (!urlMode && prevState.mode !== adapted.mode && (prevState.mode === "loading" || adapted.mode === "normal")) {
			patch.mode = adapted.mode;
		}
		if (Object.keys(patch).length > 0) {
			ctrl.setState(patch);
		}
	}, [adapted, useRefData]);

	return (
		<>
			<div
				ref={host}
				className="roles-exact-host"
				onClick={(ev) => {
					const target = ev.target instanceof HTMLElement ? ev.target : null;
					const prevBtn = target?.closest<HTMLButtonElement>("[data-page-prev]");
					if (prevBtn && !prevBtn.disabled && controllerRef.current) {
						const nextPage = Number(prevBtn.getAttribute("data-page-prev"));
						if (
							Number.isFinite(nextPage) &&
							nextPage >= 1 &&
							controllerRef.current.getState().currentPage !== nextPage
						) {
							controllerRef.current.setState({ currentPage: Math.floor(nextPage) });
						}
						return;
					}
					const nextBtn = target?.closest<HTMLButtonElement>("[data-page-next]");
					if (nextBtn && !nextBtn.disabled && controllerRef.current) {
						const nextPage = Number(nextBtn.getAttribute("data-page-next"));
						if (
							Number.isFinite(nextPage) &&
							nextPage >= 1 &&
							controllerRef.current.getState().currentPage !== nextPage
						) {
							controllerRef.current.setState({ currentPage: Math.floor(nextPage) });
						}
					}
				}}
				style={{
					width: "100%",
					height: "100%",
					minHeight: 0,
					overflowY: "auto",
					overflowX: "hidden",
					background: "var(--bg-canvas, #0E0F11)",
				}}
			/>
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

function RolesLegacyFontsFrame({
	active,
	dialogs = [],
	fonts,
	onOpen,
	onAbout,
}: RolesExactViewProps & { fonts: FontBytes }) {
	const state = useRoles(active ? "full" : "off");
	const connection = useAppField("status");
	const [now, setNow] = useState(() => Date.now());
	const [failed, setFailed] = useState(false);
	const [answer, setAnswer] = useState<{ item: NeedsYouItem; from: HTMLElement } | null>(null);
	const host = useRef<HTMLDivElement>(null);
	const visibleAt = useSyncExternalStore(subscribePageLive, liveVisibleAt, liveVisibleAt);
	const model = useMemo(
		() => projectExactRoles(state, connection, now, { visibleAt }),
		[state, connection, now, visibleAt],
	);
	const current = useRef({ model, state, active, connection, onOpen, onAbout, dialogs });
	current.current = { model, state, active, connection, onOpen, onAbout, dialogs };
	const redraw = useRef<(() => void) | null>(null);
	const hide = useRef<(() => void) | null>(null);
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const timer = setInterval(() => setNow(Date.now()), 30_000);
		return () => clearInterval(timer);
	}, [active, visibleAt]);
	const graceUntil = model.graceUntil;
	useEffect(() => {
		if (!active || graceUntil === null) return;
		const timer = setTimeout(() => setNow(Date.now()), Math.max(0, graceUntil - Date.now()) + 20);
		return () => clearTimeout(timer);
	}, [active, graceUntil]);
	useEffect(() => {
		redraw.current?.();
	}, [model, active, connection, dialogs]);
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
			const narrow = typeof window.matchMedia === "function" ? window.matchMedia("(max-width: 1023.98px)") : null;
			let binding: ReturnType<typeof bindRolesSurface> | null = null;
			const update = () => {
				if (disposed || queued !== null) return;
				queued = window.requestAnimationFrame(() => {
					queued = null;
					if (disposed) return;
					try {
						updateRolesUsageDOM(
							binding,
							() => view.refit(),
							() => {
								for (const link of doc.querySelectorAll<HTMLAnchorElement>('a[href^="#exact-route:"]')) {
									const enabled = view.canNavigate((link.getAttribute("href") ?? "").slice("#exact-route:".length));
									link.setAttribute("aria-disabled", String(!enabled));
									link.tabIndex = enabled ? 0 : -1;
									link.style.opacity = enabled ? "1" : "0.45";
								}
								const open = view.isOpen();
								if (open && !wasOpen) doc.querySelector<HTMLButtonElement>('[role="region"] button')?.focus();
								wasOpen = open;
								const rendered = current.current;
								if (
									disposed ||
									!rendered.active ||
									rendered.connection !== "open" ||
									!frame.isConnected ||
									document.visibilityState !== "visible" ||
									!rendered.state.overview
								)
									return;
								acknowledgeRenderedRolesUsage(rendered.state.overview, view.usageRenderCandidates());
							},
						);
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
					dialogs: () => current.current.dialogs,
					reload: reloadRoles,
				},
				{
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
			update();
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
