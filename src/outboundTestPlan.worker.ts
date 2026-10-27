import { createTestPlan, type TestPlanInput } from './outboundTestPlan';
let current: ReturnType<typeof createTestPlan> | undefined;
self.onmessage = (event: MessageEvent<{ input?: TestPlanInput; ids?: string[] }>) => {
  try {
    if (event.data.input) {
      current = createTestPlan(event.data.input);
      self.postMessage({ plan: current.plan });
    } else {
      if (!current) throw new Error('Test plan is unavailable.');
      self.postMessage({ batch: current.batch(event.data.ids ?? []) });
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : 'Unable to prepare outbound tests.',
    });
  }
};
