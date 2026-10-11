// Markdown helpers shared by every provider: document layout, code fences,
// file naming, saving, and an HTML -> Markdown converter for the DOM fallback.
(function (root) {
  'use strict';
  const NS = (root.ChatExport = root.ChatExport || {});

  // Fenced code block whose fence is longer than any backtick run inside it,
  // so code that itself contains ``` cannot break out of the block.
  function fence(content, lang) {
    const text = String(content == null ? '' : content).replace(/\s+$/, '');
    const longest = (text.match(/`{3,}/g) || []).reduce((m, r) => Math.max(m, r.length), 2);
    const f = '`'.repeat(longest + 1);
    return `${f}${lang || ''}\n${text}\n${f}`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
  }

  // Collapsible section (renders on GitHub, Obsidian, VS Code preview, ...).
  function details(summary, body) {
    return `<details>\n<summary>${escapeHtml(summary)}</summary>\n\n${String(body).trim()}\n\n</details>`;
  }

  function quote(text) {
    return String(text).trim().split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  // Accepts ISO strings, epoch seconds (ChatGPT) or epoch milliseconds.
  // Returns local time, e.g. "2026-10-11 14:05 (UTC+05:30)".
  function formatDate(value) {
    if (value == null || value === '') return '';
    const d = typeof value === 'number' ? new Date(value < 1e12 ? value * 1000 : value) : new Date(value);
    if (isNaN(d.getTime())) return '';
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? '+' : '-';
    const tz = `UTC${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} (${tz})`;
  }

  // Adds content to the conversation, merging consecutive blocks from the
  // same speaker (e.g. assistant -> tool -> assistant) into one turn.
  function pushTurn(turns, turn) {
    const blocks = turn.blocks.filter((b) => b && String(b).trim());
    if (!blocks.length) return;
    const last = turns[turns.length - 1];
    if (last && last.role === turn.role) {
      last.blocks.push(...blocks);
    } else {
      turns.push({ ...turn, blocks });
    }
  }

  // doc = { title, source, meta: [[label, value]], turns: [{ role, label, time, blocks }] }
  function buildDocument(doc, opts) {
    opts = opts || {};
    const lines = [`# ${doc.title || 'Untitled conversation'}`, ''];
    const meta = [['Source', doc.source], ...(doc.meta || []), ['Messages', String(doc.turns.length)], ['Exported', formatDate(Date.now())]];
    for (const [label, value] of meta) {
      if (value) lines.push(`- **${label}:** ${value}`);
    }
    const parts = [lines.join('\n')];
    for (const turn of doc.turns) {
      let head = `## ${turn.label}`;
      const time = opts.timestamps === false ? '' : formatDate(turn.time);
      if (time) head += `\n\n_${time}_`;
      parts.push(`${head}\n\n${turn.blocks.map((b) => String(b).trim()).join('\n\n')}`);
    }
    return parts.join('\n\n---\n\n').replace(/\n{4,}/g, '\n\n\n') + '\n';
  }

  function filename(title, date) {
    const d = date || new Date();
    const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const base = String(title || 'conversation')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^\.+|\.+$/g, '')
      .slice(0, 100)
      .trim();
    return `${base || 'conversation'} - ${stamp}.md`;
  }

  // Triggers a normal browser download from the page.
  function saveFile(name, text) {
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  // ---------------------------------------------------------------------------
  // HTML -> Markdown (used only when the conversation API is unavailable)
  // ---------------------------------------------------------------------------

  const SKIP_TAGS = new Set(['BUTTON', 'SVG', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'INPUT', 'TEXTAREA', 'SELECT']);

  function isPreWhitespace(el) {
    try {
      return /^pre/.test(getComputedStyle(el).whiteSpace);
    } catch {
      return false;
    }
  }

  function children(node, ctx) {
    let s = '';
    for (const c of node.childNodes) s += convert(c, ctx);
    return s;
  }

  function inlineCode(text) {
    const longest = (text.match(/`+/g) || []).reduce((m, r) => Math.max(m, r.length), 0);
    const ticks = '`'.repeat(longest + 1);
    const padded = /^`|`$/.test(text) ? ` ${text} ` : text;
    return `${ticks}${padded}${ticks}`;
  }

  function wrap(marker, inner) {
    const t = inner.trim();
    return t ? `${marker}${t}${marker}` : '';
  }

  function list(node, ctx, ordered) {
    let n = parseInt(node.getAttribute('start') || '1', 10);
    const items = [];
    for (const li of node.children) {
      if (li.tagName.toUpperCase() !== 'LI') continue;
      const marker = ordered ? `${n++}.` : '-';
      const body = children(li, { ...ctx, inList: true }).replace(/\n{3,}/g, '\n\n').trim();
      const indent = ' '.repeat(marker.length + 1);
      const lines = body.split('\n');
      items.push([`${marker} ${lines[0]}`, ...lines.slice(1).map((l) => (l ? indent + l : l))].join('\n'));
    }
    // Nested lists hug their parent item; top-level lists are separate blocks.
    return ctx.inList ? `\n${items.join('\n')}\n` : `\n\n${items.join('\n')}\n\n`;
  }

  function table(node, ctx) {
    const rows = Array.from(node.querySelectorAll('tr')).map((tr) =>
      Array.from(tr.children)
        .filter((c) => /^T[HD]$/i.test(c.tagName))
        .map((c) => children(c, ctx).replace(/\s*\n\s*/g, ' ').trim().replace(/\|/g, '\\|'))
    );
    if (!rows.length) return '';
    const cols = Math.max(...rows.map((r) => r.length));
    const line = (r) => `| ${Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ')} |`;
    const out = [line(rows[0]), `| ${Array(cols).fill('---').join(' | ')} |`, ...rows.slice(1).map(line)];
    return `\n\n${out.join('\n')}\n\n`;
  }

  function convert(node, ctx) {
    if (node.nodeType === 3) {
      const text = node.nodeValue;
      if (ctx.pre) return text;
      if (!text.trim() && text.includes('\n')) return '';
      return text.replace(/\s+/g, ' ');
    }
    if (node.nodeType !== 1) return '';
    const tag = node.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || node.getAttribute('aria-hidden') === 'true' || node.hidden) return '';
    if (!ctx.pre && isPreWhitespace(node) && tag !== 'PRE') ctx = { ...ctx, pre: true };
    const inner = () => children(node, ctx);

    switch (tag) {
      case 'BR':
        return ctx.pre ? '\n' : '  \n';
      case 'P':
        return `\n\n${inner().trim()}\n\n`;
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
        return `\n\n${'#'.repeat(Number(tag[1]))} ${inner().trim()}\n\n`;
      case 'STRONG': case 'B':
        return wrap('**', inner());
      case 'EM': case 'I':
        return wrap('*', inner());
      case 'DEL': case 'S':
        return wrap('~~', inner());
      case 'CODE':
        return inlineCode(node.textContent);
      case 'PRE': {
        const code = node.querySelector('code') || node;
        const m = (code.getAttribute('class') || '').match(/language-([\w+#.-]+)/);
        return `\n\n${fence(code.textContent, m ? m[1] : '')}\n\n`;
      }
      case 'A': {
        const text = inner().trim();
        const href = node.getAttribute('href') || '';
        if (!href || href.startsWith('javascript:') || href.startsWith('#')) return text;
        const abs = node.href || href;
        return `[${text || abs}](${abs})`;
      }
      case 'IMG': {
        const src = node.src || node.getAttribute('src') || '';
        return src && !src.startsWith('data:') ? `![${node.getAttribute('alt') || ''}](${src})` : '';
      }
      case 'UL':
        return list(node, ctx, false);
      case 'OL':
        return list(node, ctx, true);
      case 'BLOCKQUOTE':
        return `\n\n${quote(inner().replace(/\n{3,}/g, '\n\n'))}\n\n`;
      case 'HR':
        return '\n\n---\n\n';
      case 'TABLE':
        return table(node, ctx);
      case 'DIV': case 'SECTION': case 'ARTICLE': case 'HEADER': case 'FOOTER': case 'FIGURE':
        return `\n${inner()}\n`;
      default:
        return inner();
    }
  }

  function htmlToMarkdown(el) {
    return children(el, { pre: false })
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/, (m) => (m === '  ' ? m : '')))
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  NS.md = { fence, details, quote, escapeHtml, formatDate, pushTurn, buildDocument, filename, saveFile, htmlToMarkdown };
})(globalThis);
