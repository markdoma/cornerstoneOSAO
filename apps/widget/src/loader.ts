import { completedActionDetail } from './action-event';
(() => {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;
  const deploymentId = script.dataset.deployment;
  const firstParty = script.dataset.auth === 'hris-jwt';
  const endpoint =
    script.dataset.sessionEndpoint ??
    (firstParty ? '/api/internal/chat/session' : '/assistant/session');
  if (!deploymentId || !endpoint) return;
  const sessionUrl = new URL(endpoint, location.href);
  if (sessionUrl.origin !== location.origin) return;
  const apiOrigin = new URL(script.src).origin;
  let frame: HTMLIFrameElement | null = null,
    session: any,
    theme: any,
    timer: ReturnType<typeof setTimeout> | undefined,
    expired: ReturnType<typeof setTimeout> | undefined,
    stopped = false,
    epoch = 0,
    opened = false;
  let holder: HTMLDivElement | null = null;
  const remove = () => {
    clearTimeout(timer);
    clearTimeout(expired);
    frame?.remove();
    holder?.remove();
    frame = null;
    holder = null;
  };
  async function revoke(s: any) {
    if (!s?.token) return;
    await fetch(`${apiOrigin}/v1/widget/revoke`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${s.token}`,
        'x-host-origin': location.origin,
        'x-deployment-id': deploymentId!,
      },
      keepalive: true,
    }).catch(() => {});
  }
  function size() {
    if (!frame) return;
    if (theme.template === 'inline') {
      frame.style.width = '100%';
      frame.style.height = '600px';
      return;
    }
    frame.style.width = opened ? 'min(400px, calc(100vw - 24px))' : '76px';
    frame.style.height = opened ? 'min(640px, calc(100dvh - 32px))' : '76px';
  }
  function deliver() {
    frame?.contentWindow?.postMessage(
      {
        type: 'orchestrator:init',
        deploymentId,
        token: session.token,
        expiresAt: session.expiresAt,
        hostOrigin: location.origin,
      },
      apiOrigin,
    );
  }
  async function start() {
    const current = ++epoch;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (!firstParty && (script!.dataset.csrfHeader || script!.dataset.csrfMeta)) {
        const name = script!.dataset.csrfHeader ?? '';
        const meta = script!.dataset.csrfMeta ?? '';
        if (
          !/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(name) ||
          /^(authorization|cookie|host|origin|referer|content-.+|connection|sec-.+|proxy-.+)$/i.test(
            name,
          )
        )
          throw new Error('Invalid CSRF header');
        const value = Array.from(document.getElementsByTagName('meta')).find(
          (m) => m.name === meta,
        )?.content;
        if (!meta || !value || /[\r\n]/.test(value)) throw new Error('Missing CSRF token');
        headers[name] = value;
      }
      const response = await fetch(sessionUrl, {
        method: firstParty ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers,
        // Keep legacy custom endpoints compatible with the original empty-body contract.
        body: firstParty
          ? undefined
          : script!.dataset.sessionEndpoint
            ? '{}'
            : JSON.stringify({ deploymentId }),
        cache: 'no-store',
      });
      if (!response.ok) throw new Error('Not authenticated');
      const data = await response.json();
      const next = firstParty
        ? {
            token: data.user_context_token,
            deploymentId,
            widgetOrigin: apiOrigin,
            expiresAt: data.expiresAt,
          }
        : data;
      if (
        !next.token ||
        next.deploymentId !== deploymentId ||
        next.widgetOrigin !== apiOrigin ||
        !Number.isFinite(Date.parse(next.expiresAt)) ||
        Date.parse(next.expiresAt) <= Date.now()
      )
        throw new Error('Invalid widget session');
      const cfg = await fetch(`${apiOrigin}/v1/widget/config`, {
        headers: {
          authorization: `Bearer ${next.token}`,
          'x-host-origin': location.origin,
          'x-deployment-id': deploymentId!,
        },
        cache: 'no-store',
      });
      if (!cfg.ok) throw new Error('Unauthorized widget');
      const configuration = await cfg.json();
      next.expiresAt = configuration.expiresAt;
      if (stopped || current !== epoch) {
        await revoke(next);
        return;
      }
      const old = session;
      session = next;
      theme = configuration.theme;
      clearTimeout(expired);
      expired = setTimeout(
        () => {
          remove();
          session = null;
        },
        Math.max(0, Date.parse(next.expiresAt) - Date.now()),
      );
      if (!frame) {
        frame = document.createElement('iframe');
        frame.title = configuration.agent.name;
        frame.src = `${apiOrigin}/embed/${encodeURIComponent(deploymentId!)}`;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        frame.setAttribute('referrerpolicy', 'no-referrer');
        Object.assign(frame.style, {
          border: '0',
          colorScheme: 'normal',
          background: 'transparent',
          zIndex: '2147483000',
        });
        if (theme.template === 'floating')
          Object.assign(frame.style, {
            position: 'fixed',
            bottom: '16px',
            [theme.position === 'left' ? 'left' : 'right']: '16px',
          });
        else {
          holder = document.createElement('div');
          holder.style.cssText = 'width:100%;max-width:760px;';
          script!.after(holder);
        }
        (holder ?? document.body).append(frame);
        size();
        frame.addEventListener('load', deliver);
      } else deliver();
      if (old) void revoke(old);
      clearTimeout(timer);
      timer = setTimeout(
        () => void start(),
        Math.max(
          1000,
          Math.min(firstParty ? 480000 : Infinity, Date.parse(next.expiresAt) - Date.now() - 30000),
        ),
      );
    } catch {
      if (current === epoch) {
        const old = session;
        session = null;
        remove();
        void revoke(old);
      }
    }
  }
  window.addEventListener('message', (event) => {
    if (!frame || event.source !== frame.contentWindow || event.origin !== apiOrigin) return;
    if (event.data?.type === 'orchestrator:ready' && session) deliver();
    const completed = completedActionDetail(event.data, deploymentId!);
    if (completed && session && Date.parse(session.expiresAt) > Date.now()) {
      window.dispatchEvent(new CustomEvent('orchestrator:action-completed', { detail: completed }));
    }
    if (event.data?.type === 'orchestrator:resize') {
      opened = event.data.open === true;
      size();
    }
    if (event.data?.type === 'orchestrator:unauthorized') {
      const old = session;
      session = null;
      remove();
      void revoke(old);
      if (firstParty && !stopped) void start();
    }
  });
  const logout = () => {
    stopped = true;
    epoch++;
    const old = session;
    session = null;
    remove();
    void revoke(old);
  };
  (window as any).OrchestratorWidget = {
    logout,
    refresh: () => {
      stopped = false;
      return start();
    },
  };
  window.addEventListener('orchestrator:logout', logout);
  void start();
})();
