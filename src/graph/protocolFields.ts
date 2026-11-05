import { createProtocolFields } from '@wayrill/core/protocolFields';
import { protocolSource } from './protocolSource';

export type ProtocolField = import('@wayrill/core/protocolFields').ProtocolField<
  keyof typeof protocolSource
>;
export const { fieldsForStructure, settingsFields, structureProblems } =
  createProtocolFields(protocolSource);
