---
name: platform-engineer
description: How to add a component to Super Partner itself (a model or channel, a tool or skill for the steps, a web UI feature, a scheduling or check feature) as its platform engineer. Use it when planning or building such a change in a platform-engineer copy. For fixing a defect, follow skills/platform-repair/SKILL.md instead.
---

# Adding a component to Super Partner

Any model can follow this: it needs only file reading, search, editing and a shell.
Super Partner gives it to the platform engineer for every component it plans or builds.

## Rules

- Change only Super Partner's source in the copy you were given. Do not touch task data,
  credentials, Git history, the live source, or running services.
- Keep unrelated existing changes. Never delete or weaken an existing test.
- Every component comes with tests that fail without it and pass with it.
- Build on what exists: find the owning module in `docs/ARCHITECTURE.md` and extend it.

## Planning (nothing is edited yet)

1. Read `docs/ARCHITECTURE.md`. Search (`grep -n`) for the names involved and read only those
   line ranges, not whole large files.
2. Find the closest existing example and follow it:
   - a model or channel: `catalog.py` (models), `providers.py` (API), `cli_channels.py` (`CLI_SPECS`);
   - a tool for API models: `agent.py` (`Workspace`, its tool list and sandbox);
   - a skill: a folder under `skills/` with a `SKILL.md`;
   - a web UI feature: the component in `frontend/` named in the map, styles in `style.css`;
   - scheduling, steps, checks: `executor.py`, `review.py`, `quality.py`, `planner.py`.
3. Write the plan the user approves: 目标, 改动 (each file), 测试, 风险. A web UI change names the
   existing piece of UI it follows (see Web UI below). Keep it small enough to
   build and check in one go; if it is bigger, plan the first useful part and name the rest.
4. Ask the user (QUESTION / OPTIONS / STATUS: NEEDS_INPUT) only for a choice that is theirs:
   cost, credentials, behaviour they must decide.

## Building

1. Follow the approved plan. If something in it turns out wrong, do the closest thing that works
   and say what changed and why in the report.
2. Write the tests in the test file for that area (table in `docs/ARCHITECTURE.md`), reusing the
   fixtures and helpers already there. Web UI: `frontend/tests/mission-actions.test.mjs`.
3. Prefer one place for a decision over the same check in several modules, and an existing helper
   over a new parameter threaded through every layer.
4. Check, from the narrowest to the widest:
   - `python -m pytest -q tests/<area>.py`
   - `python -m pytest -q` (all backend)
   - only if the frontend changed: `cd frontend && npm test && npm run build`
   Fix every failure your change causes.
5. Update `docs/ARCHITECTURE.md` for a new module or a moved responsibility.

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
