import { takeScreenShot } from './capture.js';
import { prepareShot } from './grid.js';
import { diffFrames, formatDiff, checkPoints, checkCursor } from './analyze.js';
import { askOpenCode, loadSessionState, saveSessionState, deleteSession, cleanupCuaSessions } from './brain.js';
import {
  executeActions,
  setCoordinateMap,
  acknowledgeReobserve,
  resetWindowGuard
} from './executor.js';
import { resolveBackend } from './backends.js';
import { createStagnationDetector } from './stagnation.js';
import * as wm from './windows.js';
import { screen, mouse, sleep } from '@nut-tree-fork/nut-js';
import { config } from './config.js';

function parseArgs(argv) {
  const opts = { goal: [], steps: null, interval: null, once: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--steps') opts.steps = Number(argv[++i]);
    else if (a === '--interval') opts.interval = Number(argv[++i]);
    else if (a === '--model') config.model = argv[++i];
    else if (a === '--agent') config.agent = argv[++i];
    else if (a === '--backend') config.inputBackend = argv[++i];
    else if (a === '--dry-run') config.dryRun = true;
    else if (a === '--once') opts.once = true;
    else if (a === '--no-continue') config.continueSession = false;
    else if (a === '--no-failsafe') config.failSafeCorner = false;
    else if (a === '--observe') opts.observe = true;
    else opts.goal.push(a);
  }
  opts.goal = opts.goal.join(' ').trim();
  return opts;
}

async function checkFailSafe(state) {
  if (!config.failSafeCorner) return false;
  const pos = await mouse.getPosition();
  const inCorner =
    pos.x <= config.failSafeCornerTolerancePx && pos.y <= config.failSafeCornerTolerancePx;

  if (inCorner) {
    if (!state.cornerSince) {
      state.cornerSince = Date.now();
      console.log('    !! Phát hiện chuột ở góc màn hình — giữ yên để DỪNG khẩn cấp...');
    } else if (Date.now() - state.cornerSince >= config.failSafeCornerMs) {
      return true;
    }
  } else {
    if (state.cornerSince) console.log('    Đã rời góc màn hình, tiếp tục.');
    state.cornerSince = null;
  }
  return false;
}

async function calibrate(img) {
  const screenW = await screen.width();
  const screenH = await screen.height();
  const scaleX = screenW / img.width;
  const scaleY = screenH / img.height;
  setCoordinateMap(scaleX, scaleY, img.width, img.height);
  return { screenW, screenH };
}

function foregroundText() {
  try {
    const f = wm.describeForeground();
    if (!f) return '(không lấy được cửa sổ foreground)';
    const fs = wm.isFullscreen(f.hwnd);
    const sc = wm.getScreenSize();
    return [
      `title=${f.title || '(không có title)'}`,
      `hwnd=${f.hwnd} pid=${f.pid} proc=${f.processName || '?'} visible=${f.visible} minimized=${f.minimized}`,
      f.rect ? `rect=(${f.rect.left},${f.rect.top})-(${f.rect.right},${f.rect.bottom})` : '',
      `fullscreen=${fs ? 'YES (đang che toàn màn hình, UI bình thường KHÔNG có trên màn hình)' : 'no'}`,
      `man_hinh=${sc.width}x${sc.height} - toa do anh/click la toa do MAN HINH tuyet doi`
    ]
      .filter(Boolean)
      .join(' | ');
  } catch (err) {
    return `(lỗi đọc foreground: ${err.message})`;
  }
}

function windowListText() {
  try {
    return wm.formatWindowList({ max: 12 });
  } catch (err) {
    return `(lỗi liệt kê cửa sổ: ${err.message})`;
  }
}

/** Rect của cửa sổ foreground (dùng để báo model khi click ra ngoài ứng dụng đích). */
function foregroundRect() {
  try {
    const f = wm.describeForeground();
    return f && f.rect ? f.rect : null;
  } catch {
    return null;
  }
}

async function runLoop(opts) {
  const state = {
    cornerSince: null,
    lastAction: null,
    history: [],
    step: 0,
    session: null,
    frame: null, // khung pixel PNG của bước trước (so sánh màn hình)
    pendingMsgs: [], // cảnh báo pixel lấy ở bước trước, sẽ gửi model ở bước sau
    lastPoint: null, // điểm click/move cần kiểm tra con trỏ có trúng không
    fgRect: null
  };
  const stagnation = createStagnationDetector({ limit: 3 });
  let lastBlocked = null;
  let lastBlockedReason = '';

  console.log('=== Bắt đầu Computer Use Agent (Node.js + OpenCode CLI) ===');
  console.log(`Mục tiêu : ${opts.goal || '(chưa đặt)'}
Bước tối đa: ${opts.steps || 'không giới hạn'} | Interval: ${opts.interval ?? config.intervalMs}ms
Dry-run: ${config.dryRun} | Tiếp tục session: ${config.continueSession} | Failsafe góc màn hình: ${config.failSafeCorner}
`);
  if (config.dryRun) console.log('*** CHẾ ĐỘ DRY-RUN: chỉ in hành động, không click/gõ ***\n');

  resetWindowGuard();

  if (!config.dryRun) {
    console.log('[0] Khởi tạo backend bắn lệnh...');
    await resolveBackend();
    console.log('');
  }

  state.session = loadSessionState();
  console.log(
    `Session CUA dùng chung: ${state.session.sessionId || '(chưa có, sẽ tạo)'} | lượt gọi: ${state.session.calls}\n`
  );
  if (config.continueSession) await cleanupCuaSessions(state.session.sessionId);

  let stop = false;
  const onSignal = (sig) => {
    console.log(`\n[${sig}] Dừng khẩn cấp theo yêu cầu người dùng...`);
    stop = true;
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  while (!stop) {
    state.step++;
    try {
      if (await checkFailSafe(state)) {
        console.log('\n*** DỪNG KHẨN CẤP: chuột ở góc màn hình ***');
        break;
      }

      console.log(`\n[1] Chụp màn hình (bước ${state.step})...`);

      // PNG gốc -> phân tích pixel + (tuỳ chọn) vẽ lưới. JPG nhẹ -> gửi model.
      // Bắt buộc tách: PNG 2.8MB làm chậm ~19s/bước khi upload, JPG 212KB thì không.
      const needPixels = config.pixelAnalysis || config.gridOverlay;
      const rawShot = needPixels ? await takeScreenShot({ format: 'png' }) : null;
      const prep = rawShot
        ? await prepareShot(rawShot.path, {
            grid: config.gridOverlay,
            step: config.gridStep,
            quant: config.gridQuant
          })
        : { path: null, frame: null, width: 0, height: 0 };

      let img;
      if (config.gridOverlay && prep.frame) {
        img = { path: prep.path, width: prep.width, height: prep.height, grid: true };
      } else {
        img = { ...(await takeScreenShot()), grid: false };
      }
      console.log(`    -> ${img.path} (${img.width}x${img.height})${img.grid ? ' [lưới tọa độ]' : ''}`);

      if (state.step === 1) await calibrate(img);

      // đã chụp ảnh mới -> coi như đã quan sát lại sau window action
      acknowledgeReobserve();

      // --- Phân tích pixel tự động cho bước tới (kết quả THẬT của chuỗi trước) ---
      const analysisMsgs = [];
      if (config.pixelAnalysis && state.frame && prep.frame) {
        const t = formatDiff(diffFrames(state.frame, prep.frame));
        if (t) analysisMsgs.push(t);
      }
      if (state.pendingMsgs.length) {
        analysisMsgs.push(...state.pendingMsgs);
        state.pendingMsgs = [];
      }
      const analysisText = analysisMsgs.join('\n');
      state.frame = prep.frame;
      state.fgRect = foregroundRect();

      const fgText = foregroundText();
      const winText = windowListText();
      const stagMsg = stagnation.message();
      console.log(`    Foreground: ${fgText}`);
      if (stagMsg) console.log(`    [WINDOW] STAGNATION DETECTED: ${stagMsg}`);
      if (analysisText) {
        console.log('    [PIXEL] Phân tích sẽ gửi model:');
        for (const line of analysisText.split('\n')) console.log(`      - ${line}`);
      }

      console.log('[2] Gửi ảnh cho OpenCode CLI phân tích...');
      const { actions, raw, durationMs, sessionId } = await askOpenCode({
        goal: opts.goal,
        step: state.step,
        img,
        history: {
          lastAction: state.lastAction,
          foreground: fgText,
          windows: winText,
          stagnation: stagMsg,
          analysis: analysisText,
          blocked: lastBlocked ? `${lastBlocked} - ${lastBlockedReason}` : ''
        },
        sessionId: state.session.sessionId,
        title: state.session.sessionId ? null : 'CUA Agent'
      });
      if (sessionId) {
        if (state.session.sessionId !== sessionId) {
          state.session.sessionId = sessionId;
          console.log(`    Session dùng chung: ${sessionId}`);
        }
        state.session.calls++;
        if (state.session.calls >= config.rotateAfterCalls) {
          console.log(
            `    Đạt ${config.rotateAfterCalls} lượt gọi - xoay vòng: xóa session cũ, sang session mới.`
          );
          await deleteSession(state.session.sessionId);
          state.session = { sessionId: null, calls: 0 };
        }
        saveSessionState(state.session);
      }
      // chỉ in HÀNH ĐỘNG, không in lời bình/tóm tắt màn hình của model
      const parseFailed = actions.length === 1 && actions[0]._parseFailed;
      const shown = parseFailed ? `(không parse được) ${raw.replace(/\s+/g, ' ').slice(0, 200)}` : JSON.stringify(actions);
      console.log(`    Phản hồi (${(durationMs / 1000).toFixed(1)}s): ${shown}`);

      let queue = actions;
      if (opts.observe) {
        const before = queue.length;
        queue = queue.filter((a) => a.action !== 'done' && a.action !== 'finish');
        if (queue.length < before) console.log('    (observe mode) bỏ qua done, tiếp tục quan sát.');
      }
      // Kiểm tra pixel: điểm click có nằm trong màn hình / cửa sổ đích không?
      if (config.pixelAnalysis && prep.frame) {
        const pts = [];
        let last = null;
        for (const a of queue) {
          if ((a.action === 'click' || a.action === 'move') && typeof a.x === 'number') {
            pts.push({ x: a.x, y: a.y });
            last = { x: a.x, y: a.y };
          } else if (a.action === 'drag' && a.from && a.to) {
            pts.push(a.from, a.to);
            last = { x: a.to.x, y: a.to.y };
          }
        }
        const warns = checkPoints(pts, {
          rect: state.fgRect,
          width: prep.width || img.width,
          height: prep.height || img.height
        });
        for (const w of warns) console.log(`    [PIXEL] ${w}`);
        state.pendingMsgs.push(...warns);
        state.lastPoint = last;
      }

      console.log(`[3] Chuỗi ${queue.length} hành động:`, JSON.stringify(queue));

      if (queue.some((a) => a._parseFailed)) {
        console.log('    Cảnh báo: không parse được JSON, chuyển sang wait.');
      }

      console.log('[4] Thực thi chuỗi...');
      const result = await executeActions(queue);

      // Con trỏ có THẬT SỰ nằm ở điểm đã click không? (bắt lỗi mapping tọa độ)
      if (config.pixelAnalysis && !config.dryRun && state.lastPoint) {
        try {
          const pos = await mouse.getPosition();
          const msg = checkCursor({ x: pos.x, y: pos.y }, state.lastPoint);
          if (msg) {
            console.log(`    [PIXEL] ${msg}`);
            state.pendingMsgs.push(msg);
          }
        } catch {
          /* không đọc được vị trí chuột */
        }
      }
      state.lastPoint = null;

      state.lastAction = JSON.stringify(queue);
      state.history.push({ step: state.step, action: state.lastAction, result });
      if (state.history.length > 5) state.history.shift();

      const repeats = stagnation.push(queue);
      if (repeats >= 3) {
        console.log(
          `    [WINDOW] STAGNATION DETECTED: chuỗi vừa chạy đã lặp ${repeats} lần liên tiếp.`
        );
      }
      if (result.blocked) {
        lastBlocked = result.blocked;
        lastBlockedReason = result.blockReason || '';
        console.log(`    [WINDOW] TRẠNG THÁI: ${result.blocked} - ${lastBlockedReason}`);
      } else if (!result.reobserve) {
        lastBlocked = null;
        lastBlockedReason = '';
      }
      if (result.reobserve) {
        console.log('    [WINDOW] REOBSERVE_REQUIRED: bước kế tiếp sẽ chụp ảnh mới trước khi input.');
      }

      if (result.done) {
        console.log('\n*** AGENT BÁO HOÀN TẤT MỤC TIÊU ***');
        break;
      }
    } catch (error) {
      console.error('    Lỗi trong vòng lặp:', error.message || error);
    }

    if (stop) break;
    if (opts.once) {
      console.log('\nChế độ --once: dừng sau 1 bước.');
      break;
    }
    if (opts.steps && state.step >= opts.steps) {
      console.log(`\nĐạt giới hạn ${opts.steps} bước.`);
      break;
    }

    const waitMs = opts.interval ?? config.intervalMs;
    console.log(`Đợi ${waitMs / 1000}s cho chu kỳ tiếp theo...`);
    await sleep(waitMs);
  }

  console.log(`\nKết thúc sau ${state.step} bước.`);
}

const opts = parseArgs(process.argv.slice(2));
runLoop(opts).catch((err) => {
  console.error('Lỗi nghiêm trọng:', err);
  process.exit(1);
});
