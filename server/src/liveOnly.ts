/**
 * `--live-only` gate for every top-level adoption path except the registry tick.
 *
 * Scanners, hook adoption, and restore all call this. The registry tick does not:
 * under the flag it is the only way a top-level agent is created.
 */
export function mayCreateDiscoveredTopLevel(liveOnly: boolean): boolean {
  return !liveOnly;
}
