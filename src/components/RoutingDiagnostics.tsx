import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlaskConical, Search } from 'lucide-react';
import Dialog from './Dialog';
import { EditorTabs, EditorTabPanel, useEditorTabs } from './EditorTabs';
import { serviceCall, errorText, type ServiceError } from '../serviceClient';
import type { RuntimeController } from '../useRuntime';
import type { Diagnostic, GraphState } from '../graph/types';
import {
  diagnosticInputs,
  diagnosticHandlers,
  diagnosticDestination,
  diagnosticIPs,
  diagnosticTrail,
  diagnosticRule,
  type DiagnosticConfiguration,
  type RoutingDiagnosticResult,
} from '../routingDiagnostics';

type Mode = 'route' | 'dns';
type Job = {
  job: number;
  busy: boolean;
  result: RoutingDiagnosticResult | null;
  error: ServiceError | null;
  cancelled: boolean;
};

function useDiagnosticJob() {
  const [state, setState] = useState<{
    busy: boolean;
    result?: RoutingDiagnosticResult;
    error?: string;
  }>({ busy: false });
  const active = useRef(true),
    job = useRef<number | null>(null),
    pending = useRef(false),
    cancelRequested = useRef(false),
    cancelSent = useRef<number | null>(null),
    timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined),
    sequence = useRef(0);
  const cancel = useCallback(() => {
    cancelRequested.current = true;
    const id = job.current;
    if (id != null && cancelSent.current !== id) {
      cancelSent.current = id;
      void serviceCall('routing.diagnosticCancel', { job: id }).catch(() => {
        if (cancelSent.current === id) cancelSent.current = null;
      });
    }
  }, []);
  const retire = useCallback(() => {
    active.current = false;
    sequence.current++;
    clearTimeout(timer.current);
    cancel();
  }, [cancel]);
  useEffect(() => {
    active.current = true;
    return retire;
  }, [retire]);
  const run = async (input: Record<string, unknown>) => {
    if (pending.current) return;
    pending.current = true;
    cancelRequested.current = false;
    cancelSent.current = null;
    const id = ++sequence.current;
    setState({ busy: true });
    const accept = (reply: Job) => {
      if (!active.current || sequence.current !== id) {
        if (reply.busy)
          void serviceCall('routing.diagnosticCancel', { job: reply.job }).catch(() => {});
        return;
      }
      job.current = reply.busy ? reply.job : null;
      if (reply.busy && cancelRequested.current) cancel();
      pending.current = reply.busy;
      setState({
        busy: reply.busy,
        result: reply.result ?? undefined,
        error: reply.error
          ? errorText(reply.error)
          : reply.cancelled
            ? 'Test cancelled.'
            : undefined,
      });
      if (reply.busy)
        timer.current = setTimeout(() => {
          void serviceCall<Job>('routing.diagnosticGet', { job: reply.job })
            .then(accept)
            .catch(fail);
        }, 150);
    };
    const fail = (error: unknown) => {
      if (active.current && sequence.current === id) {
        cancel();
        job.current = null;
        pending.current = false;
        setState({ busy: false, error: errorText(error) });
      }
    };
    try {
      accept(await serviceCall<Job>('routing.diagnosticStart', input));
    } catch (error) {
      fail(error);
    }
  };
  return { ...state, run, cancel, clear: () => setState({ busy: false }) };
}

export default function RoutingDiagnostics({
  draft,
  runtime,
  graph,
  onIssue,
  onClose,
  initialMode = 'route',
  initialNodeId,
}: {
  draft: DiagnosticConfiguration | null;
  runtime: RuntimeController;
  graph: GraphState;
  onIssue: (issue: Diagnostic) => void;
  onClose: () => void;
  initialMode?: Mode;
  initialNodeId?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode),
    [source, setSource] = useState<'draft' | 'applied'>('draft');
  const applied = useMemo(
    () =>
      runtime.savedConfig
        ? {
            config: runtime.savedConfig,
            capture: runtime.savedCapture,
            displayNames: runtime.savedDisplayNames,
          }
        : null,
    [runtime.savedConfig, runtime.savedCapture, runtime.savedDisplayNames],
  );
  const plan = source === 'draft' ? draft : applied;
  const available = runtime.connected && runtime.capabilities.includes('routing.diagnostics');
  const inputs = diagnosticInputs(plan),
    handlers = diagnosticHandlers(plan);
  const initialTag = graph.nodes.find((node) => node.id === initialNodeId)?.data.settings.tag;
  const [inbound, setInbound] = useState(typeof initialTag === 'string' ? initialTag : ''),
    [handler, setHandler] = useState(typeof initialTag === 'string' ? initialTag : '');
  const input = inputs.some((i) => i.tag === inbound) ? inbound : (inputs[0]?.tag ?? '');
  const dnsHandler = handlers.some((i) => i.tag === handler) ? handler : (handlers[0]?.tag ?? '');
  const [destination, setDestination] = useState(''),
    [port, setPort] = useState('443'),
    [network, setNetwork] = useState('tcp'),
    [protocol, setProtocol] = useState('');
  const [ips, setIPs] = useState(''),
    [sourceIP, setSourceIP] = useState(''),
    [sourcePort, setSourcePort] = useState(''),
    [user, setUser] = useState('');
  const [application, setApplication] = useState(''),
    [parents, setParents] = useState(''),
    [service, setService] = useState(''),
    [packageName, setPackageName] = useState('');
  const [queryType, setQueryType] = useState('A'),
    [dnsServer, setDnsServer] = useState('8.8.8.8:53'),
    [error, setError] = useState('');
  const [tested, setTested] = useState<{
    plan: DiagnosticConfiguration;
    mode: Mode;
    destination: string;
  } | null>(null);
  const test = useDiagnosticJob();
  const tabs = useEditorTabs(
    [
      { key: 'route', label: 'Route' },
      { key: 'dns', label: 'DNS' },
    ] as const,
    mode,
    (value) => {
      setMode(value);
      change();
    },
  );
  const previous = useRef(plan);
  useEffect(() => {
    if (previous.current !== plan) {
      previous.current = plan;
      test.cancel();
      setTested(null);
    }
  }, [plan, test]);
  const result = tested?.plan === plan && tested.mode === mode ? test.result : undefined;
  const jobError = tested?.plan === plan && tested.mode === mode ? test.error : undefined;
  const change = () => {
    setTested(null);
    setError('');
    if (!test.busy) test.clear();
  };
  const run = async () => {
    if (!plan) return;
    setError('');
    try {
      const target = diagnosticDestination(destination);
      if (mode === 'dns' && !target.domain) throw new Error('Enter a domain for the DNS query.');
      const numericPort = Number(port);
      if (
        mode === 'route' &&
        (!Number.isInteger(numericPort) || numericPort < 1 || numericPort > 65535)
      )
        throw new Error('Port must be between 1 and 65535.');
      if (
        mode === 'route' &&
        sourcePort &&
        (!Number.isInteger(Number(sourcePort)) ||
          Number(sourcePort) < 1 ||
          Number(sourcePort) > 65535)
      )
        throw new Error('Source port must be between 1 and 65535.');
      if (mode === 'route' && sourceIP) diagnosticIPs(sourceIP);
      const identity = (path: string, leaf = false) => ({
        name: path.split(/[\\/]/).at(-1) ?? path,
        path: /[\\/]/.test(path) ? path : null,
        package: leaf ? packageName || null : null,
      });
      setTested({ plan, mode, destination });
      await test.run({
        config: plan.config,
        capture: plan.capture ?? null,
        mode,
        route: {
          inbound: input,
          ...target,
          port: numericPort,
          network,
          protocol,
          user,
          sourceIP,
          sourcePort: Number(sourcePort) || 0,
        },
        application:
          application || parents || service || packageName
            ? {
                lineage: [
                  identity(application.trim(), true),
                  ...parents
                    .split('\n')
                    .map((p) => p.trim())
                    .filter(Boolean)
                    .map((path) => identity(path)),
                ],
                service: service || null,
              }
            : null,
        resolvedIPs: mode === 'route' ? diagnosticIPs(ips) : [],
        handler: dnsHandler,
        domain: target.domain,
        queryType,
        server: dnsServer,
      });
    } catch (e) {
      setError(errorText(e));
    }
  };
  const output = result?.balancerTag || result?.outboundTag || '';
  const trail = result && tested ? diagnosticTrail(tested.plan, result) : [];
  const rule = result && tested ? diagnosticRule(tested.plan, result) : undefined;
  const name =
    tested?.plan.displayNames?.outbound[output] ||
    (source === 'draft'
      ? graph.nodes.find((n) => n.data.settings.tag === output)?.data.label
      : '') ||
    output;
  return (
    <Dialog
      title="Routing playground"
      className="routing-playground"
      onClose={onClose}
      footer={
        <>
          <span className="playground-scope">Isolated test · no configuration changes</span>
          {test.busy ? (
            <button className="secondary-button" onClick={test.cancel}>
              Cancel test
            </button>
          ) : (
            <button
              className="primary-button"
              disabled={
                !plan || !available || !destination.trim() || (mode === 'dns' && !dnsHandler)
              }
              onClick={() => void run()}
            >
              <Search size={15} />
              {mode === 'dns' ? 'Test this domain' : 'Evaluate route'}
            </button>
          )}
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <fieldset disabled={test.busy} className="playground-form" onChange={change}>
        <div className="playground-row">
          <label className="editor-field">
            <span>Configuration</span>
            <select
              value={source}
              onChange={(e) => {
                setSource(e.target.value as 'draft' | 'applied');
                change();
              }}
            >
              <option value="draft">Edited graph</option>
              <option value="applied" disabled={!applied}>
                Applied revision {runtime.savedRevision || ''}
              </option>
            </select>
          </label>
          <label className="editor-field">
            <span>{mode === 'route' ? 'Traffic source' : 'DNS handler'}</span>
            {mode === 'route' ? (
              <select value={input} onChange={(e) => setInbound(e.target.value)}>
                {inputs.map((i) => (
                  <option key={i.tag} value={i.tag}>
                    {i.name}
                  </option>
                ))}
              </select>
            ) : (
              <select value={dnsHandler} onChange={(e) => setHandler(e.target.value)}>
                {handlers.map((i) => (
                  <option key={i.tag} value={i.tag}>
                    {i.name}
                  </option>
                ))}
              </select>
            )}
          </label>
        </div>
        <EditorTabs tabs={tabs} label="Diagnostic type" disabled={test.busy} />
        <label className="editor-field">
          <span>{mode === 'dns' ? 'Domain' : 'Destination domain or IP'}</span>
          <input
            value={destination}
            placeholder="example.com"
            onChange={(e) => setDestination(e.target.value)}
            spellCheck={false}
            autoCapitalize="none"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void run();
              }
            }}
          />
        </label>
        <EditorTabPanel tabs={tabs} tab="route" className="playground-details">
          <div className="playground-row playground-row--three">
            <label className="editor-field">
              <span>Port</span>
              <input
                type="number"
                min="1"
                max="65535"
                value={port}
                onChange={(e) => setPort(e.target.value)}
              />
            </label>
            <label className="editor-field">
              <span>Network</span>
              <select value={network} onChange={(e) => setNetwork(e.target.value)}>
                <option value="tcp">TCP</option>
                <option value="udp">UDP</option>
              </select>
            </label>
            <label className="editor-field">
              <span>Detected protocol</span>
              <select value={protocol} onChange={(e) => setProtocol(e.target.value)}>
                <option value="">Not detected</option>
                {['http', 'tls', 'quic', 'bittorrent', 'dns', 'stun'].map((p) => (
                  <option key={p}>{p}</option>
                ))}
              </select>
            </label>
          </div>
          <details>
            <summary>Application and connection details</summary>
            <div className="playground-details">
              <label className="editor-field">
                <span>Executable name or full path</span>
                <input
                  value={application}
                  onChange={(e) => setApplication(e.target.value)}
                  placeholder="browser.exe"
                />
              </label>
              <label className="editor-field">
                <span>Parent executables · nearest first, one per line</span>
                <textarea value={parents} rows={2} onChange={(e) => setParents(e.target.value)} />
              </label>
              <div className="playground-row">
                <label className="editor-field">
                  <span>Windows service name</span>
                  <input value={service} onChange={(e) => setService(e.target.value)} />
                </label>
                <label className="editor-field">
                  <span>Windows app package</span>
                  <input value={packageName} onChange={(e) => setPackageName(e.target.value)} />
                </label>
              </div>
              <label className="editor-field">
                <span>Resolved destination IPs</span>
                <input
                  value={ips}
                  onChange={(e) => setIPs(e.target.value)}
                  placeholder="Used by IPOnDemand / IPIfNonMatch"
                />
              </label>
              <div className="playground-row">
                <label className="editor-field">
                  <span>Source IP</span>
                  <input value={sourceIP} onChange={(e) => setSourceIP(e.target.value)} />
                </label>
                <label className="editor-field">
                  <span>Source port</span>
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    value={sourcePort}
                    onChange={(e) => setSourcePort(e.target.value)}
                  />
                </label>
              </div>
              <label className="editor-field">
                <span>Inbound account email</span>
                <input value={user} onChange={(e) => setUser(e.target.value)} />
              </label>
            </div>
          </details>
        </EditorTabPanel>
        <EditorTabPanel tabs={tabs} tab="dns" className="playground-details">
          <div className="playground-row">
            <label className="editor-field">
              <span>Record type</span>
              <select value={queryType} onChange={(e) => setQueryType(e.target.value)}>
                {['A', 'AAAA', 'HTTPS', 'TXT'].map((type) => (
                  <option key={type}>{type}</option>
                ))}
              </select>
            </label>
            <label className="editor-field">
              <span>Original DNS destination</span>
              <input
                value={dnsServer}
                onChange={(e) => setDnsServer(e.target.value)}
                placeholder="8.8.8.8:53"
              />
            </label>
          </div>
          <p className="field-help">
            Uses the handler’s request policies, static hosts and resolvers. Test caches and FakeDNS
            mappings are separate from active routing.
          </p>
        </EditorTabPanel>
      </fieldset>
      {!runtime.connected && (
        <p className="field-message" role="status">
          Connect to the networking service to run diagnostics.
        </p>
      )}
      {runtime.connected && !available && (
        <p className="field-message" role="status">
          Update the networking service to use routing diagnostics.
        </p>
      )}
      {mode === 'dns' && plan && !handlers.length && (
        <p className="field-message" role="status">
          This configuration has no DNS handler to test.
        </p>
      )}
      {!plan && (
        <p className="field-message" role="status">
          Correct the graph’s Check errors before testing, or select an applied configuration.
        </p>
      )}
      {(error || jobError || result?.error) && (
        <p className="field-message" role="alert">
          {error || jobError || result?.error}
        </p>
      )}
      {test.busy && (
        <p role="status">
          <FlaskConical size={15} /> Testing…
        </p>
      )}
      {result && (
        <section className="playground-result" aria-label="Diagnostic result">
          {result.needsIPs && (
            <p className="field-message">
              Provisional result: Xray requested destination IPs. Supply them in connection details,
              then evaluate again.
            </p>
          )}
          {result.warnings?.map((message) => (
            <p className="field-message" key={message}>
              {message}
            </p>
          ))}
          {mode === 'route' && !result.error && (
            <>
              <dl className="key-value-list">
                <dt>{result.balancerTag ? 'Policy group' : 'Outbound'}</dt>
                <dd>{name || 'No default outbound'}</dd>
                <dt>Matched rule</dt>
                <dd>
                  {trail.length
                    ? trail.map((h) => h.rule).join(' → ')
                    : result.ruleIndex != null
                      ? `Xray rule ${result.ruleIndex + 1}`
                      : 'Core default outbound'}
                </dd>
              </dl>
              {trail.map((hop, index) => (
                <button
                  className="secondary-button button--small"
                  key={`${hop.filterId}:${index}`}
                  onClick={() => {
                    onClose();
                    onIssue({
                      severity: 'warning',
                      nodeId: hop.filterId,
                      rowId: hop.ruleId ?? undefined,
                      message: hop.rule,
                    });
                  }}
                >
                  {hop.rule} → {hop.output}
                </button>
              ))}
              {result.balancerTag && (
                <p className="field-help">
                  The rule selects this policy group. Its live member selection is not advanced by
                  this test.
                </p>
              )}
              {rule !== undefined && (
                <details>
                  <summary>Matched Xray rule</summary>
                  <pre className="code-preview">{JSON.stringify(rule, null, 2)}</pre>
                </details>
              )}
            </>
          )}
          {mode === 'dns' && (
            <>
              <dl className="key-value-list">
                <dt>Response</dt>
                <dd>{result.rcode ?? 'No response'}</dd>
                <dt>Query</dt>
                <dd>
                  {tested?.destination} · {queryType}
                </dd>
              </dl>
              {!!result.answers?.length && (
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Answer</th>
                      <th>Type</th>
                      <th>TTL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.answers.map((answer, index) => (
                      <tr key={index}>
                        <td>
                          {answer.value}
                          {answer.synthetic && (
                            <span className="field-help"> · FakeDNS test mapping</span>
                          )}
                        </td>
                        <td>
                          {({ 1: 'A', 28: 'AAAA', 5: 'CNAME' } as Record<number, string>)[
                            answer.type
                          ] ?? answer.type}
                        </td>
                        <td>{answer.ttl} s</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {!!result.trace?.length && (
                <details open>
                  <summary>Resolver activity</summary>
                  <ol className="playground-trace">
                    {result.trace.map((row, index) => (
                      <li key={index}>
                        <time>{row.elapsedMs} ms</time>
                        <span>{row.message}</span>
                      </li>
                    ))}
                  </ol>
                </details>
              )}
            </>
          )}
        </section>
      )}
    </Dialog>
  );
}
