import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import screenshot from 'screenshot-desktop';
import { config } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function readPngSize(buf) {
  if (buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
}

function readJpegSize(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 <= buf.length) {
    if (buf[offset] !== 0xff) {
      offset++;
      continue;
    }
    const marker = buf[offset + 1];
    if (marker === 0xff) {
      offset++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break;
    const length = buf.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
        format: 'jpeg'
      };
    }
    offset += 2 + length;
  }
  return null;
}

export function readImageSize(buf) {
  return readPngSize(buf) || readJpegSize(buf);
}

async function waitForFile(filePath, tries = 10, delayMs = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.size > 0) return stat.size;
    } catch {
      /* file does not exist yet */
    }
    await new Promise((res) => setTimeout(res, delayMs));
  }
  return 0;
}

/**
 * Capture the screen.
 * @param {{format?: 'png'|'jpg'}} [opts] 'png' keeps real pixels for analysis;
 *   otherwise the extension of config.screenshotPath is used (tloop/run_actions still use jpg).
 */
export async function takeScreenShot(opts = {}) {
  const basePath = path.isAbsolute(config.screenshotPath)
    ? config.screenshotPath
    : path.join(__dirname, config.screenshotPath);

  let outputPath = basePath;
  let format = path.extname(basePath).toLowerCase().replace('.', '') === 'png' ? 'png' : 'jpg';
  if (opts.format) {
    format = opts.format === 'png' ? 'png' : 'jpg';
    outputPath = basePath.replace(/\.[^.]+$/, `.${format}`);
  }

  await fs.mkdir(path.dirname(outputPath), { recursive: true });

  await screenshot({ filename: outputPath, format });

  const bytes = await waitForFile(outputPath);
  if (!bytes) throw new Error(`Screenshot was not written to disk: ${outputPath}`);

  const buf = await fs.readFile(outputPath);
  const size = readImageSize(buf);
  if (!size) {
    const head = buf.subarray(0, 4).toString('hex');
    throw new Error(`Could not read the image size (header=0x${head}, ${buf.length} bytes)`);
  }

  return { path: outputPath, width: size.width, height: size.height, bytes: buf.length };
}
