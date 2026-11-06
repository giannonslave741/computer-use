import { findActions, buildPrompt } from './brain.js';
import { chatCompletionsUrl, messageText, maxTokensRejected } from './providers/openai.js';

const cases = [
  '[{"action":"click","x":500,"y":300}]',
  'Sorry, [{ "action":"type", text:"hi" }]',
  '```json\n[{"action":"press","key":"ENTER"}]\n```',
  '{"action":"wait","ms":500}',
  '[{"action":"click","x":1,"y":2},{"action":"type","text":"a"},{"action":"bogus"},{"action":"done","reason":"x"}]',
  'nothing here'
];

for (const c of cases) {
  console.log(JSON.stringify(c.slice(0, 45)), '=>', JSON.stringify(findActions(c)));
}

const p = buildPrompt({ goal: 'test', step: 1, img: { width: 1920, height: 1080 }, history: {} });
console.log('prompt head/tail:', JSON.stringify(p.slice(0, 60)), '...', JSON.stringify(p.slice(-40)));

const urls = [
  ['https://api.openai.com/v1', 'https://api.openai.com/v1/chat/completions'],
  ['http://127.0.0.1:11434/v1/', 'http://127.0.0.1:11434/v1/chat/completions'],
  ['https://host/v1/chat/completions', 'https://host/v1/chat/completions']
];
for (const [input, want] of urls) {
  const got = chatCompletionsUrl(input);
  if (got !== want) throw new Error(`URL ${input} -> ${got}, expected ${want}`);
}
const fromParts = messageText({
  choices: [{ message: { content: [{ type: 'text', text: '[{"action":"wait","ms":1}]' }] } }]
});
if (!findActions(fromParts)) throw new Error('could not read array-shaped content');
const fromReason = messageText({
  choices: [{ message: { content: '', reasoning: '[{"action":"done","reason":"x"}]' } }]
});
if (!findActions(fromReason)) throw new Error('could not read reasoning when content is empty');
if (!maxTokensRejected(400, 'max_tokens is unsupported, use max_completion_tokens')) {
  throw new Error('did not recognize a max_tokens error');
}
if (maxTokensRejected(401, 'max_tokens invalid key')) throw new Error('a 401 must not swap the token field');
console.log('provider checks: ok');
