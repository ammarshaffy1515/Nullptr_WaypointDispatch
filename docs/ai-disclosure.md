# AI tool disclosure

**Tool used:** Claude Code (Anthropic, Claude Opus 5.5), running in the team's terminal.

## What was AI-assisted

We missed the Designathon deadline, so the Hackathon build was produced under heavy time pressure with substantial AI assistance:

- **Reading the brief and datasets.** Claude extracted the challenge booklet, profiled the shared CSVs and read the organisers' `check_allocation.py` to pin down the exact feasibility rules.
- **Code generation.** Most of the source was drafted by Claude from our instructions: the allocation engine (`src/planner.js`), the API (`src/server.js`), the schema and seeding (`src/db.js`), the single-page client (`public/app.js`, `styles.css`), the service worker, and the tests.
- **Documentation.** The first drafts of the README, the architecture diagram, the data model and this disclosure.

## What the team did

- Chose the scope and made the product decisions: the team name, seeding a real peak day from the scenario files, deploying to Render, and the four-role walkthrough.
- Reviewed the generated code and docs, ran the walkthrough end to end, recorded the demo video and submitted.

## How we checked the AI's work

- `npm test` runs the engine against the 85-order peak-day scenario and asserts zero constraint violations.
- The engine's output was exported in the Task 2B format and passed the organisers' own checker: `FEASIBILITY: PASSED - every rule satisfied.`
- An API smoke test ran the full chain (order → close → plan → release → load with shortfall → offline driver sync with duplicate replay → alerts) before the deadline.
