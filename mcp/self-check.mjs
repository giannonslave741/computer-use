import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: process.execPath,
  args: ['mcp/server.mjs'],
  cwd: process.cwd(),
  stderr: 'pipe'
});
const client = new Client({ name: 'computer-use-self-check', version: '1.0.0' });
await client.connect(transport);

const listed = await client.listTools();
const names = listed.tools.map((tool) => tool.name).sort();
const want = [
  'click',
  'drag',
  'hold',
  'hotkey',
  'move',
  'press',
  'screenshot',
  'scroll',
  'type',
  'window_activate',
  'window_list'
];
for (const name of want) {
  if (!names.includes(name)) throw new Error(`thiếu tool ${name}: ${names.join(',')}`);
}

const windows = await client.callTool({ name: 'window_list', arguments: {} });
const windowText = windows.content?.find((part) => part.type === 'text')?.text || '';
if (!windowText.includes('WINDOWS')) throw new Error(`window_list không có danh sách: ${windowText.slice(0, 180)}`);

const shot = await client.callTool({ name: 'screenshot', arguments: {} });
const parts = shot.content || [];
const meta = JSON.parse(parts.find((part) => part.type === 'text')?.text || '{}');
const image = parts.find((part) => part.type === 'image');
if (!meta.width || !meta.height) throw new Error(`screenshot thiếu kích thước: ${JSON.stringify(meta)}`);
if (!image || image.mimeType !== 'image/jpeg' || !image.data) throw new Error('screenshot không trả JPEG');

const activated = await client.callTool({
  name: 'window_activate',
  arguments: { process: 'Cursor.exe' }
});
const activatedText = activated.content?.find((part) => part.type === 'text')?.text || '';
if (!activatedText.includes('reobserve')) throw new Error(`window_activate không yêu cầu chụp lại: ${activatedText.slice(0, 240)}`);

const blocked = await client.callTool({ name: 'click', arguments: { x: 1, y: 1 } });
const blockedText = blocked.content?.find((part) => part.type === 'text')?.text || '';
if (!blocked.isError || !blockedText.includes('REOBSERVE_REQUIRED')) {
  throw new Error(`click sau activate phải bị chặn, chưa được gửi: ${blockedText.slice(0, 240)}`);
}

console.log(`tools ${names.length}`);
console.log(`screenshot ${meta.width}x${meta.height} jpeg ${image.data.length} chars`);
console.log('window_list ok, click sau window_activate bị chặn cho tới screenshot');
await client.close();
process.exit(0);
