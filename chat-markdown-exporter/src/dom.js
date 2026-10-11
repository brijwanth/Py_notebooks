// Fallback: scrape the rendered page when the conversation API is unavailable
// (shared links, logged-out views, or if the site changes its API).
(function (root) {
  'use strict';
  const NS = (root.ChatExport = root.ChatExport || {});

  const SITES = {
    claude: {
      label: 'Claude',
      selector: '[data-testid="user-message"], .font-claude-response, .font-claude-message',
      role: (el) => (el.matches('[data-testid="user-message"]') ? 'user' : 'assistant'),
      title: (t) => t.replace(/\s*[-–|]\s*Claude\s*$/i, ''),
    },
    chatgpt: {
      label: 'ChatGPT',
      selector: '[data-message-author-role]',
      role: (el) => el.getAttribute('data-message-author-role'),
      title: (t) => t.replace(/^ChatGPT\s*[-–|]\s*/i, '').replace(/\s*[-–|]\s*ChatGPT\s*$/i, ''),
    },
  };

  function extract(site) {
    const cfg = SITES[site];
    const found = Array.from(document.querySelectorAll(cfg.selector));
    // Keep only outermost matches so nested wrappers aren't exported twice.
    const els = found.filter((el) => !found.some((o) => o !== el && o.contains(el)));
    const turns = [];
    for (const el of els) {
      const role = cfg.role(el);
      if (role !== 'user' && role !== 'assistant') continue;
      NS.md.pushTurn(turns, {
        role,
        label: role === 'user' ? 'User' : cfg.label,
        time: null,
        blocks: [NS.md.htmlToMarkdown(el)],
      });
    }
    if (!turns.length) throw new Error('No messages found on the page');
    return {
      title: cfg.title(document.title || '') || 'Untitled conversation',
      source: location.href,
      meta: [],
      turns,
    };
  }

  NS.dom = { extract };
})(globalThis);
