/*
 * Interaction: Dimensions
 *
 * 1. Problem    - user describes the problem
 * 2. Dimensions - AI picks the five most relevant dimensions (perspectives) for this problem;
 *                 the user selects which to use and can add their own view on each
 * 3. Solution   - AI proposes a solution shaped by the selected dimensions,
 *                 with a rationale organized by dimension
 *
 * Server steps used (see prompts/dimensions/):
 *   dimensions  payload: { problem }
 *   solve       payload: { problem, selected: [{ name, why_relevant, user_view }], not_selected: [name] }
 */
(() => {
  const ID = 'dimensions';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Choose dimensions', 'Solution'];
  const STAGE_INDEX = { problem: 0, choose: 1, result: 2 };

  const S = {
    stage: 'problem',     // 'problem' | 'choose' | 'result'
    problem: '',
    dims: [],             // [{ id, name, why_relevant, key_question }]
    selected: {},         // id -> true
    notes: {},            // id -> user's view (optional)
    result: null,         // { solution: { summary, steps[] }, rationale[], set_aside[] }
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
      App.pageHeader('Dimensions',
        'Decide which perspectives matter most before a solution is shaped around them.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'choose' ? chooseView() : null,
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

  function problemRecap(editable) {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'),
      el('p', { class: 'prewrap' }, S.problem),
      editable ? el('button', { class: 'btn link', onclick: () => goTo('problem'), disabled: S.busy }, 'Edit problem') : null);
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    const box = el('textarea', {
      class: 'input big', rows: 8, disabled: S.busy,
      placeholder: 'Describe the problem you want advice on, with the context someone would need to weigh it up.',
      oninput: e => { S.problem = e.target.value; },
    });
    box.value = S.problem;
    return el('section', { class: 'card' },
      el('label', { class: 'label' }, 'The problem'),
      App.withFileLoader(box),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: submitProblem }, 'Find the key dimensions')));
  }

  function submitProblem() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    run('Working out which dimensions matter most for this problem…', async () => {
      const res = await App.callLLM(ID, 'dimensions', { problem: S.problem.trim() });
      const dims = arr(res && res.dimensions).slice(0, 5);
      if (!dims.length) throw new Error('No dimensions came back. Try again.');
      S.dims = dims.map((d, i) => ({ ...d, id: d.id || 'd' + (i + 1) }));
      S.selected = {};
      S.notes = {};
      S.result = null;
      S.stage = 'choose';
    });
  }

  /* ---------- Step 2: choose dimensions ---------- */

  function chooseView() {
    const count = S.dims.filter(d => S.selected[d.id]).length;
    return el('div', {},
      problemRecap(true),
      el('section', { class: 'card' },
        el('h2', {}, 'The five dimensions that matter most here'),
        el('p', { class: 'intro' },
          'Select the dimensions the solution should be shaped around. Add your own view on any you select – for example, how much budget there really is, or which stakeholders matter most.'),
        el('div', { class: 'dims' }, S.dims.map(dimCard)),
        el('div', { class: 'actions' },
          el('span', { class: 'hint count', id: 'dim-count' }, countText(count)),
          el('button', { class: 'btn primary', disabled: S.busy, onclick: submitDims }, 'Shape a solution around these'))));
  }

  function countText(n) { return n ? `${n} of ${S.dims.length} selected` : 'None selected yet'; }

  function dimCard(d) {
    const on = !!S.selected[d.id];
    const note = el('textarea', {
      class: 'input', rows: 2, disabled: S.busy,
      placeholder: 'Your view on this dimension (optional)',
      oninput: e => { S.notes[d.id] = e.target.value; },
      onclick: e => e.stopPropagation(),
    });
    note.value = S.notes[d.id] || '';

    const card = el('div', {
      class: 'dim' + (on ? ' on' : ''),
      role: 'checkbox', 'aria-checked': on ? 'true' : 'false', tabindex: '0',
      onclick: () => toggle(d, card),
      onkeydown: e => { if (e.key === ' ' || e.key === 'Enter') { if (e.target === card) { e.preventDefault(); toggle(d, card); } } },
    },
      el('div', { class: 'dim-head' },
        el('span', { class: 'check' }, on ? '✓' : ''),
        el('span', { class: 'dim-name' }, d.name)),
      d.why_relevant ? el('p', { class: 'dim-why' }, d.why_relevant) : null,
      d.key_question ? el('div', { class: 'based-on' }, 'Key question: ' + d.key_question) : null,
      on ? note : null);
    return card;
  }

  function toggle(d, card) {
    if (S.busy) return;
    if (S.error) { S.error = null; const box = root.querySelector('.error'); if (box) box.remove(); }
    S.selected[d.id] = !S.selected[d.id];
    if (!S.selected[d.id]) delete S.selected[d.id];
    const fresh = dimCard(d);
    card.replaceWith(fresh);
    const counter = root.querySelector('#dim-count');
    if (counter) counter.textContent = countText(S.dims.filter(x => S.selected[x.id]).length);
    if (S.selected[d.id]) { const t = fresh.querySelector('textarea'); if (t) t.focus(); }
  }

  function submitDims() {
    const chosen = S.dims.filter(d => S.selected[d.id]);
    if (!chosen.length) return fail('Please select at least one dimension.');
    run('Shaping a solution around the dimensions you chose…', async () => {
      const res = await App.callLLM(ID, 'solve', {
        problem: S.problem.trim(),
        selected: chosen.map(d => ({ name: d.name, why_relevant: d.why_relevant, user_view: (S.notes[d.id] || '').trim() })),
        not_selected: S.dims.filter(d => !S.selected[d.id]).map(d => d.name),
      });
      if (!res || !res.solution) throw new Error('The solution came back incomplete. Try again.');
      S.result = res;
      S.stage = 'result';
    });
  }

  /* ---------- Step 3: solution and rationale ---------- */

  function resultView() {
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});
    const chosen = S.dims.filter(d => S.selected[d.id]);

    return el('div', {},
      problemRecap(false),
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Shaped around'),
        el('div', { class: 'chips' }, chosen.map(d => el('span', { class: 'chip on static' }, d.name)))),

      el('section', { class: 'card accent' },
        el('h2', {}, 'Proposed solution'),
        sol.summary ? el('p', { class: 'prewrap' }, sol.summary) : null,
        arr(sol.steps).length ? el('ol', { class: 'list' }, arr(sol.steps).map(s => el('li', {}, s))) : null),

      el('section', { class: 'card' },
        el('h2', {}, 'Rationale'),
        el('p', { class: 'hint' }, 'How each dimension you chose shaped the solution.'),
        el('div', { class: 'rationale' }, arr(r.rationale).map(x =>
          el('div', { class: 'rat' },
            el('div', { class: 'rat-dim' }, x.dimension),
            el('div', {}, x.reasoning))))),

      arr(r.set_aside).length
        ? el('section', { class: 'card' },
            el('h2', {}, 'Dimensions you set aside'),
            el('p', { class: 'hint' }, 'What the solution doesn’t account for because these weren’t selected.'),
            el('ul', { class: 'list' }, arr(r.set_aside).map(x =>
              el('li', {}, el('strong', {}, x.dimension + ': '), x.effect))))
        : null,

      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('choose') }, 'Change my dimensions'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc,
          { disabled: S.busy, onError: m => fail(m) })));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const r = S.result || {};
    const sol = typeof r.solution === 'string' ? { summary: r.solution } : (r.solution || {});
    const chosen = S.dims.filter(d => S.selected[d.id]);
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Solution · Dimensions · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Dimensions considered', blocks: [{ type: 'bullets', items: chosen.map(d => ({
            text: d.name, note: (S.notes[d.id] || '').trim() ? 'Our view: ' + S.notes[d.id].trim() : d.why_relevant })) }] },
          { heading: 'Proposed solution', blocks: [
            { type: 'text', text: sol.summary },
            { type: 'numbers', items: arr(sol.steps) },
          ] },
          { heading: 'Rationale', blocks: [{ type: 'bullets', items: arr(r.rationale).map(x => ({
            text: x.reasoning, note: 'Dimension: ' + x.dimension })) }] },
          { heading: 'Dimensions set aside', blocks: [{ type: 'bullets', items: arr(r.set_aside).map(x => ({
            text: x.dimension, note: x.effect })) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', dims: [], selected: {}, notes: {}, result: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
