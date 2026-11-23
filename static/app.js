/*
 * Think-First Workbench - shared framework.
 *
 * Each interaction lives in its own file under interactions/ and calls
 *   App.register('<id>', { mount(container) { ... } })
 * The id must match an entry in INTERACTIONS below. Entries without a
 * registered implementation show a "coming soon" page.
 */

const INTERACTIONS = [
  { id: 'whats-your-problem',  title: "What’s your Problem" },
  { id: 'first-draft',         title: 'First Draft' },
  { id: 'critique',            title: 'Critique' },
  { id: 'dimensions',          title: 'Dimensions' },
  { id: 'know-your-materials', title: 'Know your Materials' },
  { id: 'explain-the-answer',  title: 'Explain the Answer' },
  { id: 'spot-the-flaw',       title: 'Spot the Flaw' },
  { id: 'pre-mortem',          title: 'Pre-mortem' },
  { id: 'devils-advocate',     title: 'Devil\u2019s Advocate' },
  { id: 'assumptions-audit',   title: 'Assumptions Audit' },
  { id: 'options-first',       title: 'Options First' },
  { id: 'predict-and-compare', title: 'Predict and Compare' },
  { id: 'client-rehearsal',    title: 'Client Rehearsal' },
  { id: 'say-it-simply',       title: 'Say it Simply' },
];

const App = (() => {
  const registry = {};

  /* Small DOM helper: el('div', {class: 'x', onclick: fn}, 'text', childNode, ...) */
  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs || {})) {
      if (value === undefined || value === null || value === false) continue;
      if (key.startsWith('on') && typeof value === 'function') {
        node.addEventListener(key.slice(2), value);
      } else if (key === 'class') {
        node.className = value;
      } else if (key === 'value') {
        node.value = value;
      } else {
        node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  /* Call the local server, which calls OpenAI (or returns a mock). */
  async function callLLM(interaction, step, payload) {
    let resp;
    try {
      resp = await fetch('/api/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ interaction, step, payload }),
      });
    } catch (e) {
      throw new Error('Cannot reach the local server. Is server.py running?');
    }
    let data = {};
    try { data = await resp.json(); } catch (e) { /* fall through */ }
    if (!resp.ok) throw new Error(data.error || `Server error (${resp.status})`);
    return data.result;
  }

  /* Shared page pieces so every interaction looks the same. */
  function pageHeader(title, subtitle) {
    return el('header', { class: 'page-header' },
      el('h1', {}, title),
      subtitle ? el('p', { class: 'subtitle' }, subtitle) : null);
  }

  function stepper(steps, activeIndex) {
    return el('ol', { class: 'stepper' },
      steps.map((label, i) => el('li', {
        class: i < activeIndex ? 'done' : i === activeIndex ? 'active' : '',
      }, el('span', { class: 'num' }, String(i + 1)), label)));
  }

  function spinner(message) {
    return el('div', { class: 'loading' }, el('div', { class: 'spin' }), el('span', {}, message));
  }

  function errorBox(message, onRetry) {
    // With a retry it's a failed call; without one it's usually a "please fill this in" message.
    return el('div', { class: 'error' },
      onRetry ? el('strong', {}, 'Something went wrong. ') : null, message,
      onRetry ? el('button', { class: 'btn small', onclick: onRetry }, 'Try again') : null);
  }

  /* Bring the top of the page into view (the main panel is the scrolling area). */
  function scrollToTop() {
    const main = document.getElementById('main');
    if (main) main.scrollTo({ top: 0, behavior: 'smooth' });
  }

  /* ---------- Reading files from the user's computer ---------- */

  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).split(',')[1] || '');
      r.onerror = () => reject(new Error('Could not read the file from your computer.'));
      r.readAsDataURL(file);
    });
  }

  /* Send a file to the local server and get its text back: { text, chars, truncated, note }. */
  async function extractFile(file) {
    if (file.size > 25 * 1024 * 1024) throw new Error('That file is too large (limit about 25 MB).');
    const data = await readAsBase64(file);
    let resp;
    try {
      resp = await fetch('/api/extract', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data }) });
    } catch (e) {
      throw new Error('Cannot reach the local server. Is server.py running?');
    }
    let out = {};
    try { out = await resp.json(); } catch (e) { /* ignore */ }
    if (resp.status === 404) throw new Error('The server needs restarting to read files (Ctrl+C, then python3 server.py).');
    if (!resp.ok) throw new Error(out.error || 'Could not read this file.');
    return out;
  }

  /* Wrap a text box with a "Load from Word file" button. The file's text fills an empty box,
     or is added after what's already there, so nothing the user typed is lost. */
  function withFileLoader(textarea) {
    const status = el('span', { class: 'loader-status' });
    const input = el('input', { type: 'file', accept: '.docx,.txt,.md', class: 'file-input',
      onchange: async e => {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        status.className = 'loader-status';
        status.textContent = 'Reading ' + file.name + '…';
        btn.disabled = true;
        try {
          const { text } = await extractFile(file);
          const current = textarea.value.trim();
          textarea.value = current ? current + '\n\n' + text : text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));  // updates the page's saved state
          status.textContent = current
            ? `Added the text of ${file.name} after what you’d written.`
            : `Loaded ${file.name}.`;
        } catch (err) {
          status.className = 'loader-status err';
          status.textContent = err.message;
        } finally {
          btn.disabled = textarea.disabled;
        }
      } });
    const btn = el('button', { type: 'button', class: 'btn small', disabled: textarea.disabled,
      onclick: () => input.click() }, 'Load from Word file…');
    return el('div', { class: 'with-loader' }, textarea, el('div', { class: 'loader-row' }, btn, status, input));
  }

  /* ---------- "Add Materials": supporting documents in a pop-up window ---------- */

  const MATERIAL_TYPES = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm';

  /*
   * A button that opens an upload window, plus a list of what's attached.
   * store: an object the interaction owns, with docs (array), uploads (number), uploadErrors (array).
   *        Each doc is { name, text, chars, note }.
   * onChange: called whenever the attached materials change, so the page can re-render.
   */
  function materialsPicker(store, onChange, { disabled = false, hint = '' } = {}) {
    store.docs = store.docs || [];
    store.uploads = store.uploads || 0;
    store.uploadErrors = store.uploadErrors || [];
    const words = n => Math.max(1, Math.round(n / 6)).toLocaleString();
    let overlay = null;

    function remove(d) {
      store.docs = store.docs.filter(x => x !== d);
      refresh();
    }

    function refresh() {
      if (overlay) renderDialog();
      onChange();
    }

    async function addFiles(fileList) {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      store.uploadErrors = [];
      store.uploads += files.length;
      refresh();
      await Promise.all(files.map(async file => {
        try {
          const out = await extractFile(file);
          store.docs.push({ name: file.name, text: out.text, chars: out.chars, note: out.note || '' });
        } catch (e) {
          store.uploadErrors.push({ name: file.name, error: e.message });
        } finally {
          store.uploads -= 1;
          refresh();
        }
      }));
    }

    function docRow(d) {
      const preview = el('div', { class: 'doc-preview prewrap', hidden: true },
        d.text.slice(0, 1200) + (d.text.length > 1200 ? '…' : ''));
      return el('div', { class: 'doc' },
        el('div', { class: 'doc-main' },
          el('div', { class: 'doc-name' }, d.name),
          el('div', { class: 'hint' }, `About ${words(d.chars)} words`, d.note ? ' · ' + d.note : '')),
        el('div', { class: 'doc-actions' },
          el('button', { class: 'btn link', onclick: e => {
            preview.hidden = !preview.hidden;
            e.target.textContent = preview.hidden ? 'Preview' : 'Hide preview';
          } }, 'Preview'),
          el('button', { class: 'btn link danger', onclick: () => remove(d) }, 'Remove')),
        preview);
    }

    function renderDialog() {
      const input = el('input', { type: 'file', multiple: true, accept: MATERIAL_TYPES, class: 'file-input',
        onchange: e => { addFiles(e.target.files); e.target.value = ''; } });
      const drop = el('div', { class: 'dropzone',
        onclick: () => input.click(),
        ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
        ondragleave: () => drop.classList.remove('over'),
        ondrop: e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); },
      },
        el('div', { class: 'drop-title' }, 'Drop files here, or click to choose'),
        el('div', { class: 'hint' }, 'PDF, Word (.docx), PowerPoint (.pptx), Excel (.xlsx), text, Markdown, CSV or HTML'),
        input);
      overlay.querySelector('.modal-body').replaceChildren(...[
        hint ? el('p', { class: 'intro' }, hint) : null,
        drop,
        store.uploads ? spinner(`Reading ${store.uploads} file${store.uploads > 1 ? 's' : ''}…`) : null,
        store.uploadErrors.length ? el('div', { class: 'note' }, store.uploadErrors.map(u =>
          el('div', {}, el('strong', {}, u.name + ': '), u.error))) : null,
        store.docs.length ? el('div', { class: 'doc-list' }, store.docs.map(docRow))
          : el('p', { class: 'hint' }, 'No materials added yet.'),
      ].filter(Boolean));
      const done = overlay.querySelector('.modal-done');
      done.disabled = store.uploads > 0;
      done.textContent = store.uploads > 0 ? 'Reading…' : 'Done';
    }

    function close() {
      if (!overlay || store.uploads > 0) return;
      overlay.remove();
      overlay = null;
      document.removeEventListener('keydown', onKey);
      onChange();
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    function open() {
      overlay = el('div', { class: 'modal-overlay', onclick: e => { if (e.target === overlay) close(); } },
        el('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add materials' },
          el('div', { class: 'modal-head' },
            el('h2', {}, 'Add materials'),
            el('button', { class: 'btn link', 'aria-label': 'Close', onclick: close }, '✕')),
          el('div', { class: 'modal-body' }),
          el('div', { class: 'modal-foot' },
            el('button', { class: 'btn primary modal-done', onclick: close }, 'Done'))));
      document.body.append(overlay);
      document.addEventListener('keydown', onKey);
      renderDialog();
    }

    const n = store.docs.length;
    return el('div', { class: 'materials' },
      el('div', { class: 'materials-head' },
        el('button', { type: 'button', class: 'btn', disabled, onclick: open },
          n ? `Add Materials (${n} attached)` : 'Add Materials'),
        store.uploads ? el('span', { class: 'hint' }, 'Reading files…') : null),
      n ? el('div', { class: 'chips materials-list' }, store.docs.map(d =>
        el('span', { class: 'chip static attached' }, d.name,
          el('button', { class: 'chip-x', title: 'Remove', disabled, onclick: () => remove(d) }, '✕')))) : null);
  }

  /* ---------- Word download ---------- */

  function today() {
    return new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
  }

  // A short title for the problem, written by the AI; cached so repeat downloads don't call again.
  const titleCache = {};
  function fallbackTitle(problem) {
    const words = String(problem || '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 8).join(' ');
    return words || 'Solution';
  }
  async function problemTitle(problem) {
    const key = String(problem || '').trim();
    if (titleCache[key]) return titleCache[key];
    let title = '';
    try {
      const res = await callLLM('common', 'title', { problem: key });
      title = String((res && res.title) || '').trim();
    } catch (e) { /* fall back below */ }
    title = title || fallbackTitle(key);
    titleCache[key] = title;
    return title;
  }

  // e.g. "Consolidating Customer Reporting - 2026-11-22.docx"
  function docFileName(title) {
    const safe = String(title || 'Solution').replace(/[\/\\:*?"<>|\u0000-\u001f]/g, ' ')
      .replace(/\s+/g, ' ').trim().slice(0, 90) || 'Solution';
    const d = new Date();
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return `${safe} - ${date}.docx`;
  }

  async function downloadDoc(doc, fileName) {
    let resp;
    try {
      resp = await fetch('/api/docx', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(doc),
      });
    } catch (e) {
      throw new Error('Cannot reach the local server. Is server.py running?');
    }
    if (!resp.ok) {
      let data = {};
      try { data = await resp.json(); } catch (e) { /* ignore */ }
      throw new Error(data.error || 'Could not create the Word document. Restart server.py and try again.');
    }
    const url = URL.createObjectURL(await resp.blob());
    const a = el('a', { href: url, download: fileName });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  /* A button that builds and downloads a Word document. buildDoc() returns (a promise of) { doc, fileName }. */
  function downloadButton(label, buildDoc, { disabled = false, onError } = {}) {
    const btn = el('button', { class: 'btn primary', disabled, onclick: async () => {
      btn.disabled = true;
      btn.textContent = 'Preparing document…';
      try {
        const { doc, fileName } = await buildDoc();
        await downloadDoc(doc, fileName);
        btn.textContent = 'Downloaded ✓';
      } catch (e) {
        btn.textContent = label;
        if (onError) onError(e.message);
      } finally {
        btn.disabled = false;
        setTimeout(() => { if (btn.textContent === 'Downloaded ✓') btn.textContent = label; }, 2500);
      }
    } }, label);
    return btn;
  }

  function register(id, impl) { registry[id] = impl; }

  function currentId() {
    const id = location.hash.replace(/^#/, '');
    return INTERACTIONS.some(i => i.id === id) ? id : INTERACTIONS[0].id;
  }

  function renderNav() {
    const nav = document.getElementById('nav');
    const active = currentId();
    nav.replaceChildren(...INTERACTIONS.map(item =>
      el('a', {
        href: '#' + item.id,
        class: 'nav-item' + (item.id === active ? ' active' : '') + (registry[item.id] ? '' : ' pending'),
      }, item.title, registry[item.id] ? null : el('span', { class: 'tag' }, 'soon'))));
  }

  function renderMain() {
    const main = document.getElementById('main');
    const id = currentId();
    const item = INTERACTIONS.find(i => i.id === id);
    const container = el('div', { class: 'page' });
    main.replaceChildren(container);
    if (registry[id]) {
      registry[id].mount(container);
    } else {
      container.append(
        pageHeader(item.title),
        el('div', { class: 'card muted' }, 'This interaction hasn’t been built yet.'));
    }
    main.scrollTop = 0;
  }

  async function showStatus() {
    const box = document.getElementById('status');
    try {
      const s = await (await fetch('/api/status')).json();
      box.replaceChildren(s.mock
        ? el('span', { class: 'badge mock' }, 'Sample mode – no API key')
        : el('span', { class: 'badge live' }, 'Live · ' + s.model));
    } catch (e) {
      box.replaceChildren(el('span', { class: 'badge off' }, 'Server not running'));
    }
  }

  function start() {
    const route = () => { renderNav(); renderMain(); };
    window.addEventListener('hashchange', route);
    route();
    showStatus();
  }

  return { el, callLLM, pageHeader, stepper, spinner, errorBox, scrollToTop,
    today, problemTitle, docFileName, downloadDoc, extractFile, withFileLoader, materialsPicker, downloadButton, register, start };
})();
