import { useEffect, useRef, useState } from 'react';
import RuleSourceLoader, { type SourceLocation } from './RuleSourceLoader';
import {
  parseDnsRules,
  importDnsRules,
  refreshDnsSource,
  detachDnsSource,
  exportDnsRules,
} from '../graph/dnsRuleSource';
import { newPresetOutput, type PresetBindings, type PresetMode } from '../graph/routingPresets';
import type { DnsFilter } from '../graph/dns';
import type { GraphState, RuleNode } from '../graph/types';
import { exportFile } from '../exportFile';
import { Download } from 'lucide-react';
import { summarizeTerms } from './editorSummaries';

export default function DnsRuleImport({
  filter,
  graph,
  node,
  onImport,
}: {
  filter: DnsFilter;
  graph: GraphState;
  node: RuleNode;
  onImport: (filter: DnsFilter) => void;
}) {
  const [incoming, setIncoming] = useState<DnsFilter | null>(null),
    [location, setLocation] = useState<SourceLocation | null>(null);
  const [refresh, setRefresh] = useState(false),
    [mode, setMode] = useState<PresetMode>('replace'),
    [keepSource, setKeepSource] = useState(true);
  const [bindings, setBindings] = useState<PresetBindings>({}),
    [problem, setProblem] = useState('');
  const heading = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (problem) alert.current?.focus();
    else if (incoming) heading.current?.focus();
  }, [incoming, problem]);
  const destination = (id: string) =>
    graph.nodes.find(
      (n) =>
        n.id ===
        graph.edges.find((edge) => edge.source === node.id && edge.sourceHandle === id)?.target,
    )?.data.label;
  const roles = incoming?.outputs.filter((output) => !output.fallback) ?? [];
  const resolved = Object.fromEntries(
    roles.map((role) => {
      const saved = refresh ? filter.source?.bindings[role.id] : undefined;
      return [
        role.id,
        bindings[role.id] ??
          (filter.outputs.some((output) => output.id === saved)
            ? saved!
            : (filter.outputs.find(
                (output) =>
                  !output.fallback && output.name.toLowerCase() === role.name.toLowerCase(),
              )?.id ?? newPresetOutput)),
      ];
    }),
  );
  return (
    <div className="routing-presets traffic-rule-import">
      <RuleSourceLoader
        source={filter.source}
        missing={filter.rules.some((rule) => rule.source?.missing)}
        onReset={() => {
          setIncoming(null);
          setBindings({});
          setProblem('');
        }}
        onDetach={() => onImport(detachDnsSource(filter))}
        onLoad={(text, _name, location, refresh) => {
          const parsed = parseDnsRules(text);
          setIncoming(parsed);
          setLocation(location);
          setRefresh(refresh);
          setBindings({});
          setProblem('');
        }}
      />
      {problem && (
        <p ref={alert} tabIndex={-1} role="alert" className="field-message error">
          {problem}
        </p>
      )}
      {incoming && (
        <>
          <h3 ref={heading} tabIndex={-1}>
            {incoming.rules.length} DNS preferences
          </h3>
          {!refresh && (
            <>
              <label className="editor-field">
                <span>Import mode</span>
                <select
                  aria-label="DNS import mode"
                  value={mode}
                  onChange={(event) => setMode(event.target.value as PresetMode)}
                >
                  <option value="replace">Replace preferences</option>
                  <option value="append">Append preferences · keep current fallback</option>
                </select>
              </label>
              <label className="check-control">
                <input
                  type="checkbox"
                  checked={keepSource && !(incoming.source && mode === 'append')}
                  disabled={!!incoming.source && mode === 'append'}
                  onChange={(event) => setKeepSource(event.target.checked)}
                />
                {incoming.source ? 'Keep source and overrides' : 'Keep source for manual updates'}
              </label>
            </>
          )}
          <button
            className="primary-button preset-import-button"
            onClick={() => {
              try {
                const next = refresh
                  ? refreshDnsSource(filter, incoming, resolved)
                  : importDnsRules(
                      filter,
                      keepSource && mode === 'replace' ? incoming : detachDnsSource(incoming),
                      resolved,
                      mode,
                      keepSource && !incoming.source ? (location ?? undefined) : undefined,
                    );
                onImport(next);
                setProblem('');
              } catch (error) {
                setProblem(error instanceof Error ? error.message : String(error));
              }
            }}
          >
            {refresh ? 'Update rules' : 'Import rules'}
          </button>
          <div className="preset-output-mapping">
            {roles.map((role) => (
              <label key={role.id} className="editor-field">
                <span>{role.name}</span>
                <select
                  aria-label={`Imported DNS output: ${role.name}`}
                  value={resolved[role.id]}
                  onChange={(event) =>
                    setBindings((old) => ({ ...old, [role.id]: event.target.value }))
                  }
                >
                  <option value={newPresetOutput}>New output · {role.name}</option>
                  {filter.outputs.map((output) => (
                    <option key={output.id} value={output.id}>
                      {output.name} → {destination(output.id) ?? 'Not connected'}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <p className="field-help">
            Fallback uses the existing Fallback connection.
            {refresh ? ' Its policy and resolver order are kept.' : ''}
          </p>
          <div className="preset-preview" aria-label="Imported DNS preference preview">
            <ol>
              {incoming.rules.map((rule) => (
                <li key={rule.id}>
                  <strong>
                    {rule.name}
                    {rule.enabled ? '' : ' (disabled)'}
                  </strong>
                  <span>
                    {incoming.outputs.find((output) => output.id === rule.output)?.name} ·{' '}
                    {summarizeTerms(rule.domains) || 'Any domain'}
                  </span>
                </li>
              ))}
            </ol>
          </div>
        </>
      )}
    </div>
  );
}

export function DnsRuleExport({ filter, name }: { filter: DnsFilter; name: string }) {
  const [embed, setEmbed] = useState(false),
    [busy, setBusy] = useState(false),
    [problem, setProblem] = useState('');
  let text = '',
    invalid = '';
  try {
    text = exportDnsRules(filter, name, embed);
  } catch (error) {
    invalid = error instanceof Error ? error.message : String(error);
  }
  async function save() {
    setBusy(true);
    setProblem('');
    try {
      await exportFile('DNS rules.wayrill-dns-rules.json', text);
    } catch (error) {
      setProblem(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="routing-presets">
      {filter.source && (
        <label className="check-control">
          <input
            type="checkbox"
            checked={embed}
            onChange={(event) => setEmbed(event.target.checked)}
          />
          Embed overrides
        </label>
      )}
      <button className="primary-button" disabled={busy || !!invalid} onClick={() => void save()}>
        <Download size={14} />
        Export file
      </button>
      {(invalid || problem) && (
        <p className="field-message error" role="alert">
          {invalid || problem}
        </p>
      )}
      <pre className="code-block" tabIndex={0}>
        {text}
      </pre>
    </div>
  );
}
