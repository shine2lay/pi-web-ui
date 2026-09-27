import { useEffect, useRef, useState } from "react";
import type { UiImageBlock } from "../types";
import { useT } from "../i18n";
import { imageSrc, isLazyImage, markImageLoaded, placeholderSrc, retrySrc, wasImageLoaded } from "../chat-image";

/** How far outside the visible part of the chat pictures start loading (about two screens). */
const LOAD_AHEAD = "1600px 0px";
/** Waits before asking again when a picture fails (its chat may still be reopening after a restart). */
const RETRY_MS = [1000, 3000, 8000];

/** The nearest ancestor that scrolls. Pictures sit inside the chat's own scroll area, and an observer
 *  rooted at the window would only fire once a picture is already on screen. */
function scrollParent(el: Element): Element | null {
	for (let p = el.parentElement; p; p = p.parentElement) {
		const oy = getComputedStyle(p).overflowY;
		if (oy === "auto" || oy === "scroll" || oy === "overlay") return p;
	}
	return null;
}

/**
 * lazy-images: one picture of a chat message. Inline pictures show at once. A placeholder (url, width,
 * height) shows a same-size gray box and loads the picture when it comes within LOAD_AHEAD of the
 * visible area. The picture is fetched off-screen first and swapped in only once it has arrived, so the
 * box never collapses or moves while the picture is on its way. While a picture isn't shown, data-src
 * holds its address (copy as image reads it, see resolveLazyImages).
 */
export function ChatImage({ block, alt }: { block: UiImageBlock; alt: string }) {
	const t = useT();
	const src = imageSrc(block);
	const lazy = isLazyImage(block);
	const known = !lazy || (src !== undefined && wasImageLoaded(src));
	const [near, setNear] = useState(known);
	/** The address that loaded (a retry has its own); undefined until the picture is here. */
	const [loadedSrc, setLoadedSrc] = useState<string | undefined>(known ? src : undefined);
	const [failed, setFailed] = useState(false);
	const ref = useRef<HTMLImageElement>(null);

	// A different picture in the same place (the list reuses components): start over.
	const [shownFor, setShownFor] = useState(src);
	if (shownFor !== src) {
		setShownFor(src);
		setNear(known);
		setLoadedSrc(known ? src : undefined);
		setFailed(false);
	}

	// Near the screen: fetch the picture, retrying a few times (its chat may still be reopening after
	// a restart). It goes on screen when it has arrived.
	useEffect(() => {
		if (!lazy || !near || loadedSrc !== undefined || failed || !src) return;
		let attempt = 0;
		let timer: number | undefined;
		let cancelled = false;
		const probe = new Image();
		probe.onload = () => {
			if (cancelled) return;
			markImageLoaded(src);
			setLoadedSrc(probe.src);
		};
		probe.onerror = () => {
			if (cancelled) return;
			if (attempt < RETRY_MS.length) {
				timer = window.setTimeout(() => {
					attempt += 1;
					probe.src = retrySrc(src, attempt);
				}, RETRY_MS[attempt]);
			} else {
				console.warn("[chat-image] picture failed to load:", src);
				setFailed(true);
			}
		};
		probe.src = src;
		return () => {
			cancelled = true;
			window.clearTimeout(timer);
			probe.onload = null;
			probe.onerror = null;
		};
	}, [lazy, near, loadedSrc, failed, src]);

	useEffect(() => {
		if (near) return;
		const el = ref.current;
		if (!el) return;
		if (typeof IntersectionObserver === "undefined") {
			setNear(true);
			return;
		}
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setNear(true);
					io.disconnect();
				}
			},
			{ root: scrollParent(el), rootMargin: LOAD_AHEAD },
		);
		io.observe(el);
		return () => io.disconnect();
	}, [near]);

	if (!src) return null;
	const pending = lazy && loadedSrc === undefined;
	return (
		<img
			ref={ref}
			src={pending ? placeholderSrc(block.width, block.height) : (loadedSrc ?? src)}
			alt={alt}
			title={failed ? t("imageLoadFailed", { name: alt }) : undefined}
			data-src={pending ? src : undefined}
			className={pending ? "chat-image-pending" : undefined}
		/>
	);
}
