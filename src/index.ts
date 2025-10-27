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
    return new Response('Method not allowed', { status: 405 });
  }

  let payload: DeviceUpdate;
  try {
    payload = (await request.json()) as DeviceUpdate;
  } catch {
    console.error('[Worker] Invalid JSON received');
    return new Response('Invalid JSON', { status: 400 });
  }

  const { deviceId, status } = payload;

  if (!deviceId || !status) {
    console.error('[Worker] Missing deviceId or status');
    return new Response('Missing deviceId or status', { status: 400 });
  }

  if (!['home', 'away'].includes(status)) {
    console.error(`[Worker] Invalid status: ${status}`);
    return new Response('Invalid status', { status: 400 });
  }

  const validDevices = env.VALID_DEVICE_IDS.split(',').map((d) => d.trim());
  if (!validDevices.includes(deviceId)) {
    console.warn(`[Worker] Unknown device: ${deviceId}`);
    return new Response('Unknown device', { status: 403 });
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
      const tado = new TadoClient(env.TADO_HOME_ID, env.KV);

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
      return new Response(
        JSON.stringify({
          success: false,
          error: errorMsg,
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      );
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
  const deviceStatuses: Record<string, string> = {};

  for (const item of devices.keys) {
    const status = await env.KV.get(item.name);
    const deviceId = item.name.replace('device:', '');
    const anonymizedId = deviceId.slice(0, 2) + '...';
    deviceStatuses[anonymizedId] = status || 'unknown';
  }

  const tadoPresence =
    (await env.KV.get('tado:presence')) || 'unknown';

  console.log(`[Worker] Status: devices=${Object.keys(deviceStatuses).length}, tadoPresence=${tadoPresence}`);

  return new Response(
    JSON.stringify({
      devices: deviceStatuses,
      tadoPresence,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
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
