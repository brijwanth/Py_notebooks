'use strict';

const SCRIPTS = ['src/markdown.js', 'src/providers/claude.js', 'src/providers/chatgpt.js', 'src/dom.js', 'src/exporter.js'];
const SITES = [
  { name: 'Claude', test: (u) => u.hostname === 'claude.ai' },
  { name: 'ChatGPT', test: (u) => u.hostname === 'chatgpt.com' || u.hostname === 'chat.openai.com' },
];
const DEFAULTS = { thinking: true, tools: true, attachments: false, timestamps: true };
const OPTION_KEYS = Object.keys(DEFAULTS);

const $ = (id) => document.getElementById(id);
let tab = null;

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = `status ${kind || ''}`;
}

function readOptions() {
  const opts = {};
  for (const k of OPTION_KEYS) opts[k] = $(k).checked;
  return opts;
}

async function init() {
  const stored = await chrome.storage.sync.get(DEFAULTS);
  for (const k of OPTION_KEYS) {
    $(k).checked = Boolean(stored[k]);
    $(k).addEventListener('change', () => chrome.storage.sync.set(readOptions()));
  }

  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url = null;
  try {
    url = new URL(tab.url);
  } catch {
    /* tab.url is unavailable on pages we have no access to */
  }
  const site = url && SITES.find((s) => s.test(url));
  if (!site) {
    $('site').textContent = 'Open a Claude.ai or ChatGPT conversation, then click the extension again.';
    return;
  }
  $('site').textContent = `${site.name}: ${tab.title || 'conversation'}`;
  $('download').disabled = false;
  $('copy').disabled = false;
}

async function run(action) {
  $('download').disabled = true;
  $('copy').disabled = true;
  setStatus('Exporting…');
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: SCRIPTS });
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => globalThis.ChatExport.exportConversation(opts),
      args: [{ ...readOptions(), action }],
    });
    const result = injection && injection.result;
    if (!result) throw new Error('No response from the page. Reload the tab and try again.');
    if (!result.ok) throw new Error(result.error);

    if (action === 'copy') await navigator.clipboard.writeText(result.markdown);
    const done = action === 'copy' ? 'Copied to clipboard' : `Saved “${result.filename}”`;
    const kb = Math.max(1, Math.round(new Blob([result.markdown]).size / 1024));
    setStatus(`${done} — ${result.messages} messages, ${kb} KB.${result.warning ? `\n${result.warning}` : ''}`, result.warning ? 'warn' : 'ok');
  } catch (e) {
    setStatus(e.message || String(e), 'err');
  } finally {
    $('download').disabled = false;
    $('copy').disabled = false;
  }
}

$('download').addEventListener('click', () => run('download'));
$('copy').addEventListener('click', () => run('copy'));
init().catch((e) => setStatus(e.message || String(e), 'err'));
