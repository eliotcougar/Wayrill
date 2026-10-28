import { settingDefaultState } from '../graph/defaults';
import { defaultSourceLabel } from '../graph/coreDefaults';
import type { GlobalDefaults, RuleNodeData } from '../graph/types';
import { SettingField } from './SettingField';
import { useContext, type ComponentProps } from 'react';
import { automaticDirectInterface, OutboundInterfacesContext } from '../outboundInterfaces';

type Props = Omit<ComponentProps<typeof SettingField>, 'hint' | 'inherited' | 'onInherit'> & {
  data: RuleNodeData;
  defaults?: GlobalDefaults;
  preparedRoot?: Record<string, unknown> | null;
  onReset?: () => void;
  onOverride?: () => void;
};
export default function InheritableSetting({
  data,
  defaults,
  preparedRoot,
  onReset,
  onOverride,
  ...props
}: Props) {
  const interfaces = useContext(OutboundInterfacesContext);
  const state = settingDefaultState(data, props.field, defaults, preparedRoot),
    id = `${props.idPrefix ?? 'setting'}-${props.field.key}`,
    target = state.resetHint && `${defaultSourceLabel(state.resetHint)} · ${state.resetHint.text}`;
  return (
    <div className="inheritable-setting">
      {onReset && (
        <>
          <div className="setting-inheritance">
            <span
              className={state.independent ? 'override-badge' : 'inherited-badge'}
              title={state.detail}
            >
              {state.label}
            </span>
            {state.independent ? (
              <button
                type="button"
                className="secondary-button button--small"
                aria-label={'Use default for ' + props.field.label}
                title={target ? `Use ${target}` : 'Follow the defaults for this graph'}
                onClick={onReset}
              >
                Use default
              </button>
            ) : (
              <button
                type="button"
                className="secondary-button button--small"
                disabled={!onOverride}
                aria-label={'Override ' + props.field.label}
                title="Keep the current value in this node, even if app defaults change"
                onClick={onOverride}
              >
                Override
              </button>
            )}
          </div>
          {['Imported omission', 'Node omission'].includes(state.label) && (
            <p className="inheritance-detail" id={`${id}-origin`}>
              Absent from JSON; app defaults are not applied.
            </p>
          )}
          {state.independent && target && (
            <p className="inheritance-detail" id={`${id}-reset`}>
              Use default → {target}
            </p>
          )}
        </>
      )}
      <SettingField
        directInterface={data.kind === 'direct-outbound'}
        automaticInterface={
          data.kind === 'direct-outbound' && props.field.key === 'interface'
            ? automaticDirectInterface(data, interfaces)
            : undefined
        }
        {...props}
        hint={state.hint}
        inheritHint={state.resetHint}
        omitted={state.independent && state.inherited}
        inherited={state.inherited}
        onInherit={onReset}
        effectiveText={state.effectiveText}
        describedBy={
          [
            ['Imported omission', 'Node omission'].includes(state.label) && `${id}-origin`,
            state.independent && target && `${id}-reset`,
          ]
            .filter(Boolean)
            .join(' ') || undefined
        }
      />
    </div>
  );
}
