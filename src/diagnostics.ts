import { invoke, isTauri } from '@tauri-apps/api/core';
import { maskLogDestination } from './routingLogPrivacy';
import { boundedText } from './text';
export type DiagnosticSource = {
  source: 'service' | 'sharing' | 'desktop';
  folder: string;
  text: string;
  error: string | null;
};
export function initializeDiagnostics() {
  if (!isTauri()) return;
  const record = (error: unknown) => {
    const message =
      error instanceof Error ? `${error.message}\n${error.stack ?? ''}` : String(error);
    void invoke('diagnostics_record', { message: boundedText(message, 4096) }).catch(() => {});
  };
  window.addEventListener('error', (event) => record(event.error ?? event.message));
  window.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) =>
    record(event.reason),
  );
}
export const diagnosticSourceNames = {
  service: 'Networking service',
  sharing: 'Internet sharing',
  desktop: 'Desktop app',
} as const;
export type DiagnosticEntry = {
  source: DiagnosticSource['source'];
  component: string | null;
  level: string;
  timeMs: number | null;
  pid: number | null;
  message: string;
  line: string;
};
export const diagnosticSourceId = (entry: Pick<DiagnosticEntry, 'source' | 'component'>) =>
  JSON.stringify([entry.source, entry.component]);

/** Keep malformed/truncated lines visible and export their original bytes as text. */
export function diagnosticEntries(sources: DiagnosticSource[]): DiagnosticEntry[] {
  return sources.flatMap((source) =>
    source.text
      .split('\n')
      .filter((line) => line.trim())
      .map((line): DiagnosticEntry => {
        try {
          const row: unknown = JSON.parse(line);
          if (
            !row ||
            typeof row !== 'object' ||
            !('timeMs' in row) ||
            typeof row.timeMs !== 'number' ||
            !Number.isFinite(row.timeMs) ||
            Math.abs(row.timeMs) > 8.64e15 ||
            !('pid' in row) ||
            typeof row.pid !== 'number' ||
            !Number.isInteger(row.pid) ||
            row.pid < 0 ||
            !('component' in row) ||
            typeof row.component !== 'string' ||
            !row.component.trim() ||
            !('level' in row) ||
            typeof row.level !== 'string' ||
            !row.level.trim() ||
            !('message' in row) ||
            typeof row.message !== 'string'
          )
            throw new Error('Invalid diagnostic entry');
          // Core files written before severity was propagated still contain the
          // authoritative Xray header. Never interpret brackets in a message body.
          const coreLevel =
            row.component === 'TUN' || row.component === 'Xray'
              ? /^[\d /:.]*\[(Debug|Info|Warning|Error)\]/.exec(row.message)?.[1]
              : undefined;
          const level = (coreLevel ?? row.level).trim().toLowerCase();
          return {
            source: source.source,
            component: row.component,
            level: level === 'warn' ? 'warning' : level,
            timeMs: row.timeMs,
            pid: row.pid,
            message: row.message,
            line,
          };
        } catch {
          return {
            source: source.source,
            component: null,
            level: 'unknown',
            timeMs: null,
            pid: null,
            message: line,
            line,
          };
        }
      }),
  );
}
export function diagnosticText(entries: DiagnosticEntry[]): string {
  return [...entries]
    .sort((a, b) => (a.timeMs ?? 0) - (b.timeMs ?? 0))
    .map((row) =>
      row.timeMs === null
        ? row.message
        : `${new Date(row.timeMs).toLocaleString()}  ${row.source}/${row.component}  ${row.level}  [${row.pid}]\n${row.message}`,
    )
    .join('\n\n');
}

/** Deliberate exports use the same privacy preference as traffic-log exports. */
export function maskDiagnosticText(text: string, mask: string): string {
  if (!mask) return text;
  return text
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, (value) => maskLogDestination(value, mask))
    .replace(/\[[0-9a-fA-F:]+(?:%[\w.-]+)?\](?::\d+)?/g, (value) => maskLogDestination(value, mask))
    .replace(/(?<![\w:])[0-9a-fA-F]{0,4}::[0-9a-fA-F:]+(?:%[\w.-]+)?/g, (value) =>
      maskLogDestination(`[${value}]`, mask),
    )
    .replace(/\b(?:[a-zA-Z0-9_-]+\.)+[a-zA-Z]{2,63}(?::\d+)?\b/g, (value) =>
      /\.(?:exe|dll|sys|json|jsonl|ps1|toml|dat|rs|ts|tsx|js|md)(?::\d+)?$/i.test(value)
        ? value
        : maskLogDestination(value, mask),
    );
}
