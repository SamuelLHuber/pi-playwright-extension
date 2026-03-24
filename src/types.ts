export type BrowserEngine = "chromium" | "firefox" | "webkit";

export interface ViewportSize {
  width: number;
  height: number;
}

export interface BrowserRetentionConfig {
  maxArtifacts: number;
  maxBytes: number;
  maxAgeDays: number;
}

export interface BrowserLaunchConfig {
  cwd: string;
  browserName: BrowserEngine;
  headless: boolean;
  isolated: boolean;
  outputDir: string;
  storageStatePath?: string;
  viewport: ViewportSize;
  videoSize: ViewportSize;
  recordVideo: boolean;
  retention: BrowserRetentionConfig;
  actionTimeoutMs: number;
  navigationTimeoutMs: number;
}

export interface BrowserStatus {
  started: boolean;
  browserName: BrowserEngine;
  headless: boolean;
  recordingVideo: boolean;
  tabCount: number;
  currentTabIndex: number;
  currentUrl?: string;
  currentTitle?: string;
  outputDir: string;
  lastVideoPath?: string;
}

export interface InteractiveElementRef {
  ref: string;
  role: string;
  name: string;
  tagName: string;
  selector: string;
  description: string;
  disabled: boolean;
  pageIndex: number;
}

export interface SnapshotResult {
  text: string;
  refs: InteractiveElementRef[];
  aria: string;
  fullPath?: string;
}

export interface ConsoleEntry {
  pageId: string;
  pageIndex: number;
  level: "debug" | "info" | "warning" | "error";
  text: string;
  location?: string;
  timestamp: number;
  navigationId: number;
}

export interface NetworkEntry {
  pageId: string;
  pageIndex: number;
  url: string;
  method: string;
  resourceType: string;
  status?: number;
  ok: boolean;
  failureText?: string;
  timestamp: number;
  navigationId: number;
}

export interface BrowserArtifactInfo {
  path: string;
  size: number;
  modifiedMs: number;
}

export interface TextResult {
  text: string;
  fullPath?: string;
  details?: Record<string, unknown>;
}
