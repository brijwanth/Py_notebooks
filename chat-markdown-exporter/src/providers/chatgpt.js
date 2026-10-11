// ChatGPT: reads the full conversation tree from the backend API the web app
// uses (authenticated with the session's own access token).
(function (root) {
  'use strict';
  const NS = (root.ChatExport = root.ChatExport || {});
  const { fence, details, quote, pushTurn } = NS.md;

  function conversationId(loc) {
    const m = loc.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  async function fetchJSON(url, headers) {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json', ...headers } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json();
  }

  async function fetchConversation(id) {
    const session = await fetchJSON('/api/auth/session');
    if (!session || !session.accessToken) throw new Error('Not logged in to ChatGPT');
    const headers = { Authorization: `Bearer ${session.accessToken}` };
    const did = (document.cookie || '').match(/(?:^|;\s*)oai-did=([^;]+)/);
    if (did) headers['oai-device-id'] = decodeURIComponent(did[1]);
    return fetchJSON(`/backend-api/conversation/${id}`, headers);
  }

  // Removes ChatGPT's inline citation markers, which render as garbage outside the app.
  function clean(text) {
    return String(text || '')
      .replace(/[^]*/g, '')
      .replace(/【\d+(?::\d+)?†[^】]*】/g, '');
  }

  function partsToMd(parts) {
    return (parts || [])
      .map((p) => {
        if (typeof p === 'string') return clean(p);
        if (!p) return '';
        if (p.content_type === 'image_asset_pointer') return '🖼️ *[image]*';
        if (p.content_type === 'audio_transcription') return clean(p.text);
        return p.text ? clean(p.text) : '';
      })
      .filter((s) => s.trim())
      .join('\n\n');
  }

  function hasImage(content) {
    return (content.parts || []).some((p) => p && p.content_type === 'image_asset_pointer');
  }

  // The visible thread is the path from the root to current_node.
  function activePath(conv) {
    const mapping = conv.mapping || {};
    const chain = [];
    const seen = new Set();
    let id = conv.current_node;
    if (!mapping[id]) id = Object.keys(mapping).find((k) => !(mapping[k].children || []).length);
    while (id && mapping[id] && !seen.has(id)) {
      seen.add(id);
      chain.push(mapping[id]);
      id = mapping[id].parent;
    }
    return chain.reverse().map((n) => n.message).filter(Boolean);
  }

  function renderMessage(msg, opts) {
    const role = msg.author && msg.author.role;
    const c = msg.content || {};
    const meta = msg.metadata || {};
    const type = c.content_type;
    if (role === 'system' || meta.is_visually_hidden_from_conversation) return null;
    if (type === 'user_editable_context' || type === 'model_editable_context') return null;

    if (role === 'user') {
      const blocks = (meta.attachments || []).map((a) => `📎 *Attachment: ${a.name || a.id}*`);
      blocks.push(type === 'text' || type === 'multimodal_text' ? partsToMd(c.parts) : clean(c.text || ''));
      return { role: 'user', blocks };
    }

    if (role === 'assistant') {
      if (msg.recipient && msg.recipient !== 'all') {
        if (!opts.tools) return null;
        const body = type === 'code' ? fence(c.text, c.language && c.language !== 'unknown' ? c.language : '') : partsToMd(c.parts) || clean(c.text);
        return { role: 'assistant', blocks: [details(`Tool call: ${msg.recipient}`, body)] };
      }
      switch (type) {
        case 'thoughts': {
          if (!opts.thinking) return null;
          const body = (c.thoughts || []).map((t) => [t.summary && `**${t.summary}**`, t.content].filter(Boolean).join('\n\n')).join('\n\n');
          return { role: 'assistant', blocks: [body && details('Thinking', quote(body))] };
        }
        case 'reasoning_recap':
          return null;
        case 'code':
          return { role: 'assistant', blocks: [fence(c.text, c.language && c.language !== 'unknown' ? c.language : '')] };
        default:
          return { role: 'assistant', blocks: [c.parts ? partsToMd(c.parts) : clean(c.text)] };
      }
    }

    if (role === 'tool') {
      // Generated images arrive as tool messages but are part of the visible answer.
      if (!opts.tools) return hasImage(c) ? { role: 'assistant', blocks: ['🖼️ *[generated image]*'] } : null;
      const name = (msg.author && msg.author.name) || 'tool';
      let body;
      if (type === 'execution_output') body = fence(c.text);
      else if (type === 'tether_browsing_display') body = clean(c.result || c.summary || '');
      else if (type === 'tether_quote') body = `${c.title ? `[${c.title}](${c.url})\n\n` : ''}${quote(c.text || '')}`;
      else if (c.parts) body = partsToMd(c.parts);
      else body = clean(c.text || '');
      return { role: 'assistant', blocks: [details(`Tool result: ${name}`, body || '_(empty)_')] };
    }
    return null;
  }

  function toDoc(conv, opts, source) {
    const turns = [];
    for (const msg of activePath(conv)) {
      const r = renderMessage(msg, opts);
      if (!r) continue;
      pushTurn(turns, { role: r.role, label: r.role === 'user' ? 'User' : 'ChatGPT', time: msg.create_time, blocks: r.blocks });
    }
    const meta = [
      ['Model', conv.default_model_slug],
      ['Created', NS.md.formatDate(conv.create_time)],
      ['Updated', NS.md.formatDate(conv.update_time)],
    ];
    return { title: conv.title || 'Untitled conversation', source, meta, turns };
  }

  async function fromApi(opts) {
    const id = conversationId(location);
    if (!id) throw new Error('No conversation id in the URL');
    const conv = await fetchConversation(id);
    return toDoc(conv, opts, `${location.origin}/c/${id}`);
  }

  NS.providers = NS.providers || {};
  NS.providers.chatgpt = { name: 'ChatGPT', fromApi, toDoc, activePath };
})(globalThis);
