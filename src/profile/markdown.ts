// Copyright 2026 Stefan Prodan.
// SPDX-License-Identifier: Apache-2.0
// Markdown drawn on the server, as 1ctx does, so the web UI ships no parser.
// Any write key can change the profile, so this is the safety boundary:
// no raw HTML, no link but http(s) and mailto, no image fetched.

const OPTIONS = { noHtmlBlocks: true, noHtmlSpans: true } as const;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const SAFE_HREF = /^(https?:|mailto:)/i;

// only a plain language token is safe in an attribute
function language(info: string | undefined): string {
  const word = (info ?? "").trim().split(/\s+/)[0] ?? "";
  return /^[\w+#.-]{1,24}$/.test(word) ? word.toLowerCase() : "";
}

const TABLE_ALIGNMENTS = new Set(["left", "center", "right"]);

const tableAlign = (value: string | undefined) =>
  value !== undefined && TABLE_ALIGNMENTS.has(value)
    ? ` style="text-align:${value}"`
    : "";

const CALLBACKS = {
  text: (content: string) => escapeHtml(content),
  paragraph: (content: string) => `<p class="md-p">${content}</p>`,
  heading: (content: string, meta: { level: number }) =>
    `<h${meta.level} class="md-h${meta.level}">${content}</h${meta.level}>`,
  blockquote: (content: string) =>
    `<blockquote class="md-quote">${content}</blockquote>`,
  hr: () => '<hr class="md-hr">',
  strong: (content: string) => `<strong class="md-strong">${content}</strong>`,
  emphasis: (content: string) => `<em class="md-em">${content}</em>`,
  strikethrough: (content: string) => `<del class="md-del">${content}</del>`,
  codespan: (content: string) => `<code class="md-code">${content}</code>`,
  code: (content: string, meta?: { language?: string }) => {
    const lang = language(meta?.language);
    return `<pre class="md-pre"${lang ? ` data-lang="${escapeHtml(lang)}"` : ""}><code class="md-block-code">${content}</code></pre>`;
  },
  link: (content: string, meta: { href: string; title?: string }): string => {
    if (!SAFE_HREF.test(meta.href)) return content;
    const title = meta.title ? ` title="${escapeHtml(meta.title)}"` : "";
    return `<a class="md-link" href="${escapeHtml(meta.href)}"${title} target="_blank" rel="noopener">${content}</a>`;
  },
  // the source shown as text, so no text chooses a request the browser makes
  image: (content: string, meta: { src: string }) =>
    `<span class="md-img">[image${content ? `: ${content}` : ""}${
      meta.src ? ` ${escapeHtml(meta.src)}` : ""
    }]</span>`,
  list: (content: string, meta: { ordered: boolean; start?: number }) =>
    meta.ordered
      ? `<ol class="md-ol"${
          meta.start !== undefined && meta.start !== 1
            ? ` start="${meta.start}"`
            : ""
        }>${content}</ol>`
      : `<ul class="md-ul">${content}</ul>`,
  listItem: (content: string, meta: { checked?: boolean }) =>
    meta.checked === undefined
      ? `<li class="md-li">${content}</li>`
      : `<li class="md-li md-task"><input class="md-check" type="checkbox" disabled${
          meta.checked ? " checked" : ""
        }> ${content}</li>`,
  // the wrapper keeps a wide table inside the page
  table: (content: string) =>
    `<div class="md-table-wrap"><table class="md-table">${content}</table></div>`,
  thead: (content: string) => `<thead class="md-thead">${content}</thead>`,
  tbody: (content: string) => `<tbody class="md-tbody">${content}</tbody>`,
  tr: (content: string) => `<tr class="md-tr">${content}</tr>`,
  th: (content: string, meta?: { align?: string }) =>
    `<th class="md-th"${tableAlign(meta?.align)}>${content}</th>`,
  td: (content: string, meta?: { align?: string }) =>
    `<td class="md-td"${tableAlign(meta?.align)}>${content}</td>`,
};

// a parser failure keeps the text readable
export function renderMarkdown(md: string): string {
  if (md === "") return "";
  try {
    return Bun.markdown.render(md, CALLBACKS, OPTIONS);
  } catch {
    return `<p class="md-p">${escapeHtml(md)}</p>`;
  }
}
