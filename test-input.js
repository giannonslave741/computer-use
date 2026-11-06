import { mouse, screen, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';
import { resolveBackend } from './backends.js';

const args = process.argv.slice(2);
for (const a of args) {
  if (a.startsWith('--backend=')) config.inputBackend = a.split('=')[1];
}
const noType = args.includes('--no-type');

if (args.includes('--devices')) {
  const { init, listDevices } = await import('./interception.js');
  try {
    init();
    console.table(listDevices());
  } catch (err) {
    console.error('Không liệt kê được thiết bị:', err.message);
    process.exit(1);
  }
  process.exit(0);
}

const backend = await resolveBackend();
console.log(`Backend đang dùng: ${backend.name}`);
if (backend.name === 'nutjs') {
  console.log('  -> Driver Interception chưa hoạt động, lệnh sẽ đi qua SendInput.');
  console.log('     Cài driver:  npm run setup-driver   (cần quyền Admin)');
}
console.log('');

const cur = async () => {
  const p = await mouse.getPosition();
  return `(${p.x}, ${p.y})`;
};

const step = async (label, fn) => {
  process.stdout.write(`  ${label} ... `);
  try {
    await fn();
    console.log('OK');
  } catch (err) {
    console.log(`LỖI: ${err.message}`);
  }
};

console.log('Trong 6 giây hãy làm:');
console.log('  1. Mở Notepad, kéo cửa sổ vào GIỮA màn hình.');
console.log('  2. Click vào vùng soạn thảo của Notepad.');
console.log('  3. Đừng chạm chuột/phím cho đến khi script chạy xong.');
console.log('');
for (let i = 6; i > 0; i--) {
  process.stdout.write(`  ... ${i}\r`);
  await sleep(1000);
}
console.log('');

const width = await screen.width();
const height = await screen.height();
const cx = Math.round(width / 2);
const cy = Math.round(height / 2);

await step(`di chuyển chuột về giữa (${cx}, ${cy})`, async () => {
  await backend.moveTo(cx, cy);
  await sleep(150);
  console.log(`\n      con trỏ thật: ${await cur()}`);
});

await step('click chuột trái (gọi)', async () => {
  await backend.click('left', false);
  await sleep(150);
  console.log(`\n      con trỏ thật: ${await cur()}`);
});

if (!noType) {
  await step('gõ chữ "cua-test 123"', async () => {
    await backend.typeText('cua-test 123');
    await sleep(200);
  });
  await step('phím Enter', async () => {
    await backend.pressKey('enter');
    await sleep(150);
  });
  await step('phím x', async () => {
    await backend.pressKey('x');
    await sleep(150);
  });
  await step('hotkey Ctrl+A', async () => {
    await backend.hotkey(['control', 'a']);
    await sleep(200);
  });
  await step('phím End (bỏ chọn)', async () => {
    await backend.pressKey('end');
    await sleep(150);
  });
} else {
  console.log('  (bỏ qua gõ chữ theo --no-type)');
}

await step('cuộn xuống 3 nấc / lên 3 nấc', async () => {
  await backend.scroll('down', 3);
  await sleep(200);
  await backend.scroll('up', 3);
  await sleep(200);
});

await step(`di chuyển chuột về góc (60, 60)`, async () => {
  await backend.moveTo(60, 60);
  await sleep(150);
  console.log(`\n      con trỏ thật: ${await cur()}`);
});

console.log('');
if (backend.name === 'interception') {
  console.log('Nếu chữ "cua-test 123" hiện trong Notepad và chuột chạy đúng -> Interception hoạt động.');
  console.log('Nếu sai vị trí chuột/gõ không hiện -> đổi thiết bị trong config.interception (keyboard/mouse).');
} else {
  console.log('Đang ở chế độ nut-js (SendInput). Cài driver rồi chạy lại: npm run setup-driver && npm run test-input');
}
process.exit(0);
