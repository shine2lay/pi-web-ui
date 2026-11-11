export const TASKS_ROLES_V8_DAG_CSS = `
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
`;
