import { useState } from 'react';
import { AlertCircle, CheckCheck, ShieldCheck } from 'lucide-react';
import type { GraphRuntimeActions } from '../createGraphRuntimeActions';
import { errorText, type ResourceWarningReport } from '../serviceClient';
import ResourceWarnings from './ResourceWarnings';
import type { Diagnostic } from '../graph/types';
import Dialog from './Dialog';
import DiagnosticList from './DiagnosticNavigation';

export default function GraphCheckDialog({
  actions,
  onClose,
  onIssue,
}: {
  actions: GraphRuntimeActions;
  onClose: () => void;
  onIssue: (issue: Diagnostic) => void;
}) {
  const { checks, compiled, errors } = actions;
  const [validation, setValidation] = useState<{
    draft: typeof compiled;
    status: 'validating' | 'passed' | 'failed';
    message?: string;
    resourceWarnings?: ResourceWarningReport;
  }>();
  const result = !checks.pending && validation?.draft === compiled ? validation : undefined;
  const warnings = checks.issues.filter((issue) => issue.severity === 'warning').length;
  async function validate() {
    if (!actions.canValidate || result?.status === 'validating') return;
    setValidation({ draft: compiled, status: 'validating' });
    try {
      const completed = await actions.validate();
      setValidation(
        completed
          ? { draft: compiled, status: 'passed', resourceWarnings: completed.resourceWarnings }
          : undefined,
      );
    } catch (error) {
      setValidation({ draft: compiled, status: 'failed', message: errorText(error) });
    }
  }
  return (
    <Dialog
      title="Graph check"
      onClose={onClose}
      footer={
        <>
          {result?.status === 'passed' && (
            <span className="graph-check-status" role="status">
              Xray validation passed.
            </span>
          )}
          {result?.status === 'failed' && (
            <span className="graph-check-status" role="alert">
              Validation failed.
            </span>
          )}
          <button
            className="primary-button graph-check-validation"
            disabled={!actions.canValidate || result?.status === 'validating'}
            title={actions.validateReason || 'Validate the draft with Xray'}
            onClick={() => void validate()}
          >
            <ShieldCheck size={16} />
            {result?.status === 'validating' ? 'Validating…' : 'Validate'}
          </button>
          <button className="secondary-button" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      <div
        className={`validation-summary${errors.length ? ' has-errors' : warnings ? ' has-warnings' : ''}`}
        aria-busy={checks.pending}
      >
        {errors.length ? <AlertCircle size={26} /> : <CheckCheck size={26} />}
        <h3>
          {checks.pending
            ? 'Checking graph…'
            : errors.length
              ? `${errors.length} ${errors.length === 1 ? 'error' : 'errors'}`
              : warnings
                ? `Checks passed · ${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`
                : 'Graph checks passed'}
        </h3>
      </div>
      {!checks.pending && <DiagnosticList issues={checks.issues} onIssue={onIssue} />}
      {result?.status === 'passed' && <ResourceWarnings report={result.resourceWarnings} />}
      {result?.status === 'failed' && (
        <p className="notice notice--error" role="alert">
          {result.message}
        </p>
      )}
      {!actions.canValidate && !checks.pending && !errors.length && (
        <p className="dialog-note">{actions.validateReason}</p>
      )}
    </Dialog>
  );
}
