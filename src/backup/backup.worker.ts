import { backupIsEncrypted, decodeBackup, encodeBackup } from './codec';
import { createContent, prepareRestore, validateContent } from './model';
import type { BackupRequest } from './client';
import { portableBackup } from '../portableJson';

self.onmessage = async (event: MessageEvent<BackupRequest>) => {
  try {
    const request = event.data;
    let result: unknown;
    if (request.operation === 'create')
      result = await encodeBackup(
        portableBackup(
          createContent(
            request.scope,
            request.graph,
            request.stash,
            request.preferences,
            request.filterIds,
          ),
          'write',
        ),
        request.password,
      );
    else if (request.operation === 'open') {
      const encrypted = backupIsEncrypted(request.text);
      result =
        encrypted && request.password === undefined
          ? { encrypted }
          : {
              encrypted,
              content: validateContent(
                portableBackup(await decodeBackup(request.text, request.password), 'read'),
              ),
            };
    } else
      result = prepareRestore(request.content, request.selection, request.graph, request.stash);
    self.postMessage({ result });
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Backup processing failed.',
    });
  }
};
