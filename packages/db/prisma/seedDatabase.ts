import { PrismaClient, Role } from '@prisma/client';
import bcrypt from 'bcryptjs';

const BCRYPT_ROUNDS = 12;
const SEED_DEFAULT_PASSWORD = 'change-me';

interface BranchSeed {
  name: string;
  lat: number;
  lng: number;
}

const BRANCHES: BranchSeed[] = [
  // Branch 1: Your house — replace with actual lat/lng from Google Maps pin
  { name: 'Home Office', lat: 0, lng: 0 },
  // Branch 2: Tarek Jdedi — replace with actual lat/lng from Google Maps pin
  { name: 'Tarek Jdedi', lat: 0, lng: 0 },
];

const DEFAULT_HOURLY_RATE_CENT = 200;
const DEFAULT_SHIFT_MIN = 540;
const SCHEDULE_WEEKDAYS = [6, 0, 1, 2, 3];

// Fills an empty database with a starting admin, two branches and two
// employees. It never deletes: on a database that already has people or
// branches it throws, so pointing it at the live server by mistake changes
// nothing.
export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  const [users, branches] = await Promise.all([prisma.user.count(), prisma.branch.count()]);
  if (users > 0 || branches > 0) {
    throw new Error(
      `seed: refused - the database already has data (${users} users, ${branches} branches). ` +
        'The seed only fills an empty database and never deletes anything.',
    );
  }

  const passwordHash = await bcrypt.hash(SEED_DEFAULT_PASSWORD, BCRYPT_ROUNDS);

  await prisma.$transaction(async (tx) => {
    // Admin (owner)
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
            shift_min: DEFAULT_SHIFT_MIN,
          },
        });
      }
    }
  });


  console.log(`seed: complete (${BRANCHES.length} branches, ${BRANCHES.length} employees, 1 admin)`);
}
