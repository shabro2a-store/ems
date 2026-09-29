import { PrismaClient } from '@prisma/client';
import { seedDatabase } from './seedDatabase';

const prisma = new PrismaClient();

seedDatabase(prisma)
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
