import { bindRolesSurface, prepareRolesDocument } from '../../web/src/roles-u0/surface.ts';
import { ReferenceModel } from './reference-model.js';
// Sealed build only, deliberately outside web/. No entry in production HTML,
// route or worker loads this module. Contains fictional prototype values.
window.startU0Fixture = async (spec, fonts) => {
  const decode = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  await prepareRolesDocument(document, { geist: decode(fonts.geist), mono: decode(fonts.mono) });
  if (spec.name === 'state-chip') {
    const values = { text: 'Working now', fg: '#7DB8FF', bg: 'rgba(125,184,255,0.12)', bd: 'rgba(125,184,255,0.4)', bs: 'solid', isWorking: true };
    window.u0 = bindRolesSurface(document, () => values, true);
  } else {
    const model = new ReferenceModel({ scenario: spec.scenario || 'live', view: 'glance', showProto: false });
    window.u0 = bindRolesSurface(document, () => ({
      ...model.renderVals(), headingSummary: '15 departments · Sun Oct 11', provenanceText: 'All roles, tasks, times and figures are mock data',
      emptyInboxText: 'Nothing needs your decision. Confirmed at 12:46:10.',
      contactsHeading: 'Your questions · asked → contacted → reply → in your chat', roleContactsHeading: 'Your questions to',
      emptyContactsText: 'No open questions. Every answer has reached you.',
      spendPeriodText: 'Spending this week · Mon Oct 5 – Sun Oct 11 PT', spendRoleText: 'Design · own-initiative',
      spendAmountText: '$1,240.50', spendBudgetText: 'of $2,000.00', spendAria: 'Design has used $1,240.50 of its $2,000 weekly own-work budget',
      spendBarWidth: '62%', spendBarColor: '#7DB8FF', arrowMeaning: 'Arrows = messages not processed yet (they disappear once handled; a reply is a new arrow back):',
      channelShown: true, contactChannelTitle: 'Your Telegram bot: messages you send on Telegram go to COO, and COO can reply there', contactChannelText: 'Telegram bot',
      spendNoteText: 'Design’s own work is paused by you; leftover budget doesn’t resume it. Requested work ($318.10 reported by 6 of 12 departments) is exempt. “Not reported” never means $0.',
    }));
    model.update = () => window.u0.update();
    window.u0Model = model;
  }
  await new Promise(requestAnimationFrame);
  await document.fonts.ready;
  window.u0Ready = true;
};
