'use client';
import React, { useEffect, useRef, useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { buildInstallKit, hostSettings } from './install-kit';
import { connectorCatalog } from '../../../packages/bridge/src/connector-catalog';

type Props = {
  endpoint: string;
  applicationOrigin: string;
  tenantId: string;
  deploymentId?: string;
  widgetOrigin: string;
  secret?: string;
};
export default function HostConnectorTabs({
  endpoint,
  applicationOrigin,
  tenantId,
  deploymentId,
  widgetOrigin,
  secret,
}: Props) {
  const [language, setLanguage] = useState<string>('node');
  const [loaded, setLoaded] = useState<{ language: string; text: string } | null>(null);
  const source = loaded?.language === language ? loaded.text : '';
  const [error, setError] = useState('');
  const [copied, setCopied] = useState('');
  const [retry, setRetry] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const item = connectorCatalog.find((c) => c.id === language)!;
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(null);
    setError('');
    setCopied('');
    void fetch(`${widgetOrigin}/host-connectors/${language}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok)
          throw new Error('Connector could not be loaded. Try again or check the AO backend.');
        const text = await r.text();
        if (!controller.signal.aborted) setLoaded({ language, text });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [language, widgetOrigin, retry]);
  const config = {
    endpoint: endpoint || '/assistant/session',
    applicationOrigin,
    tenantId,
    deploymentId: deploymentId ?? '<after publishing>',
    widgetOrigin,
  };
  const settings = hostSettings(config);
  async function copy(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(label);
    } catch {
      setError('Copy unavailable. Select the code manually or download the file.');
    }
  }
  function download(file: BlobPart, filename: string, type: string) {
    const url = URL.createObjectURL(new Blob([file], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return (
    <section className="host-connectors" aria-label="Host backend connectors">
      <h3>Choose your backend language</h3>
      <p>
        {deploymentId
          ? 'Download one ZIP with the files and steps for your app. Add the server key separately.'
          : 'Preview the connector now. Download the install kit after publishing.'}
      </p>
      <div className="connector-tabs" role="tablist" aria-label="Backend language">
        {connectorCatalog.map((c, i) => (
          <button
            key={c.id}
            ref={(el) => {
              buttons.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`connector-tab-${c.id}`}
            aria-controls="connector-panel"
            aria-selected={language === c.id}
            tabIndex={language === c.id ? 0 : -1}
            onClick={() => setLanguage(c.id)}
            onKeyDown={(e) => {
              let index = i;
              if (e.key === 'ArrowRight') index = (i + 1) % connectorCatalog.length;
              else if (e.key === 'ArrowLeft')
                index = (i - 1 + connectorCatalog.length) % connectorCatalog.length;
              else if (e.key === 'Home') index = 0;
              else if (e.key === 'End') index = connectorCatalog.length - 1;
              else return;
              e.preventDefault();
              setLanguage(connectorCatalog[index].id);
              buttons.current[index]?.focus();
            }}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div
        role="tabpanel"
        id="connector-panel"
        aria-labelledby={`connector-tab-${language}`}
        tabIndex={0}
      >
        <p>
          <strong>{item.target}</strong>
        </p>
        {deploymentId && (
          <button
            type="button"
            className="button"
            disabled={!source}
            onClick={() =>
              download(
                buildInstallKit(config, item, source),
                `ao-${item.id}-install.zip`,
                'application/zip',
              )
            }
          >
            <Download size={14} /> Download install kit
          </button>
        )}
        {deploymentId && (
          <p>
            Your app developer connects the kit to your existing login and API permissions, then
            adds the widget to the page.
          </p>
        )}
        {error && (
          <p role="alert" className="alert">
            {error}{' '}
            <button type="button" className="text-button" onClick={() => setRetry((n) => n + 1)}>
              Reload connector
            </button>
          </p>
        )}
        <details open={!deploymentId}>
          <summary>View or copy individual files</summary>
          <p>{item.mount}</p>
          {item.docs && (
            <a href={item.docs} target="_blank" rel="noreferrer">
              Framework documentation ↗
            </a>
          )}
          <h4>1. Host environment</h4>
          <pre aria-label="Host environment settings">{settings}</pre>
          <button
            type="button"
            className="button secondary"
            onClick={() => void copy(hostSettings(config, secret), 'Host settings copied')}
          >
            <Copy size={14} /> {secret ? 'Copy server settings with key' : 'Copy host settings'}
          </button>
          <h4>2. Backend connector</h4>
          <pre
            className="connector-source"
            aria-label={`${item.label} connector code`}
            aria-busy={!source && !error}
          >
            {source || (error ? 'Unable to load connector.' : 'Loading connector…')}
          </pre>
          <div className="form-actions">
            <button
              type="button"
              className="button secondary"
              disabled={!source}
              onClick={() => void copy(source, `${item.label} code copied`)}
            >
              <Copy size={14} /> Copy code
            </button>
            <button
              type="button"
              className="button secondary"
              disabled={!source}
              onClick={() => download(source, item.filename, 'text/plain;charset=utf-8')}
            >
              <Download size={14} /> Download {item.filename}
            </button>
          </div>
        </details>
        <p role="status">{copied}</p>
      </div>
    </section>
  );
}
