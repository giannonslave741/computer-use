export const config = {
  intervalMs: 5000,
  maxSteps: 0,
  continueSession: true,
  // model hỗ trợ vision + trả JSON action đúng; ghim cứng để xoay session được.
  // ĐO ĐỘ NHẮM TỌA ĐỘ (4 điểm chuẩn, ảnh 1920x1080):
  //   space-bunny-free    -> sai TB ~2px,  5s   (chọn)
  //   longcat-...-free    -> sai TB 28px,  76s
  //   nemotron-3.5-vl-free-> sai TB 150-400px, 40-190s  (nội dung OK nhưng nhắm sai chỗ,
  //                          hay click vào khoảng trống -> không trúng ô tìm kiếm)
  //   beam-free           -> KHÔNG thấy ảnh; openrouter/* -> không gọi được
  model: 'opencode/space-bunny-free',
  agent: null,
  visionCmd: 'opencode',
  // 'opencode' gọi CLI local. 'openai' gọi POST /chat/completions (mọi endpoint cùng chuẩn).
  provider: process.env.CUA_PROVIDER || 'opencode',
  openai: {
    baseUrl: process.env.CUA_BASE_URL || 'https://api.openai.com/v1',
    apiKey: process.env.CUA_API_KEY || ''
  },
  requestTimeoutMs: 120000,
  dryRun: false,
  failSafeCorner: true,
  failSafeCornerMs: 1000,
  failSafeCornerTolerancePx: 5,
  // ảnh GỐC (png để đọc pixel, jpg để tloop/run_actions gửi model)
  screenshotPath: 'temp/latest.jpg',
  rawPngPath: 'temp/latest.png',
  // Vẽ lưới tọa độ lên ảnh gửi model: chỉ cần khi model nhắm kém (vd nemotron).
  // space-bunny-free nhắm ±2px không cần lưới -> tắt cho nhẹ (640KB/bước + 350ms).
  gridOverlay: false,
  gridStep: 100,
  gridQuant: 4,
  // Phân tích pixel tự động (màn hình có đổi sau chuỗi, chuột có nằm đúng tọa độ...)
  pixelAnalysis: true,
  sessionFile: '.cua-session.json',
  // lịch sử session dài -> mỗi bước chậm dần (đo: 7s -> 16s -> 21s). Xoay sớm.
  rotateAfterCalls: 4,

  // Cách bắn phím/chuột:
  //   'auto'        -> dùng Interception nếu driver đã cài, không thì fallback SendInput (nut-js)
  //   'interception'-> bắt buộc Interception, lỗi thì dừng
  //   'nutjs'       -> luôn dùng SendInput (cũ)
  inputBackend: 'auto',

  interception: {
    // null -> tự tìm vendor/interception.dll
    dllPath: null,
    // 0 -> tự dò; số >0 -> ép thiết bị (keyboard 1..10, mouse 11..20)
    keyboard: 0,
    mouse: 0,
    // quét từng thiết bị rồi kiểm tra thật bằng GetCursorPos/GetAsyncKeyState
    autoDetect: true,
    // delay (ms) giữa 2 sự kiện phím
    keyDelayMs: 12,
    // thời gian giữ phím (ms) cho hành động 'press'
    holdMs: 60
  }
};

/** Trả về số đối số đã nuốt (0 nếu không phải cờ provider). Không in API key. */
export function takeProviderFlag(argv, i) {
  const a = argv[i];
  if (a === '--provider') {
    const v = argv[i + 1];
    if (v !== 'opencode' && v !== 'openai') {
      throw new Error(`provider không hỗ trợ: ${v}. Dùng opencode hoặc openai.`);
    }
    config.provider = v;
    return 2;
  }
  if (a === '--base-url') {
    config.openai.baseUrl = argv[i + 1];
    return 2;
  }
  if (a === '--api-key') {
    config.openai.apiKey = argv[i + 1];
    return 2;
  }
  return 0;
}
