// Trimmed-down copies of the JSON shapes returned by the Claude.ai and ChatGPT web APIs.
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';
const CHATGPT_ID = '66666666-7777-4888-9999-000000000000';
const ROOT = '00000000-0000-4000-8000-000000000000';

const claudeConversation = {
  uuid: CLAUDE_ID,
  name: 'NIFTY bhavcopy: missing dates',
  model: 'claude-test-model',
  created_at: '2026-10-01T09:00:00.000Z',
  updated_at: '2026-10-01T09:05:00.000Z',
  current_leaf_message_uuid: 'm4',
  chat_messages: [
    {
      uuid: 'm1', parent_message_uuid: ROOT, index: 0, sender: 'human', created_at: '2026-10-01T09:00:00Z',
      content: [{ type: 'text', text: 'Which dates are missing from `dates.csv`?' }],
      attachments: [{ file_name: 'dates.csv', extracted_content: 'date\n2020-01-01\n2020-01-03' }],
      files: [{ file_name: 'chart.png', file_kind: 'image' }],
    },
    {
      uuid: 'm2-old', parent_message_uuid: 'm1', index: 1, sender: 'assistant', created_at: '2026-10-01T09:01:00Z',
      content: [{ type: 'text', text: 'ABANDONED BRANCH ANSWER' }],
    },
    {
      uuid: 'm2', parent_message_uuid: 'm1', index: 1, sender: 'assistant', created_at: '2026-10-01T09:02:00Z',
      content: [
        { type: 'thinking', thinking: 'Compare against the trading calendar.\nSkip holidays.' },
        { type: 'text', text: 'Here is a script:' },
        {
          type: 'tool_use', name: 'artifacts',
          input: { id: 'chk', type: 'application/vnd.ant.code', language: 'python', title: 'date_check.py', command: 'create',
            content: 'doc = """\n```\nnested fence\n```\n"""\nprint(doc)' },
        },
        { type: 'tool_use', name: 'web_search', input: { query: 'NSE holidays 2020' } },
        { type: 'tool_result', name: 'web_search', content: [{ type: 'knowledge', title: 'NSE holiday list', url: 'https://example.com/nse' }] },
        { type: 'text', text: 'The missing date is **2020-01-02**.' },
      ],
    },
    {
      uuid: 'm3', parent_message_uuid: 'm2', index: 2, sender: 'human', created_at: '2026-10-01T09:03:00Z',
      content: [{ type: 'text', text: 'Thanks!\nSecond line.' }],
    },
    {
      uuid: 'm4', parent_message_uuid: 'm3', index: 3, sender: 'assistant', created_at: '2026-10-01T09:04:00Z',
      content: [], text: 'You are welcome.',
    },
  ],
};

function node(id, parent, children, message) {
  return { id, parent, children, message };
}

const chatgptConversation = {
  title: 'Portfolio XIRR',
  create_time: 1790000000.5,
  update_time: 1790000300.5,
  default_model_slug: 'gpt-test',
  current_node: 'n6',
  mapping: {
    root: node('root', null, ['n0'], null),
    n0: node('n0', 'root', ['n1'], { author: { role: 'system' }, content: { content_type: 'text', parts: ['SYSTEM PROMPT'] }, metadata: { is_visually_hidden_from_conversation: true } }),
    n1: node('n1', 'n0', ['n2', 'n2-old'], { author: { role: 'user' }, create_time: 1790000001, content: { content_type: 'text', parts: ['How do I compute XIRR?'] }, metadata: { attachments: [{ name: 'cashflows.xlsx' }] } }),
    'n2-old': node('n2-old', 'n1', [], { author: { role: 'assistant' }, content: { content_type: 'text', parts: ['OLD BRANCH'] }, metadata: {} }),
    n2: node('n2', 'n1', ['n3'], { author: { role: 'assistant' }, create_time: 1790000002, content: { content_type: 'thoughts', thoughts: [{ summary: 'Recall formula', content: 'XIRR solves NPV = 0.' }] }, metadata: {} }),
    n3: node('n3', 'n2', ['n4'], { author: { role: 'assistant' }, recipient: 'python', create_time: 1790000003, content: { content_type: 'code', language: 'unknown', text: 'print(1+1)' }, metadata: {} }),
    n4: node('n4', 'n3', ['n5'], { author: { role: 'tool', name: 'python' }, create_time: 1790000004, content: { content_type: 'execution_output', text: '2' }, metadata: {} }),
    n5: node('n5', 'n4', ['n6'], { author: { role: 'assistant' }, recipient: 'all', create_time: 1790000005, content: { content_type: 'text', parts: ['Use `=XIRR(values, dates)` in Excel.citeturn0search0 See docs【4:0†source】.'] }, metadata: {} }),
    n6: node('n6', 'n5', [], { author: { role: 'user' }, create_time: 1790000006, content: { content_type: 'multimodal_text', parts: [{ content_type: 'image_asset_pointer', asset_pointer: 'file-service://x' }, 'What about this chart?'] }, metadata: {} }),
  },
};

// Rendered pages, used for the DOM fallback (markup mirrors each site's structure).
const claudeHtml = `<!doctype html><html><head><title>NIFTY bhavcopy: missing dates - Claude</title></head><body>
<div data-testid="user-message"><p class="whitespace-pre-wrap" style="white-space: pre-wrap">Which dates are missing?
Line two of the prompt.</p></div>
<div class="font-claude-response"><div>
  <p>Here is a <strong>script</strong> with a <a href="https://example.com/doc">link</a>:</p>
  <pre><code class="language-python">for d in dates:
    print(d)</code></pre>
  <button>Copy</button>
  <ul><li>First item<ul><li>Nested item</li></ul></li><li>Second item</li></ul>
  <ol start="3"><li>Three</li><li>Four</li></ol>
  <table><thead><tr><th>Date</th><th>Status</th></tr></thead><tbody><tr><td>2020-01-02</td><td>missing | gap</td></tr></tbody></table>
  <blockquote><p>Quoted text</p></blockquote>
</div></div>
</body></html>`;

const chatgptHtml = `<!doctype html><html><head><title>Portfolio XIRR</title></head><body>
<div data-message-author-role="user"><div class="whitespace-pre-wrap" style="white-space: pre-wrap">How do I compute XIRR?</div></div>
<div data-message-author-role="assistant"><div class="markdown"><p>Use <code>=XIRR()</code>.</p><h3>Steps</h3><p>Done.</p></div></div>
</body></html>`;

module.exports = { CLAUDE_ID, CHATGPT_ID, claudeConversation, chatgptConversation, claudeHtml, chatgptHtml };
