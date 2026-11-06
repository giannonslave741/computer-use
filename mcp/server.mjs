import './stdio-guard.mjs';
import fs from 'node:fs/promises';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { screen } from '@nut-tree-fork/nut-js';
import { takeScreenShot } from '../capture.js';
import {
  executeActions,
  setCoordinateMap,
  acknowledgeReobserve
} from '../executor.js';
import * as wm from '../windows.js';

const server = new McpServer({ name: 'computer-use', version: '1.0.0' });

function foregroundBrief() {
  try {
    const f = wm.describeForeground();
    if (!f) return null;
    return {
      title: f.title,
      process: f.processName,
      hwnd: f.hwnd,
      minimized: f.minimized
    };
  } catch {
    return null;
  }
}

function toolResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload) }],
    isError: Boolean(payload.blocked)
  };
}

async function run(action) {
  const result = await executeActions([action]);
  return toolResult({ ...result, foreground: foregroundBrief() });
}

function windowTarget(args) {
  if (typeof args.hwnd === 'number') return { hwnd: args.hwnd };
  if (args.process) return { process: args.process };
  if (args.titleContains) return { titleContains: args.titleContains };
  if (args.target) return args.target;
  throw new Error('Cần target, process, hwnd hoặc titleContains.');
}

const windowFields = {
  target: z.string().optional().describe('Tên cửa sổ, ví dụ "Google Chrome".'),
  process: z.string().optional().describe('Tên file tiến trình, ví dụ chrome.exe.'),
  hwnd: z.number().optional().describe('HWND đã biết.'),
  titleContains: z.string().optional().describe('Một phần title cửa sổ.')
};

server.registerTool(
  'screenshot',
  {
    description:
      'Chụp màn hình chính và trả ảnh JPEG. Gọi tool này sau window_activate, và trước click/type nếu cửa sổ vừa đổi. Tọa độ các tool sau là pixel trên ảnh này, góc trên-trái = 0,0.'
  },
  async () => {
    const img = await takeScreenShot();
    const screenW = await screen.width();
    const screenH = await screen.height();
    setCoordinateMap(screenW / img.width, screenH / img.height, img.width, img.height);
    acknowledgeReobserve();
    const buf = await fs.readFile(img.path);
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            width: img.width,
            height: img.height,
            screen: { width: screenW, height: screenH },
            foreground: foregroundBrief()
          })
        },
        { type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' }
      ]
    };
  }
);

server.registerTool(
  'window_list',
  { description: 'Liệt kê cửa sổ đang mở và cửa sổ foreground. Không gửi phím hay chuột.' },
  async () => {
    return toolResult({ windows: wm.formatWindowList({ max: 15 }), foreground: foregroundBrief() });
  }
);

server.registerTool(
  'window_activate',
  {
    description:
      'Đưa một cửa sổ lên foreground bằng Windows API. Sau tool này phải gọi screenshot trước khi click, type, press, hotkey, scroll hoặc drag.',
    inputSchema: windowFields
  },
  async (args) => run({ action: 'window_activate', target: windowTarget(args) })
);

server.registerTool(
  'click',
  {
    description: 'Click một điểm. Tọa độ là pixel trên ảnh screenshot gần nhất.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'right', 'middle']).optional(),
      double: z.boolean().optional()
    }
  },
  async (args) =>
    run({
      action: 'click',
      x: args.x,
      y: args.y,
      button: args.button || 'left',
      double: Boolean(args.double)
    })
);

server.registerTool(
  'move',
  {
    description: 'Đưa chuột tới một điểm, không click.',
    inputSchema: { x: z.number(), y: z.number() }
  },
  async (args) => run({ action: 'move', x: args.x, y: args.y })
);

server.registerTool(
  'type',
  {
    description: 'Gõ chữ vào ô đang focus. Click vào ô đó trước.',
    inputSchema: { text: z.string() }
  },
  async (args) => run({ action: 'type', text: args.text })
);

server.registerTool(
  'press',
  {
    description: 'Bấm một phím, ví dụ ENTER, ESC, F11, W.',
    inputSchema: { key: z.string() }
  },
  async (args) => run({ action: 'press', key: args.key })
);

server.registerTool(
  'hold',
  {
    description: 'Giữ một phím trong ms mili-giây rồi nhả. Dùng cho di chuyển trong game.',
    inputSchema: { key: z.string(), ms: z.number() }
  },
  async (args) => run({ action: 'hold', key: args.key, ms: args.ms })
);

server.registerTool(
  'hotkey',
  {
    description: 'Bấm tổ hợp phím, ví dụ ["CTRL","L"].',
    inputSchema: { keys: z.array(z.string()).min(1) }
  },
  async (args) => run({ action: 'hotkey', keys: args.keys })
);

server.registerTool(
  'scroll',
  {
    description: 'Cuộn tại vị trí chuột hiện tại.',
    inputSchema: {
      direction: z.enum(['up', 'down']),
      amount: z.number().optional()
    }
  },
  async (args) => run({ action: 'scroll', direction: args.direction, amount: args.amount ?? 3 })
);

server.registerTool(
  'drag',
  {
    description: 'Kéo từ điểm này tới điểm kia. Tọa độ là pixel trên ảnh screenshot.',
    inputSchema: {
      fromX: z.number(),
      fromY: z.number(),
      toX: z.number(),
      toY: z.number()
    }
  },
  async (args) =>
    run({
      action: 'drag',
      from: { x: args.fromX, y: args.fromY },
      to: { x: args.toX, y: args.toY }
    })
);

const transport = new StdioServerTransport();
await server.connect(transport);
