export const TASKS_ROLES_V8_CSS = `
/* =========================================================================
   TASKS & ROLES REWORK v8 DESIGN SYSTEM (d_mbpt6ok4gx v8, m29504)
   Restrained carbon + warm-gold dark palette (#0E0F11 / #101215 / #1A1D22->#14171B),
   Geist + Geist Mono typography, warm gold ON YOU (#F0B95A),
   and StateChip pill badges with 13x13 SVG icons.
   ========================================================================= */
:root,
html[data-theme="dark"],
html[data-theme="dark"][data-scheme="stone"],
html[data-theme="dark"][data-scheme="slate"],
html[data-theme="dark"][data-scheme="graphite"],
[data-tasks-roles-v8-theme="dark"] {
  --bg-canvas: #0E0F11;
  --bg-surface: #16181B;
  --bg-subtle: #121417;
  --bg-elevated: #1C1F24;
  --bg-gold-tint: #1C170D;
  --border-default: #262A30;
  --border-subtle: #22262B;
  --border-strong: #3A3F46;
  --border-gold: #5A4722;
  --text-primary: #ECEDEE;
  --text-secondary: #C9CDD2;
  --text-muted: #A9AEB6;
  --on-you-bg: #F0B95A;
  --on-you-fg: #17130A;
  --accent-bg: #ECEDEE;
  --accent-text: #0E0F11;
  --accent-soft-bg: #141D28;
  --accent-soft-border: #3D6FA8;
  --accent-soft-text: #9CC7FF;
  --card-elevated-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
  --hero-tint-bg: #16181B;

  --st-stuck-bg: #241D11;
  --st-stuck-border: #6E5322;
  --st-stuck-text: #F0B95A;
  --row-stuck-bg: linear-gradient(90deg, rgba(240, 185, 90, 0.08) 0%, rgba(25, 28, 32, 0.96) 28%, #15181C 100%);

  --st-asking-bg: #1F1B14;
  --st-asking-border: #4D3F28;
  --st-asking-text: #E5C07B;
  --row-asking-bg: linear-gradient(90deg, rgba(229, 192, 123, 0.05) 0%, #171A1E 24%, #14171B 100%);

  --st-blocked-bg: #1F1B14;
  --st-blocked-border: #4D3F28;
  --st-blocked-text: #E5C07B;
  --row-blocked-bg: linear-gradient(90deg, rgba(229, 192, 123, 0.05) 0%, #171A1E 24%, #14171B 100%);

  --st-waiting-bg: #1F1B14;
  --st-waiting-border: #4D3F28;
  --st-waiting-text: #E5C07B;
  --row-waiting-bg: linear-gradient(90deg, rgba(229, 192, 123, 0.05) 0%, #171A1E 24%, #14171B 100%);

  --st-paused-bg: #181B20;
  --st-paused-border: #2E333B;
  --st-paused-text: #B8BEC7;

  --st-queued-bg: #181B20;
  --st-queued-border: #2E333B;
  --st-queued-text: #C9CDD2;

  --st-working-bg: #161C24;
  --st-working-border: #2B3B4E;
  --st-working-text: #B8D4F8;

  --st-landing-bg: #161C24;
  --st-landing-border: #2B3B4E;
  --st-landing-text: #B8D4F8;

  --st-landed-bg: #161F20;
  --st-landed-border: #28403E;
  --st-landed-text: #A8D5CE;

  --st-deploying-bg: #15201A;
  --st-deploying-border: #274735;
  --st-deploying-text: #9CE0B2;

  --st-live-bg: #15201A;
  --st-live-border: #274735;
  --st-live-text: #9CE0B2;

  --st-done-bg: #181B20;
  --st-done-border: #2E333B;
  --st-done-text: #B8BEC7;

  --warn-box-bg: #1C1811;
  --warn-box-border: #4D3F28;
  --warn-box-text: #E5C07B;
  --wait-box-bg: #1C1811;
  --wait-box-border: #4D3F28;
  --wait-box-text: #E5C07B;
  --ask-box-bg: #1C1811;
  --ask-box-border: #4D3F28;
  --ask-box-text: #E5C07B;
  --danger-box-bg: #221A10;
  --danger-box-border: #6E5322;
  --danger-box-text: #F0B95A;

  --card-grad: linear-gradient(180deg, #1A1D22 0%, #14171B 100%);
  --card-grad-hover: linear-gradient(180deg, #1E2228 0%, #171A1F 100%);
  --card-well-bg: #101215;
  --card-rim-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06), 0 4px 12px rgba(0, 0, 0, 0.32);
  --card-rim-shadow-hover: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 8px 20px rgba(0, 0, 0, 0.45);
  --keycap-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05), 0 1px 2px rgba(0, 0, 0, 0.35);

  --dept-design: #F0B95A;
  --dept-frontend: #60A5FA;
  --dept-backend: #34D399;
  --dept-qa: #F472B6;
  --dept-ops: #FB923C;
  --dept-architecture: #38BDF8;
  --root-blocker-marker: #F0B95A;
}

html[data-theme="light"],
html[data-theme="light"][data-scheme="stone"],
html[data-theme="light"][data-scheme="slate"],
html[data-theme="light"][data-scheme="graphite"],
[data-tasks-roles-v8-theme="light"] {
  --bg-canvas: #F3F4F6;
  --bg-surface: #FFFFFF;
  --bg-subtle: #F8F9FA;
  --bg-elevated: #EBEEF2;
  --bg-gold-tint: #FFFBEB;
  --border-default: #D5DAE2;
  --border-subtle: #E2E5EC;
  --border-strong: #8C96A6;
  --border-gold: #D99B26;
  --text-primary: #111317;
  --text-secondary: #374151;
  --text-muted: #525B69;
  --on-you-bg: #F0B95A;
  --on-you-fg: #17130A;
  --accent-bg: #111317;
  --accent-text: #FFFFFF;
  --accent-soft-bg: #EBF3FF;
  --accent-soft-border: #5B8FD6;
  --accent-soft-text: #184E8C;
  --card-elevated-shadow: 0 6px 18px rgba(15, 23, 42, 0.07);
  --hero-tint-bg: #FFFFFF;

  --st-stuck-bg: #FDE68A;
  --st-stuck-border: #D99B26;
  --st-stuck-text: #78350F;
  --row-stuck-bg: linear-gradient(90deg, rgba(245, 158, 11, 0.10) 0%, #FFFFFF 30%, #F9FAFB 100%);

  --st-asking-bg: #FEF7E0;
  --st-asking-border: #D99B26;
  --st-asking-text: #78350F;
  --row-asking-bg: linear-gradient(90deg, rgba(245, 158, 11, 0.05) 0%, #FFFFFF 28%, #F9FAFB 100%);

  --st-blocked-bg: #FEF7E0;
  --st-blocked-border: #D99B26;
  --st-blocked-text: #78350F;
  --row-blocked-bg: linear-gradient(90deg, rgba(245, 158, 11, 0.05) 0%, #FFFFFF 28%, #F9FAFB 100%);

  --st-waiting-bg: #FEF7E0;
  --st-waiting-border: #D99B26;
  --st-waiting-text: #78350F;
  --row-waiting-bg: linear-gradient(90deg, rgba(245, 158, 11, 0.05) 0%, #FFFFFF 28%, #F9FAFB 100%);

  --st-paused-bg: #F1F3F5;
  --st-paused-border: #9CA3AF;
  --st-paused-text: #374151;

  --st-queued-bg: #F1F5F9;
  --st-queued-border: #94A3B8;
  --st-queued-text: #334155;

  --st-working-bg: #EBF3FF;
  --st-working-border: #7BA7E0;
  --st-working-text: #184E8C;

  --st-landing-bg: #EBF3FF;
  --st-landing-border: #7BA7E0;
  --st-landing-text: #184E8C;

  --st-landed-bg: #E6F4F1;
  --st-landed-border: #5EA8A0;
  --st-landed-text: #134E4A;

  --st-deploying-bg: #E6F6EC;
  --st-deploying-border: #5CA977;
  --st-deploying-text: #14532D;

  --st-live-bg: #E6F6EC;
  --st-live-border: #5CA977;
  --st-live-text: #14532D;

  --st-done-bg: #F1F5F9;
  --st-done-border: #94A3B8;
  --st-done-text: #334155;

  --warn-box-bg: #FEF3C7;
  --warn-box-border: #D99B26;
  --warn-box-text: #78350F;
  --wait-box-bg: #FEF3C7;
  --wait-box-border: #D99B26;
  --wait-box-text: #78350F;
  --ask-box-bg: #FEF3C7;
  --ask-box-border: #D99B26;
  --ask-box-text: #78350F;
  --danger-box-bg: #FEF3C7;
  --danger-box-border: #D99B26;
  --danger-box-text: #78350F;

  --card-grad: linear-gradient(180deg, #FFFFFF 0%, #F9FAFB 100%);
  --card-grad-hover: linear-gradient(180deg, #FFFFFF 0%, #F3F4F6 100%);
  --card-well-bg: #F1F3F6;
  --card-rim-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 2px 6px rgba(15, 23, 42, 0.06);
  --card-rim-shadow-hover: inset 0 1px 0 rgba(255, 255, 255, 1), 0 6px 14px rgba(15, 23, 42, 0.1);
  --keycap-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.8), 0 1px 2px rgba(15, 23, 42, 0.06);

  --dept-design: #B45309;
  --dept-frontend: #1D4ED8;
  --dept-backend: #047857;
  --dept-qa: #BE185D;
  --dept-ops: #C2410C;
  --dept-architecture: #0369A1;
  --root-blocker-marker: #B45309;
}

[data-dept-role="design"], [data-dept-swatch="design"] { --dept-color: var(--dept-design); }
[data-dept-role="frontend"], [data-dept-swatch="frontend"] { --dept-color: var(--dept-frontend); }
[data-dept-role="backend"], [data-dept-swatch="backend"] { --dept-color: var(--dept-backend); }
[data-dept-role="qa"], [data-dept-swatch="qa"] { --dept-color: var(--dept-qa); }
[data-dept-role="ops"], [data-dept-swatch="ops"] { --dept-color: var(--dept-ops); }
[data-dept-role="architecture"], [data-dept-swatch="architecture"] { --dept-color: var(--dept-architecture); }
[data-dept-role="temper"], [data-dept-swatch="temper"] { --dept-color: var(--dept-backend); }
[data-dept-role="systems"], [data-dept-swatch="systems"] { --dept-color: var(--dept-ops); }
[data-dept-role="security"], [data-dept-swatch="security"] { --dept-color: var(--dept-qa); }
[data-dept-role="product"], [data-dept-swatch="product"] { --dept-color: var(--dept-design); }
[data-dept-role="data"], [data-dept-swatch="data"] { --dept-color: var(--dept-architecture); }
[data-dept-role="docs"], [data-dept-swatch="docs"] { --dept-color: var(--dept-frontend); }
[data-dept-role="marketing"], [data-dept-swatch="marketing"] { --dept-color: var(--dept-qa); }
[data-dept-role="coo"], [data-dept-swatch="coo"] { --dept-color: var(--dept-design); }
[data-dept-role="rollcall"], [data-dept-swatch="rollcall"] { --dept-color: var(--dept-backend); }

.roles-exact-host,
.initiatives-exact-host {
  min-height: 100vh;
  width: 100%;
  margin: 0;
  padding: 0;
  background: var(--bg-canvas);
  color: var(--text-primary);
  overflow-x: hidden;
}

.app-shell {
  max-width: 1380px;
  margin: 0 auto;
  padding: 12px 16px 48px;
  background: var(--bg-canvas);
  color: var(--text-primary);
  font-family: 'Geist', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  font-size: 14px;
  line-height: 1.45;
}

.app-shell *, .app-shell *::before, .app-shell *::after {
  box-sizing: border-box;
}

.app-shell button, .app-shell a, .app-shell select {
  font-family: inherit;
  font-size: 14px;
  line-height: 1.3;
  min-height: 30px;
  min-width: 30px;
  cursor: pointer;
}

.app-shell button:focus-visible, .app-shell a:focus-visible {
  outline: 2px solid var(--accent-bg);
  outline-offset: 2px;
}

.topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 14px;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border-subtle);
  border-radius: 0;
  margin-bottom: 10px;
}

.brand-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 14px;
}

.brand-title {
  font-size: 26px;
  font-weight: 700;
  margin: 0;
  letter-spacing: -0.015em;
}

.brand-subtitle {
  font-size: 14px;
  color: var(--text-muted);
  font-weight: 450;
}

.roles-live-pill {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 30px;
  padding: 0 11px;
  border-radius: 999px;
  border: 1px solid var(--st-live-border);
  background: var(--st-live-bg);
  color: var(--st-live-text);
  font-size: 14px;
  font-weight: 550;
  white-space: nowrap;
}

.on-you-badge {
  display: inline-flex;
  align-items: center;
  height: 19px;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--on-you-bg);
  color: var(--on-you-fg);
  font-size: 14px;
  font-weight: 700;
  letter-spacing: 0.04em;
  white-space: nowrap;
}

.seg-group {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 4px;
  background: var(--bg-surface);
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--border-default);
}

.seg-btn {
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  padding: 6px 12px;
  border-radius: 7px;
  font-weight: 600;
  font-size: 14px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.seg-btn[aria-pressed="true"] {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
  border-color: var(--accent-soft-border);
}

.controls-right {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.choice-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.choice-btn {
  padding: 7px 14px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
}

.choice-btn.primary-cta {
  background: var(--accent-bg);
  color: var(--accent-text);
  border-color: var(--accent-bg);
  font-weight: 650;
}

.choice-btn.secondary {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--border-strong);
}

.status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--border-strong);
}
.status-dot.tone-needs_you { background: var(--st-stuck-border); }
.status-dot.tone-needs_lead { background: var(--st-asking-border); }
.status-dot.tone-blocked   { background: var(--st-blocked-border); }
.status-dot.tone-waiting   { background: var(--st-waiting-border); }

.chip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
}

.chip-btn[aria-pressed="true"] {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
  border-color: var(--accent-soft-border);
  font-weight: 700;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  border: 1px solid var(--border-default);
  white-space: nowrap;
}

.status-stuck, .status-needs_you { background: var(--st-stuck-bg); border-color: var(--st-stuck-border); color: var(--st-stuck-text); }
.status-asking, .status-needs_lead { background: var(--st-asking-bg); border-color: var(--st-asking-border); color: var(--st-asking-text); }
.status-blocked, .status-stalled { background: var(--st-blocked-bg); border-color: var(--st-blocked-border); color: var(--st-blocked-text); }
.status-waiting { background: var(--st-waiting-bg); border-color: var(--st-waiting-border); color: var(--st-waiting-text); }
.status-paused { background: var(--st-paused-bg); border-color: var(--st-paused-border); color: var(--st-paused-text); }
.status-queued { background: var(--st-queued-bg); border-color: var(--st-queued-border); color: var(--st-queued-text); }
.status-working { background: var(--st-working-bg); border-color: var(--st-working-border); color: var(--st-working-text); }
.status-landing { background: var(--st-landing-bg); border-color: var(--st-landing-border); color: var(--st-landing-text); }
.status-landed, .status-landed_pending_deploy { background: var(--st-landed-bg); border-color: var(--st-landed-border); color: var(--st-landed-text); }
.status-deploying { background: var(--st-deploying-bg); border-color: var(--st-deploying-border); color: var(--st-deploying-text); }
.status-live { background: var(--st-live-bg); border-color: var(--st-live-border); color: var(--st-live-text); }
.status-done { background: var(--st-done-bg); border-color: var(--st-done-border); color: var(--st-done-text); }

.touch-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 14px;
  font-weight: 700;
  background: var(--bg-elevated);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
}

.tag-pill {
  display: inline-flex;
  align-items: center;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 600;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border: 1px solid var(--border-default);
}

.ask-card, .role-card {
  background: var(--card-grad);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 14px;
  box-shadow: var(--card-rim-shadow);
}

.ask-card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 10px;
}

.ask-title-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.ask-title {
  font-size: 17px;
  font-weight: 700;
  margin: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.ask-meta-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.handoff-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  margin-bottom: 12px;
}

.handoff-label {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-secondary);
  margin-right: 4px;
}

.handoff-step {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}

.handoff-step[aria-pressed="true"] {
  border: 2px solid var(--accent-bg);
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
}

.handoff-graph {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 0 0;
  margin-bottom: 0;
  background: transparent;
  border: none;
  border-top: 1px solid var(--border-subtle);
  border-radius: 0;
}
.handoff-graph .handoff-label {
  width: auto;
  margin-right: 2px;
  font-weight: 600;
  color: var(--text-muted);
}
.handoff-node {
  display: inline-flex;
  flex-direction: row;
  align-items: center;
  gap: 5px;
  padding: 3px 6px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  min-width: 0;
  flex: 0 1 auto;
  text-align: left;
  overflow: hidden;
}
.handoff-node:hover {
  background: var(--bg-subtle);
  color: var(--text-primary);
}
.handoff-node .status-badge {
  white-space: normal;
  max-width: 100%;
  padding: 2px 6px;
  line-height: 1.2;
}
.handoff-node[aria-pressed="true"] {
  outline: 2px solid var(--accent-bg);
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
}
.handoff-node.tone-needs_you { color: var(--text-primary); font-weight: 700; }

.handoff-connector-svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  color: var(--text-muted);
}

.task-row {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px 12px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.task-main-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.task-id-title {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 15px;
  font-weight: 700;
}

.task-id {
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  color: var(--text-secondary);
  background: var(--bg-surface);
  padding: 2px 6px;
  border-radius: 4px;
  border: 1px solid var(--border-default);
}

.task-subline {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-secondary);
}

.code-sha {
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  padding: 1px 6px;
  border-radius: 4px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  color: var(--text-primary);
}

.callout-box {
  padding: 8px 10px;
  border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  font-size: 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.callout-box.warn {
  background: var(--warn-box-bg);
  border-color: var(--warn-box-border);
  color: var(--warn-box-text);
}
.callout-box.danger {
  background: var(--danger-box-bg);
  border-color: var(--danger-box-border);
  color: var(--danger-box-text);
}
.callout-box.wait-tone {
  background: var(--wait-box-bg);
  border-color: var(--wait-box-border);
  color: var(--wait-box-text);
}
.callout-box.ask-tone {
  background: var(--ask-box-bg);
  border-color: var(--ask-box-border);
  color: var(--ask-box-text);
}

.dep-chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.dep-chip {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--bg-subtle);
  color: var(--text-primary);
  border: 1px solid var(--border-default);
  font-size: 14px;
  font-weight: 600;
}

.roles-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 14px;
  margin-bottom: 16px;
}

.role-card {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.role-card-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border-default);
}

.role-name {
  font-size: 17px;
  font-weight: 800;
  margin: 0;
}

.role-ask-group {
  background: var(--bg-subtle);
  border: 1px solid var(--border-default);
  border-radius: 8px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.idle-drawer {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 12px 14px;
}

.idle-list {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 10px;
}

.state-card {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  padding: 24px;
  text-align: center;
  margin-bottom: 16px;
}

.skeleton-line {
  height: 20px;
  border-radius: 6px;
  background: var(--bg-elevated);
  margin-bottom: 10px;
}

.why-details {
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 8px 12px;
  margin-bottom: 10px;
}

.why-details summary {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  cursor: pointer;
  min-height: 28px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.why-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  margin-top: 10px;
  font-size: 14px;
  color: var(--text-secondary);
}

.why-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(15, 23, 42, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.why-modal-backdrop[hidden] {
  display: none !important;
}
.why-modal-dialog {
  background: var(--bg-surface);
  color: var(--text-primary);
  border: 2px solid var(--border-strong);
  border-radius: 14px;
  max-width: 960px;
  width: 100%;
  max-height: 88vh;
  overflow-y: auto;
  padding: 16px 18px;
  box-shadow: 0 20px 45px rgba(0, 0, 0, 0.35);
}

.pulse-ring-wrap {
  position: relative;
  width: 38px;
  height: 38px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.pulse-ring-label {
  position: absolute;
  font-size: 14px;
  font-weight: 800;
  color: var(--text-primary);
}

.how-to-unblock-banner {
  padding: 0;
  border-radius: 0;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.how-to-unblock-banner strong {
  color: var(--text-primary);
}

.sequence-section {
  border-top: 1px solid var(--border-default);
  padding-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.seq-stage-block {
  position: relative;
  padding-left: 14px;
  border-left: 3px solid var(--border-strong);
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 4px;
}
.seq-stage-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 800;
  color: var(--text-primary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-default);
  padding: 2px 9px;
  border-radius: 999px;
  width: fit-content;
}
.seq-root-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 7px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 700;
  background: var(--warn-box-bg);
  color: var(--warn-box-text);
  border: 1px solid var(--warn-box-border);
}
.seq-edge-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 0;
  border-radius: 0;
  font-size: 14px;
  font-weight: 600;
  background: transparent;
  color: var(--text-secondary);
  border: none;
}

.pipeline-meter {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 6px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  font-size: 14px;
}
.pipe-step {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-muted);
}
.pipe-step.done {
  color: var(--st-live-text);
  font-weight: 700;
}
.pipe-step.current {
  color: var(--accent-soft-text);
  background: var(--accent-soft-bg);
  border: 1px solid var(--accent-soft-border);
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 800;
}

.tier-section-header {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin: 6px 0 -2px;
}
.tier-section-title {
  font-size: 14px;
  font-weight: 800;
  letter-spacing: 0.01em;
  color: var(--text-primary);
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 0;
}
.tier-section-title.muted {
  color: var(--text-muted);
  font-weight: 700;
}
.tier-count-pill {
  display: inline-flex;
  align-items: center;
  padding: 1px 8px;
  border-radius: 999px;
  font-size: 14px;
  font-weight: 700;
  background: var(--bg-elevated);
  color: var(--text-primary);
}

.dag-header-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 6px;
}
.dag-header-title {
  margin: 0;
  font-size: 16px;
  font-weight: 750;
  color: var(--text-primary);
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 6px;
  min-width: 0;
}
.dag-header-meta {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-secondary);
}
.dag-header-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  max-width: 100%;
}
.dag-tag-select {
  min-height: 28px;
  padding: 2px 8px;
  border-radius: 7px;
  border: 1px solid var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 600;
  max-width: 100%;
}
.dag-tag-select:focus,
.dag-tag-select:focus-visible,
.dag-dept-chip:focus,
.dag-dept-chip:focus-visible,
.dag-node-status-btn:focus,
.dag-node-status-btn:focus-visible,
.dag-col-overflow-btn:focus,
.dag-col-overflow-btn:focus-visible {
  outline: 2px solid var(--accent-bg);
  outline-offset: 2px;
}
.dag-dept-legend {
  position: relative;
  z-index: 3;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 5px;
  margin-bottom: 6px;
}
.dag-dept-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 26px;
  min-width: 26px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-default);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
}
.dag-dept-chip[aria-pressed="true"] {
  outline: 2px solid var(--accent-bg);
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
}
.dag-dept-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--dept-color, var(--accent-bg));
}
.dag-status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  background: currentColor;
}
.dag-root-marker {
  position: absolute;
  top: -4px;
  left: -4px;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--root-blocker-marker);
  border: 2px solid var(--bg-surface);
  z-index: 4;
}
.dag-node-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
}
.dag-node-title {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-primary);
  line-height: 1.32;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.dag-node-status-btn {
  cursor: pointer;
  min-height: 26px;
  padding: 2px 8px;
  gap: 5px;
}
.dag-col-overflow-btn {
  width: 100%;
  justify-content: center;
  min-height: 30px;
  padding: 4px 10px;
  font-weight: 650;
  background: var(--bg-surface);
  border: 1px dashed var(--border-strong);
}
.dag-detail-panel {
  position: absolute;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: min(400px, calc(100% - 16px));
  z-index: 12;
  overflow-y: auto;
  background: var(--bg-surface);
  border: 2px solid var(--border-strong);
  border-radius: 10px;
  padding: 12px 14px;
  box-shadow: var(--card-elevated-shadow);
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.dag-footer-unblock {
  margin-top: 6px;
  padding-top: 6px;
  border-top: 1px solid var(--border-subtle);
  font-size: 14px;
  color: var(--text-secondary);
}

.dag-board {
  position: relative;
  min-height: 240px;
  background-color: var(--bg-subtle);
  background-image: radial-gradient(var(--border-default) 1px, transparent 1px);
  background-size: 14px 14px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  padding: 8px;
  overflow: hidden;
}
.dag-edges-svg {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  z-index: 1;
  overflow: visible;
}
.dag-columns {
  position: relative;
  z-index: 2;
  display: grid;
  grid-template-columns: repeat(var(--dag-cols, 3), minmax(0, 1fr));
  gap: 18px;
  align-items: start;
}
.dag-stage-col {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dag-stage-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 4px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--bg-surface);
  border: 1px solid var(--border-strong);
  font-size: 14px;
  font-weight: 800;
  color: var(--text-primary);
}
.dag-stage-nodes {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}
.dag-node-card {
  position: relative;
  background: var(--bg-surface) !important;
  border: 1px solid var(--border-default) !important;
  border-left: 3px solid var(--dept-color, var(--border-strong)) !important;
  box-shadow: var(--card-rim-shadow) !important;
  border-radius: 8px !important;
  padding: 5px 9px;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  overflow-wrap: break-word;
  word-break: break-word;
}
.dag-node-card[data-root-blocker-node="true"] {
  border-left: 4px solid var(--root-blocker-marker) !important;
  box-shadow: 0 0 0 1.5px var(--root-blocker-marker), var(--card-rim-shadow) !important;
}
.dag-node-card .status-badge,
.dag-node-card .dep-chip,
.dag-node-card .seq-edge-pill,
.dag-node-card .seq-stage-pill {
  white-space: normal;
  max-width: 100%;
}
.dag-port {
  position: absolute;
  top: 20px;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--bg-surface);
  border: 2px solid var(--border-strong);
  z-index: 3;
}
.dag-port-in  { left: -5px; }
.dag-port-out { right: -5px; }

.unified-tasks-panel {
  background: var(--card-well-bg);
  border: 1px solid var(--border-default);
  border-radius: 14px;
  box-shadow: inset 0 2px 6px rgba(0, 0, 0, 0.35);
  overflow: hidden;
}
.unified-tasks-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px;
  background: var(--bg-surface);
  border-bottom: 1px solid var(--border-default);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
}
.unified-task-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
}
.unified-task-item {
  border: 1px solid var(--border-default);
  border-radius: 10px;
  background: var(--card-grad);
  box-shadow: var(--card-rim-shadow);
  transition: transform 120ms ease, box-shadow 120ms ease, border-color 120ms ease;
}
.unified-task-item:hover {
  background: var(--card-grad-hover);
  border-color: var(--border-strong);
  box-shadow: var(--card-rim-shadow-hover);
  transform: translateY(-1px);
}
.unified-task-item[data-status-tone="needs_you"] {
  background: var(--row-stuck-bg);
  border-color: var(--st-stuck-border);
  box-shadow: inset 3px 0 0 var(--on-you-bg), var(--card-rim-shadow);
}
.unified-task-item[data-status-tone="blocked"],
.unified-task-item[data-status-tone="waiting"],
.unified-task-item[data-status-tone="needs_lead"] {
  background: var(--row-blocked-bg);
  box-shadow: inset 3px 0 0 var(--st-blocked-border), var(--card-rim-shadow);
}

.dept-identity-tile {
  display: inline-flex;
  align-items: center;
  gap: 9px;
  padding: 5px 10px 5px 6px;
  border-radius: 8px;
  background: var(--card-well-bg);
  border: 1px solid var(--border-default);
  box-shadow: var(--keycap-shadow);
}
.dept-monogram {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  letter-spacing: -0.02em;
  flex-shrink: 0;
}
.dept-meta-stack {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}
.dept-name-label {
  font-size: 14px;
  font-weight: 650;
  color: var(--text-primary);
}
.task-id-keycap {
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 650;
  color: var(--text-secondary);
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  padding: 1px 6px;
  border-radius: 5px;
}
.app-well-pill {
  font-size: 14px;
  font-weight: 550;
  color: var(--text-muted);
  background: transparent;
  border-left: 1px solid var(--border-default);
  padding-left: 7px;
}

.compact-filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 12px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  margin-bottom: 8px;
}
.filter-dropdowns-group {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filter-dd {
  position: relative;
  display: inline-block;
}
.filter-dd > summary {
  list-style: none;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 32px;
  padding: 4px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.filter-dd > summary::-webkit-details-marker {
  display: none;
}
.filter-dd[open] > summary,
.filter-dd[data-active-filter="true"] > summary {
  background: var(--accent-soft-bg);
  border-color: var(--accent-soft-border);
  color: var(--accent-soft-text);
}
.filter-dd-menu {
  position: absolute;
  top: calc(100% + 6px);
  left: 0;
  z-index: 40;
  min-width: 250px;
  max-width: 320px;
  max-height: 340px;
  overflow-y: auto;
  padding: 8px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: var(--card-elevated-shadow);
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.filter-dd-search {
  width: 100%;
  min-height: 30px;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border-strong);
  background: var(--bg-surface);
  color: var(--text-primary);
  font-size: 14px;
}
.filter-dd-list {
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.filter-dd-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  min-height: 30px;
  padding: 5px 10px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 550;
  text-align: left;
  cursor: pointer;
}
.filter-dd-item:hover {
  background: var(--bg-surface);
  border-color: var(--border-default);
}
.filter-dd-item[aria-pressed="true"] {
  background: var(--accent-soft-bg);
  border-color: var(--accent-soft-border);
  color: var(--accent-soft-text);
  font-weight: 700;
}
.attention-note-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 8px 14px;
  background: var(--card-grad);
  border: 1px solid var(--border-default);
  box-shadow: inset 3px 0 0 var(--on-you-bg), var(--card-rim-shadow);
  border-radius: 12px;
  margin-bottom: 8px;
}
.attention-stat-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 10px;
  border-radius: 7px;
  background: var(--card-well-bg);
  border: 1px solid var(--border-default);
  box-shadow: var(--keycap-shadow);
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
}
.unified-task-line {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 14px;
}
.task-card-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.task-card-heading {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex: 1 1 420px;
}
.task-card-bottom {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--card-well-bg);
  border: 1px solid var(--border-subtle);
  box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.28);
}
.task-col-state {
  display: flex;
  align-items: center;
  gap: 6px;
}
.task-col-dept {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 650;
  color: var(--text-primary);
  white-space: nowrap;
  flex-shrink: 0;
}
.task-col-title {
  font-size: 15px;
  font-weight: 650;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}
.task-col-summary {
  font-size: 14px;
  color: var(--text-secondary);
  min-width: 0;
  flex: 1 1 320px;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.task-col-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 7px;
  flex-shrink: 0;
}
.tag-dag-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-height: 28px;
  padding: 2px 10px;
  border-radius: 7px;
  border: 1px solid var(--border-default);
  background: var(--card-well-bg);
  color: var(--text-secondary);
  box-shadow: var(--keycap-shadow);
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.tag-dag-btn:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
  background: var(--bg-elevated);
}
.tag-dag-btn[aria-pressed="true"] {
  background: var(--accent-soft-bg);
  color: var(--accent-soft-text);
  border-color: var(--accent-soft-border);
}
.search-input {
  min-height: 30px;
  padding: 2px 12px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-subtle);
  color: var(--text-primary);
  font-size: 14px;
  width: 220px;
  max-width: 100%;
}
.roles-lane-pills {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.roles-lane-pill {
  width: 18px;
  height: 8px;
  border-radius: 999px;
  box-sizing: border-box;
  display: inline-block;
}
.roles-lane-pill.busy {
  background: var(--st-working-text);
}
.roles-lane-pill.blocked {
  background: var(--on-you-bg);
}
.roles-lane-pill.free {
  background: transparent;
  border: 1.5px solid var(--border-strong);
}

.dept-queues-strip {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 12px;
  margin-bottom: 10px;
  background: var(--bg-surface);
  border: 1px solid var(--border-default);
  border-radius: 12px;
  box-shadow: var(--card-rim-shadow);
}
.dept-queues-strip-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.dept-strip-pill {
  display: inline-flex;
  align-items: center;
  border-radius: 8px;
  background: var(--card-well-bg);
  border: 1px solid var(--border-default);
  box-shadow: var(--keycap-shadow);
  overflow: hidden;
}
.dept-strip-pill[data-selected="true"] {
  background: var(--accent-soft-bg);
  border-color: var(--accent-soft-border);
}
.dept-strip-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 30px;
  padding: 3px 9px 3px 5px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.dept-strip-all-btn {
  padding: 3px 11px;
  border-radius: 8px;
  background: var(--card-well-bg);
  border: 1px solid var(--border-default);
  box-shadow: var(--keycap-shadow);
}
.dept-strip-btn[aria-pressed="true"] {
  color: var(--accent-soft-text);
}
.dept-strip-all-btn[aria-pressed="true"] {
  background: var(--accent-soft-bg);
  border-color: var(--accent-soft-border);
  color: var(--accent-soft-text);
}
.dept-strip-monogram {
  width: 22px;
  height: 22px;
  border-radius: 5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  flex-shrink: 0;
}
.dept-strip-title {
  font-size: 14px;
  font-weight: 650;
}
.dept-strip-lanes {
  font-family: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 14px;
  font-weight: 550;
  color: var(--text-muted);
}
.dept-strip-chat-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 30px;
  min-width: 30px;
  padding: 0 7px;
  border: none;
  border-left: 1px solid var(--border-default);
  background: transparent;
  color: var(--text-secondary);
  font-size: 14px;
  cursor: pointer;
}
.dept-strip-chat-btn:hover {
  background: var(--bg-elevated);
  color: var(--text-primary);
}

@media (max-width: 980px) {
  .dag-columns {
    grid-template-columns: 1fr !important;
    gap: 10px;
  }
  .handoff-connector-svg {
    display: none;
  }
  .task-col-actions {
    justify-content: flex-start;
  }
  .task-col-summary {
    white-space: normal;
  }
}

@media (max-width: 640px) {
  .dag-dept-legend {
    justify-content: flex-start;
  }
}

@media (max-width: 900px) {
  .roles-grid, .why-grid {
    grid-template-columns: 1fr;
  }
  .app-shell {
    padding: 8px 10px 36px;
  }
  .topbar, .ask-card, .role-card {
    padding: 9px 10px;
    margin-bottom: 8px;
  }
}
`;

export function injectTasksRolesV8Styles(doc: Document = document): HTMLStyleElement {
	const existing = doc.getElementById("tasks-roles-v8-styles") as HTMLStyleElement | null;
	if (existing) return existing;
	const styleEl = doc.createElement("style");
	styleEl.id = "tasks-roles-v8-styles";
	styleEl.textContent = TASKS_ROLES_V8_CSS;
	doc.head.appendChild(styleEl);
	return styleEl;
}
