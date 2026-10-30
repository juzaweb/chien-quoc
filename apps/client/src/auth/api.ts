/**
 * Account API client.
 *
 * The token is kept in `localStorage` so a refresh keeps the session, and it is
 * also handed to the Colyseus client (`client.auth.token`), which appends it to
 * the room connection as `_authToken` for `WorldRoom.onAuth` to verify.
 */

import { ErrorCode } from '@colyseus/sdk';

export interface AuthUser {
  id: string;
  username: string;
  displayName: string;
}

export interface AuthResponse {
  user: AuthUser;
  token: string;
}

const TOKEN_STORAGE_KEY = 'cq_auth_token';

/** Server base URL (`:2567`) resolved from the current page host. */
export function getServerUrl(): string {
  const protocol = window.location.protocol === 'https:' ? 'https:' : 'http:';
  return `${protocol}//${window.location.hostname}:2567`;
}

export function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_STORAGE_KEY);
  } catch {
    return null;
  }
}

export function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_STORAGE_KEY, token);
  } catch {
    // Private-mode storage failures are non-fatal: the session just won't persist.
  }
}

export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // Ignore.
  }
}

/** Extracts a human-readable message from a non-2xx response. */
async function readError(response: Response): Promise<string> {
  try {
    const body = await response.json();
    if (body && typeof body.error === 'string') return body.error;
  } catch {
    // Fall through to the generic message.
  }
  return 'Không thể kết nối đến máy chủ. Vui lòng thử lại.';
}

async function postAuth(path: string, body: Record<string, string>): Promise<AuthResponse> {
  let response: Response;
  try {
    response = await fetch(`${getServerUrl()}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
  } catch {
    throw new Error('Không thể kết nối đến máy chủ game. Hãy kiểm tra server đã chạy ở cổng 2567!');
  }

  if (!response.ok) {
    throw new Error(await readError(response));
  }

  const data = (await response.json()) as AuthResponse;
  storeToken(data.token);
  return data;
}

export function register(input: {
  username: string;
  displayName: string;
  password: string;
}): Promise<AuthResponse> {
  return postAuth('/auth/register', input);
}

export function login(input: { username: string; password: string }): Promise<AuthResponse> {
  return postAuth('/auth/login', input);
}

/**
 * Whether a failed room join was rejected by the server's auth check, meaning
 * the stored token is dead and the player must sign in again.
 *
 * Keyed on the matchmaking error code rather than the message text, so a
 * wording change on the server cannot silently break the logout flow.
 */
export function isAuthRejection(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === ErrorCode.AUTH_FAILED
  );
}

/**
 * Restores the session for a stored token. Returns `null` when the token is
 * missing, expired, or the server is unreachable.
 */
export async function fetchCurrentUser(): Promise<AuthUser | null> {
  const token = getStoredToken();
  if (!token) return null;

  try {
    const response = await fetch(`${getServerUrl()}/auth/me`, {
      headers: { authorization: `Bearer ${token}` }
    });
    if (!response.ok) {
      clearStoredToken();
      return null;
    }
    const data = (await response.json()) as { user: AuthUser };
    return data.user;
  } catch {
    // Keep the token: the server may just be temporarily down.
    return null;
  }
}
