/**
 * roles-by-project page CSS (design.md; prototype roles-grouping-20261115). Every colour is a v8 carbon token
 * (styles-tokens.ts) or a state colour the live pages already use: working blue #7DB8FF and done green #9FD8B8
 * (exact-surface.ts:25/34), coral #FF8A80 and lilac #C7B8FF (initiatives-exact-view.ts:53/55), with their
 * light-theme pairs from the design's tokens.css (PROVENANCE.md). Scoped to `.rbp`; no new colours or fonts.
 */
const ALIASES_DARK = `
  --you-fg:var(--st-stuck-text);--you-bg:var(--st-stuck-bg);--you-bd:var(--st-stuck-border);--you-bar:var(--on-you-bg);
  --blk-fg:#FF8A80;--blk-bg:#221415;--blk-bd:#5A2A2C;--blk-bar:#FF8A80;
  --wt-fg:#C7B8FF;--wt-bg:rgba(139,92,246,0.1);--wt-bd:rgba(199,184,255,0.5);--wt-bar:#C7B8FF;
  --wk-fg:var(--st-working-text);--wk-bg:var(--st-working-bg);--wk-bd:var(--st-working-border);--wk-bar:#7DB8FF;
  --q-fg:var(--st-queued-text);--q-bg:var(--st-queued-bg);--q-bd:var(--st-queued-border);--q-bar:var(--border-strong);
  --ok-fg:var(--st-live-text);--ok-bg:var(--st-live-bg);--ok-bd:var(--st-live-border);--ok-bar:#9FD8B8;`;
const ALIASES_LIGHT = `
  --you-fg:var(--st-stuck-text);--you-bg:var(--st-stuck-bg);--you-bd:var(--border-gold);--you-bar:var(--border-gold);
  --blk-fg:#b91c1c;--blk-bg:rgba(185,28,28,0.1);--blk-bd:#fca5a5;--blk-bar:#b91c1c;
  --wt-fg:#6d28d9;--wt-bg:rgba(139,92,246,0.14);--wt-bd:rgba(139,92,246,0.4);--wt-bar:#6d28d9;
  --wk-fg:var(--st-working-text);--wk-bg:var(--st-working-bg);--wk-bd:var(--st-working-border);--wk-bar:var(--st-working-border);
  --q-fg:var(--st-queued-text);--q-bg:var(--st-queued-bg);--q-bd:var(--st-queued-border);--q-bar:var(--st-queued-border);
  --ok-fg:var(--st-live-text);--ok-bg:var(--st-live-bg);--ok-bd:var(--st-live-border);--ok-bar:var(--st-live-border);`;

export const ROLES_BY_PROJECT_CSS = `
.rbp{${ALIASES_DARK}
  --focus:var(--accent-soft-border);--link:var(--accent-soft-text);
  width:100%;height:100%;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--bg-canvas);color:var(--text-primary);
  font-family:var(--sans,system-ui,sans-serif);font-size:14px;line-height:1.45;
  -webkit-font-smoothing:antialiased;color-scheme:dark}
.rbp[data-tasks-roles-v8-theme="light"]{${ALIASES_LIGHT}color-scheme:light}
.rbp *{box-sizing:border-box}
.rbp .rbp-sr{position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}
.rbp .num,.rbp .mono{font-family:var(--mono,ui-monospace,monospace);font-variant-numeric:tabular-nums}
:where(.rbp) :where(button,input){font:inherit;color:inherit}
.rbp :focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.rbp svg.rbp-i{width:13px;height:13px;flex:none;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.rbp-main{max-width:1280px;margin:0 auto;padding:24px 24px 64px}
.rbp-top{display:flex;justify-content:space-between;align-items:flex-end;gap:16px;flex-wrap:wrap}
.rbp h1{margin:0;font-size:28px;font-weight:700;letter-spacing:-0.015em;line-height:1.15}
.rbp-lede{margin:6px 0 0;font-size:16px;color:var(--text-secondary);max-width:70ch}
.rbp-lede b{color:var(--text-primary);font-weight:600}
.rbp-asof{font-size:12px;color:var(--text-muted)}
.rbp-note{margin:8px 0 0;font-size:12px;color:var(--text-muted)}
.rbp-controls{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin:20px 0 12px}
.rbp-gb{display:flex;align-items:center;gap:8px}
.rbp-gb>span{font-size:12px;color:var(--text-muted);font-weight:600}
.rbp-seg{display:inline-flex;background:var(--bg-subtle);border:1px solid var(--border-default);border-radius:8px;padding:2px}
.rbp-seg button{border:0;background:none;padding:6px 14px;border-radius:6px;color:var(--text-secondary);cursor:pointer;min-height:32px;font-weight:500}
.rbp-seg button[aria-checked="true"]{background:var(--bg-elevated);color:var(--text-primary);font-weight:600;box-shadow:inset 0 0 0 1px var(--border-strong)}
.rbp-seg .rbp-sm{display:none}
.rbp-search{flex:1;min-width:220px;max-width:420px;position:relative}
.rbp-search svg.rbp-i{position:absolute;left:11px;top:50%;transform:translateY(-50%);color:var(--text-muted);width:14px;height:14px}
.rbp-search input{width:100%;background:var(--bg-surface);border:1px solid var(--border-strong);border-radius:8px;padding:8px 12px 8px 32px;min-height:36px}
.rbp-search input::placeholder{color:var(--text-muted)}
.rbp-fleet{display:grid;grid-template-columns:auto minmax(0,1fr);gap:6px 16px;align-items:center;margin:0 0 20px;padding:12px 16px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px}
.rbp-fleet .rbp-tot{font-size:12px;color:var(--text-muted);white-space:nowrap}
.rbp-fleet .rbp-tot b{font-size:16px;color:var(--text-primary);font-weight:700;margin-right:4px}
.rbp-legend{grid-column:1/-1;display:flex;flex-wrap:wrap;gap:4px 16px;font-size:12px;color:var(--text-secondary)}
.rbp-legend span{display:inline-flex;align-items:center;gap:6px}
.rbp-legend i{width:8px;height:8px;border-radius:2px;display:inline-block}
.rbp-legend b{color:var(--text-primary);font-weight:700}
.rbp-bar{display:flex;gap:1px;height:8px;min-width:0}
.rbp-bar i{flex:1 1 0;border-radius:2px;min-width:0}
.rbp .k-you{background:var(--you-bar)}.rbp .k-blk{background:var(--blk-bar)}.rbp .k-wt{background:var(--wt-bar)}
.rbp .k-wk{background:var(--wk-bar)}.rbp .k-q{background:var(--q-bar)}.rbp .k-ok{background:var(--ok-bar)}
.rbp-ring{width:44px;height:44px;flex:none;position:relative;display:block}
.rbp-ring svg{width:44px;height:44px;transform:rotate(-90deg);display:block}
.rbp-ring circle{fill:none;stroke-width:4}
.rbp-ring .tr{stroke:var(--border-default)}.rbp-ring .pr{stroke:var(--ok-bar);stroke-linecap:round}
.rbp-ring b{position:absolute;inset:0;display:grid;place-items:center;font-size:12px;font-weight:600;color:var(--text-primary)}
.rbp-avatar{width:44px;height:44px;flex:none;border-radius:50%;display:grid;place-items:center;font-weight:700;font-size:14px;border:2px solid var(--dept-color,var(--border-strong));color:var(--text-primary);background:var(--bg-subtle)}
.rbp-sticon{width:44px;height:44px;flex:none;border-radius:50%;display:grid;place-items:center;border:1px solid}
.rbp-sticon svg.rbp-i{width:18px;height:18px}
.rbp-bento{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;grid-auto-flow:row dense;align-items:start}
.rbp-tile{background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;overflow:hidden;min-width:0;box-shadow:inset 0 1px 0 var(--border-subtle)}
.rbp-tile.is-l{grid-column:span 2}
.rbp-tile.is-open{grid-column:1/-1;border-color:var(--border-strong)}
.rbp-tile.is-you{border-color:var(--border-gold)}
.rbp-tile.is-idle{background:var(--bg-subtle)}
.rbp-th{display:grid;grid-template-columns:minmax(0,1fr) 24px;gap:12px;align-items:start;width:100%;text-align:left;background:none;border:0;padding:16px;cursor:pointer;color:inherit}
.rbp-th:hover{background:var(--bg-subtle)}
.rbp-th>.rbp-fig,.rbp-th>.rbp-draw,.rbp-th>.rbp-counts{grid-column:1/-1}
.rbp-th>span{display:block;min-width:0}
.rbp-fig{display:flex !important;align-items:center;gap:16px;flex-wrap:wrap}
.rbp-nums{display:flex;gap:4px 20px;flex-wrap:wrap}
.rbp-nums>span{font-size:12px;color:var(--text-muted)}
.rbp-nums b{display:block;font-size:24px;font-weight:700;color:var(--text-primary);line-height:1.1}
.rbp-nums .c-you,.rbp-nums .c-you b{color:var(--you-fg)}
.rbp-tile.is-idle .rbp-nums b{font-size:16px;color:var(--text-secondary)}
.rbp-draw{display:flex !important;align-items:center;gap:8px;flex-wrap:wrap}
.rbp-draw .rbp-cut{font-size:12px;color:var(--text-muted);white-space:nowrap}
.rbp-tile.is-open .rbp-th>.rbp-draw{display:none !important}
.rbp-thumb{position:relative;max-width:100%;overflow:hidden;display:block}
.rbp-thumb .sq{position:absolute;display:block;border-radius:2px}
.rbp-thumb .f-ok{opacity:.55}
.rbp-counts{font-size:12px;color:var(--text-secondary);display:flex !important;flex-wrap:wrap;gap:2px 10px}
.rbp-counts .c-you{color:var(--you-fg);font-weight:600}
.rbp-gname{display:flex !important;align-items:center;gap:8px;flex-wrap:wrap;min-width:0}
.rbp-gname .rbp-h{margin:0;font-size:16px;font-weight:600;line-height:1.3;overflow-wrap:anywhere}
.rbp-chip{font-size:12px;font-weight:500;color:var(--text-secondary);border:1px solid var(--border-default);border-radius:999px;padding:1px 8px;white-space:nowrap}
.rbp-gmeta{margin-top:4px;font-size:12px;color:var(--text-muted);display:flex !important;flex-wrap:wrap;gap:4px 12px}
.rbp-gmeta .rbp-lead{display:inline-flex;align-items:center;gap:6px;color:var(--text-secondary)}
.rbp-gmeta .rbp-held{color:var(--blk-fg)}
.rbp-sw{width:8px;height:8px;border-radius:50%;background:var(--dept-color,var(--border-strong));display:inline-block;flex:none}
.rbp-chev{color:var(--text-muted);transition:transform .16s ease;display:grid !important;place-items:center;height:24px}
.rbp-chev svg.rbp-i{width:16px;height:16px}
.rbp-tile.is-open .rbp-chev{transform:rotate(180deg)}
.rbp-btn-you{background:var(--on-you-bg);color:var(--on-you-fg);border:0;border-radius:8px;padding:8px 16px;font-weight:600;cursor:pointer;min-height:36px;white-space:nowrap}
.rbp-btn{background:none;border:1px solid var(--border-strong);border-radius:8px;padding:7px 14px;color:var(--text-primary);cursor:pointer;min-height:36px;font-weight:500}
.rbp-btn.is-more{margin-top:8px;font-size:12px;min-height:32px;padding:4px 12px}
.rbp-link{background:none;border:0;color:var(--link);text-decoration:underline;cursor:pointer;padding:4px;min-height:24px}
.rbp-gbody{border-top:1px solid var(--border-default);background:var(--bg-subtle);padding:16px 16px 20px;display:flex;flex-direction:column;gap:20px;animation:rbp-rise .16s ease}
@keyframes rbp-rise{from{transform:translateY(-4px)}to{transform:none}}
.rbp-sec{font-size:12px;font-weight:600;color:var(--text-muted);margin:0 0 8px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rbp-sec b{color:var(--text-primary);font-weight:600}
.rbp-needs{margin:0 0 16px}
.rbp-needs>summary{margin-bottom:8px}
.rbp-strip{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px}
.rbp-askc{background:var(--bg-gold-tint);border:1px solid var(--border-gold);border-radius:12px;padding:12px 16px;display:flex;flex-direction:column;gap:6px;min-width:0}
.rbp-askc[hidden]{display:none}
.rbp-askc .rbp-lbl{display:flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:var(--you-fg)}
.rbp-askc p{margin:0;color:var(--text-primary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.rbp-askc .rbp-foot{display:flex;justify-content:space-between;align-items:center;gap:8px;margin-top:auto;flex-wrap:wrap}
.rbp-askc .rbp-who{font-size:12px;color:var(--text-muted);min-width:0}
.rbp-askc .rbp-who .rbp-link{padding:0 2px;font-size:12px}
.rbp-askc .rbp-why{font-size:12px;color:var(--text-secondary);margin:0}
.rbp-fold>summary{cursor:pointer;list-style:none;display:flex;gap:8px;align-items:center;font-size:12px;font-weight:600;color:var(--text-secondary);min-height:24px}
.rbp-fold>summary::-webkit-details-marker{display:none}
.rbp-fold>summary svg.rbp-i{transition:transform .16s ease}
.rbp-fold[open]>summary svg.rbp-i{transform:rotate(180deg)}
.rbp-fold>.rbp-tasks,.rbp-fold>.rbp-dw,.rbp-fold>.rbp-minis{margin-top:8px}

.rbp-donefold{margin-top:16px}
.rbp-donefold>summary{padding:12px 16px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;font-size:14px}
.rbp-dw{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:4px 24px;margin:0;padding:0;list-style:none}
.rbp-dw li{display:flex;gap:8px;align-items:flex-start;color:var(--text-secondary);font-size:14px}
.rbp-dw li svg.rbp-i{margin-top:3px;color:var(--text-muted)}
.rbp-dw li.is-met{color:var(--text-primary)}.rbp-dw li.is-met svg.rbp-i{color:var(--ok-fg)}
.rbp-dag{position:relative;display:flex;gap:48px;align-items:flex-start;overflow-x:auto;padding:4px 4px 12px}
.rbp-dag .rbp-col{display:flex;flex-direction:column;gap:12px;flex:0 0 240px;position:relative;z-index:1}
.rbp-edges{position:absolute;left:0;top:0;width:0;height:0;pointer-events:none;z-index:0}
.rbp .ln{position:absolute;display:block;border:0 solid var(--border-strong);--r:10px}
.rbp .ln.e-done{border-color:var(--ok-bar)}.rbp .ln.e-blocked{border-color:var(--blk-bar);border-style:dashed}.rbp .ln.e-root{border-color:var(--wk-bar);--w:2.5px}
.rbp .ln.h{border-top-width:var(--w,1.5px)}
.rbp .ln.d1{border-top-width:var(--w,1.5px);border-right-width:var(--w,1.5px);border-top-right-radius:var(--r)}
.rbp .ln.d2{border-left-width:var(--w,1.5px);border-bottom-width:var(--w,1.5px);border-bottom-left-radius:var(--r)}
.rbp .ln.u1{border-bottom-width:var(--w,1.5px);border-right-width:var(--w,1.5px);border-bottom-right-radius:var(--r)}
.rbp .ln.u2{border-top-width:var(--w,1.5px);border-left-width:var(--w,1.5px);border-top-left-radius:var(--r)}
.rbp .ln.br{border-top-width:var(--w,1.5px);border-left-width:var(--w,1.5px);border-bottom-width:var(--w,1.5px);border-radius:var(--r) 0 0 var(--r)}
.rbp .hd{position:absolute;display:block;width:0;height:0;border-top:4px solid transparent;border-bottom:4px solid transparent;border-left:7px solid var(--border-strong)}
.rbp .hd.e-done{border-left-color:var(--ok-bar)}.rbp .hd.e-blocked{border-left-color:var(--blk-bar)}.rbp .hd.e-root{border-left-color:var(--wk-bar)}
.rbp-thumb .ln{--r:4px}
.rbp-tasks{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:8px}
.rbp-task{background:var(--bg-surface);border:1px solid var(--border-subtle);border-radius:8px;padding:12px;display:flex;flex-direction:column;gap:6px;min-width:0}
.rbp-task.is-done{border-color:var(--ok-bd)}
.rbp-task.is-done h4{color:var(--text-secondary);font-weight:400}
.rbp-task.is-root{border:2px solid var(--wk-bd)}
.rbp-task .rbp-row{display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);min-width:0}
.rbp-task .rbp-row>.rbp-pill,.rbp-task .rbp-row>.rbp-id,.rbp-task .rbp-row>.rbp-ord{flex:none}
.rbp-task .rbp-id{margin-left:auto;color:var(--text-muted)}
.rbp-task h4{margin:0;font-size:14px;font-weight:500;line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.rbp-task .rbp-from{display:block;flex:0 1 auto;min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;font-size:12px;color:var(--text-secondary)}
.rbp-task .rbp-from .rbp-sw{margin-right:6px;vertical-align:1px}
.rbp-holdnote{font-size:12px;font-weight:600;color:var(--wk-fg)}
.rbp-after{font-size:12px;color:var(--text-muted);margin:0;overflow-wrap:anywhere}
.rbp-ord{font-size:12px;font-weight:600;color:var(--text-muted)}
.rbp-unb{border-radius:6px;padding:8px;font-size:12px;line-height:1.4;border:1px solid}
.rbp-unb b{display:block;font-weight:600;margin-bottom:2px}
.rbp-unb span{color:var(--text-primary);display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere}
.rbp .u-you{background:var(--you-bg);border-color:var(--you-bd);color:var(--you-fg)}
.rbp .u-blk{background:var(--blk-bg);border-color:var(--blk-bd);color:var(--blk-fg)}
.rbp .u-wt{background:var(--wt-bg);border-color:var(--wt-bd);color:var(--wt-fg)}
.rbp-pill{display:inline-flex;align-items:center;gap:6px;height:22px;padding:0 8px;border-radius:999px;font-size:12px;font-weight:600;border:1px solid;white-space:nowrap}
.rbp .p-you{color:var(--you-fg);background:var(--you-bg);border-color:var(--you-bd)}
.rbp .p-blk{color:var(--blk-fg);background:var(--blk-bg);border-color:var(--blk-bd)}
.rbp .p-wt{color:var(--wt-fg);background:var(--wt-bg);border-color:var(--wt-bd)}
.rbp .p-wk{color:var(--wk-fg);background:var(--wk-bg);border-color:var(--wk-bd)}
.rbp .p-q{color:var(--q-fg);background:var(--q-bg);border-color:var(--q-bd)}
.rbp .p-ok{color:var(--ok-fg);background:var(--ok-bg);border-color:var(--ok-bd)}
.rbp-cluster+.rbp-cluster{margin-top:12px}
.rbp-cluster h3{margin:0 0 8px;font-size:14px;font-weight:600;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.rbp-cluster h3 small{font-weight:400;color:var(--text-muted);font-size:12px}
.rbp-minis{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:8px;margin-top:8px}
.rbp-mini{background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;padding:12px;display:flex;gap:12px;align-items:center;text-align:left;cursor:pointer;min-width:0;color:var(--text-primary)}
.rbp-mini:hover{border-color:var(--border-strong)}
.rbp-mini>.rbp-mtxt{min-width:0;display:block}
.rbp-mtxt>b{font-weight:600;display:block;overflow-wrap:anywhere}.rbp-mini small{display:block;font-size:12px;color:var(--text-muted)}
.rbp-mini .rbp-draw{margin-top:8px}
.rbp-quiet{margin-top:16px}
.rbp-lanes{display:flex;flex-direction:column;gap:12px}
.rbp-lane{display:grid;grid-template-columns:200px minmax(0,1fr);gap:16px;background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;padding:16px;box-shadow:inset 0 1px 0 var(--border-subtle);min-width:0}
.rbp-lane.is-you{border-color:var(--border-gold)}
.rbp-lh{display:flex;gap:12px;align-items:flex-start;min-width:0}
.rbp-lh h2{margin:0;font-size:16px;font-weight:600}
/* A segment shrinks to the lane and its cards wrap (QA #173 D1). The dashed separator sits in the column gap; one
   starting a wrapped row falls left of the track and is clipped, keeping 6 px for focus rings. */
.rbp-track{display:flex;flex-wrap:wrap;gap:16px 49px;min-width:0;clip-path:inset(-100vmax -100vmax -100vmax -6px)}
.rbp-segl{flex:0 1 auto;display:flex;flex-direction:column;gap:8px;min-width:0;position:relative}
.rbp-segl:last-child{flex:1 1 248px}
.rbp-segl .rbp-cards{display:flex;flex-wrap:wrap;gap:8px}
.rbp-segl .rbp-task{width:240px}
.rbp-segl+.rbp-segl::before{content:"";position:absolute;top:0;bottom:0;left:-25px;border-left:1px dashed var(--border-default)}
.rbp-banner{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:12px;align-items:center;padding:12px 16px;border:1px solid var(--blk-bd);background:var(--blk-bg);border-radius:12px;margin-bottom:12px}
.rbp-banner svg.rbp-i{color:var(--blk-fg);width:16px;height:16px}
.rbp-banner p{margin:0}.rbp-banner small{display:block;color:var(--text-secondary);font-size:12px}
.rbp-calm{padding:24px;border:1px solid var(--ok-bd);background:var(--ok-bg);border-radius:12px;display:flex;gap:16px;align-items:center;margin-bottom:12px}
.rbp-calm .rbp-sticon{border-color:var(--ok-bd);color:var(--ok-fg)}
.rbp-calm h2{margin:0;font-size:16px}.rbp-calm p{margin:2px 0 0;color:var(--text-secondary)}
.rbp-nores{padding:24px;border:1px dashed var(--border-strong);border-radius:12px;background:var(--bg-surface);margin-bottom:12px}
.rbp-nores h2{margin:0 0 4px;font-size:16px;overflow-wrap:anywhere}.rbp-nores p{margin:0 0 12px;color:var(--text-secondary)}
.rbp-nores .rbp-acts{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
.rbp-loadnote{font-size:12px;color:var(--text-muted);margin:0 0 8px}
.rbp-sk{background:var(--bg-surface);border:1px solid var(--border-default);border-radius:12px;padding:16px;display:grid;grid-template-columns:44px minmax(0,1fr);gap:16px;align-items:start;align-content:start;min-height:150px}
.rbp-sk i{display:block;background:var(--bg-elevated);border-radius:6px;height:10px}
.rbp-sk .c{width:44px;height:44px;border-radius:50%}
.rbp-sk .b{grid-column:1/-1;height:48px}
@media (max-width:900px){.rbp-bento{grid-template-columns:repeat(2,minmax(0,1fr))}.rbp-lane{grid-template-columns:1fr}}
@media (min-width:901px) and (max-width:1180px){.rbp-bento{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:640px){
  .rbp-main{padding:16px 16px 64px}
  .rbp-controls{flex-direction:column;align-items:stretch}
  .rbp-gb{justify-content:space-between}
  .rbp-seg{flex:1}.rbp-seg button{flex:1;padding:6px 8px;min-height:40px}
  .rbp-search{max-width:none;min-width:0}
  .rbp-search input{min-height:44px}
  .rbp-askc .rbp-foot .rbp-btn-you{width:100%;min-height:44px}
  .rbp-strip{grid-template-columns:minmax(0,1fr)}
  .rbp-bento{grid-template-columns:minmax(0,1fr)}
  .rbp-tile.is-l{grid-column:auto}
  .rbp-gbody{padding:12px}
  .rbp-dag{flex-direction:column;gap:12px;padding-left:28px;overflow:visible}
  .rbp-dag .rbp-col{flex:none;width:100%}
  .rbp-track{flex-direction:column;gap:12px;clip-path:none}
  .rbp-segl .rbp-cards{flex-direction:column}
  .rbp-segl .rbp-task{width:auto}
  .rbp-segl+.rbp-segl::before{content:none}
  .rbp-segl+.rbp-segl{border-top:1px dashed var(--border-default);padding-top:12px}
  .rbp-tasks{grid-template-columns:minmax(0,1fr)}
  .rbp-minis{grid-template-columns:minmax(0,1fr)}
  .rbp-fleet{grid-template-columns:minmax(0,1fr)}
  .rbp-banner{grid-template-columns:auto minmax(0,1fr)}.rbp-banner .rbp-btn{grid-column:1/-1;min-height:44px}
}
@media (max-width:400px){.rbp-seg .rbp-lg{display:none}.rbp-seg .rbp-sm{display:inline}}
@media (max-width:360px){.rbp-main{padding:12px 12px 64px}.rbp-th{padding:12px}.rbp-lane{padding:12px}.rbp-gb>span{display:none}}
@media (prefers-reduced-motion:reduce){.rbp *{animation:none !important;transition:none !important}}
`;
