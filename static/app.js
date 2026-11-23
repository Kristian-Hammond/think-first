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
    today, problemTitle, docFileName, downloadDoc, extractFile, withFileLoader, downloadButton, register, start };
})();
