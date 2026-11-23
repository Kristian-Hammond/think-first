/*
 * Interaction: Options First
 *
 * 1. Problem    - user describes the problem (typed or from Word)
 * 2. Options    - the AI first prepares a guide for this problem: where options can come from (sources)
 *                 and the points of view to bring to bear. The user must write three approaches, each from a
 *                 DIFFERENT source and tagged with the point of view it best serves. The AI checks they're
 *                 genuinely different; any that are variations of another must be rewritten.
 * 3. Score      - the AI adds a fourth option and SETS the criteria (the user doesn't choose). The user
 *                 scores every option on every criterion (1-5) before seeing the AI's scores.
 * 4. Choose     - user and AI scores side by side with weighted totals; big disagreements explained.
 *                 The user picks an option and justifies it; a weak justification must be revised
 *                 before the options paper can be downloaded.
 *
 * Server steps used (see prompts/options-first/):
 *   lenses   payload: { problem }
 *            returns { sources: [{ name, prompt }], viewpoints: [{ who, cares_about }] }
 *   distinct payload: { problem, options: [text] }
 *            returns { results: [{ index, distinct, overlaps_with, comment }] }
 *   expand   payload: { problem, options: [text] }
 *            returns { titles: [..], added: { title, description, why_different }, criteria: [{ id, name, description, weight }] }
 *   score    payload: { problem, options: [{ id, title, text }], criteria, user_scores }
 *            returns { scores: { optionId: { criterionId: n } }, gaps: [{ option_id, criterion_id, explanation }], note }
 *   choose   payload: { problem, options, criteria, user_scores, ai_scores, choice, justification }
 *            returns { verdict, comment, missing }
 */
(() => {
  const ID = 'options-first';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Your three options', 'Score them', 'Compare and choose'];
  const STAGE_INDEX = { problem: 0, options: 1, score: 2, choose: 3 };
  const WEIGHT = { High: 2, Medium: 1 };

  const S = {
    stage: 'problem',
    problem: '',
    mine: ['', '', ''],
    mineSource: ['', '', ''],
    mineView: ['', '', ''],
    guide: null,           // { sources: [{ name, prompt }], viewpoints: [{ who, cares_about }] }
    distinct: null,        // [{ index, distinct, overlaps_with, comment }]
    options: [],           // [{ id, title, text, source }]
    added: null,
    criteria: [],          // [{ id, name, description, weight }]
    userScores: {},        // optionId -> { criterionId: n }
    ai: null,              // { scores, gaps, note }
    choice: '',
    justification: '',
    verdict: null,         // { verdict, comment, missing }
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
      App.pageHeader('Options First',
        'Don’t settle on the first idea. Generate real alternatives, judge them, then decide.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'options' ? optionsView() : null,
      S.stage === 'score' ? scoreView() : null,
      S.stage === 'choose' ? chooseView() : null,
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

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function problemRecap() {
    return el('section', { class: 'card recap' }, el('div', { class: 'label' }, 'The problem'), el('p', { class: 'prewrap' }, S.problem));
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 8, 'Describe the problem you need to solve.', v => { S.problem = v; }, 'input big'))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          getGuide();
        } }, 'Next: your three options')));
  }

  function getGuide() {
    run('Working out where options could come from and whose views matter…', async () => {
      const res = await App.callLLM(ID, 'lenses', { problem: S.problem.trim() });
      if (!res || !arr(res.sources).length || !arr(res.viewpoints).length) throw new Error('The guide came back incomplete. Try again.');
      S.guide = { sources: arr(res.sources).slice(0, 6), viewpoints: arr(res.viewpoints).slice(0, 5) };
      S.mineSource = ['', '', ''];
      S.mineView = ['', '', ''];
      S.distinct = null;
      S.stage = 'options';
    });
  }

  /* ---------- Step 2: three distinct options ---------- */

  function optionsView() {
    const res = {};
    arr(S.distinct).forEach(r => { res[r.index] = r; });
    const anyFlagged = arr(S.distinct).some(r => !r.distinct);
    const g = S.guide || { sources: [], viewpoints: [] };
    const pick = (list, key, value, onPick, placeholder) => el('select', { class: 'level wide', disabled: S.busy,
      onchange: e => onPick(e.target.value) },
      el('option', { value: '' }, placeholder),
      list.map(x => el('option', { value: x[key], selected: value === x[key] || undefined }, x[key])));
    return el('div', {},
      problemRecap(),
      el('section', { class: 'card look-for' },
        el('h2', {}, 'Where to look for options'),
        el('div', { class: 'guide-cols' },
          el('div', {},
            el('div', { class: 'mini-label' }, 'Where options can come from'),
            el('ul', { class: 'list' }, g.sources.map(x => el('li', {}, el('strong', {}, x.name), ' – ', x.prompt)))),
          el('div', {},
            el('div', { class: 'mini-label' }, 'Points of view to bring to bear'),
            el('ul', { class: 'list' }, g.viewpoints.map(x => el('li', {}, el('strong', {}, x.who), ' – ', x.cares_about)))))),
      el('section', { class: 'card accent' },
        el('h2', {}, 'Three genuinely different ways to solve it'),
        el('p', { class: 'intro' },
          'Each option must come from a different source above. Describe it in a sentence or two, and say whose point of view it best serves.'),
        anyFlagged ? el('div', { class: 'hint-box' }, el('strong', {}, 'Not different enough. '),
          'Rewrite the flagged option(s) as a genuinely different approach, then check again.') : null,
        S.mine.map((o, i) => {
          const r = res[i];
          return el('div', { class: 'question' + (r && !r.distinct ? ' needs-fix' : '') },
            el('div', { class: 'q-text' },
              r ? el('span', { class: 'assess ' + (r.distinct ? 'ok' : 'miss') }, r.distinct ? 'Distinct' : 'Too similar') : null,
              el('span', { class: 'q-num' }, `Option ${String.fromCharCode(65 + i)}`)),
            el('div', { class: 'opt-tags' },
              el('label', {}, 'Source', pick(g.sources, 'name', S.mineSource[i], v => { S.mineSource[i] = v; }, 'Where does it come from?')),
              el('label', {}, 'Point of view', pick(g.viewpoints, 'who', S.mineView[i], v => { S.mineView[i] = v; }, 'Whose view does it best serve?'))),
            textArea(o, 3, 'Describe the approach…', v => { S.mine[i] = v; }),
            r && r.comment ? el('div', { class: 'hint judged ' + (r.distinct ? 'ok' : 'part') }, r.comment) : null);
        })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Back'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: checkDistinct }, 'Check my options')));
  }

  function checkDistinct() {
    const opts = S.mine.map(o => o.trim());
    if (opts.some(o => !o)) return fail('Write all three options.');
    if (S.mineSource.some(x => !x) || S.mineView.some(x => !x)) return fail('For each option, say where it comes from and whose point of view it serves.');
    if (new Set(S.mineSource).size < 3) return fail('Each option must come from a different source.');
    run('Checking that your options are genuinely different…', async () => {
      const res = await App.callLLM(ID, 'distinct', { problem: S.problem.trim(), options: opts, sources: S.mineSource });
      const results = arr(res && res.results);
      if (results.length < 3) throw new Error('The check came back incomplete. Try again.');
      S.distinct = results;
      if (results.every(r => r.distinct)) await expand(opts);
    });
  }

  async function expand(opts) {
    S.busyMessage = 'Adding an option you didn’t consider and setting the criteria…';
    render();
    const res = await App.callLLM(ID, 'expand', { problem: S.problem.trim(), options: opts,
      used_sources: S.mineSource, sources: S.guide.sources, viewpoints: S.guide.viewpoints });
    if (!res || !res.added || !arr(res.criteria).length) throw new Error('The response came back incomplete. Try again.');
    const titles = arr(res.titles);
    S.options = [
      ...opts.map((t, i) => ({ id: 'o' + (i + 1), title: titles[i] || `Option ${String.fromCharCode(65 + i)}`, text: t, source: 'you',
        from: S.mineSource[i], view: S.mineView[i] })),
      { id: 'o4', title: res.added.title || 'AI option', text: res.added.description || '', why: res.added.why_different || '', source: 'ai',
        from: res.added.source || '', view: res.added.viewpoint || '' },
    ];
    S.criteria = arr(res.criteria).slice(0, 6).map((c, i) => ({ ...c, id: c.id || 'c' + (i + 1),
      weight: String(c.weight).toLowerCase() === 'high' ? 'High' : 'Medium' }));
    S.userScores = {};
    S.options.forEach(o => { S.userScores[o.id] = {}; });
    S.ai = null; S.choice = ''; S.justification = ''; S.verdict = null;
    S.stage = 'score';
  }

  /* ---------- Step 3: user scores ---------- */

  function optionLabel(o, i) { return `${String.fromCharCode(65 + i)}. ${o.title}`; }

  function scoreView() {
    const ai = S.options.find(o => o.source === 'ai');
    return el('div', {},
      problemRecap(),
      el('section', { class: 'card' },
        el('h2', {}, 'The options'),
        el('div', { class: 'opt-list' }, S.options.map((o, i) => el('div', { class: 'opt ' + o.source },
          el('div', { class: 'opt-title' }, el('span', { class: 'src ' + o.source }, o.source === 'you' ? 'Yours' : 'Added by AI'), optionLabel(o, i)),
          el('div', { class: 'prewrap' }, o.text),
          (o.from || o.view) ? el('div', { class: 'hint' }, [o.from ? 'Source: ' + o.from : '', o.view ? 'Serves: ' + o.view : ''].filter(Boolean).join(' · ')) : null,
          o.why ? el('div', { class: 'hint' }, 'Why it’s different: ' + o.why) : null)))),
      el('section', { class: 'card' },
        el('h2', {}, 'The criteria'),
        el('p', { class: 'hint' }, 'Set for this problem. High-weight criteria count double.'),
        el('ul', { class: 'list' }, S.criteria.map(c => el('li', {},
          el('strong', {}, c.name), ` (${c.weight} weight) – `, c.description)))),
      el('section', { class: 'card accent' },
        el('h2', {}, 'Score every option'),
        el('p', { class: 'intro' }, 'Score each option on each criterion from 1 (poor) to 5 (excellent). You’ll see the AI’s scores after.'),
        scoreTable(false)),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: () => { S.distinct = null; goTo('options'); } }, 'Back to my options'),
        el('button', { class: 'btn primary', disabled: S.busy, onclick: submitScores }, 'Compare with the AI’s scores')));
  }

  function total(scores, optionId) {
    return S.criteria.reduce((sum, c) => sum + (Number((scores[optionId] || {})[c.id]) || 0) * WEIGHT[c.weight], 0);
  }

  function scoreTable(compare) {
    const aiS = compare ? (S.ai.scores || {}) : {};
    return el('div', { class: 'table-wrap' }, el('table', { class: 'score-table' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Option'),
        ...S.criteria.map(c => el('th', {}, c.name, el('div', { class: 'w' }, c.weight))),
        compare ? el('th', {}, 'Weighted total', el('div', { class: 'w' }, 'You / AI')) : null)),
      el('tbody', {}, S.options.map((o, i) => el('tr', { class: S.choice === o.id ? 'chosen' : '' },
        el('th', {}, optionLabel(o, i)),
        ...S.criteria.map(c => {
          const mine = (S.userScores[o.id] || {})[c.id];
          if (!compare) {
            return el('td', {}, el('select', { class: 'level', disabled: S.busy,
              onchange: e => { S.userScores[o.id][c.id] = Number(e.target.value) || undefined; } },
              el('option', { value: '' }, '–'),
              [1, 2, 3, 4, 5].map(n => el('option', { value: String(n), selected: mine === n || undefined }, String(n)))));
          }
          const theirs = (aiS[o.id] || {})[c.id];
          const gap = isGap(o.id, c.id);
          return el('td', { class: gap ? 'gap' : '' }, el('span', { class: 'you-score' }, String(mine || '–')),
            ' / ', el('span', { class: 'ai-score' }, String(theirs || '–')));
        }),
        compare ? el('td', { class: 'tot' }, `${total(S.userScores, o.id)} / ${total(aiS, o.id)}`) : null)))));
  }

  // A disagreement = your score and the AI's differ by 2 or more (worked out from the actual scores).
  function isGap(optionId, criterionId) {
    const mine = Number((S.userScores[optionId] || {})[criterionId]);
    const theirs = Number((((S.ai || {}).scores || {})[optionId] || {})[criterionId]);
    return Boolean(mine && theirs && Math.abs(mine - theirs) >= 2);
  }

  function submitScores() {
    const missing = S.options.some(o => S.criteria.some(c => !S.userScores[o.id][c.id]));
    if (missing) return fail('Score every option on every criterion.');
    run('Scoring the options and comparing with yours…', async () => {
      const res = await App.callLLM(ID, 'score', {
        problem: S.problem.trim(),
        options: S.options.map(o => ({ id: o.id, title: o.title, text: o.text })),
        criteria: S.criteria, user_scores: S.userScores,
      });
      if (!res || !res.scores) throw new Error('The scores came back incomplete. Try again.');
      S.ai = res;
      S.verdict = null;
      S.stage = 'choose';
    });
  }

  /* ---------- Step 4: compare and choose ---------- */

  const VERDICT = { strong: ['Holds up', 'ok'], partial: ['Partly holds up', 'part'], weak: ['Doesn’t hold up', 'miss'] };

  function chooseView() {
    const gaps = arr(S.ai.gaps).filter(g => isGap(g.option_id, g.criterion_id));
    const crit = id => (S.criteria.find(c => c.id === id) || {}).name || id;
    const opt = id => { const i = S.options.findIndex(o => o.id === id); return i >= 0 ? optionLabel(S.options[i], i) : id; };
    const v = S.verdict;
    const [vLabel, vCls] = v ? (VERDICT[String(v.verdict).toLowerCase()] || VERDICT.partial) : [];
    return el('div', {},
      problemRecap(),
      el('section', { class: 'card' },
        el('h2', {}, 'Your scores and the AI’s'),
        S.ai.note ? el('p', { class: 'prewrap' }, S.ai.note) : null,
        el('p', { class: 'hint' }, 'Each cell shows ', el('span', { class: 'you-score' }, 'your score'), ' / ', el('span', { class: 'ai-score' }, 'the AI’s'),
          '. Shaded cells differ by two or more.'),
        scoreTable(true)),
      gaps.length ? el('section', { class: 'card' },
        el('h2', {}, 'Where you and the AI disagree'),
        gaps.map(g => el('div', { class: 'check-item' },
          el('div', { class: 'q-text' }, `${opt(g.option_id)} · ${crit(g.criterion_id)}: you ${(S.userScores[g.option_id] || {})[g.criterion_id]}, AI ${((S.ai.scores || {})[g.option_id] || {})[g.criterion_id]}`),
          el('div', {}, g.explanation)))) : null,
      el('section', { class: 'card accent' },
        el('h2', {}, 'Your decision'),
        el('p', { class: 'intro' }, 'Which option do you recommend, and why? Your justification should stand up against the scores above.'),
        el('div', { class: 'chips' }, S.options.map((o, i) => el('button', { type: 'button', class: 'chip' + (S.choice === o.id ? ' on' : ''),
          disabled: S.busy, onclick: () => { S.choice = o.id; S.verdict = null; render(); } }, optionLabel(o, i)))),
        textArea(S.justification, 4, 'I recommend this option because…', val => { S.justification = val; }),
        v ? el('div', { class: 'hint judged ' + (vCls === 'ok' ? 'ok' : 'part') }, el('strong', {}, vLabel + ': '), v.comment,
          v.missing ? el('div', {}, el('strong', {}, 'What’s missing: '), v.missing) : null) : null,
        el('div', { class: 'actions' },
          el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('score') }, 'Re-score'),
          el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
          el('button', { class: v && vCls === 'ok' ? 'btn' : 'btn primary', disabled: S.busy, onclick: submitChoice },
            v ? 'Check my revised justification' : 'Check my decision'),
          v && vCls !== 'miss' ? App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) }) : null)));
  }

  function submitChoice() {
    if (!S.choice) return fail('Pick the option you recommend.');
    if (!S.justification.trim()) return fail('Justify your choice.');
    run('Testing your decision against the scores…', async () => {
      const res = await App.callLLM(ID, 'choose', {
        problem: S.problem.trim(),
        options: S.options.map(o => ({ id: o.id, title: o.title, text: o.text })),
        criteria: S.criteria, user_scores: S.userScores, ai_scores: S.ai.scores,
        choice: S.choice, justification: S.justification.trim(),
      });
      if (!res || !res.verdict) throw new Error('The review came back incomplete. Try again.');
      S.verdict = res;
    });
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const chosen = S.options.find(o => o.id === S.choice) || {};
    const ci = S.options.indexOf(chosen);
    const aiS = S.ai.scores || {};
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Options paper · Options First · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Recommendation', blocks: [
            { type: 'p', text: `Recommended option: ${optionLabel(chosen, ci)}` },
            { type: 'text', text: S.justification.trim() }] },
          { heading: 'Options considered', blocks: [{ type: 'bullets', items: S.options.map((o, i) => ({
            text: `${optionLabel(o, i)}: ${o.text}`,
            note: [o.from ? 'Source: ' + o.from : '', o.view ? 'Serves: ' + o.view : '', o.source === 'ai' ? 'Suggested in review' : ''].filter(Boolean).join(' · ') })) }] },
          { heading: 'Criteria', blocks: [{ type: 'bullets', items: S.criteria.map(c => ({ text: `${c.name} (${c.weight} weight)`, note: c.description })) }] },
          { heading: 'Scores (ours / reviewer’s)', blocks: [{ type: 'table',
            columns: ['Option', ...S.criteria.map(c => c.name), 'Weighted total'],
            rows: S.options.map((o, i) => [optionLabel(o, i),
              ...S.criteria.map(c => `${(S.userScores[o.id] || {})[c.id] || ''} / ${(aiS[o.id] || {})[c.id] || ''}`),
              `${total(S.userScores, o.id)} / ${total(aiS, o.id)}`]) }] },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', mine: ['', '', ''], mineSource: ['', '', ''], mineView: ['', '', ''], guide: null, distinct: null, options: [], added: null, criteria: [],
      userScores: {}, ai: null, choice: '', justification: '', verdict: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
