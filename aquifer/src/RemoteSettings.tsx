import { EditorTabList, useEditorTabs } from '@wayrill/ui/EditorTabs';
import { useEffect, useId, useRef, useState } from 'react';
import { jsonEqual, jsonRecord, jsonText, parseXrayJson } from './graph/xrayJson';
import { errorMessage } from './remoteClient';
import RemoteRoutingSettings, { type RouteDestination } from './RemoteRoutingSettings';
import RemoteInboundSettings, { editableInbound } from './RemoteInboundSettings';
import { inboundIssues, inboundTabs, type InboundIssue } from './inboundFields';
import { ruleIssues } from './routingEditor';
import RemotePolicySettings, { policyIssues } from './RemotePolicySettings';
import { editorTitle } from './uiTerms';
import RemoteCoreSettings, { coreTabs, coreIssues } from './RemoteCoreSettings';
import RemoteNodeSettings, { nodeSettingsTabs } from './RemoteNodeSettings';
import ServerFields from './ServerFields';
import { settingsStructures, optionalSettingsIssues } from './settingsFields';
import { get } from './nativeProperties';
import type { ApiListener } from './apiPlumbing';
import { outputIssues, syncRoutingOutputs, type RoutingOutput } from './routingOutputs';

const sections: Record<string, string[]> = {
  ...nodeSettingsTabs,
  Config: coreTabs,
  RouterConfig: ['Rules', 'Outputs', 'Options'],
  BalancingRule: ['Group'],
};

export default function RemoteSettings({
  title,
  value,
  schema,
  destinations,
  userCount,
  onManageUsers,
  onSave,
  onClose,
  apiListeners,
  routingOutputs,
}: {
  title: string;
  value: unknown;
  schema: string;
  destinations: RouteDestination[];
  userCount?: number;
  onManageUsers?: () => void;
  apiListeners?: ApiListener[];
  routingOutputs?: RoutingOutput[];
  onSave: (value: unknown, listeners?: ApiListener[], outputs?: RoutingOutput[]) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const [draft, setDraft] = useState(value);
  const [outputs, setOutputs] = useState(
    () =>
      routingOutputs ??
      syncRoutingOutputs(jsonRecord(value) ? value : {}, []).filter((output) =>
        destinations.some((target) => target.tag === output.tag && target.group === output.group),
      ),
  );
  const [listenerDraft, setListenerDraft] = useState(apiListeners ?? []);
  const inbound = schema === 'InboundDetourConfig' && editableInbound(draft);
  const protocol = jsonRecord(draft) ? jsonText(get(draft, 'protocol') ?? '').toLowerCase() : '';
  const tabs =
    inbound && editableInbound(draft)
      ? inboundTabs(draft)
      : schema === 'OutboundDetourConfig' && ['block', 'blackhole', 'loopback'].includes(protocol)
        ? ['Server']
        : schema === 'OutboundDetourConfig' &&
            ['freedom', 'direct', 'dns', 'wireguard'].includes(protocol)
          ? ['Server', 'Advanced']
          : (sections[schema] ?? []);
  const [selectedTab, setTab] = useState(tabs[0] ?? '');
  const tab = tabs.includes(selectedTab) ? selectedTab : (tabs[0] ?? '');
  const [issues, setIssues] = useState<InboundIssue[]>([]);
  const editorTabs = useEditorTabs(
    tabs.map((name) => ({
      key: name,
      label: (
        <>
          {name}
          {issues.some((issue) => issue.tab === name) && (
            <span className="settings-error-count">
              {issues.filter((issue) => issue.tab === name).length}
            </span>
          )}
        </>
      ),
    })),
    tab,
    setTab,
  );
  const [json, setJson] = useState<string | null>(
    jsonRecord(value) || (schema === 'NameServerConfig' && typeof value === 'string')
      ? null
      : JSON.stringify(value, null, 2),
  );
  const [error, setError] = useState('');
  const [validated, setValidated] = useState(false);
  const [focusPath, setFocusPath] = useState('');
  const [selectedRule, setSelectedRule] = useState(0);
  const issuesFor = (next: unknown, listeners = listenerDraft) =>
    !jsonRecord(next)
      ? []
      : schema === 'InboundDetourConfig' && editableInbound(next)
        ? inboundIssues(next)
        : schema === 'RouterConfig'
          ? [
              ...ruleIssues(next, destinations),
              ...outputIssues(syncRoutingOutputs(next, outputs), destinations),
            ]
          : schema === 'BalancingRule'
            ? policyIssues(next, destinations)
            : schema === 'Config'
              ? [
                  ...coreIssues(next),
                  ...(jsonRecord(get(next, 'api'))
                    ? listeners.flatMap((listener) =>
                        inboundIssues(listener.value)
                          .filter((issue) => ['listen', 'port'].includes(issue.path.toLowerCase()))
                          .map((issue) => ({
                            ...issue,
                            path: `apiListeners.${listener.index}.${issue.path}`,
                            tab: 'Statistics & API',
                          })),
                      )
                    : []),
                ]
              : optionalSettingsIssues(schema, next);
  const updateDraft = (next: unknown) => {
    setDraft(next);
    if (schema === 'RouterConfig' && jsonRecord(next))
      setOutputs((outputs) => syncRoutingOutputs(next, outputs));
    if (validated) setIssues(issuesFor(next));
    setError('');
  };
  const navigateIssue = (issue: InboundIssue) => {
    setTab(issue.tab);
    setFocusPath(issue.path);
    const match = /^rules\.(\d+)\./.exec(issue.path);
    if (match) setSelectedRule(Number(match[1]));
  };
  const editingJson = json !== null;
  const close = () => {
    let dirty =
      !jsonEqual(draft, value) ||
      !jsonEqual(listenerDraft, apiListeners ?? []) ||
      (routingOutputs !== undefined && !jsonEqual(outputs, routingOutputs));
    if (json !== null) {
      try {
        dirty = dirty || !jsonEqual(parseXrayJson(json), value);
      } catch {
        dirty = true;
      }
    }
    if (!dirty || window.confirm('Discard unsaved settings?')) onClose();
  };
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  useEffect(() => {
    if (body.current) body.current.scrollTop = 0;
  }, [tab, editingJson]);
  useEffect(() => {
    if (!focusPath || editingJson) return;
    const frame = window.requestAnimationFrame(() => {
      const field = [
        ...(body.current?.querySelectorAll<HTMLElement>('[data-setting-path]') ?? []),
      ].find(
        (element) =>
          element.dataset.settingPath === focusPath ||
          (schema === 'Config' &&
            element.dataset.settingPath ===
              focusPath.replace(
                /^fakedns(?:\.(\d+))?/i,
                (_match, index) => `pools.${index ?? '0'}`,
              )),
      );
      for (let ancestor = field?.parentElement; ancestor; ancestor = ancestor.parentElement)
        if (ancestor instanceof HTMLDetailsElement) ancestor.open = true;
      (
        field?.querySelector<HTMLElement>('input, select, textarea') ??
        field?.querySelector<HTMLElement>('button')
      )?.focus();
      setFocusPath('');
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusPath, tab, editingJson, selectedRule, schema]);
  const apply = (operation: (value: unknown) => void) => {
    try {
      operation(json === null ? draft : parseXrayJson(json));
      setError('');
    } catch (reason) {
      setError(errorMessage(reason));
    }
  };
  const save = (operation: (value: unknown) => void) =>
    apply((next) => {
      const issues = issuesFor(next);
      setValidated(true);
      setIssues(issues);
      if (issues.length) {
        if (json === null) navigateIssue(issues[0]);
        setError('');
        return;
      }
      operation(next);
    });
  return (
    <dialog
      ref={dialog}
      className="rule-editor-window user-library-dialog remote-settings-dialog"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        close();
      }}
    >
      <form
        ref={form}
        onSubmit={(event) => {
          event.preventDefault();
          save((value) =>
            schema === 'Config' && apiListeners !== undefined
              ? onSave(value, listenerDraft)
              : schema === 'RouterConfig' && routingOutputs !== undefined && jsonRecord(value)
                ? onSave(value, undefined, syncRoutingOutputs(value, outputs))
                : onSave(value),
          );
        }}
      >
        <header className="dialog-header">
          <h2 id={titleId}>{editorTitle(schema, title)}</h2>
          <button
            className="secondary-button"
            type="button"
            onClick={() => {
              if (!form.current?.reportValidity()) return;
              if (json === null) setJson(JSON.stringify(draft, null, 2));
              else
                apply((next) => {
                  if (
                    !jsonRecord(next) &&
                    !(schema === 'NameServerConfig' && typeof next === 'string')
                  )
                    throw new Error('This value can be edited in JSON.');
                  updateDraft(next);
                  setJson(null);
                });
            }}
          >
            {json === null ? 'Edit JSON' : 'Show fields'}
          </button>
        </header>
        {json === null && tabs.length > 1 && (
          <EditorTabList
            tabs={editorTabs}
            panelId={`${editorTabs.id}-panel`}
            label="Settings sections"
            className="editor-tab-list inspector-tabs remote-settings-tabs"
          />
        )}
        <div
          ref={body}
          className="dialog-body remote-settings-body"
          id={`${editorTabs.id}-panel`}
          role={json === null && tabs.length > 1 ? 'tabpanel' : undefined}
          aria-labelledby={json === null && tabs.length > 1 ? editorTabs.tabId(tab) : undefined}
        >
          {json !== null ? (
            <textarea
              className="code-control text-control"
              aria-label="Node settings JSON"
              spellCheck={false}
              rows={20}
              value={json}
              onChange={(event) => setJson(event.target.value)}
            />
          ) : schema === 'NameServerConfig' && typeof draft === 'string' ? (
            <RemoteNodeSettings
              schema={schema}
              value={{ address: draft }}
              tab={tab}
              issues={issues}
              destinations={destinations.filter((item) => !item.hidden)}
              onChange={updateDraft}
            />
          ) : (
            jsonRecord(draft) &&
            (schema === 'Config' ? (
              <RemoteCoreSettings
                value={draft}
                tab={tab}
                issues={issues}
                focusPath={focusPath}
                destinations={destinations.filter((item) => !item.hidden)}
                onChange={updateDraft}
                apiListeners={listenerDraft}
                onApiListenersChange={(listeners) => {
                  setListenerDraft(listeners);
                  if (validated) setIssues(issuesFor(draft, listeners));
                }}
              />
            ) : inbound ? (
              <RemoteInboundSettings
                value={draft}
                tab={tab}
                issues={issues}
                userCount={userCount}
                onChange={updateDraft}
                onManageUsers={onManageUsers}
              />
            ) : schema === 'RouterConfig' && (tab === 'Rules' || tab === 'Outputs') ? (
              <RemoteRoutingSettings
                value={draft}
                destinations={destinations}
                onChange={updateDraft}
                selectedRule={selectedRule}
                focusPath={focusPath}
                onSelectRule={setSelectedRule}
                tab={tab}
                outputs={outputs}
                onOutputsChange={(next) => {
                  setOutputs(next);
                  if (validated && jsonRecord(draft))
                    setIssues([
                      ...ruleIssues(draft, destinations),
                      ...outputIssues(next, destinations),
                    ]);
                }}
              />
            ) : schema === 'BalancingRule' && tab === 'Group' ? (
              <RemotePolicySettings
                value={draft}
                destinations={destinations.filter((item) => !item.hidden)}
                onChange={updateDraft}
                tuning={(value, onChange) => (
                  <ServerFields
                    object={value}
                    root={value}
                    schema="strategyLeastLoadConfig"
                    path="strategy.settings."
                    fieldSets={settingsStructures}
                    issues={issues}
                    onChange={onChange}
                  />
                )}
              />
            ) : schema === 'RouterConfig' ? (
              <ServerFields
                object={draft}
                root={draft}
                schema="RoutingOptions"
                fieldSets={settingsStructures}
                onChange={updateDraft}
              />
            ) : nodeSettingsTabs[schema] ? (
              <RemoteNodeSettings
                schema={schema}
                value={draft}
                tab={tab}
                issues={issues}
                destinations={destinations.filter((item) => !item.hidden)}
                onChange={updateDraft}
              />
            ) : (
              <button
                className="secondary-button"
                type="button"
                onClick={() => setJson(JSON.stringify(draft, null, 2))}
              >
                Edit native options in JSON…
              </button>
            ))
          )}
          {issues.length > 0 && (
            <div className="settings-issues" role="alert">
              <strong>
                {issues.length} {issues.length === 1 ? 'field needs' : 'fields need'} attention
              </strong>
              {issues.map((issue) => (
                <button
                  className="secondary-button"
                  type="button"
                  key={issue.path + issue.message}
                  onClick={() => {
                    navigateIssue(issue);
                  }}
                >
                  {issue.message}
                </button>
              ))}
            </div>
          )}
          {error && (
            <p className="user-dialog-message user-error" role="alert">
              {error}
            </p>
          )}
        </div>
        <footer className="dialog-footer">
          <button className="secondary-button" type="button" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="primary-button">
            Apply changes
          </button>
        </footer>
      </form>
    </dialog>
  );
}
