// Server-only. Never import this module into a browser bundle.
function exactOrigin(value, allowLocalhost) {
  const url = new URL(value);
  const local =
    allowLocalhost &&
    process.env.NODE_ENV !== 'production' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    url.origin !== value ||
    url.username ||
    url.password ||
    (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
  ) {
    throw new Error(
      'Configure an exact HTTPS origin; development localhost requires allowLocalhost',
    );
  }
  return value;
}
const json = (status, body) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    },
  });

/** One trusted authentication adapter, reused by every page containing the public embed. */
export function createRelaySessionHandler(options) {
  const relayOrigin = exactOrigin(options.relayOrigin, options.allowLocalhost);
  const widgetOrigin = exactOrigin(
    options.widgetOrigin ?? options.relayOrigin,
    options.allowLocalhost,
  );
  const applicationOrigin = exactOrigin(options.applicationOrigin, options.allowLocalhost);
  if (
    !options.deploymentId ||
    !options.integrationKey ||
    typeof options.getSession !== 'function'
  ) {
    throw new Error('Server deployment ID, integration key, and getSession adapter are required');
  }
  const fetcher = options.fetch ?? globalThis.fetch;
  async function revoke(session) {
    try {
      await fetcher(`${relayOrigin}/v1/widget/revoke`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
        headers: { authorization: `Bearer ${session.token}`, 'x-host-origin': applicationOrigin },
      });
    } catch {
      /* Expiry remains the fallback if CornerstoneLabs AO cannot be reached. */
    }
  }
  return async function handleSession(request) {
    if (request.method !== 'POST') return json(405, { error: 'Use POST' });
    if (request.headers.get('origin') !== applicationOrigin)
      return json(403, { error: 'Invalid application origin' });
    if (!request.headers.get('content-type')?.startsWith('application/json'))
      return json(415, { error: 'Use application/json' });
    let body;
    try {
      const reader = request.body?.getReader();
      const chunks = [];
      let size = 0;
      if (reader)
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2048) {
            await reader.cancel();
            return json(413, { error: 'Request too large' });
          }
          chunks.push(value);
        }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      body = JSON.parse(new TextDecoder().decode(bytes) || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return json(400, { error: 'Invalid request' });
      if (body.deploymentId !== undefined && body.deploymentId !== options.deploymentId)
        return json(403, { error: 'Deployment is not connected to this application' });
    } catch {
      return json(400, { error: 'Invalid JSON' });
    }
    let issued;
    try {
      // Browser identity, credentials, and toolIds are never used as authentication.
      const session = await options.getSession(request);
      if (
        !session ||
        !session.userId ||
        !session.apiToken ||
        typeof session.isActive !== 'function' ||
        !Number.isFinite(Date.parse(session.expiresAt)) ||
        Date.parse(session.expiresAt) <= Date.now() + 5000 ||
        !(await session.isActive())
      )
        return json(401, { error: 'Sign in to use the assistant' });
      const policy =
        session.toolIds === undefined ? { useDeploymentTools: true } : { toolIds: session.toolIds };
      const result = await fetcher(`${relayOrigin}/v1/widget-sessions`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]),
        headers: {
          authorization: `Bearer ${options.integrationKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          deploymentId: options.deploymentId,
          userId: session.userId,
          ...(session.tenantId ? { tenantId: session.tenantId } : {}),
          ...(session.employeeId ? { employeeId: session.employeeId } : {}),
          origin: applicationOrigin,
          apiToken: session.apiToken,
          apiTokenExpiresAt: session.expiresAt,
          ...policy,
        }),
      });
      if (!result.ok)
        return json(502, {
          error: 'Assistant connection failed; check the server connector and deployment settings',
        });
      const raw = await result.text();
      if (raw.length > 16000) return json(502, { error: 'Invalid assistant response' });
      const data = JSON.parse(raw);
      if (
        typeof data.token !== 'string' ||
        !/^[a-zA-Z0-9_-]{43}$/.test(data.token) ||
        data.deploymentId !== options.deploymentId ||
        data.widgetOrigin !== widgetOrigin ||
        !Number.isFinite(Date.parse(data.expiresAt)) ||
        Date.parse(data.expiresAt) <= Date.now() ||
        Date.parse(data.expiresAt) > Math.min(Date.now() + 300000, Date.parse(session.expiresAt))
      )
        return json(502, { error: 'Invalid assistant response' });
      issued = {
        token: data.token,
        expiresAt: data.expiresAt,
        deploymentId: data.deploymentId,
        widgetOrigin: data.widgetOrigin,
      };
      // Close the logout-during-exchange race before exposing any new widget token.
      if (!(await session.isActive())) {
        await revoke(issued);
        return json(401, { error: 'Host session ended' });
      }
      await options.onSessionIssued?.(issued, session);
      return json(200, issued);
    } catch {
      if (issued) await revoke(issued);
      return json(502, { error: 'Assistant connection unavailable' });
    }
  };
}
