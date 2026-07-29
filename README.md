# Murder Board

A panel that grills your Google Doc before the real audience does. Configure 1–8
agent personas. Run Review → all agents review the doc **in parallel**
→ each agent's matched passages get highlighted in its own color → feedback shows in
the sidebar. No Drive API, no comment anchoring bug.

## What it does

Click **Run Review** → every configured agent critiques the doc at once. Quoted
passages are highlighted inline, color-coded per agent; the sidebar lists each
comment with a matching color dot. One agent's API failure doesn't kill the rest —
failures are listed separately.

Each agent rates its own findings high / medium / low. Those ratings rank
reliably *within* one lens and badly across lenses, since a CFO's "high" and an
editor's "high" are not the same currency.

So a **chair** runs afterwards: one more agent, on no panel and with no stake in
the document, reads every finding at once and ranks the whole set against itself.
It marks a finding `echoed` when several reviewers independently raised the same
point, which is the strongest signal a run produces. It's also told to discount
findings that attack a borrowed example rather than the author's own reasoning.

The sidebar then lists comments in that order, numbered. If the chair call fails
the sidebar says so and falls back to worst-first by each agent's own rating —
a silent fallback would read as a considered ranking when it isn't.

Cost: one extra Gemini call per review, sequential after the parallel batch.

## Setup — manual (fastest)

1. Open any Google Doc → **Extensions → Apps Script**.
2. Create files matching these names and paste contents:
   - `Code.gs`
   - `Sidebar.html` (File → New → HTML, name it `Sidebar`)
   - Project Settings → check "Show appsscript.json" → paste `appsscript.json`.
3. **Save**. Reload the Google Doc.
4. **Murder Board** menu → **Open Murder Board**.
5. Open **⚙ Settings**:
   - Paste your Gemini API key → **Save** (stored in user properties, not in code).
   - The agent config box is pre-filled with 2 example agents. Edit the JSON
     (1–8 objects, each `{ "name", "persona" }`), **Validate**, then **Save**.
     A ready-made 5-agent pack for argumentative essays is in
     `examples/personas-argument-essay.json`. Paste from an editor, not from a
     terminal: wrapped lines inject newlines that break the JSON parse.
6. **Run Review**.

### Agent config format

```json
[
  { "name": "Skeptic", "persona": "You are a relentless skeptic. Challenge assumptions…" },
  { "name": "CFO — Risk Averse", "persona": "You are a conservative CFO. Demand clear ROI…" }
]
```

Colors are assigned by order: yellow, green, blue, red, purple, orange, teal,
grey. That palette is what caps the panel at 8. Past it the pastels stop being
distinguishable behind black text, so the sidebar dot no longer tells you which
agent flagged a passage.

A single agent is allowed. Useful when tuning one persona's prompt, since you
aren't paying for the rest of the panel on every iteration.

## Setup — clasp (if you want it version-controlled)

```bash
npm i -g @google/clasp
clasp login
cd ~/Documents/murder-board
clasp create --type docs --title "Murder Board"   # or: clasp clone <scriptId>
clasp push
```

## Get a Gemini API key

Google AI Studio → aistudio.google.com → Get API key. Free tier is enough for testing.

## Reliability

- **Rate-limit retry** — 429/503 responses retry up to 3× with exponential backoff
  + jitter (`fetchAllWithRetry_` / `fetchWithRetry_`). Only the failed requests
  retry; the rest aren't re-sent.
- **Error surfacing** — `modelText_` distinguishes non-200, prompt blocks
  (`blockReason`), empty candidates, and non-STOP finishReasons (SAFETY / MAX_TOKENS),
  so failures read as a specific cause, not "unexpected shape".
- **No-key guard** — Run Review with no saved key opens Settings instead of erroring.
- **Empty vs errored** — the sidebar distinguishes "agents found nothing" from
  "all agents errored".

## Known limits (next phases fix these)

- **Model name** `gemini-3.6-flash` (current GA as of 2026-07-23). If it 404s,
  grab the current name from Google AI Studio and swap the `GEMINI_MODEL` constant.
- **Comment density** — 8 agents × 3–7 comments = up to 56 highlights on one doc.
  No merge/dedupe pass yet; expect noise on a dense draft. Adjacent personas
  converge on the same weak passages, so overlap reads as duplication rather
  than as agreement. Start at 3–5 distinct lenses before reaching for 8.
- **Passage matching** is hardened: normalizes quote/dash/ellipsis/nbsp variants,
  treats whitespace as `\s+`, and runs a fallback ladder (whole → stripped →
  longest chunk on mid-quote `...` → first 8 words). Remaining miss cases:
  - phrase that **spans a paragraph break** (findText can't cross elements)
  - genuine **paraphrase** where no verbatim substring exists
  Both are flagged "not found" in the sidebar, never silently dropped.
- Re-runs **clear prior highlights** first (`clearHighlights_`), so no stacking.

## Dialogue

Each review comment is a **sidebar thread** (Path B has no native Docs comment
threads to attach to). Per thread:
- **Explain** — agent clarifies the feedback in simpler terms
- **Why?** — agent elaborates its reasoning
- **Continue** — type a reply, agent responds to it in character

Threads persist **per-document** in document properties, so they survive closing
and reopening the sidebar. A new **Run Review clears them** and starts fresh.

Storage caveat: document properties cap at ~9 KB per value / ~500 KB total. Each
thread is one value — a very long back-and-forth on one comment could approach the
per-value cap. Fine for normal use; revisit if you hit it.
