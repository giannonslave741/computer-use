// Detect a repeated action chain (stagnation): the same chain repeats >= limit times.
// The agent is clicking blindly or repeating a strategy that is not working.
// Coordinates are rounded to a 64px grid so "click 450,359" and "click 425,359"
// (a few pixels of model jitter) still count as the SAME chain.

const GRID = 64;
const q = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v / GRID) * GRID : v);
const point = (p) => (p && typeof p === 'object' ? { x: q(p.x), y: q(p.y) } : p);

export function normalizeChain(actions) {
  const list = Array.isArray(actions) ? actions : [actions];
  return JSON.stringify(
    list
      .filter((a) => a && typeof a === 'object')
      .map((a) => {
        const o = { action: a.action };
        for (const k of Object.keys(a).sort()) {
          if (k === 'action') continue;
          if (k === 'x' || k === 'y') o[k] = q(a[k]);
          else if (k === 'from' || k === 'to') o[k] = point(a[k]);
          else o[k] = a[k];
        }
        return o;
      })
  );
}

export function createStagnationDetector({ limit = 3 } = {}) {
  let lastKey = null;
  let count = 0;
  let total = 0;

  function push(actions) {
    const key = normalizeChain(actions);
    total++;
    if (key === lastKey) count++;
    else {
      lastKey = key;
      count = 1;
    }
    return count;
  }

  function get() {
    return { count, lastKey, total, stagnating: count >= limit, limit };
  }

  function message() {
    const s = get();
    if (!s.stagnating) return '';
    return (
      `Chain ${s.lastKey} has repeated ${s.count} times in a row. ` +
      'STUCK IN A LOOP - do NOT send that same chain again. ' +
      'Change strategy: window_list, window_activate the right window, ' +
      'take a new screenshot, then click a different coordinate.'
    );
  }

  function reset() {
    lastKey = null;
    count = 0;
    total = 0;
  }

  return { push, get, message, reset };
}
