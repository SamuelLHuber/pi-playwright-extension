import { Type } from "@sinclair/typebox";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { http } from "viem";
import { mainnet, sepolia, polygon, optimism, arbitrum, base } from "viem/chains";
import type { BrowserSession } from "./browser-session.js";
import {
  installWalletProvider,
  setRequestHandler,
  getPendingRequests,
  approveRequest,
  rejectRequest,
  setSessionAccount,
  getSessionStatus,
  removeSession,
  type WalletProviderConfig,
} from "./wallet-provider.js";

const SUPPORTED_CHAINS = {
  mainnet,
  sepolia,
  polygon,
  optimism,
  arbitrum,
  base,
};

interface WalletState {
  sessionId: string | undefined;
  pendingApprovals: Map<string, PendingApproval>;
}

interface PendingApproval {
  id: string;
  method: string;
  origin: string;
  params?: unknown[] | undefined;
  timestamp: number;
}

export function registerWalletExtension(pi: ExtensionAPI, getBrowserSession: () => Promise<BrowserSession>) {
  const walletState: WalletState = {
    sessionId: undefined,
    pendingApprovals: new Map(),
  };

  // Set up the approval handler
  setRequestHandler(async (request) => {
    const approval: PendingApproval = {
      id: request.id,
      method: request.method,
      origin: request.origin,
      params: request.params,
      timestamp: request.timestamp,
    };
    walletState.pendingApprovals.set(request.id, approval);

    // Format user-friendly message
    let message = formatWalletRequest(request.method, request.params, request.origin);
    
    // Notify the user UI (this would need to integrate with pi's notification system)
    console.log("[Pi Wallet] Approval required:", message);
    
    // For now, we throw to signal that user approval is needed
    // In a real implementation, this would wait for a tool call
    throw new Error(`Wallet approval required: ${message}`);
  });

  // Register flag for default chain
  pi.registerFlag("wallet-default-chain", {
    description: "Default chain for wallet (mainnet, sepolia, polygon, optimism, arbitrum, base)",
    type: "string",
    default: "mainnet",
  });

  // Register wallet commands
  pi.registerCommand("wallet-enable", {
    description: "Enable Pi Wallet in the browser - injects wallet provider into current page",
    handler: async (_args, ctx) => {
      const session = await getBrowserSession();
      const page = await session.getCurrentPage();
      
      const chainName = (pi.getFlag("wallet-default-chain") as string) ?? "mainnet";
      const chain = SUPPORTED_CHAINS[chainName as keyof typeof SUPPORTED_CHAINS] ?? mainnet;
      
      const config: WalletProviderConfig = {
        defaultChain: chain,
        transports: { [chain.id]: http() },
      };
      
      const sessionId = await installWalletProvider(page, config);
      walletState.sessionId = sessionId;
      
      ctx.ui.notify(`Pi Wallet enabled (session: ${sessionId.slice(0, 8)}...)`, "info");
      ctx.ui.notify("Navigate to a dApp and click 'Connect Wallet' - Pi Wallet should appear as an option", "info");
    },
  });

  pi.registerCommand("wallet-import", {
    description: "Import a private key into Pi Wallet: /wallet-import <private-key>",
    handler: async (args, ctx) => {
      const pk = args.trim();
      if (!pk) {
        ctx.ui.notify("Usage: /wallet-import <private-key>", "warning");
        return;
      }
      
      if (!walletState.sessionId) {
        ctx.ui.notify("Wallet not enabled. Run /wallet-enable first", "warning");
        return;
      }

      try {
        const account = privateKeyToAccount(pk as `0x${string}`);
        setSessionAccount(walletState.sessionId, account);
        ctx.ui.notify(`Imported wallet: ${account.address}`, "info");
        ctx.ui.notify("⚠️ Private key is stored in memory only for this session", "warning");
      } catch (e) {
        ctx.ui.notify(`Failed to import: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wallet-generate", {
    description: "Generate a new random wallet for testing",
    handler: async (_args, ctx) => {
      if (!walletState.sessionId) {
        ctx.ui.notify("Wallet not enabled. Run /wallet-enable first", "warning");
        return;
      }

      const privateKey = generatePrivateKey();
      const account = privateKeyToAccount(privateKey);
      setSessionAccount(walletState.sessionId, account);
      
      ctx.ui.notify(`Generated test wallet: ${account.address}`, "info");
      ctx.ui.notify(`Private key (save this!): ${privateKey}`, "info");
      ctx.ui.notify("⚠️ This is a random test wallet - fund it with testnet ETH only!", "warning");
    },
  });

  pi.registerCommand("wallet-status", {
    description: "Show Pi Wallet status",
    handler: async (_args, ctx) => {
      if (!walletState.sessionId) {
        ctx.ui.notify("Wallet not enabled", "warning");
        return;
      }

      const status = getSessionStatus(walletState.sessionId);
      if (!status) {
        ctx.ui.notify("Wallet session not found", "error");
        return;
      }

      const lines = [
        "Pi Wallet Status:",
        `  Connected: ${status.connected ? "yes" : "no"}`,
        `  Address: ${status.address ?? "(none set)"}`,
        `  Chain ID: ${status.chainId}`,
        `  Pending approvals: ${status.pendingCount}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("wallet-approve", {
    description: "Approve a pending wallet request: /wallet-approve <request-id>",
    handler: async (args, ctx) => {
      const requestId = args.trim();
      if (!requestId) {
        // Show pending requests
        const pending = Array.from(walletState.pendingApprovals.values());
        if (pending.length === 0) {
          ctx.ui.notify("No pending wallet requests", "info");
          return;
        }
        const lines = ["Pending requests:"];
        for (const req of pending) {
          lines.push(`  ${req.id} - ${req.method} from ${req.origin}`);
        }
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (!walletState.sessionId) {
        ctx.ui.notify("Wallet not enabled", "warning");
        return;
      }

      try {
        await approveRequest(walletState.sessionId, requestId);
        walletState.pendingApprovals.delete(requestId);
        ctx.ui.notify(`Approved request ${requestId}`, "info");
      } catch (e) {
        ctx.ui.notify(`Failed to approve: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  pi.registerCommand("wallet-reject", {
    description: "Reject a pending wallet request: /wallet-reject <request-id>",
    handler: async (args, ctx) => {
      const requestId = args.trim();
      if (!requestId) {
        ctx.ui.notify("Usage: /wallet-reject <request-id>", "warning");
        return;
      }

      if (!walletState.sessionId) {
        ctx.ui.notify("Wallet not enabled", "warning");
        return;
      }

      try {
        rejectRequest(walletState.sessionId, requestId);
        walletState.pendingApprovals.delete(requestId);
        ctx.ui.notify(`Rejected request ${requestId}`, "info");
      } catch (e) {
        ctx.ui.notify(`Failed to reject: ${e instanceof Error ? e.message : String(e)}`, "error");
      }
    },
  });

  // Register wallet tools
  pi.registerTool({
    name: "wallet_enable",
    label: "Enable Pi Wallet",
    description: "Enable Pi Wallet provider in the current browser page. After enabling, the wallet will appear in dApp 'Connect Wallet' dialogs as 'Pi Wallet'.",
    parameters: Type.Object({
      chain: Type.Optional(Type.String({ description: "Chain to use (mainnet, sepolia, polygon, optimism, arbitrum, base). Defaults to extension flag setting." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const session = await getBrowserSession();
      const page = await session.getCurrentPage();
      
      const chainName = params.chain ?? (pi.getFlag("wallet-default-chain") as string) ?? "mainnet";
      const chain = SUPPORTED_CHAINS[chainName as keyof typeof SUPPORTED_CHAINS] ?? mainnet;
      
      const config: WalletProviderConfig = {
        defaultChain: chain,
        transports: { [chain.id]: http() },
      };
      
      const sessionId = await installWalletProvider(page, config);
      walletState.sessionId = sessionId;
      
      return {
        content: [{
          type: "text",
          text: `Pi Wallet enabled with session ${sessionId.slice(0, 8)}... on ${chain.name}.\n\nNavigate to a dApp and click 'Connect Wallet' - 'Pi Wallet' should appear as an option.`,
        }],
      };
    },
  });

  pi.registerTool({
    name: "wallet_import",
    label: "Import Wallet Private Key",
    description: "Import a private key to use with Pi Wallet. The key is stored only in memory for this session.",
    parameters: Type.Object({
      privateKey: Type.String({ description: "Ethereum private key (0x...)" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!walletState.sessionId) {
        return {
          content: [{ type: "text", text: "Error: Wallet not enabled. Call wallet_enable first." }],
          isError: true,
        };
      }

      try {
        const account = privateKeyToAccount(params.privateKey as `0x${string}`);
        setSessionAccount(walletState.sessionId, account);
        return {
          content: [{
            type: "text",
            text: `Wallet imported: ${account.address}\n\n⚠️ Private key is stored in memory only for this session. Never share your private key.`,
          }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to import: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "wallet_status",
    label: "Wallet Status",
    description: "Get the current status of Pi Wallet including address, chain, and pending approvals.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      if (!walletState.sessionId) {
        return {
          content: [{ type: "text", text: "Wallet not enabled" }],
        };
      }

      const status = getSessionStatus(walletState.sessionId);
      if (!status) {
        return {
          content: [{ type: "text", text: "Wallet session not found" }],
          isError: true,
        };
      }

      const pending = Array.from(walletState.pendingApprovals.values());
      const lines = [
        "Pi Wallet Status:",
        `  Connected: ${status.connected ? "yes" : "no"}`,
        `  Address: ${status.address ?? "(none set)"}`,
        `  Chain ID: ${status.chainId}`,
        `  Pending approvals: ${status.pendingCount}`,
      ];
      
      if (pending.length > 0) {
        lines.push("", "Pending requests:");
        for (const req of pending) {
          lines.push(`  ${req.id} - ${req.method} from ${req.origin}`);
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });

  pi.registerTool({
    name: "wallet_approve",
    label: "Approve Wallet Request",
    description: "Approve a pending wallet request (connection, transaction, or signing).",
    parameters: Type.Object({
      requestId: Type.String({ description: "The request ID to approve" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!walletState.sessionId) {
        return {
          content: [{ type: "text", text: "Error: Wallet not enabled" }],
          isError: true,
        };
      }

      try {
        await approveRequest(walletState.sessionId, params.requestId);
        walletState.pendingApprovals.delete(params.requestId);
        return {
          content: [{ type: "text", text: `Approved request ${params.requestId}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to approve: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  pi.registerTool({
    name: "wallet_reject",
    label: "Reject Wallet Request",
    description: "Reject a pending wallet request.",
    parameters: Type.Object({
      requestId: Type.String({ description: "The request ID to reject" }),
      reason: Type.Optional(Type.String({ description: "Optional rejection reason" })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (!walletState.sessionId) {
        return {
          content: [{ type: "text", text: "Error: Wallet not enabled" }],
          isError: true,
        };
      }

      try {
        rejectRequest(walletState.sessionId, params.requestId, params.reason);
        walletState.pendingApprovals.delete(params.requestId);
        return {
          content: [{ type: "text", text: `Rejected request ${params.requestId}` }],
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `Failed to reject: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }
    },
  });

  // Handle session cleanup
  pi.on("session_shutdown", async () => {
    if (walletState.sessionId) {
      removeSession(walletState.sessionId);
      walletState.sessionId = undefined;
      walletState.pendingApprovals.clear();
    }
  });
}

function formatWalletRequest(method: string, params: unknown[] | undefined, origin: string): string {
  switch (method) {
    case "eth_requestAccounts":
      return `${origin} wants to connect to your wallet`;
    case "eth_sendTransaction": {
      const tx = params?.[0] as any;
      return `${origin} wants to send transaction:\n  To: ${tx?.to}\n  Value: ${tx?.value} wei\n  Data: ${tx?.data?.slice(0, 50)}...`;
    }
    case "personal_sign": {
      const message = params?.[0] as string;
      return `${origin} wants you to sign message: ${message?.slice(0, 50)}...`;
    }
    case "eth_signTypedData_v4":
      return `${origin} wants you to sign typed data`;
    default:
      return `${origin} wants to call ${method}`;
  }
}
