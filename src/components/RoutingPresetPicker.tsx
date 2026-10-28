import { useState } from 'react';
import {
  dnsPresets,
  trafficPresets,
  rolesForTraffic,
  newPresetOutput,
  type PresetBindings,
  type PresetMode,
  type DnsPreset,
  type TrafficPreset,
} from '../graph/routingPresets';
import type { GraphState, RuleNode } from '../graph/types';
import type { NamedOutput } from '../graph/rules';
import type { DnsOutput } from '../graph/dns';
import { isXrayOutbound } from '../graph/xrayNodes';

export default function RoutingPresetPicker({
  kind,
  outputs,
  graph,
  node,
  onImport,
}: {
  kind: 'traffic' | 'dns';
  outputs: (NamedOutput | DnsOutput)[];
  graph: GraphState;
  node: RuleNode;
  onImport: (
    preset: TrafficPreset | DnsPreset,
    bindings: PresetBindings,
    mode: PresetMode,
    strategy: string | null,
  ) => void;
}) {
  const presets = kind === 'traffic' ? trafficPresets : dnsPresets;
  const [chosen, setChosen] = useState(presets[0].id);
  const [mode, setMode] = useState<PresetMode>('replace');
  const [bindings, setBindings] = useState<PresetBindings>({});
  const [setStrategy, setSetStrategy] = useState(true);
  const [problem, setProblem] = useState('');
  const preset = presets.find((p) => p.id === chosen)!;
  const roles =
    kind === 'traffic' ? rolesForTraffic(preset as TrafficPreset) : (preset as DnsPreset).roles;
  const fallback = outputs.find((o) => 'fallback' in o && o.fallback);
  const destination = (id: string) => {
    const edge = graph.edges.find((e) => e.source === node.id && e.sourceHandle === id);
    return graph.nodes.find((n) => n.id === edge?.target);
  };
  const guess = (role: string, name: string) => {
    if (role === 'fallback' && kind === 'dns') return fallback?.id ?? '';
    const match = outputs.find((o) => {
      if (kind === 'dns' && 'fallback' in o && o.fallback) return false;
      const target = destination(o.id);
      return (
        o.name.toLowerCase() === name.toLowerCase() ||
        (kind === 'traffic' &&
          (role === 'direct'
            ? target?.data.kind === 'direct-outbound'
            : role === 'block'
              ? target?.data.kind === 'block-outbound'
              : !!target &&
                (isXrayOutbound(target) || target.data.kind === 'policy-group') &&
                !['direct-outbound', 'block-outbound'].includes(target.data.kind)))
      );
    });
    return match?.id ?? newPresetOutput;
  };
  const resolved = Object.fromEntries(
    roles.map((r) => [r.id, bindings[r.id] ?? guess(r.id, r.name)]),
  );
  const strategy = kind === 'traffic' ? (preset as TrafficPreset).domainStrategy : null;
  const rows = preset.rules;
  return (
    <div className="routing-presets">
      <div className="editor-two-fields">
        <label className="editor-field">
          <span>Routing preset</span>
          <select
            aria-label="Routing preset"
            value={chosen}
            onChange={(e) => {
              setChosen(e.target.value);
              setBindings({});
              setProblem('');
            }}
          >
            {['Russia', 'Iran', 'China'].map((country) => (
              <optgroup key={country} label={country}>
                {presets
                  .filter((p) => p.country === country)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="editor-field">
          <span>Import mode</span>
          <select
            aria-label="Preset import mode"
            value={mode}
            onChange={(e) => setMode(e.target.value as PresetMode)}
          >
            <option value="replace">Replace rules</option>
            <option value="append">Append rules · keep current default</option>
          </select>
        </label>
      </div>
      <div className="preset-output-mapping">
        {roles.map((role) => (
          <label className="editor-field" key={role.id}>
            <span>{role.name}</span>
            <select
              aria-label={`Preset output: ${role.name}`}
              value={resolved[role.id]}
              disabled={kind === 'dns' && role.id === 'fallback'}
              onChange={(e) => setBindings((b) => ({ ...b, [role.id]: e.target.value }))}
            >
              {!(kind === 'dns' && role.id === 'fallback') && (
                <option value={newPresetOutput}>New output · {role.name}</option>
              )}
              {outputs.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name || 'Unnamed output'} → {destination(o.id)?.data.label ?? 'Not connected'}
                </option>
              ))}
            </select>
            {'servers' in role && <small>Servers: {(role.servers as string[]).join(', ')}</small>}
          </label>
        ))}
      </div>
      {strategy && mode === 'replace' && (
        <label className="check-control">
          <input
            type="checkbox"
            checked={setStrategy}
            onChange={(e) => setSetStrategy(e.target.checked)}
          />
          Set graph routing domain strategy to {strategy}
        </label>
      )}
      {problem && (
        <p role="alert" className="field-message error">
          {problem}
        </p>
      )}
      <button
        className="primary-button preset-import-button"
        onClick={() => {
          try {
            onImport(preset, resolved, mode, mode === 'replace' && setStrategy ? strategy : null);
            setProblem('');
          } catch (error) {
            setProblem(error instanceof Error ? error.message : String(error));
          }
        }}
      >
        Import preset
      </button>
      <div className="preset-preview" aria-label="Preset rule preview">
        <ol>
          {rows.map((r, index) => (
            <li key={index}>
              <strong>{r.name}</strong>
              <span>{roles.find((role) => role.id === r.output)?.name}</span>
            </li>
          ))}
        </ol>
        {kind === 'traffic' && (
          <p>
            Unmatched traffic →{' '}
            {roles.find((r) => r.id === (preset as TrafficPreset).defaultOutput)?.name}
          </p>
        )}
        {kind === 'dns' && !rows.length && <p>All DNS requests use Fallback.</p>}
      </div>
      <p className="field-help">
        {kind === 'dns'
          ? 'Configure the listed servers in connected DNS server groups; handler hosts stay unchanged.'
          : 'Existing output connections stay intact. Connect any new outputs before running.'}
      </p>
      {kind === 'dns' &&
        Object.keys((preset as DnsPreset).hosts).filter((h) => h !== 'proxy.example.com').length >
          0 && (
          <details className="disclosure preset-hosts">
            <summary>Suggested DNS handler hosts</summary>
            <pre className="code-block" tabIndex={0}>
              {JSON.stringify(
                Object.fromEntries(
                  Object.entries((preset as DnsPreset).hosts).filter(
                    ([key]) => key !== 'proxy.example.com',
                  ),
                ),
                null,
                2,
              )}
            </pre>
          </details>
        )}
    </div>
  );
}
