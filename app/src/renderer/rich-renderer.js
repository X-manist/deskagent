'use strict';

(() => {
  function safeMediaUrl(raw) {
    const value = String(raw || '').trim();
    if (!value) return '';
    if (/^(https?:|file:|data:image\/)/i.test(value)) return value;
    if (/^\/[^/]/.test(value)) return 'file://' + value;
    return '';
  }

  function appendInline(parent, text) {
    const source = String(text || '');
    const pattern = /(!?\[([^\]]*)\]\(([^)]+)\))|(`([^`]+)`)|(\*\*([^*]+)\*\*)|(\$([^$\n]+)\$)|(\*([^*\n]+)\*)/g;
    let last = 0;
    let match;
    while ((match = pattern.exec(source))) {
      if (match.index > last) parent.appendChild(document.createTextNode(source.slice(last, match.index)));
      if (match[1] && match[1].startsWith('!')) {
        const link = document.createElement('a');
        const url = safeMediaUrl(match[3]);
        link.href = url || '#';
        link.textContent = match[2] || match[3];
        if (url) link.target = '_blank';
        parent.appendChild(link);
      } else if (match[1]) {
        const link = document.createElement('a');
        const url = safeMediaUrl(match[3]);
        link.href = url || '#';
        link.textContent = match[2] || match[3];
        if (url) link.target = '_blank';
        parent.appendChild(link);
      } else if (match[4]) {
        const code = document.createElement('code');
        code.textContent = match[5];
        parent.appendChild(code);
      } else if (match[6]) {
        const strong = document.createElement('strong');
        strong.textContent = match[7];
        parent.appendChild(strong);
      } else if (match[8]) {
        const math = document.createElement('span');
        math.className = 'math-inline';
        math.textContent = match[9];
        parent.appendChild(math);
      } else if (match[10]) {
        const em = document.createElement('em');
        em.textContent = match[11];
        parent.appendChild(em);
      }
      last = pattern.lastIndex;
    }
    if (last < source.length) parent.appendChild(document.createTextNode(source.slice(last)));
  }

  function parseTableCells(line) {
    let value = String(line || '').trim();
    if (value.startsWith('|')) value = value.slice(1);
    if (value.endsWith('|')) value = value.slice(0, -1);
    return value.split('|').map((cell) => cell.trim());
  }

  function isTableDivider(line) {
    const cells = parseTableCells(line);
    return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
  }

  function isImageLine(line) {
    return /^!\[[^\]]*]\([^)]+\)\s*$/.test(String(line || '').trim());
  }

  function isLinkOnlyLine(line) {
    return /^\[[^\]]+]\([^)]+\)\s*$/.test(String(line || '').trim());
  }

  function isFileLikeUrl(url) {
    return /\.(pdf|docx?|xlsx?|pptx?|csv|zip|txt|md)(\?|#|$)/i.test(String(url || ''));
  }

  function makeMediaCard(label, url, kind) {
    const safe = safeMediaUrl(url);
    const card = document.createElement('a');
    card.className = 'media-card';
    card.href = safe || '#';
    if (safe) card.target = '_blank';
    const icon = document.createElement('span');
    icon.className = 'media-icon';
    icon.textContent = kind === 'pdf' ? 'PDF' : '文';
    const body = document.createElement('span');
    const title = document.createElement('span');
    title.className = 'media-title';
    title.textContent = label || url;
    const meta = document.createElement('span');
    meta.className = 'media-url';
    meta.textContent = url;
    body.appendChild(title);
    body.appendChild(meta);
    card.appendChild(icon);
    card.appendChild(body);
    return card;
  }

  function appendParagraph(container, state) {
    if (!state.paragraph.length) return;
    const p = document.createElement('p');
    appendInline(p, state.paragraph.join('\n'));
    container.appendChild(p);
    state.paragraph = [];
  }

  function appendCodeBlock(container, lang, codeLines) {
    const pre = document.createElement('pre');
    const code = document.createElement('code');
    if (lang) code.dataset.lang = lang;
    code.textContent = codeLines.join('\n');
    pre.appendChild(code);
    container.appendChild(pre);
  }

  function appendTable(container, headers, rows) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    headers.forEach((cell) => {
      const th = document.createElement('th');
      appendInline(th, cell);
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.forEach((cell) => {
        const td = document.createElement('td');
        appendInline(td, cell);
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    container.appendChild(wrap);
  }

  function appendImage(container, line) {
    const match = line.trim().match(/^!\[([^\]]*)]\(([^)]+)\)$/);
    const url = match && safeMediaUrl(match[2]);
    if (!url) {
      const p = document.createElement('p');
      p.textContent = line;
      container.appendChild(p);
      return;
    }
    const figure = document.createElement('figure');
    figure.className = 'image-card';
    const img = document.createElement('img');
    img.src = url;
    img.alt = match[1] || '图片';
    figure.appendChild(img);
    if (match[1]) {
      const caption = document.createElement('figcaption');
      caption.textContent = match[1];
      figure.appendChild(caption);
    }
    container.appendChild(figure);
  }

  function renderRichText(container, text) {
    container.textContent = '';
    const root = document.createElement('div');
    root.className = 'rich';
    const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
    const state = { paragraph: [] };
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed) {
        appendParagraph(root, state);
        i += 1;
        continue;
      }

      const fence = trimmed.match(/^```([\w.+-]*)\s*$/);
      if (fence) {
        appendParagraph(root, state);
        i += 1;
        const codeLines = [];
        while (i < lines.length && !lines[i].trim().startsWith('```')) {
          codeLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        appendCodeBlock(root, fence[1], codeLines);
        continue;
      }

      if (trimmed.startsWith('$$') && trimmed.endsWith('$$') && trimmed.length > 4) {
        appendParagraph(root, state);
        const math = document.createElement('div');
        math.className = 'math-block';
        math.textContent = trimmed.slice(2, -2).trim();
        root.appendChild(math);
        i += 1;
        continue;
      }

      if (trimmed === '$$' || trimmed.startsWith('$$')) {
        appendParagraph(root, state);
        const mathLines = [];
        if (trimmed !== '$$') mathLines.push(trimmed.replace(/^\$\$|\$\$$/g, ''));
        i += 1;
        while (i < lines.length && lines[i].trim() !== '$$') {
          mathLines.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const math = document.createElement('div');
        math.className = 'math-block';
        math.textContent = mathLines.join('\n').trim();
        root.appendChild(math);
        continue;
      }

      const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
      if (heading) {
        appendParagraph(root, state);
        const h = document.createElement('h' + heading[1].length);
        appendInline(h, heading[2]);
        root.appendChild(h);
        i += 1;
        continue;
      }

      if (trimmed.includes('|') && i + 1 < lines.length && isTableDivider(lines[i + 1])) {
        appendParagraph(root, state);
        const headers = parseTableCells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].trim().includes('|') && lines[i].trim()) {
          rows.push(parseTableCells(lines[i]));
          i += 1;
        }
        appendTable(root, headers, rows);
        continue;
      }

      if (isImageLine(line)) {
        appendParagraph(root, state);
        appendImage(root, line);
        i += 1;
        continue;
      }

      if (isLinkOnlyLine(line)) {
        const match = trimmed.match(/^\[([^\]]+)]\(([^)]+)\)$/);
        if (isFileLikeUrl(match[2])) {
          appendParagraph(root, state);
          root.appendChild(makeMediaCard(match[1], match[2], /\.pdf(\?|#|$)/i.test(match[2]) ? 'pdf' : 'file'));
          i += 1;
          continue;
        }
      }

      const fileLink = trimmed.match(/^(.*?)(\[([^\]]+)]\(([^)]+)\))\s*$/);
      if (fileLink && isFileLikeUrl(fileLink[4])) {
        appendParagraph(root, state);
        if (fileLink[1].trim()) {
          const p = document.createElement('p');
          appendInline(p, fileLink[1].trim());
          root.appendChild(p);
        }
        root.appendChild(makeMediaCard(fileLink[3], fileLink[4], /\.pdf(\?|#|$)/i.test(fileLink[4]) ? 'pdf' : 'file'));
        i += 1;
        continue;
      }

      if (/^>\s+/.test(trimmed)) {
        appendParagraph(root, state);
        const quoteLines = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i += 1;
        }
        const quote = document.createElement('blockquote');
        appendInline(quote, quoteLines.join('\n'));
        root.appendChild(quote);
        continue;
      }

      if (/^([-*+]\s+|\d+\.\s+)/.test(trimmed)) {
        appendParagraph(root, state);
        const ordered = /^\d+\.\s+/.test(trimmed);
        const list = document.createElement(ordered ? 'ol' : 'ul');
        while (i < lines.length && (ordered ? /^\d+\.\s+/.test(lines[i].trim()) : /^[-*+]\s+/.test(lines[i].trim()))) {
          const li = document.createElement('li');
          appendInline(li, lines[i].trim().replace(/^([-*+]\s+|\d+\.\s+)/, ''));
          list.appendChild(li);
          i += 1;
        }
        root.appendChild(list);
        continue;
      }

      state.paragraph.push(line);
      i += 1;
    }
    appendParagraph(root, state);
    container.appendChild(root);
  }

  function renderMessageContent(bubble, role, text) {
    if (role === 'ai') renderRichText(bubble, text);
    else bubble.textContent = text || '';
  }

  window.DeskAgentRichRenderer = { renderMessageContent };
})();
