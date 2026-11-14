/**
 * Parts the note and folder readers share: the breadcrumb with Back, the stored path with Copy path,
 * the facts list, and one level of how memory keeps a note (1 one-line summary, 2 overview, 3 full text).
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import Markdown from "react-markdown";
import { chainOf, folderLabel, noteTitle } from "./explorer-text.js";

export function Crumbs({
	uri,
	isFolder,
	backLabel,
	onBack,
	onFolder,
}: {
	uri: string;
	isFolder: boolean;
	backLabel: string | null;
	onBack(): void;
	onFolder(uri: string): void;
}) {
	const chain = chainOf(uri);
	return (
		<nav className="mx-crumbs" aria-label="Where this is">
			{backLabel ? (
				<>
					<button type="button" className="mx-link" onClick={onBack}>
						{backLabel}
					</button>
					<span className="mx-dim" aria-hidden="true">
						|
					</span>
				</>
			) : null}
			<ol>
				{chain.map((at) =>
					at === uri ? (
						<li key={at} aria-current="page">
							{isFolder ? folderLabel(at) : noteTitle(at)}
						</li>
					) : (
						<li key={at}>
							<button type="button" className="mx-link" data-folder={at} onClick={() => onFolder(at)}>
								{folderLabel(at)}
							</button>
						</li>
					),
				)}
			</ol>
		</nav>
	);
}

export function PathLine({ uri }: { uri: string }) {
	const [copied, setCopied] = useState(false);
	useEffect(() => {
		if (!copied) return;
		const timer = setTimeout(() => setCopied(false), 1500);
		return () => clearTimeout(timer);
	}, [copied]);
	return (
		<div className="mx-pathline">
			<span className="mx-path" data-path>
				{uri}
			</span>
			<button
				type="button"
				className="mx-btn mx-btn-small"
				onClick={() => {
					void navigator.clipboard?.writeText(uri).catch(() => {});
					setCopied(true);
				}}
			>
				{copied ? "Copied" : "Copy path"}
			</button>
		</div>
	);
}

export function Facts({ rows }: { rows: ReadonlyArray<readonly [string, ReactNode]> }) {
	return (
		<dl className="mx-facts">
			{rows.map(([term, value]) => (
				<div key={term}>
					<dt>{term}</dt> <dd>{value}</dd>
				</div>
			))}
		</dl>
	);
}

export function Level({ n, title, why, children }: { n: 1 | 2 | 3; title: string; why: string; children: ReactNode }) {
	return (
		<div className="mx-level">
			<div>
				<h4>
					<span className="mx-level-n" aria-hidden="true">
						{n}
					</span>
					{title}
				</h4>
				<p className="mx-dim mx-level-why">{why}</p>
			</div>
			{children}
		</div>
	);
}

/** Stored text is markdown: shown formatted, headings kept below the page's own. */
const H5 = ({ children }: { children?: ReactNode }) => <h5>{children}</h5>;
const H6 = ({ children }: { children?: ReactNode }) => <h6>{children}</h6>;
const HEADINGS_DOWN = { h1: H5, h2: H5, h3: H6, h4: H6, h5: H6 };

export function StoredText({ text, level }: { text: string; level?: 3 }) {
	return (
		<div className="mx-text" data-level={level}>
			<Markdown components={HEADINGS_DOWN}>{text}</Markdown>
		</div>
	);
}

/** The overview, folded until asked for. */
export function OverviewFold({ text }: { text: string | null }) {
	if (!text) {
		return (
			<p className="mx-missing" data-level="2">
				No overview written yet.
			</p>
		);
	}
	return (
		<details className="mx-fold" data-level="2">
			<summary>Show the overview</summary>
			<StoredText text={text} />
		</details>
	);
}

/** Focus the heading once a view opens, so a screen reader hears where it landed. */
export function useFocusOnOpen<T extends HTMLElement>(ready: boolean, key: string) {
	const ref = useRef<T>(null);
	useEffect(() => {
		if (ready) ref.current?.focus();
	}, [ready, key]);
	return ref;
}
