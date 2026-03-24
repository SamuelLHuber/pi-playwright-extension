import test from "node:test";
import assert from "node:assert/strict";
import type { Static, TSchema } from "@sinclair/typebox";
import extensionFactory from "../src/index.js";

interface RegisteredTool<TParams extends TSchema = TSchema> {
  name: string;
  label: string;
  description: string;
  parameters: TParams;
  execute: (toolCallId: string, params: Static<TParams>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: unknown) => Promise<unknown>;
}

class MockPiApi {
  readonly flags = new Map<string, { description?: string; type: "boolean" | "string"; default?: boolean | string }>();
  readonly commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
  readonly tools = new Map<string, RegisteredTool>();
  readonly handlers = new Map<string, Array<(event: unknown, ctx: unknown) => Promise<void>>>();

  registerFlag(name: string, options: { description?: string; type: "boolean" | "string"; default?: boolean | string }): void {
    this.flags.set(name, options);
  }

  getFlag(name: string): boolean | string | undefined {
    return this.flags.get(name)?.default;
  }

  registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }): void {
    this.commands.set(name, options);
  }

  registerTool(tool: RegisteredTool): void {
    this.tools.set(tool.name, tool);
  }

  on(event: string, handler: (event: unknown, ctx: unknown) => Promise<void>): void {
    const handlers = this.handlers.get(event) ?? [];
    handlers.push(handler);
    this.handlers.set(event, handlers);
  }
}

test("extension registers first-class browser tools and commands", () => {
  const api = new MockPiApi();
  extensionFactory(api as never);

  assert.ok(api.flags.has("browser-headless"));
  assert.ok(api.flags.has("browser-engine"));
  assert.ok(api.flags.has("browser-output-dir"));
  assert.ok(api.flags.has("browser-record-video"));
  assert.ok(api.flags.has("browser-video-size"));
  assert.ok(api.flags.has("browser-retention-max-artifacts"));
  assert.ok(api.flags.has("browser-retention-max-bytes"));
  assert.ok(api.flags.has("browser-retention-max-days"));

  assert.ok(api.commands.has("browser"));
  assert.ok(api.commands.has("browser-open"));
  assert.ok(api.commands.has("browser-reset"));
  assert.ok(api.commands.has("browser-close"));
  assert.ok(api.commands.has("browser-video-start"));
  assert.ok(api.commands.has("browser-video-stop"));
  assert.ok(api.commands.has("browser-clean"));

  const expectedTools = [
    "browser_navigate",
    "browser_snapshot",
    "browser_click",
    "browser_type",
    "browser_press_key",
    "browser_wait_for",
    "browser_evaluate",
    "browser_console",
    "browser_network",
    "browser_screenshot",
    "browser_video_start",
    "browser_video_stop",
    "browser_video_status",
    "browser_run_summary",
    "browser_tabs",
    "browser_close",
  ];

  for (const name of expectedTools) {
    assert.ok(api.tools.has(name), `missing tool ${name}`);
  }
});
