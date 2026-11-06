# computer-use

Agent điều khiển máy Windows cho mọi model nhìn được ảnh. Vòng lặp chụp màn hình, gửi ảnh, nhận một mảng JSON hành động, rồi click, gõ phím hoặc chuyển cửa sổ.

Hợp đồng với agent là mảng JSON ở dưới. Agent nào trả đúng mảng đó thì điều khiển được cùng một executor. Lệnh gọi model mặc định nằm trong `config.js` (`visionCmd`, `model`) và đổi được mà không đổi phần click hay cửa sổ.

Mỗi bước là một vòng kín.

1. Chụp JPG nhẹ để gửi model. PNG chỉ dùng khi cần so pixel.
2. Kèm cửa sổ đang foreground, danh sách cửa sổ, và kết quả đo pixel của bước trước.
3. Model trả về tối đa 5 hành động.
4. Executor chạy chuỗi đó, rồi vòng lặp chụp lại.

Di chuột vào góc trên-trái màn hình và giữ khoảng 1 giây để dừng khẩn cấp.

## Yêu cầu

- Windows 10 trở lên
- [Node.js](https://nodejs.org/) 18 trở lên
- Một agent vision chạy được từ dòng lệnh. Mặc định `config.visionCmd` là `opencode` và `config.model` là `opencode/space-bunny-free`. Đổi hai giá trị này khi dùng agent khác.

## Cài đặt

```powershell
npm install
```

Input mặc định là `auto`: dùng driver Interception nếu đã cài, không thì gửi phím qua SendInput (nut-js). SendInput đủ cho ứng dụng thông thường. Game hoặc phần mềm nuốt input giả thường cần Interception.

```powershell
npm run setup-driver
```

Lệnh này tải `interception.dll`, cài driver, và yêu cầu quyền Administrator. Gỡ driver bằng `npm run remove-driver`. Thư mục `vendor/` do script tạo ra và không nằm trong git.

## Chạy một mục tiêu

Mục tiêu là các đối số còn lại trên dòng lệnh.

```powershell
node index.js --steps 16 --interval 4000 --once "Mo Chrome, vao YouTube, tim mot bai nhac"
```

Đọc mục tiêu từ file rồi chạy nền, ghi log vào `run.log` và `run.err.log`:

```powershell
node launch-run.mjs goal.txt 16 4000
```

`goal.txt` là mục tiêu mẫu (mở Chrome, vào YouTube, tìm nhạc).

### Cờ của `index.js`

| Cờ | Tác dụng |
| --- | --- |
| `--steps N` | Dừng sau N bước. Bỏ qua nghĩa là không giới hạn. |
| `--interval MS` | Nghỉ giữa hai bước. Mặc định `5000`. |
| `--once` | Chạy đúng một bước. |
| `--model NAME` | Tên model của agent đang dùng. |
| `--agent NAME` | Hồ sơ agent, nếu CLI đó có cờ này. |
| `--backend auto\|interception\|nutjs` | Cách gửi phím và chuột. |
| `--dry-run` | In hành động, không click và không gõ. |
| `--no-continue` | Không nối session cũ của CLI vision. |
| `--no-failsafe` | Tắt dừng khẩn cấp ở góc màn hình. |
| `--observe` | Bỏ qua `done` và tiếp tục quan sát. |
| `--provider opencode\|openai` | `opencode` gọi CLI trong `visionCmd`. `openai` gọi `POST /chat/completions`. |
| `--base-url URL` | Gốc API khi `--provider openai`. Mặc định `https://api.openai.com/v1`. |
| `--api-key KEY` | Bearer token. Bỏ trống nếu server local không cần key. Không được in ra log. |

Cùng ba cờ này có trên `tloop`. Biến môi trường tương ứng: `CUA_PROVIDER`, `CUA_BASE_URL`, `CUA_API_KEY`.

`Ctrl+C` cũng dừng vòng lặp.

### Gọi endpoint vision

Một bước vẫn là một request. Ảnh JPG vừa chụp đi kèm prompt, không gửi ảnh các bước trước, không giữ session. Body chỉ có `model`, `messages`, `stream: false` và `max_tokens` để hầu hết server nhận. Nếu server từ chối `max_tokens`, request được gửi lại một lần với `max_completion_tokens`.

```powershell
node index.js --provider openai --base-url http://127.0.0.1:11434/v1 --model llava --once "Mo Chrome"
```

`base-url` có thể là `https://api.openai.com/v1` hoặc URL đã kết thúc bằng `/chat/completions`. Cách này dùng được với OpenAI, OpenRouter, Groq, Together, vLLM, llama.cpp, Ollama, LM Studio và endpoint OpenAI của Gemini.

## Hành động

Model chỉ được trả một mảng JSON. Không markdown, không lời giải thích.

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
[{"action":"done","reason":"da tim nhac tren YouTube"}]
```

Tọa độ là pixel màn hình, góc trên-trái là `0,0`. `button` chỉ cần khi không phải nút trái. `double: true` khi cần nháy đúp.

Hành động cửa sổ: `window_list`, `window_activate`, `window_restore`, `window_minimize`, `show_desktop`, `taskbar_activate`.

`window_activate` không được nằm cùng click hoặc gõ phím trong một mảng. Executor bỏ phần input phía sau và yêu cầu chụp lại, vì tọa độ phải lấy từ ảnh mới.

Chạy tay một file hành động:

```powershell
node run_actions.mjs actions.json
```

## Cấu hình

Sửa [config.js](config.js).

- `visionCmd` — lệnh gọi agent. Mặc định `opencode`.
- `model` — model vision của agent đó. Giá trị mặc định lệch tọa độ khoảng 2px trên ảnh 1920×1080.
- `intervalMs` — nghỉ giữa hai bước.
- `rotateAfterCalls` — xóa session CLI sau từng này lượt. Session dài làm mỗi bước chậm dần.
- `gridOverlay` — vẽ lưới tọa độ lên ảnh. Đang tắt vì model mặc định nhắm đủ sát.
- `pixelAnalysis` — so khung hình và kiểm tra chuột có tới đúng điểm đã click.
- `inputBackend` — `auto`, `interception`, hoặc `nutjs`.
- `failSafeCorner` — dừng khi chuột nằm ở góc trên-trái.

Session đang dùng ghi ở `.cua-session.json` (không commit).

## Chế độ khác

**Wander** giữ WASD trong cửa sổ Roblox, không chụp ảnh và không gọi model.

```powershell
npm run wander
npm run wander:2min
npm run wander:stop
```

**tloop** mỗi 2 phút hỏi model còn đang ở trong game hay không. Còn trong game thì click giữa cửa sổ và bấm `T`. Mất cửa sổ thì mở lại qua script PowerShell đi kèm. Mục tiêu nằm trong `tloop-goal.txt`.

```powershell
npm run tloop
npm run tloop:stop
```

Log: `tloop.log`, `tloop.err.log`.

Các file `*-goal.txt` là mục tiêu mẫu gắn với máy đang chạy (đường dẫn cục bộ, game cụ thể). Đổi nội dung cho đúng máy của bạn trước khi chạy.

## MCP cho agent khác

File [.cursor/mcp.json](.cursor/mcp.json) đăng ký server `computer-use`. Agent trong Cursor gọi từng thao tác, và mỗi thao tác đi qua cùng executor với vòng lặp chính: Interception nếu có, và cấm click khi cửa sổ vừa đổi hoặc sai cửa sổ.

Tool: `screenshot`, `window_list`, `window_activate`, `click`, `move`, `type`, `press`, `hold`, `hotkey`, `scroll`, `drag`.

Sau `window_activate` phải gọi `screenshot` rồi mới `click` hoặc gõ. Tọa độ là pixel trên ảnh vừa chụp.

Chạy tay server: `node mcp/server.mjs` (nó chờ kết nối trên stdin). Kiểm tra không click thật:

```powershell
node mcp/self-check.mjs
```

## Lệnh nhỏ trong `cu/`

Các script này đưa một cửa sổ lên trước rồi gửi input trong cùng tiến trình, để cửa sổ console không chen giữa lúc nâng cửa sổ và lúc click.

```powershell
node cu/shot.mjs
node cu/click.mjs 500 300
node cu/type.mjs "hello"
node cu/key.mjs ENTER
node cu/act.mjs <hwnd> click 500 300
```

## Kiểm tra

```powershell
npm run check
npm run test-all
npm run test-input
npm run test-windows
```

`test-input` di chuột và gõ thật. `test-input --devices` liệt kê thiết bị Interception.

## Bố cục

| File | Việc nó làm |
| --- | --- |
| `index.js` | Vòng chụp, hỏi model, thực thi |
| `brain.js` | Prompt, gọi agent, tách mảng JSON |
| `executor.js` | Chạy hành động và chặn click khi chưa đúng cửa sổ |
| `capture.js` | Chụp màn hình |
| `windows.js` | Liệt kê và kích hoạt cửa sổ |
| `backends.js` | Interception hoặc nut-js |
| `analyze.js` | So pixel và kiểm tra tọa độ |
| `config.js` | Tham số chạy |

`temp/` chứa ảnh chụp và log bench. Thư mục này không được commit vì ảnh màn hình có thể chứa nội dung riêng.
