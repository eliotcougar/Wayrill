import { useState } from 'react';
import { Download } from 'lucide-react';
import { exportFile } from '../exportFile';
import {
  compatibleOutput,
  exportCompatibleRules,
  exportWayrillRules,
} from '../graph/trafficRuleExport';
import type { RuleTable } from '../graph/rules';
import type { GraphState, RuleNode } from '../graph/types';

export default function TrafficRuleExport({
  table,
  graph,
  node,
}: {
  table: RuleTable;
  graph: GraphState;
  node: RuleNode;
}) {
  const [format, setFormat] = useState('wayrill'),
    [embedOverrides, setEmbedOverrides] = useState(false),
    [problem, setProblem] = useState(''),
    [busy, setBusy] = useState(false);
  const [names, setNames] = useState<Record<string, string>>({});
  const resolved = Object.fromEntries(
    table.outputs.map((output) => {
      const mapping = compatibleOutput(table, graph, node, output.id);
      return [output.id, mapping.fixed || (names[output.id] ?? mapping.name)];
    }),
  );
  let text = '',
    error = '',
    count = 0,
    omitted: string[] = [];
  try {
    if (format === 'wayrill') text = exportWayrillRules(table, node.data.label, embedOverrides);
    else ({ text, count, omitted } = exportCompatibleRules(table, resolved));
  } catch (issue) {
    error = issue instanceof Error ? issue.message : 'Could not export rules.';
  }
  async function save() {
    setBusy(true);
    setProblem('');
    try {
      const name =
        [...node.data.label]
          .map((character) =>
            character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character,
          )
          .join('')
          .trim()
          .slice(0, 100) || 'Traffic filter';
      await exportFile(`${name}.${format === 'wayrill' ? 'wayrill-rules' : 'v2rayn'}.json`, text);
    } catch (issue) {
      setProblem(issue instanceof Error ? issue.message : String(issue));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="routing-presets">
      <label className="editor-field">
        <span>Format</span>
        <select
          value={format}
          disabled={busy}
          onChange={(event) => {
            setFormat(event.target.value);
            setProblem('');
          }}
        >
          <option value="wayrill">Wayrill</option>
          <option value="v2rayn">Compatible v2rayN</option>
        </select>
      </label>
      {table.source && (
        <label className="check-control">
          <input
            type="checkbox"
            checked={format === 'v2rayn' || embedOverrides}
            disabled={busy || format === 'v2rayn'}
            onChange={(event) => setEmbedOverrides(event.target.checked)}
          />
          Embed overrides
        </label>
      )}
      {format === 'wayrill' && table.source && !embedOverrides && (
        <p className="field-help">Includes the source location and local overrides.</p>
      )}
      {format === 'v2rayn' && (
        <>
          <p className="field-help">
            Use proxy, direct, block, or an outbound name that exists in v2rayN. Referenced inbound
            tags and resource files must also exist there.
          </p>
          <div className="preset-output-mapping">
            {table.outputs.map((output) => (
              <label className="editor-field" key={output.id}>
                <span>{output.name}</span>
                <input
                  aria-label={`v2rayN outbound for ${output.name}`}
                  value={resolved[output.id]}
                  disabled={busy || !!compatibleOutput(table, graph, node, output.id).fixed}
                  maxLength={256}
                  onChange={(event) => setNames({ ...names, [output.id]: event.target.value })}
                />
              </label>
            ))}
          </div>
          {!error && (
            <p>
              {count} exported rule{count === 1 ? '' : 's'}, including Unmatched traffic.
            </p>
          )}
          {omitted.length > 0 && (
            <div className="preset-preview">
              <h3>Omitted in compatible format</h3>
              <ul>
                {omitted.map((note, index) => (
                  <li key={index}>{note}</li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
      {(error || problem) && (
        <p role="alert" className="field-message error">
          {error || problem}
        </p>
      )}
      <button
        type="button"
        className="primary-button preset-import-button"
        disabled={busy || !!error}
        onClick={() => void save()}
      >
        <Download size={16} />
        Export file
      </button>
    </section>
  );
}
