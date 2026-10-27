import { listenerNetworks } from '../graph/listenerNetworks';
import AdvancedSettings from './AdvancedSettings';
import NativeObjectFields from './NativeObjectFields';
import { configuredFieldLabels } from '../graph/settingsLayout';
import { nativeValue } from '../graph/protocols';
import { jsonRecord } from '../graph/xrayJson';
import type { DefaultHint } from '../graph/coreDefaults';
import type { NativeField } from '../graph/nativeFields';
import type { GlobalDefaults } from '../graph/types';
import { factoryDefaults } from '../graph/defaults';
import { udpListenerEnvironment, udpListenerFields } from '../graph/udpListeners';
import { setSocketBuffer, socketBufferValue, type SocketBuffer } from '../graph/socketBuffers';

function sockopt(input: Record<string, unknown>): Record<string, unknown> {
  const stream = nativeValue(input, 'streamSettings');
  const value = jsonRecord(stream) && nativeValue(stream, 'sockopt');
  return jsonRecord(value) ? value : {};
}

const ignoreValidity = () => {};

export default function InboundSocketBuffers({
  input,
  effective,
  globalDefaults,
  onChange,
  onValidity = ignoreValidity,
}: {
  input: Record<string, unknown>;
  effective: Record<string, unknown>;
  globalDefaults?: GlobalDefaults;
  onChange: (sockopt: Record<string, unknown>) => void;
  onValidity?: (id: string, valid: boolean) => void;
}) {
  const networks = listenerNetworks(effective);
  if (!networks.length) return null;
  const current = sockopt(input),
    defaults = sockopt(effective);
  const environment = udpListenerEnvironment(globalDefaults ?? factoryDefaults());
  const fields: NativeField[] = [],
    values: Record<string, unknown> = {},
    hints: Record<string, DefaultHint> = {};
  for (const network of networks)
    for (const buffer of ['receive', 'send'] as SocketBuffer[]) {
      const key = `${network}-${buffer}`;
      const field: NativeField = {
        key,
        label: `${network.toUpperCase()} ${buffer} buffer (bytes)`,
        type: 'integer',
        min: 1,
        max: 2147483647,
      };
      fields.push(field);
      const selected = socketBufferValue(current, network, buffer),
        inherited = socketBufferValue(defaults, network, buffer);
      const shared =
        environment[
          buffer === 'receive'
            ? udpListenerFields.udpListenerReceiveKiB
            : udpListenerFields.udpListenerSendKiB
        ];
      if (selected.value !== undefined) values[key] = selected.value;
      const differentFamilies = selected.families[0] !== selected.families[1];
      hints[key] = differentFamilies
        ? {
            text: 'Different IPv4 / IPv6 values',
            source: 'native',
            detail:
              'Native JSON contains separate address-family values. Enter a value to override both.',
          }
        : inherited.value !== undefined
          ? { text: String(inherited.value), source: 'global' }
          : network === 'udp' && Number(shared) > 0
            ? { text: shared, source: 'global' }
            : { text: 'Windows default', source: 'core' };
    }
  const protocol = nativeValue(effective, 'protocol');
  const settings = nativeValue(effective, 'settings');
  const socksUDP =
    ['socks', 'mixed'].includes(String(protocol)) &&
    jsonRecord(settings) &&
    nativeValue(settings, 'udp') === true;
  return (
    <AdvancedSettings title="Socket buffers" configured={configuredFieldLabels(values, fields)}>
      <NativeObjectFields
        plain
        object={values}
        fields={fields}
        hints={hints}
        idPrefix="protocol-buffer"
        onValidity={onValidity}
        onChange={(next) => {
          for (const network of networks)
            for (const buffer of ['receive', 'send'] as SocketBuffer[]) {
              const key = `${network}-${buffer}`;
              if (next[key] !== values[key]) {
                onChange(
                  setSocketBuffer(defaults, network, buffer, next[key] as number | undefined),
                );
                return;
              }
            }
        }}
      />
      <p className="runtime-scope">
        Per Windows socket. Clear a field to remove its Windows override. QUIC may enlarge its
        buffers.
      </p>
      {socksUDP && (
        <p className="runtime-scope">SOCKS UDP uses the listener buffers in Global defaults.</p>
      )}
    </AdvancedSettings>
  );
}
