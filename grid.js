// grid.js — Vẽ lưới tọa độ lên ảnh screenshot rồi trả về buffer PNG mới.
//
// Lý do tồn tại: model VL miễn phí ĐỌC đúng nội dung ảnh nhưng ước tọa độ SAI trầm trọng
// (thực tế ô tìm kiếm ở 57%,42% -> model đoán 40%,27% -> click vào khoảng trống).
// Bằng cách vẽ thẳng số tọa độ lên ảnh, model chỉ cần ĐỌC số gần điểm cần click
// thay vì ước lượng -> click trúng đích.
//
// Không thêm dependency nào: tự giải mã + mã hoá PNG bằng zlib có sẵn của Node.

import zlib from 'node:zlib';
import fs from 'node:fs/promises';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** Đọc buffer PNG -> { width, height, rgba: Uint8Array }. Trả về null nếu không hỗ trợ. */
export function decodePng(buf) {
  try {
    if (buf.length < 24 || buf.readUInt32BE(0) !== 0x89504e47) return null;
    let offset = 8;
    let ihdr = null;
    const idat = [];
    while (offset + 8 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      const data = buf.subarray(offset + 8, offset + 8 + len);
      if (type === 'IHDR') {
        ihdr = {
          width: data.readUInt32BE(0),
          height: data.readUInt32BE(4),
          bitDepth: data[8],
          colorType: data[9],
          interlace: data[12]
        };
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      offset += 12 + len;
    }
    // Chỉ hỗ trợ 8-bit, không nén interlace (screenshot-desktop luôn xuất dạng này).
    if (!ihdr || ihdr.bitDepth !== 8 || ihdr.interlace !== 0) return null;
    const channels = ihdr.colorType === 6 ? 4 : ihdr.colorType === 2 ? 3 : 0;
    if (!channels) return null;

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const { width: w, height: h } = ihdr;
    const stride = w * channels;
    const rgba = new Uint8Array(w * h * 4);

    // Bỏ lọc từng dòng (PNG filter types 0..4).
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < h; y++) {
      const rowStart = y * (stride + 1);
      const filter = raw[rowStart];
      const line = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
      if (filter === 1) {
        for (let i = channels; i < stride; i++) line[i] = (line[i] + line[i - channels]) & 0xff;
      } else if (filter === 2) {
        for (let i = 0; i < stride; i++) line[i] = (line[i] + prev[i]) & 0xff;
      } else if (filter === 3) {
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? line[i - channels] : 0;
          line[i] = (line[i] + ((a + prev[i]) >> 1)) & 0xff;
        }
      } else if (filter === 4) {
        for (let i = 0; i < stride; i++) {
          const a = i >= channels ? line[i - channels] : 0;
          const b = prev[i];
          const c = i >= channels ? prev[i - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          line[i] = (line[i] + pred) & 0xff;
        }
      }
      prev = line;
      const out = y * w * 4;
      if (channels === 4) {
        rgba.set(line, out);
      } else {
        for (let i = 0, j = 0; i < w; i++, j += 3) {
          rgba[out + i * 4] = line[j];
          rgba[out + i * 4 + 1] = line[j + 1];
          rgba[out + i * 4 + 2] = line[j + 2];
          rgba[out + i * 4 + 3] = 255;
        }
      }
    }
    return { width: w, height: h, rgba };
  } catch {
    return null;
  }
}

/**
 * Mã hoá RGBA -> buffer PNG (color type 2/RGB, filter 0) — bỏ kênh alpha cho file nhỏ hơn.
 * @param {number} quantSố bit còn lại mỗi kênh (0 = giữ nguyên). Cắt bit làm PNG nén tốt hơn nhiều.
 */
export function encodePng(width, height, rgba, quant = 0) {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const mask = quant > 0 && quant < 8 ? (0xff << (8 - quant)) & 0xff : 0;
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0;
    let src = y * width * 4;
    let dst = row + 1;
    for (let x = 0; x < width; x++, src += 4, dst += 3) {
      raw[dst] = mask ? rgba[src] & mask : rgba[src];
      raw[dst + 1] = mask ? rgba[src + 1] & mask : rgba[src + 1];
      raw[dst + 2] = mask ? rgba[src + 2] & mask : rgba[src + 2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

const FONT = {
  0: ['01110', '10001', '10011', '10101', '11001', '10001', '01110'],
  1: ['00100', '01100', '00100', '00100', '00100', '00100', '01110'],
  2: ['01110', '10001', '00001', '00010', '00100', '01000', '11111'],
  3: ['11111', '00010', '00100', '00010', '00001', '10001', '01110'],
  4: ['00010', '00110', '01010', '10010', '11111', '00010', '00010'],
  5: ['11111', '10000', '11110', '00001', '00001', '10001', '01110'],
  6: ['00110', '01000', '10000', '11110', '10001', '10001', '01110'],
  7: ['11111', '00001', '00010', '00100', '01000', '01000', '01000'],
  8: ['01110', '10001', '10001', '01110', '10001', '10001', '01110'],
  9: ['01110', '10001', '10001', '01111', '00001', '00010', '01100']
};

function fillRect(img, x0, y0, w, h, r, g, b, a) {
  const x1 = Math.max(0, Math.min(img.width, x0 + w));
  const y1 = Math.max(0, Math.min(img.height, y0 + h));
  const sx = Math.max(0, x0);
  const sy = Math.max(0, y0);
  for (let y = sy; y < y1; y++) {
    let i = (y * img.width + sx) * 4;
    for (let x = sx; x < x1; x++, i += 4) {
      if (a >= 255) {
        img.rgba[i] = r;
        img.rgba[i + 1] = g;
        img.rgba[i + 2] = b;
      } else {
        const k = a / 255;
        img.rgba[i] = img.rgba[i] * (1 - k) + r * k;
        img.rgba[i + 1] = img.rgba[i + 1] * (1 - k) + g * k;
        img.rgba[i + 2] = img.rgba[i + 2] * (1 - k) + b * k;
      }
      img.rgba[i + 3] = 255;
    }
  }
}

/** Vẽ chuỗi chữ số (chỉ 0-9) với nền tối để đọc được trên mọi nền. */
function drawNumber(img, value, x, y, scale = 3) {
  const text = String(value);
  const gw = 5 * scale;
  const gh = 7 * scale;
  const pad = 3;
  fillRect(img, x - pad, y - pad, text.length * (gw + scale) + pad * 2, gh + pad * 2, 0, 0, 0, 235);
  for (let i = 0; i < text.length; i++) {
    const glyph = FONT[text[i]];
    if (!glyph) continue;
    const gx = x + i * (gw + scale);
    for (let ry = 0; ry < 7; ry++) {
      for (let rx = 0; rx < 5; rx++) {
        if (glyph[ry][rx] === '1') {
          fillRect(img, gx + rx * scale, y + ry * scale, scale, scale, 255, 255, 255, 255);
        }
      }
    }
  }
}

/**
 * Vẽ lưới tọa độ lên khung hình đã giải mã.
 * @param {{width:number,height:number,rgba:Uint8Array}} img
 * @param {{step?: number, quant?: number}} opts
 * @returns {{png: Buffer, width: number, height: number, step: number}}
 */
export function renderGrid(img, opts = {}) {
  const step = opts.step || 100;
  const w = img.width;
  const h = img.height;

  // Đường dọc (x) và ngang (y) — mảnh, màu đỏ cam, bán trong suốt để không che UI.
  for (let x = step; x < w; x += step) {
    const major = x % (step * 2) === 0;
    fillRect(img, x, 0, major ? 2 : 1, h, 255, 60, 40, major ? 150 : 80);
  }
  for (let y = step; y < h; y += step) {
    const major = y % (step * 2) === 0;
    fillRect(img, 0, y, w, major ? 2 : 1, 255, 60, 40, major ? 150 : 80);
  }

  // Nhãn số: cạnh trên = X, cạnh trái = Y (đọc theo lưới tuyệt đối).
  // Nhãn dày (mỗi step) vì model nhắm theo nhãn gần nhất — nhãn thưa làm sai ~100px.
  const scale = 3;
  const gh = 7 * scale;
  for (let x = step; x < w - 70; x += step) drawNumber(img, x, x, 6, scale);
  for (let y = step; y < h - gh - 10; y += step) drawNumber(img, y, 6, y, scale);

  // Góc trên-trái = 0,0 để model không lẫn gốc toạ độ.
  drawNumber(img, '0', 6, 6 + gh + 6, scale);

  return { png: encodePng(w, h, img.rgba, opts.quant || 0), width: w, height: h, step };
}

/** Bọc lại từ buffer PNG (dùng cho script thử nghiệm). */
export function drawGrid(pngBuffer, opts = {}) {
  const img = decodePng(pngBuffer);
  if (!img) return null;
  return renderGrid(img, opts);
}

/**
 * Chuẩn bị ảnh cho 1 bước: đọc PNG gốc -> khung pixel GỐC (cho phân tích pixel)
 * -> (tuỳ chọn) vẽ lưới lên bản SAO -> đường dẫn file gửi model.
 * Khung pixel KHÔNG được chứa lưới, nếu không so sánh 2 khung hình sẽ toàn ra "lưới đổi".
 *
 * @param {string} pngPath ảnh PNG vừa chụp
 * @param {{grid?: boolean, step?: number, quant?: number, gridPath?: string}} opts
 * @returns {Promise<{path: string, frame: {w:number,h:number,rgba:Uint8Array}|null,
 *                    width: number, height: number}>}
 */
export async function prepareShot(pngPath, opts = {}) {
  let buf;
  try {
    buf = await fs.readFile(pngPath);
  } catch {
    return { path: pngPath, frame: null, width: 0, height: 0 };
  }
  const img = decodePng(buf);
  if (!img) return { path: pngPath, frame: null, width: 0, height: 0 };

  // bản sao pixel gốc -> dùng để phân tích; renderGrid sẽ vẽ lên `img`.
  const frame = { w: img.width, h: img.height, rgba: img.rgba.slice() };

  let outPath = pngPath;
  if (opts.grid) {
    try {
      const g = renderGrid(img, { step: opts.step, quant: opts.quant });
      outPath = opts.gridPath || pngPath.replace(/\.[^.]+$/, '.grid.png');
      await fs.writeFile(outPath, g.png);
    } catch {
      outPath = pngPath;
    }
  }
  return { path: outPath, frame, width: img.width, height: img.height };
}
