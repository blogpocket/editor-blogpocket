/* =========================================================
   Editor · Blogpocket — lógica
   Vanilla JS, sin dependencias salvo marked, marked-footnote y DOMPurify (en /vendor).
   ========================================================= */
(() => {
  'use strict';

  const APP_VERSION = '1.1.0 · Claude 1.0';
  const $ = (s, root = document) => root.querySelector(s);
  const $$ = (s, root = document) => Array.from(root.querySelectorAll(s));
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
  const isTouch = window.matchMedia('(pointer: coarse)').matches;
  const MOD = isMac ? '⌘' : 'Ctrl';

  const ta = $('#editor');
  const hl = $('#highlight');
  const mirror = $('#mirror');
  const preview = $('#preview');
  const editorWrap = $('#editor-wrap');
  const selbar = $('#selbar');
  const linkForm = $('#link-form');
  const linkInput = $('#link-input');
  const toastEl = $('#toast');
  const root = document.documentElement;

  /* ---------------------------------------------------------
     Utilidades
     --------------------------------------------------------- */
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
  const lsGet = (k, d) => { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } };

  let toastTimer;
  function toast(msg, ms = 2200) {
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
  }

  /* ---------------------------------------------------------
     Ajustes
     --------------------------------------------------------- */
  const DEFAULTS = { theme: 'auto', font: 'mono', size: 'm', width: 'normal', focus: 'off' };
  const settings = Object.assign({}, DEFAULTS, lsGet('bp-editor-settings', {}));

  function applySettings() {
    if (settings.theme === 'auto') delete root.dataset.theme; else root.dataset.theme = settings.theme;
    root.dataset.font = settings.font;
    root.dataset.size = settings.size;
    root.dataset.width = settings.width;
    root.dataset.focus = settings.focus;
    $$('.seg').forEach((seg) => {
      const key = seg.dataset.setting;
      $$('button', seg).forEach((b) => b.classList.toggle('on', b.dataset.value === settings[key]));
    });
    const dark = settings.theme === 'dark' || (settings.theme === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
    $$('meta[name="theme-color"]').forEach((m) => m.setAttribute('content', dark ? '#1b1b1d' : '#f7f5f0'));
  }

  /* ---------------------------------------------------------
     Almacenamiento
     Con la base de datos del artefacto (claude.use("db")) los borradores
     viven fuera del navegador y Claude puede leerlos. Sin ella, IndexedDB.
     --------------------------------------------------------- */
  const LocalDB = (() => {
    let dbp;
    function open() {
      if (dbp) return dbp;
      dbp = new Promise((resolve, reject) => {
        const req = indexedDB.open('bp-editor', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('docs')) {
            const st = db.createObjectStore('docs', { keyPath: 'id' });
            st.createIndex('updated', 'updated');
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbp;
    }
    async function tx(mode, fn) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('docs', mode);
        const st = t.objectStore('docs');
        let result;
        Promise.resolve(fn(st)).then((r) => { result = r; });
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      });
    }
    const wrap = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });
    return {
      all: () => tx('readonly', (st) => wrap(st.getAll())),
      get: (id) => tx('readonly', (st) => wrap(st.get(id))),
      put: (doc) => tx('readwrite', (st) => wrap(st.put(doc))),
      del: (id) => tx('readwrite', (st) => wrap(st.delete(id))),
    };
  })();

  const withTimeout = (pr, ms, fallback) => Promise.race([pr, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  let remote = null;           // colección «drafts» de la base de datos del artefacto
  let dbRoot = null;           // la base de datos entera (para «config/sitios»)
  let assetsApi = null;        // subida de imágenes
  const known = new Set();     // ids que ya existen en la base de datos
  let writeChain = Promise.resolve();
  const snapDoc = (s) => ({ id: s.id, ...JSON.parse(JSON.stringify(s.data() || {})) });

  async function remotePut(doc) {
    const ref = remote.doc(doc.id);
    const body = { content: doc.content, updated: doc.updated };
    if (known.has(doc.id)) {
      try { await ref.update(body); return; } catch (err) {
        if (!err || err.code !== 'invalid_argument') throw err;
      }
    }
    await ref.set({ ...body, created: doc.created || doc.updated });
    known.add(doc.id);
  }

  const DB = {
    async all() {
      if (!remote) return LocalDB.all();
      const snap = await remote.get();
      return snap.docs.map((s) => { known.add(s.id); return snapDoc(s); });
    },
    async get(id) {
      if (!remote) return LocalDB.get(id);
      const s = await remote.doc(id).get();
      if (!s.exists) return undefined;
      known.add(id);
      return snapDoc(s);
    },
    put(doc) {
      if (!remote) return LocalDB.put(doc);
      // Una escritura cada vez, en orden
      const job = writeChain.then(() => remotePut(doc));
      writeChain = job.catch(() => {});
      return job;
    },
    async del(id) {
      if (!remote) return LocalDB.del(id);
      known.delete(id);
      await remote.doc(id).delete();
    },
    // Fusiona campos (p. ej. «envio») sin tocar el texto
    merge(id, fields) {
      if (!remote) return LocalDB.get(id).then((d) => LocalDB.put({ ...(d || { id }), ...fields }));
      const job = writeChain.then(() => remote.doc(id).update(fields));
      writeChain = job.catch(() => {});
      return job;
    },
  };

  let current = null;          // borrador abierto
  let dirty = false;
  let persistAsked = false;

  function newDoc(content = '') {
    const now = Date.now();
    return { id: uid(), content, created: now, updated: now };
  }

  async function saveNow() {
    if (!current) return;
    if (!dirty) return;
    current.content = ta.value;
    current.updated = Date.now();
    lsSet('bp-editor-backup', { id: current.id, content: current.content, updated: current.updated });
    try {
      await DB.put({ ...current });
      dirty = false;
      setSaveStatus('Guardado');
    } catch (err) {
      setSaveStatus('Error al guardar', true);
      console.error(err);
    }
    if (!persistAsked && navigator.storage && navigator.storage.persist) {
      persistAsked = true;
      navigator.storage.persist().catch(() => {});
    }
  }
  const saveSoon = debounce(() => saveNow(), 1200);

  function setSaveStatus(text, isDirty = false) {
    const el = $('#st-save');
    el.textContent = text;
    el.classList.toggle('dirty', isDirty);
  }

  /* ---------------------------------------------------------
     Títulos y estadísticas
     --------------------------------------------------------- */
  function plainInline(s) {
    return s
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/\[\^[^\]]+\]/g, '')
      .replace(/[*_~`]+/g, '')
      .replace(/<[^>]+>/g, '')
      .trim();
  }

  function docTitle(content) {
    const lines = content.split('\n');
    const h1 = lines.find((l) => /^#\s+\S/.test(l));
    const first = h1 || lines.find((l) => l.trim() && !/^(```|~~~|---|\*\*\*|___|\|)/.test(l.trim()));
    if (!first) return 'Sin título';
    const t = plainInline(first.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ''));
    return t ? (t.length > 70 ? t.slice(0, 68) + '…' : t) : 'Sin título';
  }

  const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'’\-]*/gu;
  function countWords(text) {
    const clean = text
      .replace(/^```[\s\S]*?^```/gm, (m) => m.replace(/```\w*/g, ''))
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\[\^[^\]]+\]:?/g, '')
      .replace(/<[^>]+>/g, '');
    const m = clean.match(WORD_RE);
    return m ? m.length : 0;
  }

  function updateStats() {
    const total = countWords(ta.value);
    const s = ta.selectionStart, e = ta.selectionEnd;
    const wEl = $('#st-words');
    if (e - s > 0) {
      const sel = countWords(ta.value.slice(s, e));
      wEl.textContent = `${sel} de ${total.toLocaleString('es-ES')} palabras`;
    } else {
      wEl.textContent = `${total.toLocaleString('es-ES')} ${total === 1 ? 'palabra' : 'palabras'}`;
    }
    const min = Math.max(total ? 1 : 0, Math.round(total / 220));
    $('#st-read').textContent = `${min} min de lectura`;
  }

  /* ---------------------------------------------------------
     Resaltado de Markdown
     La capa de resaltado reproduce el texto exacto del área de texto,
     carácter a carácter, para que el cursor encaje.
     --------------------------------------------------------- */
  const INLINE_RE = new RegExp([
    '(?<cm>`+)(?<cc>.+?)\\k<cm>',
    '!\\[(?<ia>[^\\]\\n]*)\\]\\((?<iu>[^)\\n]*)\\)',
    '\\[\\^(?<fr>[^\\]\\s]+)\\](?!:)',
    '\\[(?<lt>[^\\]\\n]+)\\]\\((?<lu>[^)\\n]*)\\)',
    '(?<bm>\\*\\*|__)(?=\\S)(?<bt>.*?\\S)\\k<bm>',
    '~~(?=\\S)(?<st>.*?\\S)~~',
    '(?<![*\\\\])\\*(?=[^\\s*])(?<it>[^*\\n]*?[^\\s*])\\*(?!\\*)',
    '(?<![\\p{L}\\p{N}_\\\\])_(?=[^\\s_])(?<iu2>[^_\\n]*?[^\\s_])_(?![\\p{L}\\p{N}_])',
    '(?<url>https?:\\/\\/[^\\s<>()"\']*[^\\s<>()"\'.,;:!?])',
    '(?<tag><\\/?[A-Za-z][^<>\\n]*>)',
  ].join('|'), 'gu');

  const mk = (s) => `<span class="mk">${esc(s)}</span>`;

  function inline(src, depth = 0) {
    if (depth > 4 || !src) return esc(src || '');
    let out = '';
    let last = 0;
    INLINE_RE.lastIndex = 0;
    const re = new RegExp(INLINE_RE.source, 'gu');
    let m;
    while ((m = re.exec(src))) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      out += esc(src.slice(last, m.index));
      const g = m.groups;
      if (g.cm !== undefined) {
        out += `<span class="c">${mk(g.cm)}${esc(g.cc)}${mk(g.cm)}</span>`;
      } else if (g.ia !== undefined) {
        out += `<span class="img">${mk('![')}${esc(g.ia)}${mk('](')}<span class="url">${esc(g.iu)}</span>${mk(')')}</span>`;
      } else if (g.fr !== undefined) {
        out += `<span class="fn">${esc(m[0])}</span>`;
      } else if (g.lt !== undefined) {
        out += `${mk('[')}<span class="lt">${inline(g.lt, depth + 1)}</span>${mk('](')}<span class="url">${esc(g.lu)}</span>${mk(')')}`;
      } else if (g.bm !== undefined) {
        out += `<span class="b">${mk(g.bm)}${inline(g.bt, depth + 1)}${mk(g.bm)}</span>`;
      } else if (g.st !== undefined) {
        out += `<span class="s">${mk('~~')}${inline(g.st, depth + 1)}${mk('~~')}</span>`;
      } else if (g.it !== undefined) {
        out += `<span class="i">${mk('*')}${inline(g.it, depth + 1)}${mk('*')}</span>`;
      } else if (g.iu2 !== undefined) {
        out += `<span class="i">${mk('_')}${inline(g.iu2, depth + 1)}${mk('_')}</span>`;
      } else if (g.url !== undefined) {
        out += `<span class="lt">${esc(g.url)}</span>`;
      } else if (g.tag !== undefined) {
        out += `<span class="html">${esc(g.tag)}</span>`;
      } else {
        out += esc(m[0]);
      }
      last = m.index + m[0].length;
    }
    out += esc(src.slice(last));
    return out;
  }

  const RE_FENCE = /^(\s{0,3})(`{3,}|~{3,})(.*)$/;
  const RE_HEADING = /^(\s{0,3})(#{1,6})(\s+)(.*)$/;
  const RE_HEADING_EMPTY = /^(\s{0,3})(#{1,6})\s*$/;
  const RE_HR = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const RE_QUOTE = /^(\s*(?:>\s?)+)(.*)$/;
  const RE_LIST = /^(\s*)([-*+]|\d{1,9}[.)])(\s+)(\[[ xX]\]\s+)?(.*)$/;
  const RE_FNDEF = /^(\[\^[^\]\s]+\]:)(.*)$/;
  const RE_TSEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function isTableSep(line) { return RE_TSEP.test(line) && line.includes('-') && line.includes('|'); }
  function looksTableRow(line) { return /\|/.test(line); }

  function renderTableRow(line) {
    const parts = line.split(/(?<!\\)(\|)/);
    return `<span class="tb-row">${parts.map((p) => (p === '|' ? mk('|') : inline(p))).join('')}</span>`;
  }

  // Devuelve { html, lineBlocks } — lineBlocks[i] = índice de bloque de la línea i (o -1 si está en blanco)
  function renderMarkdown(text) {
    const lines = text.split('\n');
    const htmlLines = new Array(lines.length);
    const lineBlocks = new Array(lines.length);
    let fence = null;
    let block = -1;
    let needNew = true;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let h;

      if (fence) {
        const fm = RE_FENCE.exec(line);
        if (fm && fm[2][0] === fence[0] && fm[2].length >= fence.length && !fm[3].trim()) {
          h = `<span class="pre">${esc(fm[1])}${mk(fm[2])}${esc(fm[3])}</span>`;
          fence = null;
          lineBlocks[i] = block;
          needNew = true;
        } else {
          h = `<span class="pre">${esc(line)}</span>`;
          lineBlocks[i] = block;
        }
        htmlLines[i] = h;
        continue;
      }

      if (!line.trim()) {
        htmlLines[i] = esc(line);
        lineBlocks[i] = -1;
        needNew = true;
        continue;
      }

      let m;
      let standalone = false;
      if ((m = RE_FENCE.exec(line))) {
        fence = m[2];
        h = `<span class="pre">${esc(m[1])}${mk(m[2])}<span class="mk">${esc(m[3])}</span></span>`;
        needNew = true;
      } else if ((m = RE_HEADING.exec(line))) {
        h = `<span class="h">${esc(m[1])}${mk(m[2])}${esc(m[3])}${inline(m[4])}</span>`;
        needNew = true; standalone = true;
      } else if ((m = RE_HEADING_EMPTY.exec(line))) {
        h = `<span class="h">${esc(m[1])}${mk(m[2])}${esc(line.slice(m[1].length + m[2].length))}</span>`;
        needNew = true; standalone = true;
      } else if (RE_HR.test(line) && !looksTableRow(line)) {
        h = `<span class="hr">${esc(line)}</span>`;
        needNew = true; standalone = true;
      } else if (looksTableRow(line) && isTableSep(line)) {
        h = `<span class="tb-sep">${esc(line)}</span>`;
      } else if (looksTableRow(line) && (/^\s*\|/.test(line) || isTableSep(lines[i + 1] || '') || isTableSep(lines[i - 1] || '') || (i > 1 && looksTableRow(lines[i - 1]) && /^\s*\|/.test(lines[i - 1])))) {
        h = renderTableRow(line);
      } else if ((m = RE_FNDEF.exec(line))) {
        h = `<span class="fnd">${mk(m[1])}${inline(m[2])}</span>`;
      } else if ((m = RE_QUOTE.exec(line))) {
        h = `<span class="q">${mk(m[1])}${inline(m[2])}</span>`;
      } else if ((m = RE_LIST.exec(line))) {
        h = `${esc(m[1])}<span class="li">${esc(m[2])}</span>${esc(m[3])}${m[4] ? mk(m[4]) : ''}${inline(m[5])}`;
      } else {
        h = inline(line);
      }

      if (needNew || standalone) block++;
      needNew = standalone;
      htmlLines[i] = h;
      lineBlocks[i] = block;
    }

    // Agrupa líneas consecutivas del mismo bloque
    let html = '';
    let i = 0;
    while (i < lines.length) {
      const b = lineBlocks[i];
      if (b < 0) {
        html += htmlLines[i];
        i++;
      } else {
        let j = i;
        const parts = [];
        while (j < lines.length && lineBlocks[j] === b) { parts.push(htmlLines[j]); j++; }
        html += `<span class="blk" data-b="${b}">${parts.join('\n')}</span>`;
        i = j;
      }
      if (i < lines.length) html += '\n';
    }
    return { html, lineBlocks };
  }

  let lineBlocks = [];
  function render() {
    const r = renderMarkdown(ta.value);
    lineBlocks = r.lineBlocks;
    // El espacio final da altura a una última línea vacía
    hl.innerHTML = r.html + '\n ';
    autosize();
    if (settings.focus === 'on') updateFocusBlock();
  }

  function autosize() {
    const y = window.scrollY;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
    if (window.scrollY !== y) window.scrollTo(0, y);
  }

  function lineIndexAt(pos) {
    let n = 0;
    const v = ta.value;
    for (let i = 0; i < pos && i < v.length; i++) if (v.charCodeAt(i) === 10) n++;
    return n;
  }

  let activeBlock = -2;
  function updateFocusBlock() {
    let li = lineIndexAt(ta.selectionStart);
    let b = lineBlocks[li];
    while (b === -1 && li > 0) { li--; b = lineBlocks[li]; }
    if (b === undefined) b = -1;
    if (b === activeBlock && hl.querySelector('.blk.active')) return;
    activeBlock = b;
    $$('.blk.active', hl).forEach((el) => el.classList.remove('active'));
    const el = hl.querySelector(`.blk[data-b="${b}"]`);
    if (el) el.classList.add('active');
  }

  /* ---------------------------------------------------------
     Posición del cursor en pantalla (div espejo)
     --------------------------------------------------------- */
  function caretRect(pos) {
    mirror.style.width = ta.clientWidth + 'px';
    const v = ta.value;
    mirror.textContent = v.slice(0, pos);
    const span = document.createElement('span');
    span.textContent = v.slice(pos, pos + 1) || '​';
    if (span.textContent === '\n') span.textContent = '​';
    mirror.appendChild(span);
    const r = ta.getBoundingClientRect();
    const lh = parseFloat(getComputedStyle(ta).lineHeight) || 28;
    return { left: r.left + span.offsetLeft, top: r.top + span.offsetTop, height: lh };
  }

  /* ---------------------------------------------------------
     Edición con deshacer nativo
     --------------------------------------------------------- */
  function replaceRange(start, end, text, selStart, selEnd) {
    ta.focus();
    ta.setSelectionRange(start, end);
    let ok = false;
    try {
      ok = text === '' ? (start === end ? true : document.execCommand('delete')) : document.execCommand('insertText', false, text);
    } catch { ok = false; }
    if (!ok) {
      ta.setRangeText(text, start, end, 'end');
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (selStart !== undefined) ta.setSelectionRange(selStart, selEnd === undefined ? selStart : selEnd);
  }

  function lineBounds(v, pos) {
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos);
    if (end === -1) end = v.length;
    return { start, end };
  }

  function selectedLines() {
    const v = ta.value;
    let s = ta.selectionStart, e = ta.selectionEnd;
    if (e > s && v[e - 1] === '\n') e--;
    const start = lineBounds(v, s).start;
    const end = lineBounds(v, e).end;
    return { start, end, text: v.slice(start, end), collapsed: ta.selectionStart === ta.selectionEnd, caret: ta.selectionStart };
  }

  /* ---------- Formato en línea ---------- */
  function runLen(v, pos, ch, dir) {
    let n = 0;
    if (dir < 0) { while (pos - 1 - n >= 0 && v[pos - 1 - n] === ch) n++; }
    else { while (pos + n < v.length && v[pos + n] === ch) n++; }
    return n;
  }

  function wordAt(v, pos) {
    const isW = (c) => c && /[\p{L}\p{N}'’\-]/u.test(c);
    let s = pos, e = pos;
    while (s > 0 && isW(v[s - 1])) s--;
    while (e < v.length && isW(v[e])) e++;
    return { s, e };
  }

  function isWrapped(v, s, e, marker) {
    const ch = marker[0];
    const before = runLen(v, s, ch, -1);
    const after = runLen(v, e, ch, 1);
    if (marker === '*') return before % 2 === 1 && after % 2 === 1;
    if (marker === '**') return before >= 2 && after >= 2 && before !== 4;
    return before >= marker.length && after >= marker.length;
  }

  function toggleInline(marker) {
    const v = ta.value;
    let s = ta.selectionStart, e = ta.selectionEnd;

    if (s === e) {
      // Sin selección: actúa sobre la palabra bajo el cursor o inserta marcadores vacíos
      if (isWrapped(v, s, e, marker) && v.slice(s - marker.length, s + marker.length) === marker + marker) {
        replaceRange(s - marker.length, s + marker.length, '', s - marker.length);
        return;
      }
      const w = wordAt(v, s);
      if (w.e > w.s) { s = w.s; e = w.e; }
      else { replaceRange(s, e, marker + marker, s + marker.length); return; }
    }

    // Recorta espacios de los bordes para que los marcadores abracen el texto
    while (s < e && /\s/.test(v[s])) s++;
    while (e > s && /\s/.test(v[e - 1])) e--;
    const sel = v.slice(s, e);

    if (isWrapped(v, s, e, marker)) {
      const L = marker.length;
      replaceRange(s - L, e + L, sel, s - L, e - L);
      return;
    }
    if (sel.length >= marker.length * 2 && sel.startsWith(marker) && sel.endsWith(marker)) {
      const inner = sel.slice(marker.length, sel.length - marker.length);
      if (marker !== '*' || !inner.startsWith('*')) {
        replaceRange(s, e, inner, s, s + inner.length);
        return;
      }
    }
    // Varias líneas: aplica a cada línea no vacía
    if (sel.includes('\n')) {
      const out = sel.split('\n').map((l) => {
        const m = /^(\s*)(.*?)(\s*)$/.exec(l);
        return m[2] ? m[1] + marker + m[2] + marker + m[3] : l;
      }).join('\n');
      replaceRange(s, e, out, s, s + out.length);
      return;
    }
    replaceRange(s, e, marker + sel + marker, s + marker.length, e + marker.length);
  }

  /* ---------- Enlaces ---------- */
  const URL_RE = /^(https?:\/\/|mailto:|www\.)\S+$/i;
  let pendingLinkRange = null;

  function linkCommand() {
    const v = ta.value;
    let s = ta.selectionStart, e = ta.selectionEnd;
    while (s < e && /\s/.test(v[s])) s++;
    while (e > s && /\s/.test(v[e - 1])) e--;
    const sel = v.slice(s, e);

    // Si ya es un enlace completo, lo quita
    const lm = /^\[([^\]]*)\]\([^)]*\)$/.exec(sel);
    if (lm) { replaceRange(s, e, lm[1], s, s + lm[1].length); return; }
    // Si el cursor está dentro del texto de un enlace [texto](url), lo quita
    if (v[s - 1] === '[' && v.slice(e, e + 2) === '](') {
      const close = v.indexOf(')', e + 2);
      if (close !== -1) { replaceRange(s - 1, close + 1, sel, s - 1, s - 1 + sel.length); return; }
    }

    if (s === e) { openLinkDialog(); return; }
    if (URL_RE.test(sel)) {
      const url = /^www\./i.test(sel) ? 'https://' + sel : sel;
      const t = `[](${url})`;
      replaceRange(s, e, t, s + 1);
      return;
    }
    pendingLinkRange = [s, e];
    showLinkForm();
  }

  function applyLink(url) {
    if (!pendingLinkRange) return;
    const [s, e] = pendingLinkRange;
    pendingLinkRange = null;
    url = url.trim();
    if (!url) { hideSelbar(); ta.focus(); ta.setSelectionRange(s, e); return; }
    if (/^www\./i.test(url)) url = 'https://' + url;
    const sel = ta.value.slice(s, e);
    const t = `[${sel}](${url})`;
    hideSelbar();
    replaceRange(s, e, t, s + t.length);
  }

  async function openLinkDialog() {
    const s = ta.selectionStart;
    const res = await dialog({
      title: 'Insertar enlace',
      body: `<label for="f-text">Texto</label><input type="text" id="f-text" name="text" autocomplete="off">
             <label for="f-url">Dirección</label><input type="url" id="f-url" name="url" placeholder="https://" autocomplete="off" inputmode="url">`,
      ok: 'Insertar',
    });
    ta.focus();
    if (!res || !res.url) { ta.setSelectionRange(s, s); return; }
    let url = res.url.trim();
    if (/^www\./i.test(url)) url = 'https://' + url;
    const text = res.text.trim() || url;
    const t = `[${text}](${url})`;
    replaceRange(s, s, t, s + t.length);
  }

  /* ---------- Formato de líneas ---------- */
  const stripHeading = (l) => l.replace(/^\s{0,3}#{1,6}(\s+|$)/, '');
  const stripList = (l) => l.replace(/^(\s*)(?:[-*+]|\d{1,9}[.)])\s+/, '$1');
  const stripQuote = (l) => l.replace(/^\s*>\s?/, '');

  function transformLines(fn) {
    const r = selectedLines();
    const lines = r.text.split('\n');
    const out = fn(lines, r);
    const text = out.join('\n');
    if (text === r.text) return;
    if (r.collapsed) {
      // Mantiene el cursor en el mismo punto del contenido
      const oldLine = lines[0], newLine = out[0];
      const offset = r.caret - r.start;
      const diff = newLine.length - oldLine.length;
      const newPos = Math.max(r.start, Math.min(r.start + newLine.length, r.start + offset + diff));
      replaceRange(r.start, r.end, text, newPos);
    } else {
      replaceRange(r.start, r.end, text, r.start, r.start + text.length);
    }
  }

  function headingCommand(level) {
    transformLines((lines) => {
      const allSame = lines.filter((l) => l.trim()).every((l) => new RegExp(`^\\s{0,3}#{${level}}(\\s|$)`).test(l));
      return lines.map((l) => {
        if (!l.trim() && lines.length > 1) return l;
        const base = stripList(stripQuote(stripHeading(l)));
        return allSame ? base : '#'.repeat(level) + ' ' + base;
      });
    });
  }

  function quoteCommand() {
    transformLines((lines) => {
      const all = lines.filter((l) => l.trim()).every((l) => /^\s*>/.test(l));
      return lines.map((l) => (all ? stripQuote(l) : (l.trim() ? '> ' + stripHeading(l) : '>')));
    });
  }

  function listCommand(ordered) {
    transformLines((lines, r) => {
      const re = ordered ? /^\s*\d{1,9}[.)]\s+/ : /^\s*[-*+]\s+/;
      const nonBlank = lines.filter((l) => l.trim());
      const all = nonBlank.length && nonBlank.every((l) => re.test(l));
      if (all) return lines.map((l) => stripList(l));
      // Continúa la numeración de la lista anterior
      let n = 1;
      if (ordered) {
        const v = ta.value;
        const prevEnd = r.start - 1;
        if (prevEnd > 0) {
          const pb = lineBounds(v, prevEnd);
          const pm = /^\s*(\d{1,9})[.)]\s+/.exec(v.slice(pb.start, pb.end));
          if (pm) n = parseInt(pm[1], 10) + 1;
        }
      }
      return lines.map((l) => {
        if (!l.trim() && lines.length > 1) return l;
        const m = /^(\s*)/.exec(l);
        const base = stripList(stripHeading(stripQuote(l))).trimStart();
        return m[1] + (ordered ? `${n++}. ` : '- ') + base;
      });
    });
  }

  /* ---------- Bloques ---------- */
  // Inserta un bloque en líneas propias, con línea en blanco antes y después
  function insertBlock(block, caretOffset, selectLen = 0) {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const lbS = lineBounds(v, s);
    const lbE = lineBounds(v, e);
    let start = s, end = e;
    let before = '', after = '';
    const lineBefore = v.slice(lbS.start, s);
    const lineAfter = v.slice(e, lbE.end);

    if (s === e && !lineBefore.trim() && !lineAfter.trim()) {
      // Línea vacía: la ocupa
      start = lbS.start; end = lbE.end;
    } else {
      if (lineBefore.length) before = '\n';
      if (lineAfter.length) after = '\n';
    }
    const prev = v.slice(0, start);
    if (prev.length && !/\n\n$/.test(prev + before)) before += (prev + before).endsWith('\n') ? '\n' : '\n\n';
    const next = v.slice(end);
    if (next.length && !/^\n\n/.test(after + next)) after += (after + next).startsWith('\n') ? '\n' : '\n\n';
    if (!next.length) after += '\n';

    const text = before + block + after;
    const caret = start + before.length + caretOffset;
    replaceRange(start, end, text, caret, caret + selectLen);
  }

  function codeBlockCommand() {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s !== e) {
      const r = selectedLines();
      const t = '```\n' + r.text + '\n```';
      replaceRange(r.start, r.end, t, r.start + 3);
      return;
    }
    // Si el cursor está dentro de una valla de código, no hace nada
    insertBlock('```\n\n```', 4);
  }

  function hrCommand() { insertBlock('---', 3); }

  async function imageCommand() {
    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = v.slice(s, e).trim();
    const res = await dialog({
      title: 'Insertar imagen',
      body: `<label for="f-iurl">Dirección de la imagen</label><input type="url" id="f-iurl" name="url" placeholder="https://tublog.com/wp-content/uploads/…" autocomplete="off" inputmode="url">
             <label for="f-alt">Texto alternativo (describe lo que se ve)</label><input type="text" id="f-alt" name="alt" autocomplete="off">
             <label for="f-ititle">Título (opcional)</label><input type="text" id="f-ititle" name="title" autocomplete="off">`,
      ok: 'Insertar',
      prefill: URL_RE.test(sel) ? { url: sel } : (sel ? { alt: sel } : {}),
    });
    ta.focus();
    ta.setSelectionRange(s, e);
    if (!res || !res.url.trim()) return;
    const title = res.title.trim() ? ` "${res.title.trim().replace(/"/g, '\\"')}"` : '';
    const md = `![${res.alt.trim()}](${res.url.trim()}${title})`;
    if (s !== e) ta.setSelectionRange(e, e);
    insertBlock(md, md.length);
  }

  /* ---------- Tablas ---------- */
  function tableAtCaret() {
    const v = ta.value;
    const lines = v.split('\n');
    const li = lineIndexAt(ta.selectionStart);
    if (!lines[li] || !lines[li].includes('|')) return null;
    let a = li, b = li;
    while (a > 0 && lines[a - 1].includes('|') && lines[a - 1].trim()) a--;
    while (b < lines.length - 1 && lines[b + 1].includes('|') && lines[b + 1].trim()) b++;
    const sepIdx = lines.slice(a, b + 1).findIndex((l) => RE_TSEP.test(l));
    if (sepIdx === -1) return null;
    let start = 0;
    for (let i = 0; i < a; i++) start += lines[i].length + 1;
    let end = start;
    for (let i = a; i <= b; i++) end += lines[i].length + (i < b ? 1 : 0);
    return { a, b, start, end, lines: lines.slice(a, b + 1), sepIdx };
  }

  function splitRow(line) {
    let l = line.trim();
    if (l.startsWith('|')) l = l.slice(1);
    if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
    return l.split(/(?<!\\)\|/).map((c) => c.trim());
  }

  function formatTable(t) {
    const rows = t.lines.map(splitRow);
    const cols = Math.max(...rows.map((r) => r.length));
    const aligns = rows[t.sepIdx].map((c) => {
      const L = c.startsWith(':'), R = c.endsWith(':');
      return L && R ? 'c' : R ? 'r' : L ? 'l' : '';
    });
    const width = new Array(cols).fill(3);
    rows.forEach((r, i) => { if (i === t.sepIdx) return; for (let c = 0; c < cols; c++) width[c] = Math.max(width[c], (r[c] || '').length); });
    return rows.map((r, i) => {
      const cells = [];
      for (let c = 0; c < cols; c++) {
        if (i === t.sepIdx) {
          const a = aligns[c] || '';
          const w = width[c];
          cells.push(a === 'c' ? ':' + '-'.repeat(w - 2) + ':' : a === 'r' ? '-'.repeat(w - 1) + ':' : a === 'l' ? ':' + '-'.repeat(w - 1) : '-'.repeat(w));
        } else {
          const txt = r[c] || '';
          const pad = width[c] - txt.length;
          cells.push(aligns[c] === 'r' ? ' '.repeat(pad) + txt : aligns[c] === 'c' ? ' '.repeat(Math.floor(pad / 2)) + txt + ' '.repeat(Math.ceil(pad / 2)) : txt + ' '.repeat(pad));
        }
      }
      return '| ' + cells.join(' | ') + ' |';
    }).join('\n');
  }

  async function tableCommand() {
    const t = tableAtCaret();
    if (t) {
      const formatted = formatTable(t);
      const li = lineIndexAt(ta.selectionStart) - t.a;
      replaceRange(t.start, t.end, formatted);
      // Deja el cursor en la misma fila
      const fl = formatted.split('\n');
      let pos = t.start;
      for (let i = 0; i < li; i++) pos += fl[i].length + 1;
      ta.setSelectionRange(pos + 2, pos + 2);
      toast('Tabla alineada');
      return;
    }

    const v = ta.value;
    const s = ta.selectionStart, e = ta.selectionEnd;
    const sel = v.slice(s, e);
    // Convierte en tabla un texto pegado desde una hoja de cálculo (tabuladores) o CSV con punto y coma
    if (sel.includes('\n') && (sel.includes('\t') || sel.includes(';'))) {
      const sep = sel.includes('\t') ? '\t' : ';';
      const rows = sel.trim().split('\n').map((l) => l.split(sep).map((c) => c.trim()));
      const cols = Math.max(...rows.map((r) => r.length));
      const lines = rows.map((r) => '| ' + Array.from({ length: cols }, (_, i) => r[i] || '').join(' | ') + ' |');
      lines.splice(1, 0, '| ' + Array(cols).fill('---').join(' | ') + ' |');
      const fake = { lines, sepIdx: 1 };
      const md = formatTable(fake);
      const r = selectedLines();
      replaceRange(r.start, r.end, md, r.start + md.length);
      toast('Texto convertido en tabla');
      return;
    }

    const res = await dialog({
      title: 'Insertar tabla',
      body: `<div class="row2">
               <div><label for="f-cols">Columnas</label><input type="number" id="f-cols" name="cols" min="1" max="12" value="3"></div>
               <div><label for="f-rows">Filas (sin la cabecera)</label><input type="number" id="f-rows" name="rows" min="1" max="50" value="2"></div>
             </div>
             <p>Consejo: con el cursor dentro de una tabla, este mismo botón alinea sus columnas. Tab salta a la celda siguiente.</p>`,
      ok: 'Insertar',
    });
    ta.focus();
    ta.setSelectionRange(s, e);
    if (!res) return;
    const cols = Math.min(12, Math.max(1, parseInt(res.cols, 10) || 3));
    const rows = Math.min(50, Math.max(1, parseInt(res.rows, 10) || 2));
    const head = Array.from({ length: cols }, (_, i) => `Columna ${i + 1}`);
    const lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map((h) => '-'.repeat(h.length)).join(' | ') + ' |'];
    for (let r = 0; r < rows; r++) lines.push('| ' + head.map((h) => ' '.repeat(h.length)).join(' | ') + ' |');
    const md = lines.join('\n');
    if (s !== e) ta.setSelectionRange(e, e);
    insertBlock(md, 2, head[0].length);
  }

  function tableTab(back) {
    const v = ta.value;
    const pos = ta.selectionStart;
    const lb = lineBounds(v, pos);
    const line = v.slice(lb.start, lb.end);
    if (!line.includes('|') || !tableAtCaret()) return false;
    const pipes = [];
    for (let i = 0; i < line.length; i++) if (line[i] === '|' && line[i - 1] !== '\\') pipes.push(lb.start + i);
    const cellStart = (p) => { let q = p + 1; while (v[q] === ' ') q++; return q; };
    if (!back) {
      const next = pipes.find((p) => p >= pos && p < lb.end - 1 && cellStart(p) < lb.end);
      const nextIsLast = next !== undefined && pipes.indexOf(next) === pipes.length - 1;
      if (next !== undefined && !nextIsLast) {
        const cs = cellStart(next);
        const ce = pipes[pipes.indexOf(next) + 1];
        let endText = ce; while (endText > cs && v[endText - 1] === ' ') endText--;
        ta.setSelectionRange(cs, Math.max(cs, endText));
        return true;
      }
      // Última celda: salta a la fila siguiente o crea una
      const nlb = lb.end < v.length ? lineBounds(v, lb.end + 1) : null;
      let nextLine = nlb ? v.slice(nlb.start, nlb.end) : '';
      if (nlb && RE_TSEP.test(nextLine)) {
        const nn = nlb.end < v.length ? lineBounds(v, nlb.end + 1) : null;
        if (nn && v.slice(nn.start, nn.end).includes('|')) { const q = nn.start + v.slice(nn.start, nn.end).indexOf('|'); ta.setSelectionRange(cellStart(q), cellStart(q)); return true; }
      } else if (nlb && nextLine.includes('|')) {
        const q = nlb.start + nextLine.indexOf('|');
        ta.setSelectionRange(cellStart(q), cellStart(q));
        return true;
      }
      const cols = Math.max(1, splitRow(line).length);
      const row = '\n|' + '   |'.repeat(cols);
      replaceRange(lb.end, lb.end, row, lb.end + 3);
      return true;
    }
    const prev = [...pipes].reverse().find((p) => cellStart(p) < pos && p < pos - 1);
    const idx = pipes.indexOf(prev);
    if (idx > 0) { const q = pipes[idx - 1]; const cs = cellStart(q); let ce = prev; while (ce > cs && v[ce - 1] === ' ') ce--; ta.setSelectionRange(cs, ce); return true; }
    if (lb.start > 0) {
      const plb = lineBounds(v, lb.start - 1);
      const pl = v.slice(plb.start, plb.end);
      if (pl.includes('|')) {
        const target = RE_TSEP.test(pl) && plb.start > 0 ? lineBounds(v, plb.start - 1) : plb;
        const tl = v.slice(target.start, target.end);
        const lastPipe = target.start + tl.lastIndexOf('|');
        let ce = lastPipe; while (ce > target.start && v[ce - 1] === ' ') ce--;
        const secondLast = target.start + tl.lastIndexOf('|', tl.lastIndexOf('|') - 1);
        ta.setSelectionRange(cellStart(secondLast), Math.max(cellStart(secondLast), ce));
      }
    }
    return true;
  }

  /* ---------- Notas al pie ---------- */
  let footnoteReturn = null;
  function footnoteCommand() {
    const v = ta.value;
    let n = 0;
    v.replace(/\[\^(\d+)\]/g, (_, d) => { n = Math.max(n, parseInt(d, 10)); return _; });
    n++;
    const ref = `[^${n}]`;
    const pos = ta.selectionEnd;
    replaceRange(pos, pos, ref);
    const afterRef = pos + ref.length;
    const v2 = ta.value;
    const trimmed = v2.replace(/\s+$/, '');
    const lastLine = trimmed.slice(trimmed.lastIndexOf('\n') + 1);
    const sep = /^\[\^[^\]]+\]:/.test(lastLine) ? '\n' : '\n\n';
    const def = sep + `[^${n}]: `;
    replaceRange(trimmed.length, v2.length, def, trimmed.length + def.length);
    footnoteReturn = afterRef;
    scrollCaretIntoView(true);
    toast('Escribe la nota. Pulsa Esc para volver al texto.', 3500);
  }

  /* ---------- Teclas especiales: Intro y Tab ---------- */
  function handleEnter(e) {
    const v = ta.value;
    const s = ta.selectionStart;
    if (s !== ta.selectionEnd) return false;
    const lb = lineBounds(v, s);
    const line = v.slice(lb.start, lb.end);
    const beforeCaret = v.slice(lb.start, s);

    let m = /^(\s*)([-*+]|(\d{1,9})([.)]))(\s+)(\[[ xX]\]\s+)?/.exec(line);
    if (m && beforeCaret.length >= m[0].length) {
      const rest = line.slice(m[0].length);
      if (!rest.trim()) {
        // Elemento vacío anidado: sube un nivel
        if (m[1].length) {
          const unit = /^\d/.test(m[2]) ? 3 : 2;
          const cut = Math.min(unit, m[1].length);
          replaceRange(lb.start, lb.start + cut, '', Math.max(lb.start, s - cut));
          return true;
        }
        // Elemento vacío: termina la lista y deja una línea en blanco
        replaceRange(lb.start, lb.end, '\n', lb.start + 1);
        return true;
      }
      const marker = m[3] ? `${parseInt(m[3], 10) + 1}${m[4]}` : m[2];
      const ins = '\n' + m[1] + marker + m[5] + (m[6] ? '[ ] ' : '');
      replaceRange(s, s, ins, s + ins.length);
      return true;
    }
    m = /^(\s*(?:>\s?)+)/.exec(line);
    if (m && beforeCaret.length >= m[0].length) {
      if (!line.slice(m[0].length).trim()) { replaceRange(lb.start, lb.end, '\n', lb.start + 1); return true; }
      const ins = '\n' + m[1].replace(/\s*$/, ' ');
      replaceRange(s, s, ins, s + ins.length);
      return true;
    }
    return false;
  }

  function handleTab(back) {
    if (tableTab(back)) return true;
    const r = selectedLines();
    const lines = r.text.split('\n');
    const isList = lines.every((l) => !l.trim() || /^\s*([-*+]|\d{1,9}[.)])\s+/.test(l));
    if (!isList) return true; // evita que el foco salga del editor
    const out = lines.map((l) => {
      if (!l.trim()) return l;
      const unit = /^\s*\d/.test(l) ? '   ' : '  ';
      if (back) return l.replace(new RegExp(`^ {1,${unit.length}}`), '');
      return unit + l;
    });
    const text = out.join('\n');
    if (text === r.text) return true;
    if (r.collapsed) {
      const diff = out[0].length - lines[0].length;
      replaceRange(r.start, r.end, text, Math.max(r.start, r.caret + diff));
    } else {
      replaceRange(r.start, r.end, text, r.start, r.start + text.length);
    }
    return true;
  }

  /* ---------- Despachador de órdenes ---------- */
  const COMMANDS = {
    bold: () => toggleInline('**'),
    italic: () => toggleInline('*'),
    strike: () => toggleInline('~~'),
    code: () => toggleInline('`'),
    link: linkCommand,
    h2: () => headingCommand(2),
    h3: () => headingCommand(3),
    h4: () => headingCommand(4),
    ul: () => listCommand(false),
    ol: () => listCommand(true),
    quote: quoteCommand,
    codeblock: codeBlockCommand,
    table: tableCommand,
    footnote: footnoteCommand,
    image: imageCommand,
    hr: hrCommand,
  };
  function run(cmd) {
    if (previewOn) togglePreview(false);
    const fn = COMMANDS[cmd];
    if (fn) fn();
    if (cmd !== 'link') hideSelbarSoon();
  }

  /* ---------------------------------------------------------
     Barra flotante de selección
     --------------------------------------------------------- */
  let mouseDown = false;
  function showSelbar() {
    if (previewOn) return;
    const s = ta.selectionStart, e = ta.selectionEnd;
    if (s === e || document.activeElement !== ta) { if (linkForm.hidden) hideSelbar(); return; }
    selbar.hidden = false;
    $('.selbar-btns', selbar).hidden = false;
    linkForm.hidden = true;
    positionSelbar();
  }

  function positionSelbar() {
    if (selbar.hidden) return;
    if (isTouch) {
      selbar.classList.add('docked');
      const vv = window.visualViewport;
      const bottomGap = vv ? (window.innerHeight - vv.height - vv.offsetTop) : 0;
      selbar.style.bottom = (Math.max(0, bottomGap) + 44) + 'px';
      return;
    }
    selbar.classList.remove('docked');
    const s = ta.selectionStart, e = ta.selectionEnd;
    const a = caretRect(s);
    const b = caretRect(e);
    const w = selbar.offsetWidth, h = selbar.offsetHeight;
    const sameLine = Math.abs(a.top - b.top) < 2;
    let x = sameLine ? (a.left + b.left) / 2 - w / 2 : a.left - 8;
    let y = a.top - h - 10;
    const topLimit = (parseFloat(getComputedStyle(root).getPropertyValue('--topbar-h')) || 52) + 8;
    if (y < topLimit) y = b.top + b.height + 10;
    x = Math.max(10, Math.min(window.innerWidth - w - 10, x));
    selbar.style.left = x + 'px';
    selbar.style.top = y + 'px';
  }

  function showLinkForm() {
    selbar.hidden = false;
    $('.selbar-btns', selbar).hidden = true;
    linkForm.hidden = false;
    linkInput.value = '';
    positionSelbar();
    // Si hay una URL en el portapapeles la propone
    if (navigator.clipboard && navigator.clipboard.readText && !isTouch) {
      navigator.clipboard.readText().then((t) => {
        t = (t || '').trim();
        if (URL_RE.test(t) && !linkInput.value) { linkInput.value = t; linkInput.select(); }
      }).catch(() => {});
    }
    setTimeout(() => linkInput.focus(), 0);
  }

  function hideSelbar() {
    selbar.hidden = true;
    linkForm.hidden = true;
    $('.selbar-btns', selbar).hidden = false;
  }
  const showSelbarSoon = debounce(() => { if (!mouseDown) showSelbar(); }, 140);
  const hideSelbarSoon = () => setTimeout(() => { if (ta.selectionStart === ta.selectionEnd && linkForm.hidden) hideSelbar(); else if (!selbar.hidden) positionSelbar(); }, 0);

  selbar.addEventListener('mousedown', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
  selbar.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cmd]');
    if (b) run(b.dataset.cmd);
  });
  linkForm.addEventListener('submit', (e) => { e.preventDefault(); applyLink(linkInput.value); });
  linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      const r = pendingLinkRange;
      pendingLinkRange = null;
      hideSelbar();
      ta.focus();
      if (r) ta.setSelectionRange(r[0], r[1]);
    }
  });
  linkInput.addEventListener('blur', () => {
    setTimeout(() => {
      if (document.activeElement !== linkInput && !linkForm.hidden) {
        pendingLinkRange = null;
        hideSelbar();
      }
    }, 150);
  });

  /* ---------------------------------------------------------
     Desplazamiento: mantener el cursor a la vista
     --------------------------------------------------------- */
  function scrollCaretIntoView(center = false) {
    const r = caretRect(ta.selectionEnd);
    const vv = window.visualViewport;
    const vh = vv ? vv.height : window.innerHeight;
    const top = (parseFloat(getComputedStyle(root).getPropertyValue('--topbar-h')) || 52) + 20;
    if (settings.focus === 'on' || center) {
      const target = vh * 0.42;
      const delta = r.top - target;
      if (Math.abs(delta) > r.height * 0.6) window.scrollBy(0, delta);
      return;
    }
    const bottomLimit = vh - 70;
    if (r.top + r.height > bottomLimit) window.scrollBy(0, r.top + r.height - bottomLimit);
    else if (r.top < top) window.scrollBy(0, r.top - top);
  }

  /* ---------------------------------------------------------
     Eventos del editor
     --------------------------------------------------------- */
  ta.addEventListener('input', () => {
    render();
    updateStats();
    dirty = true;
    setSaveStatus('Sin guardar', true);
    saveSoon();
    if (!selbar.hidden && ta.selectionStart === ta.selectionEnd && linkForm.hidden) hideSelbar();
    requestAnimationFrame(() => scrollCaretIntoView());
  });

  // Indicador de «escribiendo» para apagar las barras
  let typingIdle;
  function markTyping() {
    document.body.classList.add('typing');
    clearTimeout(typingIdle);
    typingIdle = setTimeout(() => document.body.classList.remove('typing'), 3000);
  }
  let lastMouse = [0, 0];
  window.addEventListener('mousemove', (e) => {
    if (Math.abs(e.clientX - lastMouse[0]) + Math.abs(e.clientY - lastMouse[1]) > 6) {
      document.body.classList.remove('typing');
    }
    lastMouse = [e.clientX, e.clientY];
  }, { passive: true });

  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.keyCode === 229) return;
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (e.key === 'Enter' && !e.shiftKey && !mod && !e.altKey) {
      if (handleEnter(e)) { e.preventDefault(); return; }
    }
    if (e.key === 'Tab' && !mod && !e.altKey) {
      if (handleTab(e.shiftKey)) e.preventDefault();
      return;
    }
    if (!mod && !e.altKey && (e.key.length === 1 || e.key === 'Backspace' || e.key === 'Enter')) markTyping();
  });

  // Pegar una URL sobre texto seleccionado crea el enlace
  ta.addEventListener('paste', (e) => {
    const s = ta.selectionStart, end = ta.selectionEnd;
    if (s === end) return;
    const text = (e.clipboardData && e.clipboardData.getData('text/plain') || '').trim();
    if (!URL_RE.test(text)) return;
    const sel = ta.value.slice(s, end);
    if (URL_RE.test(sel.trim()) || sel.includes('\n')) return;
    e.preventDefault();
    const t = `[${sel}](${text})`;
    replaceRange(s, end, t, s + t.length);
  });

  ta.addEventListener('mousedown', () => { mouseDown = true; hideSelbar(); });
  window.addEventListener('mouseup', () => { if (mouseDown) { mouseDown = false; showSelbarSoon(); } });

  document.addEventListener('selectionchange', () => {
    if (document.activeElement !== ta) return;
    updateStats();
    updateToolbarState();
    if (settings.focus === 'on') updateFocusBlock();
    if (ta.selectionStart === ta.selectionEnd) { if (linkForm.hidden) hideSelbar(); }
    else showSelbarSoon();
  });

  window.addEventListener('scroll', () => { if (!selbar.hidden && !isTouch) positionSelbar(); }, { passive: true });
  window.addEventListener('resize', () => { autosize(); positionSelbar(); });
  if (window.visualViewport) {
    visualViewport.addEventListener('resize', () => positionSelbar());
    visualViewport.addEventListener('scroll', () => positionSelbar());
  }

  // Estado activo de los botones de la barra superior según la línea actual
  function updateToolbarState() {
    const v = ta.value;
    const lb = lineBounds(v, ta.selectionStart);
    const line = v.slice(lb.start, lb.end);
    const hm = /^\s{0,3}(#{1,6})(\s|$)/.exec(line);
    const state = {
      h2: hm && hm[1].length === 2,
      h3: hm && hm[1].length === 3,
      h4: hm && hm[1].length === 4,
      ul: /^\s*[-*+]\s+/.test(line),
      ol: /^\s*\d{1,9}[.)]\s+/.test(line),
      quote: /^\s*>/.test(line),
    };
    $$('#format-bar .tb[data-cmd]').forEach((b) => b.classList.toggle('active', !!state[b.dataset.cmd]));
  }

  /* ---------------------------------------------------------
     Vista previa y exportación
     --------------------------------------------------------- */
  marked.use({ gfm: true, breaks: false });
  marked.use(markedFootnote({
    description: 'Notas',
    headingClass: 'footnotes-title',
    backRefLabel: 'Volver a la referencia {0}',
    prefixId: 'nota-',
  }));

  function toHtml(md, { dropTitle = false } = {}) {
    let src = md;
    if (dropTitle) src = src.replace(/^\s*#\s+[^\n]*\n?/, '');
    const raw = marked.parse(src);
    return DOMPurify.sanitize(raw, { ADD_ATTR: ['target', 'data-footnote-ref', 'data-footnotes', 'data-footnote-backref'] });
  }

  let previewOn = false;
  function togglePreview(force) {
    previewOn = force === undefined ? !previewOn : force;
    $('#btn-preview').classList.toggle('active', previewOn);
    if (previewOn) {
      const ratio = window.scrollY / Math.max(1, document.documentElement.scrollHeight - window.innerHeight);
      const html = toHtml(ta.value);
      preview.innerHTML = html.trim() ? html : '<p class="preview-empty">No hay nada que previsualizar todavía.</p>';
      $$('a[href^="http"]', preview).forEach((a) => { a.target = '_blank'; a.rel = 'noopener'; });
      editorWrap.hidden = true;
      preview.hidden = false;
      hideSelbar();
      requestAnimationFrame(() => window.scrollTo(0, ratio * (document.documentElement.scrollHeight - window.innerHeight)));
    } else {
      preview.hidden = true;
      editorWrap.hidden = false;
      autosize();
      ta.focus({ preventScroll: true });
    }
  }

  function slugify(s) {
    return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'borrador';
  }

  function download(name, content, type) {
    const blob = new Blob([content], { type });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  async function copyText(text, html) {
    try {
      if (html && window.ClipboardItem && navigator.clipboard.write) {
        await navigator.clipboard.write([new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        })]);
      } else {
        await navigator.clipboard.writeText(text);
      }
      return true;
    } catch {
      // Recurso para navegadores sin API del portapapeles
      const t = document.createElement('textarea');
      t.value = text;
      t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.appendChild(t);
      t.select();
      let ok = false;
      try { ok = document.execCommand('copy'); } catch { ok = false; }
      t.remove();
      return ok;
    }
  }

  async function doExport(kind) {
    closeMenus();
    const md = ta.value;
    const title = docTitle(md);
    const slug = slugify(title);
    if (kind === 'copy-md') {
      toast((await copyText(md)) ? 'Markdown copiado' : 'No se pudo copiar');
    } else if (kind === 'copy-html') {
      const html = toHtml(md, { dropTitle: true });
      toast((await copyText(html, html)) ? 'HTML copiado (sin el título)' : 'No se pudo copiar');
    } else if (kind === 'download-md') {
      download(slug + '.md', md, 'text/markdown;charset=utf-8');
    } else if (kind === 'download-html') {
      const body = toHtml(md);
      const doc = `<!doctype html>\n<html lang="es">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<title>${esc(title)}</title>\n</head>\n<body>\n${body}\n</body>\n</html>\n`;
      download(slug + '.html', doc, 'text/html;charset=utf-8');
    } else if (kind === 'import') {
      $('#file-input').click();
    } else if (kind === 'backup') {
      await backupAll();
    } else if (kind === 'restore') {
      $('#backup-input').click();
    }
  }

  /* ---------- Copia de seguridad de todos los borradores ---------- */
  async function backupAll() {
    if (dirty) await saveNow();
    const docs = (await DB.all()).filter((d) => d.content && d.content.trim());
    if (!docs.length) { toast('No hay borradores que guardar'); return; }
    const data = { app: 'editor-blogpocket', format: 1, version: APP_VERSION, exported: new Date().toISOString(), docs };
    const d = new Date();
    const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    download(`editor-copia-${stamp}.json`, JSON.stringify(data, null, 2), 'application/json;charset=utf-8');
    lsSet('bp-editor-last-backup', Date.now());
    toast(`Copia descargada: ${docs.length} ${docs.length === 1 ? 'borrador' : 'borradores'}`);
  }

  async function restoreBackup(file) {
    if (!file) return;
    if (file.size > 50 * 1024 * 1024) { toast('El archivo es demasiado grande'); return; }
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('El archivo no es una copia válida'); return; }
    if (!data || data.app !== 'editor-blogpocket' || !Array.isArray(data.docs)) { toast('El archivo no es una copia de este editor'); return; }
    const valid = data.docs.filter((d) => d && typeof d.id === 'string' && typeof d.content === 'string' && Number.isFinite(d.updated));
    const existing = new Map((await DB.all()).map((d) => [d.id, d]));
    let added = 0, updated = 0, kept = 0;
    for (const d of valid) {
      const doc = { id: d.id, content: d.content, created: Number.isFinite(d.created) ? d.created : d.updated, updated: d.updated };
      const cur = existing.get(doc.id);
      if (!cur) { await DB.put(doc); added++; }
      else if (doc.updated > cur.updated) { await DB.put(doc); updated++; }
      else kept++;
    }
    // Si se ha actualizado el borrador abierto, lo recarga
    if (current) {
      const fresh = await DB.get(current.id);
      if (fresh && fresh.updated > current.updated && fresh.content !== ta.value) { current = fresh; dirty = false; loadIntoEditor(current); }
    }
    if (!$('#drawer').hidden) renderDraftList();
    const parts = [];
    if (added) parts.push(`${added} ${added === 1 ? 'nuevo' : 'nuevos'}`);
    if (updated) parts.push(`${updated} ${updated === 1 ? 'actualizado' : 'actualizados'}`);
    if (kept) parts.push(`${kept} sin cambios`);
    toast(parts.length ? `Copia restaurada: ${parts.join(', ')}` : 'La copia estaba vacía', 3500);
  }
  $('#backup-input').addEventListener('change', (e) => { restoreBackup(e.target.files[0]); e.target.value = ''; });

  async function importFile(file) {
    if (!file) return;
    if (file.size > 5 * 1024 * 1024) { toast('El archivo es demasiado grande'); return; }
    const text = await file.text();
    await saveNow();
    await discardIfEmpty();
    current = newDoc(text.replace(/\r\n?/g, '\n'));
    dirty = true;
    loadIntoEditor(current, 0);
    await saveNow();
    toast(`Abierto «${file.name}» como borrador nuevo`);
  }
  $('#file-input').addEventListener('change', (e) => { importFile(e.target.files[0]); e.target.value = ''; });

  // Arrastrar un .md a la ventana
  window.addEventListener('dragover', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  window.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files[0];
    if (f && /\.(md|markdown|txt)$/i.test(f.name)) { e.preventDefault(); importFile(f); }
  });

  /* ---------------------------------------------------------
     Borradores
     --------------------------------------------------------- */
  function loadIntoEditor(doc, caret) {
    ta.value = doc.content;
    lsSet('bp-editor-current', doc.id);
    render();
    updateStats();
    setSaveStatus(dirty ? 'Sin guardar' : 'Guardado', dirty);
    renderEnvio();
    const pos = caret === undefined ? doc.content.length : caret;
    ta.focus({ preventScroll: true });
    ta.setSelectionRange(pos, pos);
    if (caret === 0) window.scrollTo(0, 0);
    else requestAnimationFrame(() => scrollCaretIntoView(true));
    updateToolbarState();
  }

  async function discardIfEmpty() {
    if (current && !ta.value.trim()) {
      try { await DB.del(current.id); } catch { /* nada */ }
    }
  }

  async function newDraft() {
    if (current && !ta.value.trim()) { closeDrawer(); ta.focus(); return; }
    await saveNow();
    current = newDoc('');
    dirty = false;
    loadIntoEditor(current, 0);
    closeDrawer();
    if (previewOn) togglePreview(false);
  }

  async function openDraft(id) {
    if (current && id === current.id) { closeDrawer(); return; }
    await saveNow();
    await discardIfEmpty();
    const doc = await DB.get(id);
    if (!doc) return;
    current = doc;
    dirty = false;
    if (previewOn) togglePreview(false);
    loadIntoEditor(doc);
    closeDrawer();
  }

  async function deleteDraft(id) {
    const doc = await DB.get(id);
    const title = doc ? docTitle(doc.content) : 'este borrador';
    const res = await dialog({
      title: 'Borrar borrador',
      body: `<p>Vas a borrar «<span id="del-title"></span>». No se puede deshacer.</p>`,
      ok: 'Borrar',
      danger: true,
      onOpen: (body) => { $('#del-title', body).textContent = title; },
    });
    if (!res) return;
    await DB.del(id);
    if (current && current.id === id) {
      const all = (await DB.all()).sort((a, b) => b.updated - a.updated);
      if (all.length) { current = all[0]; dirty = false; loadIntoEditor(current); }
      else { current = newDoc(''); dirty = false; loadIntoEditor(current, 0); }
    }
    renderDraftList();
    toast('Borrador borrado');
  }

  function fmtDate(ts) {
    const d = new Date(ts);
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const yest = new Date(now); yest.setDate(now.getDate() - 1);
    const time = d.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    if (sameDay) return `Hoy, ${time}`;
    if (d.toDateString() === yest.toDateString()) return `Ayer, ${time}`;
    return d.toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  async function renderDraftList() {
    const list = $('#draft-list');
    const q = $('#draft-search').value.trim().toLowerCase();
    let docs = await DB.all();
    // El borrador actual con su contenido en vivo
    if (current) {
      const live = { ...current, content: ta.value };
      const i = docs.findIndex((d) => d.id === current.id);
      if (i >= 0) docs[i] = live; else if (ta.value.trim()) docs.push(live);
    }
    docs = docs.filter((d) => d.content.trim() || (current && d.id === current.id));
    docs.sort((a, b) => b.updated - a.updated);
    if (q) docs = docs.filter((d) => d.content.toLowerCase().includes(q));
    list.textContent = '';
    if (!docs.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = q ? 'Ningún borrador coincide.' : 'Aún no hay borradores.';
      list.appendChild(li);
      return;
    }
    for (const d of docs) {
      const li = document.createElement('li');
      li.dataset.id = d.id;
      if (current && d.id === current.id) li.classList.add('current');
      const t = document.createElement('div'); t.className = 'd-title'; t.textContent = d.content.trim() ? docTitle(d.content) : 'Borrador vacío';
      const m = document.createElement('div'); m.className = 'd-meta';
      const w = countWords(d.content);
      m.textContent = `${fmtDate(d.updated)} · ${w.toLocaleString('es-ES')} ${w === 1 ? 'palabra' : 'palabras'}`;
      const env = d.envio && ENVIO_CORTO[d.envio.estado];
      if (env) { const s = document.createElement('span'); s.className = 'd-env'; s.textContent = ' · ' + env; m.appendChild(s); }
      const del = document.createElement('button');
      del.className = 'd-del'; del.title = 'Borrar'; del.setAttribute('aria-label', 'Borrar borrador');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12"/></svg>';
      li.append(t, m, del);
      list.appendChild(li);
    }
  }

  $('#draft-list').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-id]');
    if (!li) return;
    if (e.target.closest('.d-del')) { e.stopPropagation(); deleteDraft(li.dataset.id); return; }
    openDraft(li.dataset.id);
  });
  $('#draft-search').addEventListener('input', debounce(renderDraftList, 120));
  $('#btn-new').addEventListener('click', newDraft);

  function openDrawer() {
    closeMenus();
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
    $('#draft-search').value = '';
    renderDraftList();
    if (!isTouch) setTimeout(() => $('#draft-search').focus(), 50);
  }
  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
  }
  $('#btn-drafts').addEventListener('click', () => ($('#drawer').hidden ? openDrawer() : closeDrawer()));
  $('#scrim').addEventListener('click', closeDrawer);


  /* ---------------------------------------------------------
     Envío a Claude
     El borrador guarda en «envio» lo que Claude necesita para publicarlo.
     Claude actualiza «estado» (publicando, borrador_wp, error) al terminar.
     --------------------------------------------------------- */
  const ENVIO_LARGO = {
    pendiente: 'Enviado a Claude · pendiente',
    publicando: 'Claude lo está publicando…',
    borrador_wp: 'En WordPress como borrador',
    publicado: 'Publicado en WordPress',
    error: 'Error al publicar',
  };
  const ENVIO_CORTO = { pendiente: 'enviado', publicando: 'publicando', borrador_wp: 'en WordPress', publicado: 'publicado', error: 'error' };
  const PHRASE = 'Publica lo del editor';

  /* ---------- Sitios de WordPress (Ajustes) ---------- */
  let sitios = lsGet('bp-editor-sitios', []);
  const onSite = (url) => typeof url === 'string' && sitios.some((s) => url === s || url.startsWith(s + '/') || url.startsWith(s + '?'));

  function normSite(line) {
    let s = line.trim();
    if (!s) return null;
    if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
    try {
      const u = new URL(s);
      if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
      return (u.origin + u.pathname).replace(/\/+$/, '');
    } catch { return null; }
  }
  const siteLabel = (s) => s.replace(/^https?:\/\//, '');

  async function loadSitios() {
    if (!dbRoot) return;
    try {
      const snap = await withTimeout(dbRoot.doc('config/sitios').get(), 10000, null);
      const list = snap && snap.exists && snap.data().sitios;
      if (Array.isArray(list)) {
        sitios = list.filter((x) => typeof x === 'string' && normSite(x)).map(normSite);
        lsSet('bp-editor-sitios', sitios);
      }
    } catch (err) { console.warn('sitios', err); }
  }

  async function editSitios() {
    closeMenus();
    const res = await dialog({
      title: 'Sitios de WordPress',
      body: `<p>Uno por línea, tal como los conectaste en WPVibe. El primero es el que sale marcado al enviar.</p>
             <textarea name="sitios" id="f-sitios" rows="4" placeholder="https://tublog.com"></textarea>`,
      ok: 'Guardar',
      onOpen: (b) => { $('#f-sitios', b).value = sitios.join('\n'); setTimeout(() => $('#f-sitios', b).focus(), 40); },
    });
    if (!res) return false;
    const list = [...new Set((res.sitios || '').split(/[\n,]+/).map(normSite).filter(Boolean))];
    sitios = list;
    lsSet('bp-editor-sitios', sitios);
    if (dbRoot) {
      try { await dbRoot.doc('config/sitios').set({ sitios }); }
      catch (err) { toast('No se pudieron guardar los sitios' + (err && err.code ? ` (${err.code})` : ''), 4000); return false; }
    }
    toast(sitios.length ? `${sitios.length} ${sitios.length === 1 ? 'sitio guardado' : 'sitios guardados'}` : 'Sin sitios');
    renderEnvio();
    return true;
  }
  $('#btn-sites').addEventListener('click', (e) => { e.stopPropagation(); editSitios(); });

  function renderEnvio() {
    const el = $('#st-envio');
    const env = current && current.envio;
    el.textContent = '';
    el.className = 'st-envio';
    if (!env || !ENVIO_LARGO[env.estado]) { el.hidden = true; return; }
    el.hidden = false;
    if (env.estado === 'borrador_wp' || env.estado === 'publicado') el.classList.add('ok');
    if (env.estado === 'error') el.classList.add('err');
    const url = onSite(env.editUrl) ? env.editUrl : onSite(env.wpUrl) ? env.wpUrl : null;
    if (url) {
      const link = document.createElement('a');
      link.href = url; link.target = '_blank'; link.rel = 'noopener';
      link.textContent = ENVIO_LARGO[env.estado];
      el.appendChild(link);
    } else {
      el.textContent = ENVIO_LARGO[env.estado];
    }
    if (env.estado === 'error' && typeof env.mensaje === 'string') el.title = env.mensaje;
    if (env.enviado && current.updated > env.enviado + 3000 && env.estado !== 'pendiente') {
      el.appendChild(document.createTextNode(' · con cambios después'));
    }
  }

  function readImageSize(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight, img, url }); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    });
  }

  // Claude lee la imagen con un límite de 4 MB: si pasa de 3,5 MB la recomprime en JPEG
  async function prepareImage(file) {
    const info = await readImageSize(file);
    if (!info) throw new Error('No se puede leer la imagen');
    let blob = file, w = info.w, h = info.h, recomprimida = false;
    if (file.size > 3.5 * 1024 * 1024) {
      const max = 2560;
      const k = Math.min(1, max / Math.max(w, h));
      const cw = Math.round(w * k), ch = Math.round(h * k);
      const canvas = document.createElement('canvas');
      canvas.width = cw; canvas.height = ch;
      canvas.getContext('2d').drawImage(info.img, 0, 0, cw, ch);
      for (const q of [0.88, 0.8, 0.7]) {
        blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', q));
        if (blob && blob.size <= 3.5 * 1024 * 1024) break;
      }
      w = cw; h = ch; recomprimida = true;
    }
    URL.revokeObjectURL(info.url);
    return { blob, w, h, recomprimida, nombre: file.name };
  }

  const LAYOUT_ICONS = {
    izquierda: '<svg viewBox="0 0 54 38"><rect class="blk-img" x="4" y="5" width="18" height="15" rx="2"/><path d="M26 7h24M26 12h24M26 17h24M4 25h46M4 30h46M4 35h30"/></svg>',
    derecha: '<svg viewBox="0 0 54 38"><rect class="blk-img" x="32" y="5" width="18" height="15" rx="2"/><path d="M4 7h24M4 12h24M4 17h24M4 25h46M4 30h46M4 35h30"/></svg>',
    encima: '<svg viewBox="0 0 54 38"><rect class="blk-img" x="4" y="3" width="46" height="17" rx="2"/><path d="M4 25h46M4 30h46M4 35h30"/></svg>',
    destacada: '<svg viewBox="0 0 54 38"><rect x="4" y="3" width="46" height="32" rx="3"/><rect class="blk-img" x="9" y="8" width="36" height="14" rx="1.5"/><path d="M9 27h36M9 31h24"/></svg>',
  };

  async function openSend() {
    closeMenus();
    if (previewOn) togglePreview(false);
    if (!ta.value.trim()) { toast('El borrador está vacío'); return; }
    if (!remote) { toast('Sin conexión con Claude: no se puede enviar desde aquí', 4000); return; }
    if (!sitios.length) {
      toast('Primero añade tu sitio de WordPress', 3000);
      if (!(await editSitios()) || !sitios.length) return;
    }
    dirty = true;
    await saveNow();

    const prev = current.envio || {};
    let tipo = prev.tipo === 'pagina' ? 'pagina' : 'entrada';
    let imagen = prev.imagen && prev.imagen.id ? { ...prev.imagen } : null;   // ya subida
    let nueva = null;                                                          // elegida ahora
    const posicion = ['izquierda', 'derecha', 'encima', 'destacada'].includes(prev.posicion) ? prev.posicion : 'izquierda';
    const sitio = sitios.includes(prev.sitio) ? prev.sitio : sitios[0];

    const opt = (name, value, label, checked) =>
      `<label class="opt"><input type="radio" name="${name}" value="${value}"${checked ? ' checked' : ''}><span>${label}</span></label>`;
    const body = `
      <p>«<span id="s-title"></span>»</p>
      <span class="field-title">Tipo</span>
      <div class="opts">${opt('tipo', 'entrada', 'Entrada', tipo === 'entrada')}${opt('tipo', 'pagina', 'Página', tipo === 'pagina')}</div>
      <span class="field-title" id="s-img-title"></span>
      <div class="img-box">
        <img class="img-thumb" id="s-thumb" alt="" hidden>
        <div class="img-info">
          <div id="s-img-info"></div>
          <div class="img-actions">
            <button type="button" id="s-img-pick"></button>
            <button type="button" id="s-img-del" hidden>Quitar</button>
            <input type="file" id="s-file" accept="image/jpeg,image/png,image/webp,image/gif" hidden>
          </div>
        </div>
      </div>
      <p class="note" id="s-img-note" hidden>Claude la usa para el ALT y la colocación. Para subirla a WordPress te pedirá que la sueltes en el panel de WPVibe: WordPress no puede descargarla desde aquí.</p>
      <div id="s-layout-wrap">
        <span class="field-title">Colocación de la imagen</span>
        <div class="opts layout-pick">
          ${opt('posicion', 'izquierda', LAYOUT_ICONS.izquierda + 'Flotando a la izquierda', posicion === 'izquierda')}
          ${opt('posicion', 'derecha', LAYOUT_ICONS.derecha + 'Flotando a la derecha', posicion === 'derecha')}
          ${opt('posicion', 'encima', LAYOUT_ICONS.encima + 'Encima del texto', posicion === 'encima')}
          ${opt('posicion', 'destacada', LAYOUT_ICONS.destacada + 'Solo imagen destacada', posicion === 'destacada')}
        </div>
      </div>
      <span class="field-title">Sitio</span>
      <div class="opts">${sitios.map((s) => opt('sitio', esc(s), esc(siteLabel(s)), s === sitio)).join('')}</div>
      <span class="field-title">Notas para Claude (opcional)</span>
      <textarea name="notas" id="s-notas" placeholder="Categoría, etiquetas, frase clave…"></textarea>`;

    let refresh = () => {};
    let fileInput = null;
    const onFile = async () => {
      const f = fileInput.files[0];
      fileInput.value = '';
      if (!f) return;
      try { nueva = await prepareImage(f); refresh(); } catch (err) { toast(err.message || 'No se puede leer la imagen'); }
    };
    const res = await dialog({
      title: 'Enviar a Claude',
      body,
      ok: 'Enviar',
      wide: true,
      onOpen: (b) => {
        $('#s-title', b).textContent = docTitle(ta.value);
        fileInput = $('#s-file', b);
        fileInput.addEventListener('change', onFile);
        $('#s-notas', b).value = typeof prev.notas === 'string' ? prev.notas : '';
        refresh = () => {
          tipo = ($('input[name="tipo"]:checked', b) || {}).value || 'entrada';
          $('#s-img-title', b).textContent = 'Imagen (opcional)';
          const thumb = $('#s-thumb', b);
          const infoEl = $('#s-img-info', b);
          infoEl.textContent = '';
          let w = 0, h = 0, name = '';
          if (nueva) {
            if (thumb.dataset.obj) URL.revokeObjectURL(thumb.dataset.obj);
            thumb.dataset.obj = URL.createObjectURL(nueva.blob);
            thumb.src = thumb.dataset.obj; thumb.hidden = false;
            w = nueva.w; h = nueva.h; name = nueva.nombre;
          } else if (imagen) {
            thumb.src = '/_blob/' + imagen.id; thumb.hidden = false;
            w = imagen.ancho; h = imagen.alto; name = imagen.nombre;
          } else {
            thumb.hidden = true;
          }
          if (w) {
            const line = document.createElement('div');
            line.textContent = `${name} · ${w} × ${h} px` + (nueva && nueva.recomprimida ? ' · recomprimida' : '');
            infoEl.appendChild(line);
          } else {
            infoEl.textContent = 'Sin imagen.';
          }
          $('#s-img-pick', b).textContent = w ? 'Cambiar' : 'Elegir imagen…';
          $('#s-img-del', b).hidden = !w;
          $('#s-img-note', b).hidden = !w;
          $('#s-layout-wrap', b).hidden = !w;
          if (!assetsApi) {
            $('#s-img-pick', b).hidden = true;
            infoEl.textContent = 'Desde esta vista no se pueden subir imágenes: pásasela a Claude en el chat.';
          }
        };
        $$('input[name="tipo"]', b).forEach((r) => r.addEventListener('change', refresh));
        $('#s-img-pick', b).addEventListener('click', () => fileInput.click());
        $('#s-img-del', b).addEventListener('click', () => { nueva = null; imagen = null; refresh(); });
        refresh();
      },
    });
    const thumb = $('#s-thumb'); if (thumb && thumb.dataset.obj) URL.revokeObjectURL(thumb.dataset.obj);
    ta.focus({ preventScroll: true });
    if (!res) return;

    tipo = res.tipo === 'pagina' ? 'pagina' : 'entrada';
    if (nueva) {
      setSaveStatus('Subiendo imagen…', true);
      try {
        const up = await assetsApi.upload(nueva.blob, { type: nueva.blob.type || 'image/jpeg' });
        imagen = { id: up.id, nombre: nueva.nombre, tipo: up.contentType, ancho: nueva.w, alto: nueva.h, bytes: up.sizeBytes };
      } catch (err) {
        setSaveStatus('Guardado');
        toast('No se pudo subir la imagen' + (err && err.code ? ` (${err.code})` : ''), 4000);
        return;
      }
    }
    const envio = {
      estado: 'pendiente',
      tipo,
      sitio: sitios.includes(res.sitio) ? res.sitio : sitios[0],
      imagen: imagen || null,
      posicion: imagen ? (res.posicion || 'izquierda') : null,
      notas: (res.notas || '').trim(),
      enviado: Date.now(),
      wpId: null, wpUrl: null, editUrl: null, mensaje: null,
    };
    try {
      await DB.merge(current.id, { envio });
      current.envio = envio;
      setSaveStatus('Guardado');
      renderEnvio();
    } catch (err) {
      toast('No se pudo enviar' + (err && err.code ? ` (${err.code})` : ''), 4000);
      return;
    }
    await dialog({
      title: 'Listo para Claude',
      body: `<p>Escribe esto en el chat y Claude preparará el borrador en ${esc(siteLabel(envio.sitio))}:</p>
             <div class="copy-row"><code>${PHRASE}</code><button type="button" id="c-copy">Copiar</button></div>
             <p class="note">Si cambias el texto antes, Claude usará la versión más reciente.</p>`,
      ok: 'Cerrar',
      cancel: null,
      onOpen: (b) => {
        $('#c-copy', b).addEventListener('click', async (e) => {
          const ok = await copyText(PHRASE);
          e.target.textContent = ok ? 'Copiado' : 'No se pudo';
        });
      },
    });
  }
  $('#btn-send').addEventListener('click', openSend);

  /* ---------------------------------------------------------
     Menús, ajustes y diálogos
     --------------------------------------------------------- */
  function closeMenus() {
    $$('.menu').forEach((m) => (m.hidden = true));
    $('#btn-export').classList.remove('active');
    $('#btn-settings').classList.remove('active');
    document.body.classList.remove('menu-open');
  }
  function toggleMenu(menuId, btnId) {
    const m = $(menuId);
    const open = m.hidden;
    closeMenus();
    if (open) {
      m.hidden = false;
      $(btnId).classList.add('active');
      document.body.classList.add('menu-open');
    }
  }
  $('#btn-export').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#menu-export', '#btn-export'); });
  $('#btn-settings').addEventListener('click', (e) => { e.stopPropagation(); toggleMenu('#menu-settings', '#btn-settings'); });
  $('#menu-export').addEventListener('click', (e) => { const b = e.target.closest('[data-export]'); if (b) doExport(b.dataset.export); });
  $('#menu-settings').addEventListener('click', (e) => {
    e.stopPropagation();
    const b = e.target.closest('.seg button');
    if (!b) return;
    const key = b.closest('.seg').dataset.setting;
    settings[key] = b.dataset.value;
    lsSet('bp-editor-settings', settings);
    applySettings();
    // Los cambios de letra y tamaño alteran el ajuste de líneas
    requestAnimationFrame(() => { render(); });
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.menu') && !e.target.closest('#btn-export') && !e.target.closest('#btn-settings')) closeMenus();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applySettings);

  $('#btn-preview').addEventListener('click', () => togglePreview());
  $('#format-bar').addEventListener('mousedown', (e) => { if (e.target.closest('.tb')) e.preventDefault(); });
  $('#format-bar').addEventListener('click', (e) => {
    const b = e.target.closest('.tb[data-cmd]');
    if (!b) return;
    if (document.activeElement !== ta) ta.focus({ preventScroll: true });
    run(b.dataset.cmd);
  });

  // Diálogo genérico que devuelve los valores del formulario o null
  function dialog({ title, body, ok = 'Aceptar', danger = false, prefill = {}, onOpen, cancel = 'Cancelar', wide = false }) {
    const dlg = $('#dialog');
    dlg.classList.toggle('wide', wide);
    $('#dialog-title').textContent = title;
    const bodyEl = $('#dialog-body');
    bodyEl.innerHTML = body;
    const okBtn = $('#dialog-ok');
    okBtn.textContent = ok;
    okBtn.className = danger ? 'danger' : 'primary';
    const cancelBtn = $('#dialog-cancel');
    cancelBtn.textContent = cancel;
    cancelBtn.hidden = cancel === null;
    Object.entries(prefill).forEach(([k, v]) => { const i = bodyEl.querySelector(`[name="${k}"]`); if (i) i.value = v; });
    if (onOpen) onOpen(bodyEl);
    hideSelbar();
    return new Promise((resolve) => {
      const onClose = () => {
        dlg.removeEventListener('close', onClose);
        if (dlg.returnValue !== 'ok') { resolve(null); return; }
        const vals = {};
        $$('input, textarea, select', bodyEl).forEach((i) => {
          if (!i.name || i.type === 'file') return;
          if ((i.type === 'radio' || i.type === 'checkbox') && !i.checked) return;
          vals[i.name] = i.value;
        });
        resolve(vals);
      };
      dlg.addEventListener('close', onClose);
      dlg.returnValue = '';
      dlg.showModal();
      const first = bodyEl.querySelector('input[type="text"]:not([value]), input[type="url"], input[type="number"], input[type="text"]');
      const empty = $$('input[type="text"], input[type="url"]', bodyEl).find((i) => !i.value);
      setTimeout(() => (empty || first || okBtn).focus(), 30);
    });
  }
  // Intro dentro del diálogo = Aceptar
  $('#dialog-form').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'file') { e.preventDefault(); $('#dialog').close('ok'); }
  });

  $('#btn-shortcuts').addEventListener('click', () => {
    closeMenus();
    const alt = isMac ? '⌥' : 'Mayús';
    const rows = [
      ['Negrita', `${MOD} B`], ['Cursiva', `${MOD} I`], ['Enlace', `${MOD} K`], ['Código en línea', `${MOD} E`],
      ['Tachado', `${MOD} Mayús X`], ['Título 2 / 3 / 4', `${MOD} ${alt} 2 / 3 / 4`], ['Lista', `${MOD} Mayús 8`],
      ['Lista numerada', `${MOD} Mayús 7`], ['Cita', `${MOD} Mayús .`], ['Vista previa', `${MOD} Mayús P`],
      ['Enviar a Claude', `${MOD} Mayús Intro`], ['Borradores', `${MOD} Mayús O`], ['Nuevo borrador', `${MOD} ${isMac ? '⌥' : 'Alt'} N`], ['Guardar ya', `${MOD} S`],
      ['Sangrar elemento de lista', 'Tab / Mayús Tab'], ['Celda siguiente en tabla', 'Tab'], ['Cerrar / volver de una nota', 'Esc'],
    ];
    dialog({
      title: 'Atajos de teclado',
      body: '<table class="shortcuts"><tbody>' + rows.map(([a, k]) => `<tr><td>${esc(a)}</td><td><kbd>${esc(k)}</kbd></td></tr>`).join('') + `</tbody></table>`,
      ok: 'Cerrar',
      cancel: null,
    });
  });

  // Títulos de los botones con el atajo correcto para cada sistema
  (function labelShortcuts() {
    const alt = isMac ? '⌥' : 'Mayús';
    [2, 3, 4].forEach((n) => { const b = $(`.tb[data-cmd="h${n}"]`); if (b) b.title = `Título ${n} (${MOD} + ${alt} + ${n})`; });
    $$('[title]').forEach((el) => { el.title = el.title.replace('Ctrl/⌘', MOD); });
  })();

  /* ---------------------------------------------------------
     Atajos globales
     --------------------------------------------------------- */
  document.addEventListener('keydown', (e) => {
    const mod = isMac ? e.metaKey : e.ctrlKey;

    if (e.key === 'Escape') {
      if ($('#dialog').open) return;
      if (!$('#drawer').hidden) { closeDrawer(); ta.focus(); e.preventDefault(); return; }
      if ($$('.menu').some((m) => !m.hidden)) { closeMenus(); e.preventDefault(); return; }
      if (!selbar.hidden) { hideSelbar(); e.preventDefault(); return; }
      if (previewOn) { togglePreview(false); e.preventDefault(); return; }
      if (footnoteReturn !== null) {
        const p = Math.min(footnoteReturn, ta.value.length);
        footnoteReturn = null;
        ta.focus(); ta.setSelectionRange(p, p);
        scrollCaretIntoView(true);
        e.preventDefault();
      }
      return;
    }
    if (!mod) return;
    if ($('#dialog').open) return;

    const k = e.key.toLowerCase();
    const code = e.code;
    let cmd = null;

    if (e.shiftKey && !e.altKey) {
      if (code === 'KeyP') { e.preventDefault(); togglePreview(); return; }
      if (e.key === 'Enter') { e.preventDefault(); openSend(); return; }
      if (code === 'KeyO') { e.preventDefault(); $('#drawer').hidden ? openDrawer() : closeDrawer(); return; }
      if (code === 'KeyX') cmd = 'strike';
      else if (code === 'Digit8') cmd = 'ul';
      else if (code === 'Digit7') cmd = 'ol';
      else if (code === 'Period') cmd = 'quote';
      else if (!isMac && code === 'Digit2') cmd = 'h2';
      else if (!isMac && code === 'Digit3') cmd = 'h3';
      else if (!isMac && code === 'Digit4') cmd = 'h4';
    } else if (e.altKey && !e.shiftKey) {
      if (code === 'KeyN') { e.preventDefault(); newDraft(); return; }
      if (isMac && code === 'Digit2') cmd = 'h2';
      else if (isMac && code === 'Digit3') cmd = 'h3';
      else if (isMac && code === 'Digit4') cmd = 'h4';
    } else if (!e.altKey && !e.shiftKey) {
      if (k === 's') { e.preventDefault(); dirty = true; saveNow().then(() => toast('Guardado')); return; }
      if (document.activeElement === ta) {
        if (k === 'b') cmd = 'bold';
        else if (k === 'i') cmd = 'italic';
        else if (k === 'k') cmd = 'link';
        else if (k === 'e') cmd = 'code';
      }
    }
    if (cmd && (document.activeElement === ta || ['ul', 'ol', 'quote', 'h2', 'h3', 'h4'].includes(cmd))) {
      e.preventDefault();
      if (document.activeElement !== ta) ta.focus({ preventScroll: true });
      run(cmd);
    }
  });

  /* ---------------------------------------------------------
     Guardado al salir
     --------------------------------------------------------- */
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') saveNow(); });
  window.addEventListener('pagehide', () => { if (current) { current.content = ta.value; if (dirty) lsSet('bp-editor-backup', { id: current.id, content: ta.value, updated: Date.now() }); } saveNow(); });

  /* ---------------------------------------------------------
     Arranque
     --------------------------------------------------------- */
  async function connect() {
    if (!window.claude || typeof window.claude.use !== 'function') return;
    setSaveStatus('Conectando…');
    try {
      const db = await withTimeout(window.claude.use('db'), 10000, null);
      if (db) {
        const col = db.collection('drafts');
        // Comprueba que responde antes de usarla
        const ok = await withTimeout(col.limit(1).get().then(() => true), 10000, false);
        if (ok) { remote = col; dbRoot = db; }
      }
    } catch (err) { console.warn('db', err); }
    try { assetsApi = await withTimeout(window.claude.use('assets'), 10000, null); } catch { assetsApi = null; }
  }

  function watchRemote() {
    if (!remote) return;
    remote.onSnapshot((snap) => {
      snap.docChanges().forEach((ch) => {
        if (ch.type === 'removed') { known.delete(ch.doc.id); return; }
        known.add(ch.doc.id);
        if (!current || ch.doc.id !== current.id || snap.metadata.hasPendingWrites) return;
        const d = snapDoc(ch.doc);
        const envChanged = JSON.stringify(d.envio || null) !== JSON.stringify(current.envio || null);
        current.envio = d.envio;
        // Cambios hechos desde otro dispositivo, si aquí no hay nada pendiente
        if (!dirty && typeof d.content === 'string' && d.content !== ta.value && d.updated > current.updated) {
          const pos = Math.min(ta.selectionStart, d.content.length);
          current.content = d.content; current.updated = d.updated;
          ta.value = d.content; render(); updateStats(); ta.setSelectionRange(pos, pos);
        }
        if (envChanged) renderEnvio();
      });
      if (!$('#drawer').hidden) renderDraftList();
    }, (err) => console.warn('snapshot', err));
  }

  async function init() {
    applySettings();
    $('#app-version').textContent = 'v' + APP_VERSION;
    await connect();
    if (!remote) toast('Sin conexión con Claude: los borradores se guardan solo en este navegador', 6000);
    await loadSitios();
    let docs = [];
    try { docs = await DB.all(); } catch (err) {
      console.error(err);
      toast('No se puede usar el almacenamiento del navegador', 5000);
    }
    const lastId = lsGet('bp-editor-current', null);
    current = docs.find((d) => d.id === lastId) || docs.sort((a, b) => b.updated - a.updated)[0] || null;

    // Recupera la copia de seguridad si es más reciente que lo guardado
    const backup = lsGet('bp-editor-backup', null);
    if (backup && backup.content) {
      const saved = docs.find((d) => d.id === backup.id);
      if (!saved || backup.updated > saved.updated) {
        const doc = saved ? { ...saved, content: backup.content, updated: backup.updated } : { id: backup.id, content: backup.content, created: backup.updated, updated: backup.updated };
        try { await DB.put(doc); } catch { /* nada */ }
        if (!current || current.id === doc.id || !saved) current = doc;
      }
    }

    if (!current) {
      current = newDoc(WELCOME);
      dirty = true;
    }
    loadIntoEditor(current, current.content === WELCOME ? 0 : undefined);
    if (dirty) saveNow();
    setSaveStatus(dirty ? 'Sin guardar' : 'Guardado', dirty);

    watchRemote();
  }

  const WELCOME = `# Bienvenido a tu editor

Escribe aquí los posts de tu blog. Todo se guarda solo y Claude puede leerlo.

Antes de nada, abre Ajustes y añade tu sitio en «Sitios de WordPress».

Cuando el texto esté listo, pulsa **Enviar**: eliges si es una entrada o una página, añades la imagen y dices dónde va. Después escribe en el chat «publica lo del editor».

## Cómo funciona

Selecciona una palabra y aparece una barra para ponerla en **negrita**, en *cursiva*, ~~tachada~~, como \`código\` o convertirla en [enlace](https://wordpress.org).

Los títulos, las listas, las citas, las tablas y las notas al pie[^1] están en la barra de arriba. Esa barra se apaga mientras escribes y vuelve en cuanto mueves el ratón.

- Pulsa Intro en una lista y sigue la lista.
- Pulsa Intro en un elemento vacío y la lista termina.

> La primera línea con # es el título del post. Al copiar el HTML para WordPress se queda fuera, porque el título va en su propio campo.

| Atajo | Qué hace |
| ----- | -------- |
| ${MOD} B | Negrita |
| ${MOD} K | Enlace |

[^1]: Las notas se numeran solas y van al final del texto.
`;

  init();
})();
