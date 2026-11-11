import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useAppField } from "../app-globals";
import { liveVisibleAt, subscribePageLive } from "../page-live";
import { projectExactRoles } from "../roles-exact-model";
import { reloadRoles, useRoles } from "../roles-state";
import { useEscapeKey } from "../shortcut-stack";
import {
	buildLiveTasksRolesV8Dataset,
	createReferenceDataset,
	mountTasksRolesV8Surface,
	PAGE_SIZE,
	type MountedTasksRolesV8Controller,
} from "../tasks-roles-v8";
import { reloadWorkPage, useWorkPage } from "../work-page-state";
import { handleLiveV8TaskAnswer, markLiveV8TaskAnswered, type LiveV8AnswerDialogState } from "./live-v8-task-answer";
import { RoleAnswerDialog } from "./RoleAnswerDialog";
import { RolesLegacyFontsFrame, updateRolesUsageDOM, type RolesExactViewProps } from "./RolesLegacyFontsFrame";
import {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	TaskPriorityBadge,
	formatTaskPriorityBadge,
	renderTaskPriorityBadgeHtml,
	taskPriority,
	type TaskPriority,
} from "./TaskPriorityBadge";

export {
	DEFAULT_PRIORITY,
	PRIORITIES,
	PRIORITY_RANK,
	TaskPriorityBadge,
	formatTaskPriorityBadge,
	renderTaskPriorityBadgeHtml,
	taskPriority,
	updateRolesUsageDOM,
	type RolesExactViewProps,
	type TaskPriority,
};

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
	const [answer, setAnswer] = useState<LiveV8AnswerDialogState | null>(null);
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
			onAnswerQuestion: (taskId, choice) => {
				const cur = current.current;
				const fromEl = document.activeElement instanceof HTMLElement ? document.activeElement : container;
				return handleLiveV8TaskAnswer({
					taskId,
					choice,
					adapted: cur.adapted,
					needs: cur.model.needs,
					dialogs: cur.dialogs,
					connected: cur.connection === "open",
					fromEl,
					getController: () => controllerRef.current,
					openDialog: (dialogState) => setAnswer(dialogState),
					openChat: (target) => cur.onOpen(target),
				});
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
					initialView={answer.initialView}
					initialChoice={answer.initialChoice}
					onAnswered={(summary) => {
						markLiveV8TaskAnswered(controllerRef.current, answer.taskId, summary);
						reloadRoles();
						reloadWorkPage();
					}}
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
