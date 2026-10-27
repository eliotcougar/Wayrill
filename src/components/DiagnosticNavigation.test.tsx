// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import DiagnosticList, { draftNumberIssues, focusDiagnostic } from './DiagnosticNavigation';

it('finds an editable field when a rule also has a summary row with the same identity', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<div data-diagnostic-row="r"><button>Summary</button></div><section data-diagnostic-row="r"><input data-diagnostic-field="name"><div data-diagnostic-field="domain"><button>Expand</button><textarea></textarea></div></section>';
  document.body.append(host);
  expect(
    focusDiagnostic(host, {
      severity: 'error',
      message: 'Add a condition',
      rowId: 'r',
      fieldKey: 'domain',
    }),
  ).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('textarea'));
  host.remove();
});

it('puts blocking errors before warnings without changing order within each severity', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'),
    root = createRoot(host);
  const issues = [
    { severity: 'warning' as const, message: 'Warning one' },
    { severity: 'error' as const, message: 'Error one' },
    { severity: 'warning' as const, message: 'Warning two' },
    { severity: 'error' as const, message: 'Error two' },
  ];
  await act(() => root.render(<DiagnosticList issues={issues} onIssue={() => {}} />));
  expect([...host.querySelectorAll('.diagnostic')].map((element) => element.textContent)).toEqual([
    'ErrorError one',
    'ErrorError two',
    'WarningWarning one',
    'WarningWarning two',
  ]);
  expect(issues[0].message).toBe('Warning one');
  await act(() => root.unmount());
});

it('focuses the requested row and opens advanced fields without modifying their values', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<h2>Editor</h2><label data-diagnostic-row="a" data-diagnostic-field="sourcePort"><input value="123"></label><div data-diagnostic-row="b"><details><summary>Advanced</summary><label data-diagnostic-field="sourcePort"><input value="broken"></label></details></div>';
  document.body.append(host);
  expect(
    focusDiagnostic(host, {
      severity: 'error',
      message: 'Localized text',
      rowId: 'b',
      fieldKey: 'sourcePort',
    }),
  ).toBe(true);
  expect(document.activeElement).toBe(host.querySelector('[value="broken"]'));
  expect(host.querySelector('details')!.open).toBe(true);
  expect(host.querySelector('input')!.value).toBe('123');
  host.remove();
});

it('does not focus unrelated or hidden controls when a field cannot be located', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<h2>Editor</h2><input id="unrelated"><div hidden><input id="setting-hidden"></div>';
  document.body.append(host);
  focusDiagnostic(host, { severity: 'error', message: 'No location' });
  expect(document.activeElement).toBe(host.querySelector('h2'));
  expect(focusDiagnostic(host, { severity: 'error', message: 'Hidden', fieldKey: 'hidden' })).toBe(
    false,
  );
  host.remove();
});

it('distinguishes identical port and numeric field keys by node and control identity', () => {
  const host = document.createElement('div');
  host.innerHTML =
    '<div class="react-flow__node" data-id="a"><button data-id="1-a-data-source" data-diagnostic-port="data">A</button></div><div class="react-flow__node" data-id="b"><button data-id="1-b-data-source" data-diagnostic-port="data">B</button></div><input id="first-port"><input id="second-port">';
  document.body.append(host);
  focusDiagnostic(host, {
    severity: 'error',
    message: 'Missing path',
    nodeId: 'b',
    portId: 'data',
  });
  expect(document.activeElement!.textContent).toBe('B');
  focusDiagnostic(host, {
    severity: 'error',
    message: 'Invalid draft',
    fieldKey: 'port',
    controlId: 'second-port',
  });
  expect(document.activeElement!.id).toBe('second-port');
  host.remove();
});

it('describes local invalid numbers without including the typed value or creating dead review buttons', async () => {
  (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const issues = draftNumberIssues({ 'policy-observer-sampling': true, 'setting-port': false }, [
    { key: 'sampling', label: 'Samples', type: 'number', min: 1, max: 10 },
  ]);
  expect(issues).toEqual([
    {
      severity: 'error',
      fieldKey: 'sampling',
      controlId: 'policy-observer-sampling',
      message:
        'Samples: enter a whole number from 1 to 10. This unfinished value has not been applied.',
    },
  ]);
  const host = document.createElement('div'),
    root = createRoot(host),
    review = vi.fn();
  await act(() =>
    root.render(
      <DiagnosticList
        issues={[
          { severity: 'error', message: 'Whole graph problem' },
          { severity: 'warning', message: 'Check field', nodeId: 'b', fieldKey: 'tag' },
        ]}
        onIssue={review}
      />,
    ),
  );
  expect(host.querySelectorAll('button')).toHaveLength(1);
  expect(host.querySelector('p')!.textContent).toContain('Error');
  await act(() => host.querySelector('button')!.click());
  expect(review).toHaveBeenCalledWith({
    severity: 'warning',
    message: 'Check field',
    nodeId: 'b',
    fieldKey: 'tag',
  });
  await act(() => root.unmount());
});
