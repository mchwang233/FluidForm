---
name: platform-engineer
description: How to add a component to FluidForm itself (a model or channel, a tool or skill for the steps, a web UI feature, a scheduling or check feature) as its platform engineer. Use it when planning or building such a change in a platform-engineer copy. For fixing a defect, follow skills/platform-repair/SKILL.md instead.
---

# Adding a component to FluidForm

Any model can follow this: it needs only file reading, search, editing and a shell.
FluidForm gives it to the platform engineer for every component it plans or builds.

## Rules

- Change only FluidForm's source in the copy you were given. Do not touch task data,
  credentials, Git history, the live source, or running services.
- Keep unrelated existing changes. Never delete or weaken an existing test.
- Every component comes with tests that fail without it and pass with it.
- Build on what exists: find the owning module in `docs/ARCHITECTURE.md` and extend it.
- Take what already works (拿来主义). Before writing anything that talks to an outside service or
  solves a common problem (a chat app, a file format, a protocol, retries, parsing), look for the
  official way first (the vendor's SDK, API or integration), then a mature open-source one
  (maintained, widely used, a licence that allows it). Use it as it is meant to be used, not a
  copy of its code. Write it yourself only when neither exists or neither fits; say in the plan
  what you looked at and why it did not fit.
- The product is called FluidForm. Every word a user sees (UI text, replies, errors, reports)
  and every prompt given to a model says FluidForm. "FluidForm" stays only in the package
  names, `FLUIDFORM_` settings and code identifiers.
- The job has a budget and the user is waiting: work economically (see Building, step 4).

## Planning (nothing is edited yet)

1. Read `docs/ARCHITECTURE.md`. Search (`grep -n`) for the names involved and read only those
   line ranges, not whole large files.
2. Find the closest existing example and follow it:
   - something people or other apps use through FluidForm (a chat app's bot, an integration with an
     outside service, a background service): a capability package, as
     `skills/capability-package/SKILL.md` says. Kept inside its folder, it goes live without a restart;
   - a model or channel: `server/src/catalog.ts` (models), `providers.ts` (API), `cli-channels.ts` (`CLI_SPECS`);
     follow `skills/model-channel/SKILL.md`: measure its sandbox, output and quota messages first;
   - a tool for API models: `agent.ts` (`Workspace`, its tool list and sandbox);
   - a skill: a folder under `skills/` with a `SKILL.md`;
   - a web UI feature: the component in `frontend/` named in the map, styles in `style.css`;
   - scheduling, steps, checks: `executor.ts` (and the class chain before it), `review.ts`, `quality.ts`, `packages/planning/src/planner.ts`;
   - an API route: `app.ts`, with what routes share in `api.ts`.
3. Write the plan the user approves: 目标, 现成方案 (the official or open-source solution it uses, or
   what was looked at and why none fits), 改动 (each file), 测试, 风险. A new dependency is named
   in the plan with its source and licence; the user's approval of the plan is their agreement to it. A web UI change names the
   existing piece of UI it follows (see Web UI below). Keep it small enough to
   build and check in one go, within the job's budget: about five files and one layer's worth
   of new tests. If it is bigger, plan the first useful part and name the rest. Say in the plan
   whether it goes live by installing a package (no downtime) or by a restart (FluidForm is offline
   for a few seconds, tasks wait).
4. Ask the user (QUESTION / OPTIONS / STATUS: NEEDS_INPUT) only for a choice that is theirs:
   cost, credentials, behaviour they must decide.

## Building

1. Start with a short checklist of the work (a todo list or plan, if your tool has one) and tick
   items off as you go: the user follows it live on the job's page. Then follow the approved
   plan. If something in it turns out wrong, do the closest thing that works and say what
   changed and why in the report.
2. Write the tests in the test file for that area (table in `docs/ARCHITECTURE.md`), reusing the
   fixtures and helpers already there. Web UI: `frontend/tests/mission-actions.test.mjs`. Its
   timers do not run on their own: `setInterval` callbacks are collected, and a test runs them
   with `state.poll()` (the first) or `state.pollAll()` (all); waiting for time does nothing.
3. Prefer one place for a decision over the same check in several modules, and an existing helper
   over a new parameter threaded through every layer.
4. Check only what you changed: `cd server && npm run check` (types) and the test file,
   `node --import tsx --import ./tests/helpers/tmp.ts --test tests/<area>.test.ts` (and the
   frontend test file's matching tests, with `node --test --test-name-pattern=...`, if you changed
   the UI). Do not run the whole server suite or the frontend build: after you report, FluidForm runs
   every check itself in a clean sandbox, and if one fails it gives you the output to fix. A
   failure that also happens without your change (your own sandbox's limits: no network, no
   bwrap inside it) is named in the report, not chased.
5. Write the design note: a new feature gets `docs/design/<name>.md`, a change to one gets a
   section in its existing note (为什么, 改动, 测试, 风险, in the style of the notes there).
   Update `docs/ARCHITECTURE.md` for a new module or a moved responsibility.

## Web UI

The UI is plain and quiet: white or near-black panels, hairlines, grey text, one green. A change
must look like it was always there. Before writing any markup:

1. Find the closest existing piece of UI for the same kind of thing and copy its structure and
   classes (a setting: `.capability-field` in `frontend/capabilities.tsx`; a list row, a chip, a
   tab bar: the page in the map that has one). Add new CSS only for what nothing covers, next
   to that component's rules in `style.css`.
2. Colours, borders and backgrounds only through the variables in `style.css` (`--text`,
   `--muted`, `--faint`, `--line`, `--panel`, `--panel-2`, `--ok`, `--danger`, `--accent`), so
   the dark theme follows. In `.tsx` files no colour literals, and `style=` only for a size or
   position that comes from data, such as a bar's width (`tests/bundle.test.mjs` checks this).
3. A bare `<form>` gets the global card look (border, radius, big shadow). Inside a card, use a
   `<div>`, or give the form a class whose rule removes border, background and shadow, as
   `.capability-secrets` does. Never a box inside a box.
4. A setting saves when it changes (a select on change, a number on blur), with a faint
   "保存中… / 已保存" next to its label. A save button only when several fields go together
   (secrets). At most one `primary` button in view.
5. Words: a label of 2–6 characters; one hint line, at most about 30 characters, saying what it
   does for the user, never how it is implemented (no "重启后保留", no field names). Errors in
   `.error`, short.
6. Lay it out for 720 px wide as well (fields stack). Line up with the controls around it: the
   same heights (32 px inputs), the same label size.
7. Say in the report what the user now sees and where, in one or two sentences.

## Report

In Chinese, short: 改了什么 (each file), 测试 (names and what they prove), 验证 (commands and
results). End with `STATUS: FIXED`.
