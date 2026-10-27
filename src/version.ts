import { embeddedCoreDefaults } from './graph/coreDefaults';

declare const __APP_VERSION__: string;

export const appVersion = __APP_VERSION__;

export const appWindowTitle = `Wayrill ${appVersion} · Xray ${embeddedCoreDefaults.version}`;
