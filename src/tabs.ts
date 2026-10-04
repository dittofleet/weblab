// Kept apart from browser.ts, which loads Playwright: the steps only need this.
import type { Page } from "playwright-core";

/** Tabs weblab opened itself (the `tab` step's `open`), each with the tab the step was on, so only the session that opened one closes it. */
export const openedByWeblab = new WeakMap<Page, Page>();
