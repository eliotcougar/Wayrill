import { isProtocolKind } from './protocols';
import { isNativeConfigEditor } from './xrayNodes';
import { isRuleTableKind } from './rules';
import type { Diagnostic, RuleNodeData } from './types';

export function hasNodeEditor(data: RuleNodeData) {
  return (
    isRuleTableKind(data.kind) ||
    isProtocolKind(data.kind) ||
    isNativeConfigEditor(data.kind) ||
    [
      'dns-handler',
      'dns-routing-filter',
      'dns-servers',
      'policy-group',
      'proxy-chain',
      'observatory',
      'windivert-inbound',
      'fakedns',
      'xray-inbound',
      'xray-outbound',
    ].includes(data.kind)
  );
}

export function ruleDiagnosticTab(issue?: Diagnostic) {
  return issue?.outputId || issue?.fieldKey === 'outputs'
    ? ('outputs' as const)
    : ('rules' as const);
}

export function dnsDiagnosticTab(issue?: Diagnostic) {
  if (['fallbackMode', 'fallbackFirst', 'parallel'].includes(issue?.fieldKey ?? ''))
    return 'main' as const;
  return issue?.outputId || issue?.fieldKey === 'outputs'
    ? ('settings' as const)
    : issue?.rowId ||
        ['rules', 'policyRules', 'servers'].includes(issue?.fieldKey ?? '') ||
        !issue?.fieldKey
      ? ('main' as const)
      : ('settings' as const);
}

export function policyDiagnosticTab(data: RuleNodeData, issue?: Diagnostic) {
  if (data.kind === 'observatory') return 'observation' as const;
  const key = issue?.fieldKey ?? '';
  if (
    ['strategy', 'expected', 'maxRTT', 'tolerance', 'baselines', 'costs', 'strategyExtra'].includes(
      key,
    )
  )
    return 'strategy' as const;
  if (
    [
      'observe',
      'mode',
      'subjects',
      'probeURL',
      'probeInterval',
      'enableConcurrency',
      'destination',
      'connectivity',
      'interval',
      'sampling',
      'timeout',
      'httpMethod',
      'healthExtra',
    ].includes(key)
  )
    return 'observation' as const;
  return 'candidates' as const;
}
