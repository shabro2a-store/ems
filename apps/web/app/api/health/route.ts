import { NextResponse } from 'next/server';

const STARTED_AT = Date.now();
const VERSION = process.env.npm_package_version ?? '0.0.1';

export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    ok: true,
    data: {
      uptime_s: Math.floor((Date.now() - STARTED_AT) / 1000),
      version: VERSION,
    },
  });
}
