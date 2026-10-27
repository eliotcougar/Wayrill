import { OutboundTestSummary } from '../useOutboundTests';
import { FakeDnsUsage } from '../fakeDnsUsage';
import {
  OutboundInterfacesContext,
  directInterfaceValue,
  automaticDirectInterface,
} from '../outboundInterfaces';
import { isDisabledInbound } from '../graph/inboundState';
import { memo, useContext, useEffect } from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import {
  getDefinition,
  getOutputPorts,
  hasInputPort,
  portLabel,
  summarizeNode,
} from '../graph/catalog';
import type { NodeKind, RuleNode as RuleNodeType } from '../graph/types';
import NodeIcon from './NodeIcon';
import { MainOutboundContext } from './MainOutboundContext';
import { Crown, ListFilter } from 'lucide-react';
import { isNativeConfigEditor, isNativeXrayKind } from '../graph/xrayNodes';
import { isOutboundKind } from '../graph/outbounds';
import { isPolicyKind } from '../graph/policies';
import { isRuleTableKind } from '../graph/rules';
import { isInboundKind, isHttpInbound } from '../graph/inbounds';
import { captureNodeName, isProtocolKind, isProtocolInbound } from '../graph/protocols';
import { isDnsEditor } from '../graph/dns';
import { NodeEditorContext } from './NodeEditorContext';
import { GraphDiagnosticsContext } from './GraphDiagnosticsContext';
import {
  connectionTypes,
  sourceConnectionKind,
  targetConnectionKinds,
} from '../graph/connectionTypes';

const kindLabels: Partial<Record<NodeKind, string>> = {
  fakedns: 'FAKEDNS',
  'proxy-inbound': 'PROXY',
  'policy-group': 'POLICY GROUP',
  'proxy-chain': 'PROXY CHAIN',
  observatory: 'OBSERVATORY',
  'dns-servers': 'DNS SERVERS',
  'xray-dns-servers': 'DNS SERVERS',
  'dns-routing-filter': 'DNS FILTER',
  'dns-handler': 'DNS HANDLER',
  'xray-dns': 'DNS HANDLER',
  'routing-filter': 'ROUTING FILTER',
  'xray-options': 'CORE SETTINGS',
};
const categoryLabels = {
  inbound: 'INBOUND',
  outbound: 'OUTBOUND',
  filter: 'CONDITION',
  rule: 'ROUTING RULE',
};

function RuleNode({ id, data, selected, isConnectable }: NodeProps<RuleNodeType>) {
  const main = useContext(MainOutboundContext) === id;
  const name = captureNodeName(data);
  const definition = getDefinition(data.kind);
  const disabled = isDisabledInbound(data);
  const details = summarizeNode(data);
  const interfaces = useContext(OutboundInterfacesContext);
  if (data.kind === 'direct-outbound')
    details.push([
      'Interface',
      directInterfaceValue(data) || automaticDirectInterface(data, interfaces),
    ]);
  const compact = data.kind === 'direct-outbound' || data.kind === 'block-outbound';
  const issues = useContext(GraphDiagnosticsContext)[id] ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const ports = getOutputPorts(data.kind, data);
  const accepted = targetConnectionKinds(data);
  const acceptedColors = accepted.map((kind) => connectionTypes[kind].color);
  const table =
    data.kind === 'ics-tun' ||
    data.kind === 'fakedns' ||
    data.kind === 'windivert-inbound' ||
    isRuleTableKind(data.kind) ||
    isDnsEditor(data) ||
    isPolicyKind(data.kind) ||
    data.kind === 'proxy-chain' ||
    isNativeXrayKind(data.kind) ||
    isProtocolKind(data.kind);
  const namedPorts =
    ports.includes('observation') ||
    table ||
    (isInboundKind(data.kind) && !isProtocolInbound(data.kind));
  const openEditor = useContext(NodeEditorContext);
  const updateInternals = useUpdateNodeInternals();
  const portSignature = ports.join(',');
  useEffect(() => {
    updateInternals(id);
  }, [id, portSignature, updateInternals]);
  return (
    <article
      className={`rule-node category-${definition.category}${errors.length ? ' has-errors' : ''}${selected ? ' is-selected' : ''}${main ? ' is-main' : ''}${disabled || data.settings.enabled === false ? ' is-disabled' : ''}`}
      data-inbound-disabled={disabled || undefined}
      aria-label={`${name}, ${definition.title}${disabled ? ', disabled' : ''}${main ? ', Main outbound' : ''}`}
    >
      <div className="node-kicker">
        <span className="node-icon">
          <NodeIcon kind={data.kind} />
        </span>
        <span>
          {definition.group === 'Local capture'
            ? 'LOCAL CAPTURE'
            : (kindLabels[data.kind] ?? categoryLabels[definition.category])}
        </span>
        {main ? (
          <span className="node-main-badge">
            <Crown size={11} aria-hidden="true" /> Main
          </span>
        ) : disabled ? (
          <span className="node-disabled-label">Disabled</span>
        ) : (
          <span className="node-indicator" />
        )}
      </div>
      <h3 dir="auto" title={name}>
        {name || 'Unnamed node'}
      </h3>
      {!!errors.length && (
        <div className="node-problem" title={errors.map((e) => e.message).join('\n')}>
          {errors.length} runtime {errors.length === 1 ? 'issue' : 'issues'}
        </div>
      )}
      {(!!details.length || data.kind === 'fakedns') && (
        <div className="node-details">
          {details.map(([label, value]) => (
            <div className="node-detail" key={label}>
              <span>{label}</span>
              <strong title={value}>{value || 'Not set'}</strong>
            </div>
          ))}
          {data.kind === 'fakedns' && <FakeDnsUsage />}
        </div>
      )}
      <OutboundTestSummary
        nodeId={id}
        observationTag={isOutboundKind(data.kind) ? String(data.settings.tag ?? '') : undefined}
      />
      {namedPorts ? (
        <>
          {table &&
            (!isNativeXrayKind(data.kind) ||
              isNativeConfigEditor(data.kind) ||
              ['xray-inbound', 'xray-outbound'].includes(data.kind)) && (
              <button className="node-edit-button nodrag nopan" onClick={() => openEditor(id)}>
                Edit{' '}
                {data.kind === 'ics-tun'
                  ? 'sharing'
                  : isProtocolKind(data.kind) ||
                      ['xray-inbound', 'xray-outbound'].includes(data.kind)
                    ? 'protocol'
                    : data.kind === 'windivert-inbound'
                      ? 'adapters'
                      : data.kind === 'proxy-chain'
                        ? 'chain'
                        : data.kind === 'policy-group'
                          ? 'group'
                          : data.kind === 'observatory'
                            ? 'probes'
                            : data.kind === 'fakedns'
                              ? 'FakeDNS'
                              : data.kind === 'dns-servers'
                                ? 'servers'
                                : data.kind === 'xray-options'
                                  ? 'settings'
                                  : data.kind === 'xray-dns-servers'
                                    ? 'servers'
                                    : ['dns-handler', 'xray-dns'].includes(data.kind)
                                      ? 'DNS'
                                      : 'rules'}
                …
              </button>
            )}
          {data.kind === 'routing-filter' && (
            <button className="node-edit-button nodrag nopan" onClick={() => openEditor(id, 'log')}>
              <ListFilter size={14} aria-hidden="true" /> Traffic log
            </button>
          )}
          <div className="named-port-list">
            {ports.map((port) => (
              <div key={port}>
                <span>
                  <i
                    className="port-type-dot"
                    style={{ background: connectionTypes[sourceConnectionKind(data, port)].color }}
                  />
                  {portLabel(port, data)}
                  {isInboundKind(data.kind) &&
                    port === 'dns' &&
                    ` · ${String(data.settings.dnsPorts || '53')}`}
                  {isInboundKind(data.kind) &&
                    port === 'encrypted-dns' &&
                    ` · ${String(data.settings.encryptedDnsPorts)}`}
                </span>
              </div>
            ))}
          </div>
        </>
      ) : (
        !compact && (
          <div className="node-port-labels">
            <span>{hasInputPort(data.kind) ? 'Input' : 'Source'}</span>
            {isProtocolInbound(data.kind) ? (
              <span>All traffic</span>
            ) : (
              <span>
                {ports.length === 2
                  ? 'Matches / Otherwise'
                  : ports.length
                    ? 'Output'
                    : 'Destination'}
              </span>
            )}
          </div>
        )
      )}
      {hasInputPort(data.kind) && (
        <Handle
          type="target"
          position={Position.Left}
          id="in"
          data-diagnostic-port="in"
          tabIndex={-1}
          isConnectable={isConnectable}
          style={{
            color: acceptedColors[0],
            borderColor: acceptedColors.length === 1 ? acceptedColors[0] : 'transparent',
            ...(acceptedColors.length > 1
              ? {
                  background: `conic-gradient(${acceptedColors.map((color, i) => `${color} ${(i * 100) / acceptedColors.length}% ${((i + 1) * 100) / acceptedColors.length}%`).join(',')})`,
                }
              : {}),
          }}
          data-accepts={accepted.join(' ')}
          title={`${data.label}: accepts ${accepted.map((kind) => connectionTypes[kind].label).join(', ')}`}
          aria-label={`${data.label}: ${data.kind === 'observatory' ? 'Observation' : 'input'} port`}
        />
      )}
      {ports.map((port, index) => (
        <Handle
          key={port}
          type="source"
          position={Position.Right}
          id={port}
          data-diagnostic-port={port}
          tabIndex={-1}
          isConnectable={isConnectable && data.kind !== 'xray-dns-servers'}
          style={{
            color: connectionTypes[sourceConnectionKind(data, port)].color,
            borderColor: connectionTypes[sourceConnectionKind(data, port)].color,
            top: namedPorts ? `calc(100% - ${(ports.length - index - 0.5) * 27}px)` : '50%',
          }}
          className={
            port === 'observation' ? 'port-observation' : namedPorts ? 'port-named' : `port-${port}`
          }
          data-connection-kind={sourceConnectionKind(data, port)}
          title={`${data.label}: ${port === 'dns' && !table ? `DNS (${isHttpInbound(data) ? 'TCP' : 'TCP/UDP'} ports ${String(data.settings.dnsPorts || '53')})` : portLabel(port, data)} · ${connectionTypes[sourceConnectionKind(data, port)].description}`}
          aria-label={`${data.label}: ${portLabel(port, data)} ${port === 'observation' ? 'port' : 'output port'}`}
        />
      ))}
    </article>
  );
}
export default memo(RuleNode);
