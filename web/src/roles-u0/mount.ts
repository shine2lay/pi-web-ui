// Inert U0 lifecycle. Nothing in the app imports this module (X0 switches it
// on later). It renders the exact Roles design into its own same-origin
// document, so app themes and global CSS can't reach it (owner 5A, PROGRAM C07),
// and it changes no other page. Font bytes come from the host: production use
// waits for the owner's rights records (4A), so this module bundles none.
import {
	createNativeRolesView,
	PRESERVED_ROUTES,
	type NativeRoute,
	type NativeRoutes,
	type NativeSnapshot,
} from "./native.js";
import { bindRolesSurface, prepareRolesDocument, type FontBytes } from "./surface.js";

export interface MountedRoles {
	readonly frame: HTMLIFrameElement;
	update(): void;
	dispose(): void;
}

export async function mountNativeRoles(
	host: HTMLElement,
	read: () => NativeSnapshot,
	routes: NativeRoutes,
	fonts: FontBytes,
): Promise<MountedRoles> {
	const outer = host.ownerDocument;
	const frame = outer.createElement("iframe");
	frame.title = "Roles";
	frame.style.cssText = "display:block;width:100%;height:100%;border:0";
	host.appendChild(frame);
	const doc = frame.contentDocument,
		win = frame.contentWindow;
	if (!doc || !win) {
		frame.remove();
		throw new Error("Roles frame unavailable");
	}
	doc.open();
	doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
	doc.close();
	await prepareRolesDocument(doc, fonts);
	let queued = false,
		disposed = false;
	let binding: { update(): void; dispose(): void } | null = null;
	const invalidate = () => {
		if (queued || disposed) return;
		queued = true;
		win.requestAnimationFrame(() => {
			queued = false;
			if (!disposed) binding?.update();
		});
	};
	const view = createNativeRolesView(
		read,
		routes,
		{
			raf: (fn) => {
				win.requestAnimationFrame(() => fn());
			},
			setTimeout: (fn, ms) => win.setTimeout(fn, ms),
			clearTimeout: (h) => win.clearTimeout(h as number),
		},
		invalidate,
	);
	binding = bindRolesSurface(doc, () => view.values());
	// The template's two links carry "#u0-route:<route>"; they open the host's
	// existing routes for the selected role and never navigate the frame.
	const onClick = (e: MouseEvent) => {
		const a = (e.target as Element | null)?.closest?.('a[href^="#u0-route:"]');
		if (!a) return;
		e.preventDefault();
		const route = (a.getAttribute("href") || "").slice("#u0-route:".length) as NativeRoute;
		if (PRESERVED_ROUTES.includes(route)) view.navigate(route);
	};
	doc.addEventListener("click", onClick);
	const ro = new (win as Window & typeof globalThis).ResizeObserver(invalidate);
	ro.observe(doc.documentElement);
	return {
		frame,
		update: invalidate,
		dispose: () => {
			disposed = true;
			ro.disconnect();
			doc.removeEventListener("click", onClick);
			binding?.dispose();
			frame.remove();
		},
	};
}
