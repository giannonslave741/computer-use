import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { buildPrompt, findActions } from '../brain.js';

const MAX_TOKENS = 512;

export function chatCompletionsUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!trimmed) throw new Error('Thiếu base URL. Đặt --base-url hoặc CUA_BASE_URL.');
  if (trimmed.endsWith('/chat/completions')) return trimmed;
  return `${trimmed}/chat/completions`;
}

function mimeOf(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

export function messageText(data) {
  const choice = data?.choices?.[0];
  const msg = choice?.message;
  if (!msg) return '';
  const content = msg.content;
  if (typeof content === 'string' && content.trim()) return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  const reasoning = msg.reasoning || msg.reasoning_content || choice?.reasoning;
  return typeof reasoning === 'string' ? reasoning : '';
}

export function maxTokensRejected(status, body) {
  if (status !== 400 && status !== 422) return false;
  if (!/max_tokens/i.test(body)) return false;
  return /max_completion_tokens|unsupported|not supported|unknown|unrecognized|invalid|unexpected|extra/i.test(body);
}

function requestBody(model, prompt, dataUrl, tokenField) {
  return {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl } }
        ]
      }
    ],
    stream: false,
    [tokenField]: MAX_TOKENS
  };
}

async function postChat(url, body, signal) {
  const headers = { 'Content-Type': 'application/json' };
  if (config.openai.apiKey) headers.Authorization = `Bearer ${config.openai.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal
  });
  const text = await res.text();
  return { status: res.status, ok: res.ok, text };
}

function clip(text) {
  return String(text || '').replace(/\s+/g, ' ').slice(0, 400);
}

export async function askOpenai({ goal, step, img, history }) {
  if (!config.model) throw new Error('Thiếu model. Đặt --model theo tên model của endpoint.');
  if (!img?.path) throw new Error('Không có file ảnh để gửi.');

  const url = chatCompletionsUrl(config.openai.baseUrl);
  const bytes = await fs.readFile(img.path);
  const dataUrl = `data:${mimeOf(img.path)};base64,${bytes.toString('base64')}`;
  const prompt = buildPrompt({ goal, step, img, history });
  const signal = AbortSignal.timeout(config.requestTimeoutMs);

  const started = Date.now();
  const post = (tokenField) =>
    postChat(url, requestBody(config.model, prompt, dataUrl, tokenField), signal).catch((err) => {
      if (err?.name === 'TimeoutError' || err?.name === 'AbortError') {
        throw new Error(`Vision hết thời gian sau ${config.requestTimeoutMs}ms`);
      }
      throw err;
    });
  let sent = await post('max_tokens');
  if (maxTokensRejected(sent.status, sent.text)) {
    sent = await post('max_completion_tokens');
  }
  const durationMs = Date.now() - started;

  if (!sent.ok) {
    throw new Error(`Vision HTTP ${sent.status}: ${clip(sent.text) || 'không có nội dung'}`);
  }

  let data;
  try {
    data = JSON.parse(sent.text);
  } catch {
    throw new Error(`Vision trả về không phải JSON: ${clip(sent.text)}`);
  }

  const text = messageText(data);
  const actions = findActions(text) || [{ action: 'wait', ms: 2000, _parseFailed: true }];
  return { actions, raw: text, durationMs, sessionId: null };
}
