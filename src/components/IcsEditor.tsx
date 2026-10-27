import { useState } from 'react';
import Dialog from './Dialog';
import { getDefinition } from '../graph/catalog';
import { DEFAULT_ICS_ADAPTER_NAME, DEFAULT_ICS_GATEWAY, tunAdapterNameProblem } from '../graph/tun';
import { automaticFakeDns } from '../graph/fakeDns';
import { ipProblem } from '../graph/addressValidation';
import { jsonRecord, parseJsonObject } from '../graph/xrayJson';
import { captureNodeName, nativeValue, setNative } from '../graph/protocols';
import {
  overrideSetting,
  resetNodeDefaults,
  resolveNodeData,
  factoryDefaults,
} from '../graph/defaults';
import InheritableSetting from './InheritableSetting';
import useInternetSharing from '../useInternetSharing';
import {
  configureIcsGraph,
  canUseSharing,
  configureSharedIpv6Host,
  sharedIpv6Ready,
  type SharingInspection,
} from '../graph/internetSharing';
import { serviceCall, errorText } from '../serviceClient';
import type { GraphState, RuleNode } from '../graph/types';

export function SharingRecovery({
  sharing,
  refresh,
}: {
  sharing: SharingInspection;
  refresh: () => void;
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function recover(mode: 'restore' | 'keep') {
    setBusy(true);
    setError('');
    try {
      await serviceCall(
        `tun.sharing.${mode}`,
        mode === 'keep' ? { expectedVersion: sharing.version } : {},
      );
      refresh();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }
  if (
    !sharing.recoveryPending &&
    sharing.source !== 'remembered' &&
    (!sharing.hasSavedPair || sharing.managed)
  )
    return null;
  return (
    <section>
      {sharing.recoveryPending && (
        <p className="runtime-error" role="alert">
          {sharing.lastError?.message || 'Sharing recovery needs attention.'}
        </p>
      )}
      <div className="field-action-row">
        {(sharing.recoveryPending || sharing.source === 'remembered') && (
          <button
            className="secondary-button"
            disabled={busy}
            onClick={() => void recover('restore')}
          >
            Restore sharing
          </button>
        )}
        <button className="secondary-button" disabled={busy} onClick={() => void recover('keep')}>
          {!sharing.managed ? 'Forget saved sharing' : 'Keep Windows changes'}
        </button>
      </div>
      {error && (
        <p role="alert" className="runtime-error">
          {error}
        </p>
      )}
    </section>
  );
}

export default function IcsEditor({
  node,
  graph,
  onApply,
  onClose,
}: {
  node: RuleNode;
  graph: GraphState;
  onApply: (graph: GraphState) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(node.data);
  const [filtered, setFiltered] = useState(false);
  const sharing = useInternetSharing(node.id);
  const [error, setError] = useState('');
  const value = sharing.value;
  const connected = graph.edges.some((e) => e.source === node.id && e.sourceHandle === 'traffic');
  const fields = getDefinition('ics-tun').fields.filter((f) =>
    ['sniffing', 'sniffHttp', 'sniffTls', 'sniffQuic', 'routeOnly', 'metadataOnly'].includes(f.key),
  );
  const raw = parseJsonObject(String(draft.settings.json));
  const nativeSettings = nativeValue(raw, 'settings');
  const settings = jsonRecord(nativeSettings) ? nativeSettings : {};
  const adapterName = nativeValue(settings, 'name');
  const gateways = nativeValue(settings, 'gateway');
  const [gatewayText, setGatewayText] = useState(
    Array.isArray(gateways) ? gateways.join('\n') : '',
  );
  const setGateways = (text: string) => {
    setGatewayText(text);
    setDraft({
      ...draft,
      settings: {
        ...draft.settings,
        json: JSON.stringify(
          setNative(
            raw,
            'settings',
            setNative(settings, 'gateway', text.split(/\s+/).filter(Boolean)),
          ),
          null,
          2,
        ),
      },
    });
  };
  const resolved = resolveNodeData(draft, graph.defaults);
  const outdated =
    value?.version !== draft.settings.sharingVersion ||
    value?.pair?.public.id !== draft.settings.publicId ||
    value?.pair?.private.id !== draft.settings.privateId;
  function apply(confirm: boolean, hostIpv6 = false) {
    try {
      if (!draft.label.trim()) throw new Error('Enter a name.');
      const nameProblem = tunAdapterNameProblem(adapterName);
      if (nameProblem) throw new Error(nameProblem);
      if (
        !gatewayText.trim() ||
        gatewayText
          .trim()
          .split(/\s+/)
          .some((value) => !value.includes('/') || ipProblem(value))
      )
        throw new Error('Enter valid adapter addresses in IP/prefix form.');
      let next = {
        ...graph,
        nodes: graph.nodes.map((n) =>
          n.id === node.id ? { ...n, data: { ...draft, label: captureNodeName(draft) } } : n,
        ),
      };
      if (confirm && value) next = configureIcsGraph(next, value, node.position, filtered);
      if (hostIpv6) next = configureSharedIpv6Host(next);
      onApply(next);
      onClose();
    } catch (e) {
      setError(errorText(e));
    }
  }
  return (
    <Dialog
      title="ICS TUN"
      onClose={onClose}
      footer={
        <>
          <button
            className="primary-button"
            disabled={!draft.label.trim() || sharing.busy || !canUseSharing(value)}
            onClick={() => apply(true)}
          >
            {outdated
              ? value?.source === 'remembered'
                ? 'Use saved sharing'
                : 'Use detected sharing'
              : connected
                ? 'Apply changes'
                : 'Connect to upstream'}
          </button>
          <button
            className="secondary-button"
            disabled={!draft.label.trim()}
            onClick={() => apply(false)}
          >
            Save settings
          </button>
          <button className="secondary-button" onClick={onClose}>
            Cancel
          </button>
        </>
      }
    >
      <label className="editor-field">
        <span>Name</span>
        <input
          value={typeof adapterName === 'string' ? adapterName : ''}
          placeholder={DEFAULT_ICS_ADAPTER_NAME}
          maxLength={100}
          onChange={(e) =>
            setDraft({
              ...draft,
              settings: {
                ...draft.settings,
                json: JSON.stringify(
                  setNative(
                    raw,
                    'settings',
                    setNative(settings, 'name', e.target.value || undefined),
                  ),
                  null,
                  2,
                ),
              },
            })
          }
        />
      </label>
      <div className="field-action-row">
        <p>
          {sharing.busy
            ? 'Inspecting Windows sharing…'
            : value?.pair
              ? `${value.source === 'remembered' ? 'Saved sharing: ' : ''}${value.pair.public.name} → ${value.pair.private.name}`
              : sharing.error
                ? 'Windows sharing is unknown.'
                : 'No Windows Internet sharing detected.'}
        </p>
        <button className="secondary-button" disabled={sharing.busy} onClick={sharing.refresh}>
          Refresh
        </button>
      </div>
      {(sharing.error || value?.problem) && (
        <p className="runtime-error" role="alert">
          {sharing.error || value?.problem}
        </p>
      )}
      {value?.connections.some((c) => c.role !== null && c.portMappings?.length) && (
        <ul className="field-message">
          {value.connections
            .filter((c) => c.role !== null)
            .flatMap((c) =>
              (c.portMappings ?? []).map((m, index) => (
                <li key={`${c.id}-${index}`}>
                  <strong>
                    {c.name}:{' '}
                    {m.protocol === 6
                      ? 'TCP'
                      : m.protocol === 17
                        ? 'UDP'
                        : `Protocol ${m.protocol}`}{' '}
                    {m.externalPort}
                  </strong>
                  {' → '}
                  {m.targetName || m.target}:{m.internalPort} · {m.name}
                </li>
              )),
            )}
        </ul>
      )}
      {value?.source === 'remembered' && !value.managed && !value.recoveryPending && (
        <p className="field-message">
          Windows sharing is off. Start ICS TUN to use the saved pair, or keep it off for host TUN
          only.
        </p>
      )}
      {value && <SharingRecovery sharing={value} refresh={sharing.refresh} />}
      {value?.ipv6Forwarding && (
        <p className="field-message">
          Host TUN manages IPv6 forwarding on {value.ipv6Forwarding.upstream}. Stop restores its
          original setting.
        </p>
      )}
      <label className="editor-checkbox">
        <input
          type="checkbox"
          checked={draft.settings.shareIpv6 === true}
          onChange={(e) =>
            setDraft({ ...draft, settings: { ...draft.settings, shareIpv6: e.target.checked } })
          }
        />
        Share IPv6 with clients
      </label>
      {draft.settings.shareIpv6 === true && (
        <>
          <p className="field-message">
            Clients use automatic IPv6 addressing and the existing DHCP DNS settings.
          </p>
          {value?.ipv6Clients && (
            <p className="field-message">
              {value.ipv6Clients.private} · {value.ipv6Clients.prefix}
            </p>
          )}
          {!sharedIpv6Ready(graph) && (
            <button
              type="button"
              className="secondary-button"
              disabled={sharing.busy || !canUseSharing(value)}
              onClick={() => apply(true, true)}
            >
              Set up host IPv6
            </button>
          )}
        </>
      )}
      <p className="field-message">Stop restores native sharing while this node is enabled.</p>
      {connected ? (
        <p className="field-message">
          Traffic →{' '}
          {graph.nodes.find(
            (n) =>
              n.id ===
              graph.edges.find((e) => e.source === node.id && e.sourceHandle === 'traffic')?.target,
          )?.data.label || 'Missing destination'}
        </p>
      ) : (
        <label className="editor-checkbox">
          <input
            type="checkbox"
            checked={filtered}
            onChange={(e) => setFiltered(e.target.checked)}
          />
          Add traffic filter
        </label>
      )}
      <p className="field-message">
        Route by destination, port or detected protocol. Per-client and host process rules are
        unsupported. Gateway DNS uses this PC’s resolver.
      </p>
      <details className="editor-advanced">
        <summary>Adapter addresses</summary>
        <label className="editor-field">
          <span>Adapter addresses (CIDR)</span>
          <textarea
            rows={2}
            aria-label="Adapter addresses (CIDR)"
            value={gatewayText}
            spellCheck={false}
            onChange={(event) => setGateways(event.target.value)}
          />
        </label>
        <button
          className="secondary-button"
          type="button"
          onClick={() => setGateways(DEFAULT_ICS_GATEWAY)}
        >
          Use default
        </button>
      </details>
      {automaticFakeDns(graph) && <p className="field-help">FakeDNS name recovery · Automatic</p>}
      <details className="editor-advanced">
        <summary>Traffic inspection</summary>
        {fields.map((field) => (
          <InheritableSetting
            key={field.key}
            field={field}
            idPrefix="ics"
            issues={[]}
            data={resolved}
            defaults={graph.defaults}
            value={resolved.settings[field.key]}
            onChange={(v) => setDraft({ ...draft, ...overrideSetting(draft, field.key, v) })}
            onReset={() =>
              setDraft({
                ...draft,
                ...resetNodeDefaults(draft, graph.defaults ?? factoryDefaults(), field.key),
              })
            }
          />
        ))}
      </details>
      {error && (
        <p className="runtime-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
