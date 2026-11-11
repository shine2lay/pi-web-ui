# pi-web-ui Design Foundation (`DESIGN.md`)

Measured off `pi-web-ui`'s default theme (`web/src/styles.css`) and Warm Paper (`themes/paper.css`), in source and on the running page; paired with `.temper/design/tokens.json`. Records the existing look, documents drift without re-theming the app, marks every addition.

## 1. Who It Is For (Audience & Context)
- **Primary User — Owner Operator (`.temper/product/personas.md`):** Monitors 15 department leads and worker queues across desktop (`1440x900`) and phone (`390x844` / `320x568`) in dark (default) and light themes; needs a 5-second glance answer before drilling into raw evidence.
- **Secondary Actor — Role Agent Runtime:** Consumes deterministic server-owned fields rather than client-computed heuristics.
- **Anti-Personas:** Manual memory editors, cloud multi-tenant admins, or decorative analytics walls.

## 2. Five Failable Design Principles
1. **5-Second Glanceability Over Flat Logs:** Every workspace view opens with a status header and at most 4 summary cards (`<= 5` text fields per card). *Fails if:* a user must read a table or scroll below the fold to tell whether a subsystem is healthy, stale, idle, or offline.
2. **Honest Liveness & Distinct Unhealthy States:** `Healthy`, `Stale`, `Zero Activity`, and `Server Unreachable` are distinct operational truths. *Fails if:* any two share a badge label or icon, an unreachable backend renders `0` as healthy, or any live metric omits its age.
3. **Server-Owned Truth (Zero Client Roll-Up Math):** Every count, rate, and percentage maps 1:1 to a named server field. *Fails if:* browser code sums arrays, divides counters, or invents health thresholds.
4. **Progressive 3-Tier Disclosure:** Tier 1 shows status header, summary cards, and workspace tabs; Tier 2 explains contract vocabulary via `(?)` tooltips (`role="tooltip"`); Tier 3 opens full `L0`/`L1`/`L2` content and provenance in a reader drawer. *Fails if:* raw multi-line markdown, 64-char SHA-256 hashes, or host paths leak into Tier 1 rows.
5. **Derived Native Fit:** New views inherit `pi-web-ui` surface hierarchy, system sans/mono stacks, and `6px`/`8px`/`12px` radii. *Fails if:* a feature introduces external font CDNs, unapproved palettes, or inline style literals outside the token block.

## 3. Visual System (Measured Foundation, Drift & Additions)

### Measured Colour Hierarchy
- **Default Theme & Proof:** `web/src/theme.ts:27` (`DEFAULT_THEME_ID = "dark"`) renders `web/src/styles.css` `:root`. Every token cites `file:line:text`; `node .temper/design/check-token-provenance.mjs` must exit 0 (1 = citation wrong, 2 = file missing).
- **Surfaces (dark / light):** canvas `--bg` `#0d0e12` / `#f7f1e3`; surface `--bg-elev` `#14161c` / `#fffdf6`; elevated/hover `--bg-elev2` `#1a1d26` / `#efe7d3`; border-subtle `--border-soft` `#1e2230` / `#ded1b3`; border-strong `--border` `#262a35` / `#ddcfae`.
- **Text:** primary `--text` `#e6e8ef` / `#3f372c`; secondary `--text-dim` `#9aa1b4` / `#6f6250`; muted `--text-faint` `#8a91a3` / `#6c5a41` (already AA).
- **Accent:** `--accent` violet `#8b5cf6` / burnt orange `#b45309`. Outlines/focus only, never small text; `>= 101°` from the healthy hue.
- **Status (fg on its tint):** healthy `--green` `#34d399` / `#117236`; stale `--amber-fg` `#fbbf24` / `#9d5404`; unreachable `--red` `#f87171` / `#b91c1c`; info `--info-blue` `#60a5fa` / `#1d4ed8`; zero is neutral (`--text-dim` on `--bg-elev2`). Tints = the app's soft colours flattened over surface (`origin: "derived"`). Status hues stay `>= 62°` apart (dark), `>= 30°` (light).
- **Additions (`origin: "addition"`, app value kept):** light `status-healthy-fg` `#117236` (app `#15803d` `4.20:1` on its tint, now `5.04:1`); light `status-stale-fg` `#9d5404` (app `#d97706` `3.13:1`, now `5.03:1`; `--amber-text` `#92400e` is `18.7°` from red); `size-body` `16px` (app `14px`; feature check A15 needs `>= 16px`).

### Recorded Drift
- **Corrected 2026-11-11 (Design #274):** 5db1eb93 cited "measured" sources that never existed: `web/index.html:8` `--bg-primary #0d0d0d` (no CSS in that file), `themes/paper.css:8` `--bg-primary`, `web/index.html:1164` `16px`, `web/index.html:24` `--radius 10px`. Replaced: canvas `#0d0d0d` → `#0d0e12`, accent teal-green `#10a37f` (healthy's hue family) → violet `#8b5cf6`, font stacks → the app's, radii `6/10/16` → `6/8/12`, size-lg/xl `18/24` → `17/22`; `text-muted-legacy` dropped (unused).
- **App Drift (Not Reconciled Here):** `web/src/tasks-roles-v8/styles-tokens.ts` scopes a carbon/gold system (`#0E0F11`, Geist) to the Roles screens; top-bar tabs and chips use `9px` radius; Warm Paper's `--text-faint` is darker than its `--text-dim`.

### Typography, Spacing & Radii
- **Font Stacks (Measured):** sans = app `--sans` (system UI stack); mono = app `--mono` (`"SF Mono", "JetBrains Mono", …`). Zero webfont requests.
- **Type Scale:** `22px` (`size-xl`, metric/title), `17px` (`size-lg`, section/drawer title), `16px` (`size-body`, reading copy), `14px` (`size-md`, controls; app body), `13px` (`size-sm`, metadata), `12px` (`size-xs`, badges/ages; nothing smaller). Counters and ages set `font-variant-numeric: tabular-nums`.
- **Spacing & Radii (Measured):** spacing `4px`, `8px`, `12px`, `16px`, `20px`, `24px`, `32px`; radii `6px` sm (buttons), `8px` md (cards, rows), `12px` lg (dialogs, drawer), `999px` pills.

## 4. Layout & Breakpoints (320px / 390px / 1440px)
- **Desktop (`1440x900`):** Max width `1360px` centered (`24px` padding). Full-width status header above a 3-column summary card grid (`repeat(3, minmax(0, 1fr))`, `16px` gap) and tabbed workspace. Reader drawer opens as a `520px` right slide-over panel.
- **Mobile (`390x844` and `320x568`):** Single-column stack (`12px` padding at `320px`, `16px` at `390px`). Cards stack `1fr`; tabs wrap with `0px` horizontal overflow (`scrollWidth <= clientWidth`); tables collapse secondary columns into stacked cards without overlapping text; reader drawer opens full-width (`100vw`).
- **Scroll Discipline:** Only the document viewport and open reader drawer scroll vertically; nested clipped card scrollbars are forbidden.

## 5. Component Inventory & Rules
1. **Status Header Bar:** Subsystem title, mode badge (`Active (15/15 Roles Live)`, `Degraded Local Fallback`, or `Offline`), non-colour icon, last-checked age, and cadence note.
2. **Summary Bento Card:** `bg-surface`, `1px solid border-subtle`, `8px` radius, `16px` padding. At most **5 text fields**: (1) title + `(?)` trigger, (2) primary metric (`22px` tabular-nums), (3) status pill + icon, (4) secondary context line, (5) age/cadence footer.
3. **Workspace Tab Strip:** `role="tablist"` with 3 `role="tab"` buttons (`>= 24x24px`, `36px` height), `accent-primary` active indicator, `ArrowLeft`/`ArrowRight` navigation.
4. **Concept Tooltip (`(?)`):** Button (`>= 24x24px`) bound via `aria-describedby` to a `role="tooltip"` popover explaining contract terms (`L0`/`L1`/`L2`, `Slot 1-5`, `Commit Guard`, `Sidecar`). Opens on hover and `:focus-visible`, closes on `Escape`.
5. **Expandable Row & Tier 3 Reader Drawer:** Row trigger (`aria-expanded="false|true"`) shows Tier 1 metadata only; activation opens the Reader Drawer (`role="dialog"`) with `L0 Abstract`, `L1 Overview`, and `L2 Full Content` tabs plus provenance.
6. **Read-Only Surface:** Zero mutation controls (`Edit`, `Delete`, `Promote`, `Override`, `Write`, `Commit`) exist anywhere.

## 6. Accessibility Floor
- **Contrast:** WCAG 2.2 AA (`>= 4.5:1` normal text, `>= 3.0:1` large text `>= 18px` bold / `24px`) across both dark and light themes.
- **Non-Colour Cues:** Every health/freshness state pairs colour with a distinct icon glyph and label (`●` Healthy, `◐` Stale, `◌` Zero Activity, `✕` Server Unreachable / Offline).
- **Targets, Focus & Motion:** Controls `>= 24x24px`, visible `:focus-visible` ring (`2px solid var(--accent-primary)`), keyboard-reachable tooltips/drawer (`Escape` closes), and `@media (prefers-reduced-motion: reduce)`.
