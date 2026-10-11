// Claude.ai: reads the full conversation from the same JSON API the web app
// uses, so thinking, artifacts, tool calls and attachments are all available.
(function (root) {
  'use strict';
  const NS = (root.ChatExport = root.ChatExport || {});
  const { fence, details, quote, pushTurn } = NS.md;

  const ARTIFACT_LANG = {
    'text/markdown': 'markdown',
    'text/html': 'html',
    'image/svg+xml': 'svg',
    'application/vnd.ant.react': 'jsx',
    'application/vnd.ant.mermaid': 'mermaid',
  };

  function conversationId(loc) {
    const m = loc.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    return m ? m[1] : null;
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { credentials: 'include', headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url.split('?')[0]}`);
    return res.json();
  }

  async function organizationIds() {
    const ids = [];
    const cookie = (document.cookie || '').match(/(?:^|;\s*)lastActiveOrg=([^;]+)/);
    if (cookie) ids.push(decodeURIComponent(cookie[1]));
    try {
      const orgs = await fetchJSON('/api/organizations');
      for (const o of orgs || []) if (o && o.uuid && !ids.includes(o.uuid)) ids.push(o.uuid);
    } catch (e) {
      if (!ids.length) throw e;
    }
    if (!ids.length) throw new Error('Could not determine your Claude organization (are you logged in?)');
    return ids;
  }

  async function fetchConversation(id) {
    const query = 'tree=True&rendering_mode=messages&render_all_tools=true';
    let lastError;
    for (const org of await organizationIds()) {
      try {
        return await fetchJSON(`/api/organizations/${org}/chat_conversations/${id}?${query}`);
      } catch (e) {
        lastError = e;
      }
    }
    throw lastError;
  }

  // Claude stores every edit/retry as a branch. Follow parent links back from
  // the current leaf so the export matches what is shown on screen.
  function activeBranch(messages, leafId) {
    const byId = new Map(messages.map((m) => [m.uuid, m]));
    let leaf = byId.get(leafId);
    if (!leaf) leaf = messages.reduce((a, b) => ((b.index || 0) > (a.index || 0) ? b : a), messages[0]);
    const chain = [];
    const seen = new Set();
    for (let cur = leaf; cur && !seen.has(cur.uuid); cur = byId.get(cur.parent_message_uuid)) {
      seen.add(cur.uuid);
      chain.push(cur);
    }
    return chain.reverse();
  }

  function renderArtifact(input) {
    const title = input.title || input.id || 'Artifact';
    const cmd = input.command || 'create';
    if ((cmd === 'create' || cmd === 'rewrite') && input.content != null) {
      const lang = input.language || ARTIFACT_LANG[input.type] || '';
      return `**Artifact${cmd === 'rewrite' ? ' (rewritten)' : ''}: ${title}**\n\n${fence(input.content, lang)}`;
    }
    if (cmd === 'update') {
      return `**Artifact updated: ${title}**\n\nReplaced:\n\n${fence(input.old_str || '')}\n\nWith:\n\n${fence(input.new_str || '')}`;
    }
    return `**Artifact ${cmd}: ${title}**`;
  }

  function renderToolUse(block, opts) {
    const input = block.input || {};
    if (block.name === 'artifacts') return renderArtifact(input);
    if (!opts.tools) return '';
    // File-creating tools: show the file as a code block rather than escaped JSON.
    if (typeof input.file_text === 'string') {
      const ext = (input.path || '').split('.').pop();
      return details(`Tool call: ${block.name} ${input.path || ''}`.trim(), fence(input.file_text, ext && ext !== input.path ? ext : ''));
    }
    return details(`Tool call: ${block.name}`, fence(JSON.stringify(input, null, 2), 'json'));
  }

  function renderToolResult(block, opts) {
    if (!opts.tools) return '';
    const items = Array.isArray(block.content) ? block.content : [{ type: 'text', text: String(block.content || '') }];
    const body = items
      .map((item) => {
        if (item.type === 'text') return item.text || '';
        if (item.title && item.url) return `- [${item.title}](${item.url})`;
        return fence(JSON.stringify(item, null, 2), 'json');
      })
      .filter(Boolean)
      .join('\n\n');
    const label = `Tool result: ${block.name || 'tool'}${block.is_error ? ' (error)' : ''}`;
    return details(label, body || '_(empty)_');
  }

  function renderBlocks(msg, opts) {
    const out = [];
    const content = Array.isArray(msg.content) && msg.content.length ? msg.content : [{ type: 'text', text: msg.text || '' }];
    for (const block of content) {
      switch (block.type) {
        case 'text':
          out.push(block.text || '');
          break;
        case 'thinking':
          if (opts.thinking && block.thinking) out.push(details('Thinking', quote(block.thinking)));
          break;
        case 'tool_use':
          out.push(renderToolUse(block, opts));
          break;
        case 'tool_result':
          out.push(renderToolResult(block, opts));
          break;
        default:
          break;
      }
    }
    return out;
  }

  function renderAttachments(msg, opts) {
    const out = [];
    const names = new Set();
    for (const a of msg.attachments || []) {
      const name = a.file_name || 'attachment';
      names.add(name);
      if (opts.attachments && a.extracted_content) {
        out.push(details(`Attachment: ${name}`, fence(a.extracted_content)));
      } else {
        out.push(`📎 *Attachment: ${name}*`);
      }
    }
    for (const f of [...(msg.files || []), ...(msg.files_v2 || [])]) {
      const name = f.file_name || 'file';
      if (names.has(name)) continue;
      names.add(name);
      out.push(`📎 *${f.file_kind === 'image' ? 'Image' : 'File'}: ${name}*`);
    }
    return out;
  }

  function toDoc(conv, opts, source) {
    const turns = [];
    for (const msg of activeBranch(conv.chat_messages || [], conv.current_leaf_message_uuid)) {
      const isUser = msg.sender === 'human';
      const blocks = isUser
        ? [...renderAttachments(msg, opts), ...renderBlocks(msg, opts)]
        : [...renderBlocks(msg, opts), ...renderAttachments(msg, opts)];
      pushTurn(turns, { role: isUser ? 'user' : 'assistant', label: isUser ? 'User' : 'Claude', time: msg.created_at, blocks });
    }
    const meta = [
      ['Model', conv.model],
      ['Project', conv.project && conv.project.name],
      ['Created', NS.md.formatDate(conv.created_at)],
      ['Updated', NS.md.formatDate(conv.updated_at)],
    ];
    return { title: conv.name || 'Untitled conversation', source, meta, turns };
  }

  async function fromApi(opts) {
    const id = conversationId(location);
    if (!id) throw new Error('No conversation id in the URL');
    const conv = await fetchConversation(id);
    return toDoc(conv, opts, `https://claude.ai/chat/${id}`);
  }

  NS.providers = NS.providers || {};
  NS.providers.claude = { name: 'Claude', fromApi, toDoc, activeBranch };
})(globalThis);
