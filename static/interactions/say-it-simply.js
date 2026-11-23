/*
 * Interaction: Say it Simply
 *
 * 1. Problem & solution - typed or from Word
 * 2. Your reader        - the AI decides who the summary is for (usually the decision-maker), with what they
 *                         need and don't need. The user doesn't choose.
 * 3. Write              - the user writes an executive summary of at most 150 words (the AI never writes it)
 * 4. Assessment         - fixed checklist; jargon highlighted in the text. The user revises until every check
 *                         passes; only then does the download unlock.
 *
 * Server steps used (see prompts/say-it-simply/):
 *   reader  payload: { problem, solution }  returns { reader, why, needs: [], doesnt_need: [] }
 *   assess  payload: { problem, solution, reader, summary, attempt, previous }
 *           returns { checks: [{ key, pass, comment }], jargon: [], overall }
 */
(() => {
  const ID = 'say-it-simply';
  const { el } = App;
  const STEPS = ['Problem & solution', 'Your reader', 'Write the summary', 'Assessment'];
  const STAGE_INDEX = { problem: 0, reader: 1, write: 2, assess: 3 };
  const LIMIT = 150;
  const CHECKS = [
    { key: 'upfront', label: 'Recommendation up front' },
    { key: 'reason', label: 'Main reason is clear' },
    { key: 'ask', label: 'The ask or next step is explicit' },
    { key: 'plain', label: 'Plain language, no jargon' },
    { key: 'faithful', label: 'Faithful to the full solution' },
  ];

  const S = {
    stage: 'problem',
    problem: '',
    solution: '',
    reader: null,
    summary: '',
    attempts: [],      // [{ summary, result }]
    busy: false,
    busyMessage: '',
    error: null,
    retry: null,
  };
  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    root.replaceChildren(...[
      App.pageHeader('Say it Simply',
        'If you can’t say it simply, you may not understand it yet. Write the summary your client will actually read.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'reader' ? readerView() : null,
      S.stage === 'write' ? writeView() : null,
      S.stage === 'assess' ? assessView() : null,
    ].filter(Boolean));
  }

  async function run(message, work) {
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
      App.scrollToTop();
    }
  }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }
  const arr = x => (Array.isArray(x) ? x : []);
  const wordCount = t => (String(t).trim().match(/\S+/g) || []).length;
  const latest = () => S.attempts[S.attempts.length - 1];
  const allPass = r => r && CHECKS.every(c => (arr(r.checks).find(x => x.key === c.key) || {}).pass === true);

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value, e) });
    t.value = value;
    return t;
  }

  function readerCard() {
    const r = S.reader || {};
    return el('section', { class: 'card persona' },
      el('div', { class: 'persona-head' }, el('span', { class: 'avatar big' }, String(r.reader || '?').replace(/^(The|A) /, '').charAt(0).toUpperCase()),
        el('div', {}, el('div', { class: 'persona-name' }, 'Writing for: ' + r.reader), r.why ? el('div', { class: 'hint' }, r.why) : null)),
      el('div', { class: 'cmp-cols' },
        el('div', {}, el('div', { class: 'mini-label' }, 'What they need to know'), el('ul', { class: 'list tight' }, arr(r.needs).map(x => el('li', {}, x)))),
        el('div', {}, el('div', { class: 'mini-label' }, 'What they don’t need'), el('ul', { class: 'list tight' }, arr(r.doesnt_need).map(x => el('li', {}, x))))));
  }

  /* ---------- Step 1 ---------- */

  function problemView() {
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 6, 'Describe the client problem.', v => { S.problem = v; }, 'input big'))),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The full solution'),
        App.withFileLoader(textArea(S.solution, 12, 'The complete solution or recommendation, with all its detail.', v => { S.solution = v; }, 'input big'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: chooseReader }, 'Who am I writing for?')));
  }

  function chooseReader() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    if (!S.solution.trim()) return fail('Please add the full solution.');
    run('Working out who needs to read this…', async () => {
      const res = await App.callLLM(ID, 'reader', { problem: S.problem.trim(), solution: S.solution.trim() });
      if (!res || !res.reader) throw new Error('The reader came back incomplete. Try again.');
      S.reader = res;
      S.summary = ''; S.attempts = [];
      S.stage = 'reader';
    });
  }

  /* ---------- Step 2 ---------- */

  function readerView() {
    return el('div', {},
      el('section', { class: 'card recap' }, el('div', { class: 'label' }, 'Your reader'),
        el('p', {}, 'Chosen because they make or shape the decision this solution needs.')),
      readerCard(),
      el('section', { class: 'card' },
        el('h2', {}, 'What a good summary does'),
        el('ul', { class: 'list' }, CHECKS.map(c => el('li', {}, c.label))),
        el('p', { class: 'hint' }, `At most ${LIMIT} words. You’ll revise until it passes every check.`)),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Back'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => goTo('write') }, 'Write the summary')));
  }

  /* ---------- Step 3 ---------- */

  function counter(text) {
    const n = wordCount(text);
    return el('span', { class: 'word-count' + (n > LIMIT ? ' over' : '') }, `${n} / ${LIMIT} words`);
  }

  function writeView() {
    const r = latest();
    const box = textArea(S.summary, 9, `Your summary for ${S.reader.reader}…`, (v) => {
      S.summary = v;
      const c = root.querySelector('.word-count');
      if (c) c.replaceWith(counter(v));
    }, 'input big');
    return el('div', {},
      readerCard(),
      el('div', { class: 'review' },
        el('section', { class: 'card sticky' },
          el('h2', {}, 'The full solution'),
          el('p', { class: 'prewrap solution-text' }, S.solution)),
        el('section', { class: 'card accent' },
          el('div', { class: 'panel-head' },
            el('h2', {}, S.attempts.length ? `Revise your summary (attempt ${S.attempts.length + 1})` : 'Your executive summary'),
            counter(S.summary)),
          r ? checklist(r, true) : null,
          box,
          el('div', { class: 'actions' },
            el('button', { class: 'btn primary', disabled: S.busy, onclick: assess }, 'Check my summary')))));
  }

  function assess() {
    const text = S.summary.trim();
    if (!text) return fail('Write your summary first.');
    if (wordCount(text) > LIMIT) return fail(`Your summary is ${wordCount(text)} words. Cut it to ${LIMIT} or fewer.`);
    const prev = latest();
    run('Reading it as your reader would…', async () => {
      const res = await App.callLLM(ID, 'assess', {
        problem: S.problem.trim(), solution: S.solution.trim(), reader: S.reader, summary: text,
        attempt: S.attempts.length + 1, previous: prev ? prev.summary : '',
      });
      if (!res || !arr(res.checks).length) throw new Error('The assessment came back incomplete. Try again.');
      S.attempts.push({ summary: text, result: res });
      S.stage = 'assess';
    });
  }

  /* ---------- Step 4 ---------- */

  function checklist(r, compact) {
    return el('div', { class: 'checklist' + (compact ? ' compact' : '') }, CHECKS.map(c => {
      const x = arr(r.checks).find(y => y.key === c.key) || {};
      return el('div', { class: 'check-row ' + (x.pass ? 'pass' : 'fail') },
        el('span', { class: 'tick' }, x.pass ? '✓' : '✗'),
        el('div', {}, el('strong', {}, c.label), x.comment && !(compact && x.pass) ? el('div', { class: 'hint' }, x.comment) : null));
    }));
  }

  function highlightJargon(text, terms) {
    const list = arr(terms).filter(Boolean).sort((a, b) => b.length - a.length);
    if (!list.length) return [text];
    const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('(' + list.map(esc).join('|') + ')', 'gi');
    return String(text).split(re).map((part, i) => i % 2 ? el('mark', { class: 'jargon', title: 'Jargon' }, part) : part);
  }

  function assessView() {
    const a = latest();
    const r = a.result;
    const passed = allPass(r);
    const nPass = CHECKS.filter(c => (arr(r.checks).find(x => x.key === c.key) || {}).pass).length;
    return el('div', {},
      readerCard(),
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, `Attempt ${S.attempts.length}`),
        el('div', { class: 'score' }, el('span', { class: 'score-big' }, `${nPass} of ${CHECKS.length}`), ' checks passed',
          passed ? el('span', { class: 'assess ok', style: 'margin-left:10px' }, 'Ready') : null),
        r.overall ? el('p', { class: 'prewrap' }, r.overall) : null),
      el('div', { class: 'review' },
        el('section', { class: 'card' },
          el('div', { class: 'panel-head' }, el('h2', {}, 'Your summary'), counter(a.summary)),
          el('p', { class: 'prewrap summary-text' }, ...highlightJargon(a.summary, r.jargon)),
          arr(r.jargon).length ? el('div', { class: 'hint' }, el('mark', { class: 'jargon' }, 'Highlighted'), ' words your reader may not use.') : null),
        el('section', { class: 'card' }, el('h2', {}, 'The checklist'), checklist(r, false))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        passed
          ? App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })
          : el('button', { class: 'btn primary', disabled: S.busy, onclick: () => goTo('write') }, 'Revise my summary')));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const a = latest();
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Executive summary for ${S.reader.reader} · Say it Simply · ${App.today()}`,
        sections: [
          { heading: 'Executive summary', blocks: [{ type: 'text', text: a.summary }] },
          { heading: 'Attachment: the full solution', blocks: [{ type: 'text', text: S.solution.trim() }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', solution: '', reader: null, summary: '', attempts: [], retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
