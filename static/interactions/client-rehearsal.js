/*
 * Interaction: Client Rehearsal
 *
 * 1. Problem & recommendation - typed or from Word, plus optional client documents
 * 2. Meet the stakeholder     - the AI chooses who the user faces: the person whose support matters most and
 *                               who will be hardest to convince. Role, concerns and style are shown; what would
 *                               win them over stays hidden until the debrief.
 * 3. The meeting              - the user opens with a pitch, then a live exchange (up to 8 stakeholder turns).
 *                               The stakeholder may end it; the user may end it after 3 exchanges.
 * 4. Debrief                  - outcome, what landed, what fell flat, dodged questions, questions to prepare for
 *                               with suggested answers. Download = meeting-prep brief + transcript.
 *
 * Server steps used (see prompts/client-rehearsal/):
 *   persona  payload: { problem, recommendation, documents }
 *            returns { name, role, cares_about: [], concerns: [], style, win_over }
 *   turn     payload: { problem, recommendation, documents, persona, transcript: [{ speaker, text }], turn, max_turns }
 *            returns { reply, ended }
 *   debrief  payload: { problem, recommendation, persona, transcript }
 *            returns { outcome, outcome_note, overall, landed: [], fell_flat: [], dodged: [{ question, issue }],
 *                      prepare: [{ question, suggested_answer }] }
 */
(() => {
  const ID = 'client-rehearsal';
  const { el } = App;
  const STEPS = ['Problem & recommendation', 'Meet the stakeholder', 'The meeting', 'Debrief'];
  const STAGE_INDEX = { problem: 0, meet: 1, meeting: 2, debrief: 3 };
  const MAX_TURNS = 8;     // stakeholder replies
  const MIN_TO_END = 3;    // user turns before they may end the meeting
  const ACCEPT = '.pdf,.docx,.pptx,.xlsx,.txt,.md,.markdown,.csv,.tsv,.json,.html,.htm';

  const S = {
    stage: 'problem',
    problem: '',
    recommendation: '',
    docs: [],
    uploads: 0,
    uploadErrors: [],
    persona: null,
    transcript: [],    // [{ speaker: 'you'|'them', text }]
    draft: '',
    ended: false,
    debrief: null,
    busy: false,
    busyMessage: '',
    waiting: false,    // stakeholder is "typing"
    error: null,
    retry: null,
  };
  let root = null;

  function mount(container) { root = container; render(); }

  function render() {
    if (!root) return;
    root.replaceChildren(...[
      App.pageHeader('Client Rehearsal',
        'Rehearse the conversation with the person who matters most – before the real meeting.'),
      App.stepper(STEPS, STAGE_INDEX[S.stage]),
      S.error ? App.errorBox(S.error, S.retry) : null,
      S.busy && !S.waiting ? App.spinner(S.busyMessage) : null,
      S.stage === 'problem' ? problemView() : null,
      S.stage === 'meet' ? meetView() : null,
      S.stage === 'meeting' ? meetingView() : null,
      S.stage === 'debrief' ? debriefView() : null,
    ].filter(Boolean));
    if (S.stage === 'meeting') {
      const log = root.querySelector('.chat-log');
      if (log) log.scrollTop = log.scrollHeight;
      const box = root.querySelector('.chat-input textarea');
      if (box && !S.busy) box.focus({ preventScroll: true });
    }
  }

  async function run(message, work, { scroll = true } = {}) {
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
      S.waiting = false;
      render();
      if (scroll || S.error) App.scrollToTop();
    }
  }

  function goTo(stage) { S.stage = stage; S.error = null; render(); App.scrollToTop(); }
  function fail(message) { S.error = message; S.retry = null; render(); App.scrollToTop(); }
  const arr = x => (Array.isArray(x) ? x : []);
  const words = n => Math.max(1, Math.round(n / 6)).toLocaleString();
  const theirTurns = () => S.transcript.filter(t => t.speaker === 'them').length;
  const yourTurns = () => S.transcript.filter(t => t.speaker === 'you').length;
  const docPayload = () => S.docs.map((d, i) => ({ id: 'D' + (i + 1), name: d.name, text: d.text }));

  function textArea(value, rows, placeholder, onInput, cls = 'input') {
    const t = el('textarea', { class: cls, rows, placeholder, disabled: S.busy, oninput: e => onInput(e.target.value) });
    t.value = value;
    return t;
  }

  function initial(name) { return String(name || '?').replace(/^(The|A) /, '').charAt(0).toUpperCase(); }

  /* ---------- Step 1: problem and recommendation ---------- */

  function problemView() {
    const input = el('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'file-input',
      onchange: e => { addFiles(e.target.files); e.target.value = ''; } });
    const drop = el('div', { class: 'dropzone small', onclick: () => input.click(),
      ondragover: e => { e.preventDefault(); drop.classList.add('over'); },
      ondragleave: () => drop.classList.remove('over'),
      ondrop: e => { e.preventDefault(); drop.classList.remove('over'); addFiles(e.dataTransfer.files); } },
      el('div', { class: 'drop-title' }, 'Drop files here, or click to choose'),
      el('div', { class: 'hint' }, 'PDF, Word, PowerPoint, Excel, text or Markdown'),
      input);
    return el('div', {},
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'The problem'),
        App.withFileLoader(textArea(S.problem, 6, 'Describe the client problem.', v => { S.problem = v; }, 'input big'))),
      el('section', { class: 'card' },
        el('label', { class: 'label' }, 'Your recommendation'),
        App.withFileLoader(textArea(S.recommendation, 10, 'The recommendation you’ll be presenting.', v => { S.recommendation = v; }, 'input big'))),
      el('section', { class: 'card' },
        el('h2', {}, 'Client documents (optional)'),
        el('p', { class: 'hint' }, 'Org charts, strategy papers or past correspondence help the stakeholder behave like the real person would.'),
        drop,
        S.uploads ? App.spinner(`Reading ${S.uploads} file${S.uploads > 1 ? 's' : ''}…`) : null,
        S.uploadErrors.length ? el('div', { class: 'note' }, S.uploadErrors.map(u => el('div', {}, el('strong', {}, u.name + ': '), u.error))) : null,
        S.docs.length ? el('div', { class: 'doc-list' }, S.docs.map(d => el('div', { class: 'doc' },
          el('div', { class: 'doc-main' }, el('div', { class: 'doc-name' }, d.name), el('div', { class: 'hint' }, `About ${words(d.chars)} words`)),
          el('div', { class: 'doc-actions' }, el('button', { class: 'btn link danger', disabled: S.busy,
            onclick: () => { S.docs = S.docs.filter(x => x !== d); render(); } }, 'Remove'))))) : null),
      el('div', { class: 'actions' },
        el('button', { class: 'btn primary', disabled: S.busy || S.uploads > 0, onclick: choosePersona }, 'Who will I be facing?')));
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    S.uploadErrors = [];
    S.uploads += files.length;
    render();
    await Promise.all(files.map(async file => {
      try {
        const out = await App.extractFile(file);
        S.docs.push({ name: file.name, text: out.text, chars: out.chars });
      } catch (e) {
        S.uploadErrors.push({ name: file.name, error: e.message });
      } finally {
        S.uploads -= 1;
        render();
      }
    }));
  }

  function choosePersona() {
    if (!S.problem.trim()) return fail('Please describe the problem first.');
    if (!S.recommendation.trim()) return fail('Please write your recommendation.');
    run('Working out who matters most for this recommendation…', async () => {
      const res = await App.callLLM(ID, 'persona', { problem: S.problem.trim(), recommendation: S.recommendation.trim(), documents: docPayload() });
      if (!res || !res.role) throw new Error('The stakeholder came back incomplete. Try again.');
      S.persona = res;
      S.transcript = []; S.draft = ''; S.ended = false; S.debrief = null;
      S.stage = 'meet';
    });
  }

  /* ---------- Step 2: meet the stakeholder ---------- */

  function personaCard(compact) {
    const p = S.persona || {};
    return el('section', { class: 'card persona' },
      el('div', { class: 'persona-head' }, el('span', { class: 'avatar big' }, initial(p.name || p.role)),
        el('div', {}, el('div', { class: 'persona-name' }, p.name ? `${p.name}, ${p.role}` : p.role),
          p.style ? el('div', { class: 'hint' }, p.style) : null)),
      compact ? null : el('div', { class: 'cmp-cols' },
        el('div', {}, el('div', { class: 'mini-label' }, 'What they care about'), el('ul', { class: 'list tight' }, arr(p.cares_about).map(x => el('li', {}, x)))),
        el('div', {}, el('div', { class: 'mini-label' }, 'What worries them'), el('ul', { class: 'list tight' }, arr(p.concerns).map(x => el('li', {}, x))))));
  }

  function meetView() {
    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, 'Who you’ll be facing'),
        el('p', {}, 'Chosen because their support matters most for this recommendation – and they’ll be the hardest to win over.')),
      personaCard(false),
      el('section', { class: 'card accent' },
        el('h2', {}, 'Open the meeting'),
        el('p', { class: 'intro' }, `You have their attention for a few minutes. How do you open? Write it as you’d say it.`),
        textArea(S.draft, 6, 'Your opening…', v => { S.draft = v; }, 'input big'),
        el('div', { class: 'actions' },
          el('button', { class: 'btn', disabled: S.busy, onclick: () => goTo('problem') }, 'Back'),
          el('button', { class: 'btn primary', disabled: S.busy, onclick: startMeeting }, 'Start the meeting'))));
  }

  function startMeeting() {
    if (!S.draft.trim()) return fail('Write your opening first.');
    S.stage = 'meeting';
    send();
  }

  /* ---------- Step 3: the meeting ---------- */

  function meetingView() {
    const p = S.persona || {};
    const canEnd = yourTurns() >= MIN_TO_END && !S.ended;
    return el('div', {},
      personaCard(true),
      el('section', { class: 'card chat' },
        el('div', { class: 'panel-head' },
          el('h2', {}, 'The meeting'),
          el('span', { class: 'version' }, S.ended ? 'Meeting over' : `Exchange ${Math.min(theirTurns() + (S.waiting ? 1 : 0), MAX_TURNS)} of up to ${MAX_TURNS}`)),
        el('div', { class: 'chat-log' },
          S.transcript.map(t => el('div', { class: 'msg ' + t.speaker },
            t.speaker === 'them' ? el('span', { class: 'avatar' }, initial(p.name || p.role)) : null,
            el('div', { class: 'bubble' }, t.text))),
          S.waiting ? el('div', { class: 'msg them' }, el('span', { class: 'avatar' }, initial(p.name || p.role)),
            el('div', { class: 'bubble typing' }, el('span', {}), el('span', {}), el('span', {}))) : null),
        S.ended
          ? el('div', { class: 'chat-ended' }, 'The meeting is over.',
              el('button', { class: 'btn primary', disabled: S.busy, onclick: getDebrief }, 'Go to the debrief'))
          : el('div', { class: 'chat-input' },
              textArea(S.draft, 3, 'Your reply…', v => { S.draft = v; }),
              el('div', { class: 'point-actions' },
                el('span', { class: 'tries' }, canEnd ? '' : `You can end the meeting after ${MIN_TO_END} replies.`),
                canEnd ? el('button', { class: 'btn small', disabled: S.busy, onclick: endMeeting }, 'End the meeting') : null,
                el('button', { class: 'btn small primary', disabled: S.busy, onclick: send }, 'Send')))));
  }

  function send() {
    const text = S.draft.trim();
    if (!text) return fail('Write your reply first.');
    S.transcript.push({ speaker: 'you', text });
    S.draft = '';
    S.waiting = true;
    run('', async () => {
      const turn = theirTurns() + 1;
      const res = await App.callLLM(ID, 'turn', {
        problem: S.problem.trim(), recommendation: S.recommendation.trim(), documents: docPayload(),
        persona: S.persona, transcript: S.transcript, turn, max_turns: MAX_TURNS,
      });
      if (!res || !res.reply) throw new Error('No reply came back. Try sending again.');
      S.transcript.push({ speaker: 'them', text: res.reply });
      if (res.ended || turn >= MAX_TURNS) S.ended = true;
    }, { scroll: false }).then(() => {
      if (S.error) {  // put the unsent message back so nothing is lost
        const last = S.transcript[S.transcript.length - 1];
        if (last && last.speaker === 'you') { S.transcript.pop(); S.draft = last.text; render(); }
      }
    });
  }

  function endMeeting() { S.ended = true; getDebrief(); }

  /* ---------- Step 4: debrief ---------- */

  function getDebrief() {
    run('Stepping out of the room to debrief…', async () => {
      const res = await App.callLLM(ID, 'debrief', { problem: S.problem.trim(), recommendation: S.recommendation.trim(),
        persona: S.persona, transcript: S.transcript });
      if (!res || !res.overall) throw new Error('The debrief came back incomplete. Try again.');
      S.debrief = res;
      S.stage = 'debrief';
    });
  }

  const OUTCOME = { approve: ['Would approve', 'ok'], conditional: ['Would approve with conditions', 'part'], reject: ['Would not approve', 'miss'] };

  function debriefView() {
    const d = S.debrief || {};
    const p = S.persona || {};
    const [oLabel, oCls] = OUTCOME[String(d.outcome).toLowerCase()] || OUTCOME.conditional;
    const list = (title, items) => arr(items).length ? el('section', { class: 'card' }, el('h2', {}, title),
      el('ul', { class: 'list' }, arr(items).map(x => el('li', {}, x)))) : null;
    return el('div', {},
      el('section', { class: 'card recap' },
        el('div', { class: 'label' }, `Outcome with ${p.name ? p.name + ', ' : ''}${p.role}`),
        el('div', { class: 'score' }, el('span', { class: 'assess ' + oCls }, oLabel), ' ', d.outcome_note || ''),
        el('p', { class: 'prewrap' }, d.overall)),
      p.win_over ? el('section', { class: 'card look-for' }, el('h2', {}, 'What would have won them over'), el('p', { class: 'prewrap' }, p.win_over)) : null,
      list('What landed', d.landed),
      list('What fell flat', d.fell_flat),
      arr(d.dodged).length ? el('section', { class: 'card' }, el('h2', {}, 'Questions you dodged or answered weakly'),
        arr(d.dodged).map(x => el('div', { class: 'check-item' }, el('div', { class: 'speech' }, x.question), el('div', {}, x.issue)))) : null,
      arr(d.prepare).length ? el('section', { class: 'card accent' }, el('h2', {}, 'Prepare for these before the real meeting'),
        arr(d.prepare).map(x => el('div', { class: 'check-item' }, el('div', { class: 'q-text' }, x.question),
          el('div', { class: 'hint' }, el('strong', {}, 'A strong answer: '), x.suggested_answer)))) : null,
      el('section', { class: 'card' },
        el('h2', {}, 'Transcript'),
        el('div', { class: 'chat-log static' }, S.transcript.map(t => el('div', { class: 'msg ' + t.speaker },
          t.speaker === 'them' ? el('span', { class: 'avatar' }, initial(p.name || p.role)) : null,
          el('div', { class: 'bubble' }, t.text))))),
      el('div', { class: 'actions' },
        el('button', { class: 'btn', disabled: S.busy, onclick: rehearseAgain }, 'Rehearse again with the same person'),
        el('button', { class: 'btn', disabled: S.busy, onclick: startOver }, 'Start a new problem'),
        App.downloadButton('Accept and download (Word)', buildDoc, { disabled: S.busy, onError: m => fail(m) })));
  }

  function rehearseAgain() {
    S.transcript = []; S.draft = ''; S.ended = false; S.debrief = null;
    goTo('meet');
  }

  async function buildDoc() {
    const name = await App.problemTitle(S.problem);
    const d = S.debrief || {};
    const p = S.persona || {};
    const [oLabel] = OUTCOME[String(d.outcome).toLowerCase()] || OUTCOME.conditional;
    const who = p.name ? `${p.name}, ${p.role}` : p.role;
    return {
      fileName: App.docFileName(name),
      doc: {
        title: name,
        subtitle: `Meeting-prep brief · Client Rehearsal · ${App.today()}`,
        sections: [
          { heading: 'The recommendation', blocks: [{ type: 'text', text: S.recommendation.trim() }] },
          { heading: `The stakeholder: ${who}`, blocks: [
            { type: 'p', text: p.style || '' },
            { type: 'bullets', items: [...arr(p.cares_about).map(x => 'Cares about: ' + x), ...arr(p.concerns).map(x => 'Worried about: ' + x)] },
            p.win_over ? { type: 'p', text: 'What would win them over: ' + p.win_over } : { type: 'p', text: '' }] },
          { heading: 'Rehearsal outcome', blocks: [{ type: 'p', text: `${oLabel}. ${d.outcome_note || ''}` }, { type: 'text', text: d.overall }] },
          { heading: 'Likely questions and strong answers', blocks: [{ type: 'table', columns: ['Question', 'A strong answer'], widths: [40, 60],
            rows: arr(d.prepare).map(x => [x.question, x.suggested_answer]) }] },
          { heading: 'Points to strengthen', blocks: [{ type: 'bullets', items: [...arr(d.fell_flat), ...arr(d.dodged).map(x => `${x.question} – ${x.issue}`)] }] },
          { heading: 'What landed', blocks: [{ type: 'bullets', items: arr(d.landed) }] },
          { heading: 'Transcript', blocks: S.transcript.map(t => ({ type: 'qa', question: t.speaker === 'you' ? 'You' : who, answer: t.text })) },
        ],
      },
    };
  }

  function startOver() {
    Object.assign(S, { problem: '', recommendation: '', docs: [], uploadErrors: [], persona: null, transcript: [], draft: '',
      ended: false, debrief: null, retry: null });
    goTo('problem');
  }

  App.register(ID, { mount });
})();
