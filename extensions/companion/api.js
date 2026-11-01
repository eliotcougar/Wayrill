// Firefox's browser namespace and Chromium's MV3 APIs both return promises.
export function extensionApi() {
  return /** @type {typeof chrome} */ (Reflect.get(globalThis, 'browser') ?? chrome);
}
