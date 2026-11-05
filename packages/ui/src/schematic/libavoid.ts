import { AvoidLib } from 'libavoid-js';

// The published 0.4.5 typings describe a later binding. Keep this small boundary
// aligned with the pinned WebIDL API (flat numeric enums and borrowed polygons).
type NativeObject = object;
interface NativePoint extends NativeObject {
  x: number;
  y: number;
}
interface NativePolygon extends NativeObject {
  size(): number;
  get_ps(index: number): NativePoint;
}
interface NativeRouter extends NativeObject {
  setRoutingParameter(parameter: number, value: number): void;
  setRoutingOption(option: number, value: boolean): void;
  processTransaction(): boolean;
}
interface NativePin extends NativeObject {
  setExclusive(value: boolean): void;
}
interface NativeConnector extends NativeObject {
  displayRoute(): NativePolygon;
}
export interface AvoidBindings {
  Point: new (x: number, y: number) => NativePoint;
  Rectangle: new (a: NativePoint, b: NativePoint) => NativeObject;
  Router: new (flags: number) => NativeRouter;
  ShapeRef: new (router: NativeRouter, polygon: NativeObject) => NativeObject;
  ShapeConnectionPin: new (
    shape: NativeObject,
    id: number,
    x: number,
    y: number,
    proportional: boolean,
    insideOffset: number,
    directions: number,
  ) => NativePin;
  ConnEnd: new (shape: NativeObject, pin: number) => NativeObject;
  ConnRef: new (router: NativeRouter, from: NativeObject, to: NativeObject) => NativeConnector;
  destroy(object: NativeObject): void;
  getPointer(object: NativeObject): number;
  getClass(object: NativeObject): unknown;
  getCache(type: unknown): Record<number, unknown>;
  OrthogonalRouting: number;
  segmentPenalty: number;
  shapeBufferDistance: number;
  idealNudgingDistance: number;
  nudgeSharedPathsWithCommonEndPoint: number;
  nudgeOrthogonalTouchingColinearSegments: number;
}

let loading: Promise<void> | undefined;
export function initializeEdgeRouter(wasmUrl?: string): Promise<void> {
  return (loading ??= AvoidLib.load(wasmUrl).catch((error: unknown) => {
    loading = undefined;
    throw error;
  }));
}

export function edgeRouterBindings(): AvoidBindings {
  return AvoidLib.getInstance() as AvoidBindings;
}
