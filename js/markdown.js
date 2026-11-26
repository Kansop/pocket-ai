// Small, safe Markdown renderer (escapes all HTML first). Supports fenced code,
// inline code, headings, bold/italic/strike, links, lists, blockquotes, tables, hr.
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const KW = new Set(('abstract and as async await break case catch class const continue def default del do elif else enum export extends false final finally fn for from func function go if impl import in interface is lambda let match mod new nil none not null or package pass private protected pub public raise return self static struct super switch this throw true try type typeof undefined use var void while with yield True False None print echo int float double char bool string boolean long short unsigned').split(' '));

function highlight(code, lang) {
  // Lightweight tokenizer: comments, strings, numbers, keywords, function calls.
  const l = (lang || '').toLowerCase();
  const hashComments = /^(py|python|sh|bash|shell|zsh|ruby|rb|yaml|yml|toml|r|perl|ps|powershell)$/.test(l);
  const re = hashComments
    ? /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g
    : /(\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->)|(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')|(\b\d+(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)(?=\s*\()|([A-Za-z_$][\w$]*)/g;
  let out = '', last = 0, m;
  while ((m = re.exec(code))) {
    out += esc(code.slice(last, m.index));
    const [t] = m;
    if (m[1]) out += `<span class="tok-c">${esc(t)}</span>`;
    else if (m[2]) out += `<span class="tok-s">${esc(t)}</span>`;
    else if (m[3]) out += `<span class="tok-n">${esc(t)}</span>`;
    else if (m[4]) out += KW.has(t) ? `<span class="tok-k">${esc(t)}</span>` : `<span class="tok-f">${esc(t)}</span>`;
    else out += KW.has(t) ? `<span class="tok-k">${esc(t)}</span>` : esc(t);
    last = m.index + t.length;
  }
  return out + esc(code.slice(last));
}

function inline(s) {
  // s is raw text; protect inline code first
  const codes = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`);
  s = s.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, p, u) => `${p}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`);
  s = s.replace(/\*\*\*([^*\n]+)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__([^_\n]+)__/g, '<strong>$1</strong>');
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, '$1<em>$2</em>');
  s = s.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  return s;
}

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map(c => c.trim());
}

export function renderMarkdown(src, { streaming = false } = {}) {
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let html = '';
  let i = 0;
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(inline).join('<br>')}</p>`; para = []; } };

  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      flush();
      const marker = fence[1][0].repeat(3);
      const lang = fence[2] || '';
      const buf = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker)) { closed = true; i++; break; }
        buf.push(lines[i]); i++;
      }
      const code = buf.join('\n');
      html += `<div class="code-block"><div class="code-head"><span>${esc(lang || 'code')}</span><button class="copy-code" type="button">Copy</button></div><pre><code>${highlight(code, lang)}${(!closed && streaming) ? '' : ''}</code></pre></div>`;
      continue;
    }
    if (/^\s*$/.test(line)) { flush(); i++; continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flush(); const n = Math.min(h[1].length, 4); html += `<h${n}>${inline(h[2].replace(/#+\s*$/, ''))}</h${n}>`; i++; continue; }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); html += '<hr>'; i++; continue; }
    if (/^\s*>/.test(line)) {
      flush();
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++; }
      html += `<blockquote>${renderMarkdown(buf.join('\n'))}</blockquote>`;
      continue;
    }
    // table
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      i += 2;
      let t = '<table><thead><tr>' + head.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        t += '<tr>' + splitRow(lines[i]).map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      html += t + '</tbody></table>';
      continue;
    }
    // lists
    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const start = ordered ? parseInt(li[2], 10) : 1;
      let items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (m && m[1].length <= li[1].length + 1 && (/\d/.test(m[2]) === ordered)) { items.push([m[3]]); i++; continue; }
        if (m && m[1].length > li[1].length + 1 && items.length) { items[items.length - 1].push(lines[i]); i++; continue; }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1].push(lines[i].trim()); i++; continue; }
        break;
      }
      const tag = ordered ? 'ol' : 'ul';
      html += `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>` + items.map(parts => {
        const [first, ...rest] = parts;
        const nested = rest.filter(r => /^\s*([-*+]|\d+[.)])\s+/.test(r));
        const extra = rest.filter(r => !/^\s*([-*+]|\d+[.)])\s+/.test(r));
        return `<li>${inline([first, ...extra].join(' '))}${nested.length ? renderMarkdown(nested.map(n => n.replace(/^\s+/, '')).join('\n')) : ''}</li>`;
      }).join('') + `</${tag}>`;
      continue;
    }
    para.push(line);
    i++;
  }
  flush();
  return html;
}

export { esc };
