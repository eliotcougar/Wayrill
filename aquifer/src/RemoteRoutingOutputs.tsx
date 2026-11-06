import { Plus, Trash2 } from 'lucide-react';
import OutputList from '@wayrill/ui/OutputList';
import { moveEntry } from '@wayrill/ui/OrderedEntries';
import { setProperty } from './nativeProperties';
import { ruleList, ruleTarget, type RouteDestination, type Settings } from './routingEditor';
import { destinationKey, type RoutingOutput } from './routingOutputs';

export function setRuleDestination(
  rule: Settings,
  target: { tag: string; group: boolean },
): Settings {
  return setProperty(
    setProperty(setProperty(rule, 'outboundTag', undefined), 'balancerTag', undefined),
    target.group ? 'balancerTag' : 'outboundTag',
    target.tag,
  );
}

export default function RemoteRoutingOutputs({
  value,
  outputs,
  destinations,
  onChange,
  onOutputsChange,
}: {
  value: Settings;
  outputs: RoutingOutput[];
  destinations: RouteDestination[];
  onChange: (value: Settings) => void;
  onOutputsChange: (outputs: RoutingOutput[]) => void;
}) {
  const rules = ruleList(value);
  const visible = outputs.filter(
    (output) =>
      !destinations.some(
        (target) => target.hidden && destinationKey(target) === destinationKey(output),
      ),
  );
  const unused = destinations.filter(
    (target) =>
      !target.hidden &&
      !outputs.some((output) => destinationKey(output) === destinationKey(target)),
  );
  const rename = (id: string, name: string) =>
    onOutputsChange(outputs.map((output) => (output.id === id ? { ...output, name } : output)));
  return (
    <section className="output-editor remote-routing-outputs" data-setting-path="outputs">
      <div className="section-heading">
        <h3>Outputs</h3>
        <button
          type="button"
          className="icon-button"
          aria-label="Add output"
          title="Add output"
          disabled={!unused.length || outputs.length >= 128}
          onClick={() => {
            const target = unused[0];
            let name = target.tag.slice(0, 64),
              suffix = 2;
            while (outputs.some((output) => output.name.toLowerCase() === name.toLowerCase()))
              name = `${target.tag.slice(0, 58)} (${suffix++})`;
            onOutputsChange([
              ...outputs,
              { id: crypto.randomUUID(), name, tag: target.tag, group: target.group },
            ]);
          }}
        >
          <Plus size={16} />
        </button>
      </div>
      <OutputList
        outputs={visible}
        label="Routing outputs"
        onMove={(id, to) =>
          onOutputsChange(
            moveEntry(
              outputs,
              outputs.findIndex((output) => output.id === id),
              outputs.findIndex((output) => output.id === visible[to].id),
            ),
          )
        }
      >
        {(output, index) => {
          const protectedOutput =
            output.fallback ||
            destinations.some(
              (target) => target.hidden && destinationKey(target) === destinationKey(output),
            );
          return (
            <>
              <input
                className="text-control"
                aria-label={`Output ${index + 1} name`}
                maxLength={64}
                value={output.name}
                onChange={(event) => rename(output.id, event.target.value)}
              />
              <select
                className="text-control"
                aria-label={`Destination for ${output.name}`}
                value={destinationKey(output)}
                disabled={protectedOutput}
                onChange={(event) => {
                  const target = destinations.find(
                    (target) => destinationKey(target) === event.target.value,
                  )!;
                  onChange(
                    setProperty(
                      value,
                      'rules',
                      rules.map((rule) =>
                        destinationKey(ruleTarget(rule)) === destinationKey(output)
                          ? setRuleDestination(rule, target)
                          : rule,
                      ),
                    ),
                  );
                  onOutputsChange(
                    outputs.map((item) =>
                      item.id === output.id
                        ? { ...item, tag: target.tag, group: target.group }
                        : item,
                    ),
                  );
                }}
              >
                {destinations
                  .filter(
                    (target) =>
                      destinationKey(target) === destinationKey(output) ||
                      (!target.hidden &&
                        !outputs.some((item) => destinationKey(item) === destinationKey(target))),
                  )
                  .map((target) => (
                    <option key={destinationKey(target)} value={destinationKey(target)}>
                      {target.tag}
                      {target.group ? ' · Policy group' : target.internal ? ' · Internal' : ''}
                    </option>
                  ))}
              </select>
              <span>{output.fallback ? 'Unmatched traffic' : ''}</span>
              <button
                type="button"
                className="icon-button"
                aria-label={`Delete output ${output.name}`}
                title={
                  protectedOutput
                    ? 'Required for unmatched traffic or the management API'
                    : 'Delete output and its rules'
                }
                disabled={protectedOutput}
                onClick={() => {
                  const used = rules.filter(
                    (rule) => destinationKey(ruleTarget(rule)) === destinationKey(output),
                  );
                  if (
                    used.length &&
                    !window.confirm(
                      `Delete output "${output.name}" and its ${used.length} routing rules?`,
                    )
                  )
                    return;
                  if (used.length)
                    onChange(
                      setProperty(
                        value,
                        'rules',
                        rules.filter(
                          (rule) => destinationKey(ruleTarget(rule)) !== destinationKey(output),
                        ),
                      ),
                    );
                  onOutputsChange(outputs.filter((item) => item.id !== output.id));
                }}
              >
                <Trash2 size={16} />
              </button>
            </>
          );
        }}
      </OutputList>
      <p className="field-help">
        Unmatched traffic uses Xray’s first outbound. Manage that outbound on the graph.
      </p>
    </section>
  );
}
