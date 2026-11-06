// Phát hiện lặp hành động (stagnation): cùng một chuỗi action lặp lại >= limit lần
// => agent đang click mù / lặp lại chiến lược không hiệu quả.
// Tọa độ được làm tròn theo lưới 64px để "click 450,359" và "click 425,359"
// (chênh vài pixel do model rung tay) vẫn bị coi là CÙNG chuỗi.

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
      `Chuỗi ${s.lastKey} đã lặp ${s.count} lần liên tiếp. ` +
      'ĐANG BỊ LẶP - KHÔNG được gửi lại cùng chuỗi đó. ' +
      'Phải đổi chiến lược: dùng window_list để xem cửa sổ, ' +
      'window_activate đúng cửa sổ, chụp lại ảnh, rồi mới click tọa độ khác.'
    );
  }

  function reset() {
    lastKey = null;
    count = 0;
    total = 0;
  }

  return { push, get, message, reset };
}
