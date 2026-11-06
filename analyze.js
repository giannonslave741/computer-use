// analyze.js — Automatic pixel analysis (not the model's guess).
//
// Tell the model what the last action chain actually did. Free vision models aim poorly
// and often do not notice that their click hit nothing.
//
// Three measurements:
//   1. Did the screen change, and where
//   2. Is the click point inside the foreground window and the screen
//   3. Is the real cursor at the requested coordinate (catches a bad coordinate map)

const CELL = 16;
const SAMPLE = 4; // one pixel every 4 pixels in a cell -> 16 samples per cell
const DIFF_THRESHOLD = 10; // average RGB delta above 10 counts as a changed cell

/** Compare two frames of the same size. */
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
    return 'Screen AFTER the chain: almost unchanged -> the last chain did nothing.';
  }
  const pct = (diff.ratio * 100).toFixed(1);
  const b = diff.bbox;
  const where = b
    ? ` (changed region: (${b.x0},${b.y0})-(${b.x1},${b.y1}) — look at that region)`
    : '';
  return `Screen AFTER the chain: ${pct}% of the screen changed${where}.`;
}

/**
 * Check click and cursor points.
 * @param {Array<{x:number,y:number}>} points
 * @param {{rect?: {left,top,right,bottom}|null, width:number, height:number}} ctx
 * @returns {string[]} warnings (empty means the points are fine)
 */
export function checkPoints(points, ctx) {
  const out = [];
  if (!Array.isArray(points) || !points.length) return out;
  const { rect, width, height } = ctx;
  for (const p of points) {
    if (!p || typeof p.x !== 'number' || typeof p.y !== 'number') continue;
    if (p.x < 0 || p.y < 0 || p.x >= width || p.y >= height) {
      out.push(`POINT (${p.x},${p.y}) IS OUTSIDE THE SCREEN ${width}x${height} -> the click will miss.`);
      continue;
    }
    if (
      rect &&
      (p.x < rect.left || p.x > rect.right || p.y < rect.top || p.y > rect.bottom)
    ) {
      out.push(
        `POINT (${p.x},${p.y}) IS OUTSIDE THE FOREGROUND WINDOW ` +
          `(rect ${rect.left},${rect.top} -> ${rect.right},${rect.bottom}) ` +
          `-> it does not hit the target application.`
      );
    }
  }
  return out;
}

/** Check that the cursor is at the clicked coordinate (catches a bad coordinate map). */
export function checkCursor(actual, expected) {
  if (!actual || !expected) return '';
  const d = Math.hypot(actual.x - expected.x, actual.y - expected.y);
  if (d <= 6) return '';
  return (
    `ACTUAL CURSOR IS AT (${Math.round(actual.x)},${Math.round(actual.y)}), NOT ` +
    `(${expected.x},${expected.y}) as requested (off by ${Math.round(d)}px) ` +
    `-> the click did not land. Pick the point again from the grid numbers.`
  );
}
