import { useEffect, useRef, useState } from "react";
import { exactInitiativesFonts } from "../initiatives-exact-fonts";
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

export interface InitiativesExactViewProps {
	/** False while the page is hidden: no redraws until it shows again. */
	active?: boolean;
	input: InitiativesExactInput;
	fonts?: InitiativeFontBytes;
	onOpen: (target: InitiativesExactTarget) => void;
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

/** initiatives-exact: the supplied Initiatives design, 1:1, in a script-free frame isolated from app
 * themes (a fixed dark look). Data comes only from `input`, never the design's sample records; the
 * exact, pinned font bytes are a dependency of mounting, never a silent system-font substitute.
 * Inert until the wiring task mounts it. */
export function InitiativesExactView(props: InitiativesExactViewProps) {
	const { active = true, fonts = exactInitiativesFonts } = props;
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
			// The host owns every timer: the frame's own scripts are off.
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
