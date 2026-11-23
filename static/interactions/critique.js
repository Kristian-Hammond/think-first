/*
 * Interaction: Critique
 *
 * 1. Problem       - user describes the problem
 * 2. Your solution - user writes their solution
 * 3. Critique      - AI critiques it point by point. For each point the user can
 *                    Accept (the AI revises the solution for that point only) or Dismiss.
 *                    The current solution is shown beside the critique, with the latest
 *                    change highlighted. Undo, manual edits and re-critique are supported.
 *
 * Server steps used (see prompts/critique/):
 *   critique  payload: { problem, solution }
 *   apply     payload: { problem, solution, critique_point: { title, issue, suggestion } }
 */
(() => {
  const ID = 'critique';
  const { el } = App;
  const STEPS = ['Describe the problem', 'Your solution', 'Critique & revise'];
  const STAGE_INDEX = { problem: 0, solution: 1, review: 2 };

  const S = {
    stage: 'problem',      // 'problem' | 'solution' | 'review'
    problem: '',
    draft: '',             // what the user typed in step 2
    current: '',           // the solution as it stands now
    history: [],           // earlier versions: [{ text, note, pointId }] (for undo)
    lastChange: null,      // { before, after, note } for highlighting
    critique: null,        // { overall, strengths[], points[] }
    status: {},            // point id -> 'accepted' | 'dismissed'
    applying: null,        // id of the point being applied
    editing: false,
    editText: '',
    round: 1,              // how many times the solution has been critiqued
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
      App.pageHeader('Critique',
        'Write your solution, get a candid critique, and decide which suggestions to take.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy && !S.applying ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'solution' ? solutionView() : null,
      S.stage === 'review' ? reviewView() : null,
    ].filter(Boolean));
  }

  // Run an LLM call. scroll=false keeps the user's place (used when accepting a point).
  async function run(message, work, { scroll = true } = {}) {
    const stageBefore = S.stage;
    S.busy = true; S.busyMessage = message; S.error = null; S.retry = null;
    const y = mainScroll();
    render();
    if (scroll) App.scrollToTop(); else restoreScroll(y);
    try {
      await work();
    } catch (e) {
      S.error = e.message;
      S.retry = () => run(message, work, { scroll });
    } finally {
      S.busy = false;
      S.applying = null;
      const y2 = mainScroll();
      render();
      if (S.error || (scroll && S.stage !== stageBefore)) App.scrollToTop(); else restoreScroll(y2);
    }
  }

  function mainScroll() { const m = document.getElementById('main'); return m ? m.scrollTop : 0; }
  function restoreScroll(y) { const m = document.getElementById('main'); if (m) m.scrollTop = y; }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }

  /* ---------- helpers ---------- */

  function textArea(value, rows, placeholder, onInput) {
    const t = el('textarea', { class: 'input big', rows, placeholder, disabled: S.busy,
      oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function problemRecap(editable) {
    return el('section', { class: 'card recap' },
      el('div', { class: 'label' }, 'The problem'),
      el('p', { class: 'prewrap' }, S.problem),
      editable ? el('button', { class: 'btn link', onclick: () => goTo('problem'), disabled: S.busy }, 'Edit problem') : null);
  }

  /* Word-level diff so the user can see exactly what an accepted change did. */
  function diffNodes(before, after) {
    const a = before.split(/(\s+)/), b = after.split(/(\s+)/);
    const n = a.length, m = b.length;
    if (n * m > 4000000) return [document.createTextNode(after)]; // too long to diff; show plain
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    const push = (type, text) => {
      const last = out[out.length - 1];
      if (last && last.type === type) last.text += text; else out.push({ type, text });
    };
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { push('same', a[i]); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) { push('del', a[i]); i++; }
      else { push('ins', b[j]); j++; }
    }
    while (i < n) push('del', a[i++]);
    while (j < m) push('ins', b[j++]);
    return out.map(p => p.type === 'same' ? document.createTextNode(p.text)
      : el(p.type === 'ins' ? 'ins' : 'del', {}, p.text));
  }

  /* ---------- Step 1: problem ---------- */

  function problemView() {
    return el('section', { class: 'card' },
      el('label', { class: 'label' }, 'The problem'),
      App.withFileLoader(textArea(S.problem, 8,
        'Describe the problem. Include the context someone would need to judge a solution.',
        v => { S.problem = v; })),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy, onclick: () => {
          if (!S.problem.trim()) return fail('Please describe the problem first.');
          goTo('solution');
        } }, 'Next: your solution')));
  }

  /* ---------- Step 2: user's solution ---------- */

  function solutionView() {
    return el('div', {},
      problemRecap(true),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'Your solution'),
        el('p', { class: 'intro' }, 'How would you solve this? Write it as you would present it.'),
        App.withFileLoader(textArea(S.draft, 12, 'Your solution…', v => { S.draft = v; })),
        el('div', { class: 'actions' },
          el('button', { class: 'btn primary', disabled: S.busy, onclick: submitSolution }, 'Critique my solution'))));
  }

  function submitSolution() {
    if (!S.draft.trim()) return fail('Please write your solution first.');
    S.current = S.draft.trim();
    S.history = [];
    S.lastChange = null;
    S.round = 1;
    getCritique('Reading your solution and preparing a critique…', true);
  }

  function getCritique(message, scroll) {
    run(message, async () => {
      const res = await App.callLLM(ID, 'critique', { problem: S.problem.trim(), solution: S.current });
      if (!res || !Array.isArray(res.points)) throw new Error('The critique came back incomplete. Try again.');
      res.points = res.points.map((p, i) => ({ ...p, id: p.id || 'p' + (i + 1) }));
      S.critique = res;
      S.status = {};
      S.stage = 'review';
    }, { scroll });
  }

  /* ---------- Step 3: critique and revise ---------- */

  function reviewView() {
    return el('div', {},
      problemRecap(false),
      el('div', { class: 'review' },
        solutionPanel(),
        critiquePanel()));
  }

  function solutionPanel() {
    const versions = S.history.length;
    const header = el('div', { class: 'panel-head' },
      el('h2', {}, 'Your solution'),
      el('span', { class: 'version' }, versions ? `Version ${versions + 1}` : 'Original'));

    if (S.editing) {
      return el('section', { class: 'card sticky' }, header,
        textArea(S.editText, 16, '', v => { S.editText = v; }),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', onclick: () => { S.editing = false; render(); } }, 'Cancel'),
          el('button', { class: 'btn primary', onclick: saveEdit }, 'Save changes')));
    }

    const body = el('div', { class: 'prewrap solution-text' },
      ...(S.lastChange ? diffNodes(S.lastChange.before, S.lastChange.after) : [document.createTextNode(S.current)]));

    return el('section', { class: 'card sticky' }, header,
      S.lastChange ? el('div', { class: 'change-note' },
        el('strong', {}, 'Latest change: '), S.lastChange.note || 'Edited',
        el('button', { class: 'btn link', onclick: hideHighlight }, 'Hide highlighting')) : null,
      body,
      el('div', { class: 'panel-actions' },
        el('button', { class: 'btn small', disabled: S.busy || !versions, onclick: undo }, 'Undo last change'),
        el('button', { class: 'btn small', disabled: S.busy, onclick: startEdit }, 'Edit myself'),
        el('button', { class: 'btn small', disabled: S.busy, onclick: copySolution }, 'Copy')));
  }

  function critiquePanel() {
    const c = S.critique || {};
    const points = c.points || [];
    const open = points.filter(p => !S.status[p.id]).length;

    return el('div', {},
      el('section', { class: 'card accent' },
        el('h2', {}, S.round > 1 ? `Critique (round ${S.round})` : 'Critique'),
        el('p', { class: 'prewrap' }, c.overall),
        Array.isArray(c.strengths) && c.strengths.length
          ? el('div', {}, el('div', { class: 'mini-label' }, 'What works'),
              el('ul', { class: 'list' }, c.strengths.map(s => el('li', {}, s))))
          : null),

      el('div', { class: 'points-head' },
        el('h2', {}, 'Suggested changes'),
        el('span', { class: 'hint' }, open ? `${open} still to decide` : 'All decided')),

      ...points.map(pointCard),

      el('section', { class: 'card' },
        el('p', { class: 'intro' },
          S.history.length
            ? 'When you’ve finished, you can get a fresh critique of your revised solution.'
            : 'Accept the suggestions you agree with, then get a fresh critique of the result if you like.'),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
          el('button', { class: 'btn', disabled: S.busy, onclick: recritique }, 'Critique my revised solution'),
          App.downloadButton('Accept and download (Word)', buildDoc,
            { disabled: S.busy || S.editing, onError: m => { S.error = m; S.retry = null; render(); App.scrollToTop(); } }))));
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Final solution · Critique · ${App.today()}`,
        sections: [
          { heading: 'The problem', blocks: [{ type: 'text', text: S.problem.trim() }] },
          { heading: 'Solution', blocks: [{ type: 'text', text: S.current }] },
        ],
      },
    };
  }

  function pointCard(p) {
    const status = S.status[p.id];
    const applying = S.applying === p.id;
    return el('section', { class: 'card point' + (status ? ' ' + status : '') },
      el('div', { class: 'point-head' },
        el('div', { class: 'point-title' },
          p.severity ? el('span', { class: 'sev ' + String(p.severity).toLowerCase() }, p.severity) : null,
          p.title || 'Suggestion'),
        status ? el('span', { class: 'status ' + status }, status === 'accepted' ? 'Applied' : 'Dismissed') : null),
      p.issue ? el('p', { class: 'issue' }, p.issue) : null,
      p.suggestion ? el('div', { class: 'suggestion' }, el('strong', {}, 'Suggested change: '), p.suggestion) : null,
      applying ? App.spinner('Revising your solution for this point…') : null,
      status
        ? (status === 'dismissed'
            ? el('div', { class: 'point-actions' },
                el('button', { class: 'btn link', disabled: S.busy, onclick: () => { delete S.status[p.id]; render(); } }, 'Reconsider'))
            : null)
        : el('div', { class: 'point-actions' },
            el('button', { class: 'btn small', disabled: S.busy, onclick: () => { S.status[p.id] = 'dismissed'; render(); } }, 'Dismiss'),
            el('button', { class: 'btn small primary', disabled: S.busy, onclick: () => accept(p) }, 'Accept')));
  }

  function accept(p) {
    S.applying = p.id;
    run('Revising your solution…', async () => {
      const res = await App.callLLM(ID, 'apply', {
        problem: S.problem.trim(),
        solution: S.current,
        critique_point: { title: p.title, issue: p.issue, suggestion: p.suggestion },
      });
      if (!res || !res.revised_solution) throw new Error('The revision came back empty. Try again.');
      const note = res.change_summary || p.title;
      setSolution(res.revised_solution.trim(), note, p.id);
      S.status[p.id] = 'accepted';
    }, { scroll: false });
  }

  function setSolution(text, note, pointId) {
    S.history.push({ text: S.current, note, pointId });
    S.lastChange = { before: S.current, after: text, note };
    S.current = text;
  }

  function undo() {
    const prev = S.history.pop();
    if (!prev) return;
    S.current = prev.text;
    S.lastChange = null;
    if (prev.pointId) delete S.status[prev.pointId];  // re-open the point that made this change
    render();
  }

  function hideHighlight() { S.lastChange = null; render(); }

  function startEdit() { S.editing = true; S.editText = S.current; render(); }

  function saveEdit() {
    const text = S.editText.trim();
    S.editing = false;
    if (text && text !== S.current) setSolution(text, 'Your own edits');
    render();
  }

  function copySolution(e) {
    const btn = e.target;
    navigator.clipboard.writeText(S.current).then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
    }).catch(() => { btn.textContent = 'Copy failed'; });
  }

  function recritique() {
    S.round += 1;
    S.lastChange = null;
    getCritique('Critiquing your revised solution…', true);
  }

  function startOver() {
    Object.assign(S, { problem: '', draft: '', current: '', history: [], lastChange: null,
      critique: null, status: {}, applying: null, editing: false, editText: '', round: 1, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
