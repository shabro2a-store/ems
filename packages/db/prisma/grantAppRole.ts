import { PrismaClient } from '@prisma/client';
import { applyAppRole } from './appRole';

// Run by the compose `migrate` service after `prisma migrate deploy`, as the
// owner (its DATABASE_URL); APP_DB_PASSWORD is what web and worker log in with.
const prisma = new PrismaClient();

applyAppRole(prisma, process.env.APP_DB_PASSWORD ?? '')
  .then(() => console.log('app role: ems_app has row access and nothing more'))
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
