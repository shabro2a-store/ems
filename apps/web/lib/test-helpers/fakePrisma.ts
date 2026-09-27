import type { PrismaClient } from '@prisma/client';

/*
 * An in-memory stand-in for the Prisma client, for tests of services that
 * query the database: every model is an array, and `where` is honoured for
 * equality, null, ranges (gte/gt/lt/lte), `in`, OR and AND - enough for the
 * questions these services ask, so a test can hold the real query to account
 * instead of mocking its answer.
 */
export type Row = Record<string, unknown> & { id: string };
export type Where = Record<string, unknown>;

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Where[]).some((w) => matches(row, w));
    if (key === 'AND') return (cond as Where[]).every((w) => matches(row, w));
    const value = row[key];
    if (cond === null || typeof cond !== 'object' || cond instanceof Date) {
      return cond instanceof Date ? value instanceof Date && value.getTime() === cond.getTime() : value === cond;
    }
    // A compound unique key (user_id_date: { user_id, date }) or a nested
    // filter is just more fields to match.
    if (!Object.keys(cond).some((k) => ['gte', 'gt', 'lt', 'lte', 'in'].includes(k))) {
      return matches(row, cond as Where);
    }
    const c = cond as { gte?: Date; gt?: Date; lt?: Date; lte?: Date; in?: unknown[] };
    if (c.in) return c.in.includes(value);
    if (value === null || value === undefined) return false;
    const v = (value as Date).getTime();
    return (
      (c.gte === undefined || v >= c.gte.getTime()) &&
      (c.gt === undefined || v > c.gt.getTime()) &&
      (c.lt === undefined || v < c.lt.getTime()) &&
      (c.lte === undefined || v <= c.lte.getTime())
    );
  });
}

export function fakeDb(tables: Record<string, Row[]>): PrismaClient {
  const model = (name: string) => {
    const rows = (tables[name] ??= []);
    return {
      findMany: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)),
      findUnique: async ({ where }: { where: Where }) => rows.find((r) => matches(r, where)) ?? null,
      findFirst: async ({ where }: { where?: Where } = {}) => rows.find((r) => matches(r, where)) ?? null,
      aggregate: async ({ where }: { where?: Where }) => ({
        _sum: { amount_cent: rows.filter((r) => matches(r, where)).reduce((s, r) => s + (r.amount_cent as number), 0) || null },
      }),
      count: async ({ where }: { where?: Where } = {}) => rows.filter((r) => matches(r, where)).length,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `${name}${rows.length + 1}`, created_at: new Date(), ...data } as Row;
        rows.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Where; data: Record<string, unknown> }) => {
        const hit = rows.find((r) => matches(r, where));
        if (!hit) throw new Error(`${name}.update: no row matches`);
        return Object.assign(hit, data);
      },
      upsert: async ({ where, create, update }: { where: Where; create: Record<string, unknown>; update: Record<string, unknown> }) => {
        const hit = rows.find((r) => matches(r, where));
        if (hit) return Object.assign(hit, update);
        const row = { id: `${name}${rows.length + 1}`, ...create } as Row;
        rows.push(row);
        return row;
      },
      updateMany: async ({ where, data }: { where: Where; data: Row }) => {
        const hit = rows.filter((r) => matches(r, where));
        hit.forEach((r) => Object.assign(r, data));
        return { count: hit.length };
      },
    };
  };
  const client: PrismaClient = new Proxy(
    {},
    { get: (_t, k: string) => (k === '$transaction' ? (fn: (tx: PrismaClient) => unknown) => fn(client) : model(k)) },
  ) as unknown as PrismaClient;
  return client;
}

