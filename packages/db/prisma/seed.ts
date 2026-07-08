import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('seed: starting');
  console.log('seed: complete (Phase 0 - no users/branches yet)');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());