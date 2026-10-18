// initiatives-exact: the non-evaluating binder that renders a supplied design template, shared by the
// Roles and Initiatives pages (moved here from roles-u0/surface.ts, unchanged in what it renders).
// Inert: no registration, DOM work or resources on import. It binds ONLY the static template it is
// given, never HTML from a DTO, and it deliberately retains the source's interpolation spans.
import type { SurfaceValue, SurfaceValues } from "./roles-u0/types";
export type { SurfaceValue, SurfaceValues } from "./roles-u0/types";

export interface SurfaceOptions {
	/** Prefix of every error message ("Roles", "Initiatives"). */
	name: string;
	/** The template a `<dc-import name="StateChip">` renders; without it such an import is refused. */
	chip?: string;
	/** Where the template renders. "frame": body > #dc-root > a frame div styled `frameStyle` > template.
	 * "root": body > #dc-root > template. "body": straight into the body. */
	mount: "frame" | "root" | "body";
	/** The frame div's inline style, for mount "frame". */
	frameStyle?: string;
}
export interface SurfaceBinding {
	update: () => void;
	dispose: () => void;
}

const CHIP = {
	working: ["Working now", "#7DB8FF", "rgba(125,184,255,0.12)", "rgba(125,184,255,0.4)"],
	waiting: ["Waiting", "#F0B95A", "rgba(240,185,90,0.12)", "rgba(240,185,90,0.4)"],
	blocked: ["Blocked", "#F0B95A", "rgba(240,185,90,0.12)", "rgba(240,185,90,0.45)"],
	onhold: ["On hold", "#8FC7C0", "rgba(143,199,192,0.1)", "rgba(143,199,192,0.4)"],
	queued: ["Queued", "#AFC4E2", "rgba(175,196,226,0.08)", "rgba(175,196,226,0.35)"],
	paused: ["Paused by you", "#C3C8CF", "rgba(195,200,207,0.08)", "rgba(195,200,207,0.3)"],
	idle: ["Idle", "#A9AEB6", "transparent", "#3A3F46"],
	error: ["Error", "#FF8A80", "rgba(255,138,128,0.12)", "rgba(255,138,128,0.45)"],
	unknown: ["Unknown", "#C7B8FF", "rgba(199,184,255,0.08)", "rgba(199,184,255,0.5)"],
	done: ["Done", "#9FD8B8", "rgba(159,216,184,0.1)", "rgba(159,216,184,0.4)"],
} as const;
function resolve(values: SurfaceValues, path: string, name: string): SurfaceValue {
	if (path === "true") return true;
	if (path === "false") return false;
	if (!/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*$/.test(path)) throw new Error(`${name} binding is not a path`);
	let v: SurfaceValue = values;
	for (const part of path.split(".")) {
		if (["__proto__", "constructor", "prototype"].includes(part)) throw new Error(`${name} unsafe binding`);
		if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
		v = Object.hasOwn(v, part) ? v[part] : undefined;
	}
	return v;
}
function binding(values: SurfaceValues, text: string, name: string): SurfaceValue {
	const sole = /^\s*\{\{(.*?)\}\}\s*$/.exec(text);
	if (sole) return resolve(values, sole[1].trim(), name);
	return text.replace(/\{\{(.*?)\}\}/g, (_, path: string) => {
		const v = resolve(values, path.trim(), name);
		return v === null || v === undefined || typeof v === "boolean" ? "" : String(v);
	});
}
function stateChip(kind: SurfaceValue, last: SurfaceValue): SurfaceValues {
	const k = typeof kind === "string" && Object.hasOwn(CHIP, kind) ? (kind as keyof typeof CHIP) : "unknown";
	const m = CHIP[k];
	const data: SurfaceValues = {
		text: (last ? "Last known: " : "") + m[0],
		fg: m[1],
		bg: last ? "transparent" : m[2],
		bd: m[3],
		bs: k === "unknown" || last ? "dashed" : "solid",
	};
	for (const [value, name] of Object.entries({
		working: "Working",
		waiting: "Waiting",
		blocked: "Blocked",
		onhold: "OnHold",
		paused: "Paused",
		idle: "Idle",
		error: "Error",
		unknown: "Unknown",
		queued: "Queued",
		done: "Done",
	}))
		data["is" + name] = k === value;
	return data;
}

/** Binds one supplied template to the values `read` returns, again on every `update`. Tests can
 * supply fictional values; the pages' public entries derive them from their own closed models. */
export function bindSurface(
	doc: Document,
	template: string,
	read: () => SurfaceValues,
	opts: SurfaceOptions,
): SurfaceBinding {
	const { name } = opts;
	const t = doc.createElement("template");
	t.innerHTML = template;
	const ct = doc.createElement("template");
	ct.innerHTML = opts.chip ?? "";
	const cache = new Map<string, Node>();
	const handlers = new WeakMap<Element, Map<string, EventListener>>();
	const refs = new WeakSet<Element>();
	const styled = new WeakMap<Element, string>();
	const get = (key: string, build: () => Node): Node => {
		const prior = cache.get(key);
		if (prior) return prior;
		const node = build();
		cache.set(key, node);
		return node;
	};
	function children(parent: Node, nodes: Node[]): void {
		const wanted = new Set(nodes);
		for (const old of Array.from(parent.childNodes)) if (!wanted.has(old)) parent.removeChild(old);
		let cursor = parent.firstChild;
		for (const node of nodes) {
			if (node === cursor) cursor = cursor.nextSibling;
			else parent.insertBefore(node, cursor);
		}
	}
	function compile(source: Node, data: SurfaceValues, key: string, svg: boolean): Node[] {
		if (source.nodeType === 3) {
			const text = source.nodeValue || "";
			if (!text.trim() && !text.includes(" ")) return [];
			const bits = text.split(/\{\{([\s\S]+?)\}\}/g);
			const output: Node[] = [];
			bits.forEach((bit, i) => {
				if (!(i & 1)) {
					if (bit) {
						const n = get(key + ".t" + i, () => doc.createTextNode(bit));
						if (n.nodeValue !== bit) n.nodeValue = bit;
						output.push(n);
					}
					return;
				}
				const v = resolve(data, bit.trim(), name);
				if (v === undefined || v === null || typeof v === "boolean") return;
				if (typeof v !== "string" && typeof v !== "number") throw new Error(`${name} text must be scalar`);
				const n = get(key + ".i" + i, () => {
					const span = doc.createElement("span");
					span.className = "sc-interp";
					return span;
				});
				// Like the source's runtime (React setTextContent): leave unchanged text alone, and
				// update a changed value in its existing text node, so nothing else repaints.
				const text = String(v);
				if (n.textContent !== text) {
					const only = n.firstChild;
					if (only && only === n.lastChild && only.nodeType === 3 && text) only.nodeValue = text;
					else n.textContent = text;
				}
				output.push(n);
			});
			return output;
		}
		if (source.nodeType !== 1) return [];
		const src = source as Element,
			tag = src.localName;
		const renderChildren = (values: SurfaceValues, prefix: string, inSVG: boolean) =>
			Array.from(src.childNodes).flatMap((n, i) => compile(n, values, prefix + "." + i, inSVG));
		if (tag === "sc-if")
			return binding(data, src.getAttribute("value") || "", name) ? renderChildren(data, key, svg) : [];
		if (tag === "sc-for") {
			const list = binding(data, src.getAttribute("list") || "", name),
				as = src.getAttribute("as") || "item";
			if (list === undefined) return [];
			if (!Array.isArray(list) || list.length > 1000) throw new Error(`${name} bounded list required`);
			return list.flatMap((item, i) => renderChildren({ ...data, [as]: item }, key + ".row" + i, svg));
		}
		if (tag === "dc-import") {
			if (src.getAttribute("name") !== "StateChip" || opts.chip === undefined)
				throw new Error(`${name} unsupported import`);
			const values = stateChip(
				binding(data, src.getAttribute("kind") || "", name),
				binding(data, src.getAttribute("last-known") || "", name),
			);
			const host = get(key, () => {
				const el = doc.createElement("div");
				el.className = "sc-host";
				return el;
			});
			children(
				host,
				Array.from(ct.content.childNodes).flatMap((n, i) => compile(n, values, key + ".chip" + i, false)),
			);
			return [host];
		}
		if (["script", "iframe", "object", "embed", "link", "img"].includes(tag))
			throw new Error(`${name} forbidden template element`);
		const inSVG = svg || tag === "svg";
		const el = get(key, () =>
			inSVG ? doc.createElementNS("http://www.w3.org/2000/svg", tag) : doc.createElement(tag),
		) as Element;
		const expected = new Set<string>();
		for (const a of Array.from(src.attributes)) {
			if (a.name.startsWith("hint-")) continue;
			const v = binding(data, a.value, name);
			if (a.name === "ref") {
				if (typeof v === "function" && !refs.has(el)) {
					refs.add(el);
					queueMicrotask(() => v(el));
				}
				continue;
			}
			if (a.name.startsWith("on")) {
				if (v !== undefined && typeof v !== "function") throw new Error(`${name} callback required`);
				const event = a.name.slice(2).toLowerCase();
				const listeners = handlers.get(el) || new Map<string, EventListener>();
				handlers.set(el, listeners);
				const old = listeners.get(event);
				if (old) el.removeEventListener(event, old);
				if (typeof v === "function") {
					const f: EventListener = (e) => v(e);
					el.addEventListener(event, f);
					listeners.set(event, f);
				}
				continue;
			}
			if (v === undefined || v === null || (["disabled", "checked"].includes(a.name) && !v)) {
				if (el.hasAttribute(a.name)) el.removeAttribute(a.name);
				if (a.name === "style") styled.delete(el);
				continue;
			}
			const value = String(v);
			if (a.name === "href" && !/^#|^\/(?!\/)/.test(value)) throw new Error(`${name} native link must be local`);
			if (a.name === "style") {
				if (styled.get(el) !== value) {
					(el as HTMLElement | SVGElement).style.cssText = value;
					styled.set(el, value);
				}
			} else if (el.getAttribute(a.name) !== value) el.setAttribute(a.name, value);
			expected.add(a.name);
		}
		for (const a of Array.from(el.attributes))
			if (!expected.has(a.name) && a.name !== "data-u0-key") {
				el.removeAttribute(a.name);
				if (a.name === "style") styled.delete(el);
			}
		if (el.getAttribute("data-u0-key") !== key) el.setAttribute("data-u0-key", key);
		children(el, renderChildren(data, key, inSVG));
		return [el];
	}
	const mount = doc.createElement("div");
	mount.id = "dc-root";
	let target: Element = doc.body;
	if (opts.mount === "frame") {
		const frame = doc.createElement("div");
		frame.style.cssText = opts.frameStyle ?? "";
		mount.appendChild(frame);
		children(doc.body, [mount]);
		target = frame;
	} else if (opts.mount === "root") {
		children(doc.body, [mount]);
		target = mount;
	}
	const update = () => {
		const data = read();
		children(
			target,
			Array.from(t.content.childNodes).flatMap((n, i) => compile(n, data, "u0." + i, false)),
		);
	};
	update();
	return {
		update,
		dispose: () => {
			children(doc.body, []);
			cache.clear();
		},
	};
}
