import { getDefinition } from './catalog';
import { inboundPreview, inboundProblems } from './inbounds';
import { fieldProblem } from './settingValidation';
import { proxyInboundSettings, preserveProxyAccountAlias } from '@wayrill/core/proxyInbound';
import type { RuleNodeData, SettingValue } from './types';

export function importProxyInbound(raw: Record<string, unknown>): Record<string, SettingValue> {
  const definition = getDefinition('proxy-inbound');
  const s = proxyInboundSettings(raw, definition.defaults);
  for (const f of definition.fields)
    if (fieldProblem(f, s))
      throw new Error('A native listener field cannot yet use the proxy controls.');
  if (
    inboundProblems({ kind: 'proxy-inbound', settings: s, label: '', description: '' }).some(
      (p) => p.severity === 'error',
    )
  )
    throw new Error('Native listener needs the JSON editor.');
  return s;
}
export function projectProxyInbound(data: RuleNodeData): Record<string, unknown> {
  const original = data.native?.original;
  return preserveProxyAccountAlias(
    inboundPreview(data),
    original?.protocol === data.settings.mode ? original.settings : undefined,
  );
}
