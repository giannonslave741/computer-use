import { findActions, buildPrompt } from './brain.js';

const cases = [
  '[{"action":"click","x":500,"y":300}]',
  'Xin lỗi, [{ "action":"type", text:"hi" }]',
  '```json\n[{"action":"press","key":"ENTER"}]\n```',
  '{"action":"wait","ms":500}',
  '[{"action":"click","x":1,"y":2},{"action":"type","text":"a"},{"action":"bogus"},{"action":"done","reason":"x"}]',
  'không có gì ở đây'
];

for (const c of cases) {
  console.log(JSON.stringify(c.slice(0, 45)), '=>', JSON.stringify(findActions(c)));
}

const p = buildPrompt({ goal: 'test', step: 1, img: { width: 1920, height: 1080 }, history: {} });
console.log('prompt đầu/cuối:', JSON.stringify(p.slice(0, 60)), '...', JSON.stringify(p.slice(-40)));
