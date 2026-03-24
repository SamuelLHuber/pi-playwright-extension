import { basename, extname, resolve } from "node:path";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type ConsoleMessage,
  type Page,
  type Response,
} from "playwright";
import type {
  BrowserArtifactInfo,
  BrowserLaunchConfig,
  BrowserStatus,
  ConsoleEntry,
  InteractiveElementRef,
  NetworkEntry,
  SnapshotResult,
  TextResult,
} from "./types.js";
import { ensureDir, formatBytes, listArtifacts, pruneArtifacts, truncateText, writeOutputFile } from "./utils.js";

interface CollectRefsResult {
  refs: InteractiveElementRef[];
  pageText: string[];
}

function getBrowserType(name: BrowserLaunchConfig["browserName"]): BrowserType {
  if (name === "firefox") return firefox;
  if (name === "webkit") return webkit;
  return chromium;
}

function slugFromUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split("/").filter(Boolean).at(-1);
    return (last || parsed.hostname || "page").replace(/[^a-z0-9_-]+/gi, "-");
  } catch {
    return "page";
  }
}

function consoleLevel(type: string): ConsoleEntry["level"] {
  if (type === "error" || type === "warning") return type;
  if (type === "debug") return "debug";
  return "info";
}

function buildInteractiveSummary(refs: InteractiveElementRef[]): string[] {
  if (refs.length === 0) return ["Interactive elements:", "(none visible)"];
  return [
    "Interactive elements:",
    ...refs.map((ref) => `- [ref=${ref.ref}] ${ref.description}${ref.disabled ? " (disabled)" : ""}`),
  ];
}

function basenameOrPath(path: string): string {
  return basename(path) || path;
}

export class BrowserSession {
  private readonly config: BrowserLaunchConfig;
  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private currentPageId: string | undefined;
  private pageIds = new WeakMap<Page, string>();
  private attachedPages = new WeakSet<Page>();
  private pageIdCounter = 0;
  private navigationIds = new Map<string, number>();
  private consoleEntries: ConsoleEntry[] = [];
  private networkEntries: NetworkEntry[] = [];
  private currentRefs = new Map<string, { pageId: string; selector: string; description: string }>();
  private recordingVideo: boolean;
  private videoArtifacts: string[] = [];

  constructor(config: BrowserLaunchConfig) {
    this.config = config;
    this.recordingVideo = config.recordVideo;
  }

  getStatus(): BrowserStatus {
    const pages = this.context?.pages() ?? [];
    const currentPage = this.getCurrentPageOrUndefined();
    const status: BrowserStatus = {
      started: this.context !== undefined,
      browserName: this.config.browserName,
      headless: this.config.headless,
      recordingVideo: this.recordingVideo,
      tabCount: pages.length,
      currentTabIndex: currentPage ? pages.indexOf(currentPage) : -1,
      outputDir: this.config.outputDir,
    };
    const currentUrl = currentPage?.url();
    if (currentUrl) {
      status.currentUrl = currentUrl;
    }
    const lastVideoPath = this.videoArtifacts.at(-1);
    if (lastVideoPath) {
      status.lastVideoPath = lastVideoPath;
    }
    return status;
  }

  async start(): Promise<void> {
    if (this.context) return;
    await ensureDir(this.config.outputDir);
    const browserType = getBrowserType(this.config.browserName);
    this.browser = await browserType.launch({ headless: this.config.headless });
    this.context = await this.browser.newContext(this.createContextOptions());
    this.context.setDefaultTimeout(this.config.actionTimeoutMs);
    this.context.setDefaultNavigationTimeout(this.config.navigationTimeoutMs);
    this.context.on("page", (page) => {
      this.attachPage(page);
    });
    const page = await this.context.newPage();
    this.attachPage(page);
    this.currentPageId = this.getPageId(page);
  }

  async stop(): Promise<void> {
    await this.closeRuntime({ finalizeVideos: true });
  }

  async reset(): Promise<void> {
    await this.closeRuntime({ finalizeVideos: true });
    await this.start();
  }

  async startVideoRecording(): Promise<TextResult> {
    if (this.recordingVideo && this.context) {
      return { text: "Video recording is already active.", details: { recordingVideo: true } };
    }
    this.recordingVideo = true;
    await this.closeRuntime({ finalizeVideos: false });
    await this.start();
    return {
      text: `Video recording enabled. New recordings will be written to ${this.config.outputDir}`,
      details: { recordingVideo: true, outputDir: this.config.outputDir },
    };
  }

  async stopVideoRecording(): Promise<TextResult> {
    if (!this.recordingVideo) {
      const lastVideoPath = this.videoArtifacts.at(-1);
      return {
        text: lastVideoPath ? `Video recording is not active. Last video: ${lastVideoPath}` : "Video recording is not active.",
        details: { recordingVideo: false, videos: [...this.videoArtifacts] },
      };
    }
    const videos = await this.closeRuntime({ finalizeVideos: true });
    this.recordingVideo = false;
    await this.start();
    const latestVideos = videos.length > 0 ? videos : this.videoArtifacts;
    const text = latestVideos.length > 0
      ? `Stopped video recording. Saved videos:\n${latestVideos.map((videoPath) => `- ${videoPath}`).join("\n")}`
      : "Stopped video recording, but no video frames were produced.";
    return {
      text,
      details: { recordingVideo: false, videos: latestVideos },
    };
  }

  getVideoStatus(): TextResult {
    const lastVideoPath = this.videoArtifacts.at(-1);
    const lines = [
      `Recording video: ${this.recordingVideo ? "yes" : "no"}`,
      `Output directory: ${this.config.outputDir}`,
      `Saved videos: ${this.videoArtifacts.length}`,
    ];
    if (lastVideoPath) {
      lines.push(`Last video: ${lastVideoPath}`);
    }
    return {
      text: lines.join("\n"),
      details: {
        recordingVideo: this.recordingVideo,
        outputDir: this.config.outputDir,
        videos: [...this.videoArtifacts],
      },
    };
  }

  async navigate(url: string): Promise<TextResult> {
    const page = await this.getCurrentPage();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: this.config.navigationTimeoutMs }).catch(() => undefined);
    await this.saveVideoFrameHint();
    return {
      text: `Navigated to ${page.url()}`,
      details: { url: page.url() },
    };
  }

  async snapshot(selector?: string): Promise<SnapshotResult> {
    const page = await this.getCurrentPage();
    const rootLocator = page.locator(selector ?? "body");
    await rootLocator.waitFor({ state: "attached" });
    const aria = await rootLocator.ariaSnapshot();
    const collected = await this.collectRefs(page, selector);
    this.currentRefs.clear();
    for (const ref of collected.refs) {
      this.currentRefs.set(ref.ref, { pageId: this.getPageId(page), selector: ref.selector, description: ref.description });
    }
    const title = await page.title();
    const lines = [
      `URL: ${page.url()}`,
      `Title: ${title || "(untitled)"}`,
      "",
      "ARIA snapshot:",
      aria || "(empty)",
      "",
      ...buildInteractiveSummary(collected.refs),
    ];
    if (collected.pageText.length > 0) {
      lines.push("", "Visible text:", ...collected.pageText);
    }
    const fullText = lines.join("\n");
    const truncated = truncateText(fullText);
    let fullPath: string | undefined;
    if (truncated.truncated) {
      fullPath = await writeOutputFile(this.config.outputDir, `snapshot-${slugFromUrl(page.url())}`, "md", fullText);
    }
    const result: SnapshotResult = {
      text: fullPath ? `${truncated.text}\n\nFull snapshot saved to: ${fullPath}` : truncated.text,
      refs: collected.refs,
      aria,
    };
    if (fullPath) {
      result.fullPath = fullPath;
    }
    return result;
  }

  async click(params: { ref?: string; selector?: string; doubleClick?: boolean; button?: "left" | "right" | "middle" }): Promise<TextResult> {
    const locator = await this.resolveLocator(params.ref, params.selector);
    await locator.scrollIntoViewIfNeeded();
    if (params.doubleClick) {
      await locator.dblclick({ button: params.button ?? "left" });
    } else {
      await locator.click({ button: params.button ?? "left" });
    }
    await this.saveVideoFrameHint();
    return { text: `Clicked ${params.ref ?? params.selector ?? "element"}` };
  }

  async type(params: { ref?: string; selector?: string; text: string; submit?: boolean; slowly?: boolean }): Promise<TextResult> {
    const page = await this.getCurrentPage();
    const locator = await this.resolveLocator(params.ref, params.selector);
    await locator.scrollIntoViewIfNeeded();
    await locator.click();
    const tagName = await locator.evaluate((element) => element.tagName.toLowerCase());
    const isFillable = tagName === "input" || tagName === "textarea";
    if (isFillable && !params.slowly) {
      await locator.fill(params.text);
    } else {
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
      await page.keyboard.type(params.text, { delay: params.slowly ? 40 : 0 });
    }
    if (params.submit) {
      await page.keyboard.press("Enter");
    }
    await this.saveVideoFrameHint();
    return { text: `Typed into ${params.ref ?? params.selector ?? "element"}` };
  }

  async pressKey(key: string): Promise<TextResult> {
    const page = await this.getCurrentPage();
    await page.keyboard.press(key);
    await this.saveVideoFrameHint();
    return { text: `Pressed key ${key}` };
  }

  async waitFor(params: { time?: number; text?: string; textGone?: string; selector?: string }): Promise<TextResult> {
    const page = await this.getCurrentPage();
    if (params.time !== undefined) {
      await page.waitForTimeout(params.time * 1000);
      await this.saveVideoFrameHint();
      return { text: `Waited ${params.time}s` };
    }
    if (params.selector) {
      await page.locator(params.selector).waitFor({ state: "visible" });
      await this.saveVideoFrameHint();
      return { text: `Selector became visible: ${params.selector}` };
    }
    if (params.text) {
      await page.getByText(params.text, { exact: false }).waitFor({ state: "visible" });
      await this.saveVideoFrameHint();
      return { text: `Text became visible: ${params.text}` };
    }
    if (params.textGone) {
      await page.getByText(params.textGone, { exact: false }).waitFor({ state: "hidden" });
      await this.saveVideoFrameHint();
      return { text: `Text disappeared: ${params.textGone}` };
    }
    throw new Error("wait_for requires one of: time, selector, text, textGone");
  }

  async evaluate(params: { function: string; ref?: string; selector?: string }): Promise<TextResult> {
    const page = await this.getCurrentPage();
    const fn = this.parseFunction(params.function);
    const result = params.ref || params.selector
      ? await (await this.resolveLocator(params.ref, params.selector)).evaluate(fn)
      : await page.evaluate(fn);
    const serialized = typeof result === "string" ? result : JSON.stringify(result, null, 2);
    await this.saveVideoFrameHint();
    return { text: `Evaluation result:\n${serialized}` };
  }

  async consoleMessages(level: ConsoleEntry["level"] = "info", all = false): Promise<TextResult> {
    const page = await this.getCurrentPage();
    const pageId = this.getPageId(page);
    const currentNavigationId = this.navigationIds.get(pageId) ?? 0;
    const minimumLevel = ["debug", "info", "warning", "error"];
    const levelIndex = minimumLevel.indexOf(level);
    const relevant = this.consoleEntries.filter((entry) =>
      entry.pageId === pageId &&
      minimumLevel.indexOf(entry.level) >= levelIndex &&
      (all || entry.navigationId === currentNavigationId),
    );
    const lines = relevant.map((entry) => {
      const location = entry.location ? ` (${entry.location})` : "";
      return `[${entry.level}] ${entry.text}${location}`;
    });
    const fullText = lines.length > 0 ? lines.join("\n") : "No console messages for the current page.";
    const truncated = truncateText(fullText);
    let fullPath: string | undefined;
    if (truncated.truncated) {
      fullPath = await writeOutputFile(this.config.outputDir, "console", "log", fullText);
    }
    const result: TextResult = {
      text: fullPath ? `${truncated.text}\n\nFull console log saved to: ${fullPath}` : truncated.text,
    };
    if (fullPath) {
      result.fullPath = fullPath;
    }
    return result;
  }

  async networkRequests(includeStatic = false): Promise<TextResult> {
    const page = await this.getCurrentPage();
    const pageId = this.getPageId(page);
    const currentNavigationId = this.navigationIds.get(pageId) ?? 0;
    const relevant = this.networkEntries.filter((entry) =>
      entry.pageId === pageId &&
      entry.navigationId <= currentNavigationId &&
      (includeStatic || !["image", "stylesheet", "font"].includes(entry.resourceType)),
    );
    const lines = relevant.map((entry) => {
      const status = entry.failureText ? `FAILED ${entry.failureText}` : `${entry.status ?? 0}`;
      return `${entry.method} ${status} ${entry.resourceType} ${entry.url}`;
    });
    const fullText = lines.length > 0 ? lines.join("\n") : "No network requests recorded for the current page.";
    const truncated = truncateText(fullText);
    let fullPath: string | undefined;
    if (truncated.truncated) {
      fullPath = await writeOutputFile(this.config.outputDir, "network", "log", fullText);
    }
    const result: TextResult = {
      text: fullPath ? `${truncated.text}\n\nFull network log saved to: ${fullPath}` : truncated.text,
    };
    if (fullPath) {
      result.fullPath = fullPath;
    }
    return result;
  }

  async screenshot(params: { filename?: string; fullPage?: boolean; selector?: string }): Promise<TextResult> {
    const page = await this.getCurrentPage();
    await ensureDir(this.config.outputDir);
    const rawName = params.filename?.trim();
    const extension = rawName && extname(rawName) ? extname(rawName).slice(1) : "png";
    const safeName = rawName && basename(rawName).length > 0 ? basename(rawName) : `screenshot-${Date.now()}.${extension}`;
    const path = resolve(this.config.outputDir, safeName);
    if (params.selector) {
      await page.locator(params.selector).screenshot({ path, type: extension === "jpeg" ? "jpeg" : "png" });
    } else {
      await page.screenshot({ path, type: extension === "jpeg" ? "jpeg" : "png", fullPage: params.fullPage ?? false });
    }
    const cleanup = await this.pruneArtifacts();
    return {
      text: cleanup.removed.length > 0
        ? `Saved screenshot to ${path}\n\nArtifact cleanup removed ${cleanup.removed.length} file(s), freeing ${formatBytes(cleanup.bytesFreed)}.`
        : `Saved screenshot to ${path}`,
      details: { path, cleanup },
    };
  }

  async saveVideoFrameHint(): Promise<void> {
    const page = this.getCurrentPageOrUndefined();
    if (!page) return;
    if (!this.recordingVideo) return;
    await page.waitForTimeout(50).catch(() => undefined);
  }

  async runSummary(params?: {
    captureScreenshot?: boolean;
    screenshotFullPage?: boolean;
    finalizeVideo?: boolean;
    includeConsole?: boolean;
    includeNetwork?: boolean;
    includeSnapshot?: boolean;
    filenamePrefix?: string;
  }): Promise<TextResult> {
    const options = {
      captureScreenshot: params?.captureScreenshot ?? true,
      screenshotFullPage: params?.screenshotFullPage ?? true,
      finalizeVideo: params?.finalizeVideo ?? false,
      includeConsole: params?.includeConsole ?? true,
      includeNetwork: params?.includeNetwork ?? true,
      includeSnapshot: params?.includeSnapshot ?? false,
      filenamePrefix: params?.filenamePrefix?.trim() || "browser-run-summary",
    };

    const page = await this.getCurrentPage();
    const currentUrl = page.url();
    const currentTitle = await page.title().catch(() => "");
    let screenshotPath: string | undefined;
    if (options.captureScreenshot) {
      const screenshot = await this.screenshot({ filename: `${options.filenamePrefix}-${Date.now()}.png`, fullPage: options.screenshotFullPage });
      const path = screenshot.details?.path;
      if (typeof path === "string") {
        screenshotPath = path;
      }
    }

    let videoPaths: string[] = [];
    if (options.finalizeVideo) {
      const stopped = await this.stopVideoRecording();
      const videos = stopped.details?.videos;
      if (Array.isArray(videos)) {
        videoPaths = videos.filter((value): value is string => typeof value === "string");
      }
    } else {
      videoPaths = [...this.videoArtifacts];
    }

    const consoleResult = options.includeConsole ? await this.consoleMessages("info", true) : undefined;
    const networkResult = options.includeNetwork ? await this.networkRequests(true) : undefined;
    const snapshotResult = options.includeSnapshot ? await this.snapshot() : undefined;
    const artifacts = await listArtifacts(this.config.outputDir);
    const artifactUsage = artifacts.reduce((sum, artifact) => sum + artifact.size, 0);

    const summaryLines = [
      "# Browser Run Summary",
      "",
      "## Current Page",
      `- URL: ${currentUrl || "(none)"}`,
      `- Title: ${currentTitle || "(untitled)"}`,
      `- Tabs: ${(this.context?.pages() ?? []).length}`,
      `- Video recording active: ${this.recordingVideo ? "yes" : "no"}`,
      `- Output directory: ${this.config.outputDir}`,
      `- Artifact usage: ${formatBytes(artifactUsage)}`,
      "",
      "## Artifacts",
      `- Screenshot: ${screenshotPath ?? "(not captured)"}`,
      `- Videos: ${videoPaths.length > 0 ? videoPaths.join(", ") : "(none)"}`,
      "",
    ];

    if (consoleResult) {
      summaryLines.push("## Console", consoleResult.text, "");
    }
    if (networkResult) {
      summaryLines.push("## Network", networkResult.text, "");
    }
    if (snapshotResult) {
      summaryLines.push("## Snapshot", snapshotResult.text, "");
    }

    const summaryContent = summaryLines.join("\n");
    const summaryPath = await writeOutputFile(this.config.outputDir, options.filenamePrefix, "md", summaryContent);
    const cleanup = await this.pruneArtifacts();
    const textLines = [
      "Browser run summary",
      `- URL: ${currentUrl || "(none)"}`,
      `- Title: ${currentTitle || "(untitled)"}`,
      `- Screenshot: ${screenshotPath ?? "(none)"}`,
      `- Videos: ${videoPaths.length > 0 ? videoPaths.join(", ") : "(none)"}`,
      `- Summary file: ${summaryPath}`,
    ];
    if (cleanup.removed.length > 0) {
      textLines.push(`- Cleanup: removed ${cleanup.removed.length} artifact(s), freed ${formatBytes(cleanup.bytesFreed)}`);
    }
    return {
      text: textLines.join("\n"),
      fullPath: summaryPath,
      details: {
        url: currentUrl,
        title: currentTitle,
        screenshotPath,
        videoPaths,
        summaryPath,
        console: consoleResult?.text,
        network: networkResult?.text,
        snapshot: snapshotResult?.text,
        cleanup,
      },
    };
  }

  async cleanupArtifacts(): Promise<TextResult> {
    const cleanup = await this.pruneArtifacts();
    const remaining = await listArtifacts(this.config.outputDir);
    return {
      text: cleanup.removed.length > 0
        ? `Removed ${cleanup.removed.length} artifact(s), freed ${formatBytes(cleanup.bytesFreed)}. Remaining artifacts: ${remaining.length}.`
        : `No artifacts removed. Remaining artifacts: ${remaining.length}.`,
      details: {
        removed: cleanup.removed,
        remaining,
        bytesFreed: cleanup.bytesFreed,
      },
    };
  }

  async closeCurrentPage(): Promise<TextResult> {
    const page = await this.getCurrentPage();
    await page.close();
    this.currentPageId = this.context?.pages()[0] ? this.getPageId(this.context.pages()[0]!) : undefined;
    return { text: "Closed current page" };
  }

  async tabs(action: string, index?: number, url?: string): Promise<TextResult> {
    const context = await this.getContext();
    const pages = context.pages();
    if (action === "list") {
      const currentPage = this.getCurrentPageOrUndefined();
      const lines = pages.map((page, pageIndex) => `${page === currentPage ? "*" : " "} [${pageIndex}] ${page.url() || "about:blank"}`);
      return { text: lines.length > 0 ? lines.join("\n") : "No tabs open." };
    }
    if (action === "new") {
      const page = await context.newPage();
      this.attachPage(page);
      this.currentPageId = this.getPageId(page);
      if (url) {
        await page.goto(url, { waitUntil: "domcontentloaded" });
      }
      return { text: `Opened tab ${context.pages().indexOf(page)}${url ? ` at ${page.url()}` : ""}` };
    }
    if (action === "select") {
      if (index === undefined) throw new Error("tabs select requires index");
      const page = pages[index];
      if (!page) throw new Error(`No tab at index ${index}`);
      this.currentPageId = this.getPageId(page);
      await page.bringToFront();
      return { text: `Selected tab ${index}: ${page.url()}` };
    }
    if (action === "close") {
      const target = index === undefined ? this.getCurrentPageOrUndefined() : pages[index];
      if (!target) throw new Error(index === undefined ? "No current tab" : `No tab at index ${index}`);
      await target.close();
      this.currentPageId = this.context?.pages()[0] ? this.getPageId(this.context.pages()[0]!) : undefined;
      return { text: `Closed tab ${index ?? "current"}` };
    }
    throw new Error(`Unsupported tabs action: ${action}`);
  }

  private createContextOptions(): Parameters<Browser["newContext"]>[0] {
    const contextOptions: Parameters<Browser["newContext"]>[0] = {
      viewport: this.config.viewport,
    };
    if (this.config.storageStatePath) {
      contextOptions.storageState = this.config.storageStatePath;
    }
    if (this.recordingVideo) {
      contextOptions.recordVideo = {
        dir: this.config.outputDir,
        size: this.config.videoSize,
      };
    }
    return contextOptions;
  }

  private async closeRuntime(options: { finalizeVideos: boolean }): Promise<string[]> {
    const pages = this.context?.pages() ?? [];
    this.currentRefs.clear();
    this.consoleEntries = [];
    this.networkEntries = [];
    this.navigationIds.clear();
    this.currentPageId = undefined;
    await this.context?.close();
    await this.browser?.close();
    this.context = undefined;
    this.browser = undefined;
    if (!options.finalizeVideos) {
      return [];
    }
    const videoPaths = await this.collectVideoArtifacts(pages);
    if (videoPaths.length > 0) {
      this.videoArtifacts.push(...videoPaths);
    }
    return videoPaths;
  }

  private async collectVideoArtifacts(pages: Page[]): Promise<string[]> {
    const paths = new Set<string>();
    for (const page of pages) {
      const video = page.video();
      if (!video) continue;
      try {
        const videoPath = await video.path();
        if (videoPath) {
          paths.add(videoPath);
        }
      } catch {
        // Ignore pages that did not produce frames.
      }
    }
    return Array.from(paths);
  }

  private async pruneArtifacts(): Promise<{ removed: BrowserArtifactInfo[]; remaining: BrowserArtifactInfo[]; bytesFreed: number }> {
    return pruneArtifacts(this.config.outputDir, this.config.retention);
  }

  private async getContext(): Promise<BrowserContext> {
    if (!this.context) {
      await this.start();
    }
    if (!this.context) {
      throw new Error("Browser context unavailable");
    }
    return this.context;
  }

  private async getCurrentPage(): Promise<Page> {
    const context = await this.getContext();
    const current = this.getCurrentPageOrUndefined();
    if (current) return current;
    const page = context.pages()[0] ?? (await context.newPage());
    this.attachPage(page);
    this.currentPageId = this.getPageId(page);
    return page;
  }

  private getCurrentPageOrUndefined(): Page | undefined {
    const pages = this.context?.pages() ?? [];
    if (!this.currentPageId) return pages[0];
    return pages.find((page) => this.getPageId(page) === this.currentPageId) ?? pages[0];
  }

  private getPageId(page: Page): string {
    const existing = this.pageIds.get(page);
    if (existing) return existing;
    const id = `p${++this.pageIdCounter}`;
    this.pageIds.set(page, id);
    return id;
  }

  private attachPage(page: Page): void {
    if (this.attachedPages.has(page)) {
      return;
    }
    this.attachedPages.add(page);
    const pageId = this.getPageId(page);
    if (!this.navigationIds.has(pageId)) {
      this.navigationIds.set(pageId, 0);
    }
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        this.navigationIds.set(pageId, (this.navigationIds.get(pageId) ?? 0) + 1);
      }
    });
    page.on("console", (message) => {
      this.consoleEntries.push(this.serializeConsoleMessage(page, message));
      if (this.consoleEntries.length > 500) {
        this.consoleEntries.splice(0, this.consoleEntries.length - 500);
      }
    });
    page.on("pageerror", (error) => {
      this.consoleEntries.push({
        pageId,
        pageIndex: this.getPageIndex(page),
        level: "error",
        text: error.message,
        timestamp: Date.now(),
        navigationId: this.navigationIds.get(pageId) ?? 0,
      });
    });
    page.on("response", (response) => {
      this.networkEntries.push(this.serializeResponse(page, response));
      if (this.networkEntries.length > 1000) {
        this.networkEntries.splice(0, this.networkEntries.length - 1000);
      }
    });
    page.on("requestfailed", (request) => {
      const failureEntry: NetworkEntry = {
        pageId,
        pageIndex: this.getPageIndex(page),
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        ok: false,
        timestamp: Date.now(),
        navigationId: this.navigationIds.get(pageId) ?? 0,
      };
      const failureText = request.failure()?.errorText;
      if (failureText) {
        failureEntry.failureText = failureText;
      }
      this.networkEntries.push(failureEntry);
    });
  }

  private getPageIndex(page: Page): number {
    return (this.context?.pages() ?? []).findIndex((candidate) => candidate === page);
  }

  private serializeConsoleMessage(page: Page, message: ConsoleMessage): ConsoleEntry {
    const location = message.location();
    const locationText = location.url ? `${location.url}:${location.lineNumber ?? 0}` : undefined;
    const pageId = this.getPageId(page);
    const entry: ConsoleEntry = {
      pageId,
      pageIndex: this.getPageIndex(page),
      level: consoleLevel(message.type()),
      text: message.text(),
      timestamp: Date.now(),
      navigationId: this.navigationIds.get(pageId) ?? 0,
    };
    if (locationText) {
      entry.location = locationText;
    }
    return entry;
  }

  private serializeResponse(page: Page, response: Response): NetworkEntry {
    const request = response.request();
    const pageId = this.getPageId(page);
    return {
      pageId,
      pageIndex: this.getPageIndex(page),
      url: response.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      ok: response.ok(),
      timestamp: Date.now(),
      navigationId: this.navigationIds.get(pageId) ?? 0,
    };
  }

  private async collectRefs(page: Page, selector?: string): Promise<CollectRefsResult> {
    const pageIndex = this.getPageIndex(page);
    const root = page.locator(selector ?? "body");
    const interactiveSelector = [
      "a[href]",
      "button",
      "input:not([type='hidden'])",
      "textarea",
      "select",
      "summary",
      "[role='button']",
      "[role='link']",
      "[role='tab']",
      "[role='checkbox']",
      "[role='radio']",
      "[role='switch']",
      "[contenteditable='true']",
    ].join(",");
    const textSelector = "h1,h2,h3,h4,h5,h6,p,li,label,legend";

    const refs: InteractiveElementRef[] = [];
    const interactive = root.locator(interactiveSelector);
    const count = await interactive.count();
    for (let index = 0; index < count; index++) {
      const locator = interactive.nth(index);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const ref = `e${refs.length + 1}`;
      await locator.evaluate((element, value) => {
        (element as HTMLElement).dataset.piBrowserRef = value;
      }, ref);
      const metadata = await locator.evaluate((element) => {
        const htmlElement = element as HTMLElement;
        const explicitRole = htmlElement.getAttribute("role")?.trim();
        const role = explicitRole
          ?? (htmlElement instanceof HTMLAnchorElement
            ? "link"
            : htmlElement instanceof HTMLButtonElement
              ? "button"
              : htmlElement instanceof HTMLInputElement
                ? htmlElement.type === "checkbox"
                  ? "checkbox"
                  : htmlElement.type === "radio"
                    ? "radio"
                    : htmlElement.type === "submit" || htmlElement.type === "button"
                      ? "button"
                      : "textbox"
                : htmlElement instanceof HTMLTextAreaElement
                  ? "textbox"
                  : htmlElement instanceof HTMLSelectElement
                    ? "select"
                    : htmlElement.tagName.toLowerCase());
        const labelledBy = htmlElement.getAttribute("aria-labelledby")?.trim();
        const labelledText = labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
              .filter((value) => value.length > 0)
              .join(" ")
          : "";
        const textContent = htmlElement.innerText.replace(/\s+/g, " ").trim() || htmlElement.textContent?.replace(/\s+/g, " ").trim() || "";
        const name = htmlElement.getAttribute("aria-label")?.trim()
          || labelledText
          || (htmlElement instanceof HTMLInputElement || htmlElement instanceof HTMLTextAreaElement || htmlElement instanceof HTMLSelectElement
            ? htmlElement.labels?.[0]?.textContent?.trim() || ""
            : "")
          || ("placeholder" in htmlElement ? String((htmlElement as HTMLInputElement | HTMLTextAreaElement).placeholder ?? "").trim() : "")
          || htmlElement.getAttribute("title")?.trim()
          || htmlElement.getAttribute("alt")?.trim()
          || textContent
          || htmlElement.tagName.toLowerCase();
        return {
          role,
          name,
          tagName: htmlElement.tagName.toLowerCase(),
          disabled: htmlElement.hasAttribute("disabled") || htmlElement.getAttribute("aria-disabled") === "true",
        };
      });
      refs.push({
        ref,
        role: metadata.role,
        name: metadata.name,
        tagName: metadata.tagName,
        selector: `[data-pi-browser-ref=\"${ref}\"]`,
        description: `${metadata.role} \"${metadata.name || metadata.tagName}\"`,
        disabled: metadata.disabled,
        pageIndex,
      });
    }

    const pageText: string[] = [];
    const textLocators = root.locator(textSelector);
    const textCount = Math.min(await textLocators.count(), 40);
    for (let index = 0; index < textCount; index++) {
      const locator = textLocators.nth(index);
      const visible = await locator.isVisible().catch(() => false);
      if (!visible) continue;
      const line = await locator.evaluate((element) => {
        const text = element.textContent?.replace(/\s+/g, " ").trim() ?? "";
        return text ? `- ${element.tagName.toLowerCase()}: ${text}` : "";
      });
      if (line) {
        pageText.push(line);
      }
    }

    return { refs, pageText };
  }

  private async resolveLocator(ref: string | undefined, selector: string | undefined) {
    const page = await this.getCurrentPage();
    if (ref) {
      const existing = this.currentRefs.get(ref);
      if (!existing) {
        throw new Error(`Unknown ref ${ref}. Run browser_snapshot again before interacting.`);
      }
      if (existing.pageId !== this.getPageId(page)) {
        throw new Error(`Ref ${ref} belongs to a different tab. Select the correct tab or resnapshot.`);
      }
      return page.locator(existing.selector);
    }
    if (selector) {
      return page.locator(selector);
    }
    throw new Error("Tool requires either ref or selector");
  }

  private parseFunction(source: string): (...args: unknown[]) => unknown {
    try {
      const fn = new Function(`return (${source});`)() as (...args: unknown[]) => unknown;
      if (typeof fn !== "function") {
        throw new Error("Provided source is not a function");
      }
      return fn;
    } catch (error) {
      throw new Error(`Invalid function: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
