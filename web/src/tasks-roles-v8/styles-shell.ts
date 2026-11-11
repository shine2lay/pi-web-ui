export const TASKS_ROLES_V8_SHELL_CSS = `
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
`;
