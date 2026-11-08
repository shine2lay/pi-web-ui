import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppField } from "../app-globals";
import type {
	InitiativesExactAnswerTarget,
	InitiativesExactInput,
	InitiativesExactTarget,
} from "../initiatives-exact-model";
import { createInitiativesExactView, type InitiativesExactActions } from "../initiatives-exact-view";
import {
	bindInitiativesSurface,
	prepareInitiativesDocument,
	type InitiativeFontBytes,
} from "../initiatives-u0/surface";
import { liveVisibleAt, subscribePageLive } from "../page-live";
import { resolveQuestionAction, type NativeDialogSummary } from "../roles-answer-actions";
import { projectExactRoles } from "../roles-exact-model";
import { reloadRoles, useRoles } from "../roles-state";
import type { NeedsYouItem, UsefulOpenTarget } from "../roles-useful-model";
import { useEscapeKey } from "../shortcut-stack";
import type { WorkPageFeed } from "../initiatives-page/model";
import {
	buildLiveTasksRolesV8Dataset,
	createReferenceDataset,
	mountTasksRolesV8Surface,
	type MountedTasksRolesV8Controller,
} from "../tasks-roles-v8";
import { reloadWorkPage, useWorkPage } from "../work-page-state";
import { RoleAnswerDialog } from "./RoleAnswerDialog";

export interface InitiativesExactViewProps {
	/** False while the page is hidden: no redraws until it shows again. */
	active?: boolean;
	input: InitiativesExactInput;
	work?: WorkPageFeed;
	dialogs?: readonly NativeDialogSummary[];
	fonts?: InitiativeFontBytes;
	onOpen: (target: InitiativesExactTarget) => void;
	onOpenChat?: (target: UsefulOpenTarget) => void;
	onRetry: () => void;
	/** Each optional handler's control is shown only when the handler is given. */
	onChangeLead?: (initiative: string) => void;
	onMessageLead?: (initiative: string) => void;
	onNewInitiative?: () => void;
	onResume?: (initiative: string) => void;
	onMarkRead?: (initiative: string) => void;
	onAskDesign?: (initiative: string) => void;
	onAnswer?: (target: InitiativesExactAnswerTarget, choice: string) => void;
	/** initiatives-page: the owner picked an initiative or the "in no initiative" box. */
	onSelect?: (id: string) => void;
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

/**
 * Live Initiatives surface (v8 Tasks & Roles rework).
 * When explicit `fonts` bytes are passed by legacy font/iframe tests, preserves the iframe seam;
 * in live execution (`fonts === undefined`), mounts `web/src/tasks-roles-v8/` directly.
 */
export function InitiativesExactView(props: InitiativesExactViewProps) {
	if (props.fonts !== undefined) {
		return <InitiativesLegacyFontsFrame {...props} fonts={props.fonts} />;
	}
	return <InitiativesV8Surface {...props} />;
}

function InitiativesV8Surface(props: InitiativesExactViewProps) {
	const { active = true, dialogs = [] } = props;
	const rolesState = useRoles(active ? "full" : "off");
	const workHook = useWorkPage(active);
	const workState = props.work ?? workHook;
	const connection = useAppField("status");
	const [now, setNow] = useState(() => Date.now());
	const [answer, setAnswer] = useState<{ item: NeedsYouItem; from: HTMLElement } | null>(null);
	const [overlayOpen, setOverlayOpen] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const controllerRef = useRef<MountedTasksRolesV8Controller | null>(null);

	const visibleAt = useSyncExternalStore(subscribePageLive, liveVisibleAt, liveVisibleAt);
	const rolesModel = useMemo(
		() => projectExactRoles(rolesState, connection, now, { visibleAt }),
		[rolesState, connection, now, visibleAt],
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
			rolesState,
			workState,
			exactInput: props.input,
			now,
		});
	}, [useRefData, rolesState, workState, props.input, now]);

	const current = useRef({ props, rolesModel, adapted, active, connection, dialogs });
	current.current = { props, rolesModel, adapted, active, connection, dialogs };

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
			},
			dataset: initialAdapted.dataset,
			syncDocumentTheme: true,
			exposeWindowGlobals: true,
			onOpenChat: (chatFile) => {
				const cur = current.current;
				const matchTask = cur.adapted.dataset.tasks.find((t) => t.chat?.file === chatFile);
				const target = (matchTask ? cur.adapted.chatByTaskId.get(matchTask.id) : undefined) ?? { file: chatFile };
				if (cur.props.onOpenChat) {
					cur.props.onOpenChat(target);
				} else {
					cur.props.onOpen({
						kind: "source",
						initiative: matchTask?.initiative ?? matchTask?.tags?.[0] ?? "general",
						ref: chatFile,
					});
				}
			},
			onAnswerQuestion: (taskId, choice) => {
				const cur = current.current;
				const task = cur.adapted.dataset.tasks.find((t) => t.id === taskId);
				const matchNeed =
					cur.rolesModel.needs.items.find(
						(n) => n.link?.focus?.id === String(taskId) || n.key.endsWith(`:${taskId}`),
					) ?? (task ? cur.rolesModel.needs.items.find((n) => n.roleId === task.role) : undefined);
				const fromEl = document.activeElement instanceof HTMLElement ? document.activeElement : container;
				if (matchNeed) {
					const inlineResolved = resolveQuestionAction(cur.rolesModel.needs, matchNeed, cur.dialogs, "inline");
					if (inlineResolved) {
						setAnswer({ item: inlineResolved.item, from: fromEl });
						return;
					}
					const chatResolved = resolveQuestionAction(cur.rolesModel.needs, matchNeed, cur.dialogs, "chat");
					if (chatResolved && chatResolved.action.kind === "chat" && cur.props.onOpenChat) {
						cur.props.onOpenChat(chatResolved.action.target);
						return;
					}
				}
				if (cur.props.onAnswer) {
					cur.props.onAnswer(
						{ initiative: task?.initiative ?? task?.tags?.[0] ?? "general", ask: String(taskId) },
						choice,
					);
					return;
				}
				const fallbackChat = cur.adapted.chatByTaskId.get(taskId) ?? (task?.chat ? { file: task.chat.file } : null);
				if (fallbackChat && cur.props.onOpenChat) {
					cur.props.onOpenChat(fallbackChat);
				}
			},
			onRetryLoad: () => {
				reloadRoles();
				reloadWorkPage();
				current.current.props.onRetry();
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
				className="initiatives-exact-host"
				style={{
					width: "100%",
					height: "100%",
					minHeight: 0,
					overflowY: "auto",
					overflowX: "hidden",
					background: "var(--bg-canvas, #0E0F11)",
				}}
			/>
			{active && answer && props.onOpenChat && (
				<RoleAnswerDialog
					item={answer.item}
					needs={rolesModel.needs}
					connected={connection === "open"}
					onOpen={props.onOpenChat}
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

function InitiativesLegacyFontsFrame(props: InitiativesExactViewProps & { fonts: InitiativeFontBytes }) {
	const { active = true, fonts } = props;
	const [failed, setFailed] = useState(false);
	const host = useRef<HTMLDivElement>(null);
	const current = useRef(props);
	current.current = props;
	const shown = useRef(active);
	shown.current = active;
	const redraw = useRef<(() => void) | null>(null);
	useEffect(() => {
		redraw.current?.();
	});
	useEffect(() => {
		const container = host.current;
		if (!container) return;
		setFailed(false);
		let disposed = false;
		let release: (() => void) | null = null;
		const frame = document.createElement("iframe");
		frame.title = "Initiatives";
		frame.setAttribute("sandbox", "allow-same-origin");
		frame.referrerPolicy = "no-referrer";
		frame.style.cssText = "display:block;width:100%;height:100%;border:0;background:#0E0F11";
		container.appendChild(frame);
		const fail = () => {
			if (disposed) return;
			release?.();
			release = null;
			frame.remove();
			setFailed(true);
		};
		async function mount() {
			const doc = frame.contentDocument;
			if (!doc || !frame.contentWindow) throw new Error("Initiatives frame unavailable");
			doc.open();
			doc.write(
				'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body></body></html>',
			);
			doc.close();
			await prepareInitiativesDocument(doc, fonts);
			if (disposed) return;
			let queued: number | null = null;
			let binding: ReturnType<typeof bindInitiativesSurface> | null = null;
			const update = () => {
				if (disposed || queued !== null || !shown.current) return;
				queued = window.requestAnimationFrame(() => {
					queued = null;
					if (disposed) return;
					try {
						binding?.update();
					} catch {
						fail();
					}
				});
			};
			const actions = (): InitiativesExactActions => {
				const p = current.current;
				return {
					open: p.onOpen,
					retry: p.onRetry,
					changeLead: p.onChangeLead,
					messageLead: p.onMessageLead,
					newInitiative: p.onNewInitiative,
					resume: p.onResume,
					markRead: p.onMarkRead,
					askDesign: p.onAskDesign,
					answer: p.onAnswer,
					select: p.onSelect,
				};
			};
			const view = createInitiativesExactView(() => current.current.input, actions, update);
			try {
				binding = bindInitiativesSurface(doc, () => view.values());
			} catch (error) {
				view.dispose();
				throw error;
			}
			redraw.current = update;
			release = () => {
				if (queued !== null) window.cancelAnimationFrame(queued);
				redraw.current = null;
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
		<div ref={host} style={{ width: "100%", height: "100%", minHeight: 0, background: "#0E0F11" }}>
			{failed && (
				<p role="alert" style={{ margin: 0, padding: 16, color: "#ECEDEE" }}>
					The Initiatives page could not be loaded. No fallback design or sample data has been substituted.
				</p>
			)}
		</div>
	);
}
