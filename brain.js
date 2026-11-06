import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { execa } from 'execa';
import { config } from './config.js';

let cachedCmd;

function findRealExeFromShim(shimPath) {
  try {
    const content = fs.readFileSync(shimPath, 'utf8');
    const match = content.match(/"([^"]+\.exe)"/i);
    if (match && fs.existsSync(match[1])) return match[1];
  } catch {
    /* bỏ qua */
  }
  return null;
}

function resolveOpenCodeCmd() {
  if (cachedCmd) return cachedCmd;
  const explicit = config.opencodeCmd;
  if (explicit && explicit !== 'opencode') {
    cachedCmd = explicit;
    return cachedCmd;
  }

  try {
    const out = execSync('where opencode', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

    const exe = lines.find((s) => s.toLowerCase().endsWith('.exe') && fs.existsSync(s));
    if (exe) {
      cachedCmd = exe;
      return cachedCmd;
    }
    for (const line of lines) {
      if (line.toLowerCase().endsWith('.cmd') || line.toLowerCase().endsWith('.bat')) {
        const real = findRealExeFromShim(line);
        if (real) {
          cachedCmd = real;
          return cachedCmd;
        }
      }
    }
  } catch {
    /* where thất bại -> thử ứng viên mặc định */
  }

  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'opencode', 'opencode.exe'),
    'C:\\Program Files\\nodejs\\node_modules\\opencode-ai\\bin\\opencode.exe'
  ];
  cachedCmd = candidates.find((c) => c && fs.existsSync(c)) || 'opencode';
  return cachedCmd;
}

const SESSION_FILE = path.join(process.cwd(), config.sessionFile);

export function loadSessionState() {
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    return { sessionId: data.sessionId || null, calls: Number(data.calls) || 0 };
  } catch {
    return { sessionId: null, calls: 0 };
  }
}

export function saveSessionState(state) {
  fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
}

async function cli(args) {
  return execa(resolveOpenCodeCmd(), args, {
    reject: false,
    timeout: 60000,
    windowsHide: true,
    cwd: process.cwd()
  });
}

export async function deleteSession(sessionId) {
  if (!sessionId) return false;
  const r = await cli(['session', 'delete', sessionId]);
  if (r.exitCode === 0) console.log(`    Đã xóa session cũ: ${sessionId}`);
  return r.exitCode === 0;
}

export async function listSessions() {
  const r = await cli(['session', 'list']);
  if (r.exitCode !== 0) return [];
  const sessions = [];
  for (const line of (r.stdout || '').split(/\r?\n/)) {
    const m = line.match(/^(ses_\S+)\s+(.*?)\s{2,}\S/);
    if (m) sessions.push({ id: m[1], title: m[2].trim() });
  }
  return sessions;
}

export async function cleanupCuaSessions(keepId) {
  const sessions = await listSessions();
  let removed = 0;
  for (const s of sessions) {
    if (s.title.startsWith('CUA') && s.id !== keepId) {
      const r = await cli(['session', 'delete', s.id]);
      if (r.exitCode === 0) {
        removed++;
        console.log(`    Xóa session CUA thừa: ${s.id} (${s.title.slice(0, 40)})`);
      }
    }
  }
  if (removed) console.log(`    Đã dọn ${removed} session CUA thừa.`);
  return removed;
}

export function buildPrompt({ goal, step, img, history }) {
  const gridNote = img.grid
    ? `\n\nẢnh NÀY ĐÃ ĐƯỢC VẼ LƯỚI TỌA ĐỘ: số ghi trên cạnh TRÊN là x, số ghi bên TRÁI là y, mỗi ô = ${config.gridStep}px.\nKHÔNG ĐƯỢC ước lượng bằng mắt (sai hàng trăm px). PHẢI đọc 2 số lưới kề điểm cần nhắm rồi nội suy trong ô ${config.gridStep}px đó.`
    : '';
  return `Bạn là Computer Use Agent điều khiển máy tính qua ảnh chụp màn hình (${img.width}x${img.height} pixel, góc trên trái = 0,0).${gridNote}

MỤC TIÊU: ${goal || 'Chưa đặt mục tiêu. Hãy quan sát và chờ.'}
Bước số: ${step}
Chuỗi hành động trước đó: ${history.lastAction || 'chưa có'}

CỬA SỔ FOREGROUND HIỆN TẠI (lấy bằng Windows API, không phải suy đoán):
${history.foreground || '(chưa lấy được)'}

DANH SÁCH CỬA SỔ ĐANG MỞ:
${history.windows || '(chưa lấy được)'}

${history.analysis ? `PHÂN TÍCH PIXEL TỰ ĐỘNG CỦA HỆ THỐNG (máy tự đo bằng pixel, KHÔNG phải suy đoán — phải tin và làm theo):\n${history.analysis}\n` : ''}
${history.stagnation ? `CẢNH BÁO STAGNATION:\n${history.stagnation}\n` : ''}
${history.blocked ? `TRẠNG THÁI LỖI CỬA SỔ LẦN TRƯỚC:\n${history.blocked}\n(CHưa activate được cửa sổ -> input đang bị executor chặn. Phải tìm đúng cửa sổ qua window_list rồi window_activate lại, KHÔNG được click tọa độ.)\n` : ''}
=========================================================
QUY TẮC VỀ CỬA SỔ — ĐỌC TRƯỚC MỌI QUY TẮC VỀ TỌA ĐỘ
=========================================================

QUY TẮC 0 — WINDOW FIRST
Trước khi click/type/press/hotkey vào một ứng dụng cụ thể:
  - PHẢI xác định cửa sổ đích là cửa sổ nào.
  - Nếu cửa sổ đích chưa foreground, hoặc bạn không chắc nó có đang ở trên cùng không:
    KHÔNG được click tọa độ. Phải dùng window_activate trước.
  - Sau window_activate/window_restore/show_desktop/window_minimize:
    phải QUAN SÁT LẠI screenshot mới, rồi mới tính tọa độ.

QUY TẮC 1 — KHÔNG CLICK XUYÊN QUA CỬA SỔ
"Một click tọa độ màn hình LUÔN tác động lên cửa sổ nằm TRÊN CÙNG tại tọa độ đó,
không phải cửa sổ mà bạn nhìn thấy phía sau."
Ảnh chụp screen CHỈ thể hiện cửa sổ ĐANG Ở TRÊN (foreground) đúng nhất.
Nếu Chrome đang foreground và mục tiêu thuộc Explorer phía sau:
  SAI:  [{"action":"click","x":500,"y":350}]
  ĐÚNG: [{"action":"window_activate","target":"File Explorer"}]
        -> screenshot mới -> [{"action":"click","x":...,"y":...}]

QUY TẮC 2 — ACTIVATE TRƯỚC KHI INPUT
Nếu target application chưa foreground -> window_activate trước.
Thứ tự ưu tiên chuyển cửa sổ:
  1. window_activate (Windows API, chọn HWND chính xác)
  2. window_restore (cửa sổ đang minimize)
  3. taskbar_activate (CHỈ KHI window_activate không tìm được cửa sổ)
  4. click icon taskbar (CHỈ khi không có HWND hợp lệ - phương án cuối cùng)

QUY TẮC 3 — QUAN SÁT LẠI SAU ACTIVATION
KHÔNG được gộp window_activate + click trong CÙNG một mảng.
Chuỗi hợp lệ:
  bước A: [{"action":"window_activate","target":"File Explorer"}]
  -> screenshot mới ->
  bước B: [{"action":"click","x":...,"y":...}]
(executor sẽ tự BỎ QUA các action click/type/press nếu đi sau window_* trong cùng mảng,
 và trả về REOBSERVE_REQUIRED).

QUY TẮC 4 — DESKTOP
Nếu mục tiêu là desktop background / icon desktop / menu chuột phải desktop:
  - Nếu desktop đang bị cửa sổ che: [{"action":"show_desktop"}] trước.
  - screenshot lại -> mới tính tọa độ desktop -> click.
  - TUYỆT ĐỐI không lấy tọa độ desktop từ ảnh đang bị cửa sổ che rồi click.

QUY TẮC 5 — KHÔNG CLICK MÙ TASKBAR
Không tìm icon trên taskbar nếu target window đã tồn tại và activate được bằng window_activate.
Taskbar chỉ là FALLBACK khi Window Manager không tìm thấy cửa sổ.

QUY TẮC 6 — VERIFY
Không coi activation là thành công nếu foreground verification thất bại.
Nếu kết quả trả về có "blocked": "WINDOW_ACTIVATE_FAILED" hoặc "FOREGROUND_CHANGED":
  → QUAN SÁT LẠI màn hình, kiểm tra lại cửa sổ đích, KHÔNG bấm tiếp tọa độ cũ.

QUY TẮC 7 — KHÔNG LẶP CLICK MÙ
Nếu click không thay đổi màn hình, KHÔNG được spam lại cùng tọa độ.
Thay vào đó: window_list -> xác định đúng cửa sổ -> window_activate -> screenshot mới.

QUY TẮC 8 — MUỐN GÕ THÌ PHẢI CLICK VÀO Ô NHẬP TRƯỚC
Mọi chuỗi chứa "type" vào một ô nhập (ô tìm kiếm, ô chat, ô đã mở sẵn):
  - PHẢI có "click" vào CHÍNH ô đó trong CÙNG chuỗi, và click đứng TRƯỚC "type".
  - SAI:  [{"action":"type","text":"lofi"}]                          (gõ mù, chữ rơi chỗ khác)
  - ĐÚNG: [{"action":"click","x":740,"y":355},{"action":"type","text":"lofi"},{"action":"press","key":"ENTER"}]
  - Nếu ô đang còn chữ cũ (dòng địa chỉ, ô tìm kiếm đã gõ dở):
    [{"action":"click","x":...},{"action":"hotkey","keys":["CTRL","A"]},{"action":"type","text":"..."},{"action":"press","key":"ENTER"}]
    để KHÔNG bị nối chữ cũ vào chữ mới.
  - Nếu sau khi gõ màn hình KHÔNG đổi (chữ không vào được): click lại ô tìm kiếm
    với tọa độ MỚI lấy từ screenshot, rồi mới gõ tiếp. TUYỆT ĐỐI không gõ tiếp
    vào chỗ trống và không lặp lại y hệt chuỗi cũ.

QUY TẮC 8b — CÓ THANH TÌM KIẾM THÌ DÙNG THANH TÌM KIẾM
Với trang web có ô tìm kiếm (YouTube, Google, Shopee...):
  - PHẢI gõ vào ô tìm kiếm để tìm nội dung.
  - TUYỆT ĐỐI KHÔNG scroll trang liên tục để "dò tìm" nội dung. Scroll chỉ để
    xem phần ĐÃ hiển thị, không phải cách tìm kiếm.
  - Mục tiêu "tìm nhạc/ video/ sản phẩm" nghĩa là: click ô tìm kiếm -> gõ -> ENTER.

QUY TẮC 9 — FULLSCREEN / VIDEO ĐANG PHÁT / GAME CHE TOÀN MÀN HÌNH
Khi dòng foreground có "fullscreen=YES", hoặc ẢNH KHÔNG thấy thanh địa chỉ,
thanh tab, thanh tiêu đề, taskbar của ứng dụng:
  - Nghĩa là ứng dụng đang ở chế độ che toàn màn hình. Lúc này CÁC UI BÌNH THƯỜNG
    (thanh tìm kiếm, nút mở tab, menu) KHÔNG tồn tại trên màn hình -> click vào
    tọa độ nào cũng không thấy ô tìm kiếm.
  - PHẢI THOÁT FULLSCREEN TRƯỚC:  [{"action":"press","key":"ESC"}]
    (với trình duyệt web còn có thể [{"action":"press","key":"F11"}]).
  - screenshot lại -> tới khi thấy thanh địa chỉ/thanh tìm kiếm -> mới thao tác.
  - TUYỆT ĐỐI KHÔNG double-click vào video/nội dung: double-click ở đây sẽ BẬT
    fullscreen (hoặc pause) thay vì tắt. Double-click CHỈ được dùng trên THANH TIÊU ĐỀ
    của cửa sổ khi muốn maximize/restore.
  - Nếu sau khi thoát fullscreen mà màn hình vẫn không thấy UI -> dùng
    window_activate lại rồi screenshot, KHÔNG lặp click lung tung.

QUY TẮC 10 — TIN KẾT QUẢ "PHÂN TÍCH PIXEL TỰ ĐỘNG"
Hệ thống tự đo bằng pixel, không phải suy đoán. Nếu phần đó báo:
  - "Màn hình SAU chuỗi: KHÔNG thay đổi"  -> chuỗi vừa rồi KHÔNG làm được gì.
    KHÔNG được lặp lại chuỗi đó (kể cả khi chỉ đổi 1-2 pixel). Phải đổi cách:
    nhắm lại điểm khác theo số trên lưới, hoặc window_activate -> screenshot -> làm lại.
  - "vùng đổi: (a,b)-(c,d)"                -> nhìn ĐÚNG vùng đó để xem có tác dụng gì.
  - "ĐIỂM (x,y) NẰM NGOÀI CỬA SỔ FOREGROUND / NGOÀI MÀN HÌNH" -> tọa độ sai, phải nhắm lại.
  - "CHUỘT THẬT ĐANG Ở (a,b) chứ không phải (x,y)" -> điểm click không trúng chỗ bạn nghĩ.

TOẠ ĐỘ LUÔN LÀ TỌA ĐỘ MÀN HÌNH TUYỆT ĐỐI
Ảnh chụp là màn hình đầy đủ (WxH). 0,0 = góc trên trái CỦA MÀN HÌNH, KHÔNG phải
góc cửa sổ. Không trừ trừ cộng cộng theo rect cửa sổ, không suy diễn theo kích thước
cửa sổ con — cứ đọc tọa độ pixel ngay trên ảnh.

CÁC TRẠNG THÁI EXECUTOR TRẢ VỀ (đọc để không lặp lại lỗi):
  WINDOW_ACTIVATE_FAILED  : không tìm/không activate được cửa sổ -> đổi cách tìm
  REOBSERVE_REQUIRED      : có window action trong chuỗi -> phải xem screenshot mới
  FOREGROUND_CHANGED      : cửa sổ đích bị đổi trước khi input -> activate lại
  STAGNATION              : lặp cùng chuỗi hành động -> đổi chiến lược
  TASKBAR_ACTIVATE_FAILED : taskbar cũng không xác định được -> dùng window_list

BA QUY TẮC BẮT BUỘC:

1) TỌA ĐỘ CHÍNH XÁC
- Chỉ click tâm chính xác của đối tượng (tâm nút bấm, tâm ô nhập liệu, tâm tab).
- Tâm = điểm giữa của viền đối tượng trên ảnh (ước lượng: tâm = mép trên-trái + 1/2 chiều rộng/cao của đối tượng).
- Tọa độ PHẢI nằm trong vùng tương tác của đối tượng và trong khung 0..${img.width - 1} x 0..${img.height - 1}. TUYỆT ĐỐI không click ra ngoài viền, không click lên vùng trống/vùng chết.

2) GỘP CHUỖI HÀNH ĐỘNG LIÊN HOÀN
- Nếu chắc chắn các bước sau KHÔNG cần xem lại màn hình (vd: click ô tìm kiếm -> gõ chữ -> Enter; hoặc click thanh URL -> gõ -> Enter), hãy gộp tất cả vào MỘT mảng nhiều phần tử, thực thi ngay lập tức.
- Nếu cần xem kết quả sau thao tác (mở menu, chuyển trang, chờ load), chỉ trả về mảng gồm 1 hành động.

3) ĐẦU RA STRICT JSON ONLY
- Trả về DUY NHẤT một mảng JSON bắt đầu bằng [ và kết thúc bằng ].
- KHÔNG hội thoại, KHÔNG giải thích, KHÔNG markdown, KHÔNG phân tích tọa độ thành lời văn, KHÔNG text nào ngoài mảng.
- TUYỆT ĐỐI KHÔNG tóm tắt màn hình, KHÔNG mô tả những gì bạn đang thấy, KHÔNG bình luận sau mảng JSON. Người dùng CHỈ cần hành động, không cần đọc bạn thấy gì.
- Trường "reason" của done/finish tối đa 15 từ, ghi ngắn gọn kết quả đã đạt.

ĐỊNH DẠNG HỢP LỆ:
[{"action":"click","x":500,"y":300,"button":"left"}]
[{"action":"click","x":410,"y":60},{"action":"type","text":"youtube"},{"action":"press","key":"ENTER"}]
[{"action":"type","text":"nội dung cần gõ"}]
[{"action":"press","key":"ENTER"}]
[{"action":"hold","key":"W","ms":2000}]
[{"action":"hotkey","keys":["CTRL","L"]}]
[{"action":"scroll","direction":"down","amount":3}]
[{"action":"drag","from":{"x":100,"y":100},"to":{"x":400,"y":300}}]
[{"action":"wait","ms":1500}]
[{"action":"done","reason":"đã hoàn thành mục tiêu"}]

VÍ DỤ VỀ CỬA SỔ (window actions):
[{"action":"window_list"}]
[{"action":"window_activate","target":"File Explorer"}]
[{"action":"window_activate","target":"Notepad"}]
[{"action":"window_activate","target":{"process":"chrome.exe"}}]
[{"action":"window_activate","target":{"hwnd":655890}}]
[{"action":"window_restore","target":"Roblox"}]
[{"action":"window_minimize","target":"Google Chrome"}]
[{"action":"show_desktop"}]
[{"action":"taskbar_activate","target":"Notepad"}]

"target" nhận được: chuỗi tự do ("File Explorer", "Notepad", "Chrome"),
tên file ("explorer.exe", "notepad.exe"), hoặc object {hwnd} / {pid} / {process} / {title} / {titleContains}.
Window actions KHÔNG được gộp cùng click/type/press trong cùng mảng.

Trường "button" chỉ cần khi không phải nút trái (left/right/middle). "double":true khi cần double-click.
"hold" = giữ phím trong "ms" rồi mới nhả (dùng để di chuyển nhân vật game, giữ W/A/S/D).
Chưa cần làm gì: [{"action":"wait","ms":1500}]
Mục tiêu hoàn thành: [{"action":"done","reason":"..."}]`;
}

function parseEvents(stdout) {
  const texts = [];
  let sessionId = null;
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const evt = JSON.parse(trimmed);
      if (evt.type === 'text' && evt.part?.text) texts.push(evt.part.text);
      if (evt.sessionID) sessionId = evt.sessionID;
    } catch {
      /* bỏ qua dòng không phải JSON */
    }
  }
  return { texts, sessionId };
}

function repairJson(candidate) {
  const quotedKeys = candidate.replace(/([{,]\s*)([A-Za-z_$][\w$]*)\s*:/g, '$1"$2":');
  const singleToDouble = quotedKeys.replace(/'/g, '"');
  return JSON.parse(singleToDouble);
}

const KNOWN_ACTIONS = new Set([
  'click',
  'move',
  'type',
  'press',
  'hold',
  'hotkey',
  'scroll',
  'drag',
  'wait',
  'done',
  'finish',
  'window_list',
  'window_activate',
  'window_restore',
  'window_minimize',
  'show_desktop',
  'taskbar_activate'
]);

// Các action đổi trạng thái cửa sổ -> sau đó PHẢI quan sát lại screenshot mới
export const WINDOW_STATE_ACTIONS = new Set([
  'window_activate',
  'window_restore',
  'window_minimize',
  'show_desktop',
  'taskbar_activate'
]);

// Action sinh input (click/gõ phím) - chỉ được chạy khi cửa sổ đích đã foreground
export const INPUT_ACTIONS = new Set(['click', 'move', 'type', 'press', 'hold', 'hotkey', 'scroll', 'drag']);

const MAX_CHAIN = 5;

function scanBalanced(text, open, close) {
  const candidates = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== open) continue;
    let depth = 0;
    let inString = false;
    let escape = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (escape) {
        escape = false;
        continue;
      }
      if (ch === '\\') {
        escape = true;
        continue;
      }
      if (ch === '"') inString = !inString;
      if (inString) continue;
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) {
          candidates.push(text.slice(start, i + 1));
          break;
        }
      }
    }
  }
  return candidates;
}

function parseLoose(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return repairJson(raw);
  }
}

function validateActions(value) {
  const list = Array.isArray(value) ? value : [value];
  const out = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    if (!KNOWN_ACTIONS.has(item.action)) continue;
    out.push(item);
    if (out.length >= MAX_CHAIN) break;
  }
  return out;
}

export { validateActions as validateActionsForTest };

export function findActions(text) {
  for (const raw of scanBalanced(text, '[', ']')) {
    try {
      const actions = validateActions(parseLoose(raw));
      if (actions.length) return actions;
    } catch {
      /* ứng viên này hỏng, thử tiếp */
    }
  }
  for (const raw of scanBalanced(text, '{', '}')) {
    try {
      const actions = validateActions(parseLoose(raw));
      if (actions.length) return actions;
    } catch {
      /* ứng viên này hỏng, thử tiếp */
    }
  }
  return null;
}

export async function askOpenCode({ goal, step, img, history, sessionId = null, title = null }) {
  const cmd = resolveOpenCodeCmd();
  const prompt = buildPrompt({ goal, step, img, history });

  const makeArgs = (sid) => {
    const args = ['run', '--format', 'json'];
    if (config.model) args.push('-m', config.model);
    if (config.agent) args.push('--agent', config.agent);
    if (sid && config.continueSession) args.push('-s', sid);
    else if (title && config.continueSession) args.push('--title', title);
    if (img.path) args.push('-f', img.path);
    return args;
  };

  const run = (args) =>
    execa(cmd, args, {
      reject: false,
      timeout: config.requestTimeoutMs,
      windowsHide: true,
      cwd: process.cwd(),
      input: prompt,
      env: { ...process.env, FORCE_COLOR: '0' }
    });

  const started = Date.now();
  let result = await run(makeArgs(config.continueSession ? sessionId : null));

  if (
    result.exitCode !== 0 &&
    sessionId &&
    config.continueSession &&
    /session|not found|invalid/i.test(result.stderr || '')
  ) {
    console.log(`    Session ${sessionId} không tiếp tục được, tạo session mới...`);
    result = await run(makeArgs(null));
  }

  const durationMs = Date.now() - started;
  const { texts, sessionId: sid } = parseEvents(result.stdout || '');
  const text = texts.join('\n');

  if (result.exitCode !== 0 && !text) {
    const err = (result.stderr || result.stdout || '').trim().slice(-500);
    throw new Error(`OpenCode CLI lỗi (exit ${result.exitCode}): ${err || 'không có output'}`);
  }

  const action = findActions(text) || [{ action: 'wait', ms: 2000, _parseFailed: true }];
  return { actions: action, raw: text, durationMs, sessionId: sid || sessionId };
}
