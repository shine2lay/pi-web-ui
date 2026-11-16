export function renderWhyModal(isOpen: boolean = false): string {
	return `
    <div class="why-modal-backdrop" id="why-modal" role="dialog" aria-modal="true" aria-label="Why this rework is designed this way" ${isOpen ? "" : "hidden"}>
      <div class="why-modal-dialog">
        <div style="display:flex; justify-content:space-between; align-items:center; gap:12px; margin-bottom:10px;">
          <strong style="font-size:16px;">Why this rework is designed this way (4 plain-English choices)</strong>
          <button type="button" class="chip-btn" id="why-modal-close-btn">Close ✕</button>
        </div>
        <details class="why-details" open>
          <summary>
            <span>Why this rework is designed this way — 4 plain-English choices (tap to hide or show)</span>
          </summary>
          <div class="why-grid">
            <div class="callout-box">
              <strong>1. Unified All-Department Task Triage Table as the First View (Linear / GitHub Projects pattern)</strong>
              <div><strong>Problem:</strong> Grouping the landing page into big Initiative/Ask cards hid individual tasks across departments and made manual task triage harder.</div>
              <div><strong>Why this choice works best:</strong> The default first view lists all available tasks across every department in one scannable table sorted by urgency (<em>! Needs you → ⊗ Blocked → ◔ Waiting → ? Asking lead → ⏸ Paused → ⚡ Deploying → ↑ Landing → ✓· Landed → ● Working → ○ Queued → ✓✓ Live → ✓ Done</em>).</div>
              <div><strong>Option rejected:</strong> Multi-card Bento overview of Initiative/Ask containers as the landing page.</div>
            </div>
            <div class="callout-box">
              <strong>2. Direct Manual Filtering by Department, App, State, Tag, or Search</strong>
              <div><strong>Problem:</strong> Hiding filters inside a secondary toggle or forcing you into one fixed grouping slowed down manual triage.</div>
              <div><strong>Why this choice works best:</strong> Every filter bar row is visible up front — click any <em>Dept</em> (Design, Frontend, Backend, QA, Ops, Architecture), <em>App</em> (RollCall, Pi Web UI, Inkflow, Temper), <em>State</em>, <em>Tag</em>, or type in the search box to slice the task list immediately.</div>
              <div><strong>Option rejected:</strong> Hidden filter drawers or automatic card grouping without direct manual controls.</div>
            </div>
            <div class="callout-box">
              <strong>3. 1-Click Tag Implementation DAG &amp; Task States (Dagster / Prefect pattern)</strong>
              <div><strong>Problem:</strong> Showing all DAGs at once creates visual clutter, while hiding dependencies completely makes it hard to see how a tag's implementation fits together.</div>
              <div><strong>Why this choice works best:</strong> Every tag in the filter bar and on every task row has a 1-click <strong>☍ #tag DAG</strong> button. Clicking it opens that specific tag's multi-stage Implementation DAG (<em>Stage 1 → Stage 2 → Stage 3</em>) with SVG dependency arrows, cross-department handoff stations, and each task's live state.</div>
              <div><strong>Option rejected:</strong> Rendering multiple expanded DAGs simultaneously on initial page load.</div>
            </div>
            <div class="callout-box">
              <strong>4. Full 12-Step State Hierarchy + Plain-English "How to Unblock"</strong>
              <div><strong>Problem:</strong> "Done" did not tell you whether code was still merging, sitting on master undeployed, or live, and blocked tasks did not state what would unblock them.</div>
              <div><strong>Why this choice works best:</strong> Separates attention states (<em>Needs you, Asking lead, Blocked, Waiting, Paused, Queued</em>) from delivery states (<em>Working → Landing → Landed · not deployed → Deploying → Live / Deployed</em> vs <em>Done (no deploy)</em>), with a 1-line <strong>How to unblock:</strong> summary directly in the row.</div>
              <div><strong>Option rejected:</strong> A flat 3-state badge (<em>Queued / Working / Done</em>) or raw shell check strings.</div>
            </div>
          </div>
        </details>
      </div>
    </div>
  `;
}
