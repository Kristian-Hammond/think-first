/*
 * Interaction: Know your Materials
 *
 * 1. Problem     - user describes the problem
 * 2. Documents   - user uploads documents about the company or industry;
 *                  the local server extracts their text
 * 3. Check       - AI asks up to 5 questions about the documents and checks the answers.
 *                  Wrong or partial answers get a hint (not the answer) and must be corrected;
 *                  after two failed tries the user can reveal the answer. All must be correct
 *                  before the solution is generated.
 * 4. Solution    - AI proposes a solution that cites numbered
 *                  facts from the documents (each with an exact quote, checked against the text)
 *
 * Server steps used (see prompts/know-your-materials/):
 *   questions  payload: { problem, documents: [{ id, name, text }] }
 *   check      payload: { problem, documents, answers: [{ id, question, doc, answer }] }  (unresolved ones only)
 *   solve      payload: { problem, documents, answers: [{ id, question, doc, answer }] }  (all confirmed)
 * Plus POST /api/extract to read uploaded files.
 */
(() => {
  const ID = 'know-your-materials';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Add documents', 'Check your understanding', 'Solution'];
  const STAGE_INDEX = { problem: 0, docs: 1, quiz: 2, result: 3 };
  const LARGE_TOTAL = 200000; // characters; above this, warn about speed and cost
  const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm';

  const S = {
    stage: 'problem',
    problem: '',
    docs: [],            // [{ key, name, text, chars, note }]
    uploads: [],         // files being read: [{ key, name }]
    uploadErrors: [],    // [{ name, error }]
    questions: [],       // [{ id, question, doc, why }]
    answers: {},         // id -> text
    checks: {},          // id -> { assessment, hint, answer, source, attempts, revealed }
    result: null,
    busy: false,
    busyMessage: '',
    error: null,
    retry: null,
  };
  let nextKey = 1;
  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    root.replaceChildren(...[
      App.pageHeader('Know your Materials',
        'Ground the solution in the client’s own documents – and make sure you know what’s in them.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'docs' ? docsView() : null,
      S.stage === 'quiz' ? quizView() : null,
      S.stage === 'result' ? resultView() : null,
    ].filter(Boolean));
  }

  async function run(message, work) {
    const stageBefore = S.stage;
    S.busy = true; S.busyMessage = message; S.error = null; S.retry = null;
    render();
    App.scrollToTop();
    try {
      await work();
    } catch (e) {
      S.error = e.message;
      S.retry = () => run(message, work);
    } finally {
      S.busy = false;
      render();
      if (S.stage !== stageBefore || S.error) App.scrollToTop();
    }
  }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }
  const arr = x => (Array.isArray(x) ? x : []);

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function problemRecap(editable) {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'),
      el('p', { class: 'prewrap' }, S.problem),
      editable ? el('button', { class: 'btn link', onclick: () => goTo('problem'), disabled: S.busy }, 'Edit problem') : null);
  }

  // Documents as the AI sees them: D1, D2, ... in the order shown.
  function docPayload() { return S.docs.map((d, i) => ({ id: 'D' + (i + 1), name: d.name, text: d.text })); }
  function docName(id) {
    const i = parseInt(String(id || '').replace(/\D/g, ''), 10) - 1;
    return S.docs[i] ? S.docs[i].name : (id || '');
  }
  function docText(id) {
    const i = parseInt(String(id || '').replace(/\D/g, ''), 10) - 1;
    return S.docs[i] ? S.docs[i].text : '';
  }
  function words(n) { return Math.max(1, Math.round(n / 6)).toLocaleString(); }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    return el('section', { class: 'card' },
      el('label', { class: 'label' }, 'The problem'),
      App.withFileLoader(textArea(S.problem, 8, 'Describe the problem. You’ll add documents about the company or industry next.',
        v => { S.problem = v; }, 'input big')),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          goTo('docs');
        } }, 'Next: add documents')));
  }

  /* ---------- Step 2: documents ---------- */

  function docsView() {
    const total = S.docs.reduce((n, d) => n + d.chars, 0);
    const input = el('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'file-input',
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

    return el('div', {},
      problemRecap(true),
      el('section', { class: 'card' },
        el('h2', {}, 'Add your materials'),
        el('p', { class: 'intro' },
          'Add the documents that describe the company or industry – annual reports, strategy decks, org charts, market studies, past proposals. The AI will use only these as its source of facts.'),
        drop,
        S.uploads.length ? el('div', { class: 'uploading' }, S.uploads.map(u => App.spinner('Reading ' + u.name + '…'))) : null,
        S.uploadErrors.length ? el('div', { class: 'note' }, S.uploadErrors.map(u =>
          el('div', {}, el('strong', {}, u.name + ': '), u.error))) : null,
        S.docs.length ? el('div', { class: 'doc-list' }, S.docs.map(docRow)) : null,
        S.docs.length ? el('div', { class: 'hint' },
          `${S.docs.length} document${S.docs.length > 1 ? 's' : ''}, about ${words(total)} words in total.`,
          total > LARGE_TOTAL ? ' That’s a lot of text – responses will be slower and cost more.' : '') : null),

      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy || S.uploads.length > 0, onclick: submitDocs },
          'Next: check my understanding')));
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
        el('button', { class: 'btn link danger', disabled: S.busy, onclick: () => {
          S.docs = S.docs.filter(x => x !== d); render();
        } }, 'Remove')),
      preview);
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    S.uploadErrors = [];
    S.error = null;
    await Promise.all(files.map(async file => {
      const u = { key: nextKey++, name: file.name };
      S.uploads.push(u);
      render();
      try {
        const out = await App.extractFile(file);
        S.docs.push({ key: u.key, name: file.name, text: out.text, chars: out.chars, note: out.note || '' });
      } catch (e) {
        S.uploadErrors.push({ name: file.name, error: e.message });
      } finally {
        S.uploads = S.uploads.filter(x => x !== u);
        render();
      }
    }));
  }

  function submitDocs() {
    if (!S.docs.length) return fail('Please add at least one document.');
    run('Reading your documents and preparing questions…', async () => {
      const res = await App.callLLM(ID, 'questions', { problem: S.problem.trim(), documents: docPayload() });
      const qs = arr(res && res.questions).slice(0, 5);
      if (!qs.length) throw new Error('No questions came back. Try again.');
      S.questions = qs.map((q, i) => ({ ...q, id: q.id || 'q' + (i + 1) }));
      S.answers = {};
      S.checks = {};
      S.result = null;
      S.stage = 'quiz';
    });
  }

  /* ---------- Step 3: questions about the documents ---------- */

  const MAX_TRIES_BEFORE_REVEAL = 2;

  function isResolved(q) { const c = S.checks[q.id]; return !!(c && c.assessment === 'correct'); }
  function allResolved() { return S.questions.length > 0 && S.questions.every(isResolved); }
  function anyChecked() { return S.questions.some(q => S.checks[q.id]); }

  function quizView() {
    const done = allResolved();
    const resolved = S.questions.filter(isResolved).length;
    return el('div', {},
      problemRecap(false),
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Your materials'),
        el('div', { class: 'chips' }, S.docs.map(d => el('span', { class: 'chip static' }, d.name))),
        el('button', { class: 'btn link', disabled: S.busy, onclick: () => goTo('docs') }, 'Change documents')),
      el('section', { class: 'card' },
        el('h2', {}, 'Check your understanding'),
        el('p', { class: 'intro' }, anyChecked()
          ? (done ? 'All your answers are now correct.'
                  : `${resolved} of ${S.questions.length} correct. Use the hints to correct the others, then check again.`)
          : 'Answer from what you know of these documents – try not to look things up. Your answers will be checked, and any that are wrong must be corrected before you get a solution.'),
        S.questions.map((q, i) => questionBlock(q, i)),
        el('div', { class: 'actions' },
          done
            ? el('button', { class: 'btn primary', disabled: S.busy, onclick: getSolution }, 'Get the solution')
            : el('button', { class: 'btn primary', disabled: S.busy, onclick: checkAnswers },
                anyChecked() ? 'Check my corrected answers' : 'Check my answers'))));
  }

  function questionBlock(q, i) {
    const c = S.checks[q.id];
    const head = [
      el('div', { class: 'q-text' },
        c ? el('span', { class: 'assess ' + (ASSESS[c.assessment] || ASSESS.missed)[1] }, (ASSESS[c.assessment] || ASSESS.missed)[0]) : null,
        el('span', { class: 'q-num' }, `${i + 1}.`), q.question),
      el('div', { class: 'q-why' }, 'From: ' + docName(q.doc) + (q.why ? ' · Why it matters: ' + q.why : '')),
    ];

    if (c && c.assessment === 'correct') {
      return el('div', { class: 'question resolved' }, ...head,
        el('div', { class: 'locked-answer' }, (S.answers[q.id] || '').trim()),
        c.feedback ? el('div', { class: 'hint' }, c.feedback) : null);
    }

    const revealBtn = c && !c.revealed && c.attempts >= MAX_TRIES_BEFORE_REVEAL
      ? el('button', { class: 'btn link', disabled: S.busy, onclick: () => { c.revealed = true; render(); } }, 'Show me the answer')
      : null;

    return el('div', { class: 'question' + (c ? ' needs-fix' : '') }, ...head,
      c && c.hint ? el('div', { class: 'hint-box' }, el('strong', {}, 'Hint: '), c.hint) : null,
      c && c.revealed && c.source && c.source.quote
        ? el('div', {}, el('div', { class: 'mini-label' }, 'The answer is in this passage'), quoteBlock(c.source.doc, c.source.quote))
        : null,
      textArea(S.answers[q.id] || '', 2, c ? 'Your corrected answer' : 'Your answer', v => { S.answers[q.id] = v; }),
      c ? el('div', { class: 'tries' },
        `Tried ${c.attempts} time${c.attempts > 1 ? 's' : ''}`, revealBtn ? ' · ' : '', revealBtn) : null);
  }

  async function checkAnswers() {
    const pending = S.questions.filter(q => !isResolved(q));
    await run('Checking your answers against the documents…', async () => {
      const res = await App.callLLM(ID, 'check', {
        problem: S.problem.trim(),
        documents: docPayload(),
        answers: pending.map(q => ({ id: q.id, question: q.question, doc: q.doc,
          answer: (S.answers[q.id] || '').trim() || '(not answered)' })),
      });
      const results = arr(res && res.results);
      if (!results.length) throw new Error('The check came back empty. Try again.');
      pending.forEach((q, i) => {
        const r = results.find(x => x.question_id === q.id) || results[i];
        if (!r) return;
        const prev = S.checks[q.id] || { attempts: 0, revealed: false };
        const blank = !(S.answers[q.id] || '').trim();
        S.checks[q.id] = {
          assessment: blank ? 'not_answered' : (r.assessment || 'missed'),
          feedback: r.feedback || '',
          hint: r.hint || '',
          source: r.source || null,
          attempts: prev.attempts + 1,
          revealed: prev.revealed,
        };
      });
    });
    const first = root && root.querySelector('.question.needs-fix');
    if (first && !S.error) first.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function getSolution() {
    run('Building a solution from your documents…', async () => {
      const res = await App.callLLM(ID, 'solve', {
        problem: S.problem.trim(),
        documents: docPayload(),
        answers: S.questions.map(q => ({ id: q.id, question: q.question, doc: q.doc, answer: (S.answers[q.id] || '').trim() })),
      });
      if (!res || !res.solution) throw new Error('The solution came back incomplete. Try again.');
      S.result = res;
      S.stage = 'result';
    });
  }

  /* ---------- Step 4: solution with sources ---------- */

  // Does the quote really appear in the document? (ignores case, spacing and quote styles)
  function norm(s) {
    return String(s || '').toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
      .replace(/[–—]/g, '-').replace(/\s+/g, ' ').trim();
  }
  function quoteFound(docId, quote) {
    const q = norm(quote).replace(/^["'.… ]+|["'.… ]+$/g, '');
    return q.length > 0 && norm(docText(docId)).includes(q);
  }

  const ASSESS = {
    correct: ['Correct', 'ok'], partly: ['Partly right', 'part'], missed: ['Not right', 'miss'],
    not_answered: ['Not answered', 'none'],
  };

  function resultView() {
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});
    const facts = arr(r.facts);

    return el('div', {},
      problemRecap(false),

      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Your understanding'),
        el('p', { class: 'prewrap' }, understandingSummary())),

      el('section', { class: 'card accent' },
        el('h2', {}, 'Proposed solution'),
        sol.summary ? el('p', { class: 'prewrap' }, sol.summary) : null,
        arr(sol.steps).length ? el('ol', { class: 'list' }, arr(sol.steps).map(s => {
          const step = typeof s === 'string' ? { text: s } : s;
          return el('li', {}, step.text, ' ', arr(step.facts).map(f =>
            el('a', { class: 'ref', href: '#', onclick: e => { e.preventDefault(); jumpTo(f); } }, f)));
        })) : null),

      facts.length ? el('section', { class: 'card' },
        el('h2', {}, 'Facts used from your documents'),
        el('p', { class: 'hint' }, 'Each quote is checked against the document text. “Quote not found” means it should be checked by hand.'),
        facts.map(f => el('div', { class: 'fact', id: 'fact-' + f.id },
          el('div', {}, el('span', { class: 'ref static' }, f.id), f.fact),
          quoteBlock(f.doc, f.quote)))) : null,

      arr(r.gaps).length ? el('section', { class: 'card' },
        el('h2', {}, 'Not covered by your documents'),
        el('p', { class: 'hint' }, 'Information that would matter but wasn’t in the materials.'),
        el('ul', { class: 'list' }, arr(r.gaps).map(g => el('li', {}, g)))) : null,

      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('quiz') }, 'Back to the questions'),
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('docs') }, 'Change documents'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })));
  }

  function understandingSummary() {
    const n = S.questions.length;
    const first = S.questions.filter(q => (S.checks[q.id] || {}).attempts === 1).length;
    const revealed = S.questions.filter(q => (S.checks[q.id] || {}).revealed).length;
    let text = `All ${n} answers confirmed against your documents: ${first} right first time`;
    if (n - first) text += `, ${n - first} corrected`;
    if (revealed) text += ` (${revealed} after seeing the answer)`;
    return text + '.';
  }

  function quoteBlock(docId, quote) {
    const found = quoteFound(docId, quote);
    return el('blockquote', { class: 'quote' },
      '“' + quote + '”',
      el('div', { class: 'quote-src' }, '— ' + docName(docId),
        el('span', { class: 'verify ' + (found ? 'yes' : 'no') }, found ? 'Quote verified' : 'Quote not found')));
  }

  function jumpTo(factId) {
    const node = document.getElementById('fact-' + factId);
    if (!node) return;
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1500);
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});
    const steps = arr(sol.steps).map(s => {
      const step = typeof s === 'string' ? { text: s } : s;
      return step.text + (arr(step.facts).length ? ` [${arr(step.facts).join(', ')}]` : '');
    });
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Solution · Know your Materials · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Proposed solution', blocks: [
            { type: 'text', text: sol.summary },
            { type: 'numbers', items: steps },
          ] },
          { heading: 'Supporting facts', blocks: [{ type: 'bullets', items: arr(r.facts).map(f => ({
            text: `[${f.id}] ${f.fact}`, note: `“${f.quote}” — ${docName(f.doc)}` })) }] },
          { heading: 'Not covered by the documents', blocks: [{ type: 'bullets', items: arr(r.gaps) }] },
          { heading: 'Sources', blocks: [{ type: 'numbers', items: S.docs.map(d => d.name) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', docs: [], uploads: [], uploadErrors: [],
      questions: [], answers: {}, checks: {}, result: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
