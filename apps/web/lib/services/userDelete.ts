import type { PrismaClient } from '@prisma/client';

/**
 * What a person owns that makes deleting them destroy a record.
 *
 * The split is between what somebody DID and how they were SET UP. A punch, a
 * trip, an advance, a penalty ruling: those are the attendance record and the
 * money, and a month already paid has to stay reconstructible from them. A
 * schedule, a pay rate, a push subscription: those describe an account, mean
 * nothing once it is gone, and every account has some from the moment it is
 * created - counting them would mean nobody could ever be deleted at all.
 *
 * `driverCall` counts on both sides. A caller who has rung drivers is part of
 * those trips' history even though they never punched.
 *
 * Deliberately NOT counted: Flag, LeaveRequest, ScheduleOverride. A flag is
 * monitoring noise the system raises on its own, and someone flagged once for
 * failing to show up on their first day should still be deletable. Anyone who
 * actually worked has punches, which do count.
 */
export interface UserHistory {
  punches: number;
  trips: number;
  advances: number;
  adjustments: number;
  penaltyWaivers: number;
  penaltyAcks: number;
  overtimeDecisions: number;
  blockedCreditDecisions: number;
  blockedPunches: number;
  driverCalls: number;
}

export function hasHistory(h: UserHistory): boolean {
  return Object.values(h).some((n) => n > 0);
}

export async function userHistory(db: PrismaClient, userId: string): Promise<UserHistory> {
  const [
    punches,
    trips,
    advances,
    adjustments,
    penaltyWaivers,
    penaltyAcks,
    overtimeDecisions,
    blockedCreditDecisions,
    blockedPunches,
    callsReceived,
    callsMade,
  ] = await Promise.all([
    db.punch.count({ where: { user_id: userId } }),
    db.trip.count({ where: { driver_id: userId } }),
    db.advance.count({ where: { user_id: userId } }),
    db.adjustment.count({ where: { user_id: userId } }),
    db.penaltyWaiver.count({ where: { user_id: userId } }),
    db.penaltyAck.count({ where: { user_id: userId } }),
    db.overtimeDecision.count({ where: { user_id: userId } }),
    db.blockedCreditDecision.count({ where: { user_id: userId } }),
    db.blockedPunchAttempt.count({ where: { user_id: userId } }),
    db.driverCall.count({ where: { driver_id: userId } }),
    db.driverCall.count({ where: { caller_id: userId } }),
  ]);
  return {
    punches,
    trips,
    advances,
    adjustments,
    penaltyWaivers,
    penaltyAcks,
    overtimeDecisions,
    blockedCreditDecisions,
    blockedPunches,
    driverCalls: callsReceived + callsMade,
  };
}

/**
 * Retire an account whose records have to stay.
 *
 * The owner's model, and it is the right one: the PERSON goes today, the
 * RECORDS stay. He deletes somebody who quit in January; they lose the login
 * immediately and vanish from every present-tense screen, January's payroll
 * still shows the month he owed them, and February simply never mentions them
 * because they have no records in February. Nothing has to expire, and nothing
 * has to be swept up at month end - the absence is a consequence of having no
 * punches, not of a job running.
 *
 * A row-level delete cannot do that. Punch.user_id is a required foreign key,
 * so Postgres either refuses the delete or, with a cascade, takes the punches
 * with it and rewrites a month that has already been paid.
 *
 * So the row stays and the account is emptied of everything that makes it an
 * account:
 *
 *  - the login dies twice over - is_active false, and a password hash nothing
 *    can match
 *  - the username is FREED. It moves aside so the same person can be hired back
 *    under their old name with a genuinely new account, which is what the owner
 *    means by "he needs a new one if he comes back". `name` keeps the human
 *    label so payroll history still reads as a person.
 *  - the schedule goes, so the absence detector stops flagging somebody who is
 *    not coming, and the telegram/push wiring goes with it
 *
 * RateChange is deliberately kept: it is what prices their old punches, and
 * without it every month they worked would silently reprice to zero.
 *
 * The audit trail is untouched either way. AuditLog.actor_id has no foreign key
 * (see writeAuditLog), so everything this person did, and everything done to
 * them, outlives the account - including the row recording this.
 */
export async function retireUser(
  db: PrismaClient,
  user: { id: string; username: string; name: string | null },
  now: Date,
): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.pushSubscription.deleteMany({ where: { user_id: user.id } });
    await tx.schedule.deleteMany({ where: { user_id: user.id } });
    await tx.scheduleOverride.deleteMany({ where: { user_id: user.id, date: { gte: now } } });

    await tx.user.update({
      where: { id: user.id },
      data: {
        deleted_at: now,
        is_active: false,
        // Keeps the person readable in the months they worked. Without it,
        // freeing the username below would leave payroll history labelled with
        // the parked name.
        name: user.name ?? user.username,
        // Freed for reuse, and unique by construction. The id suffix is not
        // decoration: usernames are unique, so parking one without it would
        // collide the second time somebody with the same name is retired.
        username: `${user.username}#${user.id.slice(-8)}`,
        // Nothing can match this, so the account is dead even if is_active were
        // ever flipped back by hand.
        password_hash: 'retired',
        telegram_chat_id: null,
        can_roam_branches: false,
      },
    });
  });
}

/**
 * Remove the rows that describe an account, then the account.
 *
 * Only ever called once userHistory has come back empty, so nothing here can
 * discard a punch or a payment - these are the setup rows, plus the two kinds
 * of record that are meaningless without the person they were about.
 *
 * Every one is a required relation with no onDelete, which Prisma defaults to
 * Restrict, so each has to be cleared explicitly or Postgres refuses the
 * delete. That is a feature: adding a new table that references User will break
 * this loudly rather than silently orphaning rows.
 */
export async function deleteUserAndSetup(db: PrismaClient, userId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    await tx.pushSubscription.deleteMany({ where: { user_id: userId } });
    await tx.scheduleOverride.deleteMany({ where: { user_id: userId } });
    await tx.schedule.deleteMany({ where: { user_id: userId } });
    await tx.leaveRequest.deleteMany({ where: { user_id: userId } });
    await tx.rateChange.deleteMany({ where: { user_id: userId } });
    // Flag.user_id is nullable, so this would survive as an orphan rather than
    // block. A flag naming nobody is worse than no flag.
    await tx.flag.deleteMany({ where: { user_id: userId } });
    await tx.user.delete({ where: { id: userId } });
  });
}
