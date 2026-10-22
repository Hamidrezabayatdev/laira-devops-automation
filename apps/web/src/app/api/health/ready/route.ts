import { getReadinessStatus } from '@/lib/db/health';

export const dynamic = 'force-dynamic';

export async function GET() {
  const readiness = await getReadinessStatus();
  const statusCode = readiness.status === 'ready' ? 200 : 503;
  return Response.json(readiness, { status: statusCode });
}
