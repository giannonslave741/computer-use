# computer-use

A Windows computer-use agent for any vision model. Each step takes a screenshot, sends the image, receives a JSON action array, then clicks, types, or switches windows.

The contract with an agent is the JSON array below. Any agent that returns that array drives the same executor. The command and model live in `config.js` (`visionCmd`, `model`) and can change without touching click or window code.

Each step is a closed loop.

1. Capture a small JPG for the model. PNG is only used when pixel comparison is on.
2. Attach the foreground window, the window list, and the pixel measurement from the previous step.
3. The model returns at most 5 actions.
4. The executor runs that chain, then the loop captures again.

Move the mouse to the top-left corner and hold it for about 1 second to stop.

## Requirements

- Windows 10 or later
- [Node.js](https://nodejs.org/) 18 or later
- A vision agent that can be launched from the command line. By default `config.visionCmd` is `opencode` and `config.model` is `opencode/space-bunny-free`. Change both when you use another agent.

## Install

```powershell
npm install
```

The default input mode is `auto`: use the Interception driver when it is installed, otherwise send keys through SendInput (nut-js). SendInput is enough for ordinary apps. Games and software that ignore synthetic input usually need Interception.

```powershell
npm run setup-driver
```

That downloads `interception.dll`, installs the driver, and asks for Administrator. Remove it with `npm run remove-driver`. The `vendor/` directory is created by the script and is not in git.

## Run a goal

The goal is whatever arguments are left on the command line.

```powershell
node index.js --steps 16 --interval 4000 --once "Open Chrome, go to YouTube, and search for a song"
```

Read a goal file and run in the background. Logs go to `run.log` and `run.err.log`:

```powershell
node launch-run.mjs goal.txt 16 4000
```

`goal.txt` is a sample goal (open Chrome, go to YouTube, search for music).

### Flags for `index.js`

| Flag | Effect |
| --- | --- |
| `--steps N` | Stop after N steps. Omit it for no limit. |
| `--interval MS` | Pause between steps. Default `5000`. |
| `--once` | Run exactly one step. |
| `--model NAME` | Model name for the agent in use. |
| `--agent NAME` | Agent profile, when that CLI has this flag. |
| `--backend auto\|interception\|nutjs` | How keys and the mouse are sent. |
| `--dry-run` | Print actions. Do not click or type. |
| `--no-continue` | Do not resume the previous vision CLI session. |
| `--no-failsafe` | Disable the top-left corner emergency stop. |
| `--observe` | Ignore `done` and keep watching. |
| `--provider opencode\|openai` | `opencode` calls the CLI in `visionCmd`. `openai` calls `POST /chat/completions`. |
| `--base-url URL` | API root when `--provider openai`. Default `https://api.openai.com/v1`. |
| `--api-key KEY` | Bearer token. Leave empty when a local server needs no key. It is never printed. |

`tloop` accepts the same three provider flags. Matching environment variables: `CUA_PROVIDER`, `CUA_BASE_URL`, `CUA_API_KEY`.

`Ctrl+C` also stops the loop.

### Vision HTTP endpoint

One step is still one request. The JPG just captured is sent with the prompt. Previous images are not sent, and there is no session. The body is only `model`, `messages`, `stream: false`, and `max_tokens`, which most servers accept. If the server rejects `max_tokens`, the request is sent once more with `max_completion_tokens`.

```powershell
node index.js --provider openai --base-url http://127.0.0.1:11434/v1 --model llava --once "Open Chrome"
```

`base-url` may be `https://api.openai.com/v1` or a URL that already ends in `/chat/completions`. This works with OpenAI, OpenRouter, Groq, Together, vLLM, llama.cpp, Ollama, LM Studio, and Gemini's OpenAI endpoint.

## Actions

The model must return one JSON array. No markdown and no explanation.

```json
[{"action":"click","x":500,"y":300,"button":"left"}]
[{"action":"click","x":410,"y":60},{"action":"type","text":"youtube"},{"action":"press","key":"ENTER"}]
[{"action":"hotkey","keys":["CTRL","L"]}]
[{"action":"hold","key":"W","ms":2000}]
[{"action":"scroll","direction":"down","amount":3}]
[{"action":"drag","from":{"x":100,"y":100},"to":{"x":400,"y":300}}]
[{"action":"wait","ms":1500}]
[{"action":"window_activate","target":"Google Chrome"}]
[{"action":"window_activate","target":{"process":"chrome.exe"}}]
[{"action":"done","reason":"found music on YouTube"}]
```

Coordinates are screen pixels. The top-left is `0,0`. `button` is only needed when it is not the left button. `double: true` requests a double-click.

Window actions: `window_list`, `window_activate`, `window_restore`, `window_minimize`, `show_desktop`, `taskbar_activate`.

`window_activate` must not share an array with a click or keypress. The executor drops the input that follows and asks for a new screenshot, because coordinates must come from the new image.

Run an action file by hand:

```powershell
node run_actions.mjs actions.json
```

## Configuration

Edit [config.js](config.js).

- `visionCmd` — command that calls the agent. Default `opencode`.
- `model` — that agent's vision model. The default misses by about 2px on a 1920×1080 image.
- `intervalMs` — pause between steps.
- `rotateAfterCalls` — delete the CLI session after this many calls. A long session makes each step slower.
- `gridOverlay` — draw a coordinate grid on the image. Off, because the default model aims closely enough.
- `pixelAnalysis` — compare frames and check that the cursor reached the clicked point.
- `inputBackend` — `auto`, `interception`, or `nutjs`.
- `failSafeCorner` — stop when the mouse sits in the top-left corner.

The live session is stored in `.cua-session.json` (not committed).

## Other modes

**Wander** holds WASD inside the Roblox window. It does not take screenshots and does not call a model.

```powershell
npm run wander
npm run wander:2min
npm run wander:stop
```

**tloop** asks the model every 2 minutes whether the game is still in play. If it is, the loop clicks the middle of the window and presses `T`. If the window is gone, a PowerShell script relaunches it. The goal text is `tloop-goal.txt`.

```powershell
npm run tloop
npm run tloop:stop
```

Logs: `tloop.log`, `tloop.err.log`.

The `*-goal.txt` files are samples tied to one machine (local paths, a specific game). Edit them before you run them.

## MCP for other agents

[.cursor/mcp.json](.cursor/mcp.json) registers the `computer-use` server. An agent in Cursor calls one action at a time. Each call goes through the same executor as the main loop: Interception when it is available, and no click when the window just changed or the wrong window is in front.

Tools: `screenshot`, `window_list`, `window_activate`, `click`, `move`, `type`, `press`, `hold`, `hotkey`, `scroll`, `drag`.

After `window_activate`, call `screenshot` before `click` or typing. Coordinates are pixels on the image just captured.

Run the server by hand with `node mcp/server.mjs` (it waits on stdin). Check it without a real click:

```powershell
node mcp/self-check.mjs
```

## Small commands in `cu/`

These scripts raise a window and then send input in the same process, so a console window cannot slip in between the raise and the click.

```powershell
node cu/shot.mjs
node cu/click.mjs 500 300
node cu/type.mjs "hello"
node cu/key.mjs ENTER
node cu/act.mjs <hwnd> click 500 300
```

## Checks

```powershell
npm run check
npm run test-all
npm run test-input
npm run test-windows
```

`test-input` really moves the mouse and types. `test-input --devices` lists Interception devices.

## Layout

| File | What it does |
| --- | --- |
| `index.js` | Capture, ask the model, execute |
| `brain.js` | Prompt, call the agent, extract the JSON array |
| `executor.js` | Run actions and block clicks until the right window is in front |
| `capture.js` | Take screenshots |
| `windows.js` | List and activate windows |
| `backends.js` | Interception or nut-js |
| `analyze.js` | Compare pixels and check coordinates |
| `config.js` | Runtime settings |

`temp/` holds screenshots and bench logs. It is not committed, because a screenshot can contain private screen contents.
