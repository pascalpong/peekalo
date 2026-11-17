// A test-input exception, never a capture or privacy claim. Keep this predicate
// independent of native modules so every denied build/device case is testable.
export function allowSimulatorFixtures(dev: boolean, platform: string, physical: boolean, local: string | undefined, fixtures: string | undefined) {
  return dev && platform === 'ios' && !physical && local === 'true' && fixtures === 'true';
}
