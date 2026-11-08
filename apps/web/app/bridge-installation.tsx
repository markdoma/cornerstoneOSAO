'use client';
import React, { useState } from 'react';
import HostConnectorTabs from './host-connectors';
import { embedScript } from './install-kit';

type Props = {
  deploymentId: string;
  endpoint: string;
  origins: string[];
  tenantId: string;
  widgetOrigin: string;
  secret?: string;
  onReplaceKey?: () => void;
};

export default function BridgeInstallation({
  deploymentId,
  endpoint,
  origins,
  tenantId,
  widgetOrigin,
  secret,
  onReplaceKey,
}: Props) {
  const [selectedOrigin, setSelectedOrigin] = useState(origins[0]);
  const [copyStatus, setCopyStatus] = useState('');
  const origin = origins.includes(selectedOrigin) ? selectedOrigin : origins[0];
  const snippet = embedScript({ deploymentId, endpoint, widgetOrigin });
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(label);
    } catch {
      setCopyStatus('Copy unavailable. Select the text or download the install kit.');
    }
  }
  return (
    <div className="guide">
      <h3>Install in your application</h3>
      <p>
        Choose your backend language and download its install kit. The developer can install it
        without an AO dashboard account.
      </p>
      {origins.length > 1 && (
        <label className="field">
          Application origin for this install
          <select value={origin} onChange={(event) => setSelectedOrigin(event.target.value)}>
            {origins.map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      )}
      {secret ? (
        <div className="secret-box">
          <strong>Server integration key — shown once</strong>
          <p>Save this key in the host’s secret store. Share it separately from the install kit.</p>
          <code>{secret}</code>
          <button
            type="button"
            className="text-button"
            onClick={() => void copy(secret, 'Server key copied')}
          >
            Copy server key
          </button>
        </div>
      ) : (
        <div className="notice">
          Use the saved server integration key. AO does not show it again after creation.
          {onReplaceKey && (
            <button type="button" className="text-button" onClick={onReplaceKey}>
              Replace lost key
            </button>
          )}
        </div>
      )}
      {tenantId && origin ? (
        <HostConnectorTabs
          deploymentId={deploymentId}
          endpoint={endpoint}
          applicationOrigin={origin}
          tenantId={tenantId}
          widgetOrigin={widgetOrigin}
          secret={secret}
        />
      ) : (
        <p role="alert" className="alert">
          This deployment is missing its tenant mapping or allowed origin. Review the published
          bridge before installing.
        </p>
      )}
      <details>
        <summary>View public embed script</summary>
        <pre aria-label="Public embed script">{snippet}</pre>
        <button
          type="button"
          className="button secondary"
          onClick={() => void copy(snippet, 'Embed script copied')}
        >
          Copy embed script
        </button>
      </details>
      {copyStatus && <p role="status">{copyStatus}</p>}
    </div>
  );
}
