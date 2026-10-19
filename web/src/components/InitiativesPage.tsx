/**
 * initiatives-page (docs/initiatives-page-exact.md, Ops #225): the Initiatives tab. The supplied design
 * (InitiativesExactView, Ops #224) shows the work registry (work_page, Ops #223), each initiative's
 * decisions and its lead's updates (the decision log's initiatives_watch and progress feed). The model is
 * initiatives-page/model.ts; sections not connected yet say so.
 *
 * Its only write is today's lead picker (Change lead, for initiatives the decision log keeps), in a native
 * dialog. Message <lead> opens the lead's home chat the Roles page's way; a decision's source opens the old
 * view's source dialog.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FiX } from "react-icons/fi";
import { useT, type Translate } from "../i18n";
import { useIdentityList } from "../identity-state";
import type { InitiativesExactTarget } from "../initiatives-exact-model";
import { buildInitiativesPage } from "../initiatives-page/model";
import { reloadInitiatives, selectInitiative, useInitiatives } from "../initiatives-state";
import type { UiDecisionSource, UiProgress } from "../types";
import { useEscapeKey } from "../shortcut-stack";
import { reloadWorkPage, useWorkPage } from "../work-page-state";
import { InitiativesExactView } from "./InitiativesExactView";
import { SourceDialog } from "./InitiativesView";
import { LeadPicker } from "./ProgressSection";
import type { RolesOpenTarget } from "./RolesView";
import "../initiatives-view.css";

export interface InitiativesPageProps {
	/** The tab is shown (it watches the server only then). */
	active: boolean;
	/** Opens a chat (the Roles page's open path). */
	onOpen: (target: RolesOpenTarget) => void;
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now());
		const id = window.setInterval(() => setNow(Date.now()), 60_000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

export function InitiativesPage({ active, onOpen }: InitiativesPageProps) {
	const t = useT();
	const work = useWorkPage(active);
	const log = useInitiatives(active);
	const roles = useIdentityList();
	const now = useNow(active);
	const [pick, setPick] = useState<string | undefined>();
	const [source, setSource] = useState<UiDecisionSource | null>(null);
	const [leadFor, setLeadFor] = useState<string | null>(null);

	// Escape closes the page's own dialog first (H-INITIATIVES-PAGE-2). The app hands Escape to the newest
	// handler on its stack (shortcut-stack.ts), and the chat pane's question dialog is on it even behind this
	// tab: without this, Escape would cancel that chat's waiting question and leave the dialog open.
	useEscapeKey(
		() => {
			setLeadFor(null);
			setSource(null);
		},
		leadFor !== null || source !== null,
	);

	const homeChats = useMemo(() => {
		const out: Record<string, string> = {};
		for (const r of roles.identities) if (r.homeChat && !r.homeChatMissing) out[r.id] = r.homeChat;
		return out;
	}, [roles.identities]);
	const model = useMemo(
		() =>
			buildInitiativesPage({
				work,
				decisions: log.page,
				homeChats,
				selected: pick,
				now,
				t,
				open: (file) => onOpen({ file }),
			}),
		[work, log.page, homeChats, pick, now, t, onOpen],
	);

	// The decision log watches one initiative at a time: the open one, when it keeps it.
	const selected = model.selected;
	const logKeeps = selected !== undefined && model.changeLead.includes(selected);
	useEffect(() => {
		if (active && selected !== undefined && logKeeps) selectInitiative(selected);
	}, [active, selected, logKeeps]);

	const progress = log.page?.progress;
	const leadProgress = leadFor && progress?.initiative === leadFor ? progress : undefined;
	const leadName = leadFor ? (model.input.initiatives?.find((i) => i.id === leadFor)?.name ?? leadFor) : "";

	return (
		<div className="initiatives-page" style={{ flex: 1, minWidth: 0, minHeight: 0, height: "100%" }}>
			<InitiativesExactView
				active={active}
				input={model.input}
				onOpen={(target: InitiativesExactTarget) => {
					const src = model.sources[target.ref];
					if (src) setSource(src);
				}}
				onRetry={() => {
					reloadWorkPage();
					reloadInitiatives();
				}}
				onSelect={setPick}
				onMessageLead={(id) => {
					const file = model.leadChats[id];
					if (file) onOpen({ file });
				}}
				onChangeLead={(id) => setLeadFor(id)}
			/>
			{/* The old view's classes style the dialogs; display: contents adds no box around them. */}
			<div className="initiatives-view" style={{ display: "contents" }}>
				{source && <SourceDialog t={t} src={source} now={now} onClose={() => setSource(null)} onOpen={onOpen} />}
				{leadFor && <LeadDialog t={t} name={leadName} progress={leadProgress} onClose={() => setLeadFor(null)} />}
			</div>
		</div>
	);
}

/** Change lead: today's lead picker, in a native dialog that says what it changes. */
function LeadDialog({
	t,
	name,
	progress,
	onClose,
}: {
	t: Translate;
	name: string;
	progress: UiProgress | undefined;
	onClose: () => void;
}) {
	const ref = useRef<HTMLDialogElement>(null);
	useEffect(() => {
		const d = ref.current;
		if (d && !d.open) d.showModal();
	}, []);
	return (
		<dialog ref={ref} className="iv-dialog" aria-labelledby="ip-lead-h" onClose={onClose}>
			<div className="iv-dhead">
				<h2 id="ip-lead-h">Change lead: {name}</h2>
				<button type="button" className="iv-x" aria-label={t("ivClose")} onClick={() => ref.current?.close()}>
					<FiX aria-hidden="true" />
				</button>
			</div>
			<p>This changes who writes this initiative's progress updates.</p>
			{progress ? (
				<LeadPicker t={t} progress={progress} />
			) : (
				<p className="iv-note" role="status">
					Loading the lead…
				</p>
			)}
			<div className="iv-dfoot">
				<button type="button" className="iv-btn" onClick={() => ref.current?.close()}>
					{t("ivClose")}
				</button>
			</div>
		</dialog>
	);
}
