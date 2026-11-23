/*
 * Interaction: Explain the Answer
 *
 * 1. Problem   - user describes the problem (typed or loaded from Word) and can add supporting files
 * 2. Explain   - AI generates a solution, then asks questions, one at a time, about WHY the
 *                solution is the way it is. A wrong answer gets a hint; a second wrong answer
 *                reveals the answer. Until every question is done, the solution can't be copied
 *                and the Word download is disabled.
 * 3. Download  - the AI's reasoning is shown and the solution can be copied or downloaded
 *
 * Server steps used (see prompts/explain-the-answer/):
 *   solve  payload: { problem, documents: [{ id, name, text }] }
 *          returns the solution, the reasoning behind it, and the questions with expected answers
 *   check  payload: { problem, solution, reasoning, question, expected_answer, key_points, answer, attempt }
 */
(() => {
  const ID = 'explain-the-answer';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Explain the solution', 'Download'];

  const S = {
    stage: 'problem',     // 'problem' | 'explain'
    problem: '',
    docs: [],             // [{ name, text, chars, note }]
    uploads: 0,
    uploadErrors: [],
    result: null,         // { solution: { summary, steps[] }, reasoning[], questions[] }
    qs: {},               // question id -> { answer, attempts, status: 'open'|'correct'|'revealed', hint, feedback }
    busy: false,
    busyMessage: '',
    checking: null,       // id of the question being checked
    error: null,
    retry: null,
  };
  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    const stepIndex = S.stage === 'problem' ? 0 : (allDone() ? 2 : 1);
    root.replaceChildren(...[
      App.pageHeader('Explain the Answer',
        'Get a solution – then show you understand why it’s the right one before you take it away.'),
      App.stepper(STEPS, stepIndex),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy && !S.checking ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'explain' && S.result ? explainView() : null,
    ].filter(Boolean));
  }

  async function run(message, work, { scroll = true } = {}) {
    S.busy = true; S.busyMessage = message; S.error = null; S.retry = null;
    const main = document.getElementById('main');
    const y = main ? main.scrollTop : 0;
    render();
    if (scroll) App.scrollToTop(); else if (main) main.scrollTop = y;
    try {
      await work();
    } catch (e) {
      S.error = e.message;
      S.retry = () => run(message, work, { scroll });
    } finally {
      S.busy = false;
      S.checking = null;
      const y2 = main ? main.scrollTop : 0;
      render();
      if (S.error || scroll) App.scrollToTop(); else if (main) main.scrollTop = y2;
    }
  }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }
  const arr = x => (Array.isArray(x) ? x : []);
  const words = n => Math.max(1, Math.round(n / 6)).toLocaleString();

  function questions() { return arr(S.result && S.result.questions); }
  function allDone() {
    const q = questions();
    return q.length > 0 && q.every(x => S.qs[x.id] && S.qs[x.id].status !== 'open');
  }

  /* ---------- Step 1: problem and optional files ---------- */

  function problemView() {
    const box = el('textarea', { class: 'input big', rows: 8, disabled: S.busy,
      placeholder: 'Describe the problem you want a solution for.',
      oninput: e => { S.problem = e.target.value; } });
    box.value = S.problem;

    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(box),
        el('div', { class: 'materials-row' },
          el('div', { class: 'mini-label' }, 'Supporting materials (optional)'),
          App.materialsPicker(S, render, { disabled: S.busy, hint: 'Add documents about the company or industry for the AI to take into account when it writes the solution.' }))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy || S.uploads > 0, onclick: generate }, 'Generate a solution')));
  }

  function generate() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    run('Generating a solution and preparing questions about it…', async () => {
      const res = await App.callLLM(ID, 'solve', {
        problem: S.problem.trim(),
        documents: S.docs.map((d, i) => ({ id: 'D' + (i + 1), name: d.name, text: d.text })),
      });
      if (!res || !res.solution || !arr(res.questions).length) throw new Error('The solution came back incomplete. Try again.');
      res.questions = arr(res.questions).slice(0, 5).map((q, i) => ({ ...q, id: q.id || 'q' + (i + 1) }));
      S.result = res;
      S.qs = {};
      res.questions.forEach(q => { S.qs[q.id] = { answer: '', attempts: 0, status: 'open', hint: '', feedback: '' }; });
      S.stage = 'explain';
    });
  }

  /* ---------- Step 2: solution and questions ---------- */

  function solutionText() {
    const sol = typeof S.result.solution === 'string' ? { summary: S.result.solution } : (S.result.solution || {});
    return { summary: sol.summary || '', steps: arr(sol.steps) };
  }

  function explainView() {
    const done = allDone();
    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'The problem'),
        el('p', { class: 'prewrap' }, S.problem),
        S.docs.length ? el('div', { class: 'hint' }, 'Using: ' + S.docs.map(d => d.name).join(', ')) : null),
      el('div', { class: 'review' },
        solutionPanel(done),
        el('div', {}, questionsPanel(), done ? reasoningPanel() : null)),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Edit problem'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        done
          ? App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })
          : el('button', { class: 'btn primary', disabled: true, title: 'Answer all the questions first' },
              'Answer all questions to download')));
  }

  function solutionPanel(done) {
    const { summary, steps } = solutionText();
    const blocked = e => {
      if (allDone()) return;
      e.preventDefault();
      const n = root.querySelector('.copy-note');
      if (n) { n.classList.add('flash'); setTimeout(() => n.classList.remove('flash'), 1200); }
    };
    return el('section', { class: 'card sticky accent' },
      el('div', { class: 'panel-head' },
        el('h2', {}, 'Proposed solution'),
        el('span', { class: 'version' }, done ? 'Unlocked' : '🔒 Locked')),
      done ? null : el('div', { class: 'copy-note' },
        'Copying and downloading are turned off until you’ve answered the questions.'),
      el('div', {
        class: 'solution-box' + (done ? '' : ' locked'),
        oncopy: blocked, oncut: blocked, oncontextmenu: blocked, ondragstart: blocked,
      },
        summary ? el('p', { class: 'prewrap' }, summary) : null,
        steps.length ? el('ol', { class: 'list' }, steps.map(s => el('li', {}, s))) : null));
  }

  function questionsPanel() {
    const qs = questions();
    const current = qs.findIndex(q => S.qs[q.id].status === 'open');
    const shown = current === -1 ? qs : qs.slice(0, current + 1);
    const doneCount = qs.filter(q => S.qs[q.id].status !== 'open').length;

    return el('section', { class: 'card' },
      el('div', { class: 'panel-head' },
        el('h2', {}, 'Explain the answer'),
        el('span', { class: 'version' }, `${doneCount} of ${qs.length} done`)),
      el('p', { class: 'intro' },
        'Why is the solution the way it is? Answer in your own words. You get two tries per question – a hint after the first.'),
      shown.map((q, i) => questionCard(q, i)));
  }

  const STATUS = {
    correct: ['Correct', 'ok'],
    revealed: ['Answer shown', 'miss'],
  };

  function questionCard(q, i) {
    const st = S.qs[q.id];
    const checking = S.checking === q.id;

    if (st.status !== 'open') {
      const [label, cls] = STATUS[st.status];
      return el('div', { class: 'question' },
        el('div', { class: 'q-text' }, el('span', { class: 'assess ' + cls }, label),
          el('span', { class: 'q-num' }, `${i + 1}.`), q.question),
        el('div', { class: 'your-answer' }, 'You said: ' + st.answer),
        st.status === 'revealed'
          ? el('div', { class: 'reveal' }, el('div', { class: 'mini-label' }, 'The answer'), el('div', {}, q.answer))
          : null,
        st.feedback ? el('div', { class: 'hint' }, st.feedback) : null);
    }

    const box = el('textarea', { class: 'input', rows: 3, disabled: S.busy,
      placeholder: st.attempts ? 'Try again…' : 'Your answer',
      oninput: e => { st.answer = e.target.value; } });
    box.value = st.answer;

    return el('div', { class: 'question needs-fix', id: 'q-' + q.id },
      el('div', { class: 'q-text' },
        st.attempts ? el('span', { class: 'assess part' }, 'Not quite') : null,
        el('span', { class: 'q-num' }, `${i + 1}.`), q.question),
      st.hint ? el('div', { class: 'hint-box' }, el('strong', {}, 'Hint: '), st.hint) : null,
      box,
      checking ? App.spinner('Checking your answer…') : null,
      el('div', { class: 'point-actions' },
        el('span', { class: 'tries' }, st.attempts ? 'Last try' : 'Two tries'),
        el('button', { class: 'btn small primary', disabled: S.busy, onclick: () => submit(q) }, 'Check answer')));
  }

  function submit(q) {
    const st = S.qs[q.id];
    const answer = (st.answer || '').trim();
    if (!answer) return fail('Write an answer first.');
    S.checking = q.id;
    run('Checking your answer…', async () => {
      const { summary, steps } = solutionText();
      const res = await App.callLLM(ID, 'check', {
        problem: S.problem.trim(),
        solution: { summary, steps },
        reasoning: arr(S.result.reasoning),
        question: q.question,
        expected_answer: q.answer,
        key_points: arr(q.key_points),
        answer,
        attempt: st.attempts + 1,
      });
      if (!res || typeof res.correct !== 'boolean') throw new Error('The check came back incomplete. Try again.');
      st.attempts += 1;
      if (res.correct) {
        st.status = 'correct';
        st.feedback = res.feedback || '';
      } else if (st.attempts >= 2) {
        st.status = 'revealed';
        st.feedback = res.feedback || '';
      } else {
        st.hint = res.hint || 'Look again at what the solution does first, and why.';
        st.answer = answer;
      }
    }, { scroll: false }).then(() => {
      // Bring the next open question into view.
      const next = root && root.querySelector('.question.needs-fix textarea');
      if (next && !S.error) { next.scrollIntoView({ behavior: 'smooth', block: 'center' }); next.focus({ preventScroll: true }); }
    });
  }

  /* ---------- Step 3: reasoning and download ---------- */

  function reasoningPanel() {
    const qs = questions();
    const first = qs.filter(q => S.qs[q.id].status === 'correct' && S.qs[q.id].attempts === 1).length;
    const second = qs.filter(q => S.qs[q.id].status === 'correct' && S.qs[q.id].attempts === 2).length;
    const shown = qs.filter(q => S.qs[q.id].status === 'revealed').length;
    return el('section', { class: 'card' },
      el('h2', {}, 'Why the solution looks like this'),
      el('p', { class: 'hint' },
        `You explained ${first + second} of ${qs.length}: ${first} first time, ${second} after a hint` +
        (shown ? `; ${shown} answer${shown > 1 ? 's' : ''} shown.` : '.')),
      el('ul', { class: 'list' }, arr(S.result.reasoning).map(r => el('li', {}, r))));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const { summary, steps } = solutionText();
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Solution · Explain the Answer · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Proposed solution', blocks: [{ type: 'text', text: summary }, { type: 'numbers', items: steps }] },
          { heading: 'Why this solution', blocks: [{ type: 'bullets', items: arr(S.result.reasoning) }] },
          { heading: 'Sources', blocks: [{ type: 'numbers', items: S.docs.map(d => d.name) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', docs: [], uploadErrors: [], result: null, qs: {}, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
