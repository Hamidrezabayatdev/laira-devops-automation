import { getLivenessStatus } from '@/lib/db/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const status = getLivenessStatus();
  return Response.json(status, { status: 200 });
}
