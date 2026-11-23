/*
 * Interaction: Assumptions Audit
 *
 * 1. Problem & solution - user describes the problem and their solution (typed or from Word)
 * 2. Your assumptions   - user lists what must be true for the solution to work
 * 3. The audit          - AI adds hidden assumptions (with where they show up in the solution) and rates
 *                         EVERY assumption for confidence and importance. The user doesn't rate or choose:
 *                         the system decides which must be checked.
 * 4. Plan the checks    - user writes a check plan for each must-check assumption; AI reviews each plan
 *                         and suggests evidence to look for. Download = what to check before the client meeting.
 *
 * Must check = importance High with confidence Medium or Low, or importance Medium with confidence Low.
 *
 * Server steps used (see prompts/assumptions-audit/):
 *   audit   payload: { problem, solution, assumptions: [text] }
 *           returns { rated: [{ index, confidence, importance, reason }], hidden: [{ text, where, confidence, importance, reason }], note }
 *   review  payload: { problem, solution, checks: [{ id, assumption, confidence, importance, plan }] }
 *           returns { reviews: [{ id, verdict, comment, evidence: [] }], overall }
 */
(() => {
  const ID = 'assumptions-audit';
  const { el } = App;
  const STEPS = ['Problem & solution', 'Your assumptions', 'The audit', 'Plan the checks'];
  const STAGE_INDEX = { problem: 0, list: 1, audit: 2, checks: 3 };
  const LEVELS = ['High', 'Medium', 'Low'];

  const S = {
    stage: 'problem',
    problem: '',
    solution: '',
    mine: ['', '', ''],
    items: [],      // [{ id, n, text, source, where, confidence, importance, reason, plan }]
    note: '',
    review: null,
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
      App.pageHeader('Assumptions Audit',
        'Every solution rests on assumptions. Find the ones that could sink it – and check them first.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'list' ? listView() : null,
      S.stage === 'audit' ? auditView() : null,
      S.stage === 'checks' ? checksView() : null,
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
  const level = v => (LEVELS.find(l => l.toLowerCase() === String(v || '').toLowerCase()) || 'Medium');
  const mustCheck = a => (a.importance === 'High' && a.confidence !== 'High') || (a.importance === 'Medium' && a.confidence === 'Low');
  const risky = () => S.items.filter(mustCheck);
  const rank = a => LEVELS.indexOf(a.importance) * 3 - LEVELS.indexOf(a.confidence); // most important, least sure first

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function recap() {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'), el('p', { class: 'prewrap' }, S.problem),
      el('div', { class: 'label' }, 'Your solution'), el('p', { class: 'prewrap' }, S.solution));
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
          goTo('list');
        } }, 'Next: list your assumptions')));
  }

  /* ---------- Step 2: user's assumptions ---------- */

  function listView() {
    return el('div', {},
      recap(),
      el('section', { class: 'card accent' },
        el('h2', {}, 'What has to be true for this solution to work?'),
        el('p', { class: 'intro' },
          'List the assumptions your solution depends on, one per box – about the client, its people, budget, timing, technology, data and the market.'),
        S.mine.map((c, i) => el('div', { class: 'cause-row' },
          el('span', { class: 'q-num' }, `${i + 1}.`),
          textArea(c, 2, 'We are assuming that…', v => { S.mine[i] = v; }),
          S.mine.length > 1 ? el('button', { class: 'btn link danger', disabled: S.busy,
            onclick: () => { S.mine.splice(i, 1); render(); } }, 'Remove') : null)),
        el('div', { class: 'panel-actions' },
          el('button', { class: 'btn small', disabled: S.busy, onclick: () => { S.mine.push(''); render();
            const boxes = root.querySelectorAll('.cause-row textarea'); boxes[boxes.length - 1].focus(); } }, '+ Add another assumption'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Back'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: audit }, 'Audit my assumptions')));
  }

  function audit() {
    const mine = S.mine.map(c => c.trim()).filter(Boolean);
    if (mine.length < 2) return fail('List at least two assumptions before the audit.');
    run('Auditing your assumptions and looking for hidden ones…', async () => {
      const res = await App.callLLM(ID, 'audit', { problem: S.problem.trim(), solution: S.solution.trim(), assumptions: mine });
      if (!res || !arr(res.rated).length) throw new Error('The audit came back incomplete. Try again.');
      const rated = {};
      arr(res.rated).forEach(r => { rated[r.index] = r; });
      const items = [
        ...mine.map((t, i) => ({ id: 'u' + (i + 1), text: t, source: 'you', where: '',
          confidence: level((rated[i] || {}).confidence), importance: level((rated[i] || {}).importance), reason: (rated[i] || {}).reason || '', plan: '' })),
        ...arr(res.hidden).map((h, i) => ({ id: 'h' + (i + 1), text: h.text, source: 'ai', where: h.where || '',
          confidence: level(h.confidence), importance: level(h.importance), reason: h.reason || '', plan: '' })),
      ];
      items.forEach((a, i) => { a.n = i + 1; });
      S.items = items;
      S.note = res.note || '';
      S.review = null;
      S.stage = 'audit';
    });
  }

  /* ---------- Step 3: the audit ---------- */

  function matrix() {
    const cols = ['Low', 'Medium', 'High'];     // confidence, left to right
    const rows = ['High', 'Medium', 'Low'];     // importance, top to bottom
    const cell = (imp, conf) => {
      const here = S.items.filter(a => a.importance === imp && a.confidence === conf);
      const danger = mustCheck({ importance: imp, confidence: conf });
      return el('div', { class: 'mx-cell' + (danger ? ' danger' : '') },
        here.map(a => el('span', { class: 'mx-chip ' + a.source, title: a.text }, String(a.n))));
    };
    return el('div', { class: 'matrix' },
      el('div', { class: 'mx-ylabel' }, 'Importance →'),
      el('div', { class: 'mx-grid' },
        el('div', {}), ...cols.map(c => el('div', { class: 'mx-head' }, c)),
        ...rows.flatMap(r => [el('div', { class: 'mx-rowhead' }, r), ...cols.map(c => cell(r, c))])),
      el('div', { class: 'mx-xlabel' }, 'Confidence that it’s true →'));
  }

  function auditView() {
    const sorted = [...S.items].sort((a, b) => rank(a) - rank(b));
    const n = risky().length;
    return el('div', {},
      recap(),
      el('section', { class: 'card' },
        el('h2', {}, 'The audit'),
        S.note ? el('p', { class: 'prewrap' }, S.note) : null,
        el('div', { class: 'audit-top' },
          matrix(),
          el('div', { class: 'audit-legend' },
            el('p', {}, el('span', { class: 'mx-chip you' }, '1'), ' Your assumption'),
            el('p', {}, el('span', { class: 'mx-chip ai' }, '1'), ' Hidden assumption found by the AI'),
            el('p', {}, el('span', { class: 'legend-danger' }), ' Must be checked before you rely on the solution'),
            el('p', { class: 'score' }, el('span', { class: 'score-big' }, String(n)), n === 1 ? ' assumption must be checked' : ' assumptions must be checked'))),
        el('div', { class: 'risk-list' }, sorted.map(a => el('div', { class: 'risk assumption' + (mustCheck(a) ? ' must' : '') },
          el('span', { class: 'mx-chip ' + a.source }, String(a.n)),
          el('div', { class: 'risk-main' },
            el('div', { class: 'risk-cause' }, el('span', { class: 'src ' + a.source }, a.source === 'you' ? 'Yours' : 'Hidden'), a.text),
            a.where ? el('div', { class: 'hint' }, 'Where it shows up: ' + a.where) : null,
            a.reason ? el('div', { class: 'hint' }, a.reason) : null),
          el('div', { class: 'ratings' },
            el('span', {}, 'Confidence ', el('strong', {}, a.confidence)),
            el('span', {}, 'Importance ', el('strong', {}, a.importance)),
            mustCheck(a) ? el('span', { class: 'status missed' }, 'Must check') : null))))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('list') }, 'Back to my assumptions'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => goTo('checks') },
          n ? 'Next: plan the checks' : 'Next: finish')));
  }

  /* ---------- Step 4: plan the checks ---------- */

  const VERDICT = { strong: ['Strong', 'ok'], partial: ['Partial', 'part'], weak: ['Weak', 'miss'] };

  function checksView() {
    const list = risky().sort((a, b) => rank(a) - rank(b));
    const reviews = {};
    arr(S.review && S.review.reviews).forEach(r => { reviews[r.id] = r; });
    if (!list.length) {
      return el('div', {},
        el('section', { class: 'card' }, el('h2', {}, 'Nothing needs checking'),
          el('p', {}, 'None of the assumptions is both important and uncertain enough to need a check before you rely on the solution.')),
        finishActions(true));
    }
    return el('div', {},
      recap(),
      S.review && S.review.overall ? el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Review of your checks'), el('p', { class: 'prewrap' }, S.review.overall)) : null,
      el('section', { class: 'card' },
        el('h2', {}, 'How will you check each one?'),
        el('p', { class: 'intro' }, 'For each assumption below, say how you’ll find out whether it’s true, with whom, and by when.'),
        list.map(a => {
          const rv = reviews[a.id];
          const [label, cls] = rv ? (VERDICT[String(rv.verdict).toLowerCase()] || VERDICT.partial) : [];
          return el('div', { class: 'question' },
            el('div', { class: 'q-text' }, rv ? el('span', { class: 'assess ' + cls }, label) : null,
              el('span', { class: 'mx-chip ' + a.source }, String(a.n)), ' ', a.text),
            el('div', { class: 'q-why' }, `Confidence ${a.confidence} · Importance ${a.importance} · ${a.source === 'you' ? 'Your assumption' : 'Hidden assumption'}`),
            textArea(a.plan, 3, 'How you’ll check it, with whom, by when…', v => { a.plan = v; }),
            rv ? el('div', { class: 'hint judged ' + (cls === 'ok' ? 'ok' : 'part') }, rv.comment,
              arr(rv.evidence).length ? el('div', {}, el('strong', {}, 'Evidence to look for: '),
                el('ul', { class: 'list tight' }, arr(rv.evidence).map(e => el('li', {}, e)))) : null) : null);
        })),
      finishActions(false));
  }

  function finishActions(noChecks) {
    return el('div', { class: 'actions' },
      el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
      el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('audit') }, 'Back to the audit'),
      noChecks ? null : el('button', { class: S.review ? 'btn' : 'btn primary', disabled: S.busy, onclick: reviewChecks },
        S.review ? 'Check my revised plans' : 'Review my check plans'),
      (noChecks || S.review) ? App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) }) : null);
  }

  function reviewChecks() {
    const list = risky();
    if (list.some(a => !a.plan.trim())) return fail('Write a check plan for every assumption listed.');
    run('Reviewing your check plans…', async () => {
      const res = await App.callLLM(ID, 'review', {
        problem: S.problem.trim(), solution: S.solution.trim(),
        checks: list.map(a => ({ id: a.id, assumption: a.text, confidence: a.confidence, importance: a.importance, plan: a.plan.trim() })),
      });
      if (!res || !arr(res.reviews).length) throw new Error('The review came back empty. Try again.');
      S.review = res;
    });
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const reviews = {};
    arr(S.review && S.review.reviews).forEach(r => { reviews[r.id] = r; });
    const must = risky().sort((a, b) => rank(a) - rank(b));
    const others = S.items.filter(a => !mustCheck(a)).sort((a, b) => rank(a) - rank(b));
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Assumptions to check · Assumptions Audit · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'The solution', blocks: [{ type: 'text', text: S.solution.trim() }] },
          { heading: 'Check before going to the client', blocks: must.length ? [{ type: 'table',
            columns: ['Assumption', 'Confidence', 'Importance', 'How we will check', 'Evidence to look for'],
            widths: [26, 11, 11, 26, 26],
            rows: must.map(a => [a.text, a.confidence, a.importance, a.plan.trim(), arr((reviews[a.id] || {}).evidence).join('; ')]) }]
            : [{ type: 'p', text: 'No assumption is both important and uncertain enough to need checking.' }] },
          { heading: 'Other assumptions', blocks: [{ type: 'bullets', items: others.map(a => ({
            text: a.text, note: `Confidence ${a.confidence} · Importance ${a.importance}${a.source === 'ai' ? ' · hidden assumption' : ''}` })) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', solution: '', mine: ['', '', ''], items: [], note: '', review: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
