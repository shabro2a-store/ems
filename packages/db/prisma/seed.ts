import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;
const SEED_DEFAULT_PASSWORD = 'change-me';

const prisma = new PrismaClient();

interface BranchSeed {
  name: string;
  lat: number;
  lng: number;
}

const BRANCHES: BranchSeed[] = [
  { name: 'Hamra', lat: 33.8962, lng: 35.4827 },
  { name: 'Achrafieh', lat: 33.8895, lng: 35.5163 },
  { name: 'Verdun', lat: 33.8912, lng: 35.4871 },
];

const DEFAULT_HOURLY_RATE_CENT = 200;
const DEFAULT_SCHEDULE = { start_time: '09:00', end_time: '18:00' };
const SCHEDULE_WEEKDAYS = [6, 0, 1, 2, 3];

async function main() {
  console.log('seed: starting');

  const passwordHash = await bcrypt.hash(SEED_DEFAULT_PASSWORD, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    const existing = await tx.user.findUnique({ where: { username: 'owner' } });
    if (existing) {
      console.log('seed: admin already exists, skipping user creation');
      return;
    }

    await tx.user.create({
      data: {
        username: 'owner',
        password_hash: passwordHash,
        role: Role.ADMIN,
        branch_id: null,
        hourly_rate_cent: 0,
      },
    });

    for (let i = 0; i < BRANCHES.length; i++) {
      const b = BRANCHES[i]!;
      const branch = await tx.branch.create({
        data: {
          name: b.name,
          lat: b.lat,
          lng: b.lng,
        },
      });

      const employeeUsername = `emp${i + 1}`;
      const employee = await tx.user.create({
        data: {
          username: employeeUsername,
          password_hash: passwordHash,
          role: Role.EMPLOYEE,
          branch_id: branch.id,
          hourly_rate_cent: DEFAULT_HOURLY_RATE_CENT,
        },
      });

      const now = new Date();
      await tx.rateChange.create({
        data: {
          user_id: employee.id,
          rate_cent: DEFAULT_HOURLY_RATE_CENT,
          effective_from: now,
        },
      });

      for (const weekday of SCHEDULE_WEEKDAYS) {
        await tx.schedule.create({
          data: {
            user_id: employee.id,
            weekday,
            start_time: DEFAULT_SCHEDULE.start_time,
            end_time: DEFAULT_SCHEDULE.end_time,
          },
        });
      }
    }
  });

  console.log('seed: complete');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });