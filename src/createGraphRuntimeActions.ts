import { isDisabledInbound } from './graph/inboundState';
import { runtimeProgress } from './runtimeProgress';
import { runtimePresentation } from './runtimePresentation';
import { parseGraph, serializeGraph } from './graph/model';
import { readSubscriptionDocument, stageSubscriptionGraph } from './profiles/serviceSubscriptions';
import { jsonArray, jsonEqual } from './graph/xrayJson';
import { poolRoutingState } from './pool/model';
import type { ConfigValidationResult } from './serviceClient';
import type { GraphState } from './graph/types';
import type useGraphAnalysis from './useGraphAnalysis';
import type { RuntimeController } from './useRuntime';

export default function createGraphRuntimeActions(
  graph: GraphState,
  checks: ReturnType<typeof useGraphAnalysis>,
  runtime: RuntimeController,
  poolDocumentMatches?: boolean,
  syncingPool = false,
  layerPreferences = false,
) {
  const { snapshot, connected, busy, desktop } = runtime;
  const serviceReady = desktop && connected && !!snapshot && !busy;
  const progress = runtimeProgress(runtime);
  const canCall = serviceReady && !progress;
  const compiled = checks.compilation,
    issues = checks.issues;
  const errors = issues.filter((i) => i.severity === 'error');
  const canStop =
    serviceReady &&
    (!progress ||
      (snapshot.lifecycle?.recovering && snapshot.recovery?.desiredState === 'running')) &&
    (snapshot.recovery?.desiredState === 'running' ||
      snapshot.recovery?.state === 'waiting' ||
      snapshot.core.state !== 'stopped' ||
      snapshot.capture?.state === 'running' ||
      snapshot.capture?.firewallManaged ||
      snapshot.systemProxy.managed ||
      snapshot.systemCapture?.managed ||
      snapshot.systemProxy.recoveryPending ||
      snapshot.tun?.sharing?.managed ||
      snapshot.tun?.sharing?.recoveryPending);
  const winCapture = compiled?.capture?.inputs.some((i) => i.source !== 'tun');
  const tunApplications = compiled?.capture?.inputs.some((i) => i.source === 'tun');
  const captureAvailable =
    (!winCapture || runtime.capabilities.includes('windivert.ruleProcesses')) &&
    (!tunApplications || runtime.capabilities.includes('windows.tun.applications')) &&
    (!compiled?.capture?.tunSharing || runtime.capabilities.includes('windows.ics.graph'));
  const captureOwnership = snapshot?.capture?.availability;
  const ownershipUnavailable = !!captureOwnership && captureOwnership.state !== 'available';
  const captureBlocked = !!winCapture && ownershipUnavailable;
  const view = runtimePresentation(runtime, compiled, poolDocumentMatches, syncingPool);
  const mode = view.appliedMatch
    ? snapshot?.core.state === 'stopped'
      ? 'start'
      : 'restart'
    : 'apply';
  const activationLabel =
    !view.current || snapshot?.core.state === 'stopped'
      ? 'Start'
      : mode === 'restart'
        ? 'Restart'
        : 'Apply';
  const activationTitle =
    mode === 'start'
      ? 'Start the applied graph'
      : mode === 'restart'
        ? 'Restart the applied graph'
        : 'Apply and start this draft';
  const activationMessage =
    mode === 'start'
      ? 'Graph started.'
      : mode === 'restart'
        ? 'Graph restarted.'
        : 'Graph applied and started.';
  const activationAvailable = runtime.capabilities.includes(
    mode === 'apply' ? 'config.applyAndStart' : 'xray.lifecycle',
  );
  const nativeAvailable = !graph.xray || runtime.capabilities.includes('xray.nativeImport');
  const observationAvailable =
    runtime.capabilities.includes('xray.observatory') ||
    (!compiled?.config.observatory && !compiled?.config.burstObservatory);
  const protocolAvailable = (
    [
      ['inbounds', 'inbound'],
      ['outbounds', 'outbound'],
    ] as const
  ).every(
    ([key, direction]) =>
      !jsonArray(compiled?.config[key]) ||
      (compiled.config[key] as Record<string, unknown>[]).every((p) =>
        ((runtime.protocols?.[direction] ?? []) as readonly string[]).includes(
          String(p.protocol).toLowerCase(),
        ),
      ),
  );
  const adapterInput =
    jsonArray(compiled?.config.inbounds) &&
    (compiled.config.inbounds as Record<string, unknown>[]).some(
      (i) => String(i.protocol).toLowerCase() === 'tun',
    );
  const capacityAvailable =
    !compiled ||
    (!!runtime.limits &&
      checks.configBytes <= runtime.limits.configBytes &&
      compiled.summary.outboundCount <= runtime.limits.outbounds &&
      compiled.summary.trafficRuleCount <= runtime.limits.routingRules);
  const adapterAvailable = !adapterInput || runtime.protocols?.adapterRuntime === true;

  const draftUnavailable = checks.pending
    ? 'Checking graph…'
    : !compiled || errors.length
      ? 'Resolve the graph errors first.'
      : !nativeAvailable ||
          !captureAvailable ||
          !observationAvailable ||
          !protocolAvailable ||
          !capacityAvailable
        ? 'The service does not support this draft. Open Run graph for details.'
        : '';
  const serviceUnavailable = !desktop
    ? 'Requires the Windows app.'
    : !connected || !snapshot
      ? 'Service offline.'
      : busy || progress
        ? 'Wait for the current operation.'
        : '';
  const validateReason = serviceUnavailable || draftUnavailable;
  const applyReason =
    (syncingPool && 'Loading the applied Pool graph…') ||
    validateReason ||
    (!activationAvailable
      ? 'Update the service to enable this action.'
      : captureBlocked
        ? captureOwnership?.message || 'Capture ownership must be verified.'
        : !adapterAvailable
          ? 'The service cannot run this adapter input.'
          : '');
  const setupOutbounds = graph.nodes.filter(
    (node) =>
      node.data.kind === 'vless-outbound' &&
      (node.data.settings.address === 'edge.example.net' ||
        node.data.settings.id === 'wayrill-example') &&
      node.data.description ===
        'Fictional placeholder. Replace with a working VLESS profile before testing.',
  );
  const setupReason = setupOutbounds.length
    ? 'Replace the example outbound with a working profile from Stash.'
    : '';
  const canValidate = !validateReason,
    canApply = !applyReason && !setupReason;
  async function validate() {
    if (!canValidate || !compiled) return false;
    const result = await runtime.run('config.validate', {
      config: compiled.config,
      ...(compiled.resources ? { resources: compiled.resources } : {}),
      ...(compiled.capture ? { capture: compiled.capture } : {}),
    });
    return (result ?? {}) as ConfigValidationResult;
  }
  async function activate() {
    if (!canApply || !compiled || !snapshot) return false;
    if (mode !== 'apply') {
      await runtime.run(mode === 'start' ? 'core.start' : 'core.restart', {
        revision: snapshot.config.revision,
      });
      return true;
    }
    if (graph.poolId) {
      const { text } = await readSubscriptionDocument('applied');
      if (
        (!text ||
          !jsonEqual(
            poolRoutingState(parseGraph(text), layerPreferences),
            poolRoutingState(graph, layerPreferences),
          )) &&
        !window.confirm(
          'Apply changes to Pool-managed routes? This will pause automatic routing updates. To keep updates, use personal Before or After traffic rules, or edit your choices in Pool connection.',
        )
      )
        return false;
    }
    await runtime.run(
      'config.applyAndStart',
      {
        config: compiled.config,
        ...(compiled.resources ? { resources: compiled.resources } : {}),
        ...(runtime.capabilities.includes('config.displayNames')
          ? { displayNames: compiled.displayNames }
          : {}),
        ...(compiled.capture ? { capture: compiled.capture } : {}),
        expectedRevision: snapshot.config.revision,
      },
      runtime.capabilities.includes('subscriptions.service')
        ? async () => ({ sourceGraphToken: await stageSubscriptionGraph(serializeGraph(graph)) })
        : undefined,
    );
    return true;
  }
  async function stop() {
    if (!canStop) return false;
    await runtime.run(
      'core.stop',
      graph.nodes.some((n) => n.data.kind === 'ics-tun' && isDisabledInbound(n.data))
        ? { disableSharing: true }
        : {},
    );
    return true;
  }
  return {
    view,
    checks,
    compiled,
    errors,
    canCall,
    canStop,
    canValidate,
    canApply,
    activationLabel,
    activationTitle,
    activationMessage,
    validateReason,
    applyReason: applyReason || setupReason,
    setupOutbounds,
    validate,
    activate,
    stop,
    captureAvailable,
    captureOwnership,
    ownershipUnavailable,
    captureBlocked,
    activationAvailable,
    nativeAvailable,
    observationAvailable,
    protocolAvailable,
    capacityAvailable,
    adapterAvailable,
  };
}
export type GraphRuntimeActions = ReturnType<typeof createGraphRuntimeActions>;
