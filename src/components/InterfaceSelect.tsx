import { useContext, type ComponentProps } from 'react';
import { OutboundInterfacesContext } from '../outboundInterfaces';

type Props = Omit<ComponentProps<'select'>, 'value' | 'onChange'> & {
  value: string;
  onChange: (value: string) => void;
  preferUpstream?: boolean;
  automaticName?: string;
};
export default function InterfaceSelect({
  value,
  onChange,
  preferUpstream = false,
  automaticName,
  ...props
}: Props) {
  const interfaces = useContext(OutboundInterfacesContext);
  const automatic =
    automaticName ?? ((preferUpstream || interfaces.captured) && interfaces.automatic);
  return (
    <select
      {...props}
      value={value}
      className={value ? undefined : 'default-hint-select'}
      title={interfaces.error ?? props.title}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">{automatic ? `Automatic (${automatic})` : 'Automatic'}</option>
      {value && !interfaces.adapters.some((adapter) => adapter.name === value) && (
        <option value={value}>{value} (unavailable)</option>
      )}
      {interfaces.adapters.map((adapter) => (
        <option key={adapter.name} value={adapter.name}>
          {adapter.name}
          {adapter.active ? '' : ' (inactive)'}
        </option>
      ))}
    </select>
  );
}
