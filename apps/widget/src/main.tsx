import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import './style.css';
const deploymentId = decodeURIComponent(location.pathname.split('/').pop() ?? '');
type Auth = { token: string; hostOrigin: string; expiresAt: string };
type Message = { role: string; content: string };
function App() {
  const [auth, setAuth] = useState<Auth | null>(null),
    [cfg, setCfg] = useState<any>(null),
    [open, setOpen] = useState(false),
    [conversation, setConversation] = useState<string | null>(null),
    [messages, setMessages] = useState<Message[]>([]),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [status, setStatus] = useState(''),
    [pending, setPending] = useState<any>(null);
  const authRef = useRef<Auth | null>(null),
    identity = useRef(''),
    bottom = useRef<HTMLDivElement>(null),
    input = useRef<HTMLInputElement>(null),
    abort = useRef<AbortController | null>(null);
  const [testTools, setTestTools] = useState<any[]>([]),
    [testId, setTestId] = useState(''),
    [testArgs, setTestArgs] = useState('{}'),
    [showTest, setShowTest] = useState(false);
  function hide(a = authRef.current) {
    abort.current?.abort();
    if (a) parent.postMessage({ type: 'orchestrator:unauthorized' }, a.hostOrigin);
    authRef.current = null;
    setAuth(null);
    setCfg(null);
    setMessages([]);
    setPending(null);
  }
  async function api(path: string, body?: unknown, a = authRef.current, signal?: AbortSignal) {
    if (!a) throw new Error('Authentication required');
    const r = await fetch(`/v1/widget${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${a.token}`,
        'x-host-origin': a.hostOrigin,
        'x-deployment-id': deploymentId,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    if (r.status === 401 || r.status === 403) {
      hide(a);
      throw new Error('Assistant session is unavailable');
    }
    if (!r.ok) throw new Error((await r.json()).error ?? 'Request failed');
    return r;
  }
  useEffect(() => {
    const listener = async (event: MessageEvent) => {
      const d = event.data;
      if (
        event.source !== parent ||
        d?.type !== 'orchestrator:init' ||
        d.deploymentId !== deploymentId ||
        d.hostOrigin !== event.origin ||
        typeof d.token !== 'string'
      )
        return;
      const a = { token: d.token, hostOrigin: event.origin, expiresAt: d.expiresAt };
      try {
        const config = await (await api('/config', undefined, a)).json();
        if (identity.current && identity.current !== config.identity) {
          abort.current?.abort();
          setConversation(null);
          setMessages([]);
          setPending(null);
        }
        identity.current = config.identity;
        authRef.current = a;
        setAuth(a);
        setCfg(config);
        if (config.theme.template === 'inline') setOpen(true);
      } catch {
        hide(a);
      }
    };
    window.addEventListener('message', listener);
    parent.postMessage({ type: 'orchestrator:ready' }, '*');
    return () => window.removeEventListener('message', listener);
  }, []);
  useEffect(() => {
    if (!auth) return;
    const t = setTimeout(() => hide(auth), Math.max(0, Date.parse(auth.expiresAt) - Date.now()));
    return () => clearTimeout(t);
  }, [auth]);
  useEffect(() => {
    if (auth) parent.postMessage({ type: 'orchestrator:resize', open }, auth.hostOrigin);
    if (open) input.current?.focus();
  }, [open, auth]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pending, status]);
  async function send(approval?: boolean, testing = false) {
    if (busy || !auth) return;
    const userText = testing ? 'Test selected application operation' : text.trim();
    if (approval === undefined && !userText) return;
    setBusy(true);
    setError('');
    setStatus('Thinking…');
    let assistantIndex = -1;
    try {
      let cid = conversation;
      if (!cid) {
        cid = (await (await api('/conversations', {})).json()).id;
        setConversation(cid);
      }
      if (approval === undefined) {
        setMessages((m) => [...m, { role: 'user', content: userText }]);
        setText('');
      }
      abort.current = new AbortController();
      const response = await api(
        `/conversations/${cid}/${testing ? 'tool-test' : approval === undefined ? 'messages' : 'approve'}`,
        testing
          ? { toolId: testId, arguments: JSON.parse(testArgs) }
          : approval === undefined
            ? { text: userText }
            : { id: pending.id, approved: approval },
        authRef.current,
        abort.current.signal,
      );
      const reader = response.body!.getReader(),
        decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let split: number;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split);
          buffer = buffer.slice(split + 2);
          const event = block.match(/^event: (.+)$/m)?.[1],
            raw = block.match(/^data: (.+)$/m)?.[1];
          if (!raw) continue;
          const data = JSON.parse(raw);
          if (event === 'delta') {
            setStatus('');
            setMessages((m) => {
              const next = [...m];
              if (assistantIndex < 0) {
                assistantIndex = next.length;
                next.push({ role: 'assistant', content: '' });
              }
              next[assistantIndex] = {
                ...next[assistantIndex],
                content: next[assistantIndex].content + data.text,
              };
              return next;
            });
          }
          if (event === 'status') setStatus(data.message);
          if (event === 'approval') setPending(data);
          if (event === 'action_completed' && authRef.current) {
            parent.postMessage(
              {
                type: 'orchestrator:action-completed',
                deploymentId,
                actionId: data.actionId,
                toolId: data.toolId,
              },
              authRef.current.hostOrigin,
            );
          }
          if (event === 'error') {
            setError(data.message);
            if ([401, 403].includes(data.status)) hide();
          }
        }
      }
      const history = await (await api(`/conversations/${cid}`)).json();
      setMessages(history.messages.filter((m: Message) => m.role !== 'system'));
      setPending(history.pending);
    } catch (e: any) {
      if (e.name !== 'AbortError') setError(e.message);
    } finally {
      setBusy(false);
      setStatus('');
    }
  }
  if (!cfg || !auth) return null;
  const floating = cfg.theme.template === 'floating';
  return (
    <div
      className={`widget mode-${cfg.theme.mode}`}
      style={{ '--brand': cfg.theme.color } as React.CSSProperties}
    >
      {floating && !open ? (
        <button
          className="launcher"
          aria-label={`Open ${cfg.agent.name}`}
          onClick={() => setOpen(true)}
        >
          ✦
        </button>
      ) : (
        <section className="panel" aria-label={cfg.agent.name}>
          <header>
            <div className="avatar">
              {cfg.agent.avatar ? <img src={cfg.agent.avatar} alt="" /> : '✦'}
            </div>
            <div>
              <strong>{cfg.theme.title || cfg.agent.name}</strong>
              <small>
                <i /> Authenticated assistant
              </small>
            </div>
            {floating && (
              <button className="close" aria-label="Close assistant" onClick={() => setOpen(false)}>
                ×
              </button>
            )}
          </header>
          {cfg.bridgeTesting && (
            <details
              className="tool-testing"
              open={showTest}
              onToggle={(e) => setShowTest(e.currentTarget.open)}
            >
              <summary
                onClick={() => {
                  if (!showTest)
                    void api('/bridge-tools')
                      .then((r) => r.json())
                      .then((d) => {
                        setTestTools(d.tools);
                        setTestId(d.tools[0]?.id ?? '');
                      })
                      .catch((e) => setError(e.message));
                }}
              >
                Test permitted API tools
              </summary>
              <label>
                Operation
                <select
                  aria-label="Test operation"
                  value={testId}
                  onChange={(e) => setTestId(e.target.value)}
                >
                  {testTools.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name} · {t.kind}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Arguments (JSON)
                <textarea
                  aria-label="Test arguments"
                  rows={3}
                  value={testArgs}
                  onChange={(e) => setTestArgs(e.target.value)}
                />
              </label>
              <small>Uses your current permissions. Writes still require confirmation.</small>
              <button
                disabled={busy || !!pending || !testId}
                onClick={() => void send(undefined, true)}
              >
                Run tool test
              </button>
            </details>
          )}
          <main aria-live="polite" aria-busy={busy}>
            {!messages.length && (
              <div className="welcome">
                <span className="welcome-icon">✦</span>
                <h2>{cfg.agent.name}</h2>
                <p>{cfg.agent.welcome}</p>
                <div className="starters">
                  {cfg.agent.starters.map((s: string) => (
                    <button
                      key={s}
                      onClick={() => {
                        setText(s);
                        input.current?.focus();
                      }}
                    >
                      {s}
                      <span>↗</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
            {messages.map((m, i) => (
              <div key={i} className={`message ${m.role}`}>
                {m.content}
              </div>
            ))}
            {pending && (
              <div className="approval">
                <span className="eyebrow">YOUR CONFIRMATION IS REQUIRED</span>
                <strong>{pending.description}</strong>
                <code>
                  {pending.method} {pending.target}
                </code>
                <pre>{JSON.stringify(pending.arguments, null, 2)}</pre>
                <p>This action will change data in your application.</p>
                <div>
                  <button
                    disabled={busy || Date.parse(pending.expiresAt) <= Date.now()}
                    onClick={() => send(true)}
                  >
                    Confirm action
                  </button>
                  <button className="secondary" disabled={busy} onClick={() => send(false)}>
                    Reject
                  </button>
                </div>
              </div>
            )}
            {status && <div className="status">◌ {status}</div>}
            {error && (
              <div role="alert" className="error">
                {error}
                <button
                  disabled={busy}
                  onClick={async () => {
                    if (conversation)
                      try {
                        const h = await (await api(`/conversations/${conversation}`)).json();
                        setMessages(h.messages.filter((m: Message) => m.role !== 'system'));
                        setPending(h.pending);
                        setError('');
                      } catch (e: any) {
                        setError(e.message);
                      }
                  }}
                >
                  Refresh conversation
                </button>
              </div>
            )}
            <div ref={bottom} />
          </main>
          <div className="composer">
            <div className="input">
              <input
                ref={input}
                aria-label="Message"
                value={text}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask your assistant…"
                maxLength={12000}
                disabled={busy || !!pending}
              />
              <button
                aria-label="Send message"
                onClick={() => void send()}
                disabled={busy || !!pending || !text.trim()}
              >
                ↑
              </button>
            </div>
            <small>AI can make mistakes. Review actions before confirming.</small>
          </div>
        </section>
      )}
    </div>
  );
}
createRoot(document.getElementById('root')!).render(<App />);
