# AGENTS.md

## Conventions

- No emoji in code, no comments unless explicitly asked
- TypeScript strict mode everywhere
- pnpm only (no npm, no yarn)
- All money is Int cents (USD), no floats
- No new dependencies without listing them with justification
- File naming: services are camelCase (payout.ts), components PascalCase (PunchButton.tsx), routes are /app/api/{path}/route.ts
- Commit messages: "phase-0: ..." through "phase-8: ..." then "fix(phase-N): ..." for bug fixes