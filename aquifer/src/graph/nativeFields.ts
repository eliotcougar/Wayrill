import { createNativeFieldEditor } from '@wayrill/core/nativeFields';
import { parseXrayJson } from './xrayJson';

export * from '@wayrill/core/nativeFields';
export const { nativeFieldValue, editNativeField } = createNativeFieldEditor(parseXrayJson);
