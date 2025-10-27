const TADO_CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
const TADO_API_URL = 'https://login.tado.com/oauth2/token';
const DEVICE_CODE_URL = 'https://login.tado.com/oauth2/device_authorize';

async function getDeviceCode() {
  const params = new URLSearchParams({
    client_id: TADO_CLIENT_ID,
    scope: 'offline_access',
  });

  const response = await fetch(`${DEVICE_CODE_URL}?${params}`, {
    method: 'POST',
  });

  if (!response.ok) {
    throw new Error(`Failed to get device code: ${response.statusText}`);
  }

  return response.json();
}

async function pollForToken(deviceCode, interval, timeout) {
  const startTime = Date.now();

  while (Date.now() - startTime < timeout * 1000) {
    await new Promise((resolve) => setTimeout(resolve, interval * 1000));

    const response = await fetch(TADO_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: TADO_CLIENT_ID,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceCode,
      }).toString(),
    });

    const data = await response.json();

    if (data.access_token) {
      return {
        access_token: data.access_token,
        refresh_token: data.refresh_token || '',
      };
    }

    if (data.error && data.error !== 'authorization_pending') {
      throw new Error(`OAuth error: ${data.error}`);
    }
  }

  throw new Error('Device code expired, please try again');
}

async function getHomeId(accessToken) {
  const response = await fetch('https://my.tado.com/api/v2/me', {
    headers: {
      'Authorization': `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to get home ID: ${response.statusText}`);
  }

  const data = await response.json();
  return data.homes[0].id.toString();
}

async function main() {
  console.log('Starting Tado OAuth authentication...\n');

  try {
    const deviceCodeData = await getDeviceCode();
    console.log(`📱 Please visit this link to authenticate:\n${deviceCodeData.verification_uri_complete}\n`);
    console.log('Waiting for you to authenticate...');

    const token = await pollForToken(
      deviceCodeData.device_code,
      deviceCodeData.interval,
      deviceCodeData.expires_in
    );

    console.log('\n✓ Authenticated! Fetching home ID...');
    const homeId = await getHomeId(token.access_token);

    console.log('\n✓ Success!\n');
    console.log('Now configure your Cloudflare Worker:\n');
    console.log('1. Add home ID as a secret:');
    console.log('   npx wrangler secret put TADO_HOME_ID');
    console.log(`   ${homeId}\n`);
    console.log('2. Store refresh token in KV:');
    console.log('   npm run kv:set-refresh-token');
    console.log(`   (then paste): ${token.refresh_token}\n`);
  } catch (error) {
    console.error('Authentication failed:', error);
    process.exit(1);
  }
}

main();
