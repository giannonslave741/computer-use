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
  throw new Error('Need target, process, hwnd, or titleContains.');
}

const windowFields = {
  target: z.string().optional().describe('Window name, for example "Google Chrome".'),
  process: z.string().optional().describe('Process file name, for example chrome.exe.'),
  hwnd: z.number().optional().describe('Known HWND.'),
  titleContains: z.string().optional().describe('Part of the window title.')
};

server.registerTool(
  'screenshot',
  {
    description:
      'Capture the primary screen and return a JPEG. Call this after window_activate, and before click or type if the window just changed. Later coordinates are pixels on this image. Top-left is 0,0.'
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
  { description: 'List open windows and the foreground window. Does not send keys or mouse input.' },
  async () => {
    return toolResult({ windows: wm.formatWindowList({ max: 15 }), foreground: foregroundBrief() });
  }
);

server.registerTool(
  'window_activate',
  {
    description:
      'Raise a window with the Windows API. After this tool, call screenshot before click, type, press, hotkey, scroll, or drag.',
    inputSchema: windowFields
  },
  async (args) => run({ action: 'window_activate', target: windowTarget(args) })
);

server.registerTool(
  'click',
  {
    description: 'Click a point. Coordinates are pixels on the latest screenshot.',
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
    description: 'Move the pointer to a point without clicking.',
    inputSchema: { x: z.number(), y: z.number() }
  },
  async (args) => run({ action: 'move', x: args.x, y: args.y })
);

server.registerTool(
  'type',
  {
    description: 'Type into the focused field. Click that field first.',
    inputSchema: { text: z.string() }
  },
  async (args) => run({ action: 'type', text: args.text })
);

server.registerTool(
  'press',
  {
    description: 'Press one key, for example ENTER, ESC, F11, or W.',
    inputSchema: { key: z.string() }
  },
  async (args) => run({ action: 'press', key: args.key })
);

server.registerTool(
  'hold',
  {
    description: 'Hold a key for ms milliseconds, then release it. Used to move in a game.',
    inputSchema: { key: z.string(), ms: z.number() }
  },
  async (args) => run({ action: 'hold', key: args.key, ms: args.ms })
);

server.registerTool(
  'hotkey',
  {
    description: 'Press a key combination, for example ["CTRL","L"].',
    inputSchema: { keys: z.array(z.string()).min(1) }
  },
  async (args) => run({ action: 'hotkey', keys: args.keys })
);

server.registerTool(
  'scroll',
  {
    description: 'Scroll at the current pointer position.',
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
    description: 'Drag from one point to another. Coordinates are pixels on the screenshot.',
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
