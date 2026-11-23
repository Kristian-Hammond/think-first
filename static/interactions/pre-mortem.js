/*
 * Interaction: Pre-mortem
 *
 * 1. Problem & plan  - user describes the problem and the planned solution (typed or from Word)
 * 2. Failure         - "It's a year from now and this project has failed. Why?" The user lists causes.
 * 3. Prioritize      - AI rates the user's causes and adds ones they missed (likelihood + impact);
 *                      the user can adjust ratings and picks the 3-5 most serious
 * 4. Mitigate        - user writes a mitigation for each; AI judges whether each would really reduce
 *                      the risk. Download = risk register.
 *
 * Server steps used (see prompts/pre-mortem/):
 *   expand  payload: { problem, plan, causes: [text] }
 *           returns { assessed: [{ index, likelihood, impact, comment }], added: [{ cause, likelihood, impact, why }], note }
 *   review  payload: { problem, plan, risks: [{ id, cause, likelihood, impact, mitigation }] }
 *           returns { reviews: [{ id, verdict, comment, suggestion }], overall }
 */
(() => {
  const ID = 'pre-mortem';
  const { el } = App;
  const STEPS = ['Problem & plan', 'Imagine the failure', 'Prioritize', 'Mitigate'];
  const STAGE_INDEX = { problem: 0, causes: 1, prioritize: 2, mitigate: 3 };
  const LEVELS = ['High', 'Medium', 'Low'];
  const MIN_PICK = 3, MAX_PICK = 5;

  const S = {
    stage: 'problem',
    problem: '',
    plan: '',
    causes: ['', '', ''],    // the user's own failure causes
    risks: [],               // [{ id, cause, source: 'you'|'ai', likelihood, impact, comment, picked, mitigation }]
    note: '',
    review: null,            // { reviews: [...], overall }
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
      App.pageHeader('Pre-mortem',
        'Imagine the project has failed, work out why – and fix it before it happens.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'causes' ? causesView() : null,
      S.stage === 'prioritize' ? prioritizeView() : null,
      S.stage === 'mitigate' ? mitigateView() : null,
    ].filter(Boolean));
  }

  async function run(message, work, { scroll = true } = {}) {
    const stageBefore = S.stage;
    S.busy = true; S.busyMessage = message; S.error = null; S.retry = null;
    render();
    if (scroll) App.scrollToTop();
    try {
      await work();
    } catch (e) {
      S.error = e.message;
      S.retry = () => run(message, work, { scroll });
    } finally {
      S.busy = false;
      render();
      if (S.stage !== stageBefore || S.error || scroll) App.scrollToTop();
    }
  }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }
  const arr = x => (Array.isArray(x) ? x : []);
  const level = v => (LEVELS.find(l => l.toLowerCase() === String(v || '').toLowerCase()) || 'Medium');
  const score = r => (3 - LEVELS.indexOf(r.likelihood)) * (3 - LEVELS.indexOf(r.impact)); // 1..9

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function recap() {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'),
      el('p', { class: 'prewrap' }, S.problem),
      el('div', { class: 'label' }, 'The plan'),
      el('p', { class: 'prewrap' }, S.plan),
      el('button', { class: 'btn link', disabled: S.busy, onclick: () => goTo('problem') }, 'Edit problem or plan'));
  }

  /* ---------- Step 1: problem and plan ---------- */

  function problemView() {
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 6, 'Describe the problem the project addresses.', v => { S.problem = v; }, 'input big'))),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The planned solution'),
        App.withFileLoader(textArea(S.plan, 8, 'Describe the plan you intend to carry out.', v => { S.plan = v; }, 'input big'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          if (!S.plan.trim()) return fail('Please describe the planned solution.');
          goTo('causes');
        } }, 'Next: imagine the failure')));
  }

  /* ---------- Step 2: imagine the failure ---------- */

  function causesView() {
    return el('div', {},
      recap(),
      el('section', { class: 'card accent' },
        el('h2', {}, 'It’s a year from now, and this project has failed.'),
        el('p', { class: 'intro' },
          'What went wrong? List the most likely causes, one per box. Think about people, money, time, technology, the client and the market.'),
        S.causes.map((c, i) => el('div', { class: 'cause-row' },
          el('span', { class: 'q-num' }, `${i + 1}.`),
          textArea(c, 2, 'It failed because…', v => { S.causes[i] = v; }),
          S.causes.length > 1 ? el('button', { class: 'btn link danger', disabled: S.busy,
            onclick: () => { S.causes.splice(i, 1); render(); } }, 'Remove') : null)),
        el('div', { class: 'panel-actions' },
          el('button', { class: 'btn small', disabled: S.busy, onclick: () => { S.causes.push(''); render();
            const boxes = root.querySelectorAll('.cause-row textarea'); boxes[boxes.length - 1].focus(); } }, '+ Add another cause'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: submitCauses }, 'Done – see what I missed')));
  }

  function submitCauses() {
    const causes = S.causes.map(c => c.trim()).filter(Boolean);
    if (causes.length < 2) return fail('List at least two causes before seeing the AI’s.');
    run('Rating your causes and looking for ones you missed…', async () => {
      const res = await App.callLLM(ID, 'expand', { problem: S.problem.trim(), plan: S.plan.trim(), causes });
      if (!res || !arr(res.added).length) throw new Error('The response came back incomplete. Try again.');
      const assessed = {};
      arr(res.assessed).forEach(a => { assessed[a.index] = a; });
      S.risks = [
        ...causes.map((c, i) => ({ id: 'u' + (i + 1), cause: c, source: 'you',
          likelihood: level((assessed[i] || {}).likelihood), impact: level((assessed[i] || {}).impact),
          comment: (assessed[i] || {}).comment || '', picked: false, mitigation: '' })),
        ...arr(res.added).map((a, i) => ({ id: 'a' + (i + 1), cause: a.cause, source: 'ai',
          likelihood: level(a.likelihood), impact: level(a.impact), comment: a.why || '', picked: false, mitigation: '' })),
      ];
      S.note = res.note || '';
      S.review = null;
      S.stage = 'prioritize';
    });
  }

  /* ---------- Step 3: prioritize ---------- */

  function picked() { return S.risks.filter(r => r.picked); }

  function prioritizeView() {
    const n = picked().length;
    const sorted = [...S.risks].sort((a, b) => score(b) - score(a));
    return el('div', {},
      recap(),
      el('section', { class: 'card' },
        el('h2', {}, 'All the ways it could fail'),
        S.note ? el('p', { class: 'prewrap' }, S.note) : null,
        el('p', { class: 'intro' },
          `Your causes and the AI’s are listed from most to least serious. Adjust any rating you disagree with, then pick the ${MIN_PICK} to ${MAX_PICK} most serious risks to mitigate.`),
        el('div', { class: 'risk-list' }, sorted.map(riskRow)),
        el('div', { class: 'actions' },
          el('span', { class: 'hint count', id: 'pick-count' }, pickText(n)),
          el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('causes') }, 'Back to my causes'),
          el('button', { class: 'btn primary', disabled: S.busy, onclick: toMitigate }, 'Next: mitigate'))));
  }

  function pickText(n) { return n ? `${n} picked` : `Pick ${MIN_PICK}–${MAX_PICK}`; }

  function sevClass(r) { const s = score(r); return s >= 6 ? 'high' : s >= 3 ? 'med' : 'low'; }

  function riskRow(r) {
    const sel = (field) => el('select', { class: 'level', disabled: S.busy,
      onchange: e => { r[field] = e.target.value; render(); } },
      LEVELS.map(l => el('option', { value: l, selected: r[field] === l || undefined }, l)));
    const row = el('div', { class: 'risk' + (r.picked ? ' on' : '') },
      el('label', { class: 'risk-pick' },
        el('input', { type: 'checkbox', checked: r.picked || undefined, disabled: S.busy,
          onchange: e => {
            if (e.target.checked && picked().length >= MAX_PICK) { e.target.checked = false; return fail(`Pick at most ${MAX_PICK} – focus on the most serious.`); }
            r.picked = e.target.checked;
            row.classList.toggle('on', r.picked);
            const c = root.querySelector('#pick-count'); if (c) c.textContent = pickText(picked().length);
            if (S.error) { S.error = null; const b = root.querySelector('.error'); if (b) b.remove(); }
          } })),
      el('div', { class: 'risk-main' },
        el('div', { class: 'risk-cause' },
          el('span', { class: 'src ' + r.source }, r.source === 'you' ? 'Yours' : 'Added by AI'), r.cause),
        r.comment ? el('div', { class: 'hint' }, r.comment) : null),
      el('div', { class: 'risk-levels' },
        el('span', { class: 'sev ' + sevClass(r) }, ''),
        el('label', {}, 'Likelihood', sel('likelihood')),
        el('label', {}, 'Impact', sel('impact'))));
    return row;
  }

  function toMitigate() {
    const n = picked().length;
    if (n < MIN_PICK) return fail(`Pick at least ${MIN_PICK} risks to mitigate.`);
    goTo('mitigate');
  }

  /* ---------- Step 4: mitigate ---------- */

  const VERDICT = { strong: ['Strong', 'ok'], partial: ['Partial', 'part'], weak: ['Weak', 'miss'] };

  function mitigateView() {
    const reviews = {};
    arr(S.review && S.review.reviews).forEach(x => { reviews[x.id] = x; });
    const risks = picked().sort((a, b) => score(b) - score(a));
    return el('div', {},
      recap(),
      S.review && S.review.overall ? el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Review of your mitigations'),
        el('p', { class: 'prewrap' }, S.review.overall)) : null,
      el('section', { class: 'card' },
        el('h2', {}, 'How will you prevent each failure?'),
        el('p', { class: 'intro' }, 'For each risk, write a specific mitigation: what you’ll do, when, and who will own it.'),
        risks.map((r, i) => {
          const rv = reviews[r.id];
          const [label, cls] = rv ? (VERDICT[String(rv.verdict).toLowerCase()] || VERDICT.partial) : [];
          return el('div', { class: 'question' },
            el('div', { class: 'q-text' },
              rv ? el('span', { class: 'assess ' + cls }, label) : null,
              el('span', { class: 'q-num' }, `${i + 1}.`), r.cause),
            el('div', { class: 'q-why' }, `Likelihood ${r.likelihood} · Impact ${r.impact} · ${r.source === 'you' ? 'Your cause' : 'Added by AI'}`),
            textArea(r.mitigation, 3, 'Mitigation…', v => { r.mitigation = v; }),
            rv ? el('div', { class: 'hint judged ' + (cls === 'ok' ? 'ok' : 'part') }, rv.comment,
              rv.suggestion ? el('div', {}, el('strong', {}, 'Suggestion: '), rv.suggestion) : null) : null);
        }),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
          el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('prioritize') }, 'Change my picks'),
          el('button', { class: S.review ? 'btn' : 'btn primary', disabled: S.busy, onclick: reviewMitigations },
            S.review ? 'Check my revised mitigations' : 'Review my mitigations'),
          S.review ? App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) }) : null)));
  }

  function reviewMitigations() {
    const risks = picked();
    if (risks.some(r => !r.mitigation.trim())) return fail('Write a mitigation for every risk you picked.');
    run('Checking whether your mitigations would really reduce each risk…', async () => {
      const res = await App.callLLM(ID, 'review', {
        problem: S.problem.trim(), plan: S.plan.trim(),
        risks: risks.map(r => ({ id: r.id, cause: r.cause, likelihood: r.likelihood, impact: r.impact, mitigation: r.mitigation.trim() })),
      });
      if (!res || !arr(res.reviews).length) throw new Error('The review came back empty. Try again.');
      S.review = res;
    });
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const reviews = {};
    arr(S.review && S.review.reviews).forEach(x => { reviews[x.id] = x; });
    const risks = picked().sort((a, b) => score(b) - score(a));
    const others = S.risks.filter(r => !r.picked).sort((a, b) => score(b) - score(a));
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Risk register · Pre-mortem · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'The plan', blocks: [{ type: 'text', text: S.plan.trim() }] },
          { heading: 'Risk register', blocks: [{ type: 'table',
            columns: ['#', 'Risk', 'Likelihood', 'Impact', 'Mitigation', 'Review'],
            widths: [5, 25, 11, 11, 28, 20],
            rows: risks.map((r, i) => [String(i + 1), r.cause, r.likelihood, r.impact, r.mitigation.trim(),
              reviews[r.id] ? `${(VERDICT[String(reviews[r.id].verdict).toLowerCase()] || VERDICT.partial)[0]}: ${reviews[r.id].comment}` : '']) }] },
          { heading: 'Other risks considered', blocks: [{ type: 'bullets', items: others.map(r => ({
            text: r.cause, note: `Likelihood ${r.likelihood} · Impact ${r.impact}` })) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', plan: '', causes: ['', '', ''], risks: [], note: '', review: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
