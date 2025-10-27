import { TadoClient, type Presence } from './tado';

interface Env {
  KV: KVNamespace;
  TADO_HOME_ID: string;
  VALID_DEVICE_IDS: string;
}

interface DeviceUpdate {
  deviceId: string;
  status: 'home' | 'away';
}

interface Stats {
  apiCalls: { last24h: number; last7d: number };
  tokenRefreshes: { last24h: number; last7d: number };
  errors: { last24h: number; last7d: number };
}

const TTL_7_DAYS = 604800;

function extractTimestamp(key: string, prefix: string): number {
  return parseInt(key.replace(prefix, ''));
}

function countStatsInWindow(keys: Array<{ name: string }>, prefix: string, minTimestamp: number): number {
  return keys.filter((key) => extractTimestamp(key.name, prefix) >= minTimestamp).length;
}

async function recordApiCall(kv: KVNamespace): Promise<void> {
  const timestamp = Date.now();
  await kv.put(`stats:api_call:${timestamp}`, '1', { expirationTtl: TTL_7_DAYS });
}

async function recordTokenRefresh(kv: KVNamespace): Promise<void> {
  const timestamp = Date.now();
  await kv.put(`stats:token_refresh:${timestamp}`, '1', { expirationTtl: TTL_7_DAYS });
}

async function recordError(kv: KVNamespace): Promise<void> {
  const timestamp = Date.now();
  await kv.put(`stats:error:${timestamp}`, '1', { expirationTtl: TTL_7_DAYS });
}

async function getStats(kv: KVNamespace): Promise<Stats> {
  const now = Date.now();
  const last24h = now - 86400000;
  const last7d = now - 604800000;

  const apiCalls = await kv.list({ prefix: 'stats:api_call:' });
  const tokenRefreshes = await kv.list({ prefix: 'stats:token_refresh:' });
  const errors = await kv.list({ prefix: 'stats:error:' });

  return {
    apiCalls: {
      last24h: countStatsInWindow(apiCalls.keys, 'stats:api_call:', last24h),
      last7d: countStatsInWindow(apiCalls.keys, 'stats:api_call:', last7d),
    },
    tokenRefreshes: {
      last24h: countStatsInWindow(tokenRefreshes.keys, 'stats:token_refresh:', last24h),
      last7d: countStatsInWindow(tokenRefreshes.keys, 'stats:token_refresh:', last7d),
    },
    errors: {
      last24h: countStatsInWindow(errors.keys, 'stats:error:', last24h),
      last7d: countStatsInWindow(errors.keys, 'stats:error:', last7d),
    },
  };
}

function errorResponse(message: string, statusCode: number = 400): Response {
  return new Response(
    JSON.stringify({ success: false, error: message }),
    { status: statusCode, headers: { 'Content-Type': 'application/json' } }
  );
}

async function getOverallPresence(kv: KVNamespace): Promise<Presence> {
  const devices = await kv.list({ prefix: 'device:' });

  const statuses = await Promise.all(
    devices.keys.map((item) => kv.get(item.name))
  );

  return statuses.includes('home') ? 'HOME' : 'AWAY';
}

async function handleDeviceUpdate(
  request: Request,
  env: Env
): Promise<Response> {
  if (request.method !== 'POST') {
    return errorResponse('Method not allowed', 405);
  }

  let payload: DeviceUpdate;
  try {
    payload = (await request.json()) as DeviceUpdate;
  } catch {
    console.error('[Worker] Invalid JSON received');
    return errorResponse('Invalid JSON', 400);
  }

  const { deviceId, status } = payload;

  if (!deviceId || !status) {
    console.error('[Worker] Missing deviceId or status');
    return errorResponse('Missing deviceId or status', 400);
  }

  if (!['home', 'away'].includes(status)) {
    console.error(`[Worker] Invalid status: ${status}`);
    return errorResponse('Invalid status', 400);
  }

  const validDevices = env.VALID_DEVICE_IDS.split(',').map((d) => d.trim());
  if (!validDevices.includes(deviceId)) {
    console.warn(`[Worker] Unknown device: ${deviceId}`);
    return errorResponse('Unknown device', 403);
  }

  console.log(`[Worker] Device update received: ${deviceId} -> ${status}`);

  // Store device status
  await env.KV.put(`device:${deviceId}`, status);
  console.log(`[Worker] Stored device status in KV`);

  // Get overall presence
  const overallPresence = await getOverallPresence(env.KV);
  console.log(`[Worker] Overall presence: ${overallPresence}`);

  // Get cached Tado presence
  const cachedPresence = (await env.KV.get('tado:presence')) as Presence | null;

  // Only update if presence changed
  if (cachedPresence !== overallPresence) {
    console.log(`[Worker] Presence changed: ${cachedPresence} -> ${overallPresence}`);
    try {
      const recordStat = async (stat: 'api_call' | 'token_refresh') => {
        if (stat === 'api_call') {
          await recordApiCall(env.KV);
        } else {
          await recordTokenRefresh(env.KV);
        }
      };

      const tado = new TadoClient(env.TADO_HOME_ID, env.KV, recordStat);

      await tado.setPresence(overallPresence);
      await env.KV.put('tado:presence', overallPresence);
      console.log(`[Worker] Successfully updated Tado presence`);
      return new Response(
        JSON.stringify({
          success: true,
          message: `Presence updated to ${overallPresence}`,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[Worker] Failed to update presence: ${errorMsg}`);
      await recordError(env.KV);
      return errorResponse(errorMsg, 500);
    }
  }

  console.log(`[Worker] No presence change needed`);
  return new Response(
    JSON.stringify({
      success: true,
      message: 'Device status updated, no Tado API call needed',
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } }
  );
}

async function handleStatus(env: Env): Promise<Response> {
  console.log('[Worker] Status request received');
  const devices = await env.KV.list({ prefix: 'device:' });

  const statuses = await Promise.all(
    devices.keys.map((item) =>
      env.KV.get(item.name).then((status) => ({
        key: item.name,
        status: status || 'unknown',
      }))
    )
  );

  const deviceStatuses: Record<string, string> = {};
  for (const { key, status } of statuses) {
    const deviceId = key.replace('device:', '');
    const anonymizedId = deviceId.slice(0, 2) + '...';
    deviceStatuses[anonymizedId] = status;
  }

  const tadoPresence =
    (await env.KV.get('tado:presence')) || 'unknown';

  const stats = await getStats(env.KV);

  console.log(`[Worker] Status: devices=${Object.keys(deviceStatuses).length}, tadoPresence=${tadoPresence}`);

  return new Response(
    JSON.stringify({
      devices: deviceStatuses,
      tadoPresence,
      stats,
      timestamp: Date.now(),
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    }
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/device') {
      return handleDeviceUpdate(request, env);
    }

    if (url.pathname === '/status' && request.method === 'GET') {
      return handleStatus(env);
    }

    return new Response('Not found', { status: 404 });
  },
};
