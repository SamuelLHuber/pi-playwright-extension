import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BrowserSession } from "../src/browser-session.js";

let server: Server;
let baseUrl = "";
let outputDir = "";

before(async () => {
  outputDir = await mkdtemp(join(tmpdir(), "pi-playwright-extension-"));
  server = createServer((req, res) => {
    if (!req.url) {
      res.statusCode = 404;
      res.end();
      return;
    }
    if (req.url.startsWith("/api/data")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url.startsWith("/next")) {
      res.setHeader("Content-Type", "text/html");
      res.end(`<!doctype html><html><body><h1>Next page</h1><p>Done</p></body></html>`);
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<!doctype html>
<html>
  <body>
    <h1>Login</h1>
    <label>Email <input id="email" placeholder="Email" /></label>
    <button id="submit" onclick="console.error('clicked submit'); fetch('/api/data').then(() => location.href='/next');">Submit</button>
  </body>
</html>`);
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Failed to start test server");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  await rm(outputDir, { recursive: true, force: true });
});

test("browser session can navigate, snapshot, type, click, and inspect logs", async () => {
  const session = new BrowserSession({
    cwd: outputDir,
    browserName: "chromium",
    headless: true,
    isolated: true,
    outputDir,
    viewport: { width: 1200, height: 800 },
    videoSize: { width: 1200, height: 800 },
    recordVideo: false,
    retention: { maxArtifacts: 50, maxBytes: 512 * 1024 * 1024, maxAgeDays: 7 },
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 10_000,
  });
  await session.start();

  await session.navigate(baseUrl);
  const snapshot = await session.snapshot();
  assert.match(snapshot.text, /Login/);
  assert.match(snapshot.text, /Interactive elements:/);

  const emailRef = snapshot.refs.find((ref) => ref.role === "textbox");
  const buttonRef = snapshot.refs.find((ref) => ref.role === "button");
  assert.ok(emailRef, "expected textbox ref");
  assert.ok(buttonRef, "expected button ref");

  await session.type({ ref: emailRef.ref, text: "sam@example.com" });
  await session.click({ ref: buttonRef.ref });
  await session.waitFor({ text: "Next page" });

  const consoleMessages = await session.consoleMessages("error", true);
  assert.match(consoleMessages.text, /clicked submit/);

  const network = await session.networkRequests();
  assert.match(network.text, /GET 200 fetch/);

  await session.stop();
});

test("browser tabs can create, select, list, and close tabs", async () => {
  const session = new BrowserSession({
    cwd: outputDir,
    browserName: "chromium",
    headless: true,
    isolated: true,
    outputDir,
    viewport: { width: 1200, height: 800 },
    videoSize: { width: 1200, height: 800 },
    recordVideo: false,
    retention: { maxArtifacts: 50, maxBytes: 512 * 1024 * 1024, maxAgeDays: 7 },
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 10_000,
  });
  await session.start();
  await session.navigate(baseUrl);
  await session.tabs("new", undefined, `${baseUrl}/next`);

  const list = await session.tabs("list");
  assert.match(list.text, /\[0\]/);
  assert.match(list.text, /\[1\]/);

  const select = await session.tabs("select", 0);
  assert.match(select.text, /Selected tab 0/);

  const close = await session.tabs("close", 1);
  assert.match(close.text, /Closed tab 1/);

  await session.stop();
});

test("browser session can record video artifacts", async () => {
  const session = new BrowserSession({
    cwd: outputDir,
    browserName: "chromium",
    headless: true,
    isolated: true,
    outputDir,
    viewport: { width: 1200, height: 800 },
    videoSize: { width: 1200, height: 800 },
    recordVideo: false,
    retention: { maxArtifacts: 50, maxBytes: 512 * 1024 * 1024, maxAgeDays: 7 },
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 10_000,
  });
  await session.start();
  const started = await session.startVideoRecording();
  assert.match(started.text, /Video recording enabled/);

  await session.navigate(baseUrl);
  const snapshot = await session.snapshot();
  const buttonRef = snapshot.refs.find((ref) => ref.role === "button");
  assert.ok(buttonRef, "expected button ref for video test");
  await session.click({ ref: buttonRef.ref });
  await session.waitFor({ text: "Next page" });
  await session.screenshot({ filename: "video-check.png" });

  const stopped = await session.stopVideoRecording();
  assert.match(stopped.text, /Stopped video recording/);
  const details = stopped.details;
  assert.ok(details && Array.isArray(details.videos), "expected video list in details");
  assert.ok(details.videos.length > 0, "expected at least one video artifact");
  const firstVideo = details.videos[0];
  assert.equal(typeof firstVideo, "string");
  const videoStats = await stat(firstVideo);
  assert.ok(videoStats.size > 0, "expected non-empty video artifact");

  const status = session.getVideoStatus();
  assert.match(status.text, /Recording video: no/);
  assert.match(status.text, /Saved videos: /);

  await session.stop();
});

test("browser session can generate a bundled run summary and clean artifacts", async () => {
  const session = new BrowserSession({
    cwd: outputDir,
    browserName: "chromium",
    headless: true,
    isolated: true,
    outputDir,
    viewport: { width: 1200, height: 800 },
    videoSize: { width: 1200, height: 800 },
    recordVideo: false,
    retention: { maxArtifacts: 5, maxBytes: 10 * 1024 * 1024, maxAgeDays: 7 },
    actionTimeoutMs: 10_000,
    navigationTimeoutMs: 10_000,
  });
  await session.start();
  await session.startVideoRecording();
  await session.navigate(baseUrl);
  const snapshot = await session.snapshot();
  const buttonRef = snapshot.refs.find((ref) => ref.role === "button");
  assert.ok(buttonRef, "expected button ref for summary test");
  await session.click({ ref: buttonRef.ref });
  await session.waitFor({ text: "Next page" });

  const summary = await session.runSummary({ finalizeVideo: true, includeSnapshot: true, filenamePrefix: "summary-test" });
  assert.match(summary.text, /Browser run summary/);
  assert.ok(summary.fullPath, "expected summary path");
  const summaryStats = await stat(summary.fullPath);
  assert.ok(summaryStats.size > 0, "expected non-empty summary artifact");

  const cleanup = await session.cleanupArtifacts();
  assert.match(cleanup.text, /Remaining artifacts/);
  await session.stop();
});
