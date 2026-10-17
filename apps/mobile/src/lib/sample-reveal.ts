import { REVEAL_BUDGET_MS } from '@peekalo/contracts';
import { createLocalRevealSession } from '@peekalo/reveal';

// One non-sensitive sample, one allowance for this JS runtime. Closing/reopening
// its screen does not reset time. Reloading/restarting does; this is only a demo.
export const sampleReveal = createLocalRevealSession({
  budgetMs: REVEAL_BUDGET_MS,
  now: () => performance.now(),
  schedule: (callback, delay) => {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
});
