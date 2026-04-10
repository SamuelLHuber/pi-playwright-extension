import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BrowserSession } from "./browser-session.js";
import type { BrowserLaunchConfig, BrowserStatus } from "./types.js";
import { formatStatusLine, normalizeBrowserName, parsePositiveBytes, parsePositiveInt, parseViewport, resolveOutputDir } from "./utils.js";

const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_ACTION_TIMEOUT_MS = 5_000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;
const DEFAULT_RETENTION_MAX_ARTIFACTS = 50;
const DEFAULT_RETENTION_MAX_BYTES = 512 * 1024 * 1024;
const DEFAULT_RETENTION_MAX_DAYS = 7;

function parseBooleanFlag(value: boolean | string | undefined, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return fallback;
}

function formatBrowserStatus(status: BrowserStatus): string {
  if (!status.started) {
    return `Browser: idle${status.recordingVideo ? " | video armed" : ""}`;
  }
  const bits = [
    `${status.browserName}${status.headless ? " headless" : ""}`,
    `${Math.max(status.tabCount, 0)} tab${status.tabCount === 1 ? "" : "s"}`,
  ];
  if (status.recordingVideo) bits.push("recording video");
  if (status.currentUrl) bits.push(status.currentUrl);
  return `Browser: ${bits.join(" | ")}`;
}

export default function playwrightExtension(pi: ExtensionAPI) {
  let browserSession: BrowserSession | undefined;
  let lastCwd = process.cwd();

  function getConfig(ctx: ExtensionContext): BrowserLaunchConfig {
    lastCwd = ctx.cwd;
    const config: BrowserLaunchConfig = {
      cwd: ctx.cwd,
      browserName: normalizeBrowserName(pi.getFlag("browser-engine") as string | undefined),
      headless: parseBooleanFlag(pi.getFlag("browser-headless"), true),
      isolated: true,
      outputDir: resolveOutputDir(ctx.cwd, pi.getFlag("browser-output-dir") as string | undefined),
      viewport: parseViewport(pi.getFlag("browser-viewport") as string | undefined, DEFAULT_VIEWPORT),
      videoSize: parseViewport(pi.getFlag("browser-video-size") as string | undefined, DEFAULT_VIEWPORT),
      recordVideo: parseBooleanFlag(pi.getFlag("browser-record-video"), false),
      retention: {
        maxArtifacts: parsePositiveInt(pi.getFlag("browser-retention-max-artifacts") as string | undefined, DEFAULT_RETENTION_MAX_ARTIFACTS),
        maxBytes: parsePositiveBytes(pi.getFlag("browser-retention-max-bytes") as string | undefined, DEFAULT_RETENTION_MAX_BYTES),
        maxAgeDays: parsePositiveInt(pi.getFlag("browser-retention-max-days") as string | undefined, DEFAULT_RETENTION_MAX_DAYS),
      },
      actionTimeoutMs: parsePositiveInt(pi.getFlag("browser-timeout-action") as string | undefined, DEFAULT_ACTION_TIMEOUT_MS),
      navigationTimeoutMs: parsePositiveInt(pi.getFlag("browser-timeout-navigation") as string | undefined, DEFAULT_NAVIGATION_TIMEOUT_MS),
    };
    const storageStatePath = (pi.getFlag("browser-storage-state") as string | undefined) || undefined;
    if (storageStatePath) {
      config.storageStatePath = storageStatePath;
    }
    return config;
  }

  async function getSession(ctx: ExtensionContext): Promise<BrowserSession> {
    if (!browserSession) {
      browserSession = new BrowserSession(getConfig(ctx));
      await browserSession.start();
      updateUi(ctx);
    }
    return browserSession;
  }

  function updateUi(ctx: ExtensionContext): void {
    const status = browserSession?.getStatus() ?? {
      started: false,
      browserName: normalizeBrowserName(pi.getFlag("browser-engine") as string | undefined),
      headless: parseBooleanFlag(pi.getFlag("browser-headless"), true),
      recordingVideo: parseBooleanFlag(pi.getFlag("browser-record-video"), false),
      tabCount: 0,
      currentTabIndex: -1,
      outputDir: resolveOutputDir(lastCwd, pi.getFlag("browser-output-dir") as string | undefined),
    };
    ctx.ui.setStatus("browser", formatBrowserStatus(status));
  }

  async function closeSession(ctx: ExtensionContext, reason?: string): Promise<void> {
    if (!browserSession) {
      updateUi(ctx);
      return;
    }
    await browserSession.stop();
    browserSession = undefined;
    updateUi(ctx);
    if (reason) ctx.ui.notify(reason, "info");
  }

  pi.registerFlag("browser-headless", {
    description: "Run Playwright in headless mode",
    type: "boolean",
    default: true,
  });
  pi.registerFlag("browser-engine", {
    description: "Browser engine: chromium, firefox, or webkit",
    type: "string",
    default: "chromium",
  });
  pi.registerFlag("browser-output-dir", {
    description: "Directory for screenshots and large browser artifacts",
    type: "string",
    default: ".pi/browser",
  });
  pi.registerFlag("browser-storage-state", {
    description: "Optional Playwright storage state JSON file",
    type: "string",
  });
  pi.registerFlag("browser-viewport", {
    description: "Viewport size, e.g. 1440x960",
    type: "string",
    default: "1440x960",
  });
  pi.registerFlag("browser-record-video", {
    description: "Start the browser session with video recording enabled",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("browser-video-size", {
    description: "Recorded video size, e.g. 1440x960",
    type: "string",
    default: "1440x960",
  });
  pi.registerFlag("browser-retention-max-artifacts", {
    description: "Maximum number of browser artifacts to keep in the output directory",
    type: "string",
    default: String(DEFAULT_RETENTION_MAX_ARTIFACTS),
  });
  pi.registerFlag("browser-retention-max-bytes", {
    description: "Maximum total browser artifact size, e.g. 512MB",
    type: "string",
    default: String(DEFAULT_RETENTION_MAX_BYTES),
  });
  pi.registerFlag("browser-retention-max-days", {
    description: "Maximum artifact age in days before cleanup removes them",
    type: "string",
    default: String(DEFAULT_RETENTION_MAX_DAYS),
  });
  pi.registerFlag("browser-timeout-action", {
    description: "Action timeout in milliseconds",
    type: "string",
    default: String(DEFAULT_ACTION_TIMEOUT_MS),
  });
  pi.registerFlag("browser-timeout-navigation", {
    description: "Navigation timeout in milliseconds",
    type: "string",
    default: String(DEFAULT_NAVIGATION_TIMEOUT_MS),
  });

  pi.on("session_start", async (_event, ctx) => {
    updateUi(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await closeSession(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await closeSession(ctx, "Browser reset after tree navigation.");
  });

  pi.registerCommand("browser", {
    description: "Show browser status",
    handler: async (_args, ctx) => {
      updateUi(ctx);
      const status = browserSession?.getStatus() ?? {
        started: false,
        browserName: normalizeBrowserName(pi.getFlag("browser-engine") as string | undefined),
        headless: parseBooleanFlag(pi.getFlag("browser-headless"), true),
        recordingVideo: parseBooleanFlag(pi.getFlag("browser-record-video"), false),
        tabCount: 0,
        currentTabIndex: -1,
        outputDir: resolveOutputDir(ctx.cwd, pi.getFlag("browser-output-dir") as string | undefined),
      };
      ctx.ui.notify(formatBrowserStatus(status), "info");
    },
  });

  pi.registerCommand("browser-open", {
    description: "Open a URL in the headless browser: /browser-open <url>",
    handler: async (args, ctx) => {
      const url = args.trim();
      if (!url) {
        ctx.ui.notify("Usage: /browser-open <url>", "warning");
        return;
      }
      const session = await getSession(ctx);
      const result = await session.navigate(url);
      updateUi(ctx);
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.registerCommand("browser-reset", {
    description: "Reset the headless browser session",
    handler: async (_args, ctx) => {
      await closeSession(ctx);
      await getSession(ctx);
      updateUi(ctx);
      ctx.ui.notify("Browser reset.", "info");
    },
  });

  pi.registerCommand("browser-close", {
    description: "Close the headless browser session",
    handler: async (_args, ctx) => {
      await closeSession(ctx, "Browser closed.");
    },
  });

  pi.registerCommand("browser-video-start", {
    description: "Enable browser video recording for subsequent actions",
    handler: async (_args, ctx) => {
      const session = await getSession(ctx);
      const result = await session.startVideoRecording();
      updateUi(ctx);
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.registerCommand("browser-video-stop", {
    description: "Stop browser video recording and finalize video artifacts",
    handler: async (_args, ctx) => {
      const session = await getSession(ctx);
      const result = await session.stopVideoRecording();
      updateUi(ctx);
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.registerCommand("browser-clean", {
    description: "Prune old browser artifacts according to retention settings",
    handler: async (_args, ctx) => {
      const session = await getSession(ctx);
      const result = await session.cleanupArtifacts();
      updateUi(ctx);
      ctx.ui.notify(result.text, "info");
    },
  });

  pi.registerTool({
    name: "browser_navigate",
    label: "Browser Navigate",
    description: "Open a URL in the headless browser and wait for the page to settle.",
    promptSnippet: "Open a webpage in the persistent headless browser session.",
    promptGuidelines: [
      "Use browser_navigate when the task requires interacting with a webpage.",
      "After browser_navigate, usually call browser_snapshot before clicking or typing.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "The URL to open." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.navigate(params.url);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  });

  pi.registerTool({
    name: "browser_snapshot",
    label: "Browser Snapshot",
    description: "Capture an ARIA-oriented snapshot of the current page plus stable refs for visible interactive elements.",
    promptSnippet: "Inspect the current page before interacting with it.",
    promptGuidelines: [
      "Prefer browser_snapshot over screenshots when deciding what to click or type.",
      "Use refs returned by browser_snapshot with browser_click and browser_type.",
    ],
    parameters: Type.Object({
      selector: Type.Optional(Type.String({ description: "Optional CSS selector to scope the snapshot." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.snapshot(params.selector);
      updateUi(ctx);
      return {
        content: [{ type: "text", text: result.text }],
        details: { refs: result.refs, aria: result.aria, fullPath: result.fullPath },
      };
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description: "Click an element on the current page. Prefer an exact ref from the latest browser_snapshot. Use selector only as a fallback.",
    promptSnippet: "Click buttons, links, and other interactive page elements using exact refs from browser_snapshot.",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Stable element ref from the latest browser_snapshot. Prefer this." })),
      selector: Type.Optional(Type.String({ description: "CSS selector only when no usable ref is available." })),
      doubleClick: Type.Optional(Type.Boolean({ description: "Double click instead of single click." })),
      button: Type.Optional(Type.String({ description: "Mouse button: left, right, or middle." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const button = params.button === "right" || params.button === "middle" ? params.button : "left";
      const clickParams: { ref?: string; selector?: string; doubleClick?: boolean; button?: "left" | "right" | "middle" } = { button };
      if (params.ref) clickParams.ref = params.ref;
      if (params.selector) clickParams.selector = params.selector;
      if (params.doubleClick !== undefined) clickParams.doubleClick = params.doubleClick;
      const result = await session.click(clickParams);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_type",
    label: "Browser Type",
    description: "Type text into an element on the current page. Prefer an exact ref from the latest browser_snapshot. Use selector only as a fallback.",
    promptSnippet: "Type into inputs and editable controls using exact refs from browser_snapshot.",
    parameters: Type.Object({
      ref: Type.Optional(Type.String({ description: "Stable element ref from the latest browser_snapshot. Prefer this." })),
      selector: Type.Optional(Type.String({ description: "CSS selector only when no usable ref is available." })),
      text: Type.String({ description: "The text to enter." }),
      submit: Type.Optional(Type.Boolean({ description: "Press Enter after typing." })),
      slowly: Type.Optional(Type.Boolean({ description: "Type with a small delay between characters." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.type(params);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_press_key",
    label: "Browser Press Key",
    description: "Press a keyboard key in the current page.",
    parameters: Type.Object({
      key: Type.String({ description: "The key to press, e.g. Enter or ArrowDown." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.pressKey(params.key);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_wait_for",
    label: "Browser Wait For",
    description: "Wait for time, selector visibility, text appearance, or text disappearance.",
    parameters: Type.Object({
      time: Type.Optional(Type.Number({ description: "Seconds to wait." })),
      selector: Type.Optional(Type.String({ description: "CSS selector to wait to become visible." })),
      text: Type.Optional(Type.String({ description: "Visible text to wait for." })),
      textGone: Type.Optional(Type.String({ description: "Visible text to wait to disappear." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.waitFor(params);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_evaluate",
    label: "Browser Evaluate",
    description: "Run a JavaScript function on the current page or on a specific element.",
    parameters: Type.Object({
      function: Type.String({ description: "A JavaScript function string, e.g. () => document.title" }),
      ref: Type.Optional(Type.String({ description: "Stable element ref from browser_snapshot." })),
      selector: Type.Optional(Type.String({ description: "CSS selector when no ref is available." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.evaluate(params);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description: "Read console messages from the current page.",
    parameters: Type.Object({
      level: Type.Optional(Type.String({ description: "Minimum level: debug, info, warning, or error." })),
      all: Type.Optional(Type.Boolean({ description: "Include messages from previous navigations in the current tab." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const level = params.level === "debug" || params.level === "warning" || params.level === "error" ? params.level : "info";
      const result = await session.consoleMessages(level, params.all ?? false);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? { fullPath: result.fullPath } };
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    description: "Read network requests captured for the current page.",
    parameters: Type.Object({
      includeStatic: Type.Optional(Type.Boolean({ description: "Include images, stylesheets, and fonts." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.networkRequests(params.includeStatic ?? false);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? { fullPath: result.fullPath } };
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description: "Save a screenshot of the current page or a specific element to the browser output directory.",
    parameters: Type.Object({
      filename: Type.Optional(Type.String({ description: "Optional filename within the browser output directory." })),
      fullPage: Type.Optional(Type.Boolean({ description: "Capture the full scrollable page." })),
      selector: Type.Optional(Type.String({ description: "Optional CSS selector for an element screenshot." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.screenshot(params);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  });

  pi.registerTool({
    name: "browser_video_start",
    label: "Browser Video Start",
    description: "Enable video recording for the current browser session. This recreates the browser context so recording starts cleanly.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.startVideoRecording();
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  });

  pi.registerTool({
    name: "browser_video_stop",
    label: "Browser Video Stop",
    description: "Stop browser video recording, finalize video artifacts, and return their paths.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.stopVideoRecording();
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  });

  pi.registerTool({
    name: "browser_video_status",
    label: "Browser Video Status",
    description: "Report whether browser video recording is active and list saved videos.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = session.getVideoStatus();
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? {} };
    },
  });

  pi.registerTool({
    name: "browser_run_summary",
    label: "Browser Run Summary",
    description: "Capture a consolidated browser run summary with optional screenshot, optional finalized video, diagnostics, and a markdown artifact.",
    parameters: Type.Object({
      captureScreenshot: Type.Optional(Type.Boolean({ description: "Capture a final screenshot before writing the summary." })),
      screenshotFullPage: Type.Optional(Type.Boolean({ description: "When capturing a screenshot, capture the full page." })),
      finalizeVideo: Type.Optional(Type.Boolean({ description: "If video recording is active, stop it and finalize saved videos." })),
      includeConsole: Type.Optional(Type.Boolean({ description: "Include console output in the summary." })),
      includeNetwork: Type.Optional(Type.Boolean({ description: "Include network output in the summary." })),
      includeSnapshot: Type.Optional(Type.Boolean({ description: "Include a fresh browser snapshot in the summary." })),
      filenamePrefix: Type.Optional(Type.String({ description: "Filename prefix for the summary artifact files." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.runSummary(params);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: result.details ?? { fullPath: result.fullPath } };
    },
  });

  pi.registerTool({
    name: "browser_tabs",
    label: "Browser Tabs",
    description: "List, create, select, or close tabs in the current browser session.",
    parameters: Type.Object({
      action: Type.String({ description: "One of: list, new, select, close." }),
      index: Type.Optional(Type.Number({ description: "Tab index for select or close." })),
      url: Type.Optional(Type.String({ description: "Optional URL for the new tab action." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.tabs(params.action, params.index, params.url);
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the current tab, or the whole browser session if no tabs remain.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const session = await getSession(ctx);
      const result = await session.closeCurrentPage();
      updateUi(ctx);
      return { content: [{ type: "text", text: result.text }], details: {} };
    },
  });
}
