/*
 * Interaction: Predict and Compare
 *
 * 1. Problem   - user describes the problem (typed or from Word)
 * 2. Estimate  - the AI picks the 3-4 numbers that matter most (the user can't add, drop or change them).
 *                For each, the user gives a best guess, an 80% range and how they got there.
 * 3. Compare   - the AI gives its own estimate, range, reasoning and key drivers; ranges are drawn side by
 *                side, with a comment on the user's reasoning. The user must keep or revise each number,
 *                and say why.
 * 4. Final     - original vs final estimates on record; download.
 *
 * Server steps used (see prompts/predict-and-compare/):
 *   pick     payload: { problem }  returns { estimates: [{ id, name, unit, definition, why }] }
 *   compare  payload: { problem, estimates: [{ id, name, unit, definition, best, low, high, reasoning }] }
 *            returns { results: [{ id, best, low, high, reasoning, drivers: [], on_your_reasoning }], note }
 */
(() => {
  const ID = 'predict-and-compare';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Make your estimates', 'Compare', 'Final estimates'];
  const STAGE_INDEX = { problem: 0, estimate: 1, compare: 2, final: 3 };

  const S = {
    stage: 'problem',
    problem: '',
    est: [],        // [{ id, name, unit, definition, why, best, low, high, reasoning, ai, finalBest, finalLow, finalHigh, change, why2 }]
    note: '',
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
      App.pageHeader('Predict and Compare',
        'Commit to the numbers before you see anyone else’s – then find out how well calibrated you are.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'estimate' ? estimateView() : null,
      S.stage === 'compare' ? compareView() : null,
      S.stage === 'final' ? finalView() : null,
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
  const num = v => (v === '' || v === null || v === undefined || isNaN(Number(v)) ? null : Number(v));
  const fmt = v => (v === null || v === undefined ? '–' : Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function numInput(value, placeholder, onInput) {
    return el('input', { class: 'input num', type: 'number', step: 'any', placeholder, value: value ?? '', disabled: S.busy,
      oninput: e => onInput(e.target.value) });
  }

  function problemRecap() {
    return el('section', { class: 'card recap' }, el('div', { class: 'label' }, 'The problem'), el('p', { class: 'prewrap' }, S.problem));
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 8, 'Describe the problem, with whatever facts you have about the client.', v => { S.problem = v; }, 'input big'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: pick }, 'Next: make your estimates')));
  }

  function pick() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    run('Working out which numbers matter most for this problem…', async () => {
      const res = await App.callLLM(ID, 'pick', { problem: S.problem.trim() });
      const list = arr(res && res.estimates).slice(0, 4);
      if (!list.length) throw new Error('No estimates came back. Try again.');
      S.est = list.map((e, i) => ({ ...e, id: e.id || 'e' + (i + 1), best: '', low: '', high: '', reasoning: '', ai: null,
        finalBest: '', finalLow: '', finalHigh: '', change: '', why2: '' }));
      S.note = '';
      S.stage = 'estimate';
    });
  }

  /* ---------- Step 2: user's estimates ---------- */

  function estimateView() {
    return el('div', {},
      problemRecap(),
      el('section', { class: 'card accent' },
        el('h2', {}, 'The numbers that matter'),
        el('p', { class: 'intro' },
          'Estimate each one before you see anyone else’s. Give your best guess, a range you’re 80% sure contains the true value – not wider, not narrower – and how you got there.'),
        S.est.map((e, i) => el('div', { class: 'question' },
          el('div', { class: 'q-text' }, el('span', { class: 'q-num' }, `${i + 1}.`), e.name, el('span', { class: 'unit' }, e.unit)),
          el('div', { class: 'q-why' }, e.definition, e.why ? ' · Why it matters: ' + e.why : ''),
          el('div', { class: 'est-row' },
            el('label', {}, 'Low', numInput(e.low, 'Low', v => { e.low = v; })),
            el('label', {}, 'Best guess', numInput(e.best, 'Best guess', v => { e.best = v; })),
            el('label', {}, 'High', numInput(e.high, 'High', v => { e.high = v; }))),
          textArea(e.reasoning, 2, 'How did you get there? Key assumptions and arithmetic…', v => { e.reasoning = v; })))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Back'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: compare }, 'Lock in and compare')));
  }

  function validEstimate(b, l, h) {
    const best = num(b), low = num(l), high = num(h);
    if (best === null || low === null || high === null) return 'Give a low, best guess and high for every estimate.';
    if (!(low <= best && best <= high)) return 'For each estimate, low ≤ best guess ≤ high.';
    return '';
  }

  function compare() {
    for (const e of S.est) {
      const msg = validEstimate(e.best, e.low, e.high);
      if (msg) return fail(msg + ` (Check “${e.name}”.)`);
      if (!e.reasoning.trim()) return fail(`Explain how you got your estimate for “${e.name}”.`);
    }
    run('Making independent estimates and comparing them with yours…', async () => {
      const res = await App.callLLM(ID, 'compare', {
        problem: S.problem.trim(),
        estimates: S.est.map(e => ({ id: e.id, name: e.name, unit: e.unit, definition: e.definition,
          best: num(e.best), low: num(e.low), high: num(e.high), reasoning: e.reasoning.trim() })),
      });
      const results = arr(res && res.results);
      if (!results.length) throw new Error('The comparison came back empty. Try again.');
      S.est.forEach((e, i) => {
        const r = results.find(x => x.id === e.id) || results[i] || {};
        e.ai = { best: num(r.best), low: num(r.low), high: num(r.high), reasoning: r.reasoning || '',
          drivers: arr(r.drivers), on: r.on_your_reasoning || '' };
        e.finalBest = e.best; e.finalLow = e.low; e.finalHigh = e.high; e.change = ''; e.why2 = '';
      });
      S.note = (res && res.note) || '';
      S.stage = 'compare';
    });
  }

  /* ---------- Step 3: compare ---------- */

  // Two ranges drawn on one scale: yours (blue) and the AI's (purple).
  function rangeBars(e, finalToo) {
    const sets = [
      { label: 'You', cls: 'you', lo: num(e.low), best: num(e.best), hi: num(e.high) },
      { label: 'AI', cls: 'ai', lo: e.ai.low, best: e.ai.best, hi: e.ai.high },
    ];
    if (finalToo) sets.push({ label: 'Final', cls: 'final', lo: num(e.finalLow), best: num(e.finalBest), hi: num(e.finalHigh) });
    const vals = sets.flatMap(s => [s.lo, s.best, s.hi]).filter(v => v !== null);
    let min = Math.min(...vals), max = Math.max(...vals);
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.08; min -= pad; max += pad;
    const pos = v => `${((v - min) / (max - min)) * 100}%`;
    return el('div', { class: 'ranges' }, sets.map(s => el('div', { class: 'range-row' },
      el('span', { class: 'range-label ' + s.cls }, s.label),
      el('div', { class: 'range-track' },
        s.lo !== null && s.hi !== null ? el('div', { class: 'range-bar ' + s.cls, style: `left:${pos(s.lo)};width:calc(${pos(s.hi)} - ${pos(s.lo)})` }) : null,
        s.best !== null ? el('div', { class: 'range-dot ' + s.cls, style: `left:${pos(s.best)}`, title: fmt(s.best) }) : null),
      el('span', { class: 'range-vals' }, `${fmt(s.best)}  (${fmt(s.lo)}–${fmt(s.hi)})`))));
  }

  function verdictLine(e) {
    const aiInYours = e.ai.best !== null && e.ai.best >= num(e.low) && e.ai.best <= num(e.high);
    const yoursInAi = e.ai.low !== null && num(e.best) >= e.ai.low && num(e.best) <= e.ai.high;
    if (aiInYours && yoursInAi) return el('span', { class: 'assess ok' }, 'Close');
    if (aiInYours || yoursInAi) return el('span', { class: 'assess part' }, 'Overlapping');
    return el('span', { class: 'assess miss' }, 'Far apart');
  }

  function compareView() {
    return el('div', {},
      problemRecap(),
      S.note ? el('section', { class: 'card recap' }, el('div', { class: 'label' }, 'Overall'), el('p', { class: 'prewrap' }, S.note)) : null,
      S.est.map((e, i) => el('section', { class: 'card' },
        el('div', { class: 'q-text' }, verdictLine(e), el('span', { class: 'q-num' }, `${i + 1}.`), e.name, el('span', { class: 'unit' }, e.unit)),
        rangeBars(e, false),
        el('div', { class: 'cmp-cols' },
          el('div', {}, el('div', { class: 'mini-label' }, 'Your reasoning'), el('p', { class: 'prewrap' }, e.reasoning)),
          el('div', {}, el('div', { class: 'mini-label' }, 'The AI’s reasoning'), el('p', { class: 'prewrap' }, e.ai.reasoning),
            e.ai.drivers.length ? el('div', {}, el('div', { class: 'mini-label' }, 'Key drivers'),
              el('ul', { class: 'list tight' }, e.ai.drivers.map(d => el('li', {}, d)))) : null)),
        e.ai.on ? el('div', { class: 'hint judged part' }, el('strong', {}, 'On your reasoning: '), e.ai.on) : null,
        el('div', { class: 'final-box' },
          el('div', { class: 'mini-label' }, 'Your final estimate'),
          el('div', { class: 'chips' },
            el('button', { type: 'button', class: 'chip' + (e.change === 'keep' ? ' on' : ''), disabled: S.busy,
              onclick: () => { e.change = 'keep'; e.finalBest = e.best; e.finalLow = e.low; e.finalHigh = e.high; render(); } }, 'Keep my estimate'),
            el('button', { type: 'button', class: 'chip' + (e.change === 'revise' ? ' on' : ''), disabled: S.busy,
              onclick: () => { e.change = 'revise'; render(); } }, 'Revise it')),
          e.change === 'revise' ? el('div', { class: 'est-row' },
            el('label', {}, 'Low', numInput(e.finalLow, 'Low', v => { e.finalLow = v; })),
            el('label', {}, 'Best guess', numInput(e.finalBest, 'Best guess', v => { e.finalBest = v; })),
            el('label', {}, 'High', numInput(e.finalHigh, 'High', v => { e.finalHigh = v; }))) : null,
          e.change ? textArea(e.why2, 2, e.change === 'keep' ? 'Why are you sticking with it?' : 'Why are you changing it?', v => { e.why2 = v; }) : null))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: lockFinal }, 'Lock in my final estimates')));
  }

  function lockFinal() {
    for (const e of S.est) {
      if (!e.change) return fail(`Keep or revise your estimate for “${e.name}”.`);
      if (e.change === 'revise') { const msg = validEstimate(e.finalBest, e.finalLow, e.finalHigh); if (msg) return fail(msg + ` (Check “${e.name}”.)`); }
      if (!e.why2.trim()) return fail(`Say why you ${e.change === 'keep' ? 'kept' : 'revised'} your estimate for “${e.name}”.`);
    }
    goTo('final');
  }

  /* ---------- Step 4: final ---------- */

  function finalView() {
    const inRange = S.est.filter(e => e.ai.best !== null && e.ai.best >= num(e.low) && e.ai.best <= num(e.high)).length;
    const revised = S.est.filter(e => e.change === 'revise').length;
    return el('div', {},
      problemRecap(),
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Calibration check'),
        el('div', { class: 'score' }, el('span', { class: 'score-big' }, `${inRange} of ${S.est.length}`),
          ' of the AI’s estimates fell inside your original 80% ranges', revised ? ` · you revised ${revised}` : ''),
        el('p', { class: 'hint' }, 'If your ranges are well calibrated, about 8 in 10 true values will fall inside them. Ranges that rarely contain other informed estimates are usually too narrow.')),
      S.est.map((e, i) => el('section', { class: 'card' },
        el('div', { class: 'q-text' }, el('span', { class: 'q-num' }, `${i + 1}.`), e.name, el('span', { class: 'unit' }, e.unit)),
        rangeBars(e, true),
        el('div', { class: 'hint' }, el('strong', {}, e.change === 'keep' ? 'Kept: ' : 'Revised: '), e.why2))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('compare') }, 'Back'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const triple = (b, l, h) => `${fmt(num(b))} (${fmt(num(l))}–${fmt(num(h))})`;
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Estimates · Predict and Compare · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Estimates', blocks: [
            { type: 'p', text: 'Each estimate is shown as best guess (80% range).' },
            { type: 'table', columns: ['Estimate', 'Unit', 'Our first estimate', 'Reviewer’s estimate', 'Final estimate', 'Why'],
              widths: [20, 10, 16, 16, 16, 22],
              rows: S.est.map(e => [e.name, e.unit || '', triple(e.best, e.low, e.high), triple(e.ai.best, e.ai.low, e.ai.high),
                triple(e.finalBest, e.finalLow, e.finalHigh), `${e.change === 'keep' ? 'Kept' : 'Revised'}: ${e.why2.trim()}`]) }] },
          { heading: 'Reasoning', blocks: S.est.flatMap(e => [
            { type: 'qa', question: e.name, answer: `Our reasoning: ${e.reasoning.trim()}\nReviewer’s reasoning: ${e.ai.reasoning}${e.ai.drivers.length ? '\nKey drivers: ' + e.ai.drivers.join('; ') : ''}` }]) },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', est: [], note: '', retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
