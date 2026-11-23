# Think-First Workbench

A web app of structured "interventions" that make a consultant think about a problem before, or alongside, an AI proposing a solution. Built for technology and business consultants working on client problems.

The current version is a single-user prototype that runs locally. It is designed to move to a shared, multi-user server.

## The interventions

| Intervention | What the user has to do |
|---|---|
| What's your Problem | Answer clarifying questions before getting a restated problem and solution |
| First Draft | Write their own solution, compare it with an independent AI solution, combine the two |
| Critique | Get a point-by-point critique of their solution and accept or dismiss each change |
| Dimensions | Choose which of the five most relevant dimensions should shape the solution |
| Know your Materials | Upload client documents and answer questions on them correctly before a solution is written |
| Explain the Answer | Explain why the AI's solution works before it can be copied or downloaded |
| Spot the Flaw | Find the mistakes planted in a plausible-sounding solution |
| Pre-mortem | Imagine the project failed, list the causes, and mitigate the most serious risks |
| Devil's Advocate | Respond to objections from stakeholders chosen by the AI; responses are built into the solution |
| Assumptions Audit | List assumptions; the AI adds hidden ones, rates them all, and requires a check plan for the risky ones |
| Options First | Write three options from different sources, score them on AI-set criteria, justify a choice |
| Predict and Compare | Estimate the numbers that matter, with ranges, before seeing the AI's estimates |
| Client Rehearsal | Present to the stakeholder who matters most (chosen by the AI) in a live role-play, then debrief |
| Say it Simply | Write a 150-word executive summary for the reader the AI chooses, revising until it passes every check |

Every intervention ends with an "Accept and download (Word)" button, and every problem or solution box can be filled from a Word file.

## Run it

Needs Python 3.8 or newer. There is nothing else to install.

```
python3 server.py          # Windows: python server.py
```

Then open http://localhost:8000.

With no API key it runs in **sample mode** with canned responses, so you can try the flows for free.

## Use your OpenAI key

1. Copy `.env.example` to `.env`.
2. Put your key on the `OPENAI_API_KEY=` line. Optionally set `OPENAI_MODEL`.
3. Restart the server. The badge in the bottom-left corner should say **Live**.

The key stays in the local server and is never sent to the browser. `.env` is ignored by git, so it won't be committed. The server only listens on your own machine (127.0.0.1).

Reading PDFs locally is optional: `pip3 install pypdf`. Without it, PDFs are read through OpenAI in live mode.

## Project layout

```
server.py                          local server: pages, OpenAI calls, document reading, Word export
docx_writer.py                     builds Word documents (standard library only)
extract.py                         pulls text from uploaded PDF, Word, PowerPoint, Excel and text files
prompts/<intervention>/<step>.txt  instructions sent to the model (edit freely)
prompts/common/title.txt           writes the title used to name downloaded documents
mocks/<intervention>/<step>.json   sample responses for sample mode
static/index.html                  page shell
static/app.css                     shared styling
static/app.js                      framework: navigation, layout helpers, API calls, uploads, Word download
static/interactions/*.js           one file per intervention
```

## Tune the AI

Edit the text files in `prompts/`. Changes take effect on the next request; no restart is needed.

## Add an intervention

1. Add an entry to the `INTERACTIONS` list in `static/app.js`.
2. Create `static/interactions/<id>.js` (copy an existing one) and call `App.register('<id>', { mount })`.
3. Add a `<script>` line for it in `static/index.html`.
4. Add a prompt file per step in `prompts/<id>/` and a sample response in `mocks/<id>/`.
