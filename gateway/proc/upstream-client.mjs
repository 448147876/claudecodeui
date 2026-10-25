// Calls a child process's public upstream API. Only endpoints listed in
// mydocs/03 C-5 are used; the gateway never reads a child's database.

async function request(port, method, urlPath, { token, body, timeoutMs = 10_000 } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // Non-JSON body; callers only look at the status then.
  }
  return { status: response.status, json };
}

export const upstreamClient = {
  async status(port) {
    return request(port, 'GET', '/api/auth/status', { timeoutMs: 2_000 });
  },

  /** Registers the internal user on a fresh child, or logs it in. Returns a token. */
  async obtainToken(port, username, password) {
    const status = await this.status(port);
    if (status.json?.needsSetup) {
      const registered = await request(port, 'POST', '/api/auth/register', { body: { username, password } });
      if (registered.status === 200 && registered.json?.token) return registered.json.token;
      throw new Error(`register failed (${registered.status})`);
    }
    const login = await request(port, 'POST', '/api/auth/login', { body: { username, password } });
    if (login.status === 200 && login.json?.token) return login.json.token;
    const error = new Error(`internal user login failed (${login.status})`);
    error.code = 'INTERNAL_USER_MISMATCH';
    throw error;
  },

  /**
   * Marks first-run onboarding done. Members skip it: its git step writes the
   * global git config, which members may not change (member-policy.mjs).
   */
  async completeOnboarding(port, token) {
    const result = await request(port, 'POST', '/api/user/complete-onboarding', { token });
    if (result.status !== 200) throw new Error(`complete-onboarding failed (${result.status})`);
  },

  /** Number of running provider sessions, or null when it cannot be told. */
  async runningSessionCount(port, token) {
    const result = await request(port, 'GET', '/api/providers/sessions/running', { token });
    const sessions = result.json?.data?.sessions;
    return result.status === 200 && Array.isArray(sessions) ? sessions.length : null;
  },

  /** Number of pending scheduled messages, or null when it cannot be told. */
  async pendingScheduledCount(port, token) {
    const result = await request(port, 'GET', '/api/scheduled-messages', { token });
    const items = result.json?.data;
    return result.status === 200 && Array.isArray(items) ? items.length : null;
  },
};

/** Reads `exp` (seconds) from a JWT without verifying it. */
export function tokenExpiresAt(token) {
  try {
    const payload = JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}
