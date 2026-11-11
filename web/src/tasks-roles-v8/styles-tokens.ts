export const TASKS_ROLES_V8_TOKENS_CSS = `
/* =========================================================================
   TASKS & ROLES REWORK v8 DESIGN SYSTEM (d_mbpt6ok4gx v8, m29504)
   Restrained carbon + warm-gold dark palette (#0E0F11 / #101215 / #1A1D22->#14171B),
   Geist + Geist Mono typography, warm gold ON YOU (#F0B95A),
   and StateChip pill badges with 13x13 SVG icons.
   Scoped to .app-shell / .roles-exact-host / .initiatives-exact-host so v8
   tokens never override pi-web-ui's global :root variables.
   ========================================================================= */
.app-shell,
.roles-exact-host,
.initiatives-exact-host,
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
  --v8-cta-text: #0E0F11;
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

.app-shell[data-tasks-roles-v8-theme="light"],
[data-tasks-roles-v8-theme="light"],
html[data-theme="light"] .app-shell,
html[data-theme="light"] .roles-exact-host,
html[data-theme="light"] .initiatives-exact-host {
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
  --v8-cta-text: #FFFFFF;
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

.app-shell .topbar {
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
  color: var(--v8-cta-text);
  border-color: var(--accent-bg);
  font-weight: 650;
}

.choice-btn.secondary {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--border-strong);
}

.app-shell .status-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--border-strong);
}
.app-shell .status-dot.tone-needs_you { background: var(--st-stuck-border); }
.app-shell .status-dot.tone-needs_lead { background: var(--st-asking-border); }
.app-shell .status-dot.tone-blocked   { background: var(--st-blocked-border); }
.app-shell .status-dot.tone-waiting   { background: var(--st-waiting-border); }

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

.app-shell .status-badge {
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
`;
