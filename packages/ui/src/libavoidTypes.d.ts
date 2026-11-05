declare module 'libavoid-js' {
  export const AvoidLib: {
    load(wasmUrl?: string): Promise<void>;
    getInstance(): unknown;
  };
}
declare module 'libavoid-wasm?url' {
  const url: string;
  export default url;
}
