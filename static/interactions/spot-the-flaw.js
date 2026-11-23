/*
 * Interaction: Spot the Flaw
 *
 * 1. Problem  - user describes the problem (typed or from Word), optional supporting files,
 *               and picks a difficulty
 * 2. Find     - AI writes a plausible solution with 1-3 planted flaws (the user isn't told how many).
 *               The user selects passages they think are wrong, flags them, and says why.
 * 3. Reveal   - AI compares the user's flags with the planted flaws: found, missed, false alarms,
 *               and whether the user's reasoning was right. Shows the corrected solution.
 *
 * Server steps used (see prompts/spot-the-flaw/):
 *   generate  payload: { problem, documents, difficulty }
 *             returns { solution, flaws: [{ id, quote, type, explanation, correction }], look_for: [areas], corrected_solution }
 *   review    payload: { problem, solution, flaws, flags: [{ id, text, reason }] }
 *             returns { found: [{ flaw_id, flag_id, reasoning_ok, comment }], false_alarms: [{ flag_id, comment }], overall }
 */
(() => {
  const ID = 'spot-the-flaw';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Find the flaws', 'Reveal'];
  const STAGE_INDEX = { problem: 0, find: 1, reveal: 2 };

  const S = {
    stage: 'problem',
    problem: '',
    difficulty: 'standard',   // 'standard' | 'hard'
    docs: [],
    uploads: 0,
    uploadErrors: [],
    gen: null,                // { solution, flaws, corrected_solution }
    flags: [],                // [{ id, text, reason }]
    review: null,
    selectionNote: '',
    busy: false,
    busyMessage: '',
    error: null,
    retry: null,
  };
  let nextFlag = 1;
  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    root.replaceChildren(...[
      App.pageHeader('Spot the Flaw',
        'The AI’s solution sounds right – but it contains deliberate mistakes. Can you find them?'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'find' ? findView() : null,
      S.stage === 'reveal' ? revealView() : null,
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
  const words = n => Math.max(1, Math.round(n / 6)).toLocaleString();

  function sol(x) { return typeof x === 'string' ? { summary: x, steps: [] } : { summary: (x || {}).summary || '', steps: arr((x || {}).steps) }; }
  function solutionPlain(x) { const s = sol(x); return [s.summary, ...s.steps].join('\n'); }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    const box = el('textarea', { class: 'input big', rows: 8, disabled: S.busy,
      placeholder: 'Describe the problem you want a solution for.',
      oninput: e => { S.problem = e.target.value; } });
    box.value = S.problem;

    const level = (key, label, desc) => el('button', { type: 'button',
      class: 'chip' + (S.difficulty === key ? ' on' : ''), disabled: S.busy,
      title: desc, onclick: () => { S.difficulty = key; render(); } }, label);

    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(box),
        el('div', { class: 'materials-row' },
          el('div', { class: 'mini-label' }, 'Supporting materials (optional)'),
          App.materialsPicker(S, render, { disabled: S.busy, hint: 'Add documents about the company or industry. If you do, some of the planted flaws may contradict what they say.' }))),
      el('section', { class: 'card' },
        el('h2', {}, 'Difficulty'),
        el('div', { class: 'chips' },
          level('standard', 'Standard', 'Flaws a careful reader should catch'),
          level('hard', 'Hard', 'Subtle flaws that take real thought to spot')),
        el('p', { class: 'hint' }, S.difficulty === 'hard'
          ? 'Hard: subtle flaws that take real thought to spot.'
          : 'Standard: flaws a careful reader should catch.')),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy || S.uploads > 0, onclick: generate }, 'Generate the solution')));
  }

  function generate() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    run('Writing a solution (with a few hidden mistakes)…', async () => {
      const res = await App.callLLM(ID, 'generate', {
        problem: S.problem.trim(),
        difficulty: S.difficulty,
        documents: S.docs.map((d, i) => ({ id: 'D' + (i + 1), name: d.name, text: d.text })),
      });
      if (!res || !res.solution || !arr(res.flaws).length) throw new Error('The solution came back incomplete. Try again.');
      res.flaws = arr(res.flaws).map((f, i) => ({ ...f, id: f.id || 'f' + (i + 1) }));
      S.gen = res;
      S.flags = [];
      S.review = null;
      S.selectionNote = '';
      S.stage = 'find';
    });
  }

  /* ---------- Step 2: find the flaws ---------- */

  // Render text with some passages highlighted: marks = [{ text, cls, label }]
  function highlighted(text, marks) {
    const hits = [];
    marks.forEach(m => {
      const t = (m.text || '').trim();
      if (!t) return;
      const at = text.indexOf(t);
      if (at >= 0 && !hits.some(h => at < h.end && at + t.length > h.start)) hits.push({ start: at, end: at + t.length, m });
    });
    hits.sort((a, b) => a.start - b.start);
    const out = [];
    let pos = 0;
    hits.forEach(h => {
      if (h.start > pos) out.push(text.slice(pos, h.start));
      out.push(el('mark', { class: h.m.cls, title: h.m.label || '' }, text.slice(h.start, h.end),
        h.m.label ? el('sup', {}, h.m.label) : null));
      pos = h.end;
    });
    if (pos < text.length) out.push(text.slice(pos));
    return out;
  }

  function solutionBody(solution, marks, id) {
    const s = sol(solution);
    return el('div', { class: 'solution-box flaw-text', id },
      s.summary ? el('p', {}, ...highlighted(s.summary, marks)) : null,
      s.steps.length ? el('ol', { class: 'list' }, s.steps.map(st => el('li', {}, ...highlighted(st, marks)))) : null);
  }

  function findView() {
    const marks = S.flags.map((f, i) => ({ text: f.text, cls: 'flag', label: String(i + 1) }));
    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'The problem'),
        el('p', { class: 'prewrap' }, S.problem)),
      lookForCard(),
      el('div', { class: 'review' },
        el('section', { class: 'card sticky accent' },
          el('div', { class: 'panel-head' },
            el('h2', {}, 'Proposed solution'),
            el('span', { class: 'version' }, S.difficulty === 'hard' ? 'Hard' : 'Standard')),
          el('p', { class: 'hint' },
            'It contains at least one deliberate mistake. Select the words you think are wrong, then click Flag selection.'),
          solutionBody(S.gen.solution, marks, 'flaw-solution'),
          el('div', { class: 'panel-actions' },
            S.selectionNote ? el('span', { class: 'loader-status err' }, S.selectionNote) : null,
            el('button', { class: 'btn small primary', disabled: S.busy, onmousedown: e => e.preventDefault(),
              onclick: flagSelection }, 'Flag selection'))),
        el('section', { class: 'card' },
          el('div', { class: 'panel-head' },
            el('h2', {}, 'Your flags'),
            el('span', { class: 'version' }, `${S.flags.length} flagged`)),
          S.flags.length ? null : el('p', { class: 'hint' }, 'Nothing flagged yet.'),
          S.flags.map((f, i) => el('div', { class: 'question' },
            el('div', { class: 'q-text' }, el('span', { class: 'q-num' }, `${i + 1}.`), '“' + f.text + '”'),
            (() => {
              const t = el('textarea', { class: 'input', rows: 2, placeholder: 'Why is this wrong?', disabled: S.busy,
                oninput: e => { f.reason = e.target.value; } });
              t.value = f.reason;
              return t;
            })(),
            el('div', { class: 'point-actions' },
              el('button', { class: 'btn link danger', disabled: S.busy,
                onclick: () => { S.flags = S.flags.filter(x => x !== f); render(); } }, 'Remove')))),
          el('div', { class: 'actions' },
            el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Edit problem'),
            el('button', { class: 'btn primary', disabled: S.busy, onclick: reveal }, 'I’m done – reveal the flaws')))));
  }

  // Areas to examine: cover every planted flaw in general terms, plus one or two that are sound.
  function lookForCard() {
    const items = arr(S.gen && S.gen.look_for);
    if (!items.length) return null;
    return el('section', { class: 'card look-for' },
      el('h2', {}, 'What to look for'),
      el('p', { class: 'hint' },
        'In evaluating this solution, consider the areas below. The flaws are in some of them \u2013 not all of them.'),
      el('ul', { class: 'list' }, items.map(x => el('li', {}, x))));
  }

  function flagSelection() {
    const sel = window.getSelection();
    const box = root.querySelector('#flaw-solution');
    const text = sel ? sel.toString().replace(/\s+/g, ' ').trim() : '';
    if (!text || !box || !sel.rangeCount || !box.contains(sel.getRangeAt(0).commonAncestorContainer)) {
      S.selectionNote = 'Select some words in the solution first.';
      render();
      return;
    }
    if (S.flags.some(f => f.text === text)) { S.selectionNote = 'You’ve already flagged that.'; render(); return; }
    S.flags.push({ id: 'g' + (nextFlag++), text, reason: '' });
    S.selectionNote = '';
    sel.removeAllRanges();
    render();
    const boxes = root.querySelectorAll('.question textarea');
    if (boxes.length) boxes[boxes.length - 1].focus();
  }

  function reveal() {
    const missingReason = S.flags.find(f => !f.reason.trim());
    if (missingReason) return fail('Say why each flagged passage is wrong – your reasoning counts too.');
    run('Comparing your flags with the planted flaws…', async () => {
      const res = await App.callLLM(ID, 'review', {
        problem: S.problem.trim(),
        solution: sol(S.gen.solution),
        flaws: S.gen.flaws,
        flags: S.flags.map(f => ({ id: f.id, text: f.text, reason: f.reason.trim() })),
      });
      if (!res) throw new Error('The review came back empty. Try again.');
      S.review = res;
      S.stage = 'reveal';
    });
  }

  /* ---------- Step 3: reveal ---------- */

  function revealView() {
    const r = S.review || {};
    const flaws = arr(S.gen.flaws);
    const foundBy = {};
    arr(r.found).forEach(x => { foundBy[x.flaw_id] = x; });
    const nFound = flaws.filter(f => foundBy[f.id]).length;
    const falseAlarms = arr(r.false_alarms);
    const flagNum = id => S.flags.findIndex(f => f.id === id) + 1;

    const marks = flaws.map((f, i) => ({ text: f.quote, cls: foundBy[f.id] ? 'flaw-found' : 'flaw-missed', label: 'F' + (i + 1) }));

    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Your result'),
        el('div', { class: 'score' },
          el('span', { class: 'score-big' }, `${nFound} of ${flaws.length}`), ' flaws found',
          falseAlarms.length ? ` · ${falseAlarms.length} false alarm${falseAlarms.length > 1 ? 's' : ''}` : ''),
        r.overall ? el('p', { class: 'prewrap' }, r.overall) : null),

      el('div', { class: 'review' },
        el('section', { class: 'card sticky' },
          el('h2', {}, 'Where the flaws were'),
          el('p', { class: 'hint' }, el('mark', { class: 'flaw-found' }, 'found'), '  ', el('mark', { class: 'flaw-missed' }, 'missed')),
          solutionBody(S.gen.solution, marks, 'flaw-revealed')),
        el('div', {},
          flaws.map((f, i) => {
            const hit = foundBy[f.id];
            return el('section', { class: 'card point' + (hit ? ' accepted' : ' missed') },
              el('div', { class: 'point-head' },
                el('div', { class: 'point-title' }, `F${i + 1} · `, f.type || 'Flaw'),
                el('span', { class: 'status ' + (hit ? 'accepted' : 'missed') }, hit ? `Found (your flag ${flagNum(hit.flag_id)})` : 'Missed')),
              el('p', { class: 'issue' }, el('strong', {}, 'What was wrong: '), f.explanation),
              f.correction ? el('div', { class: 'suggestion' }, el('strong', {}, 'Correction: '), f.correction) : null,
              hit && hit.comment ? el('div', { class: 'hint judged ' + (hit.reasoning_ok ? 'ok' : 'part') },
                hit.reasoning_ok ? 'Your reasoning: right. ' : 'Your reasoning: not quite. ', hit.comment) : null);
          }),
          falseAlarms.length ? el('section', { class: 'card' },
            el('h2', {}, 'False alarms'),
            el('p', { class: 'hint' }, 'Passages you flagged that weren’t planted flaws.'),
            falseAlarms.map(fa => {
              const flag = S.flags.find(f => f.id === fa.flag_id) || {};
              return el('div', { class: 'check-item' },
                el('div', { class: 'q-text' }, `Your flag ${flagNum(fa.flag_id)}: “${flag.text || ''}”`),
                el('div', {}, fa.comment));
            })) : null)),

      el('section', { class: 'card accent' },
        el('h2', {}, 'Corrected solution'),
        solutionBody(S.gen.corrected_solution || S.gen.solution, [], 'flaw-corrected')),

      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: tryAnother }, 'Try another solution'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })));
  }

  function tryAnother() { generate(); }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const c = sol(S.gen.corrected_solution || S.gen.solution);
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Corrected solution · Spot the Flaw · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Solution', blocks: [{ type: 'text', text: c.summary }, { type: 'numbers', items: c.steps }] },
          { heading: 'Mistakes to avoid', blocks: [{ type: 'bullets', items: arr(S.gen.flaws).map(f => ({
            text: f.explanation, note: f.correction ? 'Correction: ' + f.correction : '' })) }] },
          { heading: 'Sources', blocks: [{ type: 'numbers', items: S.docs.map(d => d.name) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', docs: [], uploadErrors: [], gen: null, flags: [], review: null, selectionNote: '', retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
