/**
 * A department's Specialists node in "Where memory keeps things" (v2 §5l.15): each specialist by its
 * slug, with its status word, and three places to open: its Notebook, its Memories and its Archive.
 * A place it doesn't have shows as empty, never hidden. Slugs and names come from the store, so they
 * are shown as text only, and every place opens the uri the server listed, never one built here.
 */

import { type ReactNode, useState } from "react";
import type { SpecialistEntry, SpecialistsNode as Node } from "./explorer-api.js";

const Chevron = () => (
	<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
		<path d="M4.5 2.5L8 6l-3.5 3.5" />
	</svg>
);

interface OpenProps {
	readonly current: string | null;
	onOpen(uri: string): void;
	onOpenNote(uri: string): void;
	/** A link's note: the rows above it start open. */
	readonly reveal: string | null;
}

/** The link's note is this place or inside it (the uris the server listed; matching only, never access). */
const within = (reveal: string | null, uri: string) =>
	reveal !== null && (reveal === uri || reveal.startsWith(`${uri}/`));
const holds = (entry: SpecialistEntry, reveal: string | null) =>
	within(reveal, entry.notebook) || within(reveal, entry.memories);

/** A count as the tree words it: null is "not counted", never 0. */
function Count({ count, none }: { count: number | null; none: string }) {
	if (count === null) return <span className="mx-tree-count mx-dim">not counted</span>;
	if (count === 0) return <span className="mx-tree-count mx-dim">{none}</span>;
	return (
		<span className="mx-num mx-tree-count">
			{count.toLocaleString("en-US")}
			<span className="mx-sr">{count === 1 ? " note" : " notes"}</span>
		</span>
	);
}

/** A row that opens and closes the rows below it; its name (`label` plus any status) is text, not a link. */
function Branch({
	label,
	status,
	side,
	startOpen,
	children,
}: {
	label: string;
	status?: string | null;
	side: ReactNode;
	startOpen: boolean;
	children: ReactNode;
}) {
	const [open, setOpen] = useState(startOpen);
	return (
		<li>
			<div className="mx-tree-row" data-tree-row>
				<button
					type="button"
					className="mx-tree-toggle"
					aria-expanded={open}
					aria-label={`${open ? "Close" : "Open"} ${label}`}
					onClick={() => setOpen(!open)}
				>
					<Chevron />
				</button>
				<span className="mx-tree-name">
					{label}
					{status ? <span className="mx-dim"> · {status}</span> : null}
				</span>
				{side}
			</div>
			{open ? children : null}
		</li>
	);
}

/** One place to open: a note or a folder at the server's uri; `missing` shows it empty and closed. */
function Leaf({
	name,
	uri,
	isFolder,
	missing,
	count,
	current,
	onOpen,
	onOpenNote,
}: Omit<OpenProps, "reveal"> & {
	name: string;
	uri: string;
	isFolder: boolean;
	missing: boolean;
	count?: number | null;
}) {
	return (
		<li>
			<div className="mx-tree-row" data-tree-row aria-current={current === uri ? "true" : undefined}>
				<span aria-hidden="true" />
				<button
					type="button"
					className="mx-tree-open"
					disabled={missing}
					onClick={() => (isFolder ? onOpen(uri) : onOpenNote(uri))}
				>
					<span className="mx-tree-name">{name}</span>
				</button>
				{count !== undefined ? (
					<Count count={count} none="empty" />
				) : missing ? (
					<span className="mx-tree-count mx-dim">empty</span>
				) : null}
			</div>
		</li>
	);
}

function Specialist({ entry, ...open }: OpenProps & { entry: SpecialistEntry }) {
	const verifiedEmpty = entry.hasNotebook === false && entry.memoriesCount === 0 && entry.archiveCount === 0;
	return (
		<Branch
			label={entry.slug}
			status={entry.label}
			side={<Count count={entry.noteCount === 0 && !verifiedEmpty ? null : entry.noteCount} none="no notes yet" />}
			startOpen={holds(entry, open.reveal)}
		>
			<ul>
				<Leaf
					{...open}
					name="Notebook"
					uri={entry.notebook}
					isFolder={false}
					missing={entry.hasNotebook === false}
					count={entry.hasNotebook === null ? null : Number(entry.hasNotebook)}
				/>
				<Leaf
					{...open}
					name="Memories"
					uri={entry.memories}
					isFolder
					missing={entry.hasMemories === false}
					count={entry.memoriesCount}
				/>
				<Leaf
					{...open}
					name="Archive"
					uri={entry.archive}
					isFolder
					missing={entry.hasMemories === false}
					count={entry.archiveCount}
				/>
			</ul>
		</Branch>
	);
}

/** Notes under the node: none while memory didn't answer for all of it; else the store's own count. */
export function specialistsCount(node: Node, listed: number | null | undefined): number | null {
	if (!node.read) return null;
	if (listed !== undefined) return listed;
	let sum = 0;
	for (const s of node.specialists) {
		if (s.noteCount === null) return null;
		sum += s.noteCount;
	}
	return sum;
}

export function SpecialistsNode({ node, count, ...open }: OpenProps & { node: Node; count: number | null }) {
	return (
		<Branch
			label="Specialists"
			side={<Count count={count} none="no notes yet" />}
			startOpen={
				node.specialists.some((entry) => holds(entry, open.reveal)) ||
				node.others.some((other) => within(open.reveal, other.uri))
			}
		>
			<ul>
				{node.specialists.map((entry) => (
					<Specialist key={entry.slug} entry={entry} {...open} />
				))}
				{node.others.map((other) => (
					<Leaf key={other.uri} {...open} name={other.name} uri={other.uri} isFolder={other.isFolder} missing={false} />
				))}
			</ul>
			{node.read ? null : <p className="mx-tree-note">Couldn't read all of it.</p>}
		</Branch>
	);
}
