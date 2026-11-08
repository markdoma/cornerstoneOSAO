'use client';
import HostConnectorTabs from './host-connectors';
import BridgeInstallation from './bridge-installation';
import React, { useEffect, useState } from 'react';
import { Plug, Plus, ShieldCheck, CheckCircle2, FileCode2, ArrowRight } from 'lucide-react';
type Row = Record<string, any>;
type Props = {
  request: (path: string, body?: unknown, method?: string) => Promise<any>;
  onChange: () => Promise<void>;
  models: string[];
  Modal: React.ComponentType<any>;
};
const empty = () => ({
  name: '',
  baseUrl: '',
  origins: [] as string[],
  tenantId: '',
  sessionEndpoint: '/assistant/session',
  operations: [] as Row[],
});
const demoApps = {
  Taskroom: {
    name: 'Taskroom',
    baseUrl: 'http://127.0.0.1:3003/api',
    origins: ['http://localhost:3003'],
    sessionEndpoint: '/api/ao/session',
  },
  Taskboard: {
    name: 'Taskboard',
    baseUrl: 'http://127.0.0.1:3002/api',
    origins: ['http://localhost:3002'],
    sessionEndpoint: '/assistant/session',
  },
};
type DemoApp = keyof typeof demoApps;
type ApplicationSettings = (typeof demoApps)[DemoApp];
const steps = [
  'Application',
  'API definition',
  'Review tools',
  'Authentication',
  'Validate',
  'Publish',
];
export default function BridgePanel({ request, onChange, models, Modal }: Props) {
  const [rows, setRows] = useState<Row[]>([]),
    [status, setStatus] = useState<Row>({}),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState(false),
    [step, setStep] = useState(0),
    [id, setId] = useState(''),
    [draft, setDraft] = useState(empty()),
    [demoApp, setDemoApp] = useState<DemoApp>('Taskroom'),
    [beforeDemo, setBeforeDemo] = useState<ApplicationSettings | null>(null),
    [spec, setSpec] = useState(''),
    [inventory, setInventory] = useState<Row[]>([]),
    [selected, setSelected] = useState<string[]>([]),
    [filter, setFilter] = useState(''),
    [page, setPage] = useState(0),
    [focused, setFocused] = useState(0),
    [editor, setEditor] = useState(''),
    [bindings, setBindings] = useState('[]'),
    [validation, setValidation] = useState<Row | null>(null),
    [published, setPublished] = useState<Row | null>(null),
    [installation, setInstallation] = useState<Row | null>(null),
    [agentName, setAgentName] = useState('Application assistant'),
    [prompt, setPrompt] = useState(
      'Help the signed-in user with the permitted application tools. Ask for missing information and explain proposed changes.',
    ),
    [model, setModel] = useState(models[0] ?? ''),
    [legacyConnections, setLegacyConnections] = useState<Row[]>([]);
  async function load() {
    const [r, s, connections] = await Promise.all([
      request('/bridges'),
      request('/bridges/status'),
      request('/connections'),
    ]);
    setLegacyConnections(connections.filter((c: Row) => !c.bridgeRevisionId));
    setRows(r);
    setStatus(s);
  }
  useEffect(() => {
    void load().catch((e) => setError(e.message));
  }, []);
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  function open(row?: Row) {
    setDraft(
      row
        ? {
            ...structuredClone(row.draft),
            sessionEndpoint: row.draft.sessionEndpoint ?? '/assistant/session',
          }
        : empty(),
    );
    setDemoApp('Taskroom');
    setBeforeDemo(null);
    setId(row?.id ?? '');
    setEditing(true);
    setStep(0);
    setError('');
    setPublished(null);
    setInstallation(null);
    setValidation(null);
    setInventory([]);
    setSelected([]);
    setSpec('');
    setFocused(0);
    setEditor(JSON.stringify(row?.draft.operations?.[0]?.definition ?? {}, null, 2));
    setBindings(JSON.stringify(row?.draft.operations?.[0]?.bindings ?? [], null, 2));
  }
  function toggleDemo(enabled: boolean) {
    if (enabled) {
      const { name, baseUrl, origins, sessionEndpoint } = draft;
      setBeforeDemo({ name, baseUrl, origins, sessionEndpoint });
      setDraft({ ...draft, ...demoApps[demoApp] });
    } else if (beforeDemo) {
      setDraft({ ...draft, ...beforeDemo });
      setBeforeDemo(null);
    }
  }
  async function save() {
    const data = { ...draft };
    if (id) {
      await request(`/bridges/${id}`, data, 'PATCH');
      return id;
    }
    const row = await request('/bridges', data);
    setId(row.id);
    return row.id;
  }
  function focus(index: number, operations = draft.operations) {
    setFocused(index);
    setEditor(JSON.stringify(operations[index]?.definition ?? {}, null, 2));
    setBindings(JSON.stringify(operations[index]?.bindings ?? [], null, 2));
  }
  async function publish() {
    const saved = await save();
    const result = await request(`/bridges/${saved}/publish`, {});
    setPublished(result);
    await onChange();
    await load();
  }
  const filtered = inventory.filter((o) =>
    (o.method + ' ' + o.path + ' ' + o.description + ' ' + o.tags.join(' '))
      .toLowerCase()
      .includes(filter.toLowerCase()),
  );

  return (
    <>
      {error && !editing && (
        <div role="alert" className="alert">
          {error}
        </div>
      )}
      <div className="info-strip">
        <ShieldCheck size={18} />
        <span>
          AO runs your agents. The managed MCP bridge calls existing APIs using each signed-in
          user's bearer token. Your application routes stay unchanged.
        </span>
      </div>
      <div className="section-heading">
        <h2>
          Managed bridges <span>{rows.length}</span>
        </h2>
        <button className="button" disabled={!status.enabled} onClick={() => open()}>
          <Plus size={15} /> Set up bridge
        </button>
      </div>
      <p className="muted bridge-status">
        {!status.enabled
          ? 'Bridge setup is disabled. Configure MCP_BRIDGE_ENABLED and the managed bridge service.'
          : status.status === 'ok'
            ? 'Managed MCP service ready · protocol 2026-07-28'
            : 'Bridge service unavailable. Drafts can be reviewed; execution fails closed.'}
      </p>
      {rows.length ? (
        <div className="connection-grid">
          {rows.map((row) => (
            <article className="connection-card" key={row.id}>
              <span className="icon">
                <Plug size={22} />
              </span>
              <div>
                <h3>{row.name}</h3>
                <code>{row.draft.baseUrl}</code>
                <small>
                  {row.draft.operations.length} reviewed operations ·{' '}
                  {row.active ? 'Active' : 'Disabled'}
                </small>
              </div>
              <button
                className="button secondary"
                disabled={!status.enabled}
                onClick={() => open(row)}
              >
                Edit draft
              </button>
              <button
                className="text-button"
                onClick={() =>
                  void act(async () => {
                    await request(`/bridges/${row.id}/active`, { active: !row.active });
                    await load();
                  })
                }
              >
                {row.active ? 'Disable bridge' : 'Enable bridge'}
              </button>
            </article>
          ))}
        </div>
      ) : (
        <div className="empty">
          <Plug size={32} />
          <h3>Connect an application through MCP</h3>
          <p>
            Import its OpenAPI specification, review the tools, and connect its existing login once.
          </p>
        </div>
      )}
      {!!legacyConnections.length && (
        <details className="surface bridge-migrate">
          <summary>Migrate an existing direct API connection</summary>
          <p>
            Copies operations into a new draft. Existing agents and deployments remain unchanged
            until you publish and explicitly switch versions.
          </p>
          <Migration
            connections={legacyConnections}
            request={request}
            onCreated={async (row) => {
              open(row);
              await load();
            }}
          />
        </details>
      )}
      {editing && (
        <Modal
          title={id ? 'Configure MCP bridge' : 'Set up an MCP bridge'}
          subtitle="Review and publish API operations before making them available to agents."
          wide
          close={() => setEditing(false)}
        >
          <ol className="bridge-steps" aria-label="Bridge setup progress">
            {steps.map((s, i) => (
              <li key={s}>
                <button
                  aria-current={step === i ? 'step' : undefined}
                  disabled={busy}
                  onClick={() => setStep(i)}
                >
                  {i + 1}. {s}
                </button>
              </li>
            ))}
          </ol>
          {error && (
            <div className="alert" role="alert">
              {error}
            </div>
          )}
          {step === 0 && !id && (
            <>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={beforeDemo !== null}
                  onChange={(e) => toggleDemo(e.target.checked)}
                />
                Use demo app settings
              </label>
              {beforeDemo && (
                <label className="field">
                  Demo app
                  <select
                    value={demoApp}
                    onChange={(e) => {
                      const next = e.target.value as DemoApp;
                      setDemoApp(next);
                      setDraft({ ...draft, ...demoApps[next] });
                    }}
                  >
                    <option value="Taskroom">Taskroom (port 3003)</option>
                    <option value="Taskboard">Taskboard (port 3002)</option>
                  </select>
                  <small>
                    Start the optional demo separately and enter its external tenant ID.
                  </small>
                </label>
              )}
            </>
          )}
          {step === 0 && (
            <div className="form-columns">
              <label className="field">
                Application name
                <input
                  required
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                API base URL
                <input
                  type="url"
                  required
                  value={draft.baseUrl}
                  placeholder="https://hris.example.com/api/v1"
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                />
                <small>Public HTTPS JSON API.</small>
              </label>
              <label className="field">
                External tenant ID
                <input
                  required
                  value={draft.tenantId}
                  onChange={(e) => setDraft({ ...draft, tenantId: e.target.value })}
                />
                <small>
                  One external tenant per AO organization. Use the server-verified active tenant.
                </small>
              </label>
              <label className="field">
                Allowed application origins
                <textarea
                  value={draft.origins.join('\n')}
                  onChange={(e) => setDraft({ ...draft, origins: e.target.value.split('\n') })}
                />
                <small>One exact origin per line, without a trailing slash.</small>
              </label>
            </div>
          )}
          {step === 1 && (
            <>
              <label className="field">
                OpenAPI JSON or YAML (up to 5 MB)
                <input
                  type="file"
                  accept=".json,.yaml,.yml"
                  onChange={(e) =>
                    void act(async () => {
                      const f = e.target.files?.[0];
                      if (!f) return;
                      if (f.size > 5 * 1024 * 1024) throw new Error('Specification exceeds 5 MB');
                      setSpec(await f.text());
                      setInventory([]);
                      setSelected([]);
                    })
                  }
                />
                <textarea
                  rows={5}
                  value={spec}
                  onChange={(e) => {
                    setSpec(e.target.value);
                    setInventory([]);
                    setSelected([]);
                  }}
                  placeholder="Paste a specification or upload a file"
                />
              </label>
              <button
                className="button secondary"
                disabled={busy || !spec}
                onClick={() =>
                  void act(async () => {
                    const result = await request('/bridges/import/inventory', { spec });
                    setInventory(result.operations);
                    setPage(0);
                  })
                }
              >
                <FileCode2 size={15} /> List operations
              </button>
              {!!inventory.length && (
                <>
                  <div className="toolbar">
                    <input
                      aria-label="Search API operations"
                      placeholder="Search method, path or tag"
                      value={filter}
                      onChange={(e) => {
                        setFilter(e.target.value);
                        setPage(0);
                      }}
                    />
                    <span>
                      {selected.length}/40 selected · {filtered.length} matches
                    </span>
                  </div>
                  <div className="import-list">
                    {filtered.slice(page * 10, page * 10 + 10).map((row) => (
                      <label key={row.id}>
                        <input
                          type="checkbox"
                          checked={selected.includes(row.id)}
                          disabled={!selected.includes(row.id) && selected.length >= 40}
                          onChange={(e) =>
                            setSelected(
                              e.target.checked
                                ? [...selected, row.id]
                                : selected.filter((id) => id !== row.id),
                            )
                          }
                        />
                        <span>
                          <strong>
                            {row.method} {row.path}
                          </strong>
                          <small>{row.description}</small>
                        </span>
                      </label>
                    ))}
                  </div>
                  <div className="form-actions">
                    <button
                      className="button secondary"
                      disabled={!page}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous page
                    </button>
                    <span>
                      Page {page + 1} of {Math.max(1, Math.ceil(filtered.length / 10))}
                    </span>
                    <button
                      className="button secondary"
                      disabled={(page + 1) * 10 >= filtered.length}
                      onClick={() => setPage(page + 1)}
                    >
                      Next page
                    </button>
                  </div>
                  <button
                    className="button"
                    disabled={busy || !selected.length}
                    onClick={() =>
                      void act(async () => {
                        const result = await request('/bridges/import/review', { spec, selected });
                        setDraft({ ...draft, operations: result.operations });
                        setStep(2);
                        focus(0, result.operations);
                      })
                    }
                  >
                    Review selected operations
                  </button>
                </>
              )}
              <p className="muted install-help">
                Only selected operations are validated. Unsupported fields produce an explicit
                error; no schema fields are silently dropped.
              </p>
              <button
                className="text-button"
                disabled={draft.operations.length >= 40}
                onClick={() => {
                  const operations = [
                    ...draft.operations,
                    {
                      id: 'manual-' + Date.now(),
                      enabled: false,
                      bindings: [],
                      definition: {
                        name: 'new_operation_' + draft.operations.length,
                        description: 'Describe when the assistant should use this operation',
                        method: 'GET',
                        path: '/tasks',
                        kind: 'read',
                        schema: {
                          type: 'object',
                          properties: {},
                          required: [],
                          additionalProperties: false,
                        },
                      },
                    },
                  ];
                  setDraft({ ...draft, operations });
                  setStep(2);
                  setFocused(operations.length - 1);
                  setEditor(JSON.stringify(operations.at(-1)!.definition, null, 2));
                  setBindings('[]');
                }}
              >
                Define an operation manually
              </button>
            </>
          )}
          {step === 2 && (
            <>
              <p className="muted">
                Explicitly enable reviewed operations. Non-GET requests require confirmation.
                Configure mappings for existing API identity fields; the bridge does not add extra
                tenant fields by default.
              </p>
              <div className="bridge-review">
                <div className="import-list">
                  {draft.operations.map((operation, i) => (
                    <div className="bridge-operation" key={operation.id}>
                      <label>
                        <input
                          type="checkbox"
                          aria-label={`Enable ${operation.definition.name}`}
                          checked={operation.enabled}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              operations: draft.operations.map((o, j) =>
                                j === i ? { ...o, enabled: e.target.checked } : o,
                              ),
                            })
                          }
                        />
                        <span>
                          {operation.definition.name}
                          <small>
                            {operation.definition.method} {operation.definition.path}
                          </small>
                        </span>
                      </label>
                      <button className="text-button" onClick={() => focus(i)}>
                        Edit
                      </button>
                    </div>
                  ))}
                </div>
                <div>
                  {draft.operations[focused] && (
                    <>
                      <label className="field">
                        Operation definition (JSON)
                        <textarea
                          className="code-editor"
                          rows={14}
                          value={editor}
                          onChange={(e) => setEditor(e.target.value)}
                        />
                      </label>
                      <label className="field">
                        Verified identity bindings (JSON)
                        <textarea
                          className="code-editor"
                          rows={4}
                          value={bindings}
                          onChange={(e) => setBindings(e.target.value)}
                        />
                        <small>
                          Example: {'[{"location":"query","name":"tenantId","source":"tenantId"}]'}.
                          Sources: tenantId, userId, employeeId. Bound fields are hidden from model
                          arguments.
                        </small>
                      </label>
                      <button
                        className="button secondary"
                        onClick={() =>
                          void act(async () => {
                            const definition = JSON.parse(editor),
                              b = JSON.parse(bindings);
                            setDraft({
                              ...draft,
                              operations: draft.operations.map((o, j) =>
                                j === focused ? { ...o, definition, bindings: b } : o,
                              ),
                            });
                          })
                        }
                      >
                        Apply operation edits
                      </button>
                    </>
                  )}
                </div>
              </div>
            </>
          )}
          {step === 3 && (
            <div className="guide">
              <label className="field">
                Host session endpoint
                <input
                  aria-label="Host session endpoint"
                  required
                  value={draft.sessionEndpoint}
                  placeholder="/api/assistant/session"
                  maxLength={500}
                  onChange={(e) => setDraft({ ...draft, sessionEndpoint: e.target.value })}
                />
                <small>
                  Supply the POST endpoint your application developer implements to verify the
                  existing login and request an AO widget session. Use a path on the embedding
                  origin, not the HRIS API base URL.
                </small>
              </label>
              <p className="muted">
                Saving this path does not create or verify an endpoint in your application. Its
                backend must implement the connector before the assistant can work.
              </p>
              <div className="notice">
                One-time server connection required. Verify the application's existing login and
                assistant permission; provide the current user's existing API bearer token
                server-to-server. An AO-audience JWT is not automatically an application API token.
              </div>
              <details>
                <summary>Preview backend connectors</summary>
                <HostConnectorTabs
                  endpoint={draft.sessionEndpoint}
                  applicationOrigin={draft.origins[0]}
                  tenantId={draft.tenantId}
                  widgetOrigin={process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? 'http://localhost:4000'}
                />
              </details>
            </div>
          )}
          {step === 4 && (
            <>
              <button
                className="button"
                disabled={busy}
                onClick={() =>
                  void act(async () => {
                    const saved = await save();
                    setValidation(await request(`/bridges/${saved}/validate`, {}));
                  })
                }
              >
                <CheckCircle2 size={15} /> Validate bridge configuration
              </button>
              {validation && (
                <div className="notice">
                  MCP {validation.protocol}: {validation.status}. {validation.enabledOperations}{' '}
                  enabled operations.
                  <p>
                    Configured host endpoint: <code>POST {validation.sessionEndpoint}</code>
                  </p>
                  <p>{validation.hostAuthentication}</p>
                </div>
              )}
              <p className="muted install-help">
                After installation, open the assistant's “Test permitted API tools” panel inside the
                signed-in application to verify discovery and run calls with that user's
                permissions. Write tests show normal approval cards. Setup validation never sends a
                write.
              </p>
            </>
          )}
          {step === 5 && (
            <>
              <p>
                Publishing creates an immutable bridge revision and selectable MCP tools. Existing
                deployed agents will not change.
              </p>
              {!published ? (
                <button className="button" disabled={busy} onClick={() => void act(publish)}>
                  Publish reviewed bridge
                </button>
              ) : (
                <>
                  <div className="notice">
                    Revision {published.revision.number} published · {published.tools.length} MCP
                    tools. You can select them in an existing agent draft, or create an assistant
                    below.
                  </div>
                  <div className="form-columns">
                    <label className="field">
                      Agent name
                      <input value={agentName} onChange={(e) => setAgentName(e.target.value)} />
                    </label>
                    <label className="field">
                      Enabled model
                      <select value={model} onChange={(e) => setModel(e.target.value)}>
                        {models.map((m) => (
                          <option key={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <label className="field">
                    Agent prompt
                    <textarea rows={4} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
                  </label>
                  <button
                    className="button"
                    disabled={busy || !!installation}
                    onClick={() =>
                      void act(async () => {
                        const a = await request('/agents', {
                          name: agentName,
                          description: 'Assistant connected through the managed MCP bridge',
                          prompt,
                          welcome: 'How can I help?',
                          starters: ['Show my records'],
                          model,
                          toolIds: published.tools.map((t: Row) => t.id),
                        });
                        const v = await request(`/agents/${a.id}/publish`, {});
                        const deployment = await request('/deployments', {
                          name: draft.name + ' assistant',
                          versionId: v.id,
                          origins: draft.origins,
                          theme: { template: 'floating', title: agentName },
                        });
                        setInstallation(deployment);
                        await onChange();
                      })
                    }
                  >
                    Create agent, publish and deploy
                  </button>
                </>
              )}
              {installation && (
                <BridgeInstallation
                  deploymentId={installation.id}
                  endpoint={published?.revision.config.sessionEndpoint ?? '/assistant/session'}
                  origins={installation.origins}
                  tenantId={published?.revision.config.tenantId ?? ''}
                  widgetOrigin={process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? 'http://localhost:4000'}
                  secret={installation.integrationKey}
                />
              )}
            </>
          )}
          <div className="form-actions">
            <button
              className="button secondary"
              disabled={busy || step === 0}
              onClick={() => setStep(step - 1)}
            >
              Back
            </button>
            <button
              className="button secondary"
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await save();
                  await load();
                })
              }
            >
              Save draft
            </button>
            {step < 5 && (
              <button
                className="button"
                disabled={busy}
                onClick={() => {
                  if (step === 1 && draft.operations.length) focus(0);
                  setStep(step + 1);
                }}
              >
                Continue <ArrowRight size={14} />
              </button>
            )}
          </div>
        </Modal>
      )}
    </>
  );
}
function Migration({
  connections,
  request,
  onCreated,
}: {
  connections: Row[];
  request: Props['request'];
  onCreated: (row: Row) => Promise<void>;
}) {
  const [id, setId] = useState(''),
    [tenant, setTenant] = useState(''),
    [origin, setOrigin] = useState(''),
    [error, setError] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError('');
        void request(`/connections/${id}/migrate-to-bridge`, {
          tenantId: tenant,
          origins: [origin],
        })
          .then(onCreated)
          .catch((e) => setError(e.message));
      }}
    >
      <div className="form-columns">
        <label className="field">
          Direct connection
          <select required value={id} onChange={(e) => setId(e.target.value)}>
            <option value="">Select a connection</option>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          Verified tenant ID
          <input required value={tenant} onChange={(e) => setTenant(e.target.value)} />
        </label>
        <label className="field">
          Application origin
          <input required type="url" value={origin} onChange={(e) => setOrigin(e.target.value)} />
        </label>
      </div>
      {error && <div className="alert">{error}</div>}
      <button className="button secondary" type="submit">
        Create migration draft
      </button>
    </form>
  );
}
