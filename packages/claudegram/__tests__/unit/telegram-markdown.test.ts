import { describe, expect, it } from 'vitest'

import { renderMarkdownAsTelegramHtml } from '../../src/telegram-markdown'

describe('Telegram Markdown rendering', () => {
  it('renders GitHub-style Markdown using Telegram-supported HTML', () => {
    const markdown = `## Report

**Files added**

- \`src/index.ts\`
- [Docs](https://example.com?a=1&b=2)
- ~~removed~~ and _added_

> Keep <unsafe> HTML visible.

\`\`\`ts
const value = "<tag>" && true
\`\`\`

| Name | State |
| --- | --- |
| renderer | ready |
| parser | \`safe\` |`

    expect(renderMarkdownAsTelegramHtml(markdown)).toBe(
      `<b>Report</b>

<b>Files added</b>

• <code>src/index.ts</code>
• <a href="https://example.com/?a=1&amp;b=2">Docs</a>
• <s>removed</s> and <i>added</i>

<blockquote>Keep &lt;unsafe&gt; HTML visible.</blockquote>

<pre><code class="language-ts">const value = &quot;&lt;tag&gt;&quot; &amp;&amp; true</code></pre>

<b>Name | State</b>
renderer | ready
parser | <code>safe</code>`,
    )
  })

  it('does not pass raw HTML or unsafe links to Telegram', () => {
    expect(
      renderMarkdownAsTelegramHtml(
        '[run](javascript:alert(1)) <script>danger & "quoted"</script>',
      ),
    ).toBe(
      'run (javascript:alert(1)) &lt;script&gt;danger &amp; &quot;quoted&quot;&lt;/script&gt;',
    )
  })

  it('avoids entity combinations that Telegram rejects', () => {
    expect(
      renderMarkdownAsTelegramHtml(
        '**bold `code`**\n\n> outer\n> > nested\n> >\n> > ```ts\n> > const nested = true\n> > ```',
      ),
    ).toBe(
      '<b>bold code</b>\n\n<blockquote>outer\n\nnested\n\nconst nested = true</blockquote>',
    )
  })

  it('closes formatting tags when Telegram-length truncation is required', () => {
    const rendered = renderMarkdownAsTelegramHtml(
      `\`\`\`ts\n${'😀'.repeat(100)}\n\`\`\``,
      10,
    )

    expect(rendered).toBe(
      '<pre><code class="language-ts">😀😀😀😀…</code></pre>',
    )
  })
})
