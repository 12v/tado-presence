export type Presence = 'HOME' | 'AWAY';

interface TadoErrorResponse {
  errors?: Array<{ code: string; title: string }>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const TADO_CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
const TOKEN_ENDPOINT = 'https://login.tado.com/oauth2/token';

export class TadoClient {
  private accessToken: string;
  private homeId: string;
  private refreshToken: string;
  private kv: KVNamespace;

  constructor(
    accessToken: string,
    homeId: string,
    refreshToken: string,
    kv: KVNamespace
  ) {
    this.accessToken = accessToken;
    this.homeId = homeId;
    this.refreshToken = refreshToken;
    this.kv = kv;
  }

  private async refreshAccessToken(): Promise<void> {
    console.log('[TadoClient] Refreshing access token');

    const response = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: TADO_CLIENT_ID,
        grant_type: 'refresh_token',
        refresh_token: this.refreshToken,
      }).toString(),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error(`[TadoClient] Token refresh failed: ${response.status} ${response.statusText}`);
      throw new Error(`Failed to refresh token: ${response.statusText}`);
    }

    const data = (await response.json()) as TokenResponse;
    this.accessToken = data.access_token;
    await this.kv.put('tado:access_token', data.access_token);

    // Handle refresh token rotation - new token is issued with each refresh
    if (data.refresh_token) {
      this.refreshToken = data.refresh_token;
      await this.kv.put('tado:refresh_token', data.refresh_token);
      console.log('[TadoClient] Refresh token rotated and cached');
    }

    console.log('[TadoClient] Access token refreshed and cached');
  }

  async setPresence(presence: Presence): Promise<void> {
    console.log(`[TadoClient] Setting presence to ${presence}`);
    const response = await fetch(
      `https://my.tado.com/api/v2/homes/${this.homeId}/presenceLock`,
      {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          homePresence: presence,
        }),
      }
    );

    if (response.status === 401) {
      console.log('[TadoClient] Got 401, attempting token refresh and retry');
      await this.refreshAccessToken();
      const retryResponse = await fetch(
        `https://my.tado.com/api/v2/homes/${this.homeId}/presenceLock`,
        {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            homePresence: presence,
          }),
        }
      );

      if (!retryResponse.ok) {
        const error = (await retryResponse.json()) as TadoErrorResponse;
        console.error(`[TadoClient] Retry failed: ${retryResponse.status}`);
        throw new Error(
          `Tado API error: ${retryResponse.status} - ${error.errors?.[0]?.title || 'Unknown error'}`
        );
      }
      console.log('[TadoClient] Presence set successfully after token refresh');
      return;
    }

    if (!response.ok) {
      const error = (await response.json()) as TadoErrorResponse;
      console.error(`[TadoClient] setPresence failed: ${response.status}`);
      throw new Error(
        `Tado API error: ${response.status} - ${error.errors?.[0]?.title || 'Unknown error'}`
      );
    }

    console.log('[TadoClient] Presence set successfully');
  }

  async getPresence(): Promise<Presence> {
    console.log('[TadoClient] Fetching current presence');
    const response = await fetch(
      `https://my.tado.com/api/v2/homes/${this.homeId}/state`,
      {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      }
    );

    if (response.status === 401) {
      console.log('[TadoClient] Got 401, attempting token refresh and retry');
      await this.refreshAccessToken();
      const retryResponse = await fetch(
        `https://my.tado.com/api/v2/homes/${this.homeId}/state`,
        {
          headers: {
            'Authorization': `Bearer ${this.accessToken}`,
          },
        }
      );

      if (!retryResponse.ok) {
        console.error(`[TadoClient] Retry failed: ${retryResponse.status}`);
        throw new Error(`Tado API error: ${retryResponse.status}`);
      }

      const data = (await retryResponse.json()) as any;
      console.log(`[TadoClient] Current presence: ${data.presence}`);
      return data.presence;
    }

    if (!response.ok) {
      console.error(`[TadoClient] getPresence failed: ${response.status}`);
      throw new Error(`Tado API error: ${response.status}`);
    }

    const data = (await response.json()) as any;
    console.log(`[TadoClient] Current presence: ${data.presence}`);
    return data.presence;
  }
}
