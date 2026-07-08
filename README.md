# Supermarket EMS

Employee Management System for supermarket branches in Beirut.

## Local Development

```bash
# Start Postgres
docker compose up -d db

# Install dependencies
pnpm install

# Run migrations
pnpm --filter db prisma migrate dev --name init

# Start web (http://localhost:3000)
pnpm --filter web dev

# Start worker
pnpm --filter worker dev
```

## Tech Stack

- Next.js 14 (App Router)
- PostgreSQL 16 + Prisma
- node-cron worker
- pnpm workspaces