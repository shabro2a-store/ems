import { NextResponse } from 'next/server';
import { databaseAnswers } from '@/lib/services/dbPing';

const STARTED_AT = Date.now();
const VERSION = process.env.npm_package_version ?? '0.0.1';

export const dynamic = 'force-dynamic';

// What the container healthcheck reads. It runs a real query: a web container
// that has lost its database serves nothing useful, and must not look healthy.
export async function GET() {
  if (!(await databaseAnswers())) {
    return NextResponse.json(
      { ok: false, error: { code: 'DB_UNREACHABLE', message: 'Database unreachable' } },
      { status: 503 },
    );
  }
  return NextResponse.json({
    ok: true,
    data: {
      uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
      version: VERSION,
    },
  });
}
