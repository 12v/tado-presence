export type Presence = 'HOME' | 'AWAY';

interface TadoErrorResponse {
  errors?: Array<{ code: string; title: string }>;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

export type RecordStatFn = (stat: 'api_call' | 'token_refresh') => Promise<void>;

const TADO_CLIENT_ID = '1bb50063-6b0c-4d11-bd99-387f4a91cc46';
const TOKEN_ENDPOINT = 'https://login.tado.com/oauth2/token';

function isTransientError(error: any): boolean {
  // Network errors
  if (error instanceof TypeError && error.message.includes('fetch')) {
    return true;
  }
  // 5xx server errors and rate limiting
  if (typeof error === 'object' && 'status' in error) {
    const status = error.status;
    return status >= 500 || status === 429;
  }
  return false;
}

async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  maxRetries: number = 3
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !isTransientError(error)) {
        throw error;
      }
      const delayMs = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s
      console.log(`[TadoClient] Transient error, retrying in ${delayMs}ms (attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  throw lastError;
}

export class TadoClient {
  constructor(
    private homeId: string,
    private kv: KVNamespace,
    private recordStat: RecordStatFn
  ) { }

  private async refreshAccessToken(): Promise<string> {
    console.log('[TadoClient] Refreshing access token');

    const doRefresh = async () => {
      const refreshToken = await this.kv.get('tado:refresh_token');
      if (!refreshToken) {
        throw new Error('Refresh token not found in KV. Initialize with: wrangler kv:key put tado:refresh_token <token>');
      }

      const response = await fetch(TOKEN_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          client_id: TADO_CLIENT_ID,
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
        }).toString(),
      });

      if (!response.ok) {
        if (response.status >= 500 || response.status === 429) {
          const error = new Error(`HTTP ${response.status}`);
          (error as any).status = response.status;
          throw error;
        }
        console.error(`[TadoClient] Token refresh failed: ${response.status} ${response.statusText}`);
        throw new Error(`Failed to refresh token: ${response.statusText}`);
      }

      return response;
    };

    const response = await retryWithBackoff(doRefresh);
    const data = (await response.json()) as TokenResponse;
    await this.kv.put('tado:access_token', data.access_token);

    // Handle refresh token rotation - new token is issued with each refresh
    if (data.refresh_token) {
      await this.kv.put('tado:refresh_token', data.refresh_token);
      console.log('[TadoClient] Refresh token rotated and cached');
    }

    await this.recordStat('token_refresh');

    console.log('[TadoClient] Access token refreshed and cached');
    return data.access_token;
  }

  private async makeRequest(
    url: string,
    accessToken: string,
    body: string
  ): Promise<Response> {
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body,
    });

    if (!response.ok && (response.status >= 500 || response.status === 429)) {
      const error = new Error(`HTTP ${response.status}`);
      (error as any).status = response.status;
      throw error;
    }

    return response;
  }

  async setPresence(presence: Presence): Promise<void> {
    console.log(`[TadoClient] Setting presence to ${presence}`);
    const url = `https://my.tado.com/api/v2/homes/${this.homeId}/presenceLock`;
    const body = JSON.stringify({ homePresence: presence });

    const makeRequestWithRetry = async () => {
      let accessToken = await this.kv.get('tado:access_token') || 'INVALID';
      let response = await this.makeRequest(url, accessToken, body);

      if (response.status === 401) {
        console.log('[TadoClient] Got 401, attempting token refresh and retry');
        accessToken = await this.refreshAccessToken();
        response = await this.makeRequest(url, accessToken, body);

        if (!response.ok) {
          const error = (await response.json()) as TadoErrorResponse;
          console.error(`[TadoClient] Retry failed: ${response.status}`);
          throw new Error(
            `Tado API error: ${response.status} - ${error.errors?.[0]?.title || 'Unknown error'}`
          );
        }
      } else if (!response.ok) {
        const error = (await response.json()) as TadoErrorResponse;
        console.error(`[TadoClient] Request failed: ${response.status}`);
        throw new Error(
          `Tado API error: ${response.status} - ${error.errors?.[0]?.title || 'Unknown error'}`
        );
      }

      return response;
    };

    await retryWithBackoff(makeRequestWithRetry);
    await this.recordStat('api_call');

    console.log('[TadoClient] Presence set successfully');
  }

}
