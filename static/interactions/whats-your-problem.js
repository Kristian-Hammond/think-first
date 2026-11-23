/*
 * Interaction: What's your Problem
 *
 * 1. Problem  - user describes the problem they want advice on
 * 2. Clarify  - the model asks clarifying questions; user answers
 * 3. Solution - the model restates the problem, proposes a solution,
 *               explains the rationale and how other answers would change it
 *
 * Server steps used (see prompts/whats-your-problem/):
 *   questions  payload: { problem }
 *   solution   payload: { problem, answers: [{ question, answer }] }
 */
(() => {
  const ID = 'whats-your-problem';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Clarify', 'Restate & solve'];

  // State survives switching to another interaction and back.
  const S = {
    stage: 'problem',      // 'problem' | 'questions' | 'result'
    problem: '',
    questions: [],         // [{ id, question, why, options? }]
    answers: {},           // id -> { choice, detail }
    result: null,
    busy: false,
    busyMessage: '',
    error: null,
    retry: null,
  };

  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    const stageIndex = { problem: 0, questions: 1, result: 2 }[S.stage];
    root.replaceChildren(...[
      App.pageHeader('What’s your Problem',
        'Get clear on the problem before anyone proposes a solution.'),
      App.stepper(STEPS, stageIndex),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'questions' ? questionsView() : null,
      S.stage === 'result' ? resultView() : null,
    ].filter(Boolean));
  }

  async function run(message, work) {
    const stageBefore = S.stage;
    S.busy = true; S.busyMessage = message; S.error = null; S.retry = null;
    render();
    App.scrollToTop();  // so the "working…" message is visible
    try {
      await work();
    } catch (e) {
      S.error = e.message;
      S.retry = () => run(message, work);
    } finally {
      S.busy = false;
      render();
      // New step or an error: bring the top of the page into view.
      if (S.stage !== stageBefore || S.error) App.scrollToTop();
    }
  }

  function goTo(stage) {
    S.stage = stage; S.error = null;
    render();
    App.scrollToTop();
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    const box = el('textarea', {
      class: 'input big',
      rows: 8,
      placeholder: 'Describe the problem you want advice on. What’s happening, who is affected, and what does a good outcome look like?',
      oninput: e => { S.problem = e.target.value; },
      disabled: S.busy,
    });
    box.value = S.problem;
    return el('section', { class: 'card' },
      el('label', { class: 'label' }, 'The problem'),
      App.withFileLoader(box),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', onclick: submitProblem, disabled: S.busy }, 'Submit problem')));
  }

  function submitProblem() {
    if (!S.problem.trim()) { S.error = 'Please describe the problem first.'; S.retry = null; render(); return; }
    run('Working out what to ask you…', async () => {
      const res = await App.callLLM(ID, 'questions', { problem: S.problem.trim() });
      if (!res || !Array.isArray(res.questions) || !res.questions.length) {
        throw new Error('No questions came back. Try again.');
      }
      S.questions = res.questions.map((q, i) => ({ ...q, id: q.id || 'q' + (i + 1) }));
      S.answers = {};
      S.result = null;
      S.stage = 'questions';
    });
  }

  /* ---------- Step 2: clarifying questions ---------- */

  function questionsView() {
    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Your problem'),
        el('p', { class: 'prewrap' }, S.problem),
        el('button', { class: 'btn link', onclick: editProblem, disabled: S.busy }, 'Edit problem')),
      el('section', { class: 'card' },
        el('p', { class: 'intro' },
          'Before suggesting anything, think through these questions. Answer what you can – leave blank anything you don’t know.'),
        S.questions.map((q, i) => questionField(q, i)),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', onclick: submitAnswers, disabled: S.busy }, 'Get restatement & solution'))));
  }

  function questionField(q, i) {
    const a = S.answers[q.id] || (S.answers[q.id] = { choice: '', detail: '' });
    const options = Array.isArray(q.options) ? q.options.filter(Boolean) : [];

    const chips = options.length
      ? el('div', { class: 'chips' }, options.map(opt =>
          el('button', {
            type: 'button',
            class: 'chip' + (a.choice === opt ? ' on' : ''),
            disabled: S.busy,
            onclick: e => {
              a.choice = a.choice === opt ? '' : opt;
              e.target.parentNode.querySelectorAll('.chip').forEach(c =>
                c.classList.toggle('on', c.textContent === a.choice));
            },
          }, opt)))
      : null;

    const detail = el('textarea', {
      class: 'input',
      rows: 2,
      placeholder: options.length ? 'Add detail (optional)' : 'Your answer',
      disabled: S.busy,
      oninput: e => { a.detail = e.target.value; },
    });
    detail.value = a.detail;

    return el('div', { class: 'question' },
      el('div', { class: 'q-text' }, el('span', { class: 'q-num' }, `${i + 1}.`), q.question),
      q.why ? el('div', { class: 'q-why' }, 'Why this matters: ' + q.why) : null,
      chips,
      detail);
  }

  function editProblem() { goTo('problem'); }

  function answerText(q) {
    const a = S.answers[q.id] || {};
    const parts = [a.choice, (a.detail || '').trim()].filter(Boolean);
    return parts.length ? parts.join(' – ') : '(not answered)';
  }

  function submitAnswers() {
    const answers = S.questions.map(q => ({ question: q.question, answer: answerText(q) }));
    run('Restating the problem and drafting a solution…', async () => {
      const res = await App.callLLM(ID, 'solution', { problem: S.problem.trim(), answers });
      if (!res || !res.restatement) throw new Error('The response was incomplete. Try again.');
      S.result = res;
      S.stage = 'result';
    });
  }

  /* ---------- Step 3: restatement, solution, rationale ---------- */

  function list(items, render) {
    return Array.isArray(items) && items.length ? el('ul', { class: 'list' }, items.map(render)) : null;
  }

  function resultView() {
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});

    return el('div', {},
      el('section', { class: 'card' },
        el('h2', {}, 'The problem, restated'),
        el('p', { class: 'prewrap' }, r.restatement)),

      el('section', { class: 'card accent' },
        el('h2', {}, 'Proposed solution'),
        sol.summary ? el('p', { class: 'prewrap' }, sol.summary) : null,
        Array.isArray(sol.steps) && sol.steps.length
          ? el('ol', { class: 'list' }, sol.steps.map(s => el('li', {}, s))) : null),

      el('section', { class: 'card' },
        el('h2', {}, 'Why this solution'),
        el('p', { class: 'hint' }, 'Each point is tied to what you told us.'),
        list(r.rationale, x => el('li', {},
          el('div', {}, x.point),
          x.based_on ? el('div', { class: 'based-on' }, 'Based on: ' + x.based_on) : null))),

      el('section', { class: 'card' },
        el('h2', {}, 'How the answer would change'),
        el('p', { class: 'hint' }, 'If some of your answers were different, the recommendation would shift.'),
        list(r.what_if, x => el('li', {},
          el('div', { class: 'if' }, 'If ' + x.if),
          el('div', { class: 'then' }, '→ ' + x.then)))),

      Array.isArray(r.open_questions) && r.open_questions.length
        ? el('section', { class: 'card' },
            el('h2', {}, 'Still worth finding out'),
            list(r.open_questions, q => el('li', {}, q)))
        : null,

      el('div', { class: 'actions' },
        el('button', { class: 'btn', onclick: reviseAnswers, disabled: S.busy }, 'Revise my answers'),
        el('button', { class: 'btn', onclick: startOver, disabled: S.busy }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc,
          { disabled: S.busy, onError: m => { S.error = m; S.retry = null; render(); App.scrollToTop(); } })));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});
    const arr = x => (Array.isArray(x) ? x : []);
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Problem and proposed solution · What’s your Problem · ${App.today()}`,
        sections: [
          { heading: 'The problem, restated', blocks: [{ type: 'text', text: r.restatement }] },
          { heading: 'Proposed solution', blocks: [
            { type: 'text', text: sol.summary },
            { type: 'numbers', items: arr(sol.steps) },
          ] },
          { heading: 'Why this solution', blocks: [
            { type: 'bullets', items: arr(r.rationale).map(x => ({ text: x.point, note: x.based_on ? 'Based on: ' + x.based_on : '' })) },
          ] },
          { heading: 'How the answer would change', blocks: [
            { type: 'bullets', items: arr(r.what_if).map(x => ({ text: 'If ' + x.if, note: '→ ' + x.then })) },
          ] },
          { heading: 'Still worth finding out', blocks: [{ type: 'bullets', items: arr(r.open_questions) }] },
          { heading: 'Background: the problem as first described', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Background: clarifying questions and answers', blocks:
            S.questions.map(q => ({ type: 'qa', question: q.question, answer: answerText(q) })) },
        ],
      },
    };
  }

  function reviseAnswers() { goTo('questions'); }

  function startOver() {
    Object.assign(S, { problem: '', questions: [], answers: {}, result: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
