/**
 * Lit Protocol v8 (Naga) Integration
 *
 * Provides secure, distributed key management for HyperClaw trading agents using
 * Programmable Key Pairs (PKPs). PKPs eliminate single-point-of-failure risks by
 * distributing key shares across Lit's threshold cryptography network.
 *
 * Key benefits:
 * - Private keys never exist in full form (distributed via MPC)
 * - Threshold signing requires >2/3 of network nodes
 * - Trading rules enforced at cryptographic layer via Lit Actions
 * - Non-custodial: no single entity holds full key
 *
 * v8 Changes from v7:
 * - Uses createLitClient() instead of LitNodeClient.connect()
 * - Uses authContext instead of sessionSigs
 * - Lit Actions access params via jsParams.* (not globals)
 * - Networks: nagaDev, nagaTest, naga (mainnet)
 */

import { createLitClient, type LitClient } from "@lit-protocol/lit-client";
import { nagaDev, nagaTest, naga } from "@lit-protocol/networks";
import { createAuthManager, storagePlugins } from "@lit-protocol/auth";
import { privateKeyToAccount } from "viem/accounts";
import { AUTH_METHOD_SCOPE, AUTH_METHOD_TYPE } from "@lit-protocol/constants";
import { type Address, getAddress, keccak256, stringToBytes } from "viem";
import * as os from "os";
import * as path from "path";

// ============================================
// Types
// ============================================

export interface LitConfig {
  network: "naga-dev" | "naga-test" | "naga";
  debug?: boolean;
}

export interface PKPInfo {
  tokenId: string;
  publicKey: string;
  ethAddress: Address;
}

export interface MintedPKP extends PKPInfo {
  txHash: string;
}

export interface TradingConstraints {
  maxPositionSizeUsd: number;
  allowedCoins: string[];
  maxLeverage: number;
  requireStopLoss: boolean;
  maxDailyTrades: number;
  cooldownMs: number;
}

export interface LitActionResult {
  response?: string;
  signatures?: Record<string, { signature: string; publicKey: string; recid: number }>;
  logs?: string;
}

// ============================================
// Network Configuration
// ============================================

function getNetworkModule(networkName: string) {
  switch (networkName) {
    case "naga-dev":
    case "datil-dev":
      return nagaDev;
    case "naga-test":
    case "datil-test":
      return nagaTest;
    case "naga":
    case "datil":
      return naga;
    default:
      return nagaDev;
  }
}

// ============================================
// Singleton Lit Client
// ============================================

let litClient: LitClient | null = null;
let authManager: ReturnType<typeof createAuthManager> | null = null;
const ensuredPkpSignScope = new Set<string>();

const DEFAULT_CONFIG: LitConfig = {
  network: "naga-dev",
  debug: false,
};

/**
 * Get or initialize the Lit Client (v8)
 */
export async function getLitClient(
  config: Partial<LitConfig> = {}
): Promise<LitClient> {
  const networkName = config.network || process.env.LIT_NETWORK || DEFAULT_CONFIG.network;

  if (litClient) {
    return litClient;
  }

  const network = getNetworkModule(networkName);

  litClient = await createLitClient({
    network,
  });

  console.log(`[Lit] Connected to ${networkName} network`);

  return litClient;
}

/**
 * Get or initialize the Auth Manager
 */
export function getAuthManager() {
  if (authManager) {
    return authManager;
  }

  const networkName = process.env.LIT_NETWORK || DEFAULT_CONFIG.network;
  const storagePath = path.join(os.tmpdir(), "hyperclaw-lit");

  authManager = createAuthManager({
    storage: storagePlugins.localStorageNode({
      appName: "hyperclaw",
      networkName,
      storagePath,
    }),
  });

  return authManager;
}

/**
 * Disconnect and cleanup Lit client
 */
export function disconnectLit(): void {
  if (litClient) {
    litClient.disconnect();
    litClient = null;
  }
  authManager = null;
  console.log("[Lit] Disconnected");
}

// ============================================
// PKP Management
// ============================================

/**
 * Get operator account from environment
 */
export function getOperatorAccount() {
  const privateKey = process.env.LIT_OPERATOR_PRIVATE_KEY || process.env.HYPERLIQUID_PRIVATE_KEY;
  if (!privateKey) {
    throw new Error("LIT_OPERATOR_PRIVATE_KEY or HYPERLIQUID_PRIVATE_KEY not set");
  }
  return privateKeyToAccount(privateKey as `0x${string}`);
}

type PkpIdentifier = { tokenId: string } | { pubkey: string } | { address: string };

function buildPkpIdentifier(params: {
  tokenId?: string;
  pubkey?: string;
  address?: string;
}): PkpIdentifier {
  if (params.tokenId) return { tokenId: params.tokenId };
  if (params.pubkey) return { pubkey: params.pubkey };
  if (params.address) return { address: params.address };
  throw new Error("PKP identifier is required");
}

function toPkpIdentifierKey(identifier: PkpIdentifier): string {
  if ("tokenId" in identifier) return `token:${identifier.tokenId}`;
  if ("pubkey" in identifier) return `pubkey:${identifier.pubkey}`;
  return `address:${identifier.address}`;
}

function getEthWalletAuthMethodId(address: string): `0x${string}` {
  const checksumAddress = getAddress(address);
  const messageBytes = stringToBytes(`${checksumAddress}:lit`);
  return keccak256(messageBytes);
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function isNotPkpNftOwnerError(error: unknown): boolean {
  const message = getErrorMessage(error).toLowerCase();
  return message.includes("not pkp nft owner");
}

function formatPkpOwnerMismatchError(identifierKey: string, operatorAddress: string): string {
  return `[Lit] PKP ownership mismatch for ${identifierKey}: operator ${operatorAddress} is not the PKP NFT owner. Set LIT_OPERATOR_PRIVATE_KEY (or HYPERLIQUID_PRIVATE_KEY) to the PKP owner key, or reprovision the agent PKP.`;
}

async function operatorOwnsPkp(
  client: LitClient,
  operatorAddress: Address,
  identifier: PkpIdentifier
): Promise<boolean | null> {
  try {
    const ownedPkps = await client.viewPKPsByAddress({
      ownerAddress: operatorAddress,
    });
    return ownedPkps.some((pkp: { tokenId: bigint; pubkey: string; ethAddress: string }) => {
      if ("tokenId" in identifier) {
        return String(pkp.tokenId) === identifier.tokenId;
      }
      if ("pubkey" in identifier) {
        return pkp.pubkey.toLowerCase() === identifier.pubkey.toLowerCase();
      }
      return pkp.ethAddress.toLowerCase() === identifier.address.toLowerCase();
    });
  } catch (error) {
    console.warn(
      `[Lit] Failed to preflight PKP ownership check: ${getErrorMessage(error).slice(0, 200)}`
    );
    return null;
  }
}

export async function ensureOperatorPkpSignScope(params: {
  tokenId?: string;
  pubkey?: string;
  address?: string;
}): Promise<void> {
  const identifier = buildPkpIdentifier(params);
  const identifierKey = toPkpIdentifierKey(identifier);
  if (ensuredPkpSignScope.has(identifierKey)) {
    return;
  }

  const client = await getLitClient();
  const account = getOperatorAccount();
  const authMethodId = getEthWalletAuthMethodId(account.address);
  const ownershipErrorMessage = formatPkpOwnerMismatchError(identifierKey, account.address);

  const permissionsManager = await client.getPKPPermissionsManager({
    pkpIdentifier: identifier,
    account,
  });
  const permissions = await permissionsManager.getPermissionsContext();

  const operatorAuthMethod = permissions.authMethods.find(
    (method: { authMethodType: bigint; id: string; scopes?: string[] }) =>
      Number(method.authMethodType) === AUTH_METHOD_TYPE.EthWallet &&
      method.id.toLowerCase() === authMethodId.toLowerCase()
  );

  if (!operatorAuthMethod) {
    const ownsPkp = await operatorOwnsPkp(client, account.address, identifier);
    if (ownsPkp === false) {
      throw new Error(ownershipErrorMessage);
    }

    try {
      await permissionsManager.addPermittedAuthMethod({
        authMethodType: AUTH_METHOD_TYPE.EthWallet,
        authMethodId,
        userPubkey: "0x",
        scopes: ["sign-anything"],
      });
    } catch (error) {
      if (isNotPkpNftOwnerError(error)) {
        throw new Error(ownershipErrorMessage);
      }
      throw error;
    }
    console.log(`[Lit] Added EthWallet auth method with sign-anything scope for ${identifierKey}`);
    ensuredPkpSignScope.add(identifierKey);
    return;
  }

  const hasSignAnything = operatorAuthMethod.scopes?.includes("sign-anything") ?? false;
  if (!hasSignAnything) {
    const ownsPkp = await operatorOwnsPkp(client, account.address, identifier);
    if (ownsPkp === false) {
      throw new Error(ownershipErrorMessage);
    }

    try {
      await permissionsManager.addPermittedAuthMethodScope({
        authMethodType: AUTH_METHOD_TYPE.EthWallet,
        authMethodId,
        scopeId: AUTH_METHOD_SCOPE.SignAnything,
      });
    } catch (error) {
      if (isNotPkpNftOwnerError(error)) {
        throw new Error(ownershipErrorMessage);
      }
      throw error;
    }
    console.log(`[Lit] Added sign-anything scope for existing EthWallet auth method on ${identifierKey}`);
  }

  ensuredPkpSignScope.add(identifierKey);
}

/**
 * Create auth context for the operator
 */
export async function getOperatorAuthContext(params?: {
  tokenId?: string;
  pubkey?: string;
  address?: string;
}) {
  const client = await getLitClient();
  const manager = getAuthManager();
  const account = getOperatorAccount();

  if (params?.tokenId || params?.pubkey || params?.address) {
    await ensureOperatorPkpSignScope(params);
  }

  const authContext = await manager.createEoaAuthContext({
    config: { account },
    authConfig: {
      domain: "hyperclaw.xyz",
      statement: "HyperClaw PKP Authorization",
      resources: [
        ["lit-action-execution", "*"],
        ["pkp-signing", "*"],
      ],
      expiration: new Date(Date.now() + 60 * 60 * 1000).toISOString(), // 1 hour
    },
    litClient: client,
  });

  return authContext;
}

/**
 * Mint a new PKP for an agent
 *
 * This creates a new distributed wallet where:
 * - The private key is generated via DKG (distributed key generation)
 * - Each Lit node holds only a key share
 * - No single entity ever has the full private key
 */
export async function mintPKP(): Promise<MintedPKP> {
  const client = await getLitClient();
  const account = getOperatorAccount();

  console.log("[Lit] Minting new PKP...");

  const mintResult = await client.mintWithEoa({
    account,
  });

  const pkpData = mintResult.data;
  const pkp: MintedPKP = {
    tokenId: String(pkpData.tokenId),
    publicKey: pkpData.pubkey,
    ethAddress: pkpData.ethAddress as Address,
    txHash: mintResult.txHash,
  };

  await ensureOperatorPkpSignScope({ tokenId: pkp.tokenId });
  console.log(`[Lit] PKP minted: ${pkp.ethAddress}`);

  return pkp;
}

/**
 * Get all PKPs owned by the operator
 */
export async function getOperatorPKPs(): Promise<PKPInfo[]> {
  const client = await getLitClient();
  const account = getOperatorAccount();

  const pkps = await client.viewPKPsByAddress({
    ownerAddress: account.address,
  });

  return pkps.map((p: { tokenId: bigint; pubkey: string; ethAddress: string }) => ({
    tokenId: String(p.tokenId),
    publicKey: p.pubkey,
    ethAddress: p.ethAddress as Address,
  }));
}

// ============================================
// Lit Action Execution
// ============================================

/**
 * Execute a Lit Action with trading constraints
 */
export async function executeLitAction(params: {
  code?: string;
  ipfsId?: string;
  jsParams: Record<string, unknown>;
}): Promise<LitActionResult> {
  const client = await getLitClient();
  const pkpPublicKey =
    typeof params.jsParams?.pkpPublicKey === "string" ? params.jsParams.pkpPublicKey : undefined;
  const authContext = await getOperatorAuthContext(
    pkpPublicKey ? { pubkey: pkpPublicKey } : undefined
  );

  const result = await client.executeJs({
    ...(params.ipfsId ? { ipfsId: params.ipfsId } : { code: params.code }),
    authContext,
    jsParams: params.jsParams,
  });

  return {
    response: result.response as string,
    signatures: result.signatures as Record<string, { signature: string; publicKey: string; recid: number }>,
    logs: result.logs,
  };
}

// ============================================
// PKP Signing (v8 API)
// ============================================

/**
 * Sign a message using PKP via chain-specific API
 */
export async function signWithPKP(params: {
  pkpPublicKey: string;
  toSign: Uint8Array;
}): Promise<{ signature: string; recid: number }> {
  const client = await getLitClient();
  const authContext = await getOperatorAuthContext({ pubkey: params.pkpPublicKey });

  const result = await client.chain.ethereum.pkpSign({
    pubKey: params.pkpPublicKey,
    toSign: params.toSign,
    authContext,
  });

  const resultWithRecovery = result as {
    signature: string;
    recid?: number;
    recoveryId?: number;
  };

  return {
    signature: resultWithRecovery.signature,
    recid: resultWithRecovery.recid ?? resultWithRecovery.recoveryId ?? 0,
  };
}

// ============================================
// Trading Constraints
// ============================================

/**
 * Default trading constraints for new agents
 */
export const DEFAULT_TRADING_CONSTRAINTS: TradingConstraints = {
  maxPositionSizeUsd: 10000,
  allowedCoins: ["BTC", "ETH", "SOL", "ARB", "AVAX", "DOGE", "MATIC", "LINK"],
  maxLeverage: 10,
  requireStopLoss: true,
  maxDailyTrades: 50,
  cooldownMs: 60000, // 1 minute between trades
};

/**
 * Generate the Lit Action code for secure trading (v8 format)
 *
 * Note: In v8, params are accessed via jsParams.* (not as globals)
 */
export function generateTradingLitAction(constraints: TradingConstraints): string {
  return `
(async () => {
  try {
    // Trading constraints (immutable - baked into the Lit Action)
    const CONSTRAINTS = ${JSON.stringify(constraints)};
    
    // Parse the order parameters from jsParams (v8 format)
    const order = JSON.parse(jsParams.orderParams);
    const errors = [];
    
    // ========================================
    // Constraint Validation
    // ========================================
    
    // 1. Check allowed coins
    if (!CONSTRAINTS.allowedCoins.includes(order.coin)) {
      errors.push(\`Coin '\${order.coin}' not in allowed list\`);
    }
    
    // 2. Check position size
    const positionValueUsd = parseFloat(order.size || 0) * parseFloat(order.price || 0);
    if (positionValueUsd > CONSTRAINTS.maxPositionSizeUsd) {
      errors.push(\`Position $\${positionValueUsd.toFixed(2)} exceeds max $\${CONSTRAINTS.maxPositionSizeUsd}\`);
    }
    
    // 3. Check leverage
    if (order.leverage && order.leverage > CONSTRAINTS.maxLeverage) {
      errors.push(\`Leverage \${order.leverage}x exceeds max \${CONSTRAINTS.maxLeverage}x\`);
    }
    
    // 4. Require stop loss if configured
    if (CONSTRAINTS.requireStopLoss && !order.reduceOnly && !order.stopLoss) {
      errors.push("Stop loss is required");
    }
    
    // 5. Timestamp freshness (prevent replay attacks)
    const now = Date.now();
    const maxAge = 120000; // 2 minutes
    if (order.timestamp && Math.abs(now - order.timestamp) > maxAge) {
      errors.push("Order timestamp expired");
    }
    
    // ========================================
    // Return Error if Validation Failed
    // ========================================
    
    if (errors.length > 0) {
      Lit.Actions.setResponse({
        response: JSON.stringify({
          success: false,
          errors,
          constraints: CONSTRAINTS,
        }),
      });
      return;
    }
    
    // ========================================
    // Sign the Order
    // ========================================
    
    const orderMessage = {
      ...order,
      validatedAt: Date.now(),
    };
    
    const messageString = JSON.stringify(orderMessage, Object.keys(orderMessage).sort());
    const messageBytes = new TextEncoder().encode(messageString);
    const hashBuffer = await crypto.subtle.digest('SHA-256', messageBytes);
    const toSign = new Uint8Array(hashBuffer);
    
    // Sign using the PKP
    const sigShare = await Lit.Actions.signEcdsa({
      toSign,
      publicKey: jsParams.pkpPublicKey,
      sigName: "hyperliquidOrder",
    });
    
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: true,
        orderMessage,
        signedAt: Date.now(),
      }),
    });
    
  } catch (error) {
    Lit.Actions.setResponse({
      response: JSON.stringify({
        success: false,
        errors: [error.message || "Unknown error in Lit Action"],
      }),
    });
  }
})();
`;
}
