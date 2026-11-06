import { Key } from '@nut-tree-fork/nut-js';

export const ALIAS = {
  enter: 'enter',
  ret: 'enter',
  return: 'enter',
  esc: 'escape',
  escape: 'escape',
  ctrl: 'control',
  control: 'control',
  del: 'delete',
  delete: 'delete',
  spacebar: 'space',
  space: 'space',
  cmd: 'cmd',
  win: 'win',
  windows: 'win',
  meta: 'meta',
  super: 'super',
  altgr: 'rightalt',
  pageup: 'pageup',
  pgup: 'pageup',
  pagedown: 'pagedown',
  pgdn: 'pagedown',
  pagedn: 'pagedown',
  ins: 'insert',
  back: 'backspace',
  leftarrow: 'left',
  rightarrow: 'right',
  uparrow: 'up',
  downarrow: 'down',
  printscreen: 'print',
  prtsc: 'print',
  apps: 'menu'
};

const NUT_BY_NAME = (() => {
  const map = {};
  for (const [name, value] of Object.entries(Key)) {
    if (typeof value !== 'number' || /^[0-9]+$/.test(name)) continue;
    const lower = name.toLowerCase();
    if (!(lower in map)) map[lower] = value;
    const base = lower.replace(/^(left|right)/, '');
    if (base && !(base in map)) map[base] = value;
  }
  return map;
})();

export function resolveKeyName(name) {
  const raw = String(name ?? '').trim().toLowerCase();
  if (!raw) throw new Error('Missing key name');
  return ALIAS[raw] || raw;
}

export function resolveNutKey(name) {
  const canonical = resolveKeyName(name);
  const key =
    NUT_BY_NAME[canonical] ?? NUT_BY_NAME[`left${canonical}`] ?? NUT_BY_NAME[`right${canonical}`];
  if (key === undefined) throw new Error(`Invalid key: ${name}`);
  return key;
}
