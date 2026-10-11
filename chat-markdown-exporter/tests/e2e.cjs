// End-to-end test: loads the unpacked extension in Chromium, serves mocked
// claude.ai / chatgpt.com pages and APIs, and drives the real popup.
// Run: NODE_PATH="$(npm root -g)" node tests/e2e.cjs
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { chromium } = require('playwright');
const F = require('./fixtures.cjs');

const EXT = path.resolve(__dirname, '..');

// Chromium derives an unpacked extension's id from its absolute path.
function extensionId(dir) {
  const hex = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const html = (body) => ({ status: 200, contentType: 'text/html', body });

function mockRoutes(context, state) {
  return Promise.all([
    context.route('https://claude.ai/**', (route) => {
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/api/') && state.apiDown) return route.fulfill(json({ error: 'down' }, 500));
      if (url.pathname === '/api/organizations') return route.fulfill(json([{ uuid: 'org-wrong' }, { uuid: 'org-1' }]));
      if (url.pathname === `/api/organizations/org-1/chat_conversations/${F.CLAUDE_ID}`) {
        assert.equal(url.searchParams.get('tree'), 'True');
        return route.fulfill(json(F.claudeConversation));
      }
      if (url.pathname.startsWith('/api/')) return route.fulfill(json({ error: 'not found' }, 404));
      return route.fulfill(html(F.claudeHtml));
    }),
    context.route('https://chatgpt.com/**', (route) => {
      const url = new URL(route.request().url());
      if ((url.pathname.startsWith('/api/') || url.pathname.startsWith('/backend-api/')) && state.apiDown) return route.fulfill(json({}, 500));
      if (url.pathname === '/api/auth/session') return route.fulfill(json({ accessToken: 'tok' }));
      if (url.pathname === `/backend-api/conversation/${F.CHATGPT_ID}`) {
        assert.equal(route.request().headers().authorization, 'Bearer tok');
        return route.fulfill(json(F.chatgptConversation));
      }
      return route.fulfill(html(F.chatgptHtml));
    }),
  ]);
}

async function exportVia(context, popup, pageUrl, opts, action) {
  const page = await context.newPage();
  await page.goto(pageUrl);
  await popup.bringToFront();
  // Point the popup at the chat tab (normally it is the active tab when the popup opens).
  await popup.evaluate(async ({ url, opts }) => {
    const [t] = await chrome.tabs.query({ url: url.split('#')[0] });
    tab = t; // eslint-disable-line no-undef
    for (const [k, v] of Object.entries(opts)) document.getElementById(k).checked = v;
    document.getElementById('download').disabled = false;
  }, { url: pageUrl, opts });

  let markdown = null;
  let filename = null;
  if (action === 'download') {
    const [download] = await Promise.all([page.waitForEvent('download'), popup.click('#download')]);
    markdown = fs.readFileSync(await download.path(), 'utf8');
    filename = download.suggestedFilename();
  } else {
    await popup.click('#copy');
  }
  await popup.waitForFunction(() => /Saved|Copied|Could not|Error|HTTP/.test(document.getElementById('status').textContent));
  const status = await popup.textContent('#status');
  await page.close();
  return { markdown, filename, status };
}

(async () => {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cme-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: true,
    channel: 'chromium', // full Chromium (new headless) — the headless shell cannot load extensions
    acceptDownloads: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  const errors = [];
  const state = { apiDown: false };
  await mockRoutes(context, state);

  const popup = await context.newPage();
  popup.on('pageerror', (e) => errors.push(e.message));
  await popup.goto(`chrome-extension://${extensionId(EXT)}/popup.html`);
  await popup.waitForFunction(() => document.getElementById('site').textContent !== 'Checking this tab…');
  assert.match(await popup.textContent('#site'), /Open a Claude\.ai or ChatGPT conversation/);
  // Defaults: thinking + tools on.
  assert.equal(await popup.isChecked('#thinking'), true);
  assert.equal(await popup.isChecked('#attachments'), false);

  // 1. Claude via API, everything on.
  const all = { thinking: true, tools: true, attachments: true, timestamps: true };
  let r = await exportVia(context, popup, `https://claude.ai/chat/${F.CLAUDE_ID}`, all, 'download');
  console.log('--- Claude (API) ---\n' + r.markdown);
  assert.match(r.status, /Saved .*4 messages/);
  assert.equal(r.filename.replace(/ - \d{4}-\d\d-\d\d\.md$/, ''), 'NIFTY bhavcopy missing dates');
  const md = r.markdown;
  assert.match(md, /^# NIFTY bhavcopy: missing dates/);
  assert.match(md, /\*\*Model:\*\* claude-test-model/);
  assert.doesNotMatch(md, /ABANDONED BRANCH/);
  assert.match(md, /<summary>Attachment: dates.csv<\/summary>[\s\S]*2020-01-03/);
  assert.match(md, /📎 \*Image: chart.png\*/);
  assert.match(md, /<summary>Thinking<\/summary>\n\n> Compare against the trading calendar.\n> Skip holidays./);
  assert.match(md, /\*\*Artifact: date_check.py\*\*\n\n````python\ndoc = """\n```\nnested fence\n```\n"""\nprint\(doc\)\n````/);
  assert.match(md, /Tool call: web_search[\s\S]*"query": "NSE holidays 2020"/);
  assert.match(md, /- \[NSE holiday list\]\(https:\/\/example.com\/nse\)/);
  assert.match(md, /## User\n\n_2026-10-01 \d\d:03 \(UTC[+-]\d\d:\d\d\)_\n\nThanks!\nSecond line./);
  assert.match(md, /## Claude\n\n_[^_]+_\n\nYou are welcome.\n$/);
  assert.equal((md.match(/^## /gm) || []).length, 4);

  // 2. Claude via API, extras off.
  const none = { thinking: false, tools: false, attachments: false, timestamps: false };
  r = await exportVia(context, popup, `https://claude.ai/chat/${F.CLAUDE_ID}`, none, 'download');
  assert.doesNotMatch(r.markdown, /Thinking|web_search|2020-01-03|_2026-10-01/);
  assert.match(r.markdown, /📎 \*Attachment: dates.csv\*/);
  assert.match(r.markdown, /\*\*Artifact: date_check.py\*\*/, 'artifacts are always exported');

  // 3. ChatGPT via API.
  r = await exportVia(context, popup, `https://chatgpt.com/c/${F.CHATGPT_ID}`, all, 'download');
  console.log('--- ChatGPT (API) ---\n' + r.markdown);
  const g = r.markdown;
  assert.match(g, /^# Portfolio XIRR/);
  assert.doesNotMatch(g, /SYSTEM PROMPT|OLD BRANCH|\ue200|【/);
  assert.match(g, /📎 \*Attachment: cashflows.xlsx\*\n\nHow do I compute XIRR\?/);
  assert.match(g, /Recall formula[\s\S]*Tool call: python[\s\S]*print\(1\+1\)[\s\S]*Tool result: python[\s\S]*Use `=XIRR\(values, dates\)` in Excel. See docs./);
  assert.match(g, /🖼️ \*\[image\]\*\n\nWhat about this chart\?/);
  assert.equal((g.match(/^## /gm) || []).length, 3);

  // 4. DOM fallback when the APIs fail.
  state.apiDown = true;
  r = await exportVia(context, popup, `https://claude.ai/chat/${F.CLAUDE_ID}`, all, 'download');
  console.log('--- Claude (page fallback) ---\n' + r.markdown);
  assert.match(r.status, /visible page was used/);
  const d = r.markdown;
  assert.match(d, /^# NIFTY bhavcopy: missing dates\n/);
  assert.match(d, /## User\n\nWhich dates are missing\?\nLine two of the prompt./);
  assert.match(d, /Here is a \*\*script\*\* with a \[link\]\(https:\/\/example.com\/doc\):/);
  assert.match(d, /```python\nfor d in dates:\n    print\(d\)\n```/);
  assert.doesNotMatch(d, /Copy/);
  assert.match(d, /- First item\n  - Nested item\n- Second item/);
  assert.match(d, /3\. Three\n4\. Four/);
  assert.match(d, /\| Date \| Status \|\n\| --- \| --- \|\n\| 2020-01-02 \| missing \\\| gap \|/);
  assert.match(d, /> Quoted text/);

  r = await exportVia(context, popup, `https://chatgpt.com/c/${F.CHATGPT_ID}`, all, 'download');
  assert.match(r.markdown, /## ChatGPT\n\nUse `=XIRR\(\)`.\n\n### Steps\n\nDone./);

  // 5. Copy button.
  state.apiDown = false;
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  r = await exportVia(context, popup, `https://claude.ai/chat/${F.CLAUDE_ID}`, all, 'copy');
  assert.match(r.status, /Copied to clipboard/);
  const clip = await popup.evaluate(() => navigator.clipboard.readText());
  assert.match(clip, /^# NIFTY bhavcopy/);

  assert.deepEqual(errors, []);
  await context.close();
  console.log('\nAll e2e checks passed.');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
