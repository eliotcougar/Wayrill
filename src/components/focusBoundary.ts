/** Null or ancestor focus can precede native label/control activation.
 * Pointer dismissal and explicit keyboard exit handle actual departures.
 */
export function focusMovedOutside(region: Node, next: EventTarget | null): boolean {
  return next instanceof Node && !region.contains(next) && !next.contains(region);
}
