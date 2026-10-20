// Test-only: owner's fictional prototype controller. Never imported by web/src.
// Timed scripted mock sends are not started in the exact initial scenes.
class DCLogic {
  constructor(props) { this.props = props; }
  setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }; this.update?.(); }
}
export class ReferenceModel extends DCLogic {
  state = { scenario: null, q: '', initiative: 'all', stateFilter: 'all', drawer: 'unset', drawerTab: 'work', resolved: {}, openAnswer: null, showRead: false, actTab: 'work', actMore: false, sent: [], flights: [], pulse: {}, now: 0, tip: null, done: {}, readAnswers: {} };

  // Prototype only: plays scripted mock messages so you can see a send animate.
  // In the product, sendMessage() would be driven by real message events.
  componentDidMount() {
    this._i = 0;
    this._first = setTimeout(() => this.sendNext(), 1800);
    this._tick = setInterval(() => this.sendNext(), 3500);
  }
  measureGraph() {
    const el = this._graphEl;
    if (!el) return;
    const w = Math.round(el.clientWidth), h = Math.round(el.clientHeight);
    if (w && h && (w !== this.state.gw || h !== this.state.gh)) this.setState({ gw: w, gh: h });
    if (!this._ro && window.ResizeObserver) { this._ro = new ResizeObserver(() => this.measureGraph()); this._ro.observe(el); }
    if (!this._onResize) { this._onResize = () => this.measureGraph(); window.addEventListener('resize', this._onResize); }
  }
  componentWillUnmount() {
    if (this._ro) this._ro.disconnect();
    if (this._onResize) window.removeEventListener('resize', this._onResize);
    clearTimeout(this._first); clearInterval(this._tick); clearTimeout(this._settleT);
    if (this._raf) cancelAnimationFrame(this._raf);
  }
  sendNext() {
    const sc = this.state.scenario || this.props.scenario || 'live';
    if (sc !== 'live' && sc !== 'empty') return;
    if ((this.state.view || this.props.view || 'glance') !== 'glance') return;
    if (this.state.expanded) return;
    // Scripted mock events: a send makes a new arrow; a process removes it; a reply is a new arrow back.
    const S = [
      { process: 'm_coo_ops' },
      { send: { id: 's1', from: 'ops', to: 'coo', ref: '#112', text: 'Accepted #112. It starts after #98 finishes.' } },
      { process: 's1' },
      { send: { id: 's2', from: 'coo', to: 'you', ref: 'Update', via: 'Telegram', text: 'Ops accepted the health-check rollout (#112). It starts after #98; no start time promised.' } },
      { send: { id: 's3', from: 'design', to: 'data', ref: '#41', text: 'Acceptance receipt issued for the notebook format. You can run #8.' } },
      { process: 's3' },
      { send: { id: 's4', from: 'data', to: 'design', ref: '#8', text: 'Thanks. Running import #8 now.' } },
      { process: 's4' },
      { send: { id: 's5', from: 'security', to: 'ops', ref: 'Logs', text: 'Can you rotate the service logs today? It came up in the access review.' } },
      { process: 'm_docs_temper' },
      { send: { id: 's6', from: 'temper', to: 'docs', ref: '#71', text: 'Got it. Change notes will follow once #69 is done.' } },
      { process: 's5' },
      { send: { id: 's7', from: 'ops', to: 'security', ref: 'Logs', text: 'Queued log rotation after #98.' } }
    ];
    if (this._i >= S.length) return;
    const ev = S[this._i++];
    if (ev.send) this.sendMessage(Object.assign({ t: Date.now() }, ev.send));
    else this.markRead([ev.process]);
  }
  markRead(ids) {
    const t0 = performance.now();
    const done = Object.assign({}, this.state.done);
    ids.forEach((id) => { done[id] = t0; });
    this.setState({ done: done, now: t0 });
    this.kick();
  }
  sendMessage(m) {
    const t0 = performance.now();
    const key = m.from + '>' + m.to;
    const pulse = Object.assign({}, this.state.pulse); pulse[key] = t0 + 1300;
    this.setState({ sent: this.state.sent.concat([m]).slice(-40), flights: this.state.flights.concat([{ from: m.from, to: m.to, ask: !!m.ask, t0: t0 }]), pulse: pulse, now: t0 });
    this.kick();
  }
  kick() {
    if (this._raf) cancelAnimationFrame(this._raf);
    const step = () => {
      const now = performance.now();
      const fl = this.state.flights.filter((f) => now - f.t0 < 1300);
      const busy = fl.length || Object.keys(this.state.pulse).some((k) => now - this.state.pulse[k] < 2600) || Object.keys(this.state.done).some((k) => now - this.state.done[k] < 750);
      this.setState({ now: now, flights: fl });
      this._raf = busy ? requestAnimationFrame(step) : null;
    };
    this._raf = requestAnimationFrame(step);
  }

  data() {
    const roles = [
      { id: 'ops', name: 'Ops', mode: 'request', state: 'working', initiative: 'Reliability', updated: '12:41',
        stateNote: '1 task chat working · main chat idle',
        summary: 'Installing the answer-visibility fix (#98) in a task chat; main chat idle.',
        task: { id: '#98', title: 'Install the answer-visibility fix' },
        progress: { text: 'Dry-run install passed on a staging copy', at: '12:41' },
        next: 'Install on the live server, then ask you to confirm answers appear in your chat',
        evidence: [ { label: 'Built', s: 'done', at: '12:02' }, { label: 'Checked', s: 'done', at: '12:20 · QA' }, { label: 'Installed', s: 'active', at: 'in progress' }, { label: 'Live', s: 'pending' }, { label: 'Confirmed by you', s: 'pending' } ],
        queue: { running: 1, ready: 3, waiting: 1, paused: 0, done: 9 },
        tasks: [ { id: '#98', title: 'Install the answer-visibility fix', s: 'running' }, { id: '#112', title: 'Roll out health check (handed over by COO)', s: 'ready' }, { id: '#99', title: 'Rotate service logs', s: 'ready' }, { id: '#101', title: 'Clean up old deploy folders', s: 'ready' }, { id: '#102', title: 'Confirm answer visibility with you', s: 'waiting', dep: '#98 is live' }, { id: '#95', title: 'Restart stuck scheduler', s: 'done' } ],
        purpose: 'Installs, runs and monitors the live system.', resp: ['Installs fixes other roles have built and checked', 'Runs health checks and keeps logs'],
        report: { at: '06:00', text: 'Health checks passed on all services. Answer-visibility fix waiting for QA check.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: '$41.20' },
        activity: [ { at: '12:41', k: 'work', text: '#98 dry-run install passed on a staging copy' }, { at: '12:20', k: 'work', text: '#98 independently checked by QA' }, { at: '12:02', k: 'work', text: '#98 fix built' }, { at: 'Sat 09:14', k: 'config', text: 'Home chat description edited by you' } ] },

      { id: 'temper', name: 'Temper', mode: 'request', state: 'working', initiative: 'Team setup', updated: '12:30',
        stateNote: '1 task working · 1 task paused by you (#68). The role itself isn’t paused.',
        summary: 'Moving old rules into the new instruction format (#69); #68 paused by you.',
        task: { id: '#69', title: 'Move old rules into the new instruction format' },
        progress: { text: 'Old rule set copied into a draft; mapping each rule now', at: '12:30' },
        next: 'Show you a before/after diff before anything is activated',
        evidence: [ { label: 'Drafted', s: 'active', at: 'in progress' }, { label: 'Checked', s: 'pending' }, { label: 'Activated', s: 'pending' }, { label: 'Confirmed by you', s: 'pending' } ],
        queue: { running: 1, ready: 2, waiting: 0, paused: 1, done: 4 },
        tasks: [ { id: '#69', title: 'Move old rules into the new instruction format', s: 'running' }, { id: '#70', title: 'Retire duplicate rules', s: 'ready', dep: '#69' }, { id: '#71', title: 'Write change notes for the new rules', s: 'ready' }, { id: '#68', title: 'Rewrite escalation rules', s: 'paused' }, { id: '#66', title: 'Save your accepted instructions', s: 'done' } ],
        purpose: 'Maintains the rules and instructions that govern every role.', resp: ['Keeps instruction sets consistent', 'Migrates rules without dropping old ones'],
        report: { at: '06:00', text: 'Accepted instructions saved with old rules preserved. Migration task #69 planned.' }, model: 'Not reported',
        instr: { s: 'saved', text: 'Your accepted instructions were saved Sat 21:10. No run has loaded them yet, so they aren’t confirmed active.' }, spend: { own: 'n/a · works on request', req: '$12.10' },
        activity: [ { at: '12:30', k: 'work', text: '#69 old rule set copied into a draft' }, { at: 'Sat 21:10', k: 'config', text: 'Your accepted instructions saved (not yet confirmed active)' }, { at: 'Sat 20:55', k: 'config', text: '#68 paused by you' } ] },

      { id: 'data', name: 'Data', mode: 'request', state: 'blocked', initiative: 'Notebook import', updated: '12:22',
        stateNote: 'No task running · 1 task waiting on another role',
        summary: '#8 waiting on Design’s acceptance receipt.', tags: [ { t: 'Waiting on Design #41' } ],
        task: { id: '#8', title: 'Import the proposed notebook into the design page' },
        progress: { text: 'Import script ready; dry run on a sample notebook passed', at: '11:58' },
        next: 'Run the import once Design’s acceptance receipt exists',
        blocker: { waitingFor: 'Design’s acceptance receipt for the notebook format (from the current session)', resolver: 'Design. It’s working on #41 now (requested by Data); your pause on Design’s own work doesn’t stop requests.', check: 'Re-checks when Design #41 records acceptance. No start time promised.' },
        queue: { running: 0, ready: 0, waiting: 1, paused: 0, done: 6 },
        tasks: [ { id: '#8', title: 'Import the proposed notebook into the design page', s: 'waiting', dep: 'Design #41 acceptance receipt' }, { id: '#7', title: 'Write the notebook import script', s: 'done' } ],
        purpose: 'Owns data pipelines, imports and usage figures.', resp: ['Notebook and data imports', 'Spend and usage figures for other roles'],
        report: { at: '06:00', text: '#8 still waiting on Design acceptance. No other work queued.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: '$64.80' },
        activity: [ { at: '12:22', k: 'work', text: 'Replied to your question about #8' }, { at: '11:58', k: 'work', text: '#8 import dry run passed' } ] },

      { id: 'coo', name: 'COO', mode: 'request', state: 'queued', initiative: 'Reliability', updated: '12:46',
        stateNote: 'Main chat active · task #112 handed to Ops, not started',
        summary: '#112 waiting for an Ops slot.', tags: [ { t: 'Waiting on Ops' } ],
        task: { id: '#112', title: 'Roll out the health check you approved' },
        progress: { text: 'You approved the health check at 12:46; handed the fix to Ops', at: '12:46' },
        next: 'Confirm the check runs on the live server after Ops installs it',
        blocker: { waitingFor: 'A free Ops task slot. Ops is busy with #98.', resolver: 'Ops, automatically. #112 is first in Ops’ ready list.', check: 'Starts when Ops finishes #98 or frees a slot. No start time promised.' },
        queue: { running: 0, ready: 1, waiting: 1, paused: 0, done: 14 },
        tasks: [ { id: '#112', title: 'Roll out the health check you approved', s: 'waiting', dep: 'Ops slot (after #98)' }, { id: '#113', title: 'Answer your spend question', s: 'done' }, { id: '#114', title: 'Weekly cross-role dependency review', s: 'ready' } ],
        purpose: 'Coordinates work across roles and routes your approvals.', resp: ['Hands approved work to the right role', 'Tracks cross-role dependencies'],
        report: { at: '06:00', text: '3 dependencies open across roles; health check awaiting your approval.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: '$58.30' },
        activity: [ { at: '12:46', k: 'work', text: 'Handed the approved health check to Ops (#112)' }, { at: '11:40', k: 'work', text: 'Answered your spend question in task chat #113' } ] },

      { id: 'architecture', name: 'Architecture', mode: 'request', state: 'onhold', initiative: 'Reliability', updated: 'Sat 17:20',
        stateNote: 'Task on hold',
        summary: '#62 on hold waiting for Frontend’s repair plans.', tags: [ { t: 'Waiting on Frontend' } ],
        task: { id: '#62', title: 'Review the repair plans' },
        progress: { text: 'Review checklist prepared', at: 'Sat 17:20' },
        nextMissing: true, nextNote: 'Request R-14 is unfinished and no next task is recorded',
        blocker: { waitingFor: 'Repair plans from Frontend', resolver: 'Frontend. It’s writing them now (#1, requested by Architecture).', check: 'No re-check recorded' },
        queue: { running: 0, ready: 0, waiting: 1, paused: 0, done: 3 },
        tasks: [ { id: '#62', title: 'Review the repair plans', s: 'waiting', dep: 'Frontend repair plans' }, { id: '#61', title: 'Prepare review checklist', s: 'done' } ],
        purpose: 'Keeps the system’s structure coherent and reviews cross-cutting changes.', resp: ['Reviews repair and migration plans', 'Records design decisions'],
        report: { at: '06:00', text: 'On hold for Frontend repair plans.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: 'Not reported' },
        activity: [ { at: 'Sat 17:20', k: 'work', text: '#62 review checklist prepared; put on hold' } ] },

      { id: 'rollcall', name: 'RollCall', mode: 'request', state: 'error', initiative: 'Team setup', updated: '06:00',
        stateNote: 'Last scheduled run failed',
        summary: 'Morning roll-call failed at 06:00.',
        task: { id: 'Run 06:00', title: 'Morning roll-call' },
        progress: { text: 'Stopped at 06:00:14 with an error (exit 137). 9 of 15 reports collected.', at: '06:00' },
        next: 'Next scheduled run Mon 06:00. No retry recorded for today.',
        blocker: { waitingFor: 'Nothing. The run ended in an error.', resolver: 'Not recorded. No owner is assigned for RollCall failures.', check: 'Next scheduled run Mon 06:00' },
        queue: { running: 0, ready: 0, waiting: 0, paused: 0, done: 27 },
        tasks: [ { id: 'Run 06:00', title: 'Morning roll-call (failed)', s: 'done' } ],
        purpose: 'Collects each role’s status every morning.', resp: ['06:00 roll-call', 'Morning report digest'],
        report: null, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: 'Not reported' },
        activity: [ { at: '06:00', k: 'work', text: 'Run failed with exit 137 after 9 of 15 reports' } ] },

      { id: 'systems', name: 'Systems', mode: 'request', state: 'unknown', initiative: 'Team setup', updated: 'Sat 23:40',
        stateNote: 'No status received for 13 h',
        summary: 'No status for 13 h.',
        task: null,
        progress: { text: 'Last known: waiting for requests', at: 'Sat 23:40' },
        blocker: { waitingFor: 'A status update. None received since Sat 23:40.', resolver: 'Not recorded', check: 'Stays Unknown, not Idle, until a status arrives' },
        queue: null, tasks: [],
        purpose: 'Maintains the machines and runtimes the roles run on.', resp: ['Host maintenance', 'Runtime upgrades'],
        report: null, model: 'Not reported',
        instr: { s: 'unknown', text: 'Not reported.' }, spend: { own: 'n/a · works on request', req: 'Not reported' },
        activity: [] },

      { id: 'design', name: 'Design', mode: 'own', state: 'working', initiative: 'Notebook import', updated: '12:38',
        stateNote: 'Working on a request from Data · own initiatives paused by you', tags: [ { t: 'Own work paused' }, { t: 'Unblocks Data #8' } ],
        summary: 'Working on Data’s request (#41). Own initiatives paused by you Fri 16:02 (token limit).',
        task: { id: '#41', title: 'Accept the notebook import format' },
        progress: { text: 'Checking the format against Data’s import script', at: '12:38' },
        next: 'Issue the acceptance receipt so Data can run #8',
        queue: { running: 1, ready: 0, waiting: 0, paused: 33, done: 22 },
        tasks: [ { id: '#41', title: 'Accept the notebook import format', s: 'running' }, { id: '#43', title: 'Design page empty states', s: 'paused' }, { id: '#44', title: 'Notebook card layout', s: 'paused', dep: '#41' }, { id: '#45…', title: '31 more own-initiative tasks (held while paused)', s: 'paused' }, { id: '#40', title: 'Review proposed notebook', s: 'done' } ],
        purpose: 'Shapes product UI and starts its own design work within budget.', resp: ['Design page and notebook formats', 'Accepts formats other departments depend on'],
        report: { at: '06:00', text: 'Own initiatives paused; one request from Data queued (#41).' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: '$1,240.50 of $2,000.00', req: '$97.40' },
        budgetNote: '$759.50 own-work budget left this week (Mon–Sun, Pacific). Leftover budget doesn’t override your pause on own initiatives.',
        activity: [ { at: '12:38', k: 'work', text: 'Started #41, requested by Data' }, { at: 'Fri 15:40', k: 'work', text: '#40 proposed notebook reviewed' }, { at: 'Fri 16:02', k: 'config', text: 'Own initiatives paused by you (token limit)' } ] },

      { id: 'product', name: 'Product', mode: 'own', state: 'idle', initiative: 'Budget & tokens', updated: 'Fri 16:02',
        stateNote: 'Idle · own initiatives paused by you', tags: [ { t: 'Own work paused' } ],
        summary: 'Nothing running. Own initiatives paused by you Fri 16:02 (token limit); no requests from other departments.',
        task: { id: '#51', title: 'Reorder the backlog for Q4' }, progress: { text: 'Draft order saved before the pause', at: 'Fri 14:10' }, next: 'Share the draft order with you when own work resumes',
        queue: { running: 0, ready: 0, waiting: 0, paused: 6, done: 11 },
        tasks: [ { id: '#51', title: 'Reorder the backlog for Q4', s: 'paused' }, { id: '#52…', title: '5 more own-initiative tasks (held while paused)', s: 'paused' } ],
        purpose: 'Prioritises product work and writes requirements.', resp: ['Requirements', 'Backlog order'],
        report: { at: '06:00', text: 'Own initiatives paused. No requests received.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'Not reported', req: 'Not reported' },
        activity: [ { at: 'Fri 16:02', k: 'config', text: 'Own initiatives paused by you (token limit)' } ] },

      { id: 'backend', name: 'Backend', mode: 'request', state: 'idle', initiative: 'Budget & tokens', updated: 'Fri 16:02',
        stateNote: 'Idle · own initiatives paused by you', tags: [ { t: 'Own work paused' } ],
        summary: 'Nothing running. Own initiatives paused by you Fri 16:02 (token limit); no requests from other departments.',
        task: { id: '#1', title: 'Token usage cleanup' }, progress: { text: 'Usage report drafted before the pause', at: 'Fri 15:55' },
        queue: { running: 0, ready: 0, waiting: 0, paused: 1, done: 8 },
        tasks: [ { id: '#1', title: 'Token usage cleanup', s: 'paused' } ],
        purpose: 'Builds and maintains server-side services.', resp: ['API and data services', 'Server fixes requested by other departments'],
        report: { at: '06:00', text: 'Own initiatives paused. No requests received.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'Not reported', req: '$18.90' },
        activity: [ { at: 'Fri 16:02', k: 'config', text: 'Own initiatives paused by you (token limit)' } ] },

      { id: 'frontend', name: 'Frontend', mode: 'request', state: 'working', initiative: 'Reliability', updated: '13:05',
        stateNote: 'Working on a request from Architecture · own initiatives paused by you', tags: [ { t: 'Own work paused' }, { t: 'Unblocks Architecture #62' } ],
        summary: 'Writing repair plans for Architecture (#1). Own initiatives paused by you Sat 11:30.',
        task: { id: '#1', title: 'Write repair plans' }, progress: { text: 'First of 2 repair plans drafted', at: '13:05' }, next: 'Send both repair plans to Architecture',
        queue: { running: 1, ready: 0, waiting: 0, paused: 2, done: 5 },
        tasks: [ { id: '#1', title: 'Write repair plans', s: 'running' }, { id: '#3', title: 'UI repair backlog cleanup', s: 'paused' }, { id: '#4', title: 'Settings page polish', s: 'paused' } ],
        purpose: 'Builds the web UI.', resp: ['UI fixes', 'Repair plans for UI issues'],
        report: { at: '06:00', text: 'Own initiatives paused. Working Architecture’s repair-plan request. Proposal for extra working sessions awaiting your approval.' }, model: 'Not reported',
        instr: { s: 'saved', text: 'Your Frontend description was saved Sat 18:00. Not confirmed active: no run since.' }, spend: { own: 'Not reported', req: '$22.00' },
        activity: [ { at: '13:05', k: 'work', text: '#1 first repair plan drafted' }, { at: 'Sat 18:40', k: 'work', text: 'Proposed 2 extra working sessions per day' }, { at: 'Sat 18:00', k: 'config', text: 'Role description saved' }, { at: 'Sat 11:30', k: 'config', text: 'Own initiatives paused by you' } ] },

      { id: 'marketing', name: 'Marketing', mode: 'request', state: 'idle', initiative: 'None chosen', updated: 'Thu 09:00',
        stateNote: 'Idle · no own initiative chosen', tags: [ { t: 'Asked you 4 d ago' } ],
        summary: 'Nothing running. No own initiative yet: waiting for you to pick one. No requests from other departments.',
        task: null, progress: { text: 'No work since Thu', at: 'Thu 09:00' },
        queue: { running: 0, ready: 0, waiting: 0, paused: 0, done: 2 }, tasks: [],
        purpose: 'Plans and drafts outward-facing material for a chosen initiative.', resp: ['Launch notes', 'Announcements'],
        report: { at: '06:00', text: 'No initiative chosen. No requests received.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Thu 06:00.' }, spend: { own: 'Not reported', req: 'Not reported' },
        activity: [ { at: 'Thu 09:00', k: 'config', text: 'Asked you to pick an initiative' } ] },

      { id: 'qa', name: 'QA', mode: 'own', state: 'idle', initiative: 'Reliability', updated: 'Wed 20:15', tags: [ { t: 'Awaiting your confirmation' } ],
        stateNote: 'Idle', summary: 'Last task done Wed 20:15: report fix built, independently checked and live.',
        task: null, progress: { text: 'Report fix live and checked', at: 'Wed 20:15' }, next: 'Close the request after you confirm it works',
        queue: { running: 0, ready: 0, waiting: 0, paused: 0, done: 17 },
        tasks: [ { id: '#77', title: 'Independent check of Ops #98', s: 'done' }, { id: '#74', title: 'Verify report fix', s: 'done' } ],
        purpose: 'Independently checks work before it’s called done.', resp: ['Verification runs', 'Regression checks'],
        report: { at: '06:00', text: 'Idle. One request waiting on your confirmation.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: '$0.00 (reported)', req: '$3.40' },
        activity: [ { at: '12:20', k: 'work', text: 'Checked Ops #98' }, { at: 'Wed 20:15', k: 'work', text: 'Report fix verified live' } ] },

      { id: 'docs', name: 'Docs', mode: 'request', state: 'idle', initiative: 'Team setup', updated: '06:03',
        stateNote: 'Idle', summary: 'No active work. Takes requests only.', task: null, progress: { text: 'No active work', at: '06:03' },
        queue: { running: 0, ready: 0, waiting: 0, paused: 0, done: 4 }, tasks: [],
        purpose: 'Writes and maintains documentation on request.', resp: ['User docs', 'Change notes'],
        report: { at: '06:03', text: 'No active work.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: '$0.00 (reported)' }, activity: [] },

      { id: 'security', name: 'Security', mode: 'request', state: 'idle', initiative: 'Team setup', updated: '06:04',
        stateNote: 'Idle', summary: 'Idle. Only requested Team work continues; nothing requested now.', task: null, progress: { text: 'Team audit answered', at: 'Sat 10:12' },
        queue: { running: 0, ready: 0, waiting: 0, paused: 0, done: 6 }, tasks: [ { id: '#12', title: 'Team access audit', s: 'done' } ],
        purpose: 'Reviews access, secrets and risky changes.', resp: ['Access reviews', 'Requested Team audits'],
        report: { at: '06:04', text: 'Idle. No open findings.' }, model: 'Not reported',
        instr: { s: 'active', text: 'Loaded by the run that started Sun 06:00.' }, spend: { own: 'n/a · works on request', req: 'Not reported' },
        activity: [ { at: 'Sat 10:12', k: 'work', text: 'Answered your Team audit question' } ] }
    ];

    const inbox = [
      { id: 'i2', kind: 'Approval', role: 'Frontend', age: '18 h',
        title: 'Add 2 extra working sessions per day?',
        context: 'Proposed in Frontend’s home chat Sat 18:40. Cost estimate: not reported. Frontend’s own initiatives stay paused either way; approving doesn’t resume them.',
        choices: [ { label: 'Approve', primary: true }, { label: 'Decline' } ], link: 'Open Frontend chat' },
      { id: 'i3', kind: 'Confirmation', role: 'QA', age: '3 d 16 h',
        title: 'Does the report fix work for you?',
        context: 'QA marked it done Wed 20:15. Only your confirmation is missing.',
        evidence: [ { label: 'Built', s: 'done', at: 'Wed 17:02' }, { label: 'Checked', s: 'done', at: 'Wed 19:40 · independent' }, { label: 'Installed', s: 'done', at: 'Wed 20:05' }, { label: 'Live', s: 'done', at: 'Wed 20:15' }, { label: 'Confirmed by you', s: 'active', at: 'waiting on you' } ],
        choices: [ { label: 'Yes, it works', primary: true }, { label: 'Something’s wrong' } ], link: 'Open QA report' },
      { id: 'i4', kind: 'Question', role: 'Marketing', age: '4 d',
        title: 'Which initiative should Marketing work on?',
        context: 'Marketing has no own initiative until you choose one. It still handles requests from other departments in the meantime.',
        choices: [ { label: 'Reliability' }, { label: 'Team setup' }, { label: 'Not now' } ], link: 'Open Marketing chat' }
    ];

    const questions = [
      { id: 'q1', to: 'Data', text: 'Why is task #8 blocked?',
        asked: { s: 'done', at: '12:10' }, contacted: { s: 'done', at: '12:10' }, replied: { s: 'done', at: '12:22' }, available: { s: 'done', at: '12:22' },
        status: 'Answer is in your chat. Not opened yet.', statusKind: 'ok',
        answer: '#8 needs Design’s acceptance receipt for the notebook format from the current session. Design is working on that now (#41, which I requested). Nothing else is missing; I’ll run the import as soon as the receipt exists.' },
      { id: 'q2', to: 'COO', text: 'What has Design spent on its own work this week?',
        asked: { s: 'done', at: '11:05' }, contacted: { s: 'done', at: '11:05' }, replied: { s: 'done', at: '11:40' }, available: { s: 'problem', note: 'not delivered' },
        status: 'COO replied in task chat #113, but the reply never reached your chat.', statusKind: 'warn', elsewhere: 'Read answer from COO task chat',
        answer: 'Design own-initiative spend this week: $1,240.50 of $2,000 (Mon Oct 5 – Sun Oct 11, Pacific). Requested work is exempt and not counted.' },
      { id: 'q3', to: 'Ops', text: 'Is the answer-visibility fix live yet?',
        asked: { s: 'done', at: '12:31' }, contacted: { s: 'done', at: '12:32' }, replied: { s: 'active', note: 'not yet' }, available: { s: 'pending' },
        status: 'No reply yet. Ops is working on #98. No reply time promised.', statusKind: 'wait' }
    ];

    const readQs = [ { to: 'Security', text: 'Did the Team audit find anything urgent?', at: 'Sat 10:20' }, { to: 'QA', text: 'Was the report fix checked by someone other than its builder?', at: 'Wed 20:30' } ];

    const activity = [
      { at: '12:46', role: 'COO', k: 'work', text: 'Handed the approved health check to Ops (#112). Not started.' },
      { at: '12:41', role: 'Ops', k: 'work', text: '#98 dry-run install passed on a staging copy' },
      { at: '12:30', role: 'Temper', k: 'work', text: '#69 old rule set copied into a draft' },
      { at: '12:22', role: 'Data', k: 'work', text: 'Replied to your question about #8' },
      { at: '12:20', role: 'QA', k: 'work', text: 'Independent check of Ops #98 passed' },
      { at: '11:58', role: 'Data', k: 'work', text: '#8 import dry run passed' },
      { at: '11:40', role: 'COO', k: 'work', text: 'Answered your spend question in task chat #113' },
      { at: '06:00', role: 'RollCall', k: 'work', text: 'Morning run failed after 9 of 15 reports' },
      { at: 'Sat 21:10', role: 'Temper', k: 'config', text: 'Your accepted instructions saved. Not yet loaded by any run.' },
      { at: 'Sat 20:55', role: 'You', k: 'config', text: 'Paused Temper task #68' },
      { at: 'Sat 18:00', role: 'Frontend', k: 'config', text: 'Role description saved. No run since, so not confirmed active.' },
      { at: 'Sat 11:30', role: 'You', k: 'config', text: 'Paused Frontend’s own initiatives' },
      { at: 'Fri 16:02', role: 'You', k: 'config', text: 'Paused own initiatives for Design, Product and Backend (token limit). Requests still run.' }
    ];
    return { roles, inbox, questions, readQs, activity };
  }

  renderVals() {
    const self = this;
    const st = this.state;
    const sc = st.scenario || this.props.scenario || 'live';
    const D = this.data();
    const loading = sc === 'loading';
    const ready = !loading;
    const offline = sc === 'disconnected';
    const lastKnown = sc === 'stale' || offline;
    const dim = lastKnown ? '0.8' : '1';

    const FRESH = {
      live: { text: 'Live · confirmed 12:46:10', fg: '#9FD8B8', bd: '#2F4A3C' },
      empty: { text: 'Live · confirmed 12:46:10', fg: '#9FD8B8', bd: '#2F4A3C' },
      stale: { text: 'Stale · last confirmed 12:31 (15 min ago)', fg: '#F0B95A', bd: '#4D3F1F' },
      disconnected: { text: 'Disconnected · last confirmed 12:46', fg: '#FF8A80', bd: '#5A2A2C' },
      loading: { text: 'Loading…', fg: '#B9BEC5', bd: '#3A3F46' }
    };
    const BANNER = {
      stale: { show: true, bg: '#1D1A12', bd: '#4D3F1F', fg: '#F0B95A', title: 'Status may be out of date', body: 'No update since 12:31. Every role shows its last known state. None has been marked Idle or Finished because of the gap.', hasAction: true, action: 'Refresh now' },
      disconnected: { show: true, bg: '#221415', bd: '#5A2A2C', fg: '#FF8A80', title: 'Disconnected from the Roles service', body: 'Connection lost at 12:46. Everything below is the last known state, and decisions are off until it reconnects. Retrying every 30 s.', hasAction: true, action: 'Retry now' },
      loading: { show: true, bg: '#16181B', bd: '#2A2E34', fg: '#ECEDEE', title: 'Loading role status', body: 'Nothing is shown as Idle, Finished or All clear until each role’s status is confirmed.', hasAction: false, action: '' }
    };
    const banner = BANNER[sc] || { show: false, bg: '', bd: '', fg: '', title: '', body: '', hasAction: false, action: '' };

    const scenarios = [['live', 'Live'], ['stale', 'Stale data'], ['disconnected', 'Disconnected'], ['loading', 'Loading'], ['empty', 'Inbox empty']].map(([k, label]) => {
      const on = sc === k;
      return { label, pressed: String(on), bg: on ? '#C7B8FF' : 'transparent', fg: on ? '#16121F' : '#D6D9DD', bd: on ? '#C7B8FF' : '#3A3F46', pick: () => self.setState({ scenario: k }) };
    });

    const EV = {
      done: { fg: '#9FD8B8', bg: 'rgba(159,216,184,0.08)', bd: '#2F4A3C', bs: 'solid' },
      active: { fg: '#7DB8FF', bg: 'rgba(125,184,255,0.08)', bd: '#2B4466', bs: 'solid' },
      pending: { fg: '#A9AEB6', bg: 'transparent', bd: '#3A3F46', bs: 'dashed' }
    };
    const decEv = (e) => Object.assign({ label: e.label, at: e.at || (e.s === 'pending' ? 'not yet' : ''), isDone: e.s === 'done', isActive: e.s === 'active', isPending: e.s === 'pending' }, EV[e.s]);

    const BOX = {
      waiting: { bg: '#1B1912', bd: '#4D3F1F', fg: '#F0B95A', title: 'Why it’s waiting' },
      blocked: { bg: '#1B1912', bd: '#4D3F1F', fg: '#F0B95A', title: 'What it’s blocked on' },
      queued: { bg: '#15181D', bd: '#34404F', fg: '#AFC4E2', title: 'Why it hasn’t started (no action needed)' },
      onhold: { bg: '#121A19', bd: '#2E4744', fg: '#8FC7C0', title: 'Why it’s on hold' },
      error: { bg: '#201415', bd: '#5A2A2C', fg: '#FF8A80', title: 'What failed' },
      unknown: { bg: '#191724', bd: '#43396A', fg: '#C7B8FF', title: 'Why the status is unknown' }
    };
    const qText = (q) => {
      if (!q) return 'not reported';
      const parts = [['running', q.running], ['ready', q.ready], ['waiting', q.waiting], ['paused', q.paused], ['done', q.done]].filter((p) => p[1] > 0).map((p) => p[1] + ' ' + p[0]);
      return parts.length ? parts.join(' · ') : 'empty';
    };
    const INSTR = { active: ['Active', '#9FD8B8'], saved: ['Saved · not confirmed active', '#F0B95A'], draft: ['Draft', '#B9BEC5'], unknown: ['Not reported', '#C7B8FF'] };
    const TG = [['running', 'Running', '#7DB8FF'], ['ready', 'Ready to start', '#D6D9DD'], ['waiting', 'Waiting on something', '#F0B95A'], ['paused', 'Paused by you', '#B9BEC5'], ['done', 'Completed (latest)', '#9FD8B8']];

    const SRC = { 'ops#98': 'You', 'ops#112': 'COO', 'ops#102': 'You', 'ops#95': 'Backend', 'temper#71': 'Docs', 'temper#66': 'You', 'coo#112': 'You', 'coo#113': 'You', 'design#41': 'Data', 'design#40': 'Product', 'frontend#1': 'Architecture', 'qa#77': 'Ops', 'qa#74': 'You', 'security#12': 'You' };
    const INITS = { ops: [['Service upkeep', 'active']], temper: [['Rules migration', 'active']], data: [['Notebook import', 'waiting']], coo: [['Cross-department coordination', 'waiting']], architecture: [['Repair program', 'waiting']], rollcall: [['Morning reports', 'error']], systems: [['Host upkeep', 'unknown']], design: [['Notebook formats', 'paused'], ['Design page refresh', 'paused']], product: [['Q4 backlog', 'paused']], backend: [['Token efficiency', 'paused']], frontend: [['UI repairs', 'paused']], marketing: [], qa: [['Regression suite', 'idle']], docs: [['User docs', 'idle']], security: [['Access hygiene', 'idle']] };
    const IL = { active: 'active', waiting: 'waiting', paused: 'paused by you', idle: 'idle', error: 'last run failed', unknown: 'status unknown' };
    const STL = { working: 'working', waiting: 'waiting', blocked: 'blocked', queued: 'queued', onhold: 'on hold', paused: 'paused by you', idle: 'idle', error: 'error', unknown: 'unknown' };
    const srcOf = (r, t) => SRC[r.id + t.id] || 'own';
    const ownPausedOf = (r) => (INITS[r.id] || []).some((i) => i[1] === 'paused');
    const srcText = (s) => s === 'own' ? 'own initiative' : (s === 'You' ? 'requested by you' : 'requested by ' + s);
    const openOf = (r) => (r.tasks || []).filter((t) => t.s !== 'done').map((t) => Object.assign({}, t, { src: srcOf(r, t) }));
    const workOf = (r) => { const op = openOf(r); return { own: op.filter((t) => t.src === 'own'), dept: op.filter((t) => t.src !== 'own' && t.src !== 'You'), you: op.filter((t) => t.src === 'You') }; };
    const outbound = {};
    D.roles.forEach((o) => openOf(o).forEach((t) => {
      const asker = D.roles.find((x) => x.name === t.src);
      if (asker) (outbound[asker.id] = outbound[asker.id] || []).push(o.name + ' ' + t.id + ' (' + o.name + ' ' + STL[o.state] + ')');
    }));
    const reqText = (w) => {
      const g = {}; const order = [];
      w.you.concat(w.dept).forEach((t) => { const k = t.src === 'You' ? 'you' : t.src; if (!g[k]) { g[k] = []; order.push(k); } g[k].push(t.id); });
      return order.length ? order.map((k) => 'From ' + k + ': ' + g[k].join(', ')).join(' · ') : 'None open';
    };
    const initText = (r) => {
      const list = INITS[r.id] || [];
      if (!list.length) return 'None chosen. Waiting for you to pick one.';
      const n = workOf(r).own.length;
      return list.map((i) => i[0] + ' (' + IL[i[1]] + ')').join(', ') + (n ? ' · ' + n + ' open task' + (n === 1 ? '' : 's') : '');
    };
    const mixText = (r) => { const w = workOf(r); const req = w.dept.length + w.you.length; return (w.own.length || req) ? 'Own ' + w.own.length + ' · Requested ' + req + ' (you ' + w.you.length + ', depts ' + w.dept.length + ')' : 'No open tasks'; };

    const decorate = (r) => {
      const b = BOX[r.state] || BOX.waiting;
      const ins = INSTR[(r.instr && r.instr.s) || 'unknown'];
      const tasks = r.tasks || [];
      return Object.assign({}, r, {
        open: () => self.setState({ drawer: r.id, drawerTab: 'work' }),
        modeLabel: r.mode === 'own' ? 'Starts own work' : 'Starts work when asked',
        taskSrc: r.task ? '· ' + srcText(srcOf(r, r.task)) : '',
        ownPaused: ownPausedOf(r),
        initText: initText(r), reqInText: reqText(workOf(r)), outText: (outbound[r.id] || []).join(' · ') || 'Nothing pending',
        mix: mixText(r),
        taskId: r.task ? r.task.id : '', taskTitle: r.task ? r.task.title : 'No current task',
        progressText: r.progress ? r.progress.text : 'Not reported', progressAt: r.progress ? r.progress.at : '—',
        hasNext: !!r.next, noNext: !r.next && !!r.nextMissing, nextNone: !r.next && !r.nextMissing, nextNote: r.nextNote || '',
        hasBlocker: !!r.blocker, blocker: r.blocker || { waitingFor: '', resolver: '', check: '' },
        boxBg: b.bg, boxBd: b.bd, boxFg: b.fg, boxTitle: b.title,
        hasEvidence: !!(r.evidence && r.evidence.length), ev: (r.evidence || []).map(decEv),
        queueText: qText(r.queue), hasTags: !!(r.tags && r.tags.length), tags: r.tags || [],
        chatHref: '#chat-' + r.id, queueHref: '#queue-' + r.id,
        instrLabel: ins[0], instrFg: ins[1], instr: r.instr || { text: 'Not reported.' },
        reportAt: r.report ? r.report.at : '—', reportText: r.report ? r.report.text : 'No morning report received today.',
        respList: (r.resp || []).map((t) => ({ t })),
        hasBudgetNote: !!r.budgetNote, budgetNote: r.budgetNote || '',
        taskGroups: TG.map(([k, label, fg]) => ({ label, fg, items: tasks.filter((t) => t.s === k).map((t) => ({ id: t.id, title: t.title, hasDep: !!t.dep, dep: t.dep || '', srcText: srcText(srcOf(r, t)) })) })).filter((g) => g.items.length),
        acts: (r.activity || []).filter((a) => a.k === st.drawerTab),
        actsEmpty: !(r.activity || []).filter((a) => a.k === st.drawerTab).length
      });
    };

    const q = (st.q || '').toLowerCase().trim();
    const dept = st.dept || 'all';
    const work = st.work || 'all';
    const workOpts = [['all', 'All work'], ['own', 'Own initiatives'], ['dept', 'Requested by other departments'], ['you', 'Requested by you']].map(([k, label]) => {
      const on = work === k;
      const n = k === 'all' ? D.roles.length : D.roles.filter((r) => workOf(r)[k].length).length;
      return { label, count: loading ? '–' : String(n), pressed: String(on), bg: on ? '#ECEDEE' : '#16181B', fg: on ? '#0E0F11' : '#D6D9DD', bd: on ? '#ECEDEE' : '#2F343A', pick: () => self.setState({ work: k }) };
    });
    const match = (r) => (!q || r.name.toLowerCase().includes(q) || (r.task && (r.task.title.toLowerCase().includes(q) || r.task.id.toLowerCase().includes(q))))
      && (dept === 'all' || r.id === dept)
      && (work === 'all' || workOf(r)[work].length > 0)
      && (st.stateFilter === 'all' || (st.stateFilter === 'ownpaused' ? ownPausedOf(r) : r.state === st.stateFilter));
    const vis = ready ? D.roles.filter(match).map(decorate) : [];
    const pick = (states) => vis.filter((r) => states.indexOf(r.state) >= 0);
    const cardGroups = [
      { title: 'Working now', desc: 'A task is actually running right now.', roles: pick(['working']) },
      { title: 'Not moving', desc: 'Blocked on someone, queued, on hold, failed, or status not confirmed.', roles: pick(['blocked', 'queued', 'onhold', 'error', 'unknown']) }
    ].filter((g) => g.roles.length).map((g) => Object.assign(g, { count: String(g.roles.length) }));
    const rowGroups = [
      { title: 'Own work paused by you', desc: 'Their own initiatives are paused to save tokens. Requests from other departments still run, so some also appear above.', roles: vis.filter((r) => r.ownPaused) },
      { title: 'Idle', desc: 'Confirmed with nothing running.', roles: pick(['idle']) }
    ].filter((g) => g.roles.length).map((g) => Object.assign(g, { count: String(g.roles.length) }));

    const counts = {};
    D.roles.forEach((r) => { counts[r.state] = (counts[r.state] || 0) + 1; });
    const filters = [['all', 'All roles'], ['working', 'Working now'], ['blocked', 'Blocked'], ['queued', 'Queued'], ['onhold', 'On hold'], ['error', 'Error'], ['unknown', 'Unknown'], ['idle', 'Idle'], ['ownpaused', 'Own work paused by you']].map(([k, label]) => {
      const on = st.stateFilter === k;
      const n = k === 'all' ? D.roles.length : (k === 'ownpaused' ? D.roles.filter(ownPausedOf).length : (counts[k] || 0));
      return { label, count: loading ? '–' : String(n), pressed: String(on), bg: on ? '#ECEDEE' : '#16181B', fg: on ? '#0E0F11' : '#D6D9DD', bd: on ? '#ECEDEE' : '#2F343A', pick: () => self.setState({ stateFilter: k }) };
    });
    const isFiltered = ready && (!!q || dept !== 'all' || work !== 'all' || st.stateFilter !== 'all');

    const KIND = { Decision: ['#F0B95A', 'rgba(240,185,90,0.12)'], Approval: ['#7DB8FF', 'rgba(125,184,255,0.12)'], Confirmation: ['#9FD8B8', 'rgba(159,216,184,0.12)'], Question: ['#C7B8FF', 'rgba(199,184,255,0.12)'] };
    const inboxSrc = (sc === 'empty' || loading) ? [] : D.inbox;
    const inbox = inboxSrc.map((it) => {
      const res = st.resolved[it.id];
      return Object.assign({}, it, {
        kindFg: KIND[it.kind][0], kindBg: KIND[it.kind][1],
        isResolved: !!res, isOpen: !res, resolvedText: res ? 'Sent “' + res + '” to ' + it.role + ' · just now' : '',
        undo: () => { const n = Object.assign({}, self.state.resolved); delete n[it.id]; self.setState({ resolved: n }); },
        hasBlocks: !!it.blocks, hasEvidence: !!(it.evidence && it.evidence.length), ev: (it.evidence || []).map(decEv),
        choices: it.choices.map((c) => ({ label: c.label, hint: c.hint || '', hasHint: !!c.hint, op: offline ? '0.45' : '1',
          bg: c.primary ? '#ECEDEE' : 'transparent', fg: c.primary ? '#0E0F11' : '#ECEDEE', bd: c.primary ? '#ECEDEE' : '#4A4F57',
          pick: () => { const n = Object.assign({}, self.state.resolved); n[it.id] = c.label; self.setState({ resolved: n }); } }))
      });
    });
    const openCount = inbox.filter((i) => i.isOpen).length;
    const SUB = { live: 'Items blocking other work come first. Work you paused only shows here if it asked you something.', empty: '', stale: 'As of 12:31. These may have changed.', disconnected: 'Last known items. Choices are off while disconnected.', loading: 'Loading…' };

    const STEP = { done: ['#D6D9DD', '#9FD8B8'], active: ['#7DB8FF', '#7DB8FF'], problem: ['#F0B95A', '#F0B95A'], pending: ['#A9AEB6', '#2A2E34'] };
    const SK = { ok: '#9FD8B8', warn: '#F0B95A', wait: '#B9BEC5' };
    const qs = ((sc === 'empty' || loading) ? [] : D.questions).map((x) => {
      const open = st.openAnswer === x.id;
      const steps = [['Asked', x.asked], ['Role contacted', x.contacted], ['Reply received', x.replied], ['In your chat', x.available]].map(([label, s]) => ({
        label, fg: STEP[s.s][0], bar: STEP[s.s][1], isDone: s.s === 'done', isProblem: s.s === 'problem', sub: s.at || s.note || 'not yet' }));
      const canRead = x.available.s === 'done';
      const elsewhere = x.available.s === 'problem';
      return { to: x.to, text: x.text, askedAt: x.asked.at, steps, status: x.status, statusFg: SK[x.statusKind],
        canRead, canReadElsewhere: elsewhere, isOpen: open && (canRead || elsewhere), expanded: String(open),
        readLabel: open ? 'Hide answer' : (elsewhere ? x.elsewhere : 'Read answer'),
        answer: x.answer || '', repliedAt: x.replied.at || '',
        toggle: () => { const ra = Object.assign({}, self.state.readAnswers); ra[x.id] = true; self.setState({ openAnswer: self.state.openAnswer === x.id ? null : x.id, readAnswers: ra }); } };
    });

    const actsAll = D.activity.filter((a) => a.k === st.actTab);
    const acts = st.actMore ? actsAll : actsAll.slice(0, 5);
    const tabBtn = (key, label, cur, setKey) => { const on = cur === key; return { label, pressed: String(on), bg: on ? '#ECEDEE' : 'transparent', fg: on ? '#0E0F11' : '#D6D9DD', bd: on ? '#ECEDEE' : '#3A3F46', pick: () => { const o = {}; o[setKey] = key; self.setState(o); } }; };

    const drId = st.drawer === 'unset' ? (this.props.openRole || null) : st.drawer;
    const drRaw = ready ? D.roles.find((r) => r.id === drId) : null;
    const dr = decorate(drRaw || D.roles[0]);

    const view = 'glance';
    const makeExpand = (id) => (e) => {
      const el = e && e.currentTarget;
      const zero = { top: 0, left: 0, width: 0, height: 0 };
      const rc = el && el.getBoundingClientRect ? el.getBoundingClientRect() : zero;
      const wrap = el && el.closest ? el.closest('[data-boxgrid]') : null;
      const wr = wrap ? wrap.getBoundingClientRect() : rc;
      self.setState({ expanded: id, grown: false, tip: null, wrapH: wr.height, from: { t: rc.top - wr.top, l: rc.left - wr.left, w: rc.width, h: rc.height } });
      const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
      clearTimeout(self._settleT);
      raf(() => raf(() => {
        self.setState({ grown: true, settled: false });
        self._settleT = setTimeout(() => self.setState({ settled: true }), 380);
      }));
    };
    const GL = { ops: ['Installing fix #98', false], temper: ['Migrating rules (#69) · #68 paused', false], data: ['#8 waits on Design #41 (in progress)', false], coo: ['#112 waits for a free Ops lane', false], architecture: ['#62 on hold for Frontend’s plans · no next task', false], rollcall: ['06:00 run failed · next run Mon 06:00', false], systems: ['No status received for 13 h', false], design: ['Working on Data’s request #41', false], product: ['No requests to work on', false], backend: ['No requests to work on', false], frontend: ['Repair plans for Architecture · approval waiting on you', true], marketing: ['Waiting for you to pick an initiative', true], qa: ['Done · needs your confirmation', true], docs: ['No work', false], security: ['No work', false] };
    const EMPTYGL = { frontend: ['Repair plans for Architecture', false], marketing: ['No requests to work on', false], qa: ['Done · confirmed by you', false] };
    const allDec = ready ? D.roles.map((r) => {
      const g = (sc === 'empty' && EMPTYGL[r.id]) || GL[r.id];
      return { name: r.name, state: r.state, glance: g[0], onYou: g[1], mix: mixText(r), bd: g[1] ? '#6B5426' : '#2A2E34', open: () => self.setState({ drawer: r.id, drawerTab: 'work' }) };
    }) : [];
    const COLS = [['working', 'Running a task right now'], ['waiting', 'Can’t continue until something happens'], ['error', 'Last run failed'], ['unknown', 'Status not confirmed'], ['paused', 'You stopped these on purpose'], ['idle', 'Confirmed, nothing running']];
    const cols = ready ? COLS.map(([k, desc]) => { const rs = allDec.filter((r) => r.state === k); return { kind: k, desc, roles: rs, count: String(rs.length), empty: !rs.length }; }) : [];
    const gWorking = allDec.filter((r) => r.state === 'working');
    const gStuck = allDec.filter((r) => ['blocked', 'queued', 'onhold', 'error', 'unknown'].indexOf(r.state) >= 0);
    const nWait = gStuck.filter((r) => ['blocked', 'queued', 'onhold'].indexOf(r.state) >= 0).length;
    const nErr = gStuck.filter((r) => r.state === 'error').length;
    const nUnk = gStuck.filter((r) => r.state === 'unknown').length;
    const stuckOnYou = gStuck.filter((r) => r.onYou).length;
    const nReady = qs.filter((x) => x.canRead).length;
    const nLost = qs.filter((x) => x.canReadElsewhere).length;
    const nPend = qs.length - nReady - nLost;
    const pl = (n, one, many) => n + ' ' + (n === 1 ? one : many);
    let headline = (openCount ? pl(openCount, 'decision is', 'decisions are') + ' waiting on you. ' : 'Nothing is waiting on your decision. ')
      + pl(gWorking.length, 'role is', 'roles are') + ' working, and ' + gStuck.length + ' ' + (gStuck.length === 1 ? 'is' : 'are') + ' stuck'
      + (stuckOnYou ? ' (' + stuckOnYou + ' of them on you).' : '.');
    if (nReady || nLost) headline += ' ' + (nReady ? pl(nReady, 'answer is', 'answers are') + ' ready to read' : '') + (nReady && nLost ? ', and ' : '') + (nLost ? nLost + ' didn’t reach your chat' : '') + '.';
    if (lastKnown) headline = 'Last known at ' + (sc === 'stale' ? '12:31' : '12:46') + ': ' + headline;
    if (loading) headline = 'Loading role status. Nothing is assumed yet.';
    const oldest = inboxSrc.length ? inboxSrc[inboxSrc.length - 1].age : '';
    const toDetails = (f) => () => self.setState({ view: 'details', stateFilter: f });
    const tiles = ready ? [
      { q: 'What needs my decision?', n: String(openCount), unit: openCount === 1 ? 'decision' : 'decisions', line: openCount ? 'Oldest has waited ' + oldest + ' · 1 is blocking other work' : 'Confirmed at 12:46:10', cta: openCount ? 'Review decisions' : 'Open details', fg: openCount ? '#F0B95A' : '#9FD8B8', bd: openCount ? '#6B5426' : '#2A2E34', go: toDetails('all') },
      { q: 'Who’s working, and on what?', n: String(gWorking.length), unit: gWorking.length === 1 ? 'role' : 'roles', line: gWorking.map((r) => r.name + ': ' + r.glance).join(' · ') || 'Nothing is running', cta: 'See their work', fg: '#7DB8FF', bd: '#2A2E34', go: toDetails('working') },
      { q: 'What’s stuck?', n: String(gStuck.length), unit: gStuck.length === 1 ? 'role' : 'roles', line: [nWait ? nWait + ' waiting' : '', nErr ? nErr + ' failed' : '', nUnk ? nUnk + ' unknown' : ''].filter(Boolean).join(' · ') + (stuckOnYou ? '. ' + stuckOnYou + ' need you to unblock.' : ''), cta: 'See why', fg: '#ECEDEE', bd: '#2A2E34', go: toDetails('all') },
      { q: 'Have my answers arrived?', n: String(nReady), unit: 'ready to read', line: [nLost ? nLost + ' didn’t reach your chat' : '', nPend ? nPend + ' still being answered' : ''].filter(Boolean).join(' · ') || 'No open questions', cta: 'Read answers', fg: '#9FD8B8', bd: nLost ? '#6B5426' : '#2A2E34', go: toDetails('all') }
    ] : [];

    const ORD = { working: 1, blocked: 2, queued: 3, onhold: 4, error: 5, unknown: 6, paused: 7, idle: 8 };
    const LANES = { ops: ['working', 'free', 'free', 'free'], temper: ['working', 'paused', 'free'], data: ['blocked', 'free'], coo: ['queued', 'free'], architecture: ['onhold', 'free'], rollcall: ['error'], systems: ['unknown', 'unknown'], design: ['working', 'free', 'free', 'free'], product: ['free', 'free'], backend: ['free', 'free'], frontend: ['working', 'free', 'free'], marketing: ['free', 'free'], qa: ['free', 'free', 'free'], docs: ['free', 'free'], security: ['free', 'free'] };
    const LS = {
      working: { bg: '#7DB8FF', bd: '#7DB8FF', bs: 'solid' }, blocked: { bg: 'rgba(240,185,90,0.35)', bd: '#F0B95A', bs: 'solid' },
      queued: { bg: 'rgba(175,196,226,0.22)', bd: '#AFC4E2', bs: 'solid' }, onhold: { bg: 'rgba(143,199,192,0.28)', bd: '#8FC7C0', bs: 'solid' },
      paused: { bg: '#4A4F57', bd: '#6B7079', bs: 'solid' }, error: { bg: '#FF8A80', bd: '#FF8A80', bs: 'solid' },
      unknown: { bg: 'transparent', bd: '#C7B8FF', bs: 'dashed' }, free: { bg: 'transparent', bd: '#4A4F57', bs: 'solid' }
    };
    const LWORD = { working: 'working', blocked: 'blocked', queued: 'queued', onhold: 'on hold', paused: 'paused by you', error: 'failed', unknown: 'unknown', free: 'free' };
    const laneInfo = (id) => {
      const ls = LANES[id] || [];
      const n = {}; ls.forEach((s) => { n[s] = (n[s] || 0) + 1; });
      const order = ['working', 'blocked', 'queued', 'onhold', 'paused', 'error', 'unknown', 'free'].filter((k) => n[k]);
      return {
        lanes: ls.map((s) => LS[s]),
        lanesText: (n.working || 0) + '/' + ls.length + ' working',
        lanesLabel: ls.length + ' task lanes: ' + order.map((k) => n[k] + ' ' + LWORD[k]).join(', ')
      };
    };
    const byName = {}; D.roles.forEach((r) => { byName[r.name] = r; });
    const LST = { running: ['In progress', '#7DB8FF'], ready: ['Not started', '#AFC4E2'], waiting: ['Waiting', '#F0B95A'], paused: ['Paused by you', '#C3C8CF'] };
    const linksAll = [];
    D.roles.forEach((o) => openOf(o).forEach((t) => {
      const asker = byName[t.src];
      if (asker) linksAll.push({ fromId: asker.id, toId: o.id, from: asker.name, to: o.name, id: t.id, title: t.title, s: t.s });
    }));
    const hov = st.hover || null;
    const hovName = hov === 'you' ? 'you' : (hov ? (D.roles.find((x) => x.id === hov) || {}).name : '');
    // Layout: departments evenly spaced on an ellipse in alphabetical order, You in the centre.
    // Deterministic, so adding a department just re-spaces the ring.
    // COO is your main line, so it sits beside you in the centre; the non-role process sits on your other side.
    // Inner ring: the departments you use most. Outer ring: everyone else. Both evenly spaced, alphabetical.
    const HUB = ['coo', 'ops', 'temper'];
    const sortedRoles = D.roles.filter((r) => HUB.indexOf(r.id) < 0).sort((a, b) => a.name.localeCompare(b.name));
    const hubRoles = D.roles.filter((r) => HUB.indexOf(r.id) >= 0).sort((a, b) => a.name.localeCompare(b.name));
    // Coordinates are real pixels of the graph area, so the graph fills whatever width it has.
    const VW = st.gw || 1400, VH = st.gh || 780;
    const nodeWu = Math.max(150, Math.min(180, Math.round(VW / 9)));
    const CX = VW / 2, CY = VH / 2, RX = VW / 2 - nodeWu / 2 - 28, RY = VH / 2 - 64;
    // Inner ring keeps clear of both You and the outer ring, whatever the window height.
    const IRX = Math.max(250, RX * 0.46), IRY = Math.max(108, Math.min(RY * 0.55, RY - 120));
    const N = sortedRoles.length;
    const POS = { you: [CX, CY] };
    // Inner ring starts on the left (COO beside you), evenly spaced.
    // With three, they sit left / right / above you, in the gaps the outer ring leaves.
    const INA = hubRoles.length === 3 ? [180, 0, -90] : hubRoles.map((r, i) => 180 + i * 360 / hubRoles.length);
    hubRoles.forEach((r, i) => { const a = INA[i] * Math.PI / 180; POS[r.id] = [CX + IRX * Math.cos(a), CY + IRY * Math.sin(a)]; });
    // Outer ring: equal spacing along the ellipse's length (not equal angles), so the narrow ends don't bunch up.
    const SMP = 720, epts = [], cum = [0];
    for (let k = 0; k <= SMP; k++) { const a = -Math.PI / 2 + k * 2 * Math.PI / SMP; epts.push([CX + RX * Math.cos(a), CY + RY * Math.sin(a)]); if (k > 0) cum.push(cum[k - 1] + Math.hypot(epts[k][0] - epts[k - 1][0], epts[k][1] - epts[k - 1][1])); }
    sortedRoles.forEach((r, i) => { const target = (i + 0.5) * cum[SMP] / N; let k = 0; while (k < SMP && cum[k] < target) k++; POS[r.id] = epts[k]; });
    // Obstacles for edge labels: every node box, the You pill and the Telegram pill.
    const OBST = Object.keys(POS).map((id) => id === 'you' ? [POS.you[0], POS.you[1], 82, 42] : [POS[id][0], POS[id][1], nodeWu / 2 + 10, 60]);
    OBST.push([(CX + POS.coo[0]) / 2, (CY + POS.coo[1]) / 2, 62, 16]);
    const clearOf = (p) => OBST.every((o) => Math.abs(p[0] - o[0]) > o[2] + 34 || Math.abs(p[1] - o[1]) > o[3] + 14);
    const nameOf = (id) => id === 'you' ? 'You' : (id === 'process' ? 'Process' : (D.roles.find((x) => x.id === id) || { name: id }).name);
    // An arrow = messages from one party to another that the receiver hasn't processed yet.
    // Once processed the arrow fades away; a reply is a new arrow in the other direction.
    const MSG = [
      { id: 'm1', from: 'qa', to: 'you', at: 'Wed 20:15', ref: 'Confirm', ask: true, text: 'Does the report fix work for you?' },
      { id: 'm2', from: 'marketing', to: 'you', at: 'Thu 09:00', ref: 'Question', ask: true, text: 'Which initiative should Marketing work on?' },
      { id: 'm_docs_temper', from: 'docs', to: 'temper', at: 'Sat 15:02', ref: '#71', text: 'Please send change notes once the new rules are in.' },
      { id: 'm4', from: 'architecture', to: 'frontend', at: 'Sat 17:18', ref: '#1', processed: true, text: 'Need the two repair plans before I can finish review #62.' },
      { id: 'm5', from: 'frontend', to: 'you', at: 'Sat 18:40', ref: 'Approval', ask: true, text: 'Approval needed: add 2 extra working sessions per day?' },
      { id: 'm6', from: 'you', to: 'coo', at: '08:12', ref: 'Chat', via: 'Telegram', processed: true, text: 'Morning. Anything I need to look at today?' },
      { id: 'm7', from: 'coo', to: 'you', at: '08:13', ref: 'Chat', via: 'Telegram', processed: true, text: 'Three decisions are waiting on you.' },
      { id: 'm8', from: 'you', to: 'coo', at: '11:05', ref: 'Q', via: 'Telegram', processed: true, text: 'What has Design spent on its own work this week?' },
      { id: 'm_coo_answer', from: 'coo', to: 'you', at: '11:40', ref: 'Answer', via: 'task chat #113', text: 'Design own-work spend this week: $1,240.50 of $2,000. (Posted in task chat #113; not yet delivered to Telegram or your app chat.)' },
      { id: 'm10', from: 'you', to: 'ops', at: '11:50', ref: '#98', processed: true, text: 'Please install the answer-visibility fix.' },
      { id: 'm11', from: 'data', to: 'design', at: '12:31', ref: '#41', processed: true, text: 'Please confirm the notebook format so I can run import #8.' },
      { id: 'm12', from: 'design', to: 'data', at: '12:38', ref: '#41', processed: true, text: 'Started #41. Checking the format against your import script.' },
      { id: 'm13', from: 'you', to: 'coo', at: '12:46', ref: '#112', via: 'app', processed: true, text: 'Approved the health check. Please roll it out.' },
      { id: 'm_coo_ops', from: 'coo', to: 'ops', at: '12:46', ref: '#112', text: 'Please roll out the health check the owner approved.' },
      { id: 'm15', from: 'frontend', to: 'architecture', at: '13:05', ref: '#1', processed: true, text: 'First repair plan drafted; second in progress.' }
    ].filter((m) => !(sc === 'empty' && m.ask));
    const nowMs = Date.now();
    const ago = (t) => { const s = Math.round((nowMs - t) / 1000); return s < 10 ? 'just now' : (s < 60 ? s + 's ago' : Math.round(s / 60) + ' min ago'); };
    const pnow = st.now || 0;
    const done = st.done || {};
    const resolvedRoles = {}; inbox.forEach((i) => { if (i.isResolved) resolvedRoles[i.role] = true; });
    const isPending = (m) => !m.processed && !done[m.id] && !(m.ask && resolvedRoles[nameOf(m.from)]) && !(m.id === 'm_coo_answer' && (st.readAnswers || {}).q2);
    const isLeaving = (m) => !!done[m.id] && pnow - done[m.id] < 700;
    const log = ready ? MSG.concat((st.sent || []).map((m) => Object.assign({}, m, { at: ago(m.t) }))) : [];
    const live = log.filter((m) => POS[m.from] && POS[m.to] && (isPending(m) || isLeaving(m)));
    const groups = {}; const gOrder = [];
    live.forEach((m) => { const k = m.from + '>' + m.to; if (!groups[k]) { groups[k] = []; gOrder.push(k); } groups[k].push(m); });
    const pairs = {}; live.filter(isPending).forEach((m) => { const k = [m.from, m.to].sort().join('|'); (pairs[k] = pairs[k] || []).push(m); });
    // Geometry: curves bow toward the centre; if both directions are pending they split to either side.
    const geo = (from, to) => {
      const p1 = POS[from], p2 = POS[to], mx = (p1[0] + p2[0]) / 2, my = (p1[1] + p2[1]) / 2;
      let c = (from === 'you' || to === 'you') ? [mx, my] : [mx + (CX - mx) * 0.38, my + (CY - my) * 0.38];
      if (groups[to + '>' + from]) { const dx = p2[0] - p1[0], dy = p2[1] - p1[1], L = Math.hypot(dx, dy) || 1; c = [c[0] - dy / L * 30, c[1] + dx / L * 30]; }
      return { p1: p1, p2: p2, c: c };
    };
    const at = (g, t) => { const u = 1 - t; return [u * u * g.p1[0] + 2 * u * t * g.c[0] + t * t * g.p2[0], u * u * g.p1[1] + 2 * u * t * g.c[1] + t * t * g.p2[1]]; };
    const tan = (g, t) => [2 * (1 - t) * (g.c[0] - g.p1[0]) + 2 * t * (g.p2[0] - g.c[0]), 2 * (1 - t) * (g.c[1] - g.p1[1]) + 2 * t * (g.p2[1] - g.c[1])];
    const tipKey = st.tip || null;
    const edges = gOrder.map((k) => {
      const ms = groups[k], pend = ms.filter(isPending), last = ms[ms.length - 1], from = last.from, to = last.to;
      const g = geo(from, to);
      const kind = pend.some((m) => m.ask) ? 'ask' : ((from === 'you' || to === 'you') ? 'you' : 'dept');
      const K = { ask: ['#B08433', '#F0B95A'], you: ['#7A8089', '#D6D9DD'], dept: ['#4A82C0', '#9CC7FF'] }[kind];
      const conn = !hov || from === hov || to === hov;
      const leaving = pend.length === 0;
      const pulseAt = (st.pulse || {})[k];
      const pulsing = pulseAt && pnow >= pulseAt && pnow - pulseAt < 2500;
      const cands = [0.5, 0.42, 0.58, 0.35, 0.65, 0.3, 0.7, 0.25, 0.75];
      const lt = cands.find((t) => clearOf(at(g, t))) || 0.5;
      const at2 = lt <= 0.5 ? Math.min(0.88, lt + 0.16) : Math.max(0.12, lt - 0.16);
      const aT = Math.max(at2, lt) === at2 ? at2 : at2;
      const ah = at(g, aT), tv = tan(g, aT), tl = Math.hypot(tv[0], tv[1]) || 1, ux = tv[0] / tl, uy = tv[1] / tl;
      const arrow = 'M' + (ah[0] + ux * 8) + ' ' + (ah[1] + uy * 8) + ' L' + (ah[0] - ux * 6 - uy * 6) + ' ' + (ah[1] - uy * 6 + ux * 6) + ' L' + (ah[0] - ux * 6 + uy * 6) + ' ' + (ah[1] - uy * 6 - ux * 6) + ' Z';
      const lp0 = at(g, lt);
      const lp = clearOf(lp0) ? lp0 : [lp0[0] - uy * 28, lp0[1] + ux * 28];
      const readable = to === 'you' && !pend.some((m) => m.ask) && pend.length > 0;
      return {
        key: k, a: from, b: to, d: 'M' + g.p1[0] + ' ' + g.p1[1] + ' Q' + g.c[0] + ' ' + g.c[1] + ' ' + g.p2[0] + ' ' + g.p2[1], arrow: arrow,
        stroke: K[0], sw: (hov && conn) || tipKey === k ? '2.5' : '1.6',
        op: leaving ? '0' : (conn || tipKey === k ? (lastKnown ? '0.55' : '0.95') : '0.08'),
        lxp: (lp[0] / VW * 100) + '%', lyp: (lp[1] / VH * 100) + '%', lx: lp[0],
        chip: (last.ref || 'msg') + (pend.length > 1 ? ' · ' + pend.length : ''), chipFg: K[1],
        chipBd: pulsing || tipKey === k ? K[1] : '#2F343A', glow: pulsing ? '0 0 0 4px rgba(156,199,255,0.22)' : 'none',
        aria: pend.length + ' message' + (pend.length === 1 ? '' : 's') + ' from ' + nameOf(from) + ' to ' + nameOf(to) + ' not processed yet. Latest: ' + last.text + (readable ? ' Press to mark as read.' : ''),
        tipOn: () => { if (self.state.tip !== k) self.setState({ tip: k }); },
        chipClick: () => { if (readable) self.markRead(pend.map((m) => m.id)); else if (self.state.tip !== k) self.setState({ tip: k }); },
        title: nameOf(from) + ' → ' + nameOf(to) + ' · ' + pend.length + ' not processed yet',
        hint: readable ? 'Click the label to mark as read' : (pend.some((m) => m.ask) ? 'Goes away when you decide (Details)' : 'Goes away when ' + nameOf(to) + ' processes it'),
        msgs: pend.slice().reverse().slice(0, 4).map((m) => ({ at: m.at, dir: nameOf(m.from) + ' → ' + nameOf(m.to) + (m.via ? ' · via ' + m.via : ''), text: m.text, fg: K[1] }))
      };
    });
    const tipEdge = edges.find((e) => e.key === tipKey && e.op !== '0');
    const tip = tipEdge ? { x: tipEdge.lxp, y: tipEdge.lyp, tf: tipEdge.lx > VW * 0.62 ? 'translate(calc(-100% - 18px), -50%)' : 'translate(18px, -50%)', title: tipEdge.title, hint: tipEdge.hint, msgs: tipEdge.msgs } : { x: '0%', y: '0%', tf: 'none', title: '', hint: '', msgs: [] };
    const flights = (st.flights || []).filter((f) => POS[f.from] && POS[f.to]).map((f) => {
      const t = Math.min(1, Math.max(0, (pnow - f.t0) / 1300)); const e = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const p = at(geo(f.from, f.to), e);
      return { x: p[0], y: p[1], c: f.ask ? '#F0B95A' : ((f.to === 'you' || f.from === 'you') ? '#ECEDEE' : '#9CC7FF') };
    });
    const relFor = (id) => {
      if (!hov || hov === id) return '';
      const hn = hov === 'you' ? 'you' : hovName;
      const out = live.filter((m) => isPending(m) && m.from === id && m.to === hov).length;
      const inn = live.filter((m) => isPending(m) && m.from === hov && m.to === id).length;
      const parts = [];
      if (out) parts.push(out + ' sent to ' + hn + ', not processed');
      if (inn) parts.push(inn + ' from ' + hn + ' to process');
      return parts.join(' · ');
    };
    const youOpen = inbox.filter((i) => i.isOpen).length;
    // 6 am reports (mock). RollCall's run failed after 9 of 15, so 6 departments have none today.
    const REP = {
      ops: { summary: 'Services healthy. #98 is built and checked; installing today.', done: ['Overnight health checks: all services up', '#98 fix built and passed QA check'], today: ['Install #98 on the live server', 'Pick up COO’s #112 when a lane frees'], blocked: [] },
      temper: { summary: 'Your accepted instructions are saved; migration starts today.', done: ['Saved your accepted instructions, old rules kept'], today: ['Move old rules into the new format (#69)', 'Retire duplicate rules after #69 (#70)'], blocked: ['#68 paused by you'] },
      data: { summary: 'Import is ready to run; waiting on Design’s format sign-off.', done: ['Import script dry run passed on a sample notebook'], today: ['Run import #8 once Design accepts the format'], blocked: ['Waiting on Design #41'] },
      coo: { summary: 'Three decisions are with you; health check ready to hand to Ops once approved.', done: ['Routed 3 approvals and questions to you'], today: ['Hand the health check to Ops after your approval', 'Weekly cross-department dependency review (#114)'], blocked: [] },
      architecture: { summary: 'Repair-plan review is on hold until Frontend sends plans.', done: ['Prepared the review checklist'], today: [], blocked: ['On hold for Frontend’s repair plans', 'No next task recorded for request R-14'] },
      design: { summary: 'Own initiatives paused; working Data’s format request.', done: ['Reviewed the proposed notebook (#40)'], today: ['Accept the notebook format for Data (#41)'], blocked: ['Own initiatives paused by you'] },
      product: { summary: 'Nothing planned: own initiatives paused and no requests.', done: [], today: [], blocked: ['Own initiatives paused by you'] },
      frontend: { summary: 'Writing repair plans for Architecture; own work paused.', done: ['Outlined 2 repair plans'], today: ['Finish both repair plans and send to Architecture (#1)'], blocked: ['Own initiatives paused by you', 'Waiting on your approval for extra sessions'] },
      qa: { summary: 'No new checks queued. One fix waiting on your confirmation.', done: ['Independent check of Ops #98 passed'], today: [], blocked: ['Report fix waiting on your confirmation'] }
    };
    const repInfo = (r) => {
      const rp = REP[r.id];
      if (!rp) return { rep: { has: false, missing: true, when: 'Sun Oct 11 · 06:00 PT', summary: '', sections: [],
        reason: r.id === 'rollcall' ? 'RollCall’s own 06:00 run failed (exit 137), so no report was produced.' : 'Not collected: RollCall’s 06:00 run failed after 9 of 15 reports.',
        last: r.id === 'systems' ? 'Sat 06:00 (before status went unknown)' : 'Sat 06:00' } };
      const sec = [['Done since last report', rp.done, '#9FD8B8'], ['Planned today', rp.today, '#9CC7FF'], ['Blocked or waiting', rp.blocked, '#F0B95A']].filter((s) => s[1].length).map((s) => ({ label: s[0], fg: s[2], items: s[1].map((t) => ({ t: t })) }));
      return { rep: { has: true, missing: false, when: 'Sun Oct 11 · 06:00 PT', summary: rp.summary, sections: sec, reason: '', last: '' } };
    };
    const INITD = {
      ops: [['Service upkeep', 'Keep services healthy, logs rotated and deploys clean.']], temper: [['Rules migration', 'Move old rules into the new instruction format without losing any.']],
      data: [['Notebook import', 'Bring proposed notebooks into the design page.']], coo: [['Cross-department coordination', 'Route your approvals and track dependencies between departments.']],
      architecture: [['Repair program', 'Review and sign off repair plans before they ship.']], rollcall: [['Morning reports', 'Collect every department’s 06:00 report.']],
      systems: [['Host upkeep', 'Keep machines and runtimes patched.']], design: [['Notebook formats', 'Define the notebook formats other departments build on.', ['#44']], ['Design page refresh', 'Rework the design page and its empty states.', ['#43', '#45…']]],
      product: [['Q4 backlog', 'Put the Q4 backlog in order.']], backend: [['Token efficiency', 'Cut token usage across services.']], frontend: [['UI repairs', 'Fix reported UI issues.']],
      qa: [['Regression suite', 'Keep a regression run for every shipped fix.']], docs: [['User docs', 'Keep user docs current.']], security: [['Access hygiene', 'Run regular access reviews.']]
    };
    const ISTAT = { active: ['Active', '#7DB8FF'], waiting: ['Waiting', '#F0B95A'], paused: ['Paused by you', '#C3C8CF'], idle: ['Idle', '#A9AEB6'], error: ['Last run failed', '#FF8A80'], unknown: ['Unknown', '#C7B8FF'] };
    const TW = { running: 'running', ready: 'ready', waiting: 'waiting', paused: 'paused', done: 'done' };
    const initInfo = (r) => {
      const list = INITS[r.id] || [], det = INITD[r.id] || [];
      const own = (r.tasks || []).filter((t) => srcOf(r, t) === 'own' && t.s !== 'done');
      const inits = list.map((it, i) => {
        const d = det[i] || [it[0], ''], ids = d[2];
        const ts = ids ? own.filter((t) => ids.indexOf(t.id) >= 0) : own;
        return { name: it[0], status: (ISTAT[it[1]] || ISTAT.idle)[0], fg: (ISTAT[it[1]] || ISTAT.idle)[1], goal: d[1],
          tasksText: ts.length ? ts.map((t) => t.id + ' ' + TW[t.s]).join(' · ') : 'No open tasks' };
      });
      return { inits: inits, initEmpty: !inits.length, initCount: inits.length ? inits.length + (inits.length === 1 ? ' initiative' : ' initiatives') : '' };
    };
    const boxes = ready ? D.roles.map((r) => {
      const g = (sc === 'empty' && EMPTYGL[r.id]) || GL[r.id];
      const ex = st.expanded === r.id;
      const rel = relFor(r.id);
      const isHov = hov === r.id;
      return Object.assign(decorate(r), laneInfo(r.id), repInfo(r), initInfo(r), {
        // roles-budget-card: the supplied design shows no card budget line, so its panel keeps spending lower.
        spendBelow: true,
        hasRel: !!rel, relText: rel,
        px: (POS[r.id][0] / VW * 100) + '%', py: (POS[r.id][1] / VH * 100) + '%',
        op: hov && !isHov && !rel ? '0.38' : dim,
        bdNow: isHov ? '#9CC7FF' : (rel ? '#3D5A80' : (g[1] ? '#6B5426' : '#2A2E34')),
        hoverOn: () => { if (self.state.hover !== r.id) self.setState({ hover: r.id }); },
        glance: g[0], onYou: g[1], expanded: ex, expandedStr: String(ex), span: ex ? '1 / -1' : 'auto', chev: ex ? 'rotate(180deg)' : 'none',
        bd: ex ? '#5A6170' : (g[1] ? '#6B5426' : '#2A2E34'),
        nextShort: r.next || (r.nextMissing ? r.nextNote : 'None recorded'),
        expand: makeExpand(r.id),
        decisions: inbox.filter((i) => i.role === r.name), hasDecisions: inbox.some((i) => i.role === r.name),
        questions: qs.filter((x) => x.to === r.name), hasQuestions: qs.some((x) => x.to === r.name)
      });
    }).sort((a, b) => (ORD[a.state] - ORD[b.state]) || (Number(b.onYou) - Number(a.onYou))) : [];
    const exIsYou = ready && st.expanded === 'you';
    const exRaw = exIsYou ? (boxes[0] || null) : boxes.find((b) => b.id === st.expanded);
    const ex = exRaw || boxes[0] || Object.assign(decorate(D.roles[0]), laneInfo(D.roles[0].id), repInfo(D.roles[0]), initInfo(D.roles[0]));
    const fr = st.from || { t: 0, l: 0, w: 0, h: 0 };
    const targetH = st.wrapH || 600;
    const exPos = st.grown
      ? { t: '0px', l: '0px', w: '100%', h: targetH + 'px', o: '1', y: '0px', d: '150ms', ov: st.settled ? 'auto' : 'hidden' }
      : { t: fr.t + 'px', l: fr.l + 'px', w: fr.w + 'px', h: fr.h + 'px', o: '0', y: '8px', d: '0ms', ov: 'hidden' };
    const exMinH = '0px';
    const closeEx = () => { clearTimeout(self._settleT); self.setState({ grown: false, settled: false }); setTimeout(() => self.setState({ expanded: null }), 350); };

    const FOOT = { live: 'Last confirmed update 12:46:10 · refreshes every 15 s', empty: 'Last confirmed update 12:46:10 · refreshes every 15 s', stale: 'Last confirmed update 12:31:02 · overdue by 15 min', disconnected: 'Last confirmed update 12:46:10 · disconnected', loading: 'Waiting for first update' };

    return {
      showProto: this.props.showProto ?? true,
      isGlance: view === 'glance', isDetails: view === 'details',
      viewTabs: [tabBtn('glance', 'At a glance', view, 'view'), tabBtn('details', 'Details', view, 'view')],
      glance: { headline, tiles, cols, boxes },
      exOpen: !!exRaw, ex, exPos, closeEx, exMinH, exIsYou, exIsDept: !!exRaw && !exIsYou,
      repOpen: !!st.repOpen, repOpenStr: String(!!st.repOpen), repChev: st.repOpen ? 'rotate(180deg)' : 'none',
      toggleRep: () => self.setState({ repOpen: !self.state.repOpen }),
      exLabel: exIsYou ? 'Your decisions, questions and spending' : (ex.name + ' details'),
      youExpand: makeExpand('you'),
      graph: { edges, flights, tipOpen: !!tipEdge && !exRaw, tip },
      nodeW: nodeWu + 'px', gw: VW, gh: VH,
      setGraphEl: (el) => { if (el && self._graphEl !== el) { self._graphEl = el; self.measureGraph(); } },
      legendOpen: !!st.legendOpen, legendOpenStr: String(!!st.legendOpen), legendLabel: st.legendOpen ? 'Hide legend' : 'Legend',
      toggleLegend: () => self.setState({ legendOpen: !self.state.legendOpen }),
      tipOff: () => { if (self.state.tip) self.setState({ tip: null }); },
      youText: youOpen ? youOpen + ' waiting on you' : 'Nothing waiting on you',
      youBd: hov === 'you' ? '#F0B95A' : '#6B5426',
      youOp: hov && hov !== 'you' && !pairs[['you', hov].sort().join('|')] ? '0.38' : '1',
      youHoverOn: () => { if (self.state.hover !== 'you') self.setState({ hover: 'you' }); },
      tgOp: hov && hov !== 'you' && hov !== 'coo' ? '0.2' : '1',
      tgX: ((POS.you[0] + POS.coo[0]) / 2 / VW * 100) + '%', tgY: ((POS.you[1] + POS.coo[1]) / 2 / VH * 100) + '%',
      hoverOff: () => { if (self.state.hover) self.setState({ hover: null }); },
      scenarios, fresh: FRESH[sc], banner, loading, ready, offline, lastKnown, dim,
      q: st.q, dept, workOpts, filters, isFiltered,
      filterText: 'Showing ' + vis.length + ' of ' + D.roles.length + ' departments',
      onSearch: (e) => self.setState({ q: e.target.value }),
      onDept: (e) => self.setState({ dept: e.target.value }),
      clearFilters: () => self.setState({ q: '', dept: 'all', work: 'all', stateFilter: 'all' }),
      inbox, inboxCount: loading ? '–' : String(openCount), inboxSub: SUB[sc],
      inboxBadgeBg: openCount ? '#F0B95A' : '#262A30', inboxBadgeFg: openCount ? '#17130A' : '#D6D9DD',
      inboxEmpty: sc === 'empty',
      qs, qsEmpty: sc === 'empty', readQs: D.readQs, showRead: ready && st.showRead, showReadStr: String(st.showRead),
      readToggleLabel: (st.showRead ? 'Hide' : 'Show') + ' answered and read (' + D.readQs.length + ')',
      toggleRead: () => self.setState({ showRead: !self.state.showRead }),
      cardGroups, rowGroups, noMatches: ready && vis.length === 0,
      actTabs: [tabBtn('work', 'Work progress', st.actTab, 'actTab'), tabBtn('config', 'Configuration changes', st.actTab, 'actTab')],
      actNote: st.actTab === 'work' ? 'What roles actually did. Saved settings and instructions are under Configuration changes.' : 'Saved settings, instructions and pauses. A saved change isn’t progress, and isn’t active until a run loads it.',
      acts, actMoreLabel: st.actMore ? 'Show fewer' : 'Show earlier (' + Math.max(actsAll.length - 5, 0) + ' more)',
      toggleActMore: () => self.setState({ actMore: !self.state.actMore }),
      drawerOpen: !!drRaw, dr,
      drTabs: [tabBtn('work', 'Work progress', st.drawerTab, 'drawerTab'), tabBtn('config', 'Configuration', st.drawerTab, 'drawerTab')],
      closeDrawer: () => self.setState({ drawer: null }),
      footerText: FOOT[sc]
    };
  }
}
