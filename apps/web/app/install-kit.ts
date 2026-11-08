import { strToU8, zipSync } from 'fflate';
import { connectorCatalog } from '../../../packages/bridge/src/connector-catalog';

type Installation = {
  endpoint: string;
  applicationOrigin: string;
  tenantId: string;
  deploymentId: string;
  widgetOrigin: string;
};

export function embedScript(
  config: Pick<Installation, 'widgetOrigin' | 'deploymentId' | 'endpoint'>,
) {
  const attribute = (value: string) =>
    value
      .replaceAll('&', '&amp;')
      .replaceAll('"', '&quot;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;');
  return `<script src="${attribute(config.widgetOrigin)}/loader.js" data-deployment="${attribute(config.deploymentId)}" data-session-endpoint="${attribute(config.endpoint)}" defer></script>`;
}

export function hostSettings(config: Installation, secret = '') {
  const local = [config.widgetOrigin, config.applicationOrigin].some((origin) =>
    /^http:\/\/(localhost|127\.0\.0\.1)(:|$)/.test(origin),
  );
  return [
    '# Host backend only. Keep AO_INTEGRATION_KEY out of source control and browser code.',
    `AO_ORIGIN=${JSON.stringify(config.widgetOrigin)}`,
    `AO_WIDGET_ORIGIN=${JSON.stringify(config.widgetOrigin)}`,
    `AO_APPLICATION_ORIGIN=${JSON.stringify(config.applicationOrigin)}`,
    `AO_SESSION_ENDPOINT=${JSON.stringify(config.endpoint)}`,
    `AO_TENANT_ID=${JSON.stringify(config.tenantId)}`,
    `AO_DEPLOYMENT_ID=${JSON.stringify(config.deploymentId)}`,
    `AO_INTEGRATION_KEY=${secret ? JSON.stringify(secret) : ''}`,
    `AO_ALLOW_LOCALHOST=${local ? 'true # Local development only' : 'false'}`,
    '',
  ].join('\n');
}

export function buildInstallKit(
  config: Installation,
  item: (typeof connectorCatalog)[number],
  source: string,
) {
  const mount =
    item.id === 'node'
      ? `For Next.js, put \`route.js\` and \`ao-connector.mjs\` together in the route folder for \`${config.endpoint}\` under \`app\` or \`src/app\`. For example, \`/assistant/session\` uses \`app/assistant/session/route.js\`. For other Node servers, call the connector's \`POST\` handler with a Web Request and return its Response.`
      : item.mount;
  const readme = [
    '# Install the AO assistant',
    '',
    `This kit is for \`${config.applicationOrigin}\` and ${item.target}.`,
    '',
    '1. Copy the values from `.env.ao.example` into your app backend settings. Get `AO_INTEGRATION_KEY` from your AO owner and save it as a backend secret. If the backend uses a different address to reach AO, change `AO_ORIGIN`.',
    `2. Install \`${item.filename}\` and handle \`POST ${config.endpoint}\`. ${mount}`,
    '3. Fill in the login adapter using your existing server session. Verify assistant access, the user, and the active tenant. Return the user API token and expiry. Recheck the same login before and after the exchange, track the issued widget tokens, and revoke them on logout.',
    '4. Paste `Widget.html` into your app page and call `window.OrchestratorWidget?.logout()` in the browser logout flow. Restart the app. Sign in and run a read in **Test permitted API tools**. Sign out and check that the assistant disappears.',
    '',
    'Keep your existing CSRF protection. If it requires a header, set `data-csrf-header` and `data-csrf-meta` on the embed script so it can read the existing token from a page meta tag.',
    '',
    'For multiple tenants, select the deployment and key on the server from the verified active tenant. Keep one AO workspace per external tenant.',
    '',
  ].join('\n');
  // The shareable archive only receives public deployment settings. Never pass a key here.
  return zipSync({
    [item.filename]: strToU8(source),
    ...(item.id === 'node'
      ? { 'route.js': strToU8("export { POST } from './ao-connector.mjs';\n") }
      : {}),
    '.env.ao.example': strToU8(hostSettings(config)),
    'Widget.html': strToU8(embedScript(config) + '\n'),
    'README.md': strToU8(readme),
  });
}
