// A small, safe Markdown renderer for chat replies. Everything is HTML-escaped first; the only tags produced are the
// ones below, links are limited to http(s) and open in a new tab without a referrer. Model output is untrusted text.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const fmt = (t) => t
  .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
  .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
  .replace(/(^|[\s(])__([^_\n]+)__(?=[\s).,!?:;]|$)/g, '$1<strong>$2</strong>')
  .replace(/(^|[\s(])\*([^*\s][^*\n]*)\*(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
  .replace(/(^|[\s(])_([^_\s][^_\n]*)_(?=[\s).,!?:;]|$)/g, '$1<em>$2</em>')
  .replace(/~~([^~\n]+)~~/g, '<del>$1</del>');

/** Inline formatting: `code` first (verbatim), everything else formatted after escaping. */
export function inline(raw) {
  return String(raw).split(/(`[^`\n]+`)/).map((p, i) => (i % 2 ? `<code>${esc(p.slice(1, -1))}</code>` : fmt(esc(p)))).join('');
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
const isSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line) && line.includes('-');

/** Render Markdown prose (no fenced code: the caller splits those out) to HTML. */
export function renderMarkdown(text) {
  const lines = String(text ?? '').replace(/\r/g, '').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag, items }
  const flushPara = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((x) => `<li>${inline(x)}</li>`).join('')}</${list.tag}>`); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); flushList(); continue; }
    let m;
    if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.*)$/))) {
      flushPara(); flushList();
      const level = Math.min(6, Math.max(3, m[1].length + 1));
      out.push(`<h${level}>${inline(m[2].replace(/\s+#+\s*$/, ''))}</h${level}>`);
    } else if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushPara(); flushList();
      out.push('<hr>');
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      flushPara();
      if (!list || list.tag !== 'ul') { flushList(); list = { tag: 'ul', items: [] }; }
      list.items.push(m[1]);
    } else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
      flushPara();
      if (!list || list.tag !== 'ol') { flushList(); list = { tag: 'ol', items: [] }; }
      list.items.push(m[1]);
    } else if (/^\s*>\s?/.test(line)) {
      flushPara(); flushList();
      const q = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${q.map(inline).join('<br>')}</blockquote>`);
    } else if (line.includes('|') && i + 1 < lines.length && isSep(lines[i + 1])) {
      flushPara(); flushList();
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
      i--;
      out.push(`<div class="md-table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${head.map((_, k) => `<td>${inline(r[k] ?? '')}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
    } else if (list && /^\s{2,}\S/.test(line)) {
      list.items[list.items.length - 1] += ` ${line.trim()}`; // wrapped list item
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara(); flushList();
  return out.join('');
}
