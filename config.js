export const config = {
  intervalMs: 5000,
  maxSteps: 0,
  continueSession: true,
  // Vision model that returns a valid JSON action array. Pinned so sessions can rotate.
  // AIM ERROR on 4 reference points, 1920x1080 image:
  //   space-bunny-free    -> about 2px average, 5s   (selected)
  //   longcat-...-free    -> 28px average, 76s
  //   nemotron-3.5-vl-free-> 150-400px average, 40-190s (content is fine but the aim is off,
  //                          and it clicks empty space instead of the search box)
  //   beam-free           -> does NOT see the image; openrouter/* -> cannot be called
  model: 'opencode/space-bunny-free',
  agent: null,
  visionCmd: 'opencode',
  // 'opencode' calls the local CLI. 'openai' calls POST /chat/completions (any compatible endpoint).
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
  // Source image (png for pixels, jpg for tloop and run_actions to send to the model)
  screenshotPath: 'temp/latest.jpg',
  rawPngPath: 'temp/latest.png',
  // Draw a coordinate grid on the image sent to the model. Only needed when aim is poor (for example nemotron).
  // space-bunny-free aims within about 2px, so the grid stays off (it added 640KB and 350ms per step).
  gridOverlay: false,
  gridStep: 100,
  gridQuant: 4,
  // Automatic pixel analysis (did the screen change, did the cursor land on the point)
  pixelAnalysis: true,
  sessionFile: '.cua-session.json',
  // A long session makes each step slower (measured 7s -> 16s -> 21s). Rotate early.
  rotateAfterCalls: 4,

  // How keys and the mouse are sent:
  //   'auto'        -> Interception when the driver is installed, otherwise SendInput (nut-js)
  //   'interception'-> require Interception, and stop if it fails
  //   'nutjs'       -> always use SendInput
  inputBackend: 'auto',

  interception: {
    // null -> find vendor/interception.dll automatically
    dllPath: null,
    // 0 -> auto-detect; a number > 0 forces the device (keyboard 1..10, mouse 11..20)
    keyboard: 0,
    mouse: 0,
    // scan each device and verify it with GetCursorPos / GetAsyncKeyState
    autoDetect: true,
    // delay in ms between two key events
    keyDelayMs: 12,
    // how long a 'press' action holds the key, in ms
    holdMs: 60
  }
};

/** Returns how many argv items were consumed (0 if this is not a provider flag). Never prints the API key. */
export function takeProviderFlag(argv, i) {
  const a = argv[i];
  if (a === '--provider') {
    const v = argv[i + 1];
    if (v !== 'opencode' && v !== 'openai') {
      throw new Error(`Unsupported provider: ${v}. Use opencode or openai.`);
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
