# AGENTS.md

Conventions for anyone (human or AI) working on this repo. Read
[SYSTEM_MAP.md](SYSTEM_MAP.md) for what the system does and [API.md](API.md) for the
endpoint contract.

## Stack
- pnpm workspace. Apps: `apps/web` (Next.js 14 App Router), `apps/worker` (node-cron).
  Packages: `db` (Prisma/Postgres), `time` (Asia/Beirut), `notify` (Telegram), `pdf`.
- TypeScript strict mode everywhere. pnpm only (no npm/yarn).

## Code conventions
- No emoji in code; no comments unless they explain a non-obvious decision.
- All money is `Int` cents (USD) — never floats.
- No new dependencies without justification in the commit message.
- File naming: services camelCase (`payout.ts`), components PascalCase
  (`AdminDashboard.tsx`), API routes `app/api/{path}/route.ts`.
- Commit messages: Conventional Commits — `feat(scope):`, `fix(scope):`,
  `chore:`, `docs:`, `test:`.

## UI
- One design system. Do not hand-roll styles that duplicate it:
  - Tokens: CSS variables in `apps/web/app/globals.css`, mapped in `tailwind.config.ts`
    (slate ground, blue accent; semantic success/danger/warning kept separate from the accent).
  - Primitives: `apps/web/components/ui/*` (Button, Card, Badge, Field/Input/Select,
    Modal, StatTile, EmptyState, Alert, Spinner, PageHeader).
  - Admin pages live under the shared `admin/layout.tsx` (nav + auth). Field
    (employee/driver) pages live under `FieldShell` (mobile shell + bottom nav).
- Client API calls go through `apps/web/lib/api.ts` (`apiGet`/`apiSend` handle CSRF +
  Idempotency-Key; `errorMessage` shows the human message, never a raw code).

## API conventions
- Every response is `{ ok: true, data }` or `{ ok: false, error: { code, message } }`.
- Auth: middleware verifies the JWT and injects `x-user-id`/`x-user-role`; every
  route re-checks the role. `me/*` is scoped to the caller's own id.
- Mutations require a CSRF token; most POSTs require an `Idempotency-Key`.
- Never return `password_hash` (or other secrets) to the client — select explicitly.
- The admin account is protected: it can't be created via the app, promoted/demoted,
  or deactivated.
- Every mutation writes an append-only `AuditLog` entry.

## Testing
- `pnpm -r typecheck` and `pnpm -r test` must be green.
- Unit tests run standalone; HTTP integration tests need the app running at
  `TEST_BASE_URL` (default `http://127.0.0.1:3000`) plus Postgres — see the CI
  workflow and README.
