import type { BrowserName } from "./spec.js"

/** What a check needs from a page. Anything that drives a real browser implements this and nothing else leaks in. */
export interface PageHandle {
  goto(url: string): Promise<void>
  click(selector: string): Promise<void>
  fill(selector: string, value: string): Promise<void>
  press(key: string): Promise<void>
  waitFor(selector: string): Promise<void>
  isVisible(selector: string): Promise<boolean>
  count(selector: string): Promise<number>
  text(selector: string): Promise<string | null>
  /** Whether the active element is the first element matching the selector. */
  isFocused(selector: string): Promise<boolean>
  /** A short description of the active element, for failure messages. */
  activeElement(): Promise<string>
  contains(outer: string, inner: string): Promise<boolean>
  close(): Promise<void>
}

export interface OpenOptions {
  viewport: { width: number; height: number }
  /** Requests to any other origin are blocked. */
  allowedOrigins: readonly string[]
  timeoutMs: number
}

export interface BrowserDriver {
  readonly browser: BrowserName
  /** The browser's own version string, for the record. */
  version(): string
  /** A fresh page in a fresh context: no cookies, storage or cache from any earlier scenario. */
  open(options: OpenOptions): Promise<PageHandle>
  close(): Promise<void>
}
