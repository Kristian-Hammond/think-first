/*
 * Interaction: Devil's Advocate
 *
 * 1. Problem & solution - user describes the problem and their solution (typed or from Word)
 * 2. Respond            - the system picks the 3-4 people most likely to object to THIS plan (the user has
 *                         no say), and each presents one objection in character; the user responds to each
 * 3. Revised solution   - the AI integrates the user's responses into the solution: changes where the user
 *                         conceded or adjusted, added reasoning where they defended. Shown with changes
 *                         highlighted against the original.
 *
 * Server steps used (see prompts/devils-advocate/):
 *   objections payload: { problem, solution }
 *              returns { objections: [{ challenger, role, objection, target }] }
 *   integrate  payload: { problem, solution, exchanges: [{ challenger, objection, response }] }
 *              returns { revised_solution, changes: [{ challenger, change }], note }
 */
(() => {
  const ID = 'devils-advocate';
  const { el } = App;
  const STEPS = ['Problem & solution', 'Respond to the objections', 'Revised solution'];
  const STAGE_INDEX = { problem: 0, respond: 1, result: 2 };
  const S = {
    stage: 'problem',
    problem: '',
    solution: '',
    objections: [],      // [{ id, challenger, role, objection, target, response }]
    result: null,        // { revised_solution, changes, note }
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
      App.pageHeader('Devil’s Advocate',
        'Face the objections now, and build your answers into the solution before the client sees it.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'respond' ? respondView() : null,
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

  /* ---------- Step 1: problem and solution ---------- */

  function problemView() {
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 6, 'Describe the client problem.', v => { S.problem = v; }, 'input big'))),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'Your solution'),
        App.withFileLoader(textArea(S.solution, 10, 'Your recommendation, as you would present it.', v => { S.solution = v; }, 'input big'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          if (!S.solution.trim()) return fail('Please write your solution.');
          getObjections();
        } }, 'Face the objections')));
  }

  function getObjections() {
    run('Finding the people most likely to push back on your plan\u2026', async () => {
      const res = await App.callLLM(ID, 'objections', { problem: S.problem.trim(), solution: S.solution.trim() });
      const objs = arr(res && res.objections).slice(0, 4);
      if (!objs.length) throw new Error('No objections came back. Try again.');
      S.objections = objs.map((o, i) => ({ id: 'o' + (i + 1), challenger: o.challenger || 'Challenger', role: o.role || '',
        objection: o.objection, target: o.target || '', response: '' }));
      S.result = null;
      S.stage = 'respond';
    });
  }

  /* ---------- Step 2: respond ---------- */

  function respondView() {
    return el('div', {},
      el('div', { class: 'review' },
        el('section', { class: 'card sticky' },
          el('h2', {}, 'Your solution'),
          el('p', { class: 'prewrap solution-text' }, S.solution)),
        el('div', {},
          el('section', { class: 'card' },
            el('p', { class: 'intro' },
              'Respond to each objection as you would in the room. You can defend the plan, concede a point, or say what you’d change – your answers will be built into the solution.')),
          S.objections.map(o => el('section', { class: 'card point' },
            el('div', { class: 'persona-head' }, el('span', { class: 'avatar' }, o.challenger.replace(/^(The|A) /, '').charAt(0).toUpperCase()),
              el('div', {}, el('div', { class: 'persona-name' }, o.challenger),
                el('div', { class: 'hint' }, [o.role, o.target ? 'On: ' + o.target : ''].filter(Boolean).join(' \u00b7 ')))),
            el('div', { class: 'speech' }, o.objection),
            textArea(o.response, 4, 'Your response…', v => { o.response = v; }))),
          el('div', { class: 'actions' },
            el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Edit problem or solution'),
            el('button', { class: 'btn primary', disabled: S.busy, onclick: integrate }, 'Build my responses into the solution')))));
  }

  function integrate() {
    if (S.objections.some(o => !o.response.trim())) return fail('Respond to every objection first.');
    run('Building your responses into the solution…', async () => {
      const res = await App.callLLM(ID, 'integrate', {
        problem: S.problem.trim(), solution: S.solution.trim(),
        exchanges: S.objections.map(o => ({ challenger: o.challenger, objection: o.objection, response: o.response.trim() })),
      });
      if (!res || !res.revised_solution) throw new Error('The revised solution came back empty. Try again.');
      S.result = res;
      S.stage = 'result';
    });
  }

  /* ---------- Step 3: revised solution ---------- */

  // Word-level diff of the original and revised solution.
  function diffNodes(before, after) {
    const a = before.split(/(\s+)/), b = after.split(/(\s+)/);
    const n = a.length, m = b.length;
    if (n * m > 4000000) return [document.createTextNode(after)];
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    const push = (type, text) => { const last = out[out.length - 1]; if (last && last.type === type) last.text += text; else out.push({ type, text }); };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) push('del', a[i++]);
    while (j < m) push('ins', b[j++]);
    return out.map(p => p.type === 'same' ? document.createTextNode(p.text) : el(p.type, {}, p.text));
  }

  let showChanges = true;

  function resultView() {
    const r = S.result || {};
    const revised = String(r.revised_solution || '').trim();
    return el('div', {},
      r.note ? el('section', { class: 'card recap' }, el('div', { class: 'label' }, 'What changed'), el('p', { class: 'prewrap' }, r.note)) : null,
      el('div', { class: 'review' },
        el('section', { class: 'card sticky accent' },
          el('div', { class: 'panel-head' },
            el('h2', {}, 'Revised solution'),
            el('button', { class: 'btn link', onclick: () => { showChanges = !showChanges; render(); } },
              showChanges ? 'Hide changes' : 'Show changes')),
          showChanges ? el('p', { class: 'hint' }, el('ins', {}, 'added'), '  ', el('del', {}, 'removed'), ' compared with your original') : null,
          el('div', { class: 'prewrap solution-text' }, ...(showChanges ? diffNodes(S.solution.trim(), revised) : [revised]))),
        el('div', {},
          S.objections.map(o => {
            const ch = arr(r.changes).find(c => c.challenger === o.challenger);
            return el('section', { class: 'card point accepted' },
              el('div', { class: 'persona-name' }, o.challenger),
              el('div', { class: 'speech' }, o.objection),
              el('div', { class: 'your-reply' }, el('div', { class: 'mini-label' }, 'Your response'), o.response),
              ch ? el('div', { class: 'hint judged ok' }, el('strong', {}, 'In the solution: '), ch.change) : null);
          }))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('respond') }, 'Revise my responses'),
        el('button', { class: 'btn', disabled: S.busy, onclick: useAsNew }, 'Face new objections to this version'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })));
  }

  function useAsNew() {
    S.solution = String((S.result || {}).revised_solution || S.solution).trim();
    S.objections = [];
    S.result = null;
    getObjections();
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const r = S.result || {};
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Revised solution · Devil’s Advocate · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Solution', blocks: [{ type: 'text', text: String(r.revised_solution || '').trim() }] },
          { heading: 'Objections and responses', blocks: [{ type: 'table',
            columns: ['Raised by', 'Objection', 'Response', 'Reflected in the solution'], widths: [16, 28, 28, 28],
            rows: S.objections.map(o => {
              const ch = arr(r.changes).find(c => c.challenger === o.challenger);
              return [o.challenger, o.objection, o.response.trim(), ch ? ch.change : ''];
            }) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', solution: '', objections: [], result: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
