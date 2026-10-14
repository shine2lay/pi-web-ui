import { mountNativeRoles } from '../../web/src/roles-u0/mount.ts';
import { missingFields } from '../../web/src/roles-u0/fields.ts';
// Sealed harness only, outside web/: no production entry loads it. Fictional
// native snapshots (namespace rtpi-native, metadata all missing unless a case
// says otherwise) for the lifecycle, accessibility and theme stages.
const meta = (fields = missingFields()) => ({ schema: 'roles-u0/read-model/1', namespace: 'rtpi-native', fields });
const src = { namespace: 'rtpi-native', kind: 'test', id: 'native-entry', revision: '1' };
const known = value => ({ state: 'known', value, asOf: '2026-01-01T00:00:00.000Z', source: src });
const base = (id, title) => ({ id, title, workMode: 'request-only', workModeFrom: 'rules', goals: [], goalsFrom: 'rules', status: 'busy', asks: [], tldr: [], requests: { open: 0 }, report: { state: 'unavailable' } });
function roles(kind) {
  const out = ['alpha', 'bravo', 'charlie', 'delta', 'echo'].map((id, i) => ({ role: { ...base(id, 'Fictional ' + id), homeChat: { file: '/fictional/' + id + '.jsonl' }, queue: { running: false, active: [], queued: [], counts: { active: 0, queued: 0, done: 0 } } }, metadata: meta() }));
  if (kind === 'long') {
    out[0].role.title = 'A deliberately long fictional department title that keeps going well past one line';
    out[0].role.queue = { running: true, active: [1, 2, 3].map(id => ({ id, title: 'A deliberately long fictional task title number ' + id + ' that wraps over several lines in the panel', status: 'working' })), queued: [{ id: 4, title: 'Fictional later task', status: 'ready' }], counts: { active: 3, queued: 1, done: 2 } };
  }
  if (kind === 'partial') {
    out[1].metadata = meta({ ...missingFields(), A05: known('working'), A06: known(['working', 'free']), A08: known(true) });
  }
  return out;
}
window.startU0Native = async (kind, fonts) => {
  const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const connection = kind === 'disconnected' ? 'disconnected' : kind === 'loading' ? 'loading' : 'connected';
  let snap = { namespace: 'rtpi-native', registryComplete: true, checkedAt: '2026-01-01T00:00:00.000Z', connection, roles: kind === 'empty' ? [] : roles(kind) };
  window.u0Opened = [];
  const routes = { canOpen: (id, r) => snap.roles.some(x => x.role.id === id) && ['home', 'queue', 'board', 'report', 'spend', 'about'].includes(r), open: (id, r) => window.u0Opened.push([id, r]) };
  const host = document.createElement('div');
  host.id = 'u0-host';
  host.style.cssText = 'position:fixed;inset:0';
  document.body.appendChild(host);
  window.u0Mounted = await mountNativeRoles(host, () => snap, routes, { geist: decode(fonts.geist), mono: decode(fonts.mono) });
  window.u0SetSnapshot = next => { snap = next; window.u0Mounted.update(); };
  await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame);
  window.u0Ready = true;
};
