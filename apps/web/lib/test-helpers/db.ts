import { PrismaClient, Role, OverrideKind, OverrideSource } from '@prisma/client';
import bcrypt from 'bcryptjs';
import fs from 'fs';
import path from 'path';
import { BCRYPT_ROUNDS } from '@/lib/auth/constants';

function loadEnvOnce() {
  if (process.env.DATABASE_URL && process.env.JWT_SECRET) return;
  const candidates = [
    path.resolve(process.cwd(), '.env'),
    path.resolve(process.cwd(), '..', '..', '.env'),
    path.resolve(__dirname, '..', '..', '..', '..', '.env'),
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    const text = fs.readFileSync(p, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
    break;
  }
}

loadEnvOnce();

let _prisma: PrismaClient | null = null;

export function getTestPrisma(): PrismaClient {
  if (!_prisma) {
    _prisma = new PrismaClient({
      log: ['error'],
    });
  }
  return _prisma;
}

const TABLES = [
  'Punch',
  'Trip',
  'AuditLog',
  'ScheduleOverride',
  'LeaveRequest',
  'Adjustment',
  'Advance',
  'RateChange',
  'Schedule',
  'Flag',
  'IdempotencyKey',
  'RateLimitBucket',
  'Branch',
  'User',
];

export async function cleanDb(): Promise<void> {
  const prisma = getTestPrisma();
  await prisma.$transaction(
    TABLES.map((t) => prisma.$executeRawUnsafe(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`)),
  );
}

export interface BranchOverrides {
  name?: string;
  lat?: number;
  lng?: number;
  gps_radius_m?: number;
  gps_accuracy_max_m?: number;
  absent_grace_min?: number;
  trip_threshold_min?: number;
  is_active?: boolean;
}

export async function seedTestBranch(overrides: BranchOverrides = {}) {
  const prisma = getTestPrisma();
  return prisma.branch.create({
    data: {
      name: overrides.name ?? 'Hamra',
      lat: overrides.lat ?? 33.8962,
      lng: overrides.lng ?? 35.4827,
      gps_radius_m: overrides.gps_radius_m ?? 50,
      gps_accuracy_max_m: overrides.gps_accuracy_max_m ?? 100,
      absent_grace_min: overrides.absent_grace_min ?? 15,
      trip_threshold_min: overrides.trip_threshold_min ?? 30,
      is_active: overrides.is_active ?? true,
    },
  });
}

export interface UserOverrides {
  username?: string;
  password?: string;
  role?: Role;
  branch_id?: string | null;
  hourly_rate_cent?: number;
  is_active?: boolean;
}

export async function seedTestUser(overrides: UserOverrides = {}) {
  const prisma = getTestPrisma();
  const password = overrides.password ?? 'change-me';
  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  const hourlyRateCent = overrides.hourly_rate_cent ?? 200;

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        username: overrides.username ?? `itest-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
        password_hash: passwordHash,
        role: overrides.role ?? Role.EMPLOYEE,
        branch_id: overrides.branch_id === undefined ? null : overrides.branch_id,
        hourly_rate_cent: hourlyRateCent,
        is_active: overrides.is_active ?? true,
      },
    });
    await tx.rateChange.create({
      data: {
        user_id: user.id,
        rate_cent: hourlyRateCent,
        effective_from: new Date(),
      },
    });
    return user;
  });
}

export async function seedDayOffOverride(userId: string, date: Date) {
  const prisma = getTestPrisma();
  const dateOnly = new Date(`${date.toISOString().slice(0, 10)}T00:00:00.000Z`);
  return prisma.scheduleOverride.create({
    data: {
      user_id: userId,
      date: dateOnly,
      kind: OverrideKind.DAY_OFF,
      source: OverrideSource.ADMIN_DIRECT,
    },
  });
}
