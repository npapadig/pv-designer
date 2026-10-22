# How we work together (read first, every session)

## 0. About me (the owner)
- Name: Νίκος. Talk to me in **Greek**, informal and friendly.
- Field: not stated (asked 2026-10-21, chose not to say; do not ask again). I am not an IT person: explain in plain words, no jargon without a one-line explanation.
- Decide technical things yourself (libraries, file layout, code style). Ask me ONLY what only I can know: goals,
  engineering/PV choices that change results, priorities, money, privacy or my accounts.
- Weekly usage limit I accept: 98 % (raised from 90 % on 2026-10-22).
- **If a <<TBD>> above is still empty, ask me for it first (AskUserQuestion) and write my answer here.**

## 1. Basics (every session)
1. Questions to me ALWAYS with the AskUserQuestion tool (buttons, recommended option first, labelled "(Προτείνεται)"),
   never only in prose. One decision per question, 2-4 clear options with a short description.
2. The project folder must be a git checkout before the first change (see HANDOFF.md, "Πρώτη φορά").
   Commit after every finished step with a clear message ("0.6.0: ...").
3. Ask me BEFORE: installing anything new, touching anything outside the project folder, deleting files,
   sending/publishing anything (a `git push` to my repo is part of normal work and is fine), creating accounts.
   Never write to or delete my real data (`data/`, `_inputs/`).
4. Small steps (one or two items at a time). After every step: run the checks of §3, bump the version, update
   HANDOFF.md, and tell me in 2-4 plain lines what changed and what to try.
5. Never claim something works without running it. If a check fails, say so plainly, with the output.
6. Record every decision I make (date + what I chose) in docs/PLAN.md, so no future session asks again.

## 2. Memory between sessions (files in the project)
- `HANDOFF.md`: SHORT current state (version, what works, what is open, what we wait for from me, latest usage %).
  Every session reads it first. Keep it short; move old history to `docs/history/`.
- `docs/PLAN.md`: the agreed plan / roadmap with my decisions.
- `KANE_ESY.txt`: what YOU need from ME, numbered, step by step, in plain Greek.
- `docs/TESTS_FOR_ME.txt`: numbered things for me to try (T01, T02...); I write OK / ΠΡΟΒΛΗΜΑ / ΙΔΕΑ.
  My answers and screenshots go to `_inputs/tests/`.
- `docs/streams/`: one task file per stream (see §4).
- My private inputs live in `_inputs/` (git-ignored) and never ship in a release.

## 3. Checks that protect the results ("the numbers are sacred")
- BASELINE: `tests/baseline/` has fixed sample projects (`projects.json`) and their verified outputs
  (`expected.json`). `tests/test_baseline.py` compares them on every `python -m pytest`.
  Outputs must stay identical, unless the difference is one I decided: then regenerate with
  `python -m tests.baseline.run --write`, and list the change in CHANGELOG.md and HANDOFF.md.
- One test file per area in `tests/`. The number of passing checks may only go up, never a FAIL.
- A difference I did not ask for is a bug: stop and fix it before anything else.

## 4. Parallel work: coordinator + streams
- Work is split into STREAMS (small, independent pieces). `docs/streams/README.md` lists them and the files each owns.
- The main session = COORDINATOR, on `main` (my everyday version). It writes a stream's task file first (goal, owned
  files, numbered items, checks, status table), then starts the stream in its own session + git worktree/branch.
- A stream touches only its own files, does NOT bump the version or edit HANDOFF.md, and keeps its task file updated.
- The coordinator merges a ready stream step WITHOUT asking me again, but ONLY after the full checks (§3) pass on
  `main`; each merge = new version + HANDOFF + changelog + a short note to me. Check that the branch did not change
  line endings or unrelated files. Failing work is not merged.
- If a new session cannot be started (e.g. I write from my phone), ask me once: "do it here (in a worktree) / wait".

## 5. Usage economy
- At most 2 streams at a time (+ the coordinator).
- Check usage at every merge (if a usage command is available) and tell me the weekly % in one line.
  - weekly >= 75 %: no NEW stream without my yes; finish what runs.
  - weekly >= my limit in §0: SAFE STOP. Merge only verified work, leave a working version, complete HANDOFF +
    KANE_ESY + TESTS_FOR_ME; half-done work stays on its branch with a note; continue after the weekly reset.
- Big/slow checks run ONCE per merge, in the coordinator. Keep conversations short; read only the parts of big
  files you need; save long command output to a file and read the summary. Run commands over ~2 minutes in the
  background.

## 6. Fresh sessions instead of long ones
- Propose a NEW session (after a short handoff) when a stream's list is done, the conversation is long, or I bring
  a new unrelated topic. The coordinator renews itself the same way: CLAUDE.md -> HANDOFF.md -> PLAN.md -> KANE_ESY.

## 7. Automations
- When work may hit the 5-hour limit and scheduled tasks are available, create a one-time task (reset time + ~10 min)
  that tells the running sessions "continue if the limit stopped you, otherwise do nothing".
- Save my lasting preferences in Claude's memory (one fact per memory) when memory is available.

## 8. Feedback rounds
- When my test answers arrive: read them all, group them BY CATEGORY (appearance/texts, engine/results, outputs,
  install), one small task file per category, ask me about anything unclear, then run them as small streams until
  every item is done. My feedback has priority over new features when usage is tight.

---

# Code notes (PV Designer)


- The app owner is Greek-speaking and not technical. All user-facing text (UI, launcher messages, README, CHANGELOG) is in Greek; launcher console messages are in greeklish because cmd.exe mangles Greek.
- **Every change merged to `main` must bump the version** in `VERSION` (semver: patch for fixes, minor for new features) **and add an entry at the top of `CHANGELOG.md`** (in Greek, one line per change, under a `## vX.Y.Z (date)` heading). Changes that touch only `CLAUDE.md`, `docs/` or tests need no bump. Several threads push to `main` in parallel: before merging, rebase on `main` and re-check that your version is higher than the one there, renumbering your entry if needed.
- The version is shown in the app header (from `GET /api/version`) and in the `start_windows.bat` console; `update.ps1` prints "apo vX se vY" after updating. Do not hardcode the version anywhere else.
- Windows launcher (`start_windows.bat`, `update.ps1`) must keep CRLF line endings and must not rely on `if errorlevel` for the Python Install Manager (it can return negative codes).
- Run the tests with `python -m pytest` before pushing.
- **The owner's usage limit can run out mid-task.** Work in small, complete steps: each push to `main` must be a finished, working change that passes `python -m pytest`, so `main` is never left broken or half-done. Keep unfinished work on a branch. Before starting a large new piece of work, tell the owner first and split it into small releases.
- Architecture, features, key files and the fragile Windows launcher: `docs/ARCHITECTURE.md`. Update it when they change.
