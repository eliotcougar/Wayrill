import { createContext, useContext, useEffect, useState, type RefObject } from 'react';
import { AlertCircle, ArrowRight } from 'lucide-react';
import type { Diagnostic, SettingDefinition } from '../graph/types';

export interface DiagnosticFocusRequest {
  issue: Diagnostic;
  surface: 'editor' | 'inspector' | 'defaults';
  returnFocus?: HTMLElement | null;
}
export const DiagnosticFocusContext = createContext<DiagnosticFocusRequest | null>(null);

export function useRequestedDiagnostic() {
  return useContext(DiagnosticFocusContext)?.issue;
}

/** Locate controls by stable metadata, never by parsing translated diagnostic messages. */
export function focusDiagnostic(root: HTMLElement, issue: Diagnostic) {
  const elements = [...root.querySelectorAll<HTMLElement>('*')];
  let scope = root;
  let scopes = [root];
  if (issue.portId) {
    const port = elements.find(
      (el) =>
        el.dataset.diagnosticPort === issue.portId &&
        el.closest('.react-flow__node[data-id]')?.getAttribute('data-id') === issue.nodeId,
    );
    if (port) {
      port.focus({ preventScroll: true });
      return true;
    }
    return false;
  }
  if (issue.rowId || issue.outputId) {
    scopes = elements.filter((el) =>
      issue.outputId
        ? el.dataset.diagnosticOutput === issue.outputId
        : el.dataset.diagnosticRow === issue.rowId,
    );
    if (!scopes.length) scopes = [root];
    scope = scopes[0];
  }
  // A row can have both a list summary and an editing pane. Resolve the field in either.
  const controls = scopes.flatMap((element) => [
    ...element.querySelectorAll<HTMLElement>(
      '[data-setting-key], [data-diagnostic-field], input, select, textarea',
    ),
  ]);
  const field = issue.controlId
    ? controls.find((el) => el.id === issue.controlId)
    : issue.fieldKey
      ? controls.find(
          (el) =>
            el.dataset.settingKey === issue.fieldKey ||
            el.dataset.diagnosticField === issue.fieldKey ||
            el.id.endsWith(`-${issue.fieldKey}`),
        )
      : undefined;
  const target = field?.matches('input,select,textarea,button')
    ? field
    : (field?.querySelector<HTMLElement>('input,select,textarea') ??
      field?.querySelector<HTMLElement>('button'));
  const destination =
    target ??
    (scope !== root ? scope.querySelector<HTMLElement>('input,select,textarea,button') : null) ??
    root.querySelector<HTMLElement>('h2,h3');
  if (!destination) return false;
  // Reveal native disclosures without changing any configuration fields.
  for (
    let parent = destination.parentElement;
    parent && parent !== root;
    parent = parent.parentElement
  )
    if (parent instanceof HTMLDetailsElement) parent.open = true;
  if (destination.closest('[hidden],[inert]')) return false;
  if (!destination.matches('input,select,textarea,button')) destination.tabIndex = -1;
  destination.focus({ preventScroll: true });
  destination.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  return true;
}

/** Numeric drafts stay local to the control; describe them without publishing invalid settings. */
export function draftNumberIssues(
  invalid: Record<string, boolean>,
  fields: readonly SettingDefinition[],
): Diagnostic[] {
  const keys = [...fields].sort((a, b) => b.key.length - a.key.length);
  return Object.entries(invalid)
    .filter(([, bad]) => bad)
    .map(([controlId]) => {
      const field = keys.find((candidate) => controlId.endsWith(`-${candidate.key}`));
      return {
        severity: 'error',
        controlId,
        fieldKey: field?.key,
        message: `${field?.label ?? 'Number'}: enter a whole number${field?.min !== undefined ? ` from ${field.min}` : ''}${field?.max !== undefined ? ` to ${field.max}` : ''}. This unfinished value has not been applied.`,
      };
    });
}

export function useLocalDiagnosticFocus(ref: RefObject<HTMLElement | null>) {
  const [issue, setIssue] = useState<Diagnostic | null>(null);
  useEffect(() => {
    if (issue && ref.current) focusDiagnostic(ref.current, issue);
  }, [ref, issue]);
  return (next: Diagnostic) => setIssue({ ...next });
}

export default function DiagnosticList({
  issues,
  onIssue,
  local = false,
}: {
  issues: Diagnostic[];
  onIssue: (issue: Diagnostic) => void;
  local?: boolean;
}) {
  const ordered = [...issues].sort(
    (a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'),
  );
  return ordered.map((issue, index) => {
    const content = (
      <>
        <AlertCircle size={15} aria-hidden="true" />
        <span>
          <strong className="diagnostic-severity">
            {issue.severity === 'error' ? 'Error' : 'Warning'}
          </strong>
          {issue.message}
        </span>
      </>
    );
    return local || issue.nodeId || issue.scope === 'defaults' ? (
      <button
        type="button"
        className={`notice notice--${issue.severity} notice--compact diagnostic`}
        key={index}
        onClick={() => onIssue(issue)}
      >
        {content}
        <span className="diagnostic-action">
          Review <ArrowRight size={13} aria-hidden="true" />
        </span>
      </button>
    ) : (
      <p className={`notice notice--${issue.severity} notice--compact diagnostic`} key={index}>
        {content}
      </p>
    );
  });
}
