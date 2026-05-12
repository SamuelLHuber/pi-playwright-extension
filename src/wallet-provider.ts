import type { Page, BrowserContext } from "playwright";
import { type Hex, type LocalAccount, type Chain, type Transport } from "viem";
import { createWalletClient, http } from "viem";
import * as chains from "viem/chains";
import { randomUUID } from "crypto";

// Wallet state storage - scoped to pi session
interface WalletSession {
  id: string;
  account: LocalAccount | undefined;
  chain: Chain;
  transports: Record<number, Transport>;
  connected: boolean; // Whether user has approved connection for this dApp
  approvedOrigins: Set<string>; // Origins that can auto-connect
  pendingRequests: Map<string, PendingRequest>;
}

interface PendingRequest {
  id: string;
  method: string;
  params: unknown[] | undefined;
  origin: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timestamp: number;
}

// Global wallet sessions across all pages
const walletSessions = new Map<string, WalletSession>();

// Request callback - set by the extension to handle UI/approval
let requestCallback: ((request: PendingRequest) => Promise<unknown>) | undefined;

export interface WalletProviderConfig {
  account?: LocalAccount; // If not set, pi will prompt to create/import
  defaultChain?: Chain;
  transports?: Record<number, Transport>;
  autoApproveOrigins?: string[]; // For trusted dApps during testing
}

export async function installWalletProvider(
  pageOrContext: Page | BrowserContext,
  config: WalletProviderConfig = {}
): Promise<string> {
  const uuid = randomUUID();
  const session: WalletSession = {
    id: uuid,
    account: config.account,
    chain: config.defaultChain ?? getChain(),
    transports: config.transports ?? {},
    connected: false,
    approvedOrigins: new Set(config.autoApproveOrigins ?? []),
    pendingRequests: new Map(),
  };
  walletSessions.set(uuid, session);

  // Expose the request handler to the browser context
  await pageOrContext.exposeFunction("piWalletRequest", async (request: {
    method: string;
    params?: unknown[];
    uuid: string;
    origin: string;
  }) => {
    return handleWalletRequest(request.method, request.params, request.uuid, request.origin);
  });

  // Inject the wallet provider script
  await pageOrContext.addInitScript(
    ({ uuid, chainId }) => {
      // EIP-1193 Provider implementation
      const provider: EIP1193Provider = {
        request: async ({ method, params }) => {
          // Get the current origin
          const origin = window.location.origin;
          return await (window as any).piWalletRequest({ method, params, uuid, origin });
        },
        on: (event: string, listener: (...args: any[]) => void) => {
          window.addEventListener(`eip1193:${event}`, listener as EventListener);
        },
        removeListener: (event: string, listener: (...args: any[]) => void) => {
          window.removeEventListener(`eip1193:${event}`, listener as EventListener);
        },
      };

      // EIP-6963 Provider Info
      const info: EIP6963ProviderInfo = {
        uuid,
        name: "Pi Wallet",
        icon: "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24' fill='none' stroke='%234F46E5' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><circle cx='12' cy='12' r='10'/><path d='M12 6v12M6 12h12'/></svg>",
        rdns: "works.pi.wallet",
      };

      // Announce provider via EIP-6963
      function announceProvider() {
        const detail: EIP6963ProviderDetail = { info, provider };
        const event = new CustomEvent("eip6963:announceProvider", {
          detail: Object.freeze(detail),
        });
        window.dispatchEvent(event);
      }

      // Announce immediately
      announceProvider();

      // Re-announce when requested
      window.addEventListener("eip6963:requestProvider", () => {
        announceProvider();
      });

      // Also handle DOMContentLoaded for late injectors
      if (document.readyState === "loading") {
        window.addEventListener("DOMContentLoaded", announceProvider);
      }

      // Store chain ID for events
      let currentChainId = chainId;

      // Listen for chain changes from pi
      window.addEventListener("piWallet:chainChanged", ((event: CustomEvent) => {
        if (event.detail?.chainId && event.detail.chainId !== currentChainId) {
          currentChainId = event.detail.chainId;
          provider.emit?.("chainChanged", currentChainId);
        }
      }) as EventListener);
    },
    { uuid, chainId: `0x${session.chain.id.toString(16)}` }
  );

  return uuid;
}

async function handleWalletRequest(
  method: string,
  params: unknown[] | undefined,
  uuid: string,
  origin: string
): Promise<unknown> {
  const session = walletSessions.get(uuid);
  if (!session) {
    throw new Error("Wallet session not found");
  }

  const requestId = randomUUID();

  switch (method) {
    case "eth_requestAccounts": {
      // Check if already approved for this origin
      if (session.approvedOrigins.has(origin)) {
        session.connected = true;
        return session.account ? [session.account.address] : [];
      }

      // Need user approval
      return new Promise((resolve, reject) => {
        const pending: PendingRequest = {
          id: requestId,
          method,
          params,
          origin,
          resolve: (result) => {
            session.approvedOrigins.add(origin);
            session.connected = true;
            resolve(result);
          },
          reject,
          timestamp: Date.now(),
        };
        session.pendingRequests.set(requestId, pending);

        // Call the UI callback
        if (requestCallback) {
          requestCallback(pending);
        } else {
          // Auto-reject if no callback set
          reject(new Error("Wallet not ready - no approval handler registered"));
        }
      });
    }

    case "eth_accounts": {
      // Return empty if not connected, addresses if connected
      return session.connected && session.account ? [session.account.address] : [];
    }

    case "eth_sendTransaction":
    case "personal_sign":
    case "eth_signTypedData_v4": {
      // These require explicit approval per request
      return new Promise((resolve, reject) => {
        const pending: PendingRequest = {
          id: requestId,
          method,
          params,
          origin,
          resolve,
          reject,
          timestamp: Date.now(),
        };
        session.pendingRequests.set(requestId, pending);

        if (requestCallback) {
          requestCallback(pending);
        } else {
          reject(new Error("Wallet not ready - no approval handler registered"));
        }
      });
    }

    case "wallet_switchEthereumChain": {
      const chainId = (params?.[0] as { chainId: string })?.chainId;
      if (chainId) {
        const newChain = getChain(chainId);
        session.chain = newChain;
        // Emit chain change event to page
        // (would need to implement event emission via page.evaluate)
      }
      return null;
    }

    case "wallet_getPermissions":
      return [];

    case "wallet_requestPermissions":
      return [{ parentCapability: "eth_accounts" }];

    default: {
      // Pass through to RPC
      if (!session.account) {
        throw new Error("No account configured");
      }

      const client = createWalletClient({
        account: session.account,
        chain: session.chain,
        transport: session.transports[session.chain.id] ?? http(),
      });

      return await client.request({
        method: method as any,
        params: params as any,
      });
    }
  }
}

// Called by the extension to set up the approval handler
export function setRequestHandler(
  handler: (request: PendingRequest) => Promise<unknown>
): void {
  requestCallback = handler;
}

// Get pending requests for a session
export function getPendingRequests(sessionId: string): PendingRequest[] {
  const session = walletSessions.get(sessionId);
  if (!session) return [];
  return Array.from(session.pendingRequests.values());
}

// Approve a pending request
export async function approveRequest(
  sessionId: string,
  requestId: string,
  result?: unknown
): Promise<{ success: true; result: unknown } | { success: false; error: string }> {
  const session = walletSessions.get(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  const request = session.pendingRequests.get(requestId);
  if (!request) {
    return { success: false, error: "Request not found - may have been already handled" };
  }

  session.pendingRequests.delete(requestId);

  try {
    if (request.method === "eth_requestAccounts") {
      const addresses = session.account ? [session.account.address] : [];
      request.resolve(addresses);
      return { success: true, result: addresses };
    } else if (request.method === "eth_sendTransaction" && session.account) {
      // Sign and send the transaction
      const txParams = request.params?.[0] as any;
      const client = createWalletClient({
        account: session.account,
        chain: session.chain,
        transport: session.transports[session.chain.id] ?? http(),
      });
      const hash = await client.sendTransaction({
        to: txParams.to,
        data: txParams.data,
        value: txParams.value ? BigInt(txParams.value) : undefined,
      });
      request.resolve(hash);
      return { success: true, result: hash };
    } else if (request.method === "personal_sign" && session.account) {
      const message = request.params?.[0] as Hex;
      const signature = await session.account.signMessage({
        message: { raw: message },
      });
      request.resolve(signature);
      return { success: true, result: signature };
    } else {
      request.resolve(result);
      return { success: true, result };
    }
  } catch (e) {
    // Extract a clean error message for the dApp
    const errorMessage = e instanceof Error ? e.message : String(e);
    
    // Reject the dApp's promise with a clean error
    request.reject(new Error(errorMessage));
    
    // Return failure so the tool can report it properly
    return { success: false, error: errorMessage };
  }
}

// Reject a pending request - returns success/failure instead of throwing
export function rejectRequest(
  sessionId: string,
  requestId: string,
  reason?: string
): { success: true } | { success: false; error: string } {
  const session = walletSessions.get(sessionId);
  if (!session) {
    return { success: false, error: "Session not found" };
  }

  const request = session.pendingRequests.get(requestId);
  if (!request) {
    return { success: false, error: "Request not found - may have been already handled" };
  }

  session.pendingRequests.delete(requestId);
  request.reject(new Error(reason ?? "User rejected request"));
  return { success: true };
}

// Update session with new account
export function setSessionAccount(
  sessionId: string,
  account: LocalAccount
): void {
  const session = walletSessions.get(sessionId);
  if (session) {
    session.account = account;
  }
}

// Get session status
export function getSessionStatus(sessionId: string): {
  connected: boolean;
  address: string | undefined;
  chainId: number;
  pendingCount: number;
} | null {
  const session = walletSessions.get(sessionId);
  if (!session) return null;
  return {
    connected: session.connected,
    address: session.account?.address,
    chainId: session.chain.id,
    pendingCount: session.pendingRequests.size,
  };
}

// Clean up session
export function removeSession(sessionId: string): void {
  walletSessions.delete(sessionId);
}

function getChain(chainIdHex?: string): Chain {
  if (!chainIdHex) return chains.mainnet;
  const chainId = parseInt(chainIdHex, 16);
  for (const chain of Object.values(chains)) {
    if ("id" in chain && chain.id === chainId) {
      return chain;
    }
  }
  return chains.mainnet;
}

// Type definitions for EIP standards
interface EIP6963ProviderInfo {
  uuid: string;
  name: string;
  icon: string;
  rdns: string;
}

interface EIP1193Provider {
  request: (request: { method: string; params?: unknown[] }) => Promise<unknown>;
  on: (event: string, listener: (...args: any[]) => void) => void;
  removeListener: (event: string, listener: (...args: any[]) => void) => void;
  emit?: (event: string, ...args: any[]) => void;
}

interface EIP6963ProviderDetail {
  info: EIP6963ProviderInfo;
  provider: EIP1193Provider;
}
