import { Prisma, type PrismaClient } from '@prisma/client';
import { prisma } from '../db/prisma';

export interface AuditWriteInput {
  actorId: string;
  action: string;
  entity: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  // Widened from PrismaClient so a caller inside prisma.$transaction can pass
  // its tx: a destructive change and the record of it must commit together, or
  // roll back together. Prisma's transaction client is not a PrismaClient.
  db?: Pick<PrismaClient, 'auditLog'>;
}

function toJsonValue(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
  if (v === null) return Prisma.JsonNull;
  return v as Prisma.InputJsonValue;
}

export async function writeAuditLog(input: AuditWriteInput) {
  const db = input.db ?? prisma;
  return db.auditLog.create({
    data: {
      actor_id: input.actorId,
      action: input.action,
      entity: input.entity,
      entity_id: input.entityId,
      ...(input.before !== undefined ? { before_json: toJsonValue(input.before) } : {}),
      ...(input.after !== undefined ? { after_json: toJsonValue(input.after) } : {}),
    },
  });
}