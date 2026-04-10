declare module "@mariozechner/pi-coding-agent" {
  import type { Static, TSchema } from "@sinclair/typebox";

  export interface ExtensionUIContext {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    setStatus(key: string, text: string | undefined): void;
    setWidget(key: string, content: string[] | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
  }

  export interface ExtensionContext {
    ui: ExtensionUIContext;
    cwd: string;
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface ToolResult<TDetails = unknown> {
    content: Array<{ type: "text"; text: string }>;
    details?: TDetails;
  }

  export interface ToolDefinition<TParams extends TSchema = TSchema, TDetails = unknown> {
    name: string;
    label: string;
    description: string;
    promptSnippet?: string;
    promptGuidelines?: string[];
    parameters: TParams;
    execute(
      toolCallId: string,
      params: Static<TParams>,
      signal: AbortSignal | undefined,
      onUpdate: unknown,
      ctx: ExtensionContext,
    ): Promise<ToolResult<TDetails>>;
  }

  export interface SessionStartEvent {
    type: "session_start";
    reason: "startup" | "reload" | "new" | "resume" | "fork";
    previousSessionFile?: string;
  }

  export interface SessionShutdownEvent {
    type: "session_shutdown";
  }

  export interface SessionTreeEvent {
    type: "session_tree";
  }

  export interface ExtensionAPI {
    registerFlag(
      name: string,
      options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
    ): void;
    getFlag(name: string): boolean | string | undefined;
    registerCommand(
      name: string,
      options: { description?: string; handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
    ): void;
    registerTool<TParams extends TSchema = TSchema, TDetails = unknown>(tool: ToolDefinition<TParams, TDetails>): void;
    on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>): void;
    on(event: "session_shutdown", handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => Promise<void>): void;
    on(event: "session_tree", handler: (event: SessionTreeEvent, ctx: ExtensionContext) => Promise<void>): void;
  }
}
