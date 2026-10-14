// Sealed reference observer only. Captures the source-observed initial data
// state, without freezing RAF, layout, unrelated timers, or changing bytes.
export function installInitialSendHold(win = globalThis) {
  win.__u0InitialSendHold = [];
  let heldId = -1;
  for (const [name, delay] of [['setTimeout', 1800], ['setInterval', 3500]]) {
    const original = win[name].bind(win);
    win[name] = (callback, ms, ...args) => {
      if (ms === delay && typeof callback === 'function' && /\b(?:this\.)?sendNext\s*\(/.test(Function.prototype.toString.call(callback))) {
        win.__u0InitialSendHold.push({ timer: name, delay: ms, reason: 'source sendNext initial predicate' });
        return heldId--;
      }
      return original(callback, ms, ...args);
    };
  }
}
