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
  overtime_grace_min?: number;
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
      overtime_grace_min: overrides.overtime_grace_min ?? 15,
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

export interface PunchOverrides {
  user_id: string;
  branch_id: string;
  kind?: 'IN' | 'OUT';
  at?: Date;
  lat?: number;
  lng?: number;
  accuracy_m?: number;
  device_fp?: string;
  ip?: string;
}

export async function seedTestPunch(overrides: PunchOverrides) {
  const prisma = getTestPrisma();
  return prisma.punch.create({
    data: {
      user_id: overrides.user_id,
      branch_id: overrides.branch_id,
      kind: overrides.kind ?? 'IN',
      at: overrides.at ?? new Date(),
      lat: overrides.lat ?? 33.8962,
      lng: overrides.lng ?? 35.4827,
      accuracy_m: overrides.accuracy_m ?? 12,
      device_fp: overrides.device_fp ?? 'test-fp',
      ip: overrides.ip ?? '127.0.0.1',
    },
  });
}

export interface AdvanceOverrides {
  user_id: string;
  amount_cent?: number;
  reason?: string | null;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  decided_by?: string | null;
  decided_at?: Date | null;
  // Payroll scopes advances by created_at, so a test asserting a fixed month
  // must pin this rather than inherit "now".
  created_at?: Date;
}

export async function seedTestAdvance(overrides: AdvanceOverrides) {
  const prisma = getTestPrisma();
  return prisma.advance.create({
    data: {
      user_id: overrides.user_id,
      amount_cent: overrides.amount_cent ?? 5000,
      reason: overrides.reason ?? null,
      status: overrides.status ?? 'PENDING',
      decided_by: overrides.decided_by ?? null,
      decided_at: overrides.decided_at ?? null,
      ...(overrides.created_at ? { created_at: overrides.created_at } : {}),
    },
  });
}

export interface AdjustmentOverrides {
  user_id: string;
  period?: Date;
  kind?: 'BONUS' | 'DEDUCTION';
  amount_cent?: number;
  reason?: string;
  created_by: string;
}

export async function seedTestAdjustment(overrides: AdjustmentOverrides) {
  const prisma = getTestPrisma();
  const period = overrides.period ?? new Date(`${new Date().toISOString().slice(0, 7)}-01T00:00:00.000Z`);
  return prisma.adjustment.create({
    data: {
      user_id: overrides.user_id,
      period,
      kind: overrides.kind ?? 'BONUS',
      amount_cent: overrides.amount_cent ?? 1000,
      reason: overrides.reason ?? 'test',
      created_by: overrides.created_by,
    },
  });
}

export interface RateChangeOverrides {
  user_id: string;
  rate_cent: number;
  effective_from?: Date;
}

export async function seedTestRateChange(overrides: RateChangeOverrides) {
  const prisma = getTestPrisma();
  return prisma.rateChange.create({
    data: {
      user_id: overrides.user_id,
      rate_cent: overrides.rate_cent,
      effective_from: overrides.effective_from ?? new Date(),
    },
  });
}

export async function seedTestDriver(overrides: UserOverrides = {}) {
  const driver = await seedTestUser({ ...overrides, role: Role.DRIVER });
  // A driver may only go "out on order" after the caller rings them. Seed a
  // recent dispatch call so trip-start tests reflect the normal (dispatched)
  // flow; NOT_DISPATCHED is covered separately in the unit tests.
  await seedDispatchCall(driver.id);
  return driver;
}

// A caller ring that lets the driver start one trip.
export async function seedDispatchCall(driverId: string) {
  const prisma = getTestPrisma();
  return prisma.driverCall.create({
    data: { driver_id: driverId, caller_id: driverId, created_at: new Date() },
  });
}

export interface ScheduleOverrides {
  user_id: string;
  weekday: number;
  // Production schedule queries now filter on this (Task 10); without a
  // default here, every row this helper seeds would be invisible to them.
  shift_min?: number;
}

export async function seedTestSchedule(overrides: ScheduleOverrides) {
  const prisma = getTestPrisma();
  return prisma.schedule.create({
    data: {
      user_id: overrides.user_id,
      weekday: overrides.weekday,
      shift_min: overrides.shift_min ?? 480,
    },
  });
}

export interface TripOverrides {
  driver_id: string;
  branch_id: string;
  out_at?: Date;
  out_lat?: number;
  out_lng?: number;
  back_at?: Date | null;
  back_lat?: number | null;
  back_lng?: number | null;
  over_threshold?: boolean;
  threshold_alerted_at?: Date | null;
}

export async function seedTestTrip(overrides: TripOverrides) {
  const prisma = getTestPrisma();
  return prisma.trip.create({
    data: {
      driver_id: overrides.driver_id,
      branch_id: overrides.branch_id,
      out_at: overrides.out_at ?? new Date(),
      out_lat: overrides.out_lat ?? 33.8962,
      out_lng: overrides.out_lng ?? 35.4827,
      back_at: overrides.back_at ?? null,
      back_lat: overrides.back_lat ?? null,
      back_lng: overrides.back_lng ?? null,
      over_threshold: overrides.over_threshold ?? false,
      threshold_alerted_at: overrides.threshold_alerted_at ?? null,
    },
  });
}

export interface LeaveRequestOverrides {
  user_id: string;
  kind: 'DAY_OFF' | 'HOURS_CHANGE';
  start_date: Date;
  end_date: Date;
  off_min?: number | null;
  note?: string | null;
  status?: 'PENDING' | 'APPROVED' | 'REJECTED';
  decided_by?: string | null;
  decided_at?: Date | null;
}

export async function seedTestLeaveRequest(overrides: LeaveRequestOverrides) {
  const prisma = getTestPrisma();
  return prisma.leaveRequest.create({
    data: {
      user_id: overrides.user_id,
      kind: overrides.kind,
      start_date: overrides.start_date,
      end_date: overrides.end_date,
      off_min: overrides.off_min ?? null,
      note: overrides.note ?? null,
      status: overrides.status ?? 'PENDING',
      decided_by: overrides.decided_by ?? null,
      decided_at: overrides.decided_at ?? null,
    },
  });
}

export interface FlagOverrides {
  kind: 'WATCHED' | 'MISSED_CHECKOUT' | 'TRIP_OVER_THRESHOLD';
  user_id?: string | null;
  branch_id?: string | null;
  context_json?: unknown;
  created_at?: Date;
  notified_at?: Date | null;
}

export async function seedTestFlag(overrides: FlagOverrides) {
  const prisma = getTestPrisma();
  return prisma.flag.create({
    data: {
      kind: overrides.kind,
      user_id: overrides.user_id ?? null,
      branch_id: overrides.branch_id ?? null,
      context_json: (overrides.context_json as object) ?? {},
      created_at: overrides.created_at ?? new Date(),
      notified_at: overrides.notified_at ?? null,
    },
  });
}
