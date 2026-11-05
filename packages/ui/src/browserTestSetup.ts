import { beforeEach, vi } from 'vitest';

// jsdom has no layout. Scrolling geometry is verified in the rendered browser.
beforeEach(() => {
  if (typeof HTMLElement !== 'undefined') HTMLElement.prototype.scrollIntoView = vi.fn();
});
