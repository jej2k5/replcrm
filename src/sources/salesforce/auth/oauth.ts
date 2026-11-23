import type { OAuthTokens } from "./token-store.js";

interface OAuthClient {
  loginUrl: string;
  clientId: string;
}

export class OAuthSignInRequiredError extends Error {}

interface TokenRequest extends OAuthClient {
  clientSecret?: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

interface AuthorizationRequest extends OAuthClient {
  redirectUri: string;
  challenge: string;
  state: string;
}

export function buildAuthorizationUrl(options: AuthorizationRequest): URL {
  const url = new URL("/services/oauth2/authorize", options.loginUrl);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: options.clientId,
    redirect_uri: options.redirectUri,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    state: options.state,
    scope: "api refresh_token",
  }).toString();
  return url;
}

export function exchangeCode(
  options: TokenRequest & { code: string; verifier: string; redirectUri: string },
): Promise<OAuthTokens> {
  return requestTokens(options, new URLSearchParams({
    grant_type: "authorization_code",
    code: options.code,
    code_verifier: options.verifier,
    redirect_uri: options.redirectUri,
  }));
}

export function refreshAccessToken(
  options: TokenRequest & { refreshToken: string },
): Promise<OAuthTokens> {
  const form = new URLSearchParams();
  form.set("grant_type", "refresh_token");
  form.set("refresh_token", options.refreshToken);
  return requestTokens(options, form, options.refreshToken);
}

async function requestTokens(
  options: TokenRequest,
  form: URLSearchParams,
  previousRefreshToken?: string,
): Promise<OAuthTokens> {
  form.set("client_id", options.clientId);
  if (options.clientSecret !== undefined) form.set("client_secret", options.clientSecret);

  let response: Response;
  let body: Record<string, unknown>;
  try {
    const endpoint = new URL("/services/oauth2/token", options.loginUrl);
    response = await (options.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      body: form,
      redirect: "error",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const payload: unknown = await response.json();
    body = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : {};
  } catch {
    throw new Error("Salesforce OAuth token request failed.");
  }

  if (body.error === "invalid_grant") {
    throw new OAuthSignInRequiredError("Salesforce rejected the OAuth grant. Run auth login again.");
  }
  if (!response.ok) throw new Error("Salesforce OAuth token request failed.");

  const accessToken = body.access_token;
  const refreshToken = body.refresh_token === undefined ? previousRefreshToken : body.refresh_token;
  const instanceUrl = body.instance_url;
  const issuedAt = body.issued_at;
  if (
    typeof accessToken !== "string" || !accessToken ||
    typeof refreshToken !== "string" || !refreshToken ||
    typeof instanceUrl !== "string" || !instanceUrl ||
    typeof issuedAt !== "string" || !issuedAt
  ) {
    throw new Error("Salesforce OAuth response is missing required token fields.");
  }
  return { loginUrl: options.loginUrl, clientId: options.clientId, instanceUrl, accessToken, refreshToken, issuedAt };
}
