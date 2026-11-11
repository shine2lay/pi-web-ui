#!/usr/bin/env bash
# Acceptance assertion runner for OpenViking Memory Dashboard (openviking-dashboard).
# Exit codes: 0 = all 17 assertions pass, 1 = one or more assertion violations, 2 = could not run (e.g. prototype missing).
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
TOKENS_PATH="${REPO_ROOT}/.temper/design/tokens.json"
PROTO_PATH="${SCRIPT_DIR}/prototype.html"
PROTO_SET=0
JSON_OUT=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --json) JSON_OUT=1; shift ;;
    --tokens)
      [[ $# -lt 2 ]] && { echo "check-openviking-dashboard: ERROR: --tokens requires a path" >&2; exit 2; }
      TOKENS_PATH="$2"; shift 2 ;;
    --tokens=*) TOKENS_PATH="${1#--tokens=}"; shift ;;
    -h|--help) echo "Usage: check-openviking-dashboard.sh [<prototype-html-path>] [--tokens <tokens.json>] [--json]"; exit 0 ;;
    -*) echo "check-openviking-dashboard: ERROR: unknown flag: $1" >&2; exit 2 ;;
    *)
      [[ "${PROTO_SET}" -eq 1 ]] && { echo "check-openviking-dashboard: ERROR: unexpected argument: $1" >&2; exit 2; }
      PROTO_PATH="$1"; PROTO_SET=1; shift ;;
  esac
done

emit_exit2() {
  local msg="$1" target="${2:-}"
  if [[ "${JSON_OUT}" -eq 1 ]]; then
    python3 -c 'import json,sys; print(json.dumps({"tool":"check-openviking-dashboard","version":1,"status":"error","exit_code":2,"target":sys.argv[2],"error":sys.argv[1],"assertions":[]},indent=2))' "${msg}" "${target}"
  else
    echo "check-openviking-dashboard: ERROR: ${msg}" >&2
  fi
  exit 2
}

[[ ! -f "${PROTO_PATH}" ]] && emit_exit2 "prototype not found: ${PROTO_PATH}" "${PROTO_PATH}"
[[ ! -f "${TOKENS_PATH}" ]] && emit_exit2 "tokens.json not found: ${TOKENS_PATH}" "${PROTO_PATH}"

PW_LIBS="/home/shinelay/.cache/ms-playwright-libs/root/usr/lib/aarch64-linux-gnu"
[[ -d "${PW_LIBS}" ]] && export LD_LIBRARY_PATH="${PW_LIBS}:${LD_LIBRARY_PATH:-}"

python3 - "${PROTO_PATH}" "${TOKENS_PATH}" "${JSON_OUT}" <<'PYEOF'
import json, math, pathlib, re, sys
from playwright.sync_api import sync_playwright

proto_path = pathlib.Path(sys.argv[1]).resolve()
tokens_path = pathlib.Path(sys.argv[2]).resolve()
json_mode = (sys.argv[3] == "1")

def exit2(msg):
    if json_mode:
        print(json.dumps({"tool": "check-openviking-dashboard", "version": 1, "status": "error", "exit_code": 2, "target": str(proto_path), "error": msg, "assertions": []}, indent=2))
    else:
        print(f"check-openviking-dashboard: ERROR: {msg}", file=sys.stderr)
    sys.exit(2)

try:
    raw_html = proto_path.read_text(encoding="utf-8")
    tokens_data = json.loads(tokens_path.read_text(encoding="utf-8"))
except Exception as exc:
    exit2(f"failed to read input files: {exc}")

if not raw_html.strip():
    exit2(f"prototype is empty: {proto_path}")

def oklch_to_srgb(L, C, h_deg):
    rad = math.radians(h_deg)
    a, b = C * math.cos(rad), C * math.sin(rad)
    l_ = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m_ = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s_ = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    rl = +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_
    gl = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_
    bl = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_
    tr = lambda x: 12.92 * max(0.0, min(1.0, x)) if max(0.0, min(1.0, x)) <= 0.0031308 else 1.055 * (max(0.0, min(1.0, x)) ** (1.0 / 2.4)) - 0.055
    return (tr(rl), tr(gl), tr(bl))

def parse_color(c_str):
    s = (c_str or "").strip().lower()
    if not s or s == "transparent":
        return (0.0, 0.0, 0.0, 0.0)
    m_rgb = re.match(r"rgba?\(([^)]+)\)", s)
    if m_rgb:
        p = [x.strip() for x in re.split(r"[\s,/]+", m_rgb.group(1)) if x.strip()]
        return (float(p[0]) / 255.0, float(p[1]) / 255.0, float(p[2]) / 255.0, float(p[3]) if len(p) >= 4 else 1.0)
    m_ok = re.match(r"oklch\(([^)]+)\)", s)
    if m_ok:
        inner, alpha = m_ok.group(1), 1.0
        if "/" in inner:
            inner, a_s = inner.split("/", 1)
            alpha = float(a_s.strip().rstrip("%")) / (100.0 if "%" in a_s else 1.0)
        vals = [float(x) for x in inner.strip().split()]
        r, g, b = oklch_to_srgb(vals[0], vals[1], vals[2])
        return (r, g, b, alpha)
    return (0.0, 0.0, 0.0, 0.0)

def contrast_ratio(c1, c2):
    ch = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    lum = lambda u: 0.2126 * ch(u[0]) + 0.7152 * ch(u[1]) + 0.0722 * ch(u[2])
    l1, l2 = lum(c1), lum(c2)
    return (max(l1, l2) + 0.05) / (min(l1, l2) + 0.05)

VALID_SOURCES = {
    "observer.mode_label", "observer.roles_online_count", "observer.roles_total_count",
    "observer.daemon_bind", "observer.queue_depth", "observer.checked_at",
    "metrics.slot_hit_rate_pct", "metrics.avg_injected_tokens", "metrics.turns_sampled_24h", "metrics.last_recorded_at",
    "changelog.commits_24h", "changelog.promotions_24h", "changelog.rejected_24h", "changelog.last_event_at",
    "slots[].slot_id", "slots[].uri_prefix", "slots[].hit_rate_pct", "slots[].avg_tokens", "slots[].state", "slots[].last_sampled_at",
    "entries[].uri", "entries[].scope", "entries[].role", "entries[].layers", "entries[].l0_abstract", "entries[].updated_at",
    "events[].id", "events[].action", "events[].role", "events[].uri", "events[].l0_abstract", "events[].guard_verdict", "events[].ts"
}

assertions = []
def record(rule_id, passed, observed, limit):
    assertions.append({"id": rule_id, "status": "pass" if passed else "fail", "observed": observed, "limit": limit})

file_url = proto_path.as_uri()
external_requests = []

try:
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
        page = context.new_page()
        page.on("request", lambda req: external_requests.append(req.url) if not req.url.startswith(("file://", "data:", "blob:")) else None)

        page.goto(f"{file_url}?state=live", wait_until="load")

        # A01: Three Tier 1 elements present
        t1 = page.evaluate("""() => {
            const vis = (el) => {
                if (!el) return false;
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && r.width > 0 && r.height > 0;
            };
            const hdr = document.querySelector('[data-component="status-header"]');
            const cards = [...document.querySelectorAll('[data-component="summary-card"]')].filter(vis);
            const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"][data-tab]')].filter(vis).map(t => t.getAttribute('data-tab'));
            return { headerVisible: vis(hdr), cardCount: cards.length, tabs };
        }""")
        a01_ok = t1["headerVisible"] and t1["cardCount"] == 3 and t1["tabs"] == ["mount-map", "namespace-explorer", "commit-audit"]
        record("A01-TIER1-STRUCTURE", a01_ok, f"header={t1['headerVisible']}, cards={t1['cardCount']}, tabs={t1['tabs']}", "header=True, cards=3, tabs=['mount-map','namespace-explorer','commit-audit']")

        # A02: Max 5 text fields per summary card
        c_fields = page.evaluate("""() => {
            return [...document.querySelectorAll('[data-component="summary-card"]')].map((c, idx) => {
                const fields = [...c.querySelectorAll('[data-field]')].filter(el => el.textContent.trim().length > 0);
                const leafChildren = [...c.children].filter(el => el.textContent.trim().length > 0);
                return { id: c.getAttribute('data-card-id') || idx, count: Math.max(fields.length, leafChildren.length) };
            });
        }""")
        max_f = max([x["count"] for x in c_fields], default=0)
        a02_ok = len(c_fields) == 3 and all(1 <= x["count"] <= 5 for x in c_fields)
        record("A02-SUMMARY-CARD-MAX-FIELDS", a02_ok, f"cardFieldCounts={c_fields} (max={max_f})", "3 cards, each 1..5 fields")

        # A05: Every live number carries visible age and every panel its last-written time
        age_info = page.evaluate("""() => {
            const vis = (el) => el && getComputedStyle(el).display !== 'none' && getComputedStyle(el).visibility !== 'hidden' && el.getBoundingClientRect().width > 0;
            const figs = [...document.querySelectorAll('[data-figure]')].filter(vis);
            const missingFigAge = figs.filter(f => {
                const ageAttr = (f.getAttribute('data-age') || '').trim();
                const ageEl = (f.hasAttribute('data-age-label') ? f : null) || f.querySelector('[data-age-label]') || f.closest('[data-component],[role="tabpanel"]')?.querySelector('[data-age-label]');
                return !ageAttr || !ageEl || !vis(ageEl) || !/\\d+\\s*(s|m|h|d)\\s*ago/i.test(ageEl.textContent);
            }).map(f => f.getAttribute('data-source-field') || f.textContent.trim());
            const panels = [...document.querySelectorAll('[data-component="summary-card"], [role="tabpanel"]')].filter(vis);
            const missingPanelTime = panels.filter(p => {
                const ts = (p.getAttribute('data-panel-updated-at') || '').trim();
                const badge = p.querySelector('[data-panel-updated-label]');
                return !ts || !badge || !vis(badge) || !badge.textContent.trim();
            }).map(p => p.getAttribute('data-card-id') || p.getAttribute('data-tabpanel') || 'panel');
            return { figCount: figs.length, missingFigAge, panelCount: panels.length, missingPanelTime };
        }""")
        a05_ok = age_info["figCount"] >= 6 and len(age_info["missingFigAge"]) == 0 and age_info["panelCount"] >= 4 and len(age_info["missingPanelTime"]) == 0
        record("A05-LIVE-NUMBER-AGE-AND-PANEL-TIME", a05_ok, f"figs={age_info['figCount']}, missingFigAge={age_info['missingFigAge']}, missingPanelTime={age_info['missingPanelTime']}", "0 missing figure ages or panel timestamps")

        # A07: Every figure declares valid server source field and zero client roll-up math
        src_info = page.evaluate("""() => {
            const figs = [...document.querySelectorAll('[data-figure]')];
            const fields = figs.map(f => f.getAttribute('data-source-field') || '');
            const scripts = [...document.querySelectorAll('script:not([type="application/json"])')].map(s => s.textContent).join('\\n');
            const hasMath = /\\.reduce\\s*\\(|Math\\.(round|floor|ceil|avg)\\s*\\(|\\b(sum|total|hitRate)\\s*[=+*/-]/i.test(scripts);
            const mismatch = figs.filter(f => f.getAttribute('data-client-computed') === 'true').map(f => f.getAttribute('data-source-field'));
            return { fields, hasMath, mismatch };
        }""")
        invalid_f = [f for f in src_info["fields"] if f not in VALID_SOURCES]
        a07_ok = len(src_info["fields"]) >= 6 and len(invalid_f) == 0 and not src_info["hasMath"] and len(src_info["mismatch"]) == 0
        record("A07-SERVER-SOURCE-FIELD-NO-CLIENT-MATH", a07_ok, f"invalidFields={invalid_f}, hasClientMath={src_info['hasMath']}, clientComputedAttr={src_info['mismatch']}", "all figures in VALID_SOURCES, hasClientMath=False")

        # A08: (?) tooltips with role="tooltip" on every contract-concept badge
        tt_info = page.evaluate("""() => {
            const concepts = [...document.querySelectorAll('[data-concept]')];
            const bad = [];
            for (const c of concepts) {
                const btn = c.querySelector('button[data-slot="tooltip-trigger"]') || c.parentElement?.querySelector('button[data-slot="tooltip-trigger"]');
                if (!btn) { bad.push({ concept: c.getAttribute('data-concept'), err: 'missing trigger' }); continue; }
                const r = btn.getBoundingClientRect();
                const tid = btn.getAttribute('aria-describedby') || '';
                const tip = tid ? document.getElementById(tid) : null;
                btn.focus();
                const tipVis = tip ? (getComputedStyle(tip).display !== 'none' && getComputedStyle(tip).visibility !== 'hidden' && parseFloat(getComputedStyle(tip).opacity) > 0) : false;
                if (r.width < 24 || r.height < 24 || !tip || tip.getAttribute('role') !== 'tooltip' || !tipVis || tip.textContent.trim().length < 15) {
                    bad.push({ concept: c.getAttribute('data-concept'), w: r.width, h: r.height, role: tip?.getAttribute('role'), tipVis });
                }
            }
            return { count: concepts.length, bad };
        }""")
        a08_ok = tt_info["count"] >= 4 and len(tt_info["bad"]) == 0
        record("A08-CONCEPT-TOOLTIPS", a08_ok, f"concepts={tt_info['count']}, bad={tt_info['bad']}", ">=4 concept badges, all >=24x24px with visible role=tooltip on focus")

        # A09: Clicking a row opens L0/L1/L2 reader drawer and flips aria-expanded
        dr_info = page.evaluate("""() => {
            const tab2 = document.querySelector('[role="tab"][data-tab="namespace-explorer"]');
            if (tab2) tab2.click();
            const row = document.querySelector('[data-component="memory-row"], [data-component="audit-row"]');
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            if (!row || !drawer) return { ok: false, reason: 'missing row or drawer' };
            const beforeExp = row.getAttribute('aria-expanded');
            row.click();
            const afterExp = row.getAttribute('aria-expanded');
            const s = getComputedStyle(drawer);
            const drawerVis = s.display !== 'none' && s.visibility !== 'hidden' && drawer.getBoundingClientRect().width > 0;
            const dTabs = [...drawer.querySelectorAll('[data-drawer-tab]')].map(t => t.getAttribute('data-drawer-tab'));
            const prov = drawer.querySelector('[data-slot="drawer-provenance"]');
            const closeBtn = drawer.querySelector('[data-slot="drawer-close"]');
            if (closeBtn) closeBtn.click(); else row.click();
            const closedExp = row.getAttribute('aria-expanded');
            return { beforeExp, afterExp, closedExp, drawerVis, dTabs, hasProv: !!(prov && prov.textContent.trim()) };
        }""")
        a09_ok = (dr_info.get("beforeExp") == "false" and dr_info.get("afterExp") == "true" and dr_info.get("closedExp") == "false"
                  and dr_info.get("drawerVis") is True and dr_info.get("dTabs") == ["l0", "l1", "l2"] and dr_info.get("hasProv") is True)
        record("A09-DRAWER-TOGGLE-L0-L1-L2", a09_ok, f"drawer={dr_info}", "aria-expanded false->true->false, drawer visible with ['l0','l1','l2'] + provenance")

        # A10: No full L1/L2 markdown in list rows
        md_leak = page.evaluate("""() => {
            const leaks = [];
            for (const t of document.querySelectorAll('[role="tab"][data-tab]')) {
                t.click();
                for (const r of document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')) {
                    const txt = r.innerText || '';
                    if (/^#{1,6}\\s+/m.test(txt) || /```/.test(txt) || (r.querySelector('[data-layer-leak="true"]') !== null) || txt.split('\\n').some(l => l.length > 180)) {
                        leaks.push(txt.slice(0, 80));
                    }
                }
            }
            document.querySelector('[role="tab"][data-tab="mount-map"]')?.click();
            return leaks;
        }""")
        record("A10-NO-FULL-MARKDOWN-IN-ROWS", len(md_leak) == 0, f"markdownLeaks={md_leak}", "0 multi-line/heading/code-fence markdown leaks in list rows")

        # A12: No mutation controls anywhere
        mut_leaks = page.evaluate("""() => {
            const controls = [...document.querySelectorAll('button, input, select, textarea, form, [role="button"]')];
            const bad = [];
            for (const c of controls) {
                const label = ((c.innerText || '') + ' ' + (c.getAttribute('aria-label') || '') + ' ' + (c.getAttribute('data-action') || '')).trim();
                if (/\\b(write|edit|delete|promote|override|mutate|save|create|remove|drop|clear memory)\\b/i.test(label) || c.tagName === 'FORM' || (c.tagName === 'INPUT' && c.type !== 'hidden')) {
                    bad.push(label || c.tagName);
                }
            }
            return bad;
        }""")
        record("A12-NO-MUTATION-CONTROLS", len(mut_leaks) == 0, f"mutationControls={mut_leaks}", "0 mutation controls")

        # A13: No prototype chrome (#stateStrip, data-st-state, window.__hidePrototypeChrome)
        proto_chrome = page.evaluate("""() => ({
            stateStrip: document.getElementById('stateStrip') !== null,
            dataStState: document.querySelector('[data-st-state]') !== null,
            hideFn: typeof window.__hidePrototypeChrome !== 'undefined'
        })""")
        a13_ok = not proto_chrome["stateStrip"] and not proto_chrome["dataStState"] and not proto_chrome["hideFn"]
        record("A13-NO-PROTOTYPE-CHROME", a13_ok, f"protoChrome={proto_chrome}", "stateStrip=False, dataStState=False, hideFn=False")

        # A03, A04, A06, A11 across states (live, stale, empty, error)
        state_sigs = {}
        hash_path_leaks = []
        unreachable_check = {}
        stale_badge_check = {}

        for st in ["live", "stale", "empty", "error"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            info = page.evaluate("""(st) => {
                const badge = document.querySelector('[data-component="summary-card"][data-card-id="context-injection"] [data-slot="state-badge"]') || document.querySelector('[data-slot="state-badge"]');
                const s = badge ? getComputedStyle(badge) : null;
                const staleBadges = [...document.querySelectorAll('[data-stale-badge="true"]')].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
                const figs = [...document.querySelectorAll('[data-component="summary-card"] [data-figure]')].map(f => ({
                    text: f.textContent.trim(),
                    unreach: f.getAttribute('data-unreachable-value') === 'true'
                }));
                const hdrBadge = document.querySelector('[data-component="status-header"] [data-slot="mode-badge"]');
                const bodyTxt = document.body.innerText || '';
                return {
                    label: badge ? badge.textContent.trim() : '',
                    icon: badge ? (badge.getAttribute('data-icon') || '') : '',
                    borderStyle: s ? s.borderTopStyle : '',
                    color: s ? s.color : '',
                    staleBadgeCount: staleBadges.length,
                    staleBadgeText: staleBadges.map(b => b.textContent.trim()),
                    figs,
                    hdrMode: hdrBadge ? hdrBadge.textContent.trim() : '',
                    bodyTxt
                };
            }""", st)
            state_sigs[st] = (info["label"], info["icon"], info["borderStyle"], info["color"])
            if st == "stale":
                stale_badge_check["stale"] = (info["staleBadgeCount"], info["staleBadgeText"], info["label"])
            if st == "live":
                stale_badge_check["live"] = info["staleBadgeCount"]
            if st == "error":
                unreachable_check = {"hdrMode": info["hdrMode"], "cardLabel": info["label"], "figs": info["figs"]}
            for m in re.findall(r"\b[0-9a-f]{64}\b", info["bodyTxt"], flags=re.I):
                hash_path_leaks.append(f"{st}:hash:{m[:16]}...")
            for m in re.findall(r"(?:/home/[A-Za-z0-9_./-]+|/var/[A-Za-z0-9_./-]+|~/.local/[A-Za-z0-9_./-]+|\b(?:memory-changelog|metrics|sidecar-timed-out)\.jsonl\b)", info["bodyTxt"]):
                hash_path_leaks.append(f"{st}:path:{m}")

        labels = [state_sigs[k][0] for k in ["live", "stale", "empty", "error"]]
        icons = [state_sigs[k][1] for k in ["live", "stale", "empty", "error"]]
        borders = [state_sigs[k][2] for k in ["live", "stale", "empty", "error"]]
        colors = [state_sigs[k][3] for k in ["live", "stale", "empty", "error"]]
        a03_ok = (len(set(labels)) == 4 and len(set(icons)) == 4 and len(set(borders)) == 4 and len(set(colors)) == 4
                  and all(bool(x) for x in labels) and all(bool(x) for x in icons))
        record("A03-DISTINCT-UNHEALTHY-STATES", a03_ok, f"labels={labels}, icons={icons}, borders={borders}", "4 distinct labels, 4 distinct icons, 4 distinct border styles, 4 distinct colors across live/stale/empty/error")

        figs_err = unreachable_check.get("figs", [])
        has_zero_counter = any(re.match(r"^0(?:\.0+)?%?$", f["text"]) or not f["unreach"] for f in figs_err)
        hdr_fake = "Active" in unreachable_check.get("hdrMode", "") or "Healthy" in unreachable_check.get("cardLabel", "")
        a04_ok = len(figs_err) >= 3 and not has_zero_counter and not hdr_fake
        record("A04-NO-FAKE-ZERO-ON-UNREACHABLE", a04_ok, f"errorHeader={unreachable_check.get('hdrMode')}, cardLabel={unreachable_check.get('cardLabel')}, figs={figs_err}", "all unreachable figures marked data-unreachable-value=true ('— (Unreachable)'), never '0' or 'Healthy'")

        st_cnt, st_txts, st_lbl = stale_badge_check.get("stale", (0, [], ""))
        a06_ok = st_cnt >= 1 and stale_badge_check.get("live", 0) == 0 and any(">" in t for t in st_txts) and "Healthy" not in st_lbl
        record("A06-STALE-BADGE-PAST-CADENCE", a06_ok, f"liveStaleBadges={stale_badge_check.get('live')}, staleStateBadges={st_cnt} ({st_txts}), label={st_lbl}", "live=0 stale badges, stale>=1 badge naming exceeded cadence (> 30s / > 5m / > 15m)")

        record("A11-NO-HASH-OR-INTERNAL-PATH", len(hash_path_leaks) == 0, f"leaks={hash_path_leaks}", "0 64-char hex hashes or internal filesystem paths across all states")

        # A14: Zero cross-origin requests or remote assets
        page.goto(f"{file_url}?state=live", wait_until="load")
        dom_remote = page.evaluate("""() => {
            const urls = [];
            for (const el of document.querySelectorAll('link[href], script[src], img[src], iframe[src]')) {
                const u = el.getAttribute('href') || el.getAttribute('src') || '';
                if (/^https?:\\/\\//i.test(u) || /^\\/\\//.test(u)) urls.push(u);
            }
            for (const s of document.querySelectorAll('style')) {
                const m = (s.textContent || '').match(/url\\(\\s*['"]?https?:\\/\\/[^)'"\\s]+/gi);
                if (m) urls.push(...m);
            }
            return urls;
        }""")
        a14_ok = len(external_requests) == 0 and len(dom_remote) == 0
        record("A14-ZERO-CROSS-ORIGIN", a14_ok, f"netRequests={external_requests}, domRemote={dom_remote}", "0 external network requests or remote URLs")

        # A15: Type floor (>=12px all text, >=16px body) & 0 horizontal overflow at 320, 390, 1440
        type_violations = []
        for w, h in [(320, 568), (390, 844), (1440, 900)]:
            page.set_viewport_size({"width": w, "height": h})
            res = page.evaluate("""(w) => {
                const sw = document.documentElement.scrollWidth, cw = document.documentElement.clientWidth;
                const bodyFs = parseFloat(getComputedStyle(document.body).fontSize);
                const bodyCopy = [...document.querySelectorAll('[data-body-copy]')].map(el => parseFloat(getComputedStyle(el).fontSize));
                let minFs = 999, minText = '';
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = walker.nextNode())) {
                    if (!n.nodeValue.trim()) continue;
                    const el = n.parentElement;
                    if (!el) continue;
                    const s = getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
                    const fs = parseFloat(s.fontSize);
                    if (fs < minFs) { minFs = fs; minText = n.nodeValue.trim().slice(0, 24); }
                }
                return { overflow: sw - cw, bodyFs, minBodyCopy: bodyCopy.length ? Math.min(...bodyCopy) : bodyFs, minFs, minText };
            }""", w)
            if res["overflow"] > 1 or res["bodyFs"] < 16 or res["minBodyCopy"] < 16 or res["minFs"] < 12:
                type_violations.append(f"{w}px:minFs={res['minFs']}px('{res['minText']}'),body={res['bodyFs']}px,copy={res['minBodyCopy']}px,overflow={res['overflow']}px")
        record("A15-TYPE-FLOOR-320-390-1440", len(type_violations) == 0, f"violations={type_violations}", "minFs>=12px, body>=16px, overflow<=1px at 320/390/1440")

        # A16: WCAG 2.2 AA contrast in both dark and light themes
        page.set_viewport_size({"width": 1440, "height": 900})
        contrast_fails = []
        for theme in ["dark", "light"]:
            page.evaluate(f"document.documentElement.setAttribute('data-theme', '{theme}')")
            pairs = page.evaluate("""() => {
                const out = [];
                const getBg = (el) => {
                    let cur = el;
                    while (cur) {
                        const bg = getComputedStyle(cur).backgroundColor;
                        if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') return bg;
                        cur = cur.parentElement;
                    }
                    return getComputedStyle(document.body).backgroundColor;
                };
                const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                let n;
                while ((n = walker.nextNode())) {
                    const txt = n.nodeValue.trim();
                    if (!txt) continue;
                    const el = n.parentElement;
                    if (!el) continue;
                    const s = getComputedStyle(el);
                    if (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0) continue;
                    const fs = parseFloat(s.fontSize);
                    const fw = parseInt(s.fontWeight || '400', 10) || 400;
                    out.push({ txt: txt.slice(0, 28), fg: s.color, bg: getBg(el), large: (fs >= 24 || (fs >= 18 && fw >= 700)) });
                }
                return out;
            }""")
            for item in pairs:
                fg = parse_color(item["fg"])
                bg = parse_color(item["bg"])
                cr = contrast_ratio(fg[:3], bg[:3])
                req = 3.0 if item["large"] else 4.5
                if cr + 0.02 < req:
                    contrast_fails.append(f"{theme}:{cr:.2f}:1<{req}:1('{item['txt']}')")
                    break
        record("A16-WCAG-AA-CONTRAST-BOTH-THEMES", len(contrast_fails) == 0, f"contrastFails={contrast_fails}", "all text >=4.5:1 (>=3.0:1 large) in dark and light")

        # A17: No colour or spacing literal outside the token block
        style_leaks = page.evaluate("""() => {
            const inlineStyles = [...document.querySelectorAll('[style]')].map(el => el.getAttribute('style'));
            const cssBlocks = [...document.querySelectorAll('style')].map(s => s.textContent || '').join('\\n');
            const stripped = cssBlocks.replace(/\\/\\*[\\s\\S]*?\\*\\//g, '').replace(/(?::root|html\\[data-theme=[^\\]]+\\])\\s*\\{[^}]*\\}/g, '');
            const colorLit = stripped.match(/#[0-9a-fA-F]{3,8}\\b|\\b(?:rgb|hsl|oklch)a?\\s*\\(/g) || [];
            const spaceLit = [];
            for (const m of stripped.matchAll(/\\b(?:padding(?:-(?:top|right|bottom|left))?|margin(?:-(?:top|right|bottom|left))?|gap|row-gap|column-gap)\\s*:\\s*([^;!}]+)/g)) {
                const val = m[1].trim();
                const cleaned = val.replace(/var\\([^)]+\\)/g, '').trim();
                if (/\\b[1-9]\\d*(?:\\.\\d+)?(?:px|rem|em)\\b/.test(cleaned)) spaceLit.push(m[0].trim());
            }
            return { inlineStyles, colorLit, spaceLit };
        }""")
        a17_ok = len(style_leaks["inlineStyles"]) == 0 and len(style_leaks["colorLit"]) == 0 and len(style_leaks["spaceLit"]) == 0
        record("A17-CSS-TOKENS-ONLY", a17_ok, f"inline={style_leaks['inlineStyles']}, colors={style_leaks['colorLit']}, spacing={style_leaks['spaceLit']}", "0 inline styles, 0 color/spacing literals outside token block")

        browser.close()
except Exception as exc:
    exit2(f"Playwright execution error: {exc}")

failed = [a["id"] for a in assertions if a["status"] != "pass"]
exit_code = 0 if len(failed) == 0 else 1
report = {
    "tool": "check-openviking-dashboard",
    "version": 1,
    "status": "pass" if exit_code == 0 else "fail",
    "exit_code": exit_code,
    "target": str(proto_path),
    "failed_rules": failed,
    "assertions": assertions,
}
if json_mode:
    print(json.dumps(report, indent=2))
else:
    print(f"check-openviking-dashboard: {report['status'].upper()} (exit={exit_code}, failed={failed})")
    for a in assertions:
        print(f"  [{a['status'].upper()}] {a['id']}: observed={a['observed']} (limit={a['limit']})")
sys.exit(exit_code)
PYEOF
