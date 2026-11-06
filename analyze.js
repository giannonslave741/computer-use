// analyze.js — Phân tích TỰ ĐỘNG bằng pixel (không phải suy đoán của model).
//
// Mục tiêu: cho model biết kết quả THẬT của chuỗi hành động vừa chạy, vì model VL
// miễn phí nhắm tọa độ kém và thường không nhận ra click của mình không trúng gì.
//
// 3 tín hiệu không thể sai:
//   1. Màn hình có thay đổi sau chuỗi không + vùng nào thay đổi  -> "click có tác dụng không"
//   2. Điểm click có nằm trong cửa sổ foreground / trong màn hình không
//   3. Con trỏ có THẬT SỰ nằm ở tọa độ đã click không            -> bắt lỗi mapping tọa độ

const CELL = 16;
const SAMPLE = 4; // lấy 1 pixel mỗi 4 pixel trong ô -> 16 điểm/ô
const DIFF_THRESHOLD = 10; // chênh trung bình RGB > 10 coi như ô đó đổi

/** So sánh 2 khung hình cùng kích thước. */
export function diffFrames(a, b) {
  if (!a || !b || a.w !== b.w || a.h !== b.h) return null;
  const cols = Math.ceil(a.w / CELL);
  const rows = Math.ceil(a.h / CELL);
  let changed = 0;
  let x0 = -1;
  let y0 = -1;
  let x1 = -1;
  let y1 = -1;

  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      let sum = 0;
      let n = 0;
      const sx = cx * CELL;
      const sy = cy * CELL;
      for (let y = sy; y < Math.min(sy + CELL, a.h); y += SAMPLE) {
        for (let x = sx; x < Math.min(sx + CELL, a.w); x += SAMPLE) {
          const i = (y * a.w + x) * 4;
          sum +=
            Math.abs(a.rgba[i] - b.rgba[i]) +
            Math.abs(a.rgba[i + 1] - b.rgba[i + 1]) +
            Math.abs(a.rgba[i + 2] - b.rgba[i + 2]);
          n++;
        }
      }
      if (!n) continue;
      if (sum / n / 3 > DIFF_THRESHOLD) {
        changed++;
        if (x0 < 0 || sx < x0) x0 = sx;
        if (y0 < 0 || sy < y0) y0 = sy;
        if (x1 < 0 || sx + CELL > x1) x1 = sx + CELL;
        if (y1 < 0 || sy + CELL > y1) y1 = sy + CELL;
      }
    }
  }
  const total = cols * rows;
  return {
    ratio: total ? changed / total : 0,
    bbox: changed ? { x0, y0, x1: Math.min(x1, a.w), y1: Math.min(y1, a.h) } : null
  };
}

export function formatDiff(diff) {
  if (!diff) return '';
  if (diff.ratio < 0.004) {
    return 'Màn hình SAU chuỗi: KHÔNG thay đổi gần như nào -> chuỗi vừa rồi KHÔNG làm được gì.';
  }
  const pct = (diff.ratio * 100).toFixed(1);
  const b = diff.bbox;
  const where = b
    ? ` (vùng đổi: (${b.x0},${b.y0})-(${b.x1},${b.y1}) — hãy nhìn đúng vùng đó để đánh giá)`
    : '';
  return `Màn hình SAU chuỗi: thay đổi ${pct}% màn hình${where}.`;
}

/**
 * Kiểm tra các điểm click/chuột.
 * @param {Array<{x:number,y:number}>} points
 * @param {{rect?: {left,top,right,bottom}|null, width:number, height:number}} ctx
 * @returns {string[]} các cảnh báo (rỗng = ổn)
 */
export function checkPoints(points, ctx) {
  const out = [];
  if (!Array.isArray(points) || !points.length) return out;
  const { rect, width, height } = ctx;
  for (const p of points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) {
      out.push(`ĐIỂM (${p.x},${p.y}) NẰM NGOÀI MÀN HÌNH ${width}x${height} -> click sẽ trượt.`);
      continue;
    }
    if (
      rect &&
      (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom)
    ) {
      out.push(
        `ĐIỂM (${p.x},${p.y}) NẰM NGOÀI CỬA SỔ FOREGROUND ` +
          `(rect ${rect.left},${rect.top} -> ${rect.right},${rect.bottom}) ` +
          `-> không nhắm vào ứng dụng đích.`
      );
    }
  }
  return out;
}

/** Kiểm tra con trỏ có nằm đúng tọa độ đã click không (bắt lỗi mapping/đường bắn). */
export function checkCursor(actual, expected) {
  if (!actual || !expected) return '';
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  if (d <= 6) return '';
  return (
    `CHUỘT THẬT ĐANG Ở (${Math.round(actual.x)},${Math.round(actual.y)}) chứ KHÔNG phải ` +
    `(${expected.x},${expected.y}) mà bạn yêu cầu (lệch ${Math.round(d)}px) ` +
    `-> tọa độ click không được bắn đúng, hãy chọn lại điểm theo số trên lưới.`
  );
}
