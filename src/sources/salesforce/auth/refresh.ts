import { OAuthSignInRequiredError, refreshAccessToken } from "./oauth.js";
import type { OAuthTokens, TokenStore } from "./token-store.js";

interface RefreshOptions {
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  fetch?: typeof globalThis.fetch | undefined;
}

export function createStoredRefresh(
  store: TokenStore,
  deploymentId: string,
  options: RefreshOptions,
): (failedAccessToken: string) => Promise<OAuthTokens> {
  return async (failedAccessToken) => (await refreshStoredSignIn(store, deploymentId, options, failedAccessToken)).tokens;
}

// Call with the refresh lock held. Omitting the failed token forces a refresh.
export async function refreshStoredSignIn(
  store: TokenStore,
  deploymentId: string,
  options: RefreshOptions,
  failedAccessToken?: string,
): Promise<{ tokens: OAuthTokens; rotated: boolean }> {
  const saved = await store.load(deploymentId);
  if (!saved) throw new OAuthSignInRequiredError("No stored Salesforce OAuth sign-in. Run auth login again.");
  if (failedAccessToken !== undefined && saved.accessToken !== failedAccessToken) {
    return { tokens: saved, rotated: false };
  }
  const { clientId = saved.clientId, clientSecret, fetch } = options;
  const tokens = await refreshAccessToken({
    loginUrl: saved.loginUrl, refreshToken: saved.refreshToken, clientId,
    ...(clientSecret ? { clientSecret } : {}),
    ...(fetch ? { fetch } : {}),
  });
  await store.save(deploymentId, tokens);
  return { tokens, rotated: tokens.refreshToken !== saved.refreshToken };
}
