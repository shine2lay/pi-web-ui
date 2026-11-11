#!/usr/bin/env bash
# Acceptance assertion runner for OpenViking Memory Dashboard (openviking-dashboard).
# Exit codes: 0 = every assertion below passes (A01-A44), 1 = one or more assertion violations, 2 = could not run (e.g. prototype missing).
# Task #269 appends A18-A23 (state honesty, summary/detail parity, drawer integrity, role isolation, focus/keyboard, unmeasured slots); exit 0 now means all 23 pass.
# Task #275 appends A24-A28 (drawer honours and follows state, neutral unmeasured slots, error card 3 / Tab 3 parity, no role liveness claim); exit 0 now means all 28 pass.
# A26 reads slot fields and uri_prefix values from server/openviking/types.ts; a missing or unreadable types file is exit 2.
# Task #280 narrows A04 to :1933-sourced figures (lead ruling on TASK-7-REPORT.md item 1) and appends A29-A31 (session-commit label, phone sheet focus trap,
# local JSONL panels survive error); exit 0 now means all 31 pass. A04 and A31 read which figure comes from :1933 or a local JSONL from spec.md's
# source table; a missing or unparseable spec.md is exit 2.
# Task #284 appends A32-A37 (each card pill shows its own panel's health, no age without a timestamp field, header mode = observer.mode_label,
# selection never wears a status colour, loading shows no status, percentages achievable from their counts); exit 0 now means all 37 pass.
# A32/A34/A36 read pill labels and status icons from design.md §Screen States and mode labels / timestamp fields from types.ts; missing is exit 2.
# Task #286 appends A38-A39 (observer.last_reachable_at gates no state, pill, mode badge or verdict; null never reads as recent). The prototype
# takes a last_reachable_at variant as ?state=<screen>_reach-<null|3s|1m|18m|3d> (prototype-only, like ?state=); exit 0 now means all 39 pass.
# Task #289 appends A40-A41 (a sync-caused stale reads the stale_badge the server sends, with no age or duration in that row; when both causes
# hold the badge is the age). The stale screen takes a stale_badge variant as ?state=stale_badge-<age|sync|both|mixed>; exit 0 now means all 41 pass.
# A40/A41 read the allowed stale_badge values per source from spec-states.md §4; a missing or unparseable file is exit 2.
# Task #290 appends A42-A43 (on the Offline screen every row's L1/L2 states that row's own reason, and the screen promises
# text comes back only for the layers the daemon serves); exit 0 now means all 43 pass. A42 classifies each row from the
# page's own live rendering, so no copy list lives in this checker.
# Task #290 lead amendments (same standing as A03/A04): A24's offline-wording branch applies only to daemon-served layers
# (A42 proves the marking), and A21 runs over all five states instead of ?state=live only.
# Task #296 appends A44 (every element carrying data-source-field, in all five states, holds at most one reading outside its
# nested field spans, and that reading is the kind its field's type in types.ts yields -- the generalisation of S4-1 and S5-1);
# exit 0 now means all 44 pass. The figure-kind -> field pairing table is built from server/openviking/types.ts, never restated here.
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

# Task #275 (A26): the slot contract comes from the server's own types, never restated in this checker
OV_TYPES_PATH="${REPO_ROOT}/server/openviking/types.ts"
[[ ! -f "${OV_TYPES_PATH}" ]] && emit_exit2 "server types not found: ${OV_TYPES_PATH}" "${PROTO_PATH}"
export OV_TYPES_PATH

# Task #280 (A04/A31): spec.md owns which source (:1933 or a local JSONL) feeds each figure; never restated in this checker
OV_SPEC_PATH="${SCRIPT_DIR}/spec.md"
[[ ! -f "${OV_SPEC_PATH}" ]] && emit_exit2 "feature spec not found: ${OV_SPEC_PATH}" "${PROTO_PATH}"
export OV_SPEC_PATH

# Task #284 (A32/A34/A36): design.md owns the pill label, icon and border for each health state; never restated in this checker
OV_DESIGN_PATH="${SCRIPT_DIR}/design.md"
[[ ! -f "${OV_DESIGN_PATH}" ]] && emit_exit2 "feature design not found: ${OV_DESIGN_PATH}" "${PROTO_PATH}"
export OV_DESIGN_PATH

# Task #289 (A40/A41): spec-states.md §4 owns the stale_badge value set per source; never restated in this checker
OV_STATES_PATH="${SCRIPT_DIR}/spec-states.md"
[[ ! -f "${OV_STATES_PATH}" ]] && emit_exit2 "feature operational states not found: ${OV_STATES_PATH}" "${PROTO_PATH}"
export OV_STATES_PATH

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

# Task #275 (A26): OpenVikingSlotSummary fields and OPENVIKING_CONTEXT_SLOTS uri_prefix values, read from types.ts
import os
try:
    types_src = pathlib.Path(os.environ["OV_TYPES_PATH"]).read_text(encoding="utf-8")
except Exception as exc:
    exit2(f"failed to read server types: {exc}")
_slot_iface = re.search(r"export interface OpenVikingSlotSummary\s*\{(.*?)\n\}", types_src, re.S)
_slot_defs = re.search(r"export const OPENVIKING_CONTEXT_SLOTS\b(.*?)\n\]", types_src, re.S)
SLOT_FIELDS = re.findall(r"^\s*(\w+)\??\s*:", _slot_iface.group(1), re.M) if _slot_iface else []
SLOT_PREFIX_BY_ID = dict(re.findall(r'slot_id:\s*(\d+)\s*,.*?uri_prefix:\s*"([^"]+)"', _slot_defs.group(1), re.S)) if _slot_defs else {}
if not SLOT_FIELDS or len(SLOT_PREFIX_BY_ID) != 5:
    exit2(f"could not read OpenVikingSlotSummary fields and 5 slot uri_prefix values from {os.environ['OV_TYPES_PATH']}")

# Task #280 (A04/A31): spec.md "Canonical State and Formula Owners" table -> each field is ("server", None) for 127.0.0.1:1933 or ("local", <jsonl>)
try:
    spec_src = pathlib.Path(os.environ["OV_SPEC_PATH"]).read_text(encoding="utf-8")
except Exception as exc:
    exit2(f"failed to read feature spec: {exc}")
_owner_tbl = re.search(r"^## Canonical State and Formula Owners\n(.*?)(?=^#{2,3} )", spec_src, re.S | re.M)
FIELD_SOURCE, FAMILY_SOURCE = {}, {}
for _line in (_owner_tbl.group(1).splitlines() if _owner_tbl else []):
    if not _line.startswith("| `"):
        continue
    _cols = [c.strip() for c in _line.strip().strip("|").split("|")]
    if len(_cols) < 2:
        continue
    _jsonl = re.findall(r"[\w.-]+\.jsonl\b", _cols[1])
    _server = re.search(r"/health|/api/v1/|viking://", _cols[1])
    _src = ("local", _jsonl[0]) if _jsonl and not _server else ("server", None)
    for _tok in re.findall(r"`([^`]+)`", _cols[0]):
        _m = re.match(r"^(.*?)\{([^}]*)\}$", _tok)
        for _field in ([_m.group(1) + x.strip() for x in _m.group(2).split(",")] if _m else [_tok]):
            FIELD_SOURCE[_field] = _src
            FAMILY_SOURCE.setdefault(_field.split(".")[0], set()).add(_src)
if any(len(v) != 1 for v in FAMILY_SOURCE.values()) or not any(s[0] == "local" for s in FIELD_SOURCE.values()) or not any(s[0] == "server" for s in FIELD_SOURCE.values()):
    exit2(f"could not read one :1933-or-local source per field family from the spec.md source table ({os.environ['OV_SPEC_PATH']})")

def source_of(field):
    """("server", None) or ("local", jsonl) for a data-source-field; unknown fields are held to the :1933 rule."""
    if field in FIELD_SOURCE:
        return FIELD_SOURCE[field]
    fam = FAMILY_SOURCE.get((field or "").split(".")[0])
    return next(iter(fam)) if fam else ("server", None)

# design.md §Screen States: the visible label a local figure carries in error
LOCAL_SOURCE_LABEL = {"memory-changelog.jsonl": "from local audit log", "metrics.jsonl": "from local metrics log"}

# Task #284 (A32/A34/A36): design.md §Screen States -> visible pill labels and icon per data-health-state
try:
    design_src = pathlib.Path(os.environ["OV_DESIGN_PATH"]).read_text(encoding="utf-8")
except Exception as exc:
    exit2(f"failed to read feature design: {exc}")
_states_sec = re.search(r"^## Screen States\n(.*?)(?=^## )", design_src, re.S | re.M)
HEALTH_LABELS, STATUS_ICONS = {}, set()
for _line in (_states_sec.group(1).splitlines() if _states_sec else []):
    _hs = re.search(r'data-health-state="([\w-]+)"', _line)
    _lbl = re.search(r"label ((?:`[^`]+`(?:,? or |, )?)+)", _line)
    if _hs and _lbl:
        HEALTH_LABELS[_hs.group(1)] = re.findall(r"`([^`]+)`", _lbl.group(1))
        STATUS_ICONS.update(re.findall(r'data-icon="([\w-]+)"', _line))
if set(HEALTH_LABELS) != {"healthy", "stale", "zero-activity", "server-unreachable"} or len(STATUS_ICONS) != 4:
    exit2(f"could not read 4 health labels and icons from design.md §Screen States: {HEALTH_LABELS}, {STATUS_ICONS}")

# Task #289 (A40/A41): spec-states.md §4 -> the stale_badge values each source may send (ruling rm-b5272a3e)
try:
    states_src = pathlib.Path(os.environ["OV_STATES_PATH"]).read_text(encoding="utf-8")
except Exception as exc:
    exit2(f"failed to read feature operational states: {exc}")
BADGE_VALUES = {}
for _fams, _vals in re.findall(r"((?:`\w+\.stale_badge`(?:\s+and\s+)?)+)\s+(?:is|are)\s+`([^`]+)`", states_src):
    _vs = [v.strip().strip('"') for v in _vals.split("|")]
    for _fam in re.findall(r"`(\w+)\.stale_badge`", _fams):
        BADGE_VALUES[_fam] = _vs
AGE_BADGE = {f: [v for v in vs if re.fullmatch(r">\s*\d+[smhd]", v)] for f, vs in BADGE_VALUES.items()}
_sync_vals = {v for vs in BADGE_VALUES.values() for v in vs if v != "null" and not re.fullmatch(r">\s*\d+[smhd]", v)}
if (len(BADGE_VALUES) < 3 or any(len(v) != 1 for v in AGE_BADGE.values()) or len(_sync_vals) != 1
        or any("null" not in vs for vs in BADGE_VALUES.values())):
    exit2(f"could not read one age value, one sync value and null per source from spec-states.md §4: {BADGE_VALUES}")
SYNC_BADGE = _sync_vals.pop()
AGE_BADGE = {f: v[0] for f, v in AGE_BADGE.items()}

# Task #284 (A33/A34): types.ts -> observer.mode_label values and every timestamp field, named as the page cites it (family.field)
_mode = re.search(r"export type OpenVikingModeLabel\s*=\s*([^;]+);", types_src)
MODE_LABELS = re.findall(r'"([^"]+)"', _mode.group(1)) if _mode else []
_ifaces = {n: b for n, b in re.findall(r"export interface (\w+)\s*\{(.*?)\n\}", types_src, re.S)}
_ts_names = lambda body: [f for f, t in re.findall(r"^\t(\w+)\??:\s*([^;]+);", body, re.M) if re.fullmatch(r"\w+_at|ts", f) and "string" in t]
TS_FIELDS = set()
for _resp in ("OpenVikingOverviewResponse", "OpenVikingEntriesResponse", "OpenVikingAuditResponse"):
    for _fam, _typ, _arr in re.findall(r"^\t(\w+)\??:\s*(\w+)(\[\])?;", _ifaces.get(_resp, ""), re.M):
        TS_FIELDS.update(f"{_fam}{_arr}.{f}" for f in _ts_names(_ifaces.get(_typ, "")))
if len(MODE_LABELS) != 3 or not TS_FIELDS:
    exit2(f"could not read OpenVikingModeLabel values and timestamp fields from {os.environ['OV_TYPES_PATH']}: {MODE_LABELS}, {sorted(TS_FIELDS)}")

# Task #296 (A44): the figure-kind -> field pairing table, read from types.ts and never restated here. Every path the page
# may cite in data-source-field maps to its TypeScript type; the type and the field's own name say what that field can
# render. The three API responses are walked the way the page addresses them: an Overview member is a family
# (`observer.checked_at`), an array member takes `[]` (`entries[].updated_at`, `slots[].state`), and the scalars of the
# entries / audit responses take that response's nickname (`entries.stale_badge`, `audit.stale_badge`).
TYPE_ALIASES = dict(re.findall(r"export type (\w+)\s*=\s*([^;]+);", types_src))

def expand_alias(t):
    out = t
    for _ in range(3):
        nxt = re.sub(r"\b([A-Z]\w+)\b", lambda m: f"({TYPE_ALIASES[m.group(1)].strip()})" if m.group(1) in TYPE_ALIASES else m.group(1), out)
        if nxt == out:
            break
        out = nxt
    return re.sub(r"\s+", " ", out).strip()

FIELD_TYPE = {}

def walk_iface(body, path, nick=None, depth=0):
    """Record every leaf field of a response interface under the path the page cites it by."""
    if depth > 4:
        return
    indents, cur = [], list(path)
    for line in body.split("\n"):
        closing = re.match(r"^(\t+)\};?\s*$", line)
        if closing:
            d = len(closing.group(1))
            while indents and indents[-1] >= d:
                indents.pop()
                cur.pop()
            continue
        m = re.match(r"^(\t+)(\w+)\??:\s*(.*)$", line)
        if not m:
            continue
        d, name, val = len(m.group(1)), m.group(2), m.group(3).strip()
        while indents and indents[-1] >= d:
            indents.pop()
            cur.pop()
        if val.startswith("{"):
            indents.append(d)
            cur.append(name)
            continue
        t = val.rstrip(";").strip()
        arr = t.endswith("[]")
        base = t[:-2].strip() if arr else t
        if base in _ifaces:
            if arr:  # the list itself is a figure too: the page renders it as how many there are
                FIELD_TYPE[".".join(cur + [name])] = t
            walk_iface(_ifaces[base], cur + [name + ("[]" if arr else "")], None, depth + 1)
        else:
            FIELD_TYPE[".".join(([nick] if (nick and not cur) else cur) + [name])] = expand_alias(t)

for _resp, _nick in (("OpenVikingOverviewResponse", None), ("OpenVikingEntriesResponse", "entries"), ("OpenVikingAuditResponse", "audit")):
    if _resp not in _ifaces:
        exit2(f"could not read {_resp} from {os.environ['OV_TYPES_PATH']}")
    walk_iface(_ifaces[_resp], [], _nick)
FIELD_LITERALS = {f: re.findall(r'"([^"]*)"', t) for f, t in FIELD_TYPE.items()}

def field_kind(path, t):
    """What one reading of this field looks like on screen: a percentage, a count, an age, or only its own words."""
    name = path.split(".")[-1]
    if t.strip().endswith("[]"):
        return "count"
    if name.endswith("_pct"):
        return "percent"
    if re.search(r"\bnumber\b", t):
        return "count"
    if re.fullmatch(r"\w*_at|ts", name) and re.search(r"\bstring\b", t):
        return "age"
    return "text"

if not {"metrics.turns_sampled_24h", "metrics.slot_hit_rate_pct", "metrics.avg_injected_tokens", "observer.checked_at",
        "entries[].updated_at", "entries.stale_badge", "audit.stale_badge", "events[].ts", "slots[].state",
        "auxiliary.rollout.pending_wt_land_syncs"} <= set(FIELD_TYPE):
    exit2(f"could not read the dashboard field types from {os.environ['OV_TYPES_PATH']}: {len(FIELD_TYPE)} fields, missing the figure fields the page cites")

# Task #284 (A32/A34): what the server reports for each prototype screen. Panel health follows overview.ts panelHealth
# (0 events -> zero-activity; age > cadence -> stale; else healthy; never server-unreachable for the local-log panels) and the
# daemon's observer.health_state (down -> server-unreachable; degraded rollout -> stale; else healthy). Screen facts:
#   live:  daemon answers, rollout clean; last injection 1m (< 5m), last audit event 5m (< 15m)
#   stale: daemon answers, rollout degraded (worktree syncs pending); last injection 19m (> 5m), last audit event 42m (> 15m)
#   empty: daemon answers, rollout clean; 0 turns and 0 audit events in 24h
#   error: daemon down; local logs: last injection 18m (> 5m), last audit event 18m (> 15m)
SCREEN_TRUTH = {
    "live":  {"mode": "Active", "system-health": "healthy", "context-injection": "healthy", "commit-governance": "healthy"},
    "stale": {"mode": "Degraded Local Fallback", "system-health": "stale", "context-injection": "stale", "commit-governance": "stale"},
    "empty": {"mode": "Active", "system-health": "healthy", "context-injection": "zero-activity", "commit-governance": "zero-activity"},
    "error": {"mode": "Offline", "system-health": "server-unreachable", "context-injection": "stale", "commit-governance": "stale"},
}

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
    "observer.mode_label", "observer.role_memory_folder_count", "observer.roles_total_count",
    "observer.daemon_bind", "observer.queue_depth", "observer.checked_at",
    "metrics.slot_hit_rate_pct", "metrics.avg_injected_tokens", "metrics.turns_sampled_24h", "metrics.last_recorded_at",
    "changelog.session_commits_24h", "changelog.promotions_24h", "changelog.rejected_24h", "changelog.last_event_at",
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
                // #284 lead decision: A03 probes the summary pill carrying the screen's own health (cards show their own panel health, M3-1)
                const screenHealth = { live: 'healthy', stale: 'stale', empty: 'zero-activity', error: 'server-unreachable' }[st];
                const pill = [...document.querySelectorAll('[data-component="summary-card"] [data-slot="state-badge"]')]
                    .find(p => p.getAttribute('data-health-state') === screenHealth && getComputedStyle(p).display !== 'none' && p.getBoundingClientRect().width > 0) || null;
                const s = pill ? getComputedStyle(pill) : null;
                const staleBadges = [...document.querySelectorAll('[data-stale-badge="true"]')].filter(el => getComputedStyle(el).display !== 'none' && el.getBoundingClientRect().width > 0);
                const figs = [...document.querySelectorAll('[data-component="summary-card"] [data-figure]')].map(f => ({
                    text: f.textContent.trim(),
                    unreach: f.getAttribute('data-unreachable-value') === 'true',
                    field: f.getAttribute('data-source-field') || ''
                }));
                const hdrBadge = document.querySelector('[data-component="status-header"] [data-slot="mode-badge"]');
                const bodyTxt = document.body.innerText || '';
                return {
                    label: badge ? badge.textContent.trim() : '',
                    pillLabel: pill ? pill.textContent.trim() : '',
                    icon: pill ? (pill.getAttribute('data-icon') || '') : '',
                    borderStyle: s ? s.borderTopStyle : '',
                    color: s ? s.color : '',
                    staleBadgeCount: staleBadges.length,
                    staleBadgeText: staleBadges.map(b => b.textContent.trim()),
                    figs,
                    hdrMode: hdrBadge ? hdrBadge.textContent.trim() : '',
                    bodyTxt
                };
            }""", st)
            state_sigs[st] = (info["pillLabel"], info["icon"], info["borderStyle"], info["color"])
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
                  and all(bool(x) for x in labels) and all(bool(x) for x in icons) and all(bool(x) for x in borders) and all(bool(x) for x in colors))
        record("A03-DISTINCT-UNHEALTHY-STATES", a03_ok, f"labels={labels}, icons={icons}, borders={borders}", "on each screen a summary pill carries the screen's health (live healthy, stale stale, empty zero-activity, error server-unreachable); those 4 pills have 4 distinct labels, icons, border styles and colors")

        # Task #280: A04 covers the figures spec.md sources from 127.0.0.1:1933; local-JSONL figures are A31's (spec §4 error)
        figs_err = unreachable_check.get("figs", [])
        server_figs = [f for f in figs_err if source_of(f["field"])[0] == "server"]
        has_zero_counter = any(re.match(r"^0(?:\.0+)?%?$", f["text"]) or not f["unreach"] or "— (Unreachable)" not in f["text"] for f in server_figs)
        hdr_fake = "Active" in unreachable_check.get("hdrMode", "") or "Healthy" in unreachable_check.get("cardLabel", "")
        a04_ok = len(figs_err) >= 3 and len(server_figs) >= 1 and not has_zero_counter and not hdr_fake
        record("A04-NO-FAKE-ZERO-ON-UNREACHABLE", a04_ok, f"errorHeader={unreachable_check.get('hdrMode')}, cardLabel={unreachable_check.get('cardLabel')}, summaryFigs={len(figs_err)}, serverFigs={server_figs}", ">=3 summary figures; every :1933-sourced one (spec.md source table) marked data-unreachable-value=true and '— (Unreachable)', never '0' or 'Healthy'")

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

        # ---- A18-A23 (task #269) ----
        ROWS_SEL = '[data-component="memory-row"], [data-component="audit-row"]'
        JS_HELPERS = r"""
            const vis = (el) => {
                if (!el) return false;
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && r.width > 0 && r.height > 0;
            };
            const UNIT = { s: 1, m: 60, h: 3600, d: 86400 };
            const agesOf = (txt) => [...(txt || '').matchAll(/(?:\b([a-z]+)\s+)?(\d+)\s*(s|m|h|d)\s*ago\b/gi)].map(m => ({ word: (m[1] || '').toLowerCase(), secs: parseInt(m[2], 10) * UNIT[m[3].toLowerCase()] }));
            const tabs = () => [...document.querySelectorAll('[role="tab"][data-tab]')];
            const openTab = (t) => { t.click(); return document.querySelector(`[role="tabpanel"][data-tabpanel="${t.getAttribute('data-tab')}"]`); };
            const rowsIn = (root) => [...root.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')].filter(vis);
            const rowUri = (r) => (((r && r.innerText) || '').match(/viking:\/\/[^\s\u00b7,;)]+/) || [''])[0];
            const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        """

        # A18: error / stale / loading reach every tab panel and every age label
        a18_bad = []
        for st in ["error", "stale", "loading"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            a18_bad.extend(page.evaluate("(st) => {" + JS_HELPERS + r"""
                const bad = [];
                const FRESH_SECS = 300;
                const STATE_RE = { error: /unreachable|offline/i, stale: /stale/i, loading: /loading/i };
                const checkAges = (els, where) => {
                    for (const el of els.filter(vis)) {
                        const txt = norm(el.innerText || el.textContent);
                        const ages = agesOf(txt);
                        if (st === 'loading') {
                            if (ages.length || !/loading|fetching|waiting/i.test(txt)) bad.push(`${st}:${where}:age-label '${txt.slice(0, 60)}'`);
                        } else if (ages.some(a => a.secs < FRESH_SECS)) {
                            bad.push(`${st}:${where}:fresh-age '${txt.slice(0, 60)}'`);
                        }
                    }
                };
                const healthy = (root, where) => {
                    for (const el of [...root.querySelectorAll('.badge-healthy, [data-health-state="healthy"]')].filter(vis)) {
                        if (where === 'summary' && el.closest('[role="tabpanel"]')) continue;
                        bad.push(`${st}:${where}:healthy-badge '${norm(el.textContent).slice(0, 40)}'`);
                    }
                };
                checkAges([...document.querySelectorAll('[data-age-label]')].filter(el => !el.closest('[role="tabpanel"]')), 'summary');
                healthy(document, 'summary');
                for (const t of tabs()) {
                    const key = t.getAttribute('data-tab');
                    const panel = openTab(t);
                    if (!panel || !vis(panel)) { bad.push(`${st}:${key}:panel-not-visible`); continue; }
                    const label = panel.querySelector('[data-panel-updated-label]');
                    const labelTxt = label && vis(label) ? norm(label.innerText) : '';
                    const staleBadge = [...panel.querySelectorAll('[data-stale-badge="true"]')].some(vis);
                    if (!(STATE_RE[st].test(labelTxt) || (st === 'stale' && staleBadge))) bad.push(`${st}:${key}:panel-label '${labelTxt.slice(0, 60)}'`);
                    if (st === 'loading') {
                        for (const r of rowsIn(panel)) if (rowUri(r)) bad.push(`${st}:${key}:row-before-load '${rowUri(r)}'`);
                    }
                    checkAges([...panel.querySelectorAll('[data-age-label]')], key);
                    healthy(panel, key);
                }
                tabs()[0]?.click();
                return [...new Set(bad)];
            }""", st))
        record("A18-ALL-PANELS-HONOR-STATE", len(a18_bad) == 0, f"violations={a18_bad[:14]} (total={len(a18_bad)})", "error/stale/loading: every tab panel label names the state, no visible age label < 5m ago (loading: no age at all), no healthy badge, no loaded rows while loading")

        # A19: summary cards and their detail tabs tell the same story
        a19_bad = []
        for st in ["live", "stale", "empty"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            a19_bad.extend(page.evaluate("(st) => {" + JS_HELPERS + r"""
                const bad = [];
                const firstInt = (txt) => { const m = (txt || '').replace(/,/g, '').match(/\b(\d+)\b/); return m ? parseInt(m[1], 10) : null; };
                const card = (id) => document.querySelector(`[data-component="summary-card"][data-card-id="${id}"]`);
                const panelOf = (key) => { const t = document.querySelector(`[role="tab"][data-tab="${key}"]`); const p = t ? openTab(t) : null; return { p, txt: p && vis(p) ? norm(p.innerText).replace(/,/g, '') : '' }; };
                const c3fig = card('commit-governance')?.querySelector('[data-source-field="changelog.session_commits_24h"]');
                const commits = c3fig && c3fig.getAttribute('data-unreachable-value') !== 'true' ? firstInt(c3fig.innerText) : null;
                const t3 = panelOf('commit-audit');
                const auditRows = t3.p ? rowsIn(t3.p) : [];
                if (commits === 0 && auditRows.length) bad.push(`${st}:card3=0 commits but commit-audit lists ${auditRows.length} events`);
                if (commits !== null && commits > 0) {
                    if (!auditRows.length) bad.push(`${st}:card3=${commits} commits but commit-audit lists 0 events`);
                    if (!new RegExp(`\\b${commits}\\b`).test(t3.txt)) bad.push(`${st}:card3=${commits} commits not cited in commit-audit`);
                }
                const c2figs = [...(card('context-injection')?.querySelectorAll('[data-figure]') || [])].filter(f => f.getAttribute('data-unreachable-value') !== 'true');
                const turns = c2figs.map(f => norm(f.innerText).replace(/,/g, '').match(/\b(\d+)\s+turns\b/i)).find(Boolean);
                const t1 = panelOf('mount-map');
                if (turns && !new RegExp(`\\b${turns[1]}\\s+turns?\\b`, 'i').test(t1.txt)) bad.push(`${st}:card2=${turns[1]} turns not cited in mount-map`);
                if (st === 'empty') {
                    for (const t of tabs()) {
                        const p = openTab(t);
                        if (!p || !vis(p)) continue;
                        for (const r of rowsIn(p)) {
                            if (r.getAttribute('data-component') === 'audit-row') { bad.push(`empty:${t.getAttribute('data-tab')}:event listed '${rowUri(r)}'`); continue; }
                            const labels = [...r.querySelectorAll('[data-age-label]')].filter(vis);
                            if (r.hasAttribute('data-age-label')) labels.push(r);
                            for (const el of labels) for (const a of agesOf(el.innerText)) {
                                if (a.secs < 86400 && a.word !== 'checked') bad.push(`empty:${t.getAttribute('data-tab')}:in-window '${norm(el.innerText).slice(0, 50)}'`);
                            }
                        }
                    }
                }
                tabs()[0]?.click();
                return [...new Set(bad)];
            }""", st))
        record("A19-SUMMARY-MATCHES-DETAIL", len(a19_bad) == 0, f"violations={a19_bad[:12]} (total={len(a19_bad)})", "card3 commit count cited by commit-audit (0 -> no events), card2 turn count cited by mount-map, empty state lists no event inside the 24h window")

        # A20 + A21 share one walk over every clickable row of every tab (task #290: A21 runs it on all five screens)
        WALK_JS = "() => {" + JS_HELPERS + r"""
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            if (!drawer) return { rows: [], initial: null, error: 'missing reader drawer' };
            const field = (name, legacy) => drawer.querySelector(`[data-drawer-field="${name}"]`) || drawer.querySelector(legacy);
            const read = () => ({
                uri: norm(field('uri', '#drawer-uri')?.textContent),
                scope: norm(field('scope', '#drawer-scope')?.textContent),
                l0: norm(field('l0', '#drawer-l0-body')?.textContent),
                l1: norm(field('l1', '#drawer-l1-body')?.textContent),
                l2: norm(field('l2', '#drawer-l2-body')?.textContent),
                prov: norm(drawer.querySelector('[data-slot="drawer-provenance"]')?.textContent)
            });
            const initial = read();
            const rows = [];
            for (const t of tabs()) {
                const panel = openTab(t);
                if (!panel || !vis(panel)) continue;
                for (const row of rowsIn(panel)) {
                    if (row.getAttribute('aria-expanded') === 'true') row.click();
                    row.click();
                    rows.push({
                        key: row.getAttribute('data-item-key') || rowUri(row),
                        uri: rowUri(row),
                        abstract: norm(row.querySelector('[data-row-field="l0"], .abstract-copy')?.textContent),
                        drawerVisible: vis(drawer),
                        d: read()
                    });
                }
            }
            drawer.querySelector('[data-slot="drawer-close"]')?.click();
            tabs()[0]?.click();
            return { rows, initial, error: null };
        }"""
        page.goto(f"{file_url}?state=live", wait_until="load")
        walk = page.evaluate(WALK_JS)
        a20_bad = [walk["error"]] if walk["error"] else []
        prev_uri, prev_d = "initial-markup", walk["initial"] or {}
        is_gap = lambda s: bool(re.search(r"unavailable|isolat", s or "", re.I))
        for r in walk["rows"]:
            d, issues = r["d"], []
            role_uri = r["uri"].startswith("viking://agent/")
            if not r["drawerVisible"]:
                issues.append("drawer hidden")
            issues += [f"{k} empty" for k in ["uri", "scope", "l0", "l1", "l2", "prov"] if not d[k]]
            if r["uri"] and d["uri"] != r["uri"]:
                issues.append(f"uri={d['uri']!r}")
            scope_ok = (re.search(r"\brole\b", d["scope"], re.I) and not re.search(r"shared", d["scope"], re.I)) if role_uri else (re.search(r"shared", d["scope"], re.I) and not re.search(r"\brole\b", d["scope"], re.I))
            if not scope_ok:
                issues.append(f"scope={d['scope']!r} for {'role' if role_uri else 'shared'} uri")
            if r["abstract"] and d["l0"] != r["abstract"]:
                issues.append(f"l0 != row abstract ({d['l0'][:40]!r})")
            if prev_uri != r["uri"]:
                for k in ["l1", "l2", "prov"]:
                    if d[k] and d[k] == prev_d.get(k) and not (k != "prov" and is_gap(d[k])):
                        issues.append(f"{k} left over from {prev_uri}")
            if issues:
                a20_bad.append(f"{r['key']}: {'; '.join(issues)}")
            prev_uri, prev_d = r["uri"] or r["key"], d
        record("A20-DRAWER-MATCHES-ROW", len(walk["rows"]) >= 1 and len(a20_bad) == 0, f"rows={len(walk['rows'])}, violations={a20_bad[:10]} (total={len(a20_bad)})", "every clickable row opens a visible drawer whose uri/scope/L0/L1/L2/provenance belong to that row; nothing left over from the previous row")

        # A21: per-role memory rows show only the isolation placeholder; drawer L1/L2 null or unavailable
        # Task #290 amendment (lead decision, same standing as A03/A04): role isolation is a permanent boundary, so it is
        # proven on all five screens -- an outage cannot be the reason a role-scoped layer is withheld.
        a21_bad, a21_role_rows, walks = [], {}, {"live": walk}
        for st in ["stale", "empty", "error", "loading"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            walks[st] = page.evaluate(WALK_JS)
        for st, w in walks.items():
            if w["error"]:
                a21_bad.append(f"{st}: {w['error']}")
            a21_role_rows[st] = 0
            for r in w["rows"]:
                if not r["uri"].startswith("viking://agent/memories/"):
                    continue
                a21_role_rows[st] += 1
                d = r["d"]
                if not re.search(r"isolated per-role memory", r["abstract"], re.I) or len(r["abstract"]) > 120:
                    a21_bad.append(f"{st}:{r['key']}: row L0 {r['abstract'][:50]!r}")
                if not re.search(r"isolated per-role memory", d["l0"], re.I) or len(d["l0"]) > 120:
                    a21_bad.append(f"{st}:{r['key']}: drawer L0 {d['l0'][:50]!r}")
                for k in ["l1", "l2"]:
                    if d[k] and (not (re.search(r"unavailable", d[k], re.I) and re.search(r"isolat", d[k], re.I)) or len(d[k]) > 200):
                        a21_bad.append(f"{st}:{r['key']}: drawer {k.upper()} {d[k][:50]!r}")
            if w["rows"] and a21_role_rows[st] == 0:
                a21_bad.append(f"{st}: {len(w['rows'])} rows, none of them viking://agent/memories/, so isolation proves nothing on this screen")
        page.goto(f"{file_url}?state=live", wait_until="load")
        record("A21-ROLE-ISOLATION", sum(a21_role_rows.values()) >= 1 and len(a21_bad) == 0, f"roleRowsPerState={a21_role_rows}, violations={a21_bad[:10]} (total={len(a21_bad)})", "all 5 states: every viking://agent/memories/ row: row + drawer L0 = isolated placeholder only; drawer L1/L2 null or 'unavailable (isolation)'")

        # A22: drawer focus return, Escape on tooltips, tooltip as overlay, drawer in viewport (S1), tablist keys (S4)
        a22_bad = []
        for vw, vh in [(1440, 900), (390, 844)]:
            page.set_viewport_size({"width": vw, "height": vh})
            page.goto(f"{file_url}?state=live", wait_until="load")
            try:
                idx = page.evaluate("() => {" + JS_HELPERS + r"""
                    for (const t of tabs()) {
                        const p = openTab(t);
                        const r = p && vis(p) ? rowsIn(p)[0] : null;
                        if (r) return [...document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')].indexOf(r);
                    }
                    return -1;
                }""")
                if idx < 0:
                    a22_bad.append(f"{vw}px: no clickable row")
                    continue
                row = page.locator(ROWS_SEL).nth(idx)
                drawer_state = r"""(idx) => {
                    const d = document.querySelector('[data-component="reader-drawer"]');
                    const row = document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')[idx];
                    const s = d ? getComputedStyle(d) : null;
                    const r = d ? d.getBoundingClientRect() : { top: 0, left: 0, bottom: 0, right: 0, width: 0 };
                    const open = !!s && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0;
                    const inView = open && r.top >= -1 && r.left >= -1 && r.bottom <= innerHeight + 1 && r.right <= innerWidth + 1;
                    return { open, inView, rect: [Math.trunc(r.top), Math.trunc(r.bottom), innerHeight], focusOnRow: document.activeElement === row };
                }"""
                # (a) close button returns focus to the row
                row.focus()
                page.keyboard.press("Enter")
                st1 = page.evaluate(drawer_state, idx)
                if not st1["open"]:
                    a22_bad.append(f"{vw}px: Enter on row did not open drawer")
                if not st1["inView"]:
                    a22_bad.append(f"{vw}px: opened drawer outside viewport rect(top,bottom,vh)={st1['rect']}")
                page.evaluate("() => { window.scrollTo(0, document.documentElement.scrollHeight); }")
                st1b = page.evaluate(drawer_state, idx)
                if st1["open"] and not st1b["inView"]:
                    a22_bad.append(f"{vw}px: drawer leaves viewport after scrolling rect={st1b['rect']}")
                page.evaluate("() => { const b = document.querySelector('[data-slot=\"drawer-close\"]'); if (b) { b.focus(); b.click(); } }")
                if not page.evaluate(drawer_state, idx)["focusOnRow"]:
                    a22_bad.append(f"{vw}px: close button did not return focus to the row")
                # (b) Escape from inside the drawer closes it and returns focus to the row
                row.focus()
                page.keyboard.press("Enter")
                page.evaluate("() => { const t = document.querySelector('[data-component=\"reader-drawer\"] [data-drawer-tab]'); if (t) t.focus(); }")
                page.keyboard.press("Escape")
                st2 = page.evaluate(drawer_state, idx)
                if st2["open"] or not st2["focusOnRow"]:
                    a22_bad.append(f"{vw}px: Escape open={st2['open']} focusOnRow={st2['focusOnRow']}")
                # (c) drawer tablist: ArrowRight / End / Home move focus and selection
                row.focus()
                page.keyboard.press("Enter")
                dtabs = page.locator('[data-component="reader-drawer"] [data-drawer-tab]')
                if dtabs.count() >= 3:
                    dtabs.nth(0).focus()
                    for key, want in [("ArrowRight", 1), ("End", dtabs.count() - 1), ("Home", 0)]:
                        page.keyboard.press(key)
                        ok = page.evaluate(r"""(want) => {
                            const ts = [...document.querySelectorAll('[data-component="reader-drawer"] [data-drawer-tab]')];
                            return document.activeElement === ts[want] && ts[want].getAttribute('aria-selected') === 'true';
                        }""", want)
                        if not ok:
                            a22_bad.append(f"{vw}px: drawer tablist {key} did not focus+select tab {want}")
                page.keyboard.press("Escape")
                # (d) workspace tablist: ArrowRight / End / Home / ArrowLeft wrap
                wtabs = page.locator('[role="tab"][data-tab]')
                n_tabs = wtabs.count()
                wtabs.nth(0).click()
                wtabs.nth(0).focus()
                for key, want in [("ArrowRight", 1), ("End", n_tabs - 1), ("Home", 0), ("ArrowLeft", n_tabs - 1)]:
                    page.keyboard.press(key)
                    ok = page.evaluate(r"""(want) => {
                        const ts = [...document.querySelectorAll('[role="tab"][data-tab]')];
                        const p = document.querySelector(`[role="tabpanel"][data-tabpanel="${ts[want].getAttribute('data-tab')}"]`);
                        return document.activeElement === ts[want] && ts[want].getAttribute('aria-selected') === 'true' && !!p && getComputedStyle(p).display !== 'none';
                    }""", want)
                    if not ok:
                        a22_bad.append(f"{vw}px: workspace tablist {key} did not focus+select+show tab {want}")
                wtabs.nth(0).click()
                # (e) tooltips: Escape hides a focused tooltip; showing one moves no card/row/panel by more than 1px
                tips = page.evaluate("() => {" + JS_HELPERS + r"""
                    const boxes = () => [...document.querySelectorAll('[data-component="summary-card"], [role="tabpanel"], [data-component="memory-row"], [data-component="audit-row"]')].filter(vis).map(el => { const r = el.getBoundingClientRect(); return [r.left + scrollX, r.top + scrollY, r.width, r.height]; });
                    const out = [];
                    document.querySelectorAll('button[data-slot="tooltip-trigger"]').forEach((btn, i) => {
                        if (!vis(btn)) return;
                        const before = boxes();
                        btn.focus({ preventScroll: true });
                        const after = boxes();
                        let shift = 0;
                        before.forEach((b, j) => { const a = after[j] || b; for (let k = 0; k < 4; k++) shift = Math.max(shift, Math.abs(a[k] - b[k])); });
                        out.push({ i, tip: btn.getAttribute('aria-describedby') || '', shift });
                        btn.blur();
                    });
                    return out;
                }""")
                for t in tips:
                    if t["shift"] > 1:
                        a22_bad.append(f"{vw}px: tooltip {t['tip']} moved layout by {t['shift']:.0f}px")
                trig = page.locator('button[data-slot="tooltip-trigger"]')
                for t in tips:
                    trig.nth(t["i"]).focus()
                    page.keyboard.press("Escape")
                    shown = page.evaluate(r"""(id) => {
                        const tip = document.getElementById(id);
                        if (!tip) return false;
                        const s = getComputedStyle(tip);
                        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity) > 0 && tip.getBoundingClientRect().width > 0;
                    }""", t["tip"])
                    if shown:
                        a22_bad.append(f"{vw}px: Escape left tooltip {t['tip']} visible while its trigger has focus")
            except Exception as exc:
                a22_bad.append(f"{vw}px: interaction error {str(exc).splitlines()[0][:120]}")
        page.set_viewport_size({"width": 1440, "height": 900})
        record("A22-DRAWER-FOCUS-AND-TOOLTIP-ESC", len(a22_bad) == 0, f"violations={a22_bad[:14]} (total={len(a22_bad)})", "at 1440+390: close/Escape return focus to the row, Escape hides a focused tooltip, tooltip moves layout <=1px, opened drawer inside viewport (S1), Arrow/Home/End move both tablists (S4)")

        # A23: per-slot hit rate and tokens are unmeasured in v1 (spec G3): never a number
        a23_bad, slots_seen = [], 0
        for st in ["live", "stale", "empty", "loading", "error"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            res = page.evaluate("(st) => {" + JS_HELPERS + r"""
                const bad = []; let n = 0;
                tabs().find(t => t.getAttribute('data-tab') === 'mount-map')?.click();
                for (const r of [...document.querySelectorAll('[data-slot-id]')].filter(vis)) {
                    n++;
                    const txt = norm(r.innerText);
                    const id = r.getAttribute('data-slot-id');
                    const m = txt.match(/\d+(?:\.\d+)?\s*%|\b\d[\d,]*\s*(?:avg\s*)?tok(?:en)?s?\b/i);
                    if (m) bad.push(`${st}:slot${id}:'${m[0]}'`);
                    if ((st === 'live' || st === 'stale') && !/not measured yet/i.test(txt)) bad.push(`${st}:slot${id}:missing 'not measured yet'`);
                }
                return { n, bad };
            }""", st)
            a23_bad.extend(res["bad"])
            if st == "live":
                slots_seen = res["n"]
        record("A23-UNMEASURED-PER-SLOT", slots_seen >= 1 and len(a23_bad) == 0, f"liveSlots={slots_seen}, violations={a23_bad[:12]} (total={len(a23_bad)})", "every slot row says 'not measured yet' (live/stale) and never shows a per-slot % or token number in any state")

        # ---- A24-A28 (task #275): the drawer honours and follows state, unmeasured slots stay neutral, no role liveness ----
        STATES5 = ["live", "stale", "empty", "error", "loading"]
        DRAWER_JS = JS_HELPERS + r"""
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            const dfield = (name, legacy) => drawer ? (drawer.querySelector(`[data-drawer-field="${name}"]`) || drawer.querySelector(legacy)) : null;
            const readDrawer = () => ({
                open: vis(drawer),
                l1: norm(dfield('l1', '#drawer-l1-body')?.textContent),
                l2: norm(dfield('l2', '#drawer-l2-body')?.textContent),
                prov: norm(drawer?.querySelector('[data-slot="drawer-provenance"]')?.textContent),
                skeleton: !!drawer && [...drawer.querySelectorAll('[data-skeleton]')].some(vis),
                tone: drawer ? getComputedStyle(drawer).borderTopColor : '',
                reason: { l1: dfield('l1', '#drawer-l1-body')?.getAttribute('data-layer-reason') || '', l2: dfield('l2', '#drawer-l2-body')?.getAttribute('data-layer-reason') || '' }
            });
            const stateTone = () => { const b = document.querySelector('[data-component="status-header"] [data-slot="mode-badge"]'); return b ? getComputedStyle(b).borderTopColor : 'no mode badge'; };
            const ageSet = (txt) => [...new Set(agesOf(txt).map(a => a.secs))].sort((a, b) => a - b).join(',');
            const rowAgeText = (r) => { const els = [...r.querySelectorAll('[data-figure], [data-age-label]')].filter(e => agesOf(e.innerText).length); return els.length ? els.map(e => e.innerText).join(' · ') : r.innerText; };
            const OFFLINE_RE = /unavailable while offline/i;
            const drawerIssues = (st, d, row) => {
                if (!d.open) return ['drawer not visible'];
                const out = [];
                if (d.tone !== stateTone()) out.push(`frame ${d.tone} is not the ${st} tone ${stateTone()}`);
                const ra = ageSet(rowAgeText(row)), da = ageSet(d.prov);
                if (ra !== da) out.push(`drawer age [${da}]s != row age [${ra}]s ('${d.prov.slice(-36)}')`);
                // Task #290 amendment (lead decision, same standing as A03/A04): an outage can only withhold what
                // 127.0.0.1:1933 serves, so this branch skips role-isolated rows and layers already marked structurally
                // unavailable; A42 proves each row's marking against what the same row says while the daemon answers.
                if (st === 'error') for (const k of ['l1', 'l2']) {
                    if (rowUri(row).startsWith('viking://agent/memories/') || d.reason[k] === 'role-isolation' || d.reason[k] === 'structural') continue;
                    if (!OFFLINE_RE.test(d[k])) out.push(`${k.toUpperCase()} '${d[k].slice(0, 36)}' is not 'unavailable while offline'`);
                }
                if (st === 'loading' && !d.skeleton) out.push('no skeleton while loading');
                return out;
            };
        """

        # A24: every clickable row in every state opens a drawer that tells that state's story
        a24_bad, a24_rows = [], {}
        for st in STATES5:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            res = page.evaluate("(st) => {" + DRAWER_JS + r"""
                const bad = []; let n = 0;
                if (!drawer) return { n, bad: ['missing reader drawer'] };
                for (const t of tabs()) {
                    const panel = openTab(t);
                    if (!panel || !vis(panel)) continue;
                    for (const row of rowsIn(panel)) {
                        n++;
                        if (row.getAttribute('aria-expanded') === 'true') row.click();
                        row.click();
                        const key = row.getAttribute('data-item-key') || rowUri(row);
                        for (const issue of drawerIssues(st, readDrawer(), row)) bad.push(`${st}:${key}: ${issue}`);
                        const close = drawer.querySelector('[data-slot="drawer-close"]');
                        if (close && vis(drawer)) close.click();
                    }
                }
                tabs()[0]?.click();
                return { n, bad };
            }""", st)
            a24_rows[st] = res["n"]
            a24_bad.extend(res["bad"])
        a24_seen = {st: [b for b in a24_bad if b.startswith(st + ":")][:3] for st in STATES5}
        record("A24-DRAWER-HONORS-STATE", sum(a24_rows.values()) >= 1 and len(a24_bad) == 0, f"rows={a24_rows}, firstViolationsPerState={a24_seen} (total={len(a24_bad)})", "every clickable row in all 5 states: drawer age = row age, drawer frame = the state's mode-badge tone, error: L1/L2 'unavailable while offline', loading: skeletons")

        # A25: a drawer opened in live re-renders for the new state or closes and hands focus back; it never keeps live content
        page.goto(f"{file_url}?state=live", wait_until="load")
        probe_idx = page.evaluate("() => {" + JS_HELPERS + r"""
            const all = [...document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')];
            const out = [];
            for (const t of tabs()) { const p = openTab(t); if (p && vis(p)) for (const r of rowsIn(p)) out.push(all.indexOf(r)); }
            tabs()[0]?.click();
            return out;
        }""")
        a25_bad, a25_cases = [], 0
        for to_st in ["stale", "empty", "error", "loading"]:
            for idx in probe_idx:
                page.goto(f"{file_url}?state=live", wait_until="load")
                a25_cases += 1
                a25_bad.extend(page.evaluate("([idx, toSt]) => {" + DRAWER_JS + r"""
                    const row = [...document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')][idx];
                    const key = row.getAttribute('data-item-key') || rowUri(row);
                    const panel = row.closest('[role="tabpanel"]');
                    const tab = panel && tabs().find(t => t.getAttribute('data-tab') === panel.getAttribute('data-tabpanel'));
                    if (tab) openTab(tab);
                    row.click();
                    const live = readDrawer();
                    const sw = document.querySelector(`[data-set-state="${toSt}"]`);
                    if (!sw) return [`${key}: no [data-set-state="${toSt}"] control to switch state`];
                    sw.click();
                    const d = readDrawer();
                    const a = document.activeElement;
                    if (!d.open) {
                        if (!a || a === document.body || !vis(a)) return [`live->${toSt}:${key}: drawer closed but focus went to ${a ? a.tagName : 'nothing'}`];
                        if (row.getAttribute('aria-expanded') === 'true') return [`live->${toSt}:${key}: drawer closed but the row is still aria-expanded`];
                        return [];
                    }
                    if (!vis(row)) return [`live->${toSt}:${key}: drawer still open for a row the ${toSt} state hides ('${d.prov.slice(-36)}')`];
                    const out = drawerIssues(toSt, d, row).map(i => `live->${toSt}:${key}: ${i}`);
                    if (d.prov === live.prov && d.tone === live.tone) out.push(`live->${toSt}:${key}: drawer kept the live provenance and frame`);
                    return out;
                }""", [idx, to_st]))
        a25_seen = {st: [b for b in a25_bad if b.startswith(f"live->{st}:") or b.endswith(f'"{st}"] control to switch state')][:3] for st in STATES5[1:]}
        record("A25-DRAWER-FOLLOWS-STATE-CHANGE", a25_cases >= 1 and len(a25_bad) == 0, f"cases={a25_cases}, firstViolationsPerState={a25_seen} (total={len(a25_bad)})", "drawer opened in live, state switched to stale/empty/error/loading: it closes with focus on a visible element, or re-renders and passes A24 for the new state; never keeps the live content")

        # A26: unmeasured slots never look measured; slot rows show only OpenVikingSlotSummary fields and the types.ts uri_prefix
        a26_bad, a26_live = [], 0
        for st in STATES5:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            res = page.evaluate("([st, fields, prefixes]) => {" + JS_HELPERS + r"""
                const bad = []; let n = 0;
                const probe = document.createElement('span');
                probe.className = 'badge badge-healthy';
                probe.textContent = 'probe';
                document.body.appendChild(probe);
                const okStyle = getComputedStyle(probe);
                const okTone = [okStyle.color, okStyle.borderTopColor];
                probe.remove();
                const tab = tabs().find(t => t.getAttribute('data-tab') === 'mount-map');
                const panel = tab ? openTab(tab) : null;
                const head = panel ? norm(panel.querySelector('[data-panel-updated-label]')?.innerText) : '';
                if (/latest mount|\bworker\b/i.test(head)) bad.push(`${st}:mount-map label '${head.slice(0, 60)}' names a mount or worker that no slots[] field carries`);
                for (const r of [...document.querySelectorAll('[data-slot-id]')].filter(vis)) {
                    n++;
                    const id = r.getAttribute('data-slot-id');
                    const txt = norm(r.innerText);
                    for (const el of [r, ...r.querySelectorAll('[data-source-field]')]) {
                        const f = el.getAttribute('data-source-field');
                        if (f === null) continue;
                        const m = f.match(/^slots\[\]\.(\w+)$/);
                        if (!m || !fields.includes(m[1])) bad.push(`${st}:slot${id}: field '${f}' is not in OpenVikingSlotSummary`);
                    }
                    const uris = txt.match(/viking:\/\/[^\s\u00b7,;)]+/g) || [];
                    if (!uris.length) bad.push(`${st}:slot${id}: no uri_prefix shown`);
                    for (const u of uris) if (u !== prefixes[id]) bad.push(`${st}:slot${id}: uri '${u}' is not the types.ts uri_prefix '${prefixes[id]}'`);
                    if ((r.getAttribute('data-slot-state') || 'unmeasured-gap') !== 'unmeasured-gap') continue;
                    const w = txt.match(/\b(hit|live|ok)\b/i);
                    if (w) bad.push(`${st}:slot${id}: '${w[0]}' on an unmeasured slot`);
                    const badges = [...r.querySelectorAll('.badge, [data-slot="state-badge"], [data-health-state]')].filter(vis);
                    for (const b of badges) {
                        const s = getComputedStyle(b);
                        if (b.classList.contains('badge-healthy') || b.getAttribute('data-health-state') === 'healthy' || s.color === okTone[0] || s.borderTopColor === okTone[1])
                            bad.push(`${st}:slot${id}: success tone on '${norm(b.innerText).slice(0, 30)}'`);
                    }
                    if (['live', 'stale', 'empty'].includes(st) && !badges.some(b => /^\W*not measured\b/i.test(norm(b.innerText))))
                        bad.push(`${st}:slot${id}: badge is not the neutral 'Not measured'`);
                }
                tabs()[0]?.click();
                return { n, bad };
            }""", [st, SLOT_FIELDS, SLOT_PREFIX_BY_ID])
            a26_bad.extend(res["bad"])
            if st == "live":
                a26_live = res["n"]
        record("A26-UNMEASURED-SLOT-NEUTRAL", a26_live >= 1 and len(a26_bad) == 0, f"liveSlots={a26_live}, slotFields={SLOT_FIELDS}, violations={a26_bad[:12]} (total={len(a26_bad)})", "unmeasured-gap slots: no success tone, no Hit/Live/OK, badge 'Not measured' (live/stale/empty); slot fields only from types.ts OpenVikingSlotSummary; slot URI = types.ts uri_prefix; no mount/worker claim")

        # A27: in error, card 3 and Tab 3 tell one story: both from the local audit log (same age, same count) or both unreachable
        page.goto(f"{file_url}?state=error", wait_until="load")
        a27 = page.evaluate("() => {" + JS_HELPERS + r"""
            const card = document.querySelector('[data-component="summary-card"][data-card-id="commit-governance"]');
            if (!card) return { bad: ['no commit-governance summary card'], summary: '' };
            const figs = [...card.querySelectorAll('[data-source-field^="changelog."]')].filter(vis);
            const cardTxt = norm(card.innerText);
            const unreach = (f) => f.getAttribute('data-unreachable-value') === 'true';
            const tab = tabs().find(t => t.getAttribute('data-tab') === 'commit-audit');
            const panel = tab ? openTab(tab) : null;
            const rows = panel && vis(panel) ? rowsIn(panel) : [];
            const label = panel ? norm(panel.querySelector('[data-panel-updated-label]')?.innerText) : '';
            const panelTxt = panel && vis(panel) ? norm(panel.innerText).replace(/,/g, '') : '';
            tabs()[0]?.click();
            const summary = `card3='${cardTxt.slice(0, 90)}', tab3Rows=${rows.length}, tab3Label='${label.slice(0, 80)}'`;
            if (figs.length && figs.every(unreach)) {
                if (rows.length || /local audit/i.test(panelTxt)) return { bad: [`card 3 says unreachable but Tab 3 reads the local audit log (${rows.length} events listed)`], summary };
                if (!/unreachable|offline/i.test(label)) return { bad: ['card 3 says unreachable but the Tab 3 label does not'], summary };
                return { bad: [], summary };
            }
            const bad = [];
            if (!figs.length || figs.some(unreach)) bad.push('card 3 mixes unreachable and local figures, or shows none');
            if (!/local audit/i.test(cardTxt)) bad.push("card 3 does not say it reads the local audit log");
            if (!/local audit/i.test(label)) bad.push("Tab 3 label does not say it reads the local audit log");
            const ca = agesOf(cardTxt).map(a => a.secs), la = agesOf(label).map(a => a.secs);
            if (!ca.length || !ca.some(s => la.includes(s))) bad.push(`card 3 age [${ca}]s is not the Tab 3 age [${la}]s`);
            const cf = card.querySelector('[data-source-field="changelog.session_commits_24h"]');
            const m = cf ? norm(cf.innerText).replace(/,/g, '').match(/\b(\d+)\b/) : null;
            if (!m) bad.push('card 3 shows no commit count');
            else if (!new RegExp(`\\b${m[1]}\\b`).test(panelTxt)) bad.push(`card 3 count ${m[1]} is not cited in Tab 3`);
            else if (parseInt(m[1], 10) > 0 && !rows.length) bad.push(`card 3 count ${m[1]} but Tab 3 lists no events`);
            return { bad, summary };
        }""")
        record("A27-SUMMARY-MATCHES-DETAIL-ERROR", len(a27["bad"]) == 0, f"{a27['summary']}, violations={a27['bad']}", "error: card 3 and Tab 3 both read the local audit log (same age, count cited, events listed) or both say unreachable with no events")

        # A28: no panel implies roles are live (no liveness signal in v1); the header count is 'N role memory folders'
        LIVENESS_RE = r"roles?\s+(?:live|online|active)\b|\d+\s*/\s*\d+\s*roles\b|injecting\b[^.]{0,80}\bacross\s+all\b[^.]{0,12}\broles\b"
        a28_bad = []
        key_leak = re.search(r"roles?_(?:online|live|active)\w*", raw_html, re.I)
        if key_leak:
            a28_bad.append(f"source: liveness fixture key '{key_leak.group(0)}'")
        if "role_memory_folder_count" not in raw_html:
            a28_bad.append("source: no role_memory_folder_count fixture key")
        for st in STATES5:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            a28_bad.extend(page.evaluate("([st, reSrc]) => {" + JS_HELPERS + r"""
                const re = new RegExp(reSrc, 'i');
                const bad = [];
                const texts = [];
                for (const t of tabs()) { openTab(t); texts.push([`text(${t.getAttribute('data-tab')})`, document.body.innerText || '']); }
                if (!tabs().length) texts.push(['text', document.body.innerText || '']);
                tabs()[0]?.click();
                document.querySelectorAll('[role="tooltip"]').forEach(t => texts.push([`tooltip#${t.id}`, t.textContent || '']));
                document.querySelectorAll('[aria-label]').forEach(el => texts.push(['aria-label', el.getAttribute('aria-label') || '']));
                for (const [where, t] of texts) { const m = norm(t).match(re); if (m) bad.push(`${st}:${where}: '${m[0]}'`); }
                const fig = document.querySelector('[data-source-field="observer.role_memory_folder_count"]');
                if (['live', 'stale', 'empty'].includes(st)) {
                    if (!fig) bad.push(`${st}: no observer.role_memory_folder_count figure`);
                    else if (!/^\d+ role memory folders$/.test(norm(fig.innerText))) bad.push(`${st}: folder count reads '${norm(fig.innerText)}'`);
                }
                return [...new Set(bad)];
            }""", [st, LIVENESS_RE]))
        record("A28-NO-LIVENESS-CLAIM", len(a28_bad) == 0, f"violations={a28_bad[:12]} (total={len(a28_bad)})", "all 5 states: no text/tooltip/aria-label implies live roles; live/stale/empty header count = 'N role memory folders' from observer.role_memory_folder_count; no roles_*online/live/active key in source")

        # ---- A29-A31 (task #280): session-commit label, phone sheet focus trap, local JSONL panels survive error ----
        # A29: the commit figure counts session commits only (ruling rm-9724bae9) and says so in every state
        a29_bad, a29_live = [], 0
        for m in re.finditer(r"(?<![\w.])(?:changelog\.)?commits_(?:24h)\b|\broles_online_(?:count)\b", raw_html):
            a29_bad.append(f"source: retired field '{m.group(0)}'")
        for st in STATES5:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            res = page.evaluate("(st) => {" + JS_HELPERS + r"""
                const bad = [];
                const texts = [];
                for (const t of tabs()) { openTab(t); texts.push([`text(${t.getAttribute('data-tab')})`, document.body.innerText || '']); }
                if (!tabs().length) texts.push(['text', document.body.innerText || '']);
                tabs()[0]?.click();
                document.querySelectorAll('[role="tooltip"]').forEach(t => texts.push([`tooltip#${t.id}`, t.textContent || '']));
                document.querySelectorAll('[aria-label]').forEach(el => texts.push(['aria-label', el.getAttribute('aria-label') || '']));
                for (const [where, t] of texts) for (const m of norm(t).matchAll(/\b\d[\d,]*\s+commits?\b/gi)) bad.push(`${st}:${where}: bare '${m[0]}'`);
                const figs = [...document.querySelectorAll('[data-source-field]')].filter(el => /commit/i.test(el.getAttribute('data-source-field')));
                for (const f of figs) {
                    const field = f.getAttribute('data-source-field');
                    if (field !== 'changelog.session_commits_24h') bad.push(`${st}: commit figure field '${field}'`);
                    if (!/session commits/i.test(norm(f.textContent))) bad.push(`${st}: commit figure reads '${norm(f.textContent).slice(0, 40)}'`);
                }
                return { n: figs.length, bad: [...new Set(bad)] };
            }""", st)
            a29_bad.extend(res["bad"])
            if st == "live":
                a29_live = res["n"]
        if a29_live < 1:
            a29_bad.append("live: no changelog.session_commits_24h figure")
        record("A29-SESSION-COMMITS-LABEL", len(a29_bad) == 0, f"liveCommitFigures={a29_live}, violations={a29_bad[:12]} (total={len(a29_bad)})", "all 5 states: every commit figure is changelog.session_commits_24h and reads 'session commits'; no rendered text/tooltip/aria-label says '<N> commits' without 'session'; neither retired field (bare commit count, roles-online count) in source")

        # A30: at 390 and 320 the reader opens as a modal bottom sheet that keeps keyboard focus inside it
        a30_bad = []
        in_sheet = r"""(idx) => {
            const d = document.querySelector('[data-component="reader-drawer"]');
            const row = document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')[idx];
            const s = d ? getComputedStyle(d) : null;
            const open = !!s && s.display !== 'none' && s.visibility !== 'hidden' && d.getBoundingClientRect().width > 0;
            const a = document.activeElement;
            const where = a ? (a.getAttribute('data-slot') || a.getAttribute('data-drawer-tab') || a.getAttribute('data-item-key') || a.tagName) : 'nothing';
            return { open, inside: !!d && !!a && a !== document.body && d.contains(a), focusOnRow: a === row, where };
        }"""
        for vw, vh in [(390, 844), (320, 640)]:
            page.set_viewport_size({"width": vw, "height": vh})
            page.goto(f"{file_url}?state=live", wait_until="load")
            try:
                idx = page.evaluate("() => {" + JS_HELPERS + r"""
                    for (const t of tabs()) {
                        const p = openTab(t);
                        const r = p && vis(p) ? rowsIn(p)[0] : null;
                        if (r) return [...document.querySelectorAll('[data-component="memory-row"], [data-component="audit-row"]')].indexOf(r);
                    }
                    return -1;
                }""")
                if idx < 0:
                    a30_bad.append(f"{vw}px: no clickable row")
                    continue
                row = page.locator(ROWS_SEL).nth(idx)
                row.focus()
                page.keyboard.press("Enter")
                s0 = page.evaluate(in_sheet, idx)
                if not s0["open"]:
                    a30_bad.append(f"{vw}px: Enter on row did not open the sheet")
                    continue
                if not s0["inside"]:
                    a30_bad.append(f"{vw}px: opening the sheet left focus outside it on {s0['where']}")
                stops = page.evaluate("() => document.querySelectorAll('[data-component=\"reader-drawer\"] button, [data-component=\"reader-drawer\"] [tabindex], [data-component=\"reader-drawer\"] a[href]').length")
                for key in ["Tab", "Shift+Tab"]:
                    for i in range(stops + 3):
                        page.keyboard.press(key)
                        s1 = page.evaluate(in_sheet, idx)
                        if not s1["open"]:
                            a30_bad.append(f"{vw}px: {key} #{i + 1} closed the sheet")
                            break
                        if not s1["inside"]:
                            a30_bad.append(f"{vw}px: {key} #{i + 1} moved focus outside the sheet to {s1['where']}")
                            break
                page.keyboard.press("Escape")
                s2 = page.evaluate(in_sheet, idx)
                if s2["open"] or not s2["focusOnRow"]:
                    a30_bad.append(f"{vw}px: Escape open={s2['open']} focus on {s2['where']}, not the row")
                row.focus()
                page.keyboard.press("Enter")
                page.locator('[data-component="reader-drawer"] [data-slot="drawer-close"]').focus()
                page.keyboard.press("Enter")
                s3 = page.evaluate(in_sheet, idx)
                if s3["open"] or not s3["focusOnRow"]:
                    a30_bad.append(f"{vw}px: close button open={s3['open']} focus on {s3['where']}, not the row")
            except Exception as exc:
                a30_bad.append(f"{vw}px: interaction error {str(exc).splitlines()[0][:120]}")
        page.set_viewport_size({"width": 1440, "height": 900})
        record("A30-SHEET-FOCUS-TRAP", len(a30_bad) == 0, f"violations={a30_bad[:10]} (total={len(a30_bad)})", "at 390 and 320: opening a row puts focus in the sheet; Tab and Shift+Tab never move it outside while open; Escape and the close button close it and return focus to the row")

        # A31: in error the local JSONL figures keep their count, age and source label (spec §4 error); Tab 3 rows stay listed and open
        page.goto(f"{file_url}?state=error", wait_until="load")
        a31 = page.evaluate("() => {" + JS_HELPERS + r"""
            const out = { figs: [], rows: [], commits: null };
            const fig = (f, where, ctx, summary) => ({ where, ctx, summary, field: f.getAttribute('data-source-field') || '', text: norm(f.innerText || f.textContent), unreach: f.getAttribute('data-unreachable-value') === 'true', age: f.getAttribute('data-age') || '' });
            for (const card of document.querySelectorAll('[data-component="summary-card"]')) {
                const ctx = norm(card.innerText);
                for (const f of card.querySelectorAll('[data-figure]')) out.figs.push(fig(f, `card:${card.getAttribute('data-card-id')}`, ctx, true));
            }
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            for (const t of tabs()) {
                const key = t.getAttribute('data-tab');
                const panel = openTab(t);
                if (!panel || !vis(panel)) continue;
                const ctx = norm(panel.querySelector('[data-panel-updated-label]')?.innerText);
                for (const f of [...panel.querySelectorAll('[data-figure]')].filter(vis)) out.figs.push(fig(f, `tab:${key}`, ctx, false));
                if (key !== 'commit-audit') continue;
                for (const r of rowsIn(panel)) {
                    if (r.getAttribute('aria-expanded') === 'true') r.click();
                    r.click();
                    const l0 = drawer ? norm((drawer.querySelector('[data-drawer-field="l0"]') || drawer.querySelector('#drawer-l0-body'))?.textContent) : '';
                    out.rows.push({ key: r.getAttribute('data-item-key') || rowUri(r), expanded: r.getAttribute('aria-expanded') === 'true', open: vis(drawer), l0 });
                    const close = drawer && drawer.querySelector('[data-slot="drawer-close"]');
                    if (close && vis(drawer)) close.click();
                }
            }
            tabs()[0]?.click();
            const cf = document.querySelector('[data-component="summary-card"][data-card-id="commit-governance"] [data-source-field^="changelog."][data-source-field*="commits"]');
            const m = cf && cf.getAttribute('data-unreachable-value') !== 'true' ? norm(cf.innerText).replace(/,/g, '').match(/\b(\d+)\b/) : null;
            out.commits = m ? parseInt(m[1], 10) : null;
            return out;
        }""")
        a31_bad, a31_local = [], []
        age_re = re.compile(r"\d+\s*[smhd]\s*ago\b", re.I)
        for f in a31["figs"]:
            kind, jsonl = source_of(f["field"])
            if kind != "local":
                continue
            a31_local.append(f"{f['where']}:{f['field']}")
            tag = f"{f['where']}:{f['field']}"
            label = LOCAL_SOURCE_LABEL.get(jsonl)
            if f["unreach"] or re.search(r"unreachable", f["text"], re.I):
                a31_bad.append(f"{tag}: local figure shown unreachable '{f['text'][:40]}'")
            if not f["age"]:
                a31_bad.append(f"{tag}: no data-age")
            if f["summary"] and not re.search(r"\d", f["text"]):
                a31_bad.append(f"{tag}: no count '{f['text'][:40]}'")
            if f["summary"] and not age_re.search(f["ctx"]):
                a31_bad.append(f"{tag}: card shows no age")
            if not f["summary"] and not age_re.search(f["text"]):
                a31_bad.append(f"{tag}: row shows no age '{f['text'][:40]}'")
            if not label:
                a31_bad.append(f"{tag}: no design.md source label for {jsonl}")
            elif label.lower() not in f["ctx"].lower():
                a31_bad.append(f"{tag}: '{label}' not shown ('{f['ctx'][:60]}')")
        if not any(x.startswith("card:commit-governance:") for x in a31_local):
            a31_bad.append("card:commit-governance: no local-JSONL figure")
        if a31["commits"] is None:
            a31_bad.append("card:commit-governance: no session commit count in error")
        elif a31["commits"] > 0 and not a31["rows"]:
            a31_bad.append(f"tab:commit-audit: card 3 counts {a31['commits']} session commits but Tab 3 lists no events")
        for r in a31["rows"]:
            if not (r["expanded"] and r["open"]):
                a31_bad.append(f"tab:commit-audit:{r['key']}: row did not open the reader (expanded={r['expanded']}, open={r['open']})")
            elif not r["l0"] or re.search(r"unavailable while offline", r["l0"], re.I):
                a31_bad.append(f"tab:commit-audit:{r['key']}: L0 '{r['l0'][:40]}' is not the local record")
        record("A31-LOCAL-PANELS-SURVIVE-ERROR", len(a31_bad) == 0, f"localFigures={len(a31_local)}, tab3Rows={len(a31['rows'])}, card3Commits={a31['commits']}, violations={a31_bad[:12]} (total={len(a31_bad)})", "error: every local-JSONL figure (spec.md source table) shows its count/age and 'from local audit log' or 'from local metrics log', never unreachable; card 3 has one; Tab 3 lists its events and each opens the reader with the local L0")

        # ---- A32-A37 (task #284) ----
        # A32: each card pill shows its own panel's health (SCREEN_TRUTH), local-log panels never Unreachable, label per design.md
        a32_bad = []
        for st, truth in SCREEN_TRUTH.items():
            page.goto(f"{file_url}?state={st}", wait_until="load")
            pills = page.evaluate("() => {" + JS_HELPERS + r"""
                return [...document.querySelectorAll('[data-component="summary-card"]')].map(c => {
                    const p = c.querySelector('[data-slot="state-badge"]');
                    return { card: c.getAttribute('data-card-id') || '', hs: p ? (p.getAttribute('data-health-state') || '') : null,
                             text: p ? norm(p.textContent) : '', shown: vis(p),
                             fields: [...c.querySelectorAll('[data-figure][data-source-field]')].map(f => f.getAttribute('data-source-field')) };
                });
            }""")
            for pl in pills:
                want = truth.get(pl["card"])
                local = any(source_of(f)[0] == "local" for f in pl["fields"])
                if want is None:
                    a32_bad.append(f"{st}:{pl['card']}: no expected health for this card")
                    continue
                if pl["hs"] is None or not pl["shown"]:
                    a32_bad.append(f"{st}:{pl['card']}: no visible state pill")
                    continue
                if pl["hs"] != want:
                    a32_bad.append(f"{st}:{pl['card']}: pill data-health-state='{pl['hs']}', panel health_state is '{want}'")
                if local and pl["hs"] == "server-unreachable":
                    a32_bad.append(f"{st}:{pl['card']}: local-log panel ({pl['fields'][0]}) marked server-unreachable")
                own = HEALTH_LABELS.get(pl["hs"], [])
                others = [l for h, ls in HEALTH_LABELS.items() if h != pl["hs"] for l in ls if l not in own]
                if not any(l in pl["text"] for l in own) or any(l in pl["text"] for l in others):
                    a32_bad.append(f"{st}:{pl['card']}: pill text '{pl['text'][:40]}' is not design.md's label {own} for {pl['hs'] or '(none)'}")
            if len(pills) != 3:
                a32_bad.append(f"{st}: {len(pills)} summary cards, expected 3")
        record("A32-CARD-PILL-OWN-HEALTH", len(a32_bad) == 0, f"violations={a32_bad[:12]} (total={len(a32_bad)})", "live/stale/empty/error: every card pill's data-health-state = its panel's health_state; local-log panels never server-unreachable; pill text = design.md label for that health")

        # A33: every visible age sits under a data-source-field naming a types.ts timestamp field; no last-seen / last-contact wording anywhere
        a33_bad = [f"source: '{m.group(0)}'" for m in re.finditer(r"last\s+(?:seen|contact)", raw_html, re.I)]
        a33_seen = 0
        for st in ["live", "stale", "empty", "error", "loading"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            res = page.evaluate("(tsFields) => {" + JS_HELPERS + r"""
                const AGE = /\d+\s?(?:s|m|h|d) (?:ago|old)\b/i;
                const out = [];
                const scan = (where) => {
                    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
                    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
                        const m = (n.nodeValue || '').match(AGE);
                        if (!m || !vis(n.parentElement) || n.parentElement.closest('[role="tooltip"], script, style')) continue;
                        const src = n.parentElement.closest('[data-source-field]');
                        const field = src ? src.getAttribute('data-source-field') : '';
                        out.push({ where, age: m[0], field, ok: tsFields.includes(field), text: norm(n.parentElement.textContent).slice(0, 60) });
                    }
                };
                const drawer = document.querySelector('[data-component="reader-drawer"]');
                for (const t of tabs()) {
                    const panel = openTab(t);
                    scan(t.getAttribute('data-tab'));
                    const row = panel ? rowsIn(panel)[0] : null;
                    if (row) {
                        row.click();
                        scan(`${t.getAttribute('data-tab')}:drawer`);
                        const close = drawer && drawer.querySelector('[data-slot="drawer-close"]');
                        if (close && vis(drawer)) close.click();
                    }
                }
                tabs()[0]?.click();
                return out;
            }""", sorted(TS_FIELDS))
            a33_seen += len(res)
            for r in res:
                if not r["ok"]:
                    a33_bad.append(f"{st}:{r['where']}: '{r['age']}' in '{r['text']}' cites '{r['field'] or '(no data-source-field)'}'")
        a33_bad = list(dict.fromkeys(a33_bad))
        record("A33-NO-UNBACKED-AGE", len(a33_bad) == 0 and a33_seen > 0, f"agesSeen={a33_seen}, violations={a33_bad[:12]} (total={len(a33_bad)})", f"every visible 'N(s|m|h|d) ago|old' sits under a data-source-field in {sorted(TS_FIELDS)}; no last-seen / last-contact wording in the page")

        # A34: the header mode badge reads exactly one observer.mode_label value (types.ts), the one the server sends for that screen
        a34_bad = []
        for st, truth in SCREEN_TRUTH.items():
            page.goto(f"{file_url}?state={st}", wait_until="load")
            hdr = page.evaluate(r"""() => { const b = document.querySelector('[data-component="status-header"] [data-slot="mode-badge"]'); return b ? b.textContent.replace(/\s+/g, ' ').trim() : null; }""")
            label = re.sub(r"^[^A-Za-z]+", "", hdr or "").strip()
            if label not in MODE_LABELS:
                a34_bad.append(f"{st}: mode badge '{hdr}' is not one of {MODE_LABELS}")
            elif label != truth["mode"]:
                a34_bad.append(f"{st}: mode badge '{label}', server sends '{truth['mode']}'")
        record("A34-MODE-LABEL-VALUES", len(a34_bad) == 0, f"violations={a34_bad}", f"header mode badge text in {MODE_LABELS} (freshness detail beside it, not inside)")

        # A35: selected tab, filter and drawer tier never wear a status-* token colour (both themes, every screen)
        status_vars = sorted(set(re.findall(r"--(status-[\w-]+)\s*:", raw_html)))
        a35_bad, a35_n = [], 0
        for st in ["live", "stale", "empty", "error"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            for theme in ["dark", "light"]:
                res = page.evaluate("([theme, vars]) => {" + JS_HELPERS + r"""
                    document.documentElement.setAttribute('data-theme', theme);
                    const probe = document.createElement('span');
                    document.body.appendChild(probe);
                    const tok = {};
                    for (const v of vars) { probe.style.backgroundColor = `var(--${v})`; tok[getComputedStyle(probe).backgroundColor] = v; }
                    probe.remove();
                    const groups = { tab: '[role="tab"][data-tab][aria-selected="true"]',
                                     filter: '.filter-btn[aria-pressed="true"]', tier: '[data-drawer-tab][aria-selected="true"]' };
                    const out = [];
                    for (const [g, sel] of Object.entries(groups)) {
                        const els = [...document.querySelectorAll(sel)];
                        if (!els.length) out.push({ g, bg: '', hit: '(no selected element)' });
                        for (const el of els) { const bg = getComputedStyle(el).backgroundColor; out.push({ g, bg, hit: tok[bg] || '' }); }
                    }
                    return out;
                }""", [theme, status_vars])
                for r in res:
                    a35_n += 1
                    if r["hit"]:
                        a35_bad.append(f"{st}/{theme}:{r['g']}: background {r['bg']} = {r['hit']}")
        a35_bad = list(dict.fromkeys(a35_bad))
        record("A35-SELECTION-NOT-STATUS", len(a35_bad) == 0 and len(status_vars) >= 8, f"statusTokens={len(status_vars)}, selectedChecked={a35_n}, violations={a35_bad[:10]} (total={len(a35_bad)})", "selected tab / filter / drawer tier background is never a --status-* token colour")

        # A36: loading shows skeletons and no status: no status data-icon, no status glyph or label in any pill or badge
        page.goto(f"{file_url}?state=loading", wait_until="load")
        a36 = page.evaluate("([icons, labels]) => {" + JS_HELPERS + r"""
            const bad = [];
            const GLYPH = /[\u25cf\u25d0\u25cc\u2715]/;
            for (const el of [...document.querySelectorAll('[data-icon]')].filter(vis))
                if (icons.includes(el.getAttribute('data-icon'))) bad.push(`data-icon=${el.getAttribute('data-icon')} on '${norm(el.textContent).slice(0, 30)}'`);
            for (const el of [...document.querySelectorAll('.badge, [data-slot="state-badge"], [data-slot="mode-badge"]')].filter(vis)) {
                if (el.closest('.proto-btn, [data-set-state]')) continue;
                const t = norm(el.textContent);
                if (GLYPH.test(t) || labels.some(l => t.includes(l))) bad.push(`pill '${t.slice(0, 30)}'`);
            }
            const cards = [...document.querySelectorAll('[data-component="summary-card"]')];
            const skel = cards.filter(c => [...c.querySelectorAll('[data-skeleton="true"]')].some(vis)).length;
            if (skel !== cards.length || !cards.length) bad.push(`${skel}/${cards.length} summary cards show a skeleton`);
            return bad;
        }""", [sorted(STATUS_ICONS), sorted({l for ls in HEALTH_LABELS.values() for l in ls} | set(MODE_LABELS))])
        record("A36-LOADING-NO-STATUS", len(a36) == 0, f"violations={a36[:10]} (total={len(a36)})", f"loading: 0 visible data-icon in {sorted(STATUS_ICONS)}, 0 pills with a status glyph or label, a skeleton in every summary card")

        # A37: every percentage shown next to a count can come from that count (round(100k/n) for some integer 0 <= k <= n)
        a37_bad, a37_pairs = [], 0
        for st in ["live", "stale", "error"]:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            blocks = page.evaluate("() => {" + JS_HELPERS + r"""
                const out = [...document.querySelectorAll('[data-component="summary-card"]')].filter(vis).map(c => [c.getAttribute('data-card-id'), norm(c.innerText)]);
                for (const t of tabs()) { const p = openTab(t); if (p && vis(p)) out.push([t.getAttribute('data-tab'), norm(p.innerText)]); }
                tabs()[0]?.click();
                return out;
            }""")
            for where, txt in blocks:
                counts = [int(c.replace(",", "")) for c in re.findall(r"\b(\d[\d,]*)\s+turns?\b", txt)]
                for pct in re.findall(r"\b(\d+(?:\.\d+)?)\s?%", txt):
                    dec = len(pct.split(".")[1]) if "." in pct else 0
                    for n in [c for c in counts if c > 0]:
                        a37_pairs += 1
                        if not any(abs(100.0 * k / n - float(pct)) <= 0.5 * 10 ** -dec + 1e-9 for k in range(n + 1)):
                            a37_bad.append(f"{st}:{where}: {pct}% cannot come from {n} turns")
        a37_bad = list(dict.fromkeys(a37_bad))
        record("A37-FIXTURE-ARITHMETIC", len(a37_bad) == 0 and a37_pairs > 0, f"pairsChecked={a37_pairs}, violations={a37_bad}", "each N% beside an 'M turns' count equals round(100k/M) for some integer k")

        # ---- A38-A39 (task #286): observer.last_reachable_at (spec §4, architecture ruling rm-5bbe0bcc) ----
        REACH_FIELD = "observer.last_reachable_at"
        REACH_NULL_TEXT = "No successful contact since the dashboard server started"  # ruling rm-5bbe0bcc condition 1, verbatim
        REACH_SNAPSHOT_JS = "(field) => {" + JS_HELPERS + r"""
            const pick = (el) => el ? [el.id || el.getAttribute('data-card-id') || '', el.getAttribute('data-health-state') || '', el.getAttribute('data-icon') || '',
                                       el.getAttribute('data-stale-badge') || '', el.className || '', norm(el.textContent)] : null;
            const banner = document.getElementById('state-banner');
            return {
                screen: [...document.querySelectorAll('[data-screen-state]')].map(e => e.getAttribute('data-screen-state')),
                health: [...document.querySelectorAll('[data-health-state]')].map(e => [e.id || e.closest('[data-card-id]')?.getAttribute('data-card-id') || '', e.getAttribute('data-health-state')]),
                pills: [...document.querySelectorAll('[data-slot="state-badge"], .badge')].filter(e => !e.closest('[data-prototype-only]')).map(pick),
                mode: pick(document.querySelector('[data-component="status-header"] [data-slot="mode-badge"]')),
                verdict: banner ? [banner.className, norm(banner.querySelector('strong')?.textContent)] : null,
                reach: [...document.querySelectorAll(`[data-source-field="${field}"]`)].filter(vis).map(e => norm(e.textContent)),
            };
        }"""
        REACH_SCREENS = ["live", "stale", "empty", "error", "loading"]

        # A38: flipping last_reachable_at (null, 1m, 3d) changes no data-health-state, pill, mode badge, verdict banner or screen state anywhere;
        # the flip must be observable on the Offline screen (3 distinct last_reachable_at readings), or the check proves nothing
        a38_bad, a38_flip = [], {}
        for st in REACH_SCREENS:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            base = page.evaluate(REACH_SNAPSHOT_JS, REACH_FIELD)
            for v in ["null", "1m", "3d"]:
                page.goto(f"{file_url}?state={st}_reach-{v}", wait_until="load")
                snap = page.evaluate(REACH_SNAPSHOT_JS, REACH_FIELD)
                for key in ["screen", "health", "pills", "mode", "verdict"]:
                    if snap[key] != base[key]:
                        diff = next(((a, b) for a, b in zip(base[key] or [], snap[key] or []) if a != b), (base[key], snap[key]))
                        a38_bad.append(f"{st} last_reachable_at={v}: {key} changed {str(diff[0])[:70]} -> {str(diff[1])[:70]}")
                if st == "error":
                    a38_flip[v] = " | ".join(snap["reach"])
        if len({t for t in a38_flip.values() if t}) != 3:
            a38_bad.append(f"error: last_reachable_at flip not observable, readings {a38_flip} (need 3 distinct visible {REACH_FIELD} texts)")
        record("A38-LAST-REACHABLE-NOT-HEALTH", len(a38_bad) == 0, f"offlineReadings={a38_flip}, violations={a38_bad[:10]} (total={len(a38_bad)})", f"live/stale/empty/error/loading x last_reachable_at null/1m/3d: identical data-screen-state, data-health-state, pills, mode badge and verdict banner; error shows 3 distinct {REACH_FIELD} readings")

        # A39: null reads as the ruling's sentence, never a duration, 0, dash or 'just now'; short ages read in seconds (never 0m);
        # the reading shows only on the Offline screen (elsewhere the daemon answered this request and it would repeat checked_at)
        REACH_EXPECT = {None: "Last answered 18m ago", "null": REACH_NULL_TEXT, "3s": "Last answered 3s ago", "1m": "Last answered 1m ago",
                        "18m": "Last answered 18m ago", "3d": "Last answered 3d ago"}
        RECENT_RE = re.compile(r"\d+\s?(?:s|sec|m|min|h|d)\b|(?<![\d.])0(?![\d.])|\u2014|-{1,2}|just now", re.I)
        ZERO_RE = re.compile(r"(?<![\d.])0\s?(?:s|m|min|h|d)\b|just now|\u2014", re.I)
        a39_bad = []
        for st in REACH_SCREENS:
            for v in REACH_EXPECT:
                page.goto(f"{file_url}?state={st}" + (f"_reach-{v}" if v else ""), wait_until="load")
                texts = page.evaluate(REACH_SNAPSHOT_JS, REACH_FIELD)["reach"]
                tag = f"{st} last_reachable_at={v or 'default'}"
                if st != "error":
                    if texts:
                        a39_bad.append(f"{tag}: shows {texts} (only the Offline screen shows it)")
                    continue
                if len(texts) != 1:
                    a39_bad.append(f"{tag}: {len(texts)} visible {REACH_FIELD} readings, expected 1")
                for t in texts:
                    if t != REACH_EXPECT[v]:
                        a39_bad.append(f"{tag}: reads '{t[:70]}', expected '{REACH_EXPECT[v]}'")
                    if v == "null" and RECENT_RE.search(t):
                        a39_bad.append(f"{tag}: null reading '{t[:70]}' contains '{RECENT_RE.search(t).group(0)}' (duration, 0, dash or just now)")
                    if v != "null" and ZERO_RE.search(t):
                        a39_bad.append(f"{tag}: reading '{t[:70]}' contains '{ZERO_RE.search(t).group(0)}'")
        record("A39-NULL-NOT-JUST-NOW", len(a39_bad) == 0, f"violations={a39_bad[:10]} (total={len(a39_bad)})", f"error: null -> exactly '{REACH_NULL_TEXT}' with no duration/0/dash/just now; 3s -> 'Last answered 3s ago' (never 0m); 18m -> 'Last answered 18m ago'; other screens show no {REACH_FIELD} reading")

        # ---- A40-A41 (task #289): stale_badge names the true reason (spec-states.md §4, architecture ruling rm-b5272a3e) ----
        # What the server sends for each stale fixture: the stale_badge per source, and whether a wt land sync is pending.
        # A pending sync is global (rollout-state.json), so no source is null while one waits; within cadence it reads the
        # sync value, past cadence the age. None is the default stale screen (?state=stale); the rest are ?state=stale_badge-<variant>.
        BADGE_FIXTURES = {
            None:    ({"observer": SYNC_BADGE, "entries": AGE_BADGE["entries"], "audit": AGE_BADGE["audit"]}, True),
            "age":   ({"observer": AGE_BADGE["observer"], "entries": AGE_BADGE["entries"], "audit": AGE_BADGE["audit"]}, False),
            "sync":  ({"observer": SYNC_BADGE, "entries": SYNC_BADGE, "audit": SYNC_BADGE}, True),
            "both":  ({"observer": AGE_BADGE["observer"], "entries": AGE_BADGE["entries"], "audit": AGE_BADGE["audit"]}, True),
            "mixed": ({"observer": None, "entries": None, "audit": AGE_BADGE["audit"]}, False),
        }
        SYNC_FIELD = "auxiliary.rollout.pending_wt_land_syncs"
        DURATION_RE = re.compile(r"\b\d+\s?(?:s|sec|secs|m|min|mins|h|hr|hrs|d)\b", re.I)
        SYNC_PROGRESS_RE = re.compile(r"sync[a-z]*\b[^.]*?(?:waiting to land|still landing|landing|in progress)|(?:waiting to land|still landing|in progress)[^.]*?\bsync", re.I)
        BADGE_SNAPSHOT_JS = "(syncField) => {" + JS_HELPERS + r"""
            const nodes = [...document.querySelectorAll('[data-source-field$=".stale_badge"]')];
            const syncNodes = [...document.querySelectorAll(`[data-source-field="${syncField}"]`)];
            const state = nodes.map(el => ({ fam: (el.getAttribute('data-source-field') || '').split('.')[0],
                                             text: norm(el.textContent), shown: false, marked: false, rowId: null, row: '' }));
            let syncShown = false;
            const sweep = () => {
                nodes.forEach((el, i) => {
                    if (!vis(el)) return;
                    const r = el.closest('[data-stale-row]');
                    state[i].shown = true;
                    state[i].marked = !!el.closest('[data-stale-badge="true"]');
                    state[i].rowId = r ? r.getAttribute('data-stale-row') : null;
                    state[i].row = r ? norm(r.innerText) : '';
                });
                if (!syncShown) syncShown = syncNodes.some(vis);
            };
            sweep();
            for (const t of tabs()) { openTab(t); sweep(); }
            tabs()[0]?.click();
            return { badges: state.filter(s => s.shown), syncShown };
        }"""

        # A40: every stale pill prints the stale_badge the server sends, verbatim; a sync-caused stale says so and carries no age
        # or duration in its row; a null stale_badge shows no reading at all (the live screen, where all three are null, included)
        a40_bad, a41_bad, a40_sync_seen, a41_age_seen = [], [], 0, 0
        badge_texts = {}
        for variant, (want, sync_pending) in BADGE_FIXTURES.items():
            page.goto(f"{file_url}?state=stale" + (f"_badge-{variant}" if variant else ""), wait_until="load")
            snap = page.evaluate(BADGE_SNAPSHOT_JS, SYNC_FIELD)
            seen = {}
            for b in snap["badges"]:
                seen.setdefault(b["fam"], []).append(b)
            badge_texts[variant] = {f: sorted(b["text"] for b in bs) for f, bs in seen.items()}
            tag = f"stale_badge-{variant or 'default'}"
            for fam, expect in want.items():
                got = seen.get(fam, [])
                if expect is None:
                    if got:
                        a40_bad.append(f"{tag}:{fam}: stale_badge is null but the page reads {[g['text'][:30] for g in got]}")
                    continue
                if len(got) != 1:
                    a40_bad.append(f"{tag}:{fam}: {len(got)} visible {fam}.stale_badge readings, expected 1 ('{expect}')")
                    continue
                b = got[0]
                if b["text"] not in BADGE_VALUES[fam]:
                    a40_bad.append(f"{tag}:{fam}: reads '{b['text'][:40]}', not one of {BADGE_VALUES[fam]} (spec-states.md §4)")
                if not b["marked"]:
                    a40_bad.append(f"{tag}:{fam}: reading '{b['text'][:40]}' carries no [data-stale-badge=\"true\"]")
                if b["rowId"] != fam:
                    a40_bad.append(f"{tag}:{fam}: reading sits in row '{b['rowId']}', expected [data-stale-row=\"{fam}\"]")
                if expect == SYNC_BADGE:
                    a40_sync_seen += 1
                    if b["text"] != SYNC_BADGE:
                        a40_bad.append(f"{tag}:{fam}: sync-caused stale reads '{b['text'][:40]}', expected '{SYNC_BADGE}'")
                    dur = DURATION_RE.search(b["row"])
                    if dur:
                        a40_bad.append(f"{tag}:{fam}: '{SYNC_BADGE}' row says '{dur.group(0)}' in '{b['row'][:70]}'")
                    if not SYNC_PROGRESS_RE.search(b["row"]):
                        a40_bad.append(f"{tag}:{fam}: '{SYNC_BADGE}' row does not say a sync is still landing ('{b['row'][:70]}')")
                elif sync_pending:
                    a41_age_seen += 1
                    if b["text"] == SYNC_BADGE:
                        a41_bad.append(f"{tag}:{fam}: age past cadence with a sync pending reads '{SYNC_BADGE}', expected the age '{expect}'")
                    elif b["text"] != expect:
                        a41_bad.append(f"{tag}:{fam}: reads '{b['text'][:40]}', expected the age '{expect}'")
                    if fam == "observer" and not SYNC_PROGRESS_RE.search(b["row"]):
                        a41_bad.append(f"{tag}:{fam}: row '{b['row'][:70]}' drops the pending sync it is also stale for")
            if sync_pending and not snap["syncShown"]:
                a41_bad.append(f"{tag}: no visible {SYNC_FIELD} reading, so the fixture never shows a sync is pending")
        page.goto(f"{file_url}?state=live", wait_until="load")
        for b in page.evaluate(BADGE_SNAPSHOT_JS, SYNC_FIELD)["badges"]:
            a40_bad.append(f"live:{b['fam']}: reads '{b['text'][:40]}' while every stale_badge is null")
        if a40_sync_seen < 2:
            a40_bad.append(f"only {a40_sync_seen} '{SYNC_BADGE}' readings across the fixtures (need the daemon card and a panel)")
        record("A40-SYNC-STALE-READS-ITS-BADGE", len(a40_bad) == 0, f"syncReadings={a40_sync_seen}, fixtures={badge_texts}, violations={a40_bad[:10]} (total={len(a40_bad)})", f"every stale pill prints its source's stale_badge verbatim ({BADGE_VALUES}); a '{SYNC_BADGE}' row says a sync is still landing and holds no age or duration; null shows no reading")

        # A41: age wins. In a fixture where both causes hold, each source past its cadence still reads the age, never the sync value
        if a41_age_seen < 3 or badge_texts.get("both") == badge_texts.get("sync") or not badge_texts.get("both"):
            a41_bad.append(f"age-with-sync readings={a41_age_seen}, both={badge_texts.get('both')}, sync={badge_texts.get('sync')} (need a both-causes fixture that differs from the sync-only one)")
        record("A41-AGE-WINS-OVER-PENDING-SYNC", len(a41_bad) == 0, f"ageWithSyncReadings={a41_age_seen}, both={badge_texts.get('both')}, sync={badge_texts.get('sync')}, violations={a41_bad[:10]} (total={len(a41_bad)})", f"with a sync pending and the age past cadence the badge is the age ({AGE_BADGE}), never '{SYNC_BADGE}'; the daemon row still names the pending sync; every sync-pending fixture shows {SYNC_FIELD}")

        # ---- A42-A43 (task #290, VERIFICATION-4 M4-1): on the Offline screen every row keeps its own reason ----
        # An outage can only withhold what the daemon serves. A layer that is already unavailable while :1933 answers
        # -- role isolation (R-ISOLATION-1), or a mount that keeps no copy of the text -- is withheld by a permanent
        # boundary, so its sentence must not change when the daemon stops answering; only a layer the daemon really
        # serves may read the offline sentence. Which row is which is read from the page's own live rendering, so this
        # checker dictates no copy: it compares the Offline screen against what the same row says while the daemon answers.
        ROW_REASON_JS = "() => {" + JS_HELPERS + r"""
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            if (!drawer) return { rows: [], error: 'missing reader drawer' };
            const dfield = (name) => drawer.querySelector(`[data-drawer-field="${name}"]`) || drawer.querySelector(`#drawer-${name}-body`);
            const read = (k) => { const el = dfield(k); return { text: norm(el ? el.textContent : ''), reason: (el && el.getAttribute('data-layer-reason')) || '' }; };
            const rows = [];
            for (const t of tabs()) {
                const panel = openTab(t);
                if (!panel || !vis(panel)) continue;
                for (const row of rowsIn(panel)) {
                    if (row.getAttribute('aria-expanded') === 'true') row.click();
                    row.click();
                    rows.push({ key: row.getAttribute('data-item-key') || rowUri(row), tab: t.getAttribute('data-tab'), uri: rowUri(row), l1: read('l1'), l2: read('l2') });
                    const close = drawer.querySelector('[data-slot="drawer-close"]');
                    if (close && vis(drawer)) close.click();
                }
            }
            tabs()[0]?.click();
            return { rows, error: null };
        }"""
        page.goto(f"{file_url}?state=live", wait_until="load")
        live_layers = page.evaluate(ROW_REASON_JS)
        page.goto(f"{file_url}?state=error", wait_until="load")
        offline_layers = page.evaluate(ROW_REASON_JS)
        ROLE_URI = "viking://agent/memories/"
        GAP_RE = re.compile(r"unavailable|isolat", re.I)
        OUTAGE_RE = re.compile(r"while offline|not answering|unreachable|\boffline\b", re.I)
        OFFLINE_SENTENCE_RE = re.compile(r"unavailable while offline", re.I)
        a42_bad = [e for e in [live_layers.get("error"), offline_layers.get("error")] if e]
        live_by_key = {r["key"]: r for r in live_layers["rows"]}
        a42_seen = {"role-isolation": 0, "structural": 0, "daemon": 0}
        for r in offline_layers["rows"]:
            base = live_by_key.get(r["key"])
            if base is None:
                a42_bad.append(f"{r['key']}: on the Offline screen but not on the live screen, so its own reason cannot be read")
                continue
            role = r["uri"].startswith(ROLE_URI)
            for k in ["l1", "l2"]:
                own = bool(GAP_RE.search(base[k]["text"] or ""))
                want = "role-isolation" if role else ("structural" if own else "daemon")
                a42_seen[want] += 1
                if role and not own:
                    a42_bad.append(f"{r['key']}:{k.upper()}: role-isolated row shows layer text while the daemon answers ('{base[k]['text'][:44]}')")
                if r[k]["reason"] != want:
                    a42_bad.append(f"{r['key']}:{k.upper()}: marked data-layer-reason={r[k]['reason']!r}, its live reading says {want!r}")
                if want == "daemon":
                    if not OFFLINE_SENTENCE_RE.search(r[k]["text"] or ""):
                        a42_bad.append(f"{r['key']}:{k.upper()}: daemon-served layer reads '{r[k]['text'][:44]}', not the offline sentence")
                    if r[k]["text"] == base[k]["text"]:
                        a42_bad.append(f"{r['key']}:{k.upper()}: still shows the daemon's text while 127.0.0.1:1933 is down")
                elif r[k]["text"] != base[k]["text"]:
                    blamed = OUTAGE_RE.search(r[k]["text"] or "")
                    why = f"the outage ('{r[k]['text'][:44]}')" if blamed else f"'{r[k]['text'][:44]}'"
                    a42_bad.append(f"{r['key']}:{k.upper()}: own {want} reason '{base[k]['text'][:44]}' replaced with {why}")
        for kind in ["role-isolation", "structural", "daemon"]:
            if a42_seen[kind] == 0:
                a42_bad.append(f"no {kind} layer among the {len(offline_layers['rows'])} rows of the Offline screen, so the rule proves nothing")
        record("A42-OFFLINE-ROW-KEEPS-ITS-REASON", len(a42_bad) == 0, f"offlineRows={len(offline_layers['rows'])}, layers={a42_seen}, violations={a42_bad[:10]} (total={len(a42_bad)})", "?state=error: a layer already unavailable while the daemon answers keeps that same sentence (role isolation, or a mount that keeps no copy), only a daemon-served layer reads 'unavailable while offline', and every layer's data-layer-reason matches its live reading")

        # A43: the Offline screen promises text comes back only for the layers the daemon serves, never for every row it lists
        page.goto(f"{file_url}?state=error", wait_until="load")
        offline_text = page.evaluate("() => {" + JS_HELPERS + r"""
            const out = [];
            const grab = () => { const t = document.body.innerText || ''; if (!out.includes(t)) out.push(t); };
            grab();
            for (const t of tabs()) { openTab(t); grab(); }
            tabs()[0]?.click();
            return out;
        }""")
        PROMISE_RE = re.compile(r"\b(?:opens?|comes?|returns?|appears?|reappears?|loads?)\b[^.;\n]*\b(?:again|back)\b", re.I)
        EVERY_ROW_RE = re.compile(r"\b(?:their|these|those|all|every|each)\b", re.I)
        SERVED_RE = re.compile(r"\bread from\b[^.;\n]*\b(?:daemon|127\.0\.0\.1:1933)\b|\b(?:daemon|127\.0\.0\.1:1933)\b[^.;\n]*\b(?:serves|sends|reads)\b", re.I)
        a43_bad, a43_promises = [], []
        for txt in offline_text:
            for piece in re.split(r"[.;\n]+", txt):
                s = re.sub(r"\s+", " ", piece).strip()
                if not s or not PROMISE_RE.search(s) or s in a43_promises:
                    continue
                a43_promises.append(s)
                every = EVERY_ROW_RE.search(s)
                if every:
                    a43_bad.append(f"promises it for every row it lists ({every.group(0)!r}): '{s[:90]}'")
                if not SERVED_RE.search(s):
                    a43_bad.append(f"promise never names what the daemon serves: '{s[:90]}'")
        if not a43_promises:
            a43_bad.append("the Offline screen never says what comes back when the daemon answers")
        record("A43-OFFLINE-PROMISE-IS-SCOPED", len(a43_bad) == 0, f"promises={[p[:70] for p in a43_promises]}, violations={a43_bad[:10]} (total={len(a43_bad)})", "?state=error: every sentence promising text comes back names the daemon-served layers it is limited to, never promises it for every listed row, and at least one such sentence exists")

        # ---- A44 (task #296, VERIFICATION-4 S4-1 + VERIFICATION-5 S5-1): every figure sits under the field that produces it ----
        # S4-1 and S5-1 are one defect twice: an element names a data-source-field that cannot yield the figure inside it, so a
        # frontend wired from the attribute reads the wrong field for a label that happens to be true. The pairing table is
        # FIELD_TYPE, built from types.ts above: a field's name and type say what it can render -- a `_pct` field a percentage,
        # a number or a list one count, a timestamp field one age, a string or literal union only its own words. One attribute
        # names one field, so outside its nested [data-source-field] spans an element may hold at most one reading.
        FIGURE_SCAN_JS = "() => {" + JS_HELPERS + r"""
            const out = [], seen = new Set();
            const scan = (where) => {
                for (const el of document.querySelectorAll('[data-source-field]')) {
                    if (!vis(el) || el.closest('[role="tooltip"]')) continue;
                    let own = el.textContent || '';
                    for (const n of el.querySelectorAll('[data-source-field]')) own = own.replace(n.textContent, ' ');
                    const field = el.getAttribute('data-source-field') || '';
                    const key = field + '|' + norm(own);
                    if (seen.has(key)) continue;
                    seen.add(key);
                    out.push({ where, field, own: norm(own), full: norm(el.textContent) });
                }
            };
            scan('summary');
            const drawer = document.querySelector('[data-component="reader-drawer"]');
            for (const t of tabs()) {
                const panel = openTab(t);
                scan(t.getAttribute('data-tab'));
                const row = panel ? rowsIn(panel)[0] : null;
                if (row) {
                    row.click();
                    scan(`${t.getAttribute('data-tab')}:drawer`);
                    const close = drawer && drawer.querySelector('[data-slot="drawer-close"]');
                    if (close && vis(drawer)) close.click();
                }
            }
            tabs()[0]?.click();
            return out;
        }"""
        AGE_READING_RE = re.compile(r"\b\d+\s*(?:s|m|h|d)\s+(?:ago|old)\b", re.I)
        PCT_READING_RE = re.compile(r"\b\d[\d,]*(?:\.\d+)?\s*%")
        NUM_READING_RE = re.compile(r"\d[\d,]*(?:\.\d+)?")
        # not readings: the daemon's own address, a disclosure tier, a contract rule id, a numeral glued into a name by a hyphen
        # (`5-slot`, `Turn-1`), and the window or cadence a figure is measured over
        NOT_A_READING_RE = [
            re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b"),
            re.compile(r"\bL[0-9]\b"),
            re.compile(r"\bR-[A-Z0-9-]+\b"),
            re.compile(r"\b\d+-\w|\w-\d+\b"),
            re.compile(r"\(\s*\d+\s*[smhd]\s*\)|\b(?:in|per|every|over|last|within)\s+\d+\s*[smhd]\b|\b\d+\s*[smhd]\s+(?:cadence|window)\b|/\s*\d+\s*[smhd]\b", re.I),
        ]

        def figure_readings(text, literals):
            """Every measured value an element shows in its own words, each as (kind, text)."""
            s = text
            for lit in sorted([l for l in literals if l], key=len, reverse=True):
                s = s.replace(lit, " ")
            for rx in NOT_A_READING_RE:
                s = rx.sub(" ", s)
            found = [("age", m.group(0)) for m in AGE_READING_RE.finditer(s)]
            s = AGE_READING_RE.sub(" ", s)
            found += [("percent", m.group(0)) for m in PCT_READING_RE.finditer(s)]
            s = PCT_READING_RE.sub(" ", s)
            return found + [("count", m.group(0)) for m in NUM_READING_RE.finditer(s)]

        a44_bad, a44_figures, a44_proved = [], 0, {"count": 0, "percent": 0, "age": 0}
        for st in STATES5:
            page.goto(f"{file_url}?state={st}", wait_until="load")
            for r in page.evaluate(FIGURE_SCAN_JS):
                a44_figures += 1
                field, ts_type = r["field"], FIELD_TYPE.get(r["field"])
                if ts_type is None:
                    a44_bad.append(f"{st}:{r['where']}: '{r['full'][:40]}' cites '{field}', which no dashboard response sends")
                    continue
                kind = field_kind(field, ts_type)
                reads = figure_readings(r["own"], FIELD_LITERALS[field])
                if len(reads) > 1:
                    a44_bad.append(f"{st}:{r['where']}: '{r['full'][:60]}' names one field ({field}) but shows {len(reads)} figures {[v for _, v in reads]}; at least one comes from another field")
                    continue
                if not reads:
                    continue
                got, val = reads[0]
                if got != kind:
                    a44_bad.append(f"{st}:{r['where']}: '{val}' in '{r['full'][:60]}' is a {got}, but {field}: {ts_type} yields a {kind}")
                else:
                    a44_proved[kind] += 1
        for kind, n in a44_proved.items():
            if n == 0:
                a44_bad.append(f"no {kind} figure among the {a44_figures} walked, so the rule proves nothing for that kind")
        record("A44-FIGURE-CITES-ITS-FIELD", len(a44_bad) == 0, f"figures={a44_figures}, proved={a44_proved}, violations={a44_bad[:10]} (total={len(a44_bad)})", "live/stale/empty/error/loading: every [data-source-field] element holds at most one reading outside its nested field spans, and that reading is what its type in types.ts yields (a percentage for a _pct field, a count for a number or list, an age for a timestamp, only its own words for a string)")

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
