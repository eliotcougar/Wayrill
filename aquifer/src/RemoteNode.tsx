import { memo, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  GitBranch,
  Radio,
  Settings2,
  Server,
  ShieldCheck,
  Users,
} from 'lucide-react';
import type { ViewNode } from './remoteModel';
import { viewConnections } from './viewConnections';

function RemoteNode({ id, data, selected, isConnectable }: NodeProps<ViewNode>) {
  const updateInternals = useUpdateNodeInternals();
  const ports = [...(data.inputs ?? []), ...data.outputs].map((port) => port.id).join(',');
  useEffect(() => {
    updateInternals(id);
  }, [id, ports, data.hasInput, updateInternals]);
  const inputColor = viewConnections[data.inputKinds?.[0] ?? 'traffic'].color;
  const Icon =
    data.category === 'users'
      ? Users
      : data.category === 'inbound'
        ? ArrowDownToLine
        : data.category === 'outbound'
          ? ArrowUpFromLine
          : data.category === 'internal'
            ? ShieldCheck
            : data.rules
              ? GitBranch
              : data.subtitle.includes('Observatory')
                ? Radio
                : data.subtitle.includes('DNS')
                  ? Server
                  : Settings2;
  return (
    <article
      className={`node-card remote-node ${selected ? 'is-selected' : ''}`}
      data-category={data.category}
    >
      {data.hasInput && (
        <Handle
          type="target"
          id="in"
          position={Position.Left}
          isConnectable={false}
          style={{ background: inputColor }}
        />
      )}
      <header>
        <div className="remote-node-kicker">
          <span className="remote-node-icon">
            <Icon size={15} />
          </span>
          <span>{data.subtitle}</span>
          <span className="remote-node-indicator" aria-hidden="true" />
        </div>
        <strong title={data.title} dir="auto">
          {data.title}
        </strong>
      </header>
      {data.inputs?.map((port) => (
        <div className="node-input" key={port.id}>
          <Handle
            type="target"
            id={port.id}
            position={Position.Left}
            isConnectable={isConnectable}
            style={{ background: viewConnections[port.kind].color }}
          />
          <span>{port.label}</span>
        </div>
      ))}
      {data.facts.length > 0 && (
        <dl>
          {data.facts.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd title={value}>{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.outputs.length > 0 && (
        <div className="node-outputs">
          {data.outputs.map((port) => (
            <div className="node-output" key={port.id}>
              <span title={port.label}>{port.label}</span>
              <Handle
                type="source"
                position={Position.Right}
                id={port.id}
                isConnectable={isConnectable && port.kind === 'users' && port.id === 'users'}
                style={{ background: viewConnections[port.kind].color }}
              />
            </div>
          ))}
        </div>
      )}
    </article>
  );
}
export default memo(RemoteNode);
