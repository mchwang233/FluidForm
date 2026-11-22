# FluidForm

A local web app that plans a task into steps, runs each step on a chosen model (membership CLIs
or API models with sandboxed tools), reviews the results, and diagnoses and repairs failures.

- Backend: `server` (TypeScript, Node 22+, Fastify). Frontend: `frontend` (React, Vite).
- How a task is done (planning, lead, engineer, learning) lives in `server/packages/<id>/src`; `server/src` never imports it.
- Where things are: `docs/ARCHITECTURE.md`. Read it before searching the code.
- Fixing a defect in FluidForm itself: follow `skills/platform-repair/SKILL.md`.
- Adding a component to FluidForm itself: follow `skills/platform-engineer/SKILL.md`.
- Any change to FluidForm itself also follows `skills/platform-rules/SKILL.md` (no machine-specific facts in the source).
- Tests: `cd server && npm run check && npm test` (backend), `cd frontend && npm test && npm run build` (frontend).
  One file: `cd server && node --import tsx --import ./tests/helpers/tmp.ts --test tests/<area>.test.ts`.
- The service runs the compiled server (`server/dist`, built by `./start.sh`).
