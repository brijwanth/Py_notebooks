// Entry point called by the popup after the scripts are injected into the tab.
(function (root) {
  'use strict';
  const NS = (root.ChatExport = root.ChatExport || {});

  function detectSite(loc) {
    if (loc.hostname === 'claude.ai') return 'claude';
    if (loc.hostname === 'chatgpt.com' || loc.hostname === 'chat.openai.com') return 'chatgpt';
    return null;
  }

  // opts: { action: 'download' | 'copy', thinking, tools, attachments, timestamps }
  NS.exportConversation = async function (opts) {
    const site = detectSite(location);
    if (!site) return { ok: false, error: 'Open a Claude.ai or ChatGPT conversation first.' };

    let doc;
    let method = 'api';
    let warning = '';
    try {
      doc = await NS.providers[site].fromApi(opts);
    } catch (apiError) {
      try {
        doc = NS.dom.extract(site);
        method = 'page';
        warning = `Full export unavailable (${apiError.message}), so the visible page was used instead. Thinking, tool calls and attachment contents may be missing.`;
      } catch (domError) {
        return { ok: false, error: `Could not read the conversation. API: ${apiError.message}. Page: ${domError.message}.` };
      }
    }

    const markdown = NS.md.buildDocument(doc, opts);
    const filename = NS.md.filename(doc.title);
    if (opts.action === 'download') NS.md.saveFile(filename, markdown);
    return { ok: true, markdown, filename, title: doc.title, messages: doc.turns.length, method, warning };
  };

  NS.detectSite = detectSite;
})(globalThis);
