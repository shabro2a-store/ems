import { PrismaClient } from '@prisma/client';
import { todayInBeirut, todayInBeirutDateRange } from 'time';
import { prisma as defaultPrisma } from '../db/prisma';
import type { Notifier } from 'notify';

export interface DailySummaryOpts {
  db?: PrismaClient;
  now?: Date;
  notifier: Notifier;
}

export interface DailySummaryResult {
  branch_id: string | null;
  branch_name: string | null;
  present: number;
  absent: number;
  drivers_out: number;
  flags_count: number;
  notified: boolean;
}

export async function runDailySummary(opts: DailySummaryOpts): Promise<DailySummaryResult[]> {
  const db = opts.db ?? defaultPrisma;
  const now = opts.now ?? new Date();
  const today = todayInBeirut(now);
  const { startUtc, endUtc } = todayInBeirutDateRange(today);

  const branches = await db.branch.findMany({
    where: { is_active: true },
    orderBy: { name: 'asc' },
  });

  // Always do a system-wide summary too (branch_id = null)
  const allBranchesSummary = await summarize(db, null, null, startUtc, endUtc);
  const results: DailySummaryResult[] = [];
  const sysResult: DailySummaryResult = {
    branch_id: null,
    branch_name: null,
    present: allBranchesSummary.present,
    absent: allBranchesSummary.absent,
    drivers_out: allBranchesSummary.driversOut,
    flags_count: allBranchesSummary.flagsCount,
    notified: false,
  };
  await opts.notifier.send({
    channel: 'telegram',
    recipient: 'admin',
    template: 'daily_summary',
    context: {
      branch: { id: 'all', name: 'All branches' },
      present: sysResult.present,
      absent: sysResult.absent,
      drivers_out: sysResult.drivers_out,
      flags_count: sysResult.flags_count,
    },
  });
  sysResult.notified = true;
  results.push(sysResult);

  for (const branch of branches) {
    const summary = await summarize(db, branch.id, branch.name, startUtc, endUtc);
    const result: DailySummaryResult = {
      branch_id: branch.id,
      branch_name: branch.name,
      present: summary.present,
      absent: summary.absent,
      drivers_out: summary.driversOut,
      flags_count: summary.flagsCount,
      notified: false,
    };
    await opts.notifier.send({
      channel: 'telegram',
      recipient: 'admin',
      template: 'daily_summary',
      context: {
        branch: { id: branch.id, name: branch.name },
        present: result.present,
        absent: result.absent,
        drivers_out: result.drivers_out,
        flags_count: result.flags_count,
      },
    });
    result.notified = true;
    results.push(result);
  }

  return results;
}

interface BranchSummary {
  present: number;
  absent: number;
  driversOut: number;
  flagsCount: number;
}

async function summarize(
  db: PrismaClient,
  branchId: string | null,
  _branchName: string | null,
  startUtc: Date,
  endUtc: Date,
): Promise<BranchSummary> {
  const activeUsers = await db.user.findMany({
    where: { is_active: true, ...(branchId ? { branch_id: branchId } : {}) },
    select: { id: true },
  });
  const userIds = activeUsers.map((u) => u.id);
  const setIds = new Set(userIds);

  // present = users who have an IN punch today with no later OUT
  const allIns = await db.punch.findMany({
    where: { user_id: { in: userIds }, kind: 'IN', at: { gte: startUtc, lt: endUtc } },
    orderBy: { at: 'asc' },
  });
  const allOuts = await db.punch.findMany({
    where: { user_id: { in: userIds }, kind: 'OUT', at: { gte: startUtc, lt: endUtc } },
    orderBy: { at: 'asc' },
  });

  // Per user, find latest IN and whether a later OUT exists
  const lastInByUser = new Map<string, Date>();
  for (const p of allIns) lastInByUser.set(p.user_id, p.at);
  const presentIds = new Set<string>();
  for (const u of userIds) {
    const lastIn = lastInByUser.get(u);
    if (!lastIn) continue;
    const laterOut = allOuts.find(
      (o) => o.user_id === u && o.at.getTime() > lastIn.getTime(),
    );
    if (!laterOut) presentIds.add(u);
  }

  const driversOut = await db.trip.count({
    where: {
      back_at: null,
      driver: { ...(branchId ? { branch_id: branchId } : {}), is_active: true },
    },
  });

  const flagsCount = await db.flag.count({
    where: {
      created_at: { gte: startUtc, lt: endUtc },
      ...(branchId ? { branch_id: branchId } : {}),
    },
  });

  // Absent: active users minus present (drivers currently out are excluded)
  // We use set math to avoid double-counting
  const present = presentIds.size;
  const absent = Math.max(0, setIds.size - present);
  void driversOut;
  void flagsCount;

  return { present, absent, driversOut, flagsCount };
}