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
  // Branch 1: Your house — replace with actual lat/lng from Google Maps pin
  { name: 'Home Office', lat: 0, lng: 0 },
  // Branch 2: Tarek Jdedi — replace with actual lat/lng from Google Maps pin
  { name: 'Tarek Jdedi', lat: 0, lng: 0 },
];

const DEFAULT_HOURLY_RATE_CENT = 200;
const DEFAULT_SHIFT_MIN = 540;
const SCHEDULE_WEEKDAYS = [6, 0, 1, 2, 3];

async function main() {
  console.log('seed: starting');

  const passwordHash = await bcrypt.hash(SEED_DEFAULT_PASSWORD, BCRYPT_ROUNDS);

  // Clean ALL existing data (in dependency order) so we can re-seed cleanly.
  // Idempotent — safe to run multiple times.
  await prisma.$transaction(async (tx) => {
    await tx.auditLog.deleteMany();
    await tx.adjustment.deleteMany();
    await tx.advance.deleteMany();
    await tx.punch.deleteMany();
    await tx.trip.deleteMany();
    await tx.scheduleOverride.deleteMany();
    await tx.leaveRequest.deleteMany();
    await tx.schedule.deleteMany();
    await tx.rateChange.deleteMany();
    await tx.idempotencyKey.deleteMany();
    await tx.rateLimitBucket.deleteMany();
    await tx.flag.deleteMany();
    // Detach users from branches before deleting branches
    await tx.user.updateMany({ data: { branch_id: null } });
    await tx.user.deleteMany();
    await tx.branch.deleteMany();
  });

  console.log('seed: cleared existing data');

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

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });