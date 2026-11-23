/*
 * Interaction: First Draft
 *
 * 1. Problem          - user describes the problem
 * 2. Your idea        - user writes their own solution first
 * 3. Compare/combine  - AI solves the problem independently (from the problem only),
 *                       shown beside the user's; then an explanation of how they differ;
 *                       user combines both into a final answer
 * 4. Critique         - AI critiques the final answer
 *
 * Server steps used (see prompts/first-draft/):
 *   solve     payload: { problem }                         (AI never sees the user's idea)
 *   compare   payload: { problem, user_solution, ai_solution }
 *   critique  payload: { problem, user_solution, ai_solution, final_answer }
 */
(() => {
  const ID = 'first-draft';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Your solution', 'Compare & combine', 'Critique'];
  const STAGE_INDEX = { problem: 0, idea: 1, compare: 2, critique: 3 };

  const S = {
    stage: 'problem',     // 'problem' | 'idea' | 'compare' | 'critique'
    problem: '',
    userSolution: '',
    aiSolution: null,     // { summary, steps[], assumptions[] }
    comparison: null,     // { overview, common_ground[], differences[], questions_to_consider[] }
    finalAnswer: '',
    critique: null,       // { verdict, strengths[], weaknesses[], left_out[] }
    busy: false,
    busyMessage: '',
    error: null,
    retry: null,
  };

  let root = null;

  function mount(container) {
    root = container;
    root.classList.add('wide');
    render();
  }

  function render() {
    if (!root) return;
    root.replaceChildren(...[
      App.pageHeader('First Draft',
        'Write your own solution first. Then see how an AI would approach it, and combine the best of both.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'idea' ? ideaView() : null,
      S.stage === 'compare' ? compareView() : null,
      S.stage === 'critique' ? critiqueView() : null,
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

  function goTo(stage) {
    S.stage = stage; S.error = null;
    render();
    App.scrollToTop();
  }

  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }

  /* ---------- helpers ---------- */

  function textArea(value, rows, placeholder, onInput, cls = 'input big') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy,
      oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function list(items, renderItem, ordered = false) {
    return Array.isArray(items) && items.length
      ? el(ordered ? 'ol' : 'ul', { class: 'list' }, items.map(renderItem))
      : null;
  }

  function problemRecap(editable) {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'),
      el('p', { class: 'prewrap' }, S.problem),
      editable ? el('button', { class: 'btn link', onclick: () => goTo('problem'), disabled: S.busy }, 'Edit problem') : null);
  }

  function aiSolutionBody(sol) {
    if (!sol) return null;
    return el('div', {},
      sol.summary ? el('p', { class: 'prewrap' }, sol.summary) : null,
      list(sol.steps, s => el('li', {}, s), true),
      Array.isArray(sol.assumptions) && sol.assumptions.length
        ? el('div', { class: 'assumptions' },
            el('div', { class: 'mini-label' }, 'Assumptions made'),
            list(sol.assumptions, a => el('li', {}, a)))
        : null);
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    return el('section', { class: 'card' },
      el('label', { class: 'label' }, 'The problem'),
      App.withFileLoader(textArea(S.problem, 8,
        'Describe the problem you want to solve. Include the context someone would need to suggest a solution.',
        v => { S.problem = v; })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          goTo('idea');
        } }, 'Next: your solution')));
  }

  /* ---------- Step 2: user's own solution ---------- */

  function ideaView() {
    return el('div', {},
      problemRecap(true),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'Your solution'),
        el('p', { class: 'intro' },
          'Before seeing any AI suggestion, how would you solve this? Rough ideas and bullet points are fine.'),
        App.withFileLoader(textArea(S.userSolution, 10, 'Your ideas for a solution…', v => { S.userSolution = v; })),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', disabled: S.busy, onclick: submitSolution }, 'Submit my solution'))));
  }

  function submitSolution() {
    if (!S.userSolution.trim()) return fail('Please write your own solution first – even a rough one.');
    run('Drafting an independent AI solution and comparing it with yours…', async () => {
      const problem = S.problem.trim();
      const userSolution = S.userSolution.trim();
      const ai = await App.callLLM(ID, 'solve', { problem });
      if (!ai || !ai.summary) throw new Error('The AI solution came back incomplete. Try again.');
      const cmp = await App.callLLM(ID, 'compare', { problem, user_solution: userSolution, ai_solution: ai });
      if (!cmp) throw new Error('The comparison came back empty. Try again.');
      S.aiSolution = ai;
      S.comparison = cmp;
      S.critique = null;
      S.stage = 'compare';
    });
  }

  /* ---------- Step 3: side by side, differences, combine ---------- */

  function compareView() {
    const c = S.comparison || {};
    return el('div', {},
      problemRecap(false),

      el('div', { class: 'columns' },
        el('section', { class: 'card col' },
          el('h2', {}, 'Your solution'),
          el('p', { class: 'prewrap' }, S.userSolution),
          el('button', { class: 'btn link', disabled: S.busy, onclick: () => goTo('idea') }, 'Edit my solution')),
        el('section', { class: 'card col accent' },
          el('h2', {}, 'AI solution'),
          aiSolutionBody(S.aiSolution))),

      el('section', { class: 'card' },
        el('h2', {}, 'How the two differ'),
        c.overview ? el('p', { class: 'prewrap' }, c.overview) : null,
        Array.isArray(c.common_ground) && c.common_ground.length
          ? el('div', {}, el('div', { class: 'mini-label' }, 'Where they agree'),
              list(c.common_ground, x => el('li', {}, x)))
          : null,
        Array.isArray(c.differences) && c.differences.length
          ? el('div', {}, el('div', { class: 'mini-label' }, 'Where they differ'),
              el('div', { class: 'diffs' }, c.differences.map(diffRow)))
          : null),

      Array.isArray(c.questions_to_consider) && c.questions_to_consider.length
        ? el('section', { class: 'card' },
            el('h2', {}, 'Questions to consider as you combine them'),
            list(c.questions_to_consider, q => el('li', {}, q)))
        : null,

      el('section', { class: 'card' },
        el('h2', {}, 'Combine them into one answer'),
        el('p', { class: 'intro' },
          'Write a single solution that keeps the best of both. You decide what stays, what goes and what changes.'),
        el('div', { class: 'prefill' },
          el('button', { class: 'btn small', disabled: S.busy, onclick: () => prefill(S.userSolution) }, 'Start from my solution'),
          el('button', { class: 'btn small', disabled: S.busy, onclick: () => prefill(aiAsText()) }, 'Start from the AI’s')),
        App.withFileLoader(textArea(S.finalAnswer, 12, 'Your combined solution…', v => { S.finalAnswer = v; })),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start over'),
          el('button', { class: 'btn primary', disabled: S.busy, onclick: submitFinal }, 'Submit for critique'))));
  }

  function diffRow(d) {
    return el('div', { class: 'diff' },
      el('div', { class: 'diff-aspect' }, d.aspect || ''),
      el('div', { class: 'diff-grid' },
        el('div', {}, el('div', { class: 'mini-label' }, 'Yours'), el('div', {}, d.yours || '—')),
        el('div', {}, el('div', { class: 'mini-label' }, 'AI'), el('div', {}, d.ai || '—'))),
      d.why_it_matters ? el('div', { class: 'based-on' }, 'Why it matters: ' + d.why_it_matters) : null);
  }

  function aiAsText() {
    const s = S.aiSolution || {};
    const steps = Array.isArray(s.steps) ? s.steps.map((x, i) => `${i + 1}. ${x}`).join('\n') : '';
    return [s.summary, steps].filter(Boolean).join('\n\n');
  }

  // Fill the combine box from one draft. Never overwrite text the user has edited.
  function prefill(text) {
    const current = S.finalAnswer.trim();
    const untouched = !current || current === S.userSolution.trim() || current === aiAsText().trim();
    if (!untouched) {
      return fail('Your combined answer already has your edits. Clear the box first if you want to start again from one of the drafts.');
    }
    S.finalAnswer = text;
    S.error = null;
    render();
  }

  function submitFinal() {
    if (!S.finalAnswer.trim()) return fail('Please write your combined answer first.');
    run('Critiquing your final answer…', async () => {
      const res = await App.callLLM(ID, 'critique', {
        problem: S.problem.trim(),
        user_solution: S.userSolution.trim(),
        ai_solution: S.aiSolution,
        final_answer: S.finalAnswer.trim(),
      });
      if (!res || !res.verdict) throw new Error('The critique came back incomplete. Try again.');
      S.critique = res;
      S.stage = 'critique';
    });
  }

  /* ---------- Step 4: critique ---------- */

  function critiqueView() {
    const c = S.critique || {};
    return el('div', {},
      problemRecap(false),
      el('section', { class: 'card' },
        el('h2', {}, 'Your final answer'),
        el('p', { class: 'prewrap' }, S.finalAnswer)),

      el('section', { class: 'card accent' },
        el('h2', {}, 'Critique'),
        el('p', { class: 'prewrap' }, c.verdict)),

      Array.isArray(c.strengths) && c.strengths.length
        ? el('section', { class: 'card' }, el('h2', {}, 'Strengths'), list(c.strengths, x => el('li', {}, x)))
        : null,

      Array.isArray(c.weaknesses) && c.weaknesses.length
        ? el('section', { class: 'card' },
            el('h2', {}, 'Weaknesses and how to fix them'),
            list(c.weaknesses, w => el('li', {},
              el('div', {}, w.issue),
              w.suggestion ? el('div', { class: 'then' }, '→ ' + w.suggestion) : null)))
        : null,

      Array.isArray(c.left_out) && c.left_out.length
        ? el('section', { class: 'card' },
            el('h2', {}, 'Left out of the final answer'),
            el('p', { class: 'hint' }, 'Ideas from either draft that didn’t make it in, and whether that matters.'),
            list(c.left_out, x => el('li', {}, x)))
        : null,

      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('compare') }, 'Revise my final answer'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc,
          { disabled: S.busy, onError: m => { S.error = m; S.retry = null; render(); App.scrollToTop(); } })));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Final solution · First Draft · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Solution', blocks: [{ type: 'text', text: S.finalAnswer.trim() }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', userSolution: '', aiSolution: null, comparison: null,
      finalAnswer: '', critique: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
