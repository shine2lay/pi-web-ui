/** Project body selectors only: no shared header/grid/map/mini selectors are changed. */
export const PROJECT_PROGRESS_CSS = `
.rbp .rpp{padding:8px 16px 16px;min-width:0;font-size:13px}
.rbp .rpp-main,.rbp .rpp-work{display:flex;flex-direction:column;gap:16px;min-width:0}
.rbp .rpp section{min-width:0}
.rbp .rpp h3{display:flex;align-items:baseline;justify-content:space-between;flex-wrap:wrap;gap:4px 12px;margin:0 0 12px;font-size:12px;font-weight:600;color:var(--text-secondary)}
.rbp .rpp h3 small{font-size:12px;font-weight:400;color:var(--text-muted)}
.rbp .rpp-fraction{font-size:12px;font-weight:400;color:var(--text-muted);white-space:nowrap}
.rbp .rpp-fraction b{font-size:20px;color:var(--text-primary);font-weight:600}
.rbp .rpp-note,.rbp .rpp-warning{margin:0;font-size:12px;color:var(--text-muted);overflow-wrap:anywhere}
.rbp .rpp-warning{color:var(--wt-fg);margin:0 0 12px}
.rbp .rpp-strip{display:flex;gap:4px;height:6px;margin:0 0 12px}
.rbp .rpp-strip i{flex:1;min-width:0;border-radius:3px;background:var(--border-default)}
.rbp .rpp-strip i.is-met{background:var(--ok-bar)}
.rbp .rpp-criteria,.rbp .rpp-tasks{margin:0;padding:0;list-style:none}
.rbp .rpp-criteria{display:flex;flex-direction:column;gap:6px}
.rbp .rpp-criteria li{display:flex;align-items:flex-start;gap:8px;min-width:0}
.rbp .rpp-criteria svg{margin-top:3px;color:var(--text-muted)}
.rbp .rpp-criteria .is-met svg{color:var(--ok-fg)}
.rbp .rpp-number{flex:none;color:var(--text-muted);min-width:12px;text-align:right}
.rbp .rpp-criterion,.rbp .rpp-title{overflow:hidden;white-space:nowrap;text-overflow:ellipsis;min-width:0}
.rbp .rpp-tasks{display:flex;flex-direction:column;gap:12px}
.rbp .rpp-task-head{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:4px;color:var(--text-muted);font-size:12px}
.rbp .rpp-title{margin:0;color:var(--text-primary)}
.rbp .rpp-reason{margin:4px 0 0;font-size:12px;color:var(--text-secondary);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.rbp .rpp-tasks+.rpp-note{margin-top:8px}
.rbp .rpp-activity{border-top:1px solid var(--border-default);margin-top:16px;padding-top:12px}
.rbp .rpp-activity h3{margin-bottom:6px}
.rbp .rpp-activity p{font-size:12px;color:var(--text-muted);margin:0 0 8px}
.rbp .rpp-activity p b{font-size:16px;color:var(--text-primary);font-weight:600}
.rbp .rpp-lifecycle{display:block;margin:0 0 12px;font-size:12px;color:var(--text-muted)}
.rbp .rpp-open .rpp-criterion,.rbp .rpp-open .rpp-title{white-space:normal;overflow:visible;overflow-wrap:anywhere}
.rbp .rpp-open .rpp-reason{display:block;overflow:visible}
.rbp .rpp>.rbp-gbody{margin:16px -16px -16px}
@media(min-width:641px){
 .rbp .is-l .rpp-main{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:16px}
 .rbp .is-l .rpp:not(.rpp-open) .rpp-title{display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;white-space:normal;overflow-wrap:anywhere}
}
`;
