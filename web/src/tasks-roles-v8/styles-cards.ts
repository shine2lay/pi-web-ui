export const TASKS_ROLES_V8_CARDS_CSS = `
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
.app-shell .search-input {
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

.tasks-pagination-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 9px 14px;
  background: var(--bg-surface);
  border-top: 1px solid var(--border-default);
}
.pagination-btn {
  min-height: 30px;
  min-width: 30px;
  padding: 4px 12px;
  font-weight: 600;
  box-shadow: var(--keycap-shadow);
}
.pagination-btn:disabled,
.pagination-btn[aria-disabled="true"] {
  opacity: 0.45;
  cursor: not-allowed;
}
.pagination-status {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-secondary);
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
  .app-shell .topbar, .ask-card, .role-card {
    padding: 9px 10px;
    margin-bottom: 8px;
  }
}
`;
