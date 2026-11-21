#!/usr/bin/env python3
"""Ops #1058 (Q-STALL-1 silence watch, step 1): builds replay-7d.json, the frozen 7-day records the S12
replay-parity case reads.

It reuses the replay's own episode extraction (ops #1054 replay_lib.py, kept outside this repo) so the fixture
and replay_stalls.out come from one reading of the records. It writes ids, roles, times and states only: no
titles, no project names, no file paths, no message text (AGENTS.md rule 8). Turn times are kept only where a
case can look at them: the deciding role's turns inside each wait.

    python3 tests/unit/silence-watch/build-fixture.py [replay_lib dir]   # default ~/ops-checks/queue-hardening
"""

import json
import os
import sys

lib_dir = sys.argv[1] if len(sys.argv) > 1 else os.path.expanduser("~/ops-checks/queue-hardening")
sys.path.insert(0, lib_dir)
import replay_lib as R  # noqa: E402

eps, turns_by = R.episodes(R.registry(), R.home_chats())
# Every wait that is still open somewhere in the window (the S12 rounds run from T0 to T1).
win = [e for e in eps if (e["end"] or R.T1) > R.T0 and e["start"] < R.T1]
win.sort(key=lambda e: (e["start"], e["role"] or "", e["id"]))

waits = []
spans = {}
for e in win:
    if not e["role"] or not e["who"]:
        raise SystemExit(f"wait without a role: id {e['id']} at {R.iso(e['start'])}")
    waits.append(
        {
            "role": e["role"],
            "id": e["id"],
            "state": e["state"],
            "start": e["start"],
            "end": e["end"],
            "decidingRole": e["who"],
            "n": e["n"],
            "parked": e["parked"],
            "leadBlock": e["lead_block"],
            "checkpoint": e["checkpoint"],
            "onTasks": len(e["on"]),
        }
    )
    spans.setdefault(e["who"], []).append((e["start"], min(e["end"] or R.T1, R.T1)))

turns = {}
for role, ss in sorted(spans.items()):
    kept = sorted({t for t in turns_by.get(role, []) for a, b in ss if a <= t <= b})
    turns[role] = kept

out = {
    "about": "Ops #1058 S12: sanitised queue waits (ids, roles, times, states) and home-chat turn times; no text",
    "t0": R.T0,
    "t1": R.T1,
    "waits": waits,
    "turns": turns,
}
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "replay-7d.json"), "w") as f:
    json.dump(out, f, separators=(",", ":"))
    f.write("\n")
print(f"waits {len(waits)}, turn times {sum(len(v) for v in turns.values())}")
