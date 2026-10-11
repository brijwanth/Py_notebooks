# Chat to Markdown Exporter (Chrome / Edge)

A Manifest V3 browser extension that downloads a **complete** Claude.ai or ChatGPT
conversation as a Markdown (`.md`) file, or copies it to the clipboard.

It does not scrape the screen. It reads the conversation from the same JSON API the
site's web app uses, logged in as you, so the export includes:

- every message in the active branch, even very long chats (when you edited or
  retried a message, it exports the version you are looking at)
- code blocks and Claude **artifacts**, as fenced code with their language
- **thinking / reasoning** (optional, in collapsible `<details>` blocks)
- **tool calls and results**, such as web search, code interpreter and file tools (optional)
- attachment names, and optionally the extracted text of attached files
- title, model, created/updated dates, and per-message timestamps (optional)

If the API ever fails (a shared link, a logged-out view, or the site changing its API),
it falls back to converting the visible page HTML to Markdown and tells you so.

## Install (Chrome or Edge)

1. Get this folder on your computer: clone the repo, or download it as a ZIP from GitHub and unzip it.
2. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
3. Turn on **Developer mode** (top-right in Chrome, left sidebar in Edge).
4. Click **Load unpacked** and select the `chat-markdown-exporter` folder (the one containing `manifest.json`).
5. Optional: pin the extension to the toolbar.

## Use

1. Open a conversation on `claude.ai/chat/...` or `chatgpt.com/c/...`.
2. Click the extension icon, or press **Alt+Shift+M**.
3. Choose your options, then click **Download .md** or **Copy**.

The file is saved as `<conversation title> - <YYYY-MM-DD>.md` in your normal downloads
folder. If you turned on "Ask where to save each file" in your browser, it asks you first.
Your option choices are remembered.

## Sample output

````markdown
# NIFTY bhavcopy: missing dates

- **Source:** https://claude.ai/chat/1111...
- **Model:** claude-...
- **Created:** 2026-10-01 14:30 (UTC+05:30)
- **Messages:** 4

---

## User

_2026-10-01 14:30 (UTC+05:30)_

Which dates are missing from `dates.csv`?

---

## Claude

<details>
<summary>Thinking</summary>

> Compare against the trading calendar...

</details>

**Artifact: date_check.py**

```python
...
```
````

## Privacy

- The extension runs only when you click it, and only on `claude.ai`, `chatgpt.com` and `chat.openai.com`.
- It sends no data anywhere. The only network requests go to the chat site itself, using your existing login.
- Permissions: `scripting` (to run the exporter in the chat tab), `storage` (to remember
  your options), `clipboardWrite` (for the Copy button).

## Files

| Path | Purpose |
| --- | --- |
| `manifest.json` | Extension manifest (MV3) |
| `popup.html/.css/.js` | Toolbar popup; injects the exporter into the active tab |
| `src/markdown.js` | Markdown layout, code fences, file naming, HTML→Markdown fallback |
| `src/providers/claude.js` | Claude.ai API export |
| `src/providers/chatgpt.js` | ChatGPT API export |
| `src/dom.js` | Visible-page fallback |
| `src/exporter.js` | Entry point: picks a provider, builds and saves the file |
| `tests/` | End-to-end test with mocked sites |

## Tests

The end-to-end test loads the unpacked extension in Chromium, serves mocked Claude and
ChatGPT pages and APIs, and drives the real popup. It covers download, copy, branches,
artifacts, thinking, tools, attachments, citation clean-up and the page fallback.

```bash
npm i -g playwright      # if not already installed
NODE_PATH="$(npm root -g)" node tests/e2e.cjs
```

## Limitations

- These are private web-app APIs, so they can change without notice. When that happens,
  the page fallback still works, and the provider file is the place to update.
- Images are exported as placeholders (`[image]`), not embedded.
- Only the active branch is exported. Earlier edits and retries are skipped.
