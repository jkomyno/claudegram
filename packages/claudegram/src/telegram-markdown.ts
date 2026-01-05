import { Marked, Renderer, type Token, type Tokens } from 'marked'

const TELEGRAM_HTML_TAG =
  /<(?<closing>\/)?(?<tag>a|b|blockquote|code|i|pre|s)(?: [^>]*)?>|&(?:amp|gt|lt|quot);|[\s\S]/gu
const TELEGRAM_LINK_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tg:'])
export const TELEGRAM_MESSAGE_TEXT_LIMIT = 4096
const SOURCE_LENGTH_FACTOR = 4

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const safeLink = (href: string): string | undefined => {
  try {
    const parsed = new URL(href)
    return TELEGRAM_LINK_PROTOCOLS.has(parsed.protocol) ? parsed.href : undefined
  } catch {
    return undefined
  }
}

const trimBlock = (value: string): string => value.trimEnd()

class TelegramHtmlRenderer extends Renderer {
  private entityDepth = 0
  private blockquoteDepth = 0

  private parseBlockWithinEntity(tokens: Array<Token>): string {
    this.entityDepth += 1
    try {
      return this.parser.parse(tokens)
    } finally {
      this.entityDepth -= 1
    }
  }

  private parseInlineWithinEntity(tokens: Array<Token>): string {
    this.entityDepth += 1
    try {
      return this.parser.parseInline(tokens)
    } finally {
      this.entityDepth -= 1
    }
  }

  override space(): string {
    return ''
  }

  override code({ text, lang }: Tokens.Code): string {
    if (this.entityDepth > 0) return `${escapeHtml(text)}\n\n`

    const language = lang?.match(/^[a-z0-9_+-]+/iu)?.[0]
    const attribute =
      language === undefined ? '' : ` class="language-${language}"`
    return `<pre><code${attribute}>${escapeHtml(text)}</code></pre>\n\n`
  }

  override blockquote({ tokens }: Tokens.Blockquote): string {
    const nested = this.blockquoteDepth > 0
    this.blockquoteDepth += 1
    let content: string
    try {
      content = trimBlock(this.parseBlockWithinEntity(tokens))
    } finally {
      this.blockquoteDepth -= 1
    }
    return nested ? `${content}\n\n` : `<blockquote>${content}</blockquote>\n\n`
  }

  override html(token: Tokens.HTML | Tokens.Tag): string {
    return `${escapeHtml(token.text)}${token.block ? '\n\n' : ''}`
  }

  override def(): string {
    return ''
  }

  override heading({ tokens }: Tokens.Heading): string {
    return `<b>${this.parseInlineWithinEntity(tokens)}</b>\n\n`
  }

  override hr(): string {
    return '—\n\n'
  }

  override list(token: Tokens.List): string {
    const start = token.start === '' ? 1 : token.start
    const items = token.items.map((item, index) => {
      const marker = token.ordered
        ? `${start + index}. `
        : item.task
          ? ''
          : '• '
      const indentation = ' '.repeat(marker.length || 2)
      const content = trimBlock(this.parser.parse(item.tokens)).replaceAll(
        '\n',
        `\n${indentation}`,
      )
      return `${marker}${content}`
    })
    return `${items.join('\n')}\n\n`
  }

  override listitem({ tokens }: Tokens.ListItem): string {
    return `${trimBlock(this.parser.parse(tokens))}\n`
  }

  override checkbox({ checked }: Tokens.Checkbox): string {
    return checked ? '☑ ' : '☐ '
  }

  override paragraph({ tokens }: Tokens.Paragraph): string {
    return `${this.parser.parseInline(tokens)}\n\n`
  }

  override table(token: Tokens.Table): string {
    const row = (
      cells: ReadonlyArray<Tokens.TableCell>,
      withinEntity = false,
    ): string =>
      cells
        .map((cell) =>
          trimBlock(
            withinEntity
              ? this.parseInlineWithinEntity(cell.tokens)
              : this.parser.parseInline(cell.tokens),
          ),
        )
        .join(' | ')
    const header = `<b>${row(token.header, true)}</b>`
    return `${[header, ...token.rows.map((cells) => row(cells))].join('\n')}\n\n`
  }

  override tablerow({ text }: Tokens.TableRow): string {
    return `${text}\n`
  }

  override tablecell({ tokens }: Tokens.TableCell): string {
    return this.parser.parseInline(tokens)
  }

  override strong({ tokens }: Tokens.Strong): string {
    return `<b>${this.parseInlineWithinEntity(tokens)}</b>`
  }

  override em({ tokens }: Tokens.Em): string {
    return `<i>${this.parseInlineWithinEntity(tokens)}</i>`
  }

  override codespan({ text }: Tokens.Codespan): string {
    const escaped = escapeHtml(text)
    return this.entityDepth > 0 ? escaped : `<code>${escaped}</code>`
  }

  override br(): string {
    return '\n'
  }

  override del({ tokens }: Tokens.Del): string {
    return `<s>${this.parseInlineWithinEntity(tokens)}</s>`
  }

  override link({ href, tokens }: Tokens.Link): string {
    const label = this.parseInlineWithinEntity(tokens)
    const safeHref = safeLink(href)
    return safeHref === undefined
      ? `${label} (${escapeHtml(href)})`
      : `<a href="${escapeHtml(safeHref)}">${label}</a>`
  }

  override image({ href, text }: Tokens.Image): string {
    const label = `🖼 ${escapeHtml(text || href)}`
    const safeHref = safeLink(href)
    return safeHref === undefined
      ? label
      : `<a href="${escapeHtml(safeHref)}">${label}</a>`
  }

  override text(token: Tokens.Text | Tokens.Escape): string {
    return 'tokens' in token && token.tokens !== undefined
      ? this.parser.parseInline(token.tokens)
      : escapeHtml(token.text)
  }
}

const telegramMarkdown = new Marked().setOptions({
  async: false,
  gfm: true,
  renderer: new TelegramHtmlRenderer(),
})

interface BoundedText {
  readonly text: string
  readonly truncated: boolean
}

const boundUtf16 = (value: string, maximumLength: number): BoundedText => {
  if (value.length <= maximumLength) {
    return { text: value, truncated: false }
  }

  const lastCodeUnit = value.charCodeAt(maximumLength - 1)
  const safeEnd =
    lastCodeUnit >= 0xd800 && lastCodeUnit <= 0xdbff
      ? maximumLength - 1
      : maximumLength
  return { text: value.slice(0, safeEnd), truncated: true }
}

const htmlTokens = (html: string): ReadonlyArray<RegExpMatchArray> =>
  Array.from(html.matchAll(TELEGRAM_HTML_TAG))

const htmlTextLength = (html: string): number =>
  htmlTokens(html).reduce((length, match) => {
    const token = match[0]
    if (match.groups?.tag !== undefined) return length
    return length + (token.startsWith('&') ? 1 : token.length)
  }, 0)

const truncateTelegramHtml = (
  html: string,
  maximumTextLength: number,
): string => {
  if (htmlTextLength(html) <= maximumTextLength) return html

  const contentLimit = Math.max(0, maximumTextLength - 1)
  const openTags: Array<string> = []
  let output = ''
  let textLength = 0

  for (const match of htmlTokens(html)) {
    const token = match[0]
    const tag = match.groups?.tag
    if (tag !== undefined) {
      output += token
      if (match.groups?.closing === undefined) {
        openTags.push(tag)
      } else if (openTags.at(-1) === tag) {
        openTags.pop()
      }
      continue
    }

    const tokenLength = token.startsWith('&') ? 1 : token.length
    if (textLength + tokenLength > contentLimit) break
    output += token
    textLength += tokenLength
  }

  return `${output}…${openTags.toReversed().map((tag) => `</${tag}>`).join('')}`
}

export const renderMarkdownAsTelegramHtml = (
  markdown: string,
  maximumTextLength = TELEGRAM_MESSAGE_TEXT_LIMIT,
): string => {
  if (maximumTextLength <= 0) return ''

  const source = boundUtf16(
    markdown,
    maximumTextLength * SOURCE_LENGTH_FACTOR,
  )
  let rendered: string
  try {
    rendered = telegramMarkdown.parse(source.text, { async: false }).trim()
  } catch {
    rendered = escapeHtml(source.text).trim()
  }

  return truncateTelegramHtml(
    `${rendered}${source.truncated ? '…' : ''}`,
    maximumTextLength,
  )
}
