'use client';
import BridgePanel from './bridges';
import BridgeInstallation from './bridge-installation';
import React, { useEffect, useRef, useState } from 'react';
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  Copy,
  Globe,
  KeyRound,
  Layers,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plug,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  Terminal,
  Trash2,
  Users,
  Workflow,
  X,
  Zap,
} from 'lucide-react';
const widgetOrigin = process.env.NEXT_PUBLIC_WIDGET_ORIGIN ?? 'http://localhost:4000';
type Row = Record<string, any>;
const blankTheme = {
  template: 'floating',
  color: '#7560e8',
  mode: 'light',
  position: 'right',
  title: 'Assistant',
};
async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(`/backend/v1${path}`, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw Object.assign(new Error(data.error ?? 'Request failed'), { status: r.status });
  return data;
}
function Brand() {
  return (
    <div className="wordmark" aria-label="CornerstoneLabs AO — Agent orchestrator">
      <span className="logo">
        <svg viewBox="0 0 48 56" fill="none" aria-hidden="true">
          <path d="M24 2 5 24 24 34 43 24Z" fill="#9BC848" />
          <path d="m24 2 0 32 19-10Z" fill="#C3E66F" />
          <path d="M5 24v21l19 10V34Z" fill="#1B548A" />
          <path d="M24 34v21l19-10V24Z" fill="#28ACCC" />
          <path d="m24 15-9 14 9-5 9 5Z" fill="#67D4E5" />
          <path d="M24 34v21M5 24l19 10 19-10" stroke="#D9F5FF" strokeWidth="1" />
        </svg>
      </span>
      <span className="brand-copy">
        <strong>
          <span className="brand-corner">Corner</span>
          <span className="brand-stone">stone</span>
          <span className="brand-labs">Labs</span> <span className="brand-ao">AO</span>
        </strong>
        <small>Agent orchestrator</small>
      </span>
    </div>
  );
}
function Icon({ children }: { children: React.ReactNode }) {
  return <span className="icon">{children}</span>;
}
function Button({
  children,
  onClick,
  secondary = false,
  disabled = false,
  type = 'button',
}: {
  children: React.ReactNode;
  onClick?: () => void;
  secondary?: boolean;
  disabled?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      className={`button ${secondary ? 'secondary' : ''}`}
      onClick={onClick}
      disabled={disabled}
    >
      {children}
    </button>
  );
}
function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  );
}
function Modal({
  title,
  subtitle,
  children,
  close,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  close: () => void;
  wide?: boolean;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    box.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Tab') {
        const els = box.current?.querySelectorAll<HTMLElement>(
          'button,input,textarea,select,a[href],[tabindex="0"]',
        );
        if (!els?.length) return;
        const first = els[0],
          last = els[els.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      previous?.focus();
    };
  }, []);
  return (
    <div
      className="overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div
        ref={box}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'wide' : ''}`}
      >
        <div className="modal-heading">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="icon-button" aria-label="Close dialog" onClick={close}>
            <X size={19} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function Empty({
  icon,
  title,
  description,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="empty">
      <div className="empty-icon">{icon}</div>
      <h3>{title}</h3>
      <p>{description}</p>
      {action}
    </div>
  );
}
function Auth({ onDone }: { onDone: () => void }) {
  const [mode, setMode] = useState('login'),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState('');
  const reset =
    typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('reset') : null;
  useEffect(() => {
    if (reset) setMode('reset');
  }, [reset]);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const f = Object.fromEntries(new FormData(e.currentTarget));
    try {
      if (mode === 'forgot') {
        const data = await api('/auth/forgot', f);
        setMessage(data.message);
      } else if (mode === 'reset') {
        await api('/auth/reset', { password: f.password, token: reset });
        history.replaceState({}, '', location.pathname);
        setMode('login');
        setMessage('Password reset. Sign in with your new password.');
      } else {
        await api(`/auth/${mode}`, f);
        onDone();
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-shell">
      <div className="auth-story">
        <Brand />
        <div className="auth-story-content">
          <span className="pill">WORKSPACE ACCESS</span>
          <h1>
            Welcome to your
            <br />
            <em>agent workspace.</em>
          </h1>
          <p>
            Create capable AI assistants and connect them to your applications. One secure workspace
            for every agent.
          </p>
          <div className="auth-features">
            <div>
              <ShieldCheck size={21} />
              <strong>Secure access</strong>
              <p>Your users’ permissions stay in control.</p>
            </div>
            <div>
              <Layers size={21} />
              <strong>Every application</strong>
              <p>Connect your APIs and embed your assistant.</p>
            </div>
            <div>
              <Zap size={21} />
              <strong>Actions that matter</strong>
              <p>Review and approve changes before they run.</p>
            </div>
          </div>
        </div>
        <small>THE AI AGENT WORKSPACE</small>
      </div>
      <div className="auth-form">
        <div className="auth-card">
          <span className="eyebrow">WELCOME TO CORNERSTONELABS AO</span>
          <h2>
            {mode === 'signup'
              ? 'Build something capable.'
              : mode === 'forgot'
                ? 'Forgot your password?'
                : mode === 'reset'
                  ? 'Choose a new password.'
                  : 'Welcome back.'}
          </h2>
          <p>
            {mode === 'signup'
              ? 'Create your workspace and bring your first agent to life.'
              : mode === 'forgot'
                ? 'We’ll email you a secure reset link.'
                : mode === 'reset'
                  ? 'Use at least 12 characters.'
                  : 'Sign in to your agent workspace.'}
          </p>
          <form onSubmit={submit}>
            {mode === 'signup' && (
              <>
                <Field label="Your name">
                  <input name="name" required maxLength={100} autoComplete="name" />
                </Field>
                <Field label="Organization">
                  <input name="organization" required maxLength={100} placeholder="Acme, Inc." />
                </Field>
              </>
            )}
            {mode !== 'reset' && (
              <Field label="Email address">
                <input
                  name="email"
                  type="email"
                  required
                  autoComplete="email"
                  placeholder="you@company.com"
                />
              </Field>
            )}
            {mode !== 'forgot' && (
              <Field
                label="Password"
                hint={mode === 'signup' ? 'At least 12 characters.' : undefined}
              >
                <input
                  name="password"
                  type="password"
                  required
                  minLength={12}
                  maxLength={128}
                  autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                />
              </Field>
            )}
            {error && (
              <div className="alert" role="alert">
                {error}
              </div>
            )}
            {message && <div className="notice">{message}</div>}
            <Button type="submit" disabled={busy}>
              {busy
                ? 'Please wait…'
                : mode === 'signup'
                  ? 'Create workspace'
                  : mode === 'forgot'
                    ? 'Send reset link'
                    : mode === 'reset'
                      ? 'Reset password'
                      : 'Sign in'}
              <ArrowRight size={16} />
            </Button>
          </form>
          <div className="auth-links">
            {mode === 'login' ? (
              <>
                <button
                  onClick={() => {
                    setMode('signup');
                    setError('');
                  }}
                >
                  Create an account
                </button>
                <button
                  onClick={() => {
                    setMode('forgot');
                    setError('');
                  }}
                >
                  Forgot password?
                </button>
              </>
            ) : (
              <button
                onClick={() => {
                  setMode('login');
                  setError('');
                }}
              >
                Back to sign in
              </button>
            )}
          </div>
          <p className="auth-foot">
            <ShieldCheck size={14} /> Your agents. Your data. Your control.
          </p>
        </div>
      </div>
    </div>
  );
}

export default function Dashboard() {
  const [me, setMe] = useState<Row | null>(null),
    [loaded, setLoaded] = useState(false),
    [page, setPage] = useState('Overview'),
    [agents, setAgents] = useState<Row[]>([]),
    [tools, setTools] = useState<Row[]>([]),
    [deployments, setDeployments] = useState<Row[]>([]),
    [overview, setOverview] = useState<Row>({}),
    [conversations, setConversations] = useState<Row[]>([]),
    [members, setMembers] = useState<Row[]>([]),
    [orgs, setOrgs] = useState<Row[]>([]),
    [modal, setModal] = useState<string | null>(null),
    [selected, setSelected] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [toast, setToast] = useState(''),
    [loading, setLoading] = useState(false),
    [search, setSearch] = useState(''),
    [versions, setVersions] = useState<Row[]>([]),
    [secret, setSecret] = useState(''),
    [messages, setMessages] = useState<Row[]>([]);
  async function refresh() {
    try {
      const user = await api('/auth/me');
      setMe(user);
      const [a, t, d, o, conv, m, organizations] = await Promise.all([
        api('/agents'),
        api('/tools'),
        api('/deployments'),
        api('/overview'),
        api('/conversations'),
        api('/members'),
        api('/organizations'),
      ]);
      setAgents(a);
      setTools(t);
      setDeployments(d);
      setOverview(o);
      setConversations(conv);
      setMembers(m);
      setOrgs(organizations);
    } catch (e: any) {
      if (e.status === 401) setMe(null);
      else setError(e.message);
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(''), 4500);
    return () => clearTimeout(t);
  }, [toast]);
  async function act(fn: () => Promise<unknown>, success?: string) {
    setLoading(true);
    setError('');
    try {
      await fn();
      await refresh();
      if (success) setToast(success);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  function close() {
    setModal(null);
    setSelected(null);
    setSecret('');
    setError('');
  }
  function createAgent() {
    setSelected(null);
    setModal('agent');
  }
  async function publish(a: Row) {
    await act(async () => {
      await api(`/agents/${a.id}/publish`, {});
    }, 'Agent published. Create a deployment to make it available.');
  }
  async function newDeployment() {
    setError('');
    setLoading(true);
    try {
      const list = (
        await Promise.all(
          agents.filter((a) => !a.archived).map((a) => api(`/agents/${a.id}/versions`)),
        )
      ).flat();
      setVersions(list.filter((v) => (v.config.tools ?? []).every((t: Row) => t.bridgeRevisionId)));
      setModal('deployment');
      setSelected(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setToast('Copied to clipboard');
    } catch {
      setError('Clipboard unavailable. Select and copy the text manually.');
    }
  }
  const filteredAgents = agents.filter(
    (a) => !a.archived && a.draft.name.toLowerCase().includes(search.toLowerCase()),
  );
  if (!loaded)
    return (
      <div className="boot">
        <span className="logo">
          <Workflow />
        </span>
        <p>Opening your workspace…</p>
      </div>
    );
  if (!me) return <Auth onDone={() => void refresh()} />;
  const headings: Row = {
    Overview: ['Workspace overview', 'A little intelligence. A lot of possibility.'],
    Agents: ['Your agents', 'Give your MCP tools a voice, a personality, and a purpose.'],
    'MCP Bridges': ['MCP Bridges', 'Turn existing application APIs into secure MCP tools.'],
    Deployments: ['Deployments', 'Bring your agents to the applications your users already love.'],
    Conversations: ['Conversations', 'See how your assistants are helping your users.'],
    Settings: ['Workspace settings', 'Manage the people and access behind your agents.'],
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <Brand />
        <label className="workspace-switch">
          <span className="workspace-avatar">{me.organization.name.slice(0, 1).toUpperCase()}</span>
          <select
            aria-label="Organization"
            value={me.orgId}
            onChange={(e) =>
              void act(async () => {
                await api('/organizations/switch', { orgId: e.target.value });
              }, 'Workspace switched')
            }
          >
            {orgs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
          <ChevronDown size={14} />
        </label>
        <span className="nav-label">WORKSPACE</span>
        <nav>
          {[
            ['Overview', LayoutDashboard],
            ['Agents', Sparkles],
            ['MCP Bridges', Plug],
            ['Deployments', Layers],
            ['Conversations', MessageSquare],
          ].map(([name, Component]) => {
            const NavIcon = Component as typeof Activity;
            return (
              <button
                key={String(name)}
                className={page === name ? 'active' : ''}
                onClick={() => {
                  setPage(String(name));
                  setSearch('');
                }}
              >
                <NavIcon size={18} />
                {String(name)}
                {name === 'Agents' && (
                  <span className="nav-count">{agents.filter((a) => !a.archived).length}</span>
                )}
              </button>
            );
          })}
        </nav>
        <div className="sidebar-bottom">
          <div className="secure-note">
            <div>
              <ShieldCheck size={17} />
              <strong>Secure by default</strong>
            </div>
            <p>
              Every widget. Every API call.
              <br />
              Always authenticated.
            </p>
            <button onClick={() => setModal('guide')}>
              View integration guide <ArrowUpRight size={13} />
            </button>
          </div>
          <button
            className={page === 'Settings' ? 'settings active' : 'settings'}
            onClick={() => setPage('Settings')}
          >
            <Settings size={17} />
            Settings
          </button>
          <div className="profile">
            <span>{me.user.name.slice(0, 2).toUpperCase()}</span>
            <div>
              <strong>{me.user.name}</strong>
              <small>{me.role === 'OWNER' ? 'Workspace owner' : 'Administrator'}</small>
            </div>
            <button
              aria-label="Sign out"
              className="icon-button"
              onClick={() =>
                void act(async () => {
                  await api('/auth/logout', {});
                  setMe(null);
                })
              }
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumb">
            Workspace <ChevronRight size={14} />
            <strong>{page}</strong>
          </div>
          <div className="topbar-right">
            <span className="environment">
              <i /> Workspace live
            </span>
            <button onClick={() => setModal('guide')}>
              <BookOpen size={15} /> Documentation <ArrowUpRight size={13} />
            </button>
          </div>
        </header>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR AI OPERATIONS, CONNECTED</div>
              <h1>{headings[page][0]}</h1>
              <p>{headings[page][1]}</p>
            </div>
            {['Overview', 'Agents'].includes(page) ? (
              <Button onClick={createAgent}>
                <Plus size={16} />
                Create agent
              </Button>
            ) : page === 'Deployments' ? (
              <Button disabled={loading} onClick={() => void newDeployment()}>
                <Plus size={16} />
                New deployment
              </Button>
            ) : null}
          </div>
          {error && !modal && (
            <div className="alert" role="alert">
              {error}
              <button onClick={() => setError('')}>×</button>
            </div>
          )}
          {page === 'MCP Bridges' && (
            <BridgePanel
              key={me.orgId}
              request={api}
              onChange={refresh}
              models={me.models}
              Modal={Modal}
            />
          )}
          {page === 'Overview' && (
            <>
              <section className="hero">
                <div>
                  <span className="hero-label">
                    <span /> FROM ENDPOINT TO EXPERIENCE
                  </span>
                  <h2>
                    Build agents that
                    <br />
                    do more than talk.
                  </h2>
                  <p>
                    Connect your APIs, shape your assistant, and embed
                    <br className="desktop" /> intelligence right into your application.
                  </p>
                  <button onClick={createAgent}>
                    Create your first agent <ArrowRight size={15} />
                  </button>
                </div>
                <div className="flow-art" aria-hidden="true">
                  <div className="flow-grid" />
                  <div className="flow-node flow-api">
                    <Plug size={22} />
                    <span>Your APIs</span>
                    <small>GET · POST · PATCH</small>
                  </div>
                  <div className="flow-link link-one" />
                  <div className="flow-node flow-agent">
                    <Sparkles size={30} />
                    <strong>Your agent</strong>
                    <span>Intelligence, connected</span>
                    <div className="mini-status">
                      <i /> Ready to work
                    </div>
                  </div>
                  <div className="flow-link link-two" />
                  <div className="flow-node flow-app">
                    <Box size={22} />
                    <span>Your app</span>
                    <small>Securely embedded</small>
                  </div>
                  <span className="art-dot dot-one" />
                  <span className="art-dot dot-two" />
                </div>
              </section>
              <div className="stats-grid">
                {[
                  [Sparkles, 'Active agents', overview.agents ?? 0, 'Configured and ready'],
                  [
                    Layers,
                    'Live deployments',
                    overview.deployments ?? 0,
                    'Across your applications',
                  ],
                  [
                    MessageSquare,
                    'Conversations',
                    overview.conversations ?? 0,
                    'Helpful connections made',
                  ],
                  [Zap, 'Tool executions', overview.actions ?? 0, 'Your APIs in action'],
                ].map(([Component, label, value, sub]) => {
                  const StatIcon = Component as typeof Activity;
                  return (
                    <div className="stat" key={String(label)}>
                      <div>
                        <span>{String(label)}</span>
                        <StatIcon size={17} />
                      </div>
                      <strong>{Number(value).toLocaleString()}</strong>
                      <small>{String(sub)}</small>
                    </div>
                  );
                })}
              </div>
              <div className="section-heading">
                <div>
                  <h2>
                    Your agents <span>{agents.filter((a) => !a.archived).length}</span>
                  </h2>
                  <p>A purpose for every assistant.</p>
                </div>
                <button onClick={() => setPage('Agents')}>
                  View all agents <ArrowRight size={14} />
                </button>
              </div>
              {!filteredAgents.length ? (
                <div className="onboarding">
                  <div className="onboarding-art">
                    <Sparkles size={29} />
                    <span className="orbit a" />
                    <span className="orbit b" />
                  </div>
                  <div>
                    <h3>Your next great teammate starts here.</h3>
                    <p>Create an agent, connect a tool, and see what’s possible.</p>
                  </div>
                  <Button secondary onClick={createAgent}>
                    <Plus size={15} />
                    Create an agent
                  </Button>
                </div>
              ) : (
                <div className="agent-grid">
                  {filteredAgents.slice(0, 3).map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      tools={tools}
                      onEdit={() => {
                        setSelected(a);
                        setModal('agent');
                      }}
                      onPublish={() => void publish(a)}
                      onArchive={() => {
                        setSelected(a);
                        setModal('archive');
                      }}
                    />
                  ))}
                </div>
              )}
              <div className="bottom-grid">
                <section className="surface">
                  <div className="section-heading compact">
                    <h2>Recent activity</h2>
                    <Activity size={16} />
                  </div>
                  {!overview.events?.length ? (
                    <div className="quiet">
                      <span>
                        <Activity size={22} />
                      </span>
                      <p>A fresh start, a clear workspace.</p>
                      <small>Your agent activity will appear here.</small>
                    </div>
                  ) : (
                    <div className="activity-list">
                      {overview.events.slice(0, 5).map((e: Row) => (
                        <div key={e.id}>
                          <span className="activity-icon">
                            <Zap size={14} />
                          </span>
                          <div>
                            <strong>
                              {tools.find((t) => t.id === e.toolId)?.definition.name ??
                                'Tool execution'}
                            </strong>
                            <small>{e.status.replaceAll('_', ' ').toLowerCase()}</small>
                          </div>
                          <time>
                            {new Date(e.createdAt).toLocaleTimeString([], {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </time>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
                <section className="surface checklist">
                  <span className="eyebrow">YOUR LAUNCH CHECKLIST</span>
                  <h2>From idea to embedded.</h2>
                  {[
                    [
                      'Create an agent',
                      'Give your assistant a name and purpose.',
                      agents.length > 0,
                      () => createAgent(),
                    ],
                    [
                      'Set up an MCP bridge',
                      'Review and publish the tools your agent can use.',
                      tools.some((t) => t.enabled && t.bridgeRevisionId),
                      () => setPage('MCP Bridges'),
                    ],
                    [
                      'Deploy your widget',
                      'Make it part of your application.',
                      deployments.length > 0,
                      () => setPage('Deployments'),
                    ],
                  ].map(([title, sub, done, click], i) => (
                    <button key={String(title)} onClick={click as () => void}>
                      <span className={done ? 'step done' : 'step'}>
                        {done ? <Check size={14} /> : i + 1}
                      </span>
                      <span>
                        <strong>{String(title)}</strong>
                        <small>{String(sub)}</small>
                      </span>
                      <ChevronRight size={14} />
                    </button>
                  ))}
                </section>
              </div>
            </>
          )}
          {page === 'Agents' && (
            <>
              <div className="toolbar">
                <span>{filteredAgents.length} agents in this workspace</span>
                <label className="search">
                  <Search size={16} />
                  <input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search agents"
                    aria-label="Search agents"
                  />
                </label>
              </div>
              {filteredAgents.length ? (
                <div className="agent-grid">
                  {filteredAgents.map((a) => (
                    <AgentCard
                      key={a.id}
                      agent={a}
                      tools={tools}
                      onEdit={() => {
                        setSelected(a);
                        setModal('agent');
                      }}
                      onPublish={() => void publish(a)}
                      onArchive={() => {
                        setSelected(a);
                        setModal('archive');
                      }}
                    />
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<Sparkles />}
                  title="A workspace full of possibilities"
                  description="Create your first agent with a custom prompt and the tools it needs."
                  action={
                    <Button onClick={createAgent}>
                      <Plus size={15} />
                      Create agent
                    </Button>
                  }
                />
              )}
            </>
          )}
          {page === 'Deployments' && (
            <>
              {deployments.length ? (
                <div className="deployment-grid">
                  {deployments.map((d) => (
                    <div className="deployment-card" key={d.id}>
                      <div
                        className="deployment-preview"
                        style={{ '--preview-color': d.theme.color } as React.CSSProperties}
                      >
                        <div className="browser-dots">
                          <i />
                          <i />
                          <i />
                        </div>
                        <div className="preview-lines">
                          <span />
                          <span />
                          <span />
                        </div>
                        <div className={`preview-widget ${d.theme.template}`}>
                          <span>✦</span>
                          {d.theme.template === 'inline' && (
                            <div>
                              <strong>{d.theme.title}</strong>
                              <small>How can I help you?</small>
                            </div>
                          )}
                        </div>
                      </div>
                      <div className="deployment-body">
                        <div className="card-top">
                          <h3>{d.name}</h3>
                          <span className={`badge ${d.active ? 'green' : ''}`}>
                            <i />
                            {d.active ? 'Live' : 'Paused'}
                          </span>
                        </div>
                        <p>
                          {d.theme.template === 'floating'
                            ? 'Floating assistant'
                            : 'Inline chat panel'}{' '}
                          · {d.origins.length} allowed origin{d.origins.length !== 1 ? 's' : ''}
                        </p>
                        <div className="origin">
                          <Globe size={13} />
                          {d.origins[0]}
                        </div>
                        <div className="card-actions">
                          <button
                            onClick={() => {
                              setSelected(d);
                              setModal('embed');
                            }}
                          >
                            <Code2 size={14} />
                            Get embed code
                          </button>
                          <button
                            onClick={() => {
                              setSelected(d);
                              setModal('playground');
                            }}
                          >
                            <Play size={13} />
                            Test
                          </button>
                          <button
                            aria-label={`Settings for ${d.name}`}
                            onClick={async () => {
                              const list = (
                                await Promise.all(
                                  agents
                                    .filter((a) => !a.archived)
                                    .map((a) => api(`/agents/${a.id}/versions`)),
                                )
                              ).flat();
                              setVersions(
                                list.filter(
                                  (v) =>
                                    v.id === d.versionId ||
                                    (v.config.tools ?? []).every((t: Row) => t.bridgeRevisionId),
                                ),
                              );
                              setSelected(d);
                              setModal('deployment');
                            }}
                          >
                            <Settings size={14} />
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <Empty
                  icon={<Layers />}
                  title="Your assistant, everywhere you need it"
                  description="Publish an agent, create a deployment, then paste a small snippet into your application."
                  action={<Button onClick={() => void newDeployment()}>New deployment</Button>}
                />
              )}
            </>
          )}
          {page === 'Conversations' && (
            <>
              {conversations.length ? (
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Conversation</th>
                        <th>Host user</th>
                        <th>Application</th>
                        <th>Started</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {conversations.map((c) => (
                        <tr key={c.id}>
                          <td>
                            <MessageSquare size={14} />
                            <code>{c.id.slice(-10)}</code>
                          </td>
                          <td>{c.userId}</td>
                          <td>
                            {deployments.find((d) => d.id === c.deploymentId)?.name ?? 'Deployment'}
                          </td>
                          <td>{new Date(c.createdAt).toLocaleString()}</td>
                          <td>
                            <button
                              className="text-button"
                              onClick={async () => {
                                setMessages(await api(`/conversations/${c.id}`));
                                setModal('history');
                              }}
                            >
                              View transcript
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <Empty
                  icon={<MessageSquare />}
                  title="Every conversation starts with a hello"
                  description="Conversations from your deployed widgets will appear here."
                />
              )}
            </>
          )}
          {page === 'Settings' && (
            <div className="settings-grid">
              <section className="surface settings-card">
                <h2>Workspace</h2>
                <Field label="Organization">
                  <input readOnly value={me.organization.name} />
                </Field>
                <Field label="Your email">
                  <input readOnly value={me.user.email} />
                </Field>
                <div className="info-strip">
                  <ShieldCheck size={18} />
                  <span>
                    Role: {me.role.toLowerCase()}. Organization data is isolated on every request.
                  </span>
                </div>
                <h3>Model access</h3>
                <p className="muted">Enabled by the platform administrator.</p>
                {me.models.map((m: string) => (
                  <span className="badge" key={m}>
                    {m}
                  </span>
                ))}
              </section>
              <section className="surface settings-card">
                <h2>Workspace members</h2>
                <p className="muted">
                  Owners can add people who already have a CornerstoneLabs AO account.
                </p>
                {members.map((m) => (
                  <div className="member" key={m.id}>
                    <span className="member-avatar">{m.user?.name.slice(0, 1)}</span>
                    <div>
                      <strong>{m.user?.name}</strong>
                      <small>{m.user?.email}</small>
                    </div>
                    <span className="badge">{m.role.toLowerCase()}</span>
                    {me.role === 'OWNER' && m.role === 'ADMIN' && (
                      <button
                        aria-label={`Remove ${m.user?.name}`}
                        className="icon-button"
                        onClick={() =>
                          void act(
                            () => api(`/members/${m.id}`, undefined, 'DELETE'),
                            'Member removed',
                          )
                        }
                      >
                        <X size={14} />
                      </button>
                    )}
                  </div>
                ))}
                {me.role === 'OWNER' && (
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      void act(
                        () => api('/members', { email: f.get('email') }),
                        'Administrator added',
                      );
                      e.currentTarget.reset();
                    }}
                  >
                    <Field label="Add administrator">
                      <input
                        name="email"
                        type="email"
                        required
                        placeholder="teammate@company.com"
                      />
                    </Field>
                    <Button type="submit" secondary>
                      <Users size={14} />
                      Add member
                    </Button>
                  </form>
                )}
              </section>
            </div>
          )}
          <footer className="page-footer">
            <span>
              <Workflow size={13} /> Built for capable agents. Designed for your control.
            </span>
            <span>CornerstoneLabs AO / v0.1</span>
          </footer>
        </main>
      </div>
      {toast && (
        <div className="toast" role="status">
          <CheckCircle2 size={17} />
          {toast}
        </div>
      )}
      {modal === 'agent' && (
        <Modal
          title={selected ? 'Edit agent' : 'Create an agent'}
          subtitle="A clear purpose is the start of a capable assistant."
          close={close}
          wide
        >
          <AgentEditor
            initial={selected?.draft}
            models={me.models}
            tools={tools}
            error={error}
            busy={loading}
            onSubmit={(data) =>
              void act(async () => {
                await api(
                  selected ? `/agents/${selected.id}` : '/agents',
                  data,
                  selected ? 'PATCH' : 'POST',
                );
                close();
              }, 'Agent draft saved')
            }
          />
        </Modal>
      )}
      {modal === 'archive' && (
        <Modal
          title="Archive this agent?"
          subtitle="Live deployments of this agent will stop accepting requests."
          close={close}
        >
          <p>
            Archive <strong>{selected?.draft.name}</strong>?
          </p>
          {error && <div className="alert">{error}</div>}
          <div className="form-actions">
            <Button secondary onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={loading}
              onClick={() =>
                void act(async () => {
                  await api(`/agents/${selected?.id}/archive`, {});
                  close();
                }, 'Agent archived')
              }
            >
              Archive agent
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'deployment' && (
        <Modal
          title={selected ? 'Deployment settings' : 'Deploy an agent'}
          subtitle="Choose a published agent version and customize its widget."
          close={close}
          wide
        >
          <DeploymentEditor
            initial={selected}
            versions={versions}
            error={error}
            busy={loading}
            onSubmit={(data) =>
              void act(
                async () => {
                  if (selected) {
                    await api(
                      `/deployments/${selected.id}`,
                      { versionId: data.versionId, origins: data.origins, theme: data.theme },
                      'PATCH',
                    );
                    close();
                  } else {
                    const d = await api('/deployments', data);
                    setSelected(d);
                    setSecret(d.integrationKey);
                    setModal('embed');
                  }
                },
                selected ? 'Deployment updated' : 'Deployment created',
              )
            }
          />
          {selected && (
            <div className="danger-zone">
              <Button
                secondary
                onClick={() =>
                  void act(async () => {
                    await api(`/deployments/${selected.id}`, { active: !selected.active }, 'PATCH');
                    close();
                  }, 'Deployment updated')
                }
              >
                {selected.active ? 'Pause deployment' : 'Activate deployment'}
              </Button>
              {me.role === 'OWNER' && (
                <Button
                  secondary
                  onClick={() => {
                    setModal('rotate');
                  }}
                >
                  <KeyRound size={14} />
                  Rotate integration key
                </Button>
              )}
            </div>
          )}
        </Modal>
      )}
      {modal === 'rotate' && (
        <Modal
          title="Rotate integration key?"
          subtitle="This revokes all current widget sessions. Update the host backend with the new key."
          close={close}
        >
          {error && <div className="alert">{error}</div>}
          <div className="form-actions">
            <Button secondary onClick={close}>
              Cancel
            </Button>
            <Button
              disabled={loading}
              onClick={() =>
                void act(async () => {
                  const r = await api(`/deployments/${selected?.id}/rotate-key`, {});
                  setSecret(r.integrationKey);
                  setModal('embed');
                }, 'Integration key rotated')
              }
            >
              Rotate key
            </Button>
          </div>
        </Modal>
      )}
      {modal === 'embed' && (
        <Modal
          title="Bring your agent to your app"
          subtitle="Paste one script into any page of your connected application."
          close={close}
          wide
        >
          <EmbedInstallation
            deployment={selected!}
            secret={secret}
            copy={copy}
            onReplaceKey={me.role === 'OWNER' ? () => setModal('rotate') : undefined}
          />
        </Modal>
      )}
      {modal === 'playground' && (
        <Modal
          title="Test your deployed agent"
          subtitle={
            selected?.authMode === 'bridge-session'
              ? 'Test MCP tools as a signed-in application user.'
              : 'Test an existing deployment with a short-lived delegated user token.'
          }
          close={close}
          wide
        >
          {selected?.authMode === 'bridge-session' ? (
            <div className="guide">
              <p>
                Open your host application, sign in, and use its assistant. Expand{' '}
                <strong>Test permitted API tools</strong> to test discovery and operations through
                the managed MCP bridge.
              </p>
              <p>
                The host connector supplies verified identity and credentials. Writes require
                confirmation; no owner credential is substituted here.
              </p>
            </div>
          ) : (
            <Playground deployment={selected!} tools={tools} />
          )}
        </Modal>
      )}
      {modal === 'history' && (
        <Modal title="Conversation transcript" close={close} wide>
          <div className="transcript">
            {messages.length ? (
              messages.map((m) => (
                <div className={`transcript-message ${m.role}`} key={m.id}>
                  <span>{m.role}</span>
                  <p>{m.content}</p>
                  <small>{new Date(m.createdAt).toLocaleString()}</small>
                </div>
              ))
            ) : (
              <p className="muted">No messages yet.</p>
            )}
          </div>
        </Modal>
      )}
      {modal === 'guide' && (
        <Modal
          title="Secure widget integration"
          subtitle="A small snippet. A trusted backend. Your users’ existing permissions."
          close={close}
          wide
        >
          <div className="guide">
            <h3>1. Publish the assistant</h3>
            <p>
              In MCP Bridges, review the operations, publish the bridge, and create a deployment.
            </p>
            <h3>2. Download the install kit</h3>
            <p>
              In Deployments, choose Get embed code and your backend language. Send the kit to your
              app developer and share the server key separately.
            </p>
            <h3>3. Install and test in the app</h3>
            <p>
              Follow the kit to connect your app’s login and add the widget. Sign in, try a read in
              Test permitted API tools, and verify the assistant disappears on logout.
            </p>
            <div className="info-strip">
              <Terminal size={19} />
              <span>See the repository README to start an optional demo host.</span>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function AgentCard({
  agent,
  tools,
  onEdit,
  onPublish,
  onArchive,
}: {
  agent: Row;
  tools: Row[];
  onEdit: () => void;
  onPublish: () => void;
  onArchive: () => void;
}) {
  return (
    <article className="agent-card">
      <div className="card-top">
        <span className="agent-avatar">
          {agent.draft.avatar ? <img src={agent.draft.avatar} alt="" /> : <Sparkles size={23} />}
        </span>
        <span className="badge purple">Draft</span>
        <button
          className="icon-button"
          aria-label={`Archive ${agent.draft.name}`}
          onClick={onArchive}
        >
          <Trash2 size={14} />
        </button>
      </div>
      <h3>{agent.draft.name}</h3>
      <p>{agent.draft.description || 'A capable assistant, ready for your application.'}</p>
      <div className="agent-meta">
        <span>
          <Plug size={13} />
          {agent.draft.toolIds.length} tools
        </span>
        <span>
          <Box size={13} />
          {agent.draft.model}
        </span>
      </div>
      <div className="tool-tags">
        {agent.draft.toolIds.slice(0, 2).map((id: string) => (
          <span key={id}>{tools.find((t) => t.id === id)?.definition.name ?? 'Tool'}</span>
        ))}
      </div>
      <div className="card-actions">
        <button onClick={onEdit}>
          <Settings size={14} />
          Configure
        </button>
        <button onClick={onPublish}>
          Publish version
          <ArrowUpRight size={13} />
        </button>
      </div>
    </article>
  );
}
function AgentEditor({
  initial,
  models,
  tools,
  onSubmit,
  error,
  busy,
}: {
  initial?: Row;
  models: string[];
  tools: Row[];
  onSubmit: (v: Row) => void;
  error: string;
  busy: boolean;
}) {
  const [avatar, setAvatar] = useState(initial?.avatar ?? ''),
    [toolIds, setToolIds] = useState<string[]>(initial?.toolIds ?? []),
    [localError, setLocalError] = useState('');
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        onSubmit({
          ...f,
          avatar,
          starters: String(f.starters)
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          toolIds,
        });
      }}
    >
      <div className="form-columns">
        <div>
          <Field label="Agent name">
            <input
              name="name"
              defaultValue={initial?.name}
              required
              placeholder="Customer success assistant"
              maxLength={100}
            />
          </Field>
          <Field label="Description">
            <input
              name="description"
              defaultValue={initial?.description}
              placeholder="Helps customers manage their account"
              maxLength={1000}
            />
          </Field>
        </div>
        <div>
          <Field label="Model">
            <select name="model" defaultValue={initial?.model ?? models[0]}>
              {models.map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </Field>
          <Field label="Avatar" hint="PNG, JPEG, or WebP, up to 140 KB">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 140000) {
                  setLocalError('Avatar must be under 140 KB');
                  return;
                }
                const r = new FileReader();
                r.onload = () => {
                  setAvatar(String(r.result));
                  setLocalError('');
                };
                r.readAsDataURL(file);
              }}
            />
          </Field>
        </div>
      </div>
      <Field
        label="System prompt"
        hint="Describe your agent’s role, tone, and responsibilities. Permissions are enforced separately."
      >
        <textarea
          name="prompt"
          required
          rows={6}
          defaultValue={
            initial?.prompt ??
            'You are a helpful assistant for this application. Use the available tools to help the user. Explain proposed changes clearly and respect the user’s decisions.'
          }
          maxLength={20000}
        />
      </Field>
      <div className="form-columns">
        <Field label="Welcome message">
          <textarea
            name="welcome"
            rows={3}
            maxLength={500}
            defaultValue={initial?.welcome ?? 'Hi! How can I help you today?'}
          />
        </Field>
        <Field label="Conversation starters" hint="One per line, up to four">
          <textarea
            name="starters"
            rows={3}
            defaultValue={initial?.starters?.join('\n') ?? 'What can you help me with?'}
            maxLength={804}
          />
        </Field>
      </div>
      <div className="field">
        <span>Permitted tools</span>
        <small>
          Select enabled MCP tools from published bridge revisions. Remove unavailable selections
          before saving.
        </small>
        <div className="tool-picker">
          {tools.filter((t) => (t.enabled && t.bridgeRevisionId) || toolIds.includes(t.id))
            .length ? (
            tools
              .filter((t) => (t.enabled && t.bridgeRevisionId) || toolIds.includes(t.id))
              .map((t) => (
                <label key={t.id}>
                  <input
                    type="checkbox"
                    checked={toolIds.includes(t.id)}
                    disabled={!t.bridgeRevisionId && !toolIds.includes(t.id)}
                    onChange={(e) =>
                      setToolIds((ids) =>
                        e.target.checked ? [...ids, t.id] : ids.filter((x) => x !== t.id),
                      )
                    }
                  />
                  <span>
                    <strong>
                      {t.definition.name}
                      {!t.bridgeRevisionId
                        ? ' (direct tool — migrate or remove)'
                        : !t.enabled && ' (disabled — remove)'}
                    </strong>
                    <small>
                      {t.definition.method} {t.definition.path}
                    </small>
                  </span>
                  <span className="badge">{t.definition.kind}</span>
                </label>
              ))
          ) : (
            <p className="muted">
              Publish an MCP bridge to add capabilities. You can save a chat-only agent without
              tools.
            </p>
          )}
        </div>
      </div>
      {(error || localError) && <div className="alert">{error || localError}</div>}
      <div className="form-actions">
        <span className="muted">
          <ShieldCheck size={13} /> Writes always require confirmation
        </span>
        <Button type="submit" disabled={busy}>
          Save draft <Check size={15} />
        </Button>
      </div>
    </form>
  );
}
function DeploymentEditor({
  initial,
  versions,
  error,
  busy,
  onSubmit,
}: {
  initial: Row | null;
  versions: Row[];
  error: string;
  busy: boolean;
  onSubmit: (v: Row) => void;
}) {
  const [theme, setTheme] = useState(initial?.theme ?? blankTheme);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        const f = Object.fromEntries(new FormData(e.currentTarget));
        onSubmit({
          name: f.name,
          versionId: f.versionId,
          origins: String(f.origins)
            .split('\n')
            .map((x) => x.trim())
            .filter(Boolean),
          theme,
        });
      }}
    >
      {!versions.length && (
        <div className="notice">Publish an agent version before creating a deployment.</div>
      )}
      <div className="form-columns">
        <Field label="Deployment name">
          <input
            name="name"
            defaultValue={initial?.name}
            required
            placeholder="Customer portal assistant"
            disabled={!!initial}
          />
        </Field>
        <Field label="Published agent version">
          <select name="versionId" defaultValue={initial?.versionId} required>
            <option value="">Select a version</option>
            {versions.map((v) => (
              <option key={v.id} value={v.id}>
                {v.config.name} · v{v.number}
              </option>
            ))}
          </select>
        </Field>
      </div>
      <Field
        label="Allowed application origins"
        hint="One exact origin per line. HTTPS required, except localhost during development."
      >
        <textarea
          name="origins"
          rows={3}
          defaultValue={initial?.origins.join('\n') ?? ''}
          required
        />
      </Field>
      <div className="template-picker">
        {[
          ['floating', 'Floating assistant', MessageSquare],
          ['inline', 'Inline chat panel', LayoutDashboard],
        ].map(([value, label, Component]) => {
          const I = Component as typeof Activity;
          return (
            <button
              type="button"
              key={String(value)}
              className={theme.template === value ? 'chosen' : ''}
              onClick={() => setTheme({ ...theme, template: value })}
            >
              <I size={22} />
              <strong>{String(label)}</strong>
              <small>
                {value === 'floating'
                  ? 'A helpful presence in the corner'
                  : 'An assistant built into your page'}
              </small>
              {theme.template === value && <CheckCircle2 size={16} />}
            </button>
          );
        })}
      </div>
      <div className="form-columns">
        <Field label="Assistant title">
          <input
            value={theme.title}
            onChange={(e) => setTheme({ ...theme, title: e.target.value })}
            maxLength={100}
          />
        </Field>
        <Field label="Brand color">
          <div className="color-field">
            <input
              type="color"
              value={theme.color}
              onChange={(e) => setTheme({ ...theme, color: e.target.value })}
            />
            <code>{theme.color}</code>
          </div>
        </Field>
        <Field label="Appearance">
          <select value={theme.mode} onChange={(e) => setTheme({ ...theme, mode: e.target.value })}>
            {['light', 'dark', 'auto'].map((x) => (
              <option key={x}>{x}</option>
            ))}
          </select>
        </Field>
        <Field label="Position">
          <select
            value={theme.position}
            onChange={(e) => setTheme({ ...theme, position: e.target.value })}
          >
            <option value="right">Bottom right</option>
            <option value="left">Bottom left</option>
          </select>
        </Field>
      </div>
      {error && <div className="alert">{error}</div>}
      <div className="form-actions">
        <Button type="submit" disabled={busy || !versions.length}>
          {initial ? 'Save deployment' : 'Create deployment'}
          <ArrowRight size={15} />
        </Button>
      </div>
    </form>
  );
}
function EmbedInstallation({
  deployment,
  secret,
  copy,
  onReplaceKey,
}: {
  deployment: Row;
  secret: string;
  copy: (value: string) => Promise<void>;
  onReplaceKey?: () => void;
}) {
  const [tab, setTab] = useState<'embed' | 'server'>(secret ? 'server' : 'embed');
  const [authMode, setAuthMode] = useState<string>();
  const [authError, setAuthError] = useState('');
  const [integration, setIntegration] = useState<Row | null>(null);
  useEffect(() => {
    api(`/deployments/${deployment.id}/integration`)
      .then((data) => {
        setAuthMode(data.authMode ?? 'exchange');
        setIntegration(data);
      })
      .catch((error) => setAuthError(error.message));
  }, [deployment.id]);
  const snippet = `<script src="${widgetOrigin}/loader.js" data-deployment="${deployment.id}"${authMode === 'hris-jwt' ? ' data-auth="hris-jwt"' : ''} defer></script>`;
  const serverCode = `// app/assistant/session/route.ts — server only (Next.js example)
import { createRelaySessionHandler } from '@/lib/relay-server.mjs';
import { getRelayHostSession } from '@/lib/auth';

export const POST = createRelaySessionHandler({
  relayOrigin: ${JSON.stringify(widgetOrigin)},
  applicationOrigin: ${JSON.stringify(deployment.origins[0])},
  deploymentId: ${JSON.stringify(deployment.id)},
  integrationKey: process.env.RELAY_INTEGRATION_KEY!,
  getSession: getRelayHostSession,
  allowLocalhost: process.env.NODE_ENV !== 'production',
});`;
  if (!authMode)
    return <div className="notice">{authError || 'Loading authentication configuration…'}</div>;
  if (authMode === 'bridge-session' && integration)
    return (
      <BridgeInstallation
        deploymentId={deployment.id}
        endpoint={integration.sessionEndpoint}
        origins={integration.origins ?? deployment.origins}
        tenantId={integration.tenantId ?? ''}
        widgetOrigin={widgetOrigin}
        secret={secret}
        onReplaceKey={onReplaceKey}
      />
    );
  if (authMode === 'hris-jwt')
    return (
      <div className="guide">
        <div className="notice">
          First-party HRIS authentication is enabled. This widget uses signed user-context JWTs
          directly; no integration-key exchange is used.
        </div>
        <h3>Embed the HRIS assistant</h3>
        <pre>{snippet}</pre>
        <Button onClick={() => void copy(snippet)}>
          <Copy size={14} /> Copy embed script
        </Button>
        <h3>HRIS backend setup</h3>
        <p>
          Expose GET /api/internal/chat/session using your existing login and GET
          /.well-known/jwks.json for public signing keys. Return user_context_token and expiresAt.
          AO must trust the configured issuer, tenant-to-organization mapping, and exact embedding
          origin.
        </p>
        <p>
          Issue tool scopes as tool:operation_name. Internal action endpoints must verify both the
          AO service credential and X-User-Context, enforce record ownership, and use the verified
          tenant. Tokens refresh in the background every eight minutes.
        </p>
        <p>
          Test this deployment inside the authenticated HRIS application. The legacy delegated-token
          playground is disabled in first-party mode.
        </p>
      </div>
    );
  return (
    <div>
      <div className="install-tabs" role="tablist" aria-label="Installation steps">
        <button role="tab" aria-selected={tab === 'embed'} onClick={() => setTab('embed')}>
          <Code2 size={15} />
          Embed widget
        </button>
        <button role="tab" aria-selected={tab === 'server'} onClick={() => setTab('server')}>
          <ShieldCheck size={15} />
          One-time server setup
        </button>
      </div>
      {tab === 'embed' ? (
        <div role="tabpanel" aria-label="Embed widget">
          <div className="info-strip">
            <ShieldCheck size={18} />
            <span>
              One-time connection first, then copy and paste. The widget appears only for users
              verified by your application’s server.
            </span>
          </div>
          <Field
            label="Embed snippet"
            hint="Paste before the closing body tag. For an inline widget, put it inside the desired container."
          >
            <textarea readOnly rows={4} value={snippet} />
          </Field>
          <Button onClick={() => void copy(snippet)}>
            <Copy size={14} />
            Copy embed script
          </Button>
          {secret && (
            <div className="notice install-notice">
              Your new server integration key is available once.{' '}
              <button className="text-button" onClick={() => setTab('server')}>
                Open server setup and save it securely.
              </button>
            </div>
          )}
          <p className="muted install-help">
            No secrets or tool IDs go in this script. Branding and published capabilities are
            managed in CornerstoneLabs AO. A developer connects your existing login once per
            deployment and application backend.
          </p>
          <button className="text-button" onClick={() => setTab('server')}>
            First installation? Set up the secure server connector <ArrowRight size={14} />
          </button>
        </div>
      ) : (
        <div role="tabpanel" aria-label="One-time server setup">
          <div className="notice">
            For your application developer. A public script cannot verify another application’s
            private login session. Connect the server once; users can then paste the public script
            on any page.
          </div>
          {secret ? (
            <div className="secret-box">
              <strong>
                <KeyRound size={15} />
                Server integration key — shown once
              </strong>
              <p>
                Save as RELAY_INTEGRATION_KEY on your host backend. For Taskboard, use
                SAMPLE_INTEGRATION_KEY. Never put it in HTML.
              </p>
              <div>
                <code>{secret}</code>
                <button aria-label="Copy integration key" onClick={() => void copy(secret)}>
                  <Copy size={15} />
                </button>
              </div>
            </div>
          ) : (
            <div className="notice">
              <strong>The original integration key cannot be shown again.</strong>
              <p style={{ margin: '9px 0' }}>
                It was displayed once when this deployment was created. Use your saved key, or
                generate a replacement if you no longer have it. Replacing it revokes existing
                widget sessions and requires updating your host server.
              </p>
              {onReplaceKey ? (
                <Button secondary onClick={onReplaceKey}>
                  <KeyRound size={14} /> Generate replacement key
                </Button>
              ) : (
                <p>Ask your workspace owner to generate a replacement key.</p>
              )}
            </div>
          )}
          <h3>1. Add the server connector</h3>
          <p className="muted">
            Download this server-only module into your application as lib/relay-server.mjs. It
            handles origin checks, token exchange, expiry, and logout races.
          </p>
          <a
            className="button secondary"
            href={`${widgetOrigin}/relay-server.mjs`}
            download="relay-server.mjs"
          >
            <ArrowDownLeft size={14} />
            Download server connector
          </a>
          <h3>2. Connect your existing login</h3>
          <p className="muted">
            Implement getRelayHostSession on your server. Return null for logged-out or unauthorized
            users, or return the verified userId, user-scoped apiToken, expiresAt, and an isActive
            function that rechecks the same host session. Never use browser identity fields.
          </p>
          <Field label="Server route (Next.js example)">
            <textarea rows={15} readOnly className="code-editor" value={serverCode} />
          </Field>
          <Button secondary onClick={() => void copy(serverCode)}>
            <Copy size={14} />
            Copy server example
          </Button>
          <h3>3. Connect logout once</h3>
          <p className="muted">
            Call window.OrchestratorWidget?.logout() from host logout and revoke issued widget
            sessions on your server. The sample Taskboard application already implements both.
          </p>
          <div className="info-strip">
            <Terminal size={18} />
            <span>
              For Taskboard on localhost:3002, set SAMPLE_DEPLOYMENT_ID and SAMPLE_INTEGRATION_KEY
              once, then restart the host. Tool IDs are selected automatically.
            </span>
          </div>
          <details className="install-advanced">
            <summary>Advanced: restrict tool access</summary>
            <IntegrationToolIds deploymentId={deployment.id} />
          </details>
        </div>
      )}
    </div>
  );
}

function IntegrationToolIds({ deploymentId }: { deploymentId: string }) {
  const [details, setDetails] = useState<Row | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api(`/deployments/${deploymentId}/integration`)
      .then(setDetails)
      .catch((e) => setError(e.message));
  }, [deploymentId]);
  if (error) return <div className="alert">{error}</div>;
  if (!details) return <p className="muted">Loading published tool IDs…</p>;
  return (
    <div style={{ marginTop: 22 }}>
      <Field
        label="Published tool IDs"
        hint="Optional: restrict the server connector to a subset. Otherwise it uses the published, enabled tools; your API still enforces user permissions."
      >
        <textarea readOnly rows={3} value={details.toolIds.join(',')} />
      </Field>
      <p className="muted">
        {details.tools.map((t: Row) => t.name).join(' · ') || 'This agent has no API tools.'}
      </p>
    </div>
  );
}
function Playground({ deployment, tools }: { deployment: Row; tools: Row[] }) {
  const [session, setSession] = useState<Row | null>(null),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const frame = useRef<HTMLIFrameElement>(null),
    sref = useRef<Row | null>(null);
  function deliver() {
    if (!sref.current) return;
    frame.current?.contentWindow?.postMessage(
      {
        type: 'orchestrator:init',
        deploymentId: deployment.id,
        token: sref.current.token,
        expiresAt: sref.current.expiresAt,
        hostOrigin: location.origin,
      },
      widgetOrigin,
    );
  }
  useEffect(() => {
    const listener = (e: MessageEvent) => {
      if (e.source !== frame.current?.contentWindow || e.origin !== widgetOrigin) return;
      if (e.data?.type === 'orchestrator:ready') deliver();
      if (e.data?.type === 'orchestrator:unauthorized') {
        setSession(null);
        setError('Session expired. Start a new test session.');
      }
    };
    window.addEventListener('message', listener);
    return () => {
      window.removeEventListener('message', listener);
      if (sref.current)
        void fetch(`${widgetOrigin}/v1/widget/revoke`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${sref.current.token}`,
            'x-host-origin': location.origin,
          },
        });
    };
  }, []);
  return session ? (
    <iframe
      className="playground"
      title="Agent playground"
      ref={frame}
      sandbox="allow-scripts allow-same-origin"
      src={`${widgetOrigin}/embed/${deployment.id}`}
      onLoad={deliver}
    />
  ) : (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError('');
        const f = new FormData(e.currentTarget);
        try {
          const versions = await api(`/agents`);
          const all = (
            await Promise.all(versions.map((a: Row) => api(`/agents/${a.id}/versions`)))
          ).flat();
          const version = all.find((v: Row) => v.id === deployment.versionId);
          const s = await api(`/deployments/${deployment.id}/test-session`, {
            apiToken: f.get('apiToken'),
            apiTokenExpiresAt: new Date(String(f.get('expiry'))).toISOString(),
            toolIds: version.config.toolIds.filter((id: string) =>
              tools.some((t) => t.id === id && t.enabled),
            ),
          });
          sref.current = s;
          setSession(s);
        } catch (e: any) {
          setError(e.message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <Field label="Delegated test-user API token">
        <input name="apiToken" type="password" required autoComplete="off" />
      </Field>
      <Field label="Token expires at (your local time)">
        <input
          name="expiry"
          type="datetime-local"
          required
          defaultValue={new Date(Date.now() + 300000 - new Date().getTimezoneOffset() * 60000)
            .toISOString()
            .slice(0, 16)}
        />
      </Field>
      {error && <div className="alert">{error}</div>}
      <Button disabled={busy} type="submit">
        <Play size={14} />
        Start test session
      </Button>
    </form>
  );
}
