/* W1-F, standalone classic script or module. Loading it does not open a drawer.
 * Wave 2: PiToolInspector.open({clientId, convId, baseUrl?}).
 * No dependency on app.js, host styles, a framework or a WebSocket protocol.
 */
(function (global) {
	"use strict";
	const sources = ["all", "core", "extension", "plugin", "mcp"];
	const escapeHtml = (value) =>
		String(value == null ? "" : value).replace(
			/[&<>"']/g,
			(char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
		);
	const filterTools = (tools, search = "", source = "all") => {
		const query = search.trim().toLowerCase();
		return tools.filter(
			(tool) =>
				(source === "all" || tool.source === source) &&
				(!query ||
					[tool.name, tool.label, tool.description, tool.origin, tool.source].some((value) =>
						String(value || "")
							.toLowerCase()
							.includes(query),
					)),
		);
	};
	function formatSchema(schema) {
		if (schema == null) return "No parameter schema available.";
		try {
			return JSON.stringify(schema, null, 2);
		} catch {
			return "Schema cannot be displayed.";
		}
	}
	function renderParameters(rows) {
		if (!rows || !rows.length) return '<p class="pti-muted">No named parameters.</p>';
		return `<div class="pti-table-scroll"><table><caption>Parameters</caption><thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead><tbody>${rows.map((row) => `<tr><th scope="row"><code>${escapeHtml(row.name)}</code></th><td>${escapeHtml(row.type)}</td><td>${row.required ? "Yes" : "No"}</td><td>${escapeHtml(row.description)}</td></tr>`).join("")}</tbody></table></div>`;
	}
	function renderToolRow(tool, index, options = {}) {
		const scope = options.scope === "workspace" ? "workspace" : "chat";
		const overrides = options.draft || (tool.overrides && tool.overrides[scope]) || {};
		const description = overrides.customDescription == null ? "" : overrides.customDescription;
		const rule = overrides.promptRule == null ? "" : overrides.promptRule;
		const checked = tool.enabled ? " checked" : "";
		const disabled = options.busy ? " disabled" : "";
		const ruleList = (tool.promptGuidelines || []).map((line) => `<li>${escapeHtml(line)}</li>`).join("");
		return `<article class="pti-tool" data-tool-index="${index}">
			<div class="pti-tool-head"><div><code class="pti-tool-name">${escapeHtml(tool.name)}</code><span class="pti-badge">${escapeHtml(tool.source)}</span>${tool.exposure && tool.exposure !== "direct" ? `<span class="pti-badge">${escapeHtml(tool.exposure)}</span>` : ""}<span class="pti-status">${tool.active ? "Active" : tool.enabled ? "Available, not active" : "Disabled"}</span></div>
			<label class="pti-switch"><input type="checkbox" role="switch" data-action="toggle" aria-label="Enable ${escapeHtml(tool.name)}"${checked}${disabled}><span aria-hidden="true"></span></label></div>
			<p class="pti-description">${escapeHtml(tool.description || "No description.")}</p>
			<details data-tool-details="${escapeHtml(tool.name)}"${options.expanded ? " open" : ""}><summary>Details and custom rules</summary>
			${tool.origin ? `<p class="pti-origin"><strong>Source:</strong> ${escapeHtml(tool.origin)}</p>` : ""}
			${tool.promptSnippet ? `<h3>Prompt snippet</h3><pre>${escapeHtml(tool.promptSnippet)}</pre>` : ""}
			${ruleList ? `<h3>Effective prompt guidelines</h3><ul>${ruleList}</ul>` : ""}
			${renderParameters(tool.parameterSummary)}
			<details class="pti-schema"><summary>JSON schema</summary><pre>${escapeHtml(tool.parametersDropped ? "Schema exceeds the server's tool-info display size." : formatSchema(tool.parameters))}</pre></details>
			<form data-action="edit" class="pti-editor">
			<label>Custom description <textarea name="customDescription" rows="3" maxlength="8000" placeholder="Inherit the tool description"${disabled}>${escapeHtml(description)}</textarea></label>
			<label>Extra prompt rule <textarea name="promptRule" rows="3" maxlength="8000" placeholder="Inherit the workspace rule, if any"${disabled}>${escapeHtml(rule)}</textarea></label>
			<p class="pti-muted">Saved for ${scope === "chat" ? "this chat" : "this workspace (all its chats)"}. Empty fields inherit defaults. Tool changes take effect on the next turn; they do not cancel a running call.</p>
			<div class="pti-editor-actions"><button type="submit"${disabled}>Save text</button><button type="button" data-action="reset"${disabled}>Reset ${scope === "chat" ? "chat" : "workspace"} overrides</button></div>
			</form></details></article>`;
	}
	function renderToolList(snapshot, options = {}) {
		const tools = snapshot && Array.isArray(snapshot.tools) ? snapshot.tools : [];
		const filtered = filterTools(tools, options.search, options.source);
		if (!filtered.length)
			return `<p class="pti-empty">${tools.length ? "No tools match your search." : "No tools are registered for this chat."}</p>`;
		return filtered
			.map((tool) => {
				const index = tools.indexOf(tool);
				return renderToolRow(tool, index, {
					...options,
					draft: options.drafts && options.drafts.get(JSON.stringify([options.scope, tool.name])),
					expanded: options.expanded && options.expanded.has(tool.name),
				});
			})
			.join("");
	}
	function buildUpdate(toolName, values, scope = "chat") {
		const update = { toolName, scope };
		for (const key of ["enabled", "customDescription", "promptRule"]) {
			if (Object.prototype.hasOwnProperty.call(values, key)) update[key] = values[key];
		}
		return update;
	}
	const styles = `
.pti-overlay{position:fixed;inset:0;z-index:12000;background:#0007;display:flex;justify-content:flex-end;color:var(--text,#e9e9ef);font:14px/1.5 system-ui,sans-serif}
.pti-drawer{width:min(680px,100%);height:100%;background:var(--bg,#191a20);border-left:1px solid var(--border,#444);box-shadow:-12px 0 50px #0006;display:flex;flex-direction:column;min-width:0}
.pti-drawer *{box-sizing:border-box}.pti-drawer header{display:flex;align-items:center;justify-content:space-between;padding:16px 20px;border-bottom:1px solid var(--border,#444);gap:12px}.pti-drawer h2{font-size:19px;margin:0}.pti-drawer h3{font-size:13px;margin:14px 0 6px}.pti-drawer button,.pti-drawer select,.pti-drawer input[type=search],.pti-drawer textarea{font:inherit;color:inherit;background:var(--bg-elev,#23252d);border:1px solid var(--border,#555);border-radius:6px;padding:7px 10px}.pti-drawer button{cursor:pointer}.pti-drawer button:disabled{opacity:.55;cursor:wait}.pti-drawer :focus-visible{outline:2px solid var(--accent,#9ab7ff);outline-offset:2px}.pti-close{font-size:22px!important;line-height:1;min-width:40px;min-height:40px}.pti-controls{padding:12px 20px;border-bottom:1px solid var(--border,#444);display:grid;gap:10px}.pti-controls input[type=search]{width:100%}.pti-filters{display:flex;gap:6px;flex-wrap:wrap}.pti-filters button{font-size:12px;padding:4px 9px}.pti-filters button[aria-pressed=true]{border-color:var(--accent,#9ab7ff);background:var(--accent-soft,#344060)}.pti-scope{display:flex;gap:10px;align-items:center;flex-wrap:wrap}.pti-meta,.pti-muted,.pti-status{color:var(--text-dim,#b5b6c3);font-size:12px}.pti-meta{margin:0}.pti-error{margin:10px 20px;padding:10px;border:1px solid var(--red,#ee9696);border-radius:6px;color:var(--red,#ee9696)}.pti-error[hidden]{display:none}.pti-content{overflow:auto;overscroll-behavior:contain;flex:1;padding:0 20px 24px}.pti-tool{padding:14px 0;border-bottom:1px solid var(--border,#444);overflow-wrap:anywhere}.pti-tool-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.pti-tool-head>div{display:flex;align-items:center;gap:6px;flex-wrap:wrap;min-width:0}.pti-tool-name{font-family:var(--mono,monospace);font-weight:600}.pti-badge{border:1px solid var(--border,#555);border-radius:20px;padding:0 7px;font-size:11px}.pti-description{white-space:pre-wrap;margin:8px 0;font-size:13px}.pti-tool:not(:has(details[open]))>.pti-description{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.pti-drawer summary{cursor:pointer;color:var(--text-dim,#b5b6c3);font-size:12px;padding:4px 0}.pti-drawer pre{font:12px/1.5 var(--mono,monospace);white-space:pre-wrap;overflow-wrap:anywhere;background:var(--bg-elev,#23252d);padding:10px;border-radius:6px;max-height:320px;overflow:auto}.pti-drawer ul{padding-left:20px}.pti-table-scroll{overflow-x:auto;margin-top:10px}.pti-drawer table{border-collapse:collapse;width:100%;font-size:12px;text-align:left}.pti-drawer caption{text-align:left;font-weight:600;padding:4px 0}.pti-drawer th,.pti-drawer td{padding:6px 8px;border-bottom:1px solid var(--border-soft,#363842);vertical-align:top}.pti-origin{font-size:12px;white-space:pre-wrap}.pti-editor{margin-top:12px;background:var(--bg-elev,#23252d);padding:12px;border-radius:6px}.pti-editor label{display:block;font-size:12px;margin-bottom:10px}.pti-editor textarea{display:block;width:100%;margin-top:5px;resize:vertical;background:var(--bg,#191a20)}.pti-editor-actions{display:flex;gap:8px;flex-wrap:wrap}.pti-switch{position:relative;flex-shrink:0;display:flex;align-items:center;justify-content:center;width:46px;height:36px;cursor:pointer}.pti-switch input{position:absolute;opacity:0;width:100%;height:100%;margin:0;cursor:pointer}.pti-switch span{width:34px;height:20px;border:1px solid var(--border,#666);border-radius:12px;background:var(--bg-elev2,#444);pointer-events:none}.pti-switch span:after{content:"";display:block;width:14px;height:14px;border-radius:50%;background:var(--text,#eee);margin:2px;transition:transform .12s}.pti-switch input:checked+span{background:var(--accent,#718fe0)}.pti-switch input:checked+span:after{transform:translateX(14px)}.pti-switch input:focus-visible+span{outline:2px solid var(--accent,#9ab7ff);outline-offset:3px}.pti-switch input:disabled+span{opacity:.5}.pti-empty{padding:25px 0;color:var(--text-dim,#b5b6c3)}
@media(prefers-reduced-motion:reduce){.pti-switch span:after{transition:none}}
`;
	let current = null;
	let generation = 0;
	function injectStyles(doc) {
		if (doc.getElementById("pi-tool-inspector-styles")) return;
		const style = doc.createElement("style");
		style.id = "pi-tool-inspector-styles";
		style.textContent = styles;
		doc.head.append(style);
	}
	function endpoint(options, path) {
		const location = global.location;
		const base = new URL(options.baseUrl || ".", global.document.baseURI);
		if (base.origin !== location.origin) throw new Error("Tool Inspector API must use the application's own origin.");
		base.pathname = base.pathname.replace(/\/?$/, "/");
		base.search = "";
		base.hash = "";
		const url = new URL(path, base);
		try {
			const token = global.localStorage.getItem("pi-web-ui:token");
			if (token) url.searchParams.set("token", token);
		} catch {
			/* HttpOnly authentication cookie remains available. */
		}
		return url;
	}
	function setError(state, message) {
		if (current !== state) return;
		const error = state.root.querySelector(".pti-error");
		error.textContent = message || "";
		error.hidden = !message;
	}
	function drawList(state) {
		const tools = state.snapshot ? state.snapshot.tools : [];
		const expanded = new Set();
		for (const details of state.root.querySelectorAll("details[data-tool-details][open]")) {
			expanded.add(details.dataset.toolDetails);
		}
		state.root.querySelector(".pti-content").innerHTML = state.snapshot
			? renderToolList(state.snapshot, {
					search: state.search,
					source: state.source,
					scope: state.scope,
					busy: state.busy,
					expanded,
					drafts: state.drafts,
				})
			: '<p class="pti-empty">Loading tools…</p>';
		state.root.querySelector(".pti-content").setAttribute("aria-busy", String(state.busy));
		state.root.querySelector(".pti-meta").textContent = state.snapshot
			? `${tools.filter((tool) => tool.active).length} active · ${tools.filter((tool) => !tool.enabled).length} disabled · ${tools.length} registered`
			: "Loading tool catalog";
		state.root.querySelector("[data-action=scope]").disabled = state.busy;
		for (const button of state.root.querySelectorAll("[data-source]")) {
			button.setAttribute("aria-pressed", String(button.dataset.source === state.source));
		}
	}
	async function request(state, update) {
		const url = endpoint(state.options, update ? "api/tool-inspector/update" : "api/tool-inspector");
		const init = { credentials: "same-origin", signal: state.abort.signal };
		if (update) {
			init.method = "POST";
			init.headers = { "Content-Type": "application/json" };
			init.body = JSON.stringify({ clientId: state.options.clientId, convId: state.options.convId, update });
		} else {
			url.searchParams.set("clientId", state.options.clientId);
			url.searchParams.set("convId", state.options.convId);
		}
		const response = await (state.options.fetch || global.fetch)(url, init);
		let body;
		try {
			body = await response.json();
		} catch {
			throw new Error(`Tool Inspector returned an invalid response (${response.status}).`);
		}
		if (!response.ok) throw new Error(body.error || `Tool Inspector request failed (${response.status}).`);
		if (!body || !Array.isArray(body.tools)) throw new Error("Tool Inspector returned an invalid catalog.");
		return body;
	}
	async function load(state, update) {
		if (current !== state || state.busy) return;
		state.busy = true;
		setError(state, "");
		const focused = global.document.activeElement;
		const focusedRow = focused && focused.closest("[data-tool-index]");
		const focusedName = focusedRow && state.snapshot && state.snapshot.tools[Number(focusedRow.dataset.toolIndex)].name;
		const focusedSelector =
			focused &&
			(focused.dataset.action === "toggle"
				? "[data-action=toggle]"
				: focused.dataset.action === "reset"
					? "[data-action=reset]"
					: focused.type === "submit"
						? "[type=submit]"
						: focused.name === "customDescription"
							? "[name=customDescription]"
							: focused.name === "promptRule"
								? "[name=promptRule]"
								: null);
		state.root.querySelector(".pti-content").setAttribute("aria-busy", "true");
		// Drafts survive failures, filtering, refreshes and scope changes.
		for (const control of state.root.querySelectorAll(".pti-content input,.pti-content button,.pti-content textarea"))
			control.disabled = true;
		state.root.querySelector("[data-action=scope]").disabled = true;
		try {
			const snapshot = await request(state, update);
			if (current !== state || state.generation !== generation) return;
			state.snapshot = snapshot;
			if (update && (Object.hasOwn(update, "customDescription") || Object.hasOwn(update, "promptRule"))) {
				state.drafts.delete(JSON.stringify([update.scope || "chat", update.toolName]));
			}
			state.busy = false;
			drawList(state);
			if (focusedName && focusedSelector) {
				for (const row of state.root.querySelectorAll("[data-tool-index]")) {
					if (snapshot.tools[Number(row.dataset.toolIndex)].name === focusedName)
						row.querySelector(focusedSelector)?.focus();
				}
			}
		} catch (error) {
			if (current !== state || error.name === "AbortError") return;
			state.busy = false;
			state.root.querySelector(".pti-content").setAttribute("aria-busy", "false");
			for (const control of state.root.querySelectorAll(".pti-content input,.pti-content button,.pti-content textarea"))
				control.disabled = false;
			state.root.querySelector("[data-action=scope]").disabled = false;
			// Failed toggle: put the switch back to the server-confirmed value.
			for (const row of state.root.querySelectorAll("[data-tool-index]")) {
				const tool = state.snapshot && state.snapshot.tools[Number(row.dataset.toolIndex)];
				if (tool) row.querySelector("[data-action=toggle]").checked = tool.enabled;
			}
			setError(state, error.message || "Could not load tools. Retry when the connection is back.");
		}
	}
	function close() {
		if (!current) return;
		const state = current;
		current = null;
		generation++;
		state.abort.abort();
		global.document.removeEventListener("keydown", state.keydown);
		state.root.remove();
		if (state.previousFocus && state.previousFocus.isConnected) state.previousFocus.focus();
	}
	async function open(options = {}) {
		if (!global.document) throw new Error("Tool Inspector requires a browser document.");
		if (!options.clientId || !options.convId) throw new Error("Select a chat before opening Tool Inspector.");
		close();
		const doc = global.document;
		injectStyles(doc);
		const root = doc.createElement("div");
		root.className = "pti-overlay";
		root.innerHTML = `<section class="pti-drawer" role="dialog" aria-modal="true" aria-labelledby="pti-title"><header><div><h2 id="pti-title">Tool Inspector</h2><p class="pti-meta" role="status">Loading tool catalog</p></div><button type="button" class="pti-close" data-action="close" aria-label="Close Tool Inspector">×</button></header><div class="pti-controls"><input type="search" data-action="search" placeholder="Search tools, descriptions or sources" aria-label="Search tools"><div class="pti-filters" aria-label="Tool sources">${sources.map((source) => `<button type="button" data-source="${source}" aria-pressed="${source === "all"}">${source === "all" ? "All" : source}</button>`).join("")}</div><label class="pti-scope">Change settings for <select data-action="scope"><option value="chat">This chat only</option><option value="workspace">Workspace (all its chats)</option></select></label><button type="button" data-action="reload">Refresh catalog</button></div><p class="pti-error" role="alert" hidden></p><div class="pti-content" aria-busy="true"><p class="pti-empty">Loading tools…</p></div></section>`;
		const state = {
			root,
			options: { ...options },
			previousFocus: doc.activeElement,
			snapshot: null,
			search: "",
			source: "all",
			scope: "chat",
			busy: false,
			drafts: new Map(),
			abort: new AbortController(),
			generation: ++generation,
		};
		current = state;
		state.keydown = (event) => {
			if (event.key === "Escape") {
				event.preventDefault();
				close();
				return;
			}
			if (event.key !== "Tab") return;
			const controls = [
				...root.querySelectorAll(
					"button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary",
				),
			].filter((node) => node.getClientRects().length);
			const first = controls[0],
				last = controls[controls.length - 1];
			if (event.shiftKey && (doc.activeElement === first || !root.contains(doc.activeElement))) {
				event.preventDefault();
				last && last.focus();
			} else if (!event.shiftKey && (doc.activeElement === last || !root.contains(doc.activeElement))) {
				event.preventDefault();
				first && first.focus();
			}
		};
		doc.addEventListener("keydown", state.keydown);
		const toolAt = (target) => {
			const row = target.closest("[data-tool-index]");
			return row && state.snapshot && state.snapshot.tools[Number(row.dataset.toolIndex)];
		};
		root.addEventListener("click", (event) => {
			if (event.target === root || event.target.closest('[data-action="close"]')) {
				close();
				return;
			}
			const filter = event.target.closest("[data-source]");
			if (filter) {
				state.source = filter.dataset.source;
				drawList(state);
				return;
			}
			if (event.target.closest('[data-action="reload"]')) {
				if (!state.busy) void load(state);
				return;
			}
			const reset = event.target.closest('[data-action="reset"]');
			if (reset && !state.busy) {
				const tool = toolAt(reset);
				if (tool)
					void load(
						state,
						buildUpdate(tool.name, { enabled: null, customDescription: null, promptRule: null }, state.scope),
					);
			}
		});
		root.addEventListener("input", (event) => {
			if (event.target.dataset.action === "search") {
				state.search = event.target.value;
				drawList(state);
				return;
			}
			const tool = toolAt(event.target);
			const form = event.target.closest("form");
			if (tool && form)
				state.drafts.set(JSON.stringify([state.scope, tool.name]), Object.fromEntries(new FormData(form)));
		});
		root.addEventListener("change", (event) => {
			if (event.target.dataset.action === "scope") {
				state.scope = event.target.value;
				drawList(state);
				return;
			}
			if (event.target.dataset.action !== "toggle" || state.busy) return;
			const tool = toolAt(event.target);
			if (tool) void load(state, buildUpdate(tool.name, { enabled: event.target.checked }, state.scope));
		});
		root.addEventListener("submit", (event) => {
			event.preventDefault();
			if (state.busy) return;
			const tool = toolAt(event.target);
			if (!tool) return;
			const values = Object.fromEntries(new FormData(event.target));
			void load(
				state,
				buildUpdate(
					tool.name,
					{
						customDescription: String(values.customDescription || "").trim() || null,
						promptRule: String(values.promptRule || "").trim() || null,
					},
					state.scope,
				),
			);
		});
		doc.body.append(root);
		root.querySelector("[data-action=search]").focus();
		await load(state);
	}
	global.PiToolInspector = Object.freeze({
		open,
		close,
		refresh: () => current && load(current),
		helpers: Object.freeze({
			escapeHtml,
			filterTools,
			formatSchema,
			renderParameters,
			renderToolRow,
			renderToolList,
			buildUpdate,
		}),
	});
})(globalThis);
