import { type Address } from "viem";

// ============================================
// Agent Types
// ============================================

// ============================================
// Autonomy Modes
// ============================================

export type AutonomyMode = "full" | "semi" | "manual";

export interface AutonomyConfig {
  mode: AutonomyMode;
  // "full": agent trades on its own, notifies after
  // "semi": agent proposes trades, waits for user approval (via Telegram or UI)
  // "manual": user triggers every trade through UI

  // How aggressive the agent is between decisions (0-100)
  // 0 = only trades on very high conviction signals
  // 100 = trades on any signal above minimum confidence
  aggressiveness: number;

  // Minimum confidence threshold to act (0-1)
  // Derived from aggressiveness: minConfidence = 1 - (aggressiveness / 100) * 0.5
  // aggressiveness=0 -> minConfidence=1.0 (never trades)
  // aggressiveness=50 -> minConfidence=0.75
  // aggressiveness=100 -> minConfidence=0.5
  minConfidence?: number;

  // Max trades per day (safety limit)
  maxTradesPerDay: number;

  // Auto-approve timeout for semi mode (ms) - if not approved in time, skip
  approvalTimeoutMs: number;

  // Network partition used to scope agent lists at runtime.
  deploymentNetwork?: "testnet" | "mainnet";
}

// ============================================
// Telegram Config
// ============================================

export interface TelegramConfig {
  enabled: boolean;
  chatId: string; // user's Telegram chat ID (from /start command)
  ownerPrivyId?: string; // Privy user ID that owns this agent
  ownerWalletAddress?: Address; // Creator wallet address associated with ownerPrivyId
  // Notification preferences
  notifyOnTrade: boolean; // notify when agent executes or proposes a trade
  notifyOnPnl: boolean; // daily PnL summary
  notifyOnTierUnlock: boolean; // $HCLAW tier changes
}

// ============================================
// Vault Social Config
// ============================================

export interface VaultSocialConfig {
  isOpenVault: boolean; // can other users/agents join this vault?
  telegramGroupId?: string; // Telegram group chat for vault community
  telegramGroupInviteLink?: string; // invite link to the group
  // Chat room settings
  agentPostsTrades: boolean; // agent posts trade proposals to group
  allowDiscussion: boolean; // investors can discuss in group
  agentRespondsToQuestions: boolean; // agent answers investor questions via AI
}

export interface Agent {
  id: string;
  name: string;
  description: string;
  status: "active" | "paused" | "stopped";
  createdAt: number;
  // Trading config
  markets: string[]; // e.g. ["BTC", "ETH", "SOL"]
  maxLeverage: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  stopLossPercent: number;
  // Autonomy
  autonomy: AutonomyConfig;
  // Indicator-based trading
  indicator?: IndicatorConfig;
  // Telegram
  telegram?: TelegramConfig;
  // Vault social
  vaultSocial?: VaultSocialConfig;
  // Hyperliquid
  hlAddress: Address;
  hlVaultAddress?: Address;
  // Performance
  totalPnl: number;
  totalPnlPercent: number;
  totalTrades: number;
  winRate: number;
  // Vault
  vaultTvlUsd: number;
  depositorCount: number;
  // Pending approvals (for semi-autonomous mode)
  pendingApproval?: PendingTradeApproval;
  // Optional user API key override for this agent (encrypted)
  aiApiKey?: { provider: "anthropic" | "openai"; encryptedKey: string };
  // Monad on-chain metadata attestation for AIP/external verification.
  aipAttestation?: AgentOnchainAttestation;
}

export interface AgentOnchainAttestation {
  version: "hyperclaw-agent-attestation-v1";
  status: "confirmed";
  method: "monad_tx_calldata";
  txHash: `0x${string}`;
  blockNumber: number;
  chainId: number;
  network: "mainnet" | "testnet";
  attestedAt: number;
  metadataHash: `0x${string}`;
  metadataUri?: string;
  attestor: Address;
  explorerUrl?: string;
}

export interface PendingTradeApproval {
  id: string;
  decision: TradeDecision;
  proposedAt: number;
  expiresAt: number;
  telegramMessageId?: number;
  status: "pending" | "approved" | "rejected" | "expired";
}

export interface AgentConfig {
  name: string;
  description: string;
  markets: string[];
  maxLeverage: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  stopLossPercent: number;
  // New fields
  autonomy: AutonomyConfig;
  telegramChatId?: string;
  ownerPrivyId?: string;
  ownerWalletAddress?: Address;
  isOpenVault?: boolean;
}

// ============================================
// Trade Types
// ============================================

export interface TradeDecision {
  action: "long" | "short" | "close" | "hold";
  asset: string;
  size: number; // as percentage of available capital
  leverage: number;
  confidence: number; // 0-1
  reasoning: string;
  stopLoss?: number;
  takeProfit?: number;
}

export interface TradeLog {
  id: string;
  agentId: string;
  timestamp: number;
  decision: TradeDecision;
  executed: boolean;
  executionResult?: {
    orderId: string;
    fillPrice: number;
    fillSize: number;
    status: "filled" | "partial" | "rejected";
  };
}

// ============================================
// Vault Types
// ============================================

export interface VaultDeposit {
  agentId: string;
  user: Address;
  token: Address;
  tokenSymbol: string;
  amount: string;
  shares: string;
  timestamp: number;
  txHash: string;
}

export interface VaultPosition {
  agentId: string;
  user: Address;
  shares: string;
  totalShares: string;
  sharePercent: number;
  estimatedValueUsd: number;
  pnl: number;
  pnlPercent: number;
}

// ============================================
// $HCLAW Token Types
// ============================================

export interface HclawTier {
  tier: number;
  name: string;
  minMcap: number;
  maxDepositUsd: number;
}

export interface HclawState {
  tokenAddress: Address;
  price: number;
  marketCap: number;
  currentTier: HclawTier;
  nextTier: HclawTier | null;
  maxDepositPerVault: number;
  progressToNextTier: number; // 0-100
  lockTier?: HclawLockTier;
  hclawPower?: number;
  baseCapUsd?: number;
  boostedCapUsd?: number;
  capRemainingUsd?: number;
  rebateBps?: number;
  pointsThisEpoch?: number;
  claimableRebateUsd?: number;
  claimableIncentiveHclaw?: number;
}

export type HclawLockTier = 0 | 1 | 2 | 3;

export interface HclawLockPosition {
  lockId: string;
  amount: number;
  startTs: number;
  endTs: number;
  durationDays: number;
  multiplierBps: number;
  unlocked: boolean;
  remainingMs: number;
}

export interface HclawLockState {
  user: Address;
  tier: HclawLockTier;
  power: number;
  boostBps: number;
  rebateBps: number;
  lockIds: string[];
  positions: HclawLockPosition[];
}

export interface HclawCapContext {
  user: Address;
  baseCapUsd: number;
  boostedCapUsd: number;
  capRemainingUsd: number;
  boostBps: number;
  rebateBps: number;
  tier: HclawLockTier;
  power?: number;
}

export interface HclawPointBreakdown {
  lockPoints: number;
  lpPoints: number;
  refPoints: number;
  questPoints: number;
  totalPoints: number;
}

export interface HclawEpochInfo {
  epochId: string;
  startTs: number;
  endTs: number;
  status: "open" | "closing" | "closed";
  rootHash?: string | null;
}

export interface HclawRewardState {
  user: Address;
  epochId: string;
  rebateUsd: number;
  incentiveHclaw: number;
  claimed: boolean;
}

export interface HclawTreasuryFlow {
  ts: number;
  source: string;
  amountUsd: number;
  buybackUsd: number;
  incentiveUsd: number;
  reserveUsd: number;
  txHash?: string | null;
}

export interface AgenticVaultStatus {
  configured: boolean;
  paused: boolean;
  killSwitch: boolean;
  inventorySkewBps: number;
  dailyTurnoverBps: number;
  drawdownBps: number;
  maxInventorySkewBps: number;
  maxDailyTurnoverBps: number;
  maxDrawdownBps: number;
  cumulativeRealizedPnlUsd: number;
  lastExecutionTs: number;
}

export const HCLAW_TIERS: HclawTier[] = [
  { tier: 0, name: "Hatchling", minMcap: 0, maxDepositUsd: 100 },
  { tier: 1, name: "Hunter", minMcap: 1_000, maxDepositUsd: 1_000 },
  { tier: 2, name: "Striker", minMcap: 10_000, maxDepositUsd: 10_000 },
  { tier: 3, name: "Apex", minMcap: 50_000, maxDepositUsd: 100_000 },
];

// ============================================
// Vault Chat Messages
// ============================================

export interface VaultChatMessage {
  id: string;
  agentId: string;
  timestamp: number;
  sender: "agent" | "investor" | "system";
  senderName: string;
  senderId?: string; // telegram user id or wallet address
  type: "trade_proposal" | "trade_executed" | "discussion" | "question" | "ai_response" | "pnl_update";
  content: string;
  // For trade messages
  tradeDecision?: TradeDecision;
  // Telegram message ID for linking
  telegramMessageId?: number;
}

// ============================================
// Market Data Types
// ============================================

export interface MarketData {
  coin: string;
  price: number;
  change24h: number;
  volume24h: number;
  fundingRate: number;
  openInterest: number;
}

export interface PortfolioSummary {
  totalValueUsd: number;
  totalPnl: number;
  totalPnlPercent: number;
  activeAgents: number;
  totalDeposited: number;
  walletBalanceMon: number;
}

// ============================================
// Monad Token Config
// ============================================

export interface MonadToken {
  address: Address;
  symbol: string;
  name: string;
  decimals: number;
  logoURI?: string;
}

export const MONAD_TOKENS: MonadToken[] = [
  {
    address: "0x0000000000000000000000000000000000000000",
    symbol: "MON",
    name: "Monad",
    decimals: 18,
  },
  {
    address: "0xfBC2D240A5eD44231AcA3A9e9066bc4b33f01149",
    symbol: "USDT",
    name: "Tether USD",
    decimals: 6,
  },
];

// ============================================
// Streaming / Watcher Types
// ============================================

export interface StreamPosition {
  coin: string;
  size: number;
  entryPrice: number;
  positionValue: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  leverage: number;
  liquidationPrice: number | null;
  marginUsed: number;
  side: "long" | "short";
}

export interface StreamOrder {
  oid: number;
  coin: string;
  side: "buy" | "sell";
  price: number;
  size: number;
  originalSize: number;
  orderType: string;
  reduceOnly: boolean;
  timestamp: number;
}

export interface StreamBalance {
  totalEquity: number;
  availableBalance: number;
  marginUsed: number;
  unrealizedPnl: number;
  accountValue: number;
}

export interface StreamBookLevel {
  price: number;
  size: number;
  cumulative: number;
  percent: number; // percentage of total depth
}

export interface StreamBook {
  coin: string;
  bids: StreamBookLevel[];
  asks: StreamBookLevel[];
  spread: number;
  spreadPercent: number;
  midPrice: number;
}

export interface StreamPrice {
  coin: string;
  price: number;
  timestamp: number;
}

// ============================================
// Account Management Types
// ============================================

export interface HlAccount {
  alias: string;
  address: Address;
  type: "trading" | "readonly" | "pkp";
  isDefault: boolean;
  encryptedKey?: string; // encrypted private key, absent for readonly/pkp
  agentId?: string; // linked agent
  createdAt: number;
  // PKP-specific fields (for type === "pkp")
  pkp?: PKPAccountInfo;
}

/**
 * PKP (Programmable Key Pair) account info
 * Used for Lit Protocol distributed key management
 */
export interface PKPAccountInfo {
  tokenId: string; // NFT token ID on Lit Chronicle chain
  publicKey: string; // Compressed public key
  ethAddress: Address; // Derived Ethereum address (same as account.address)
  litActionCid?: string; // IPFS CID of the permitted Lit Action
  constraints?: PKPTradingConstraints; // Trading constraints enforced by Lit Action
}

/**
 * Trading constraints enforced at the cryptographic layer by Lit Actions
 */
export interface PKPTradingConstraints {
  maxPositionSizeUsd: number;
  allowedCoins: string[];
  maxLeverage: number;
  requireStopLoss: boolean;
  maxDailyTrades: number;
  cooldownMs: number;
}

// ============================================
// Indicator Configuration Types
// ============================================

export type IndicatorSignal = "bullish" | "bearish" | "neutral";

export interface IndicatorConfig {
  enabled: boolean;
  // The indicator name/type
  name: string;
  // Human-readable description
  description: string;
  // The Pine Script source code (for reference/documentation)
  pineScript?: string;
  // Key signal conditions from the indicator
  signals: {
    // What condition indicates bullish signal
    bullishCondition: string;
    // What condition indicates bearish signal
    bearishCondition: string;
  };
  // How much weight to give this indicator (0-100)
  weight: number;
  // Whether agent should strictly follow or use as guidance
  strictMode: boolean;
  // Custom parameters for the indicator
  parameters?: Record<string, number | string | boolean>;
}

// Pre-defined indicator templates
export const INDICATOR_TEMPLATES: Record<string, Omit<IndicatorConfig, "enabled" | "weight" | "strictMode">> = {
  "adaptive-rsi-divergence": {
    name: "Adaptive RSI with Divergence",
    description: "Gaussian-weighted RSI with real-time bullish/bearish divergence detection and trailing stops",
    signals: {
      bullishCondition: "RSI crosses above oversold (30) with bullish divergence (price makes lower low, RSI makes higher low), or RSI crosses above buy trigger level",
      bearishCondition: "RSI crosses below overbought (70) with bearish divergence (price makes higher high, RSI makes lower high), or RSI crosses below sell trigger level",
    },
    parameters: {
      rsiLength: 14,
      gaussianSigma: 3.0,
      signalLength: 9,
      buyTrigger: 20,
      sellTrigger: 80,
      enableDivergence: true,
      enableTrailingStop: true,
      trailingMultiplier: 3.0,
    },
  },
  "smart-money-concepts": {
    name: "Smart Money Concepts",
    description: "Institutional trading concepts including market structure (BOS/CHoCH), order blocks, fair value gaps, and liquidity zones",
    signals: {
      bullishCondition: "Bullish CHoCH (change of character) or BOS (break of structure), price in discount zone, bullish order block support, or bullish fair value gap",
      bearishCondition: "Bearish CHoCH or BOS, price in premium zone, bearish order block resistance, or bearish fair value gap",
    },
    parameters: {
      showInternalStructure: true,
      showSwingStructure: true,
      showOrderBlocks: true,
      showFairValueGaps: true,
      showPremiumDiscountZones: true,
      swingsLength: 50,
      orderBlockFilter: "ATR",
    },
  },
  "custom": {
    name: "Custom Indicator",
    description: "Define your own indicator signals and conditions",
    signals: {
      bullishCondition: "",
      bearishCondition: "",
    },
    parameters: {},
  },
};

// ============================================
// Strategy Testing Types
// ============================================

export interface StrategyConfig {
  name: string;
  markets: string[];
  maxLeverage: number;
  riskLevel: "conservative" | "moderate" | "aggressive";
  stopLossPercent: number;
  takeProfitPercent: number;
  tickIntervalMs: number;
  useTestnet: boolean;
}

export interface StrategyTestResult {
  id: string;
  config: StrategyConfig;
  startedAt: number;
  completedAt: number;
  ticks: number;
  trades: TradeLog[];
  finalPnl: number;
  finalPnlPercent: number;
  winRate: number;
  maxDrawdown: number;
  sharpeRatio: number;
}

// ============================================
// Order Types (extended)
// ============================================

export type OrderSide = "buy" | "sell" | "long" | "short";
export type OrderType = "limit" | "market" | "stop-loss" | "take-profit";
export type TimeInForce = "Gtc" | "Ioc" | "Alo";

export interface PlaceOrderParams {
  agentId?: string;
  coin: string;
  side: OrderSide;
  size: number;
  orderType: OrderType;
  price?: number; // required for limit
  triggerPrice?: number; // required for stop-loss / take-profit
  tif?: TimeInForce;
  reduceOnly?: boolean;
  slippagePercent?: number; // for market orders, default 1%
  isTpsl?: boolean; // attach as TP/SL to position
  vaultAddress?: Address;
}

export interface OrderConfig {
  defaultSlippagePercent: number;
  defaultTif: TimeInForce;
}

// ============================================
// Agent Runner Types
// ============================================

export interface AgentRunnerState {
  agentId: string;
  isRunning: boolean;
  lastTickAt: number | null;
  nextTickAt: number | null;
  tickCount: number;
  intervalMs: number;
  errors: Array<{ timestamp: number; message: string }>;
}

// ============================================
// Constants
// ============================================

export const HYPERLIQUID_API = "https://api.hyperliquid.xyz";
export const HYPERLIQUID_TESTNET_API = "https://api.hyperliquid-testnet.xyz";

export const NADFUN_CONFIG = {
  mainnet: {
    chainId: 143,
    apiUrl: "https://api.nadapp.net",
    dexFactory: "0x6B5F564339DbAD6b780249827f2198a841FEB7F3" as Address,
    wmon: "0x3bd359C1119dA7Da1D913D1C4D2B7c461115433A" as Address,
    bondingCurveRouter: "0x6F6B8F1a20703309951a5127c45B49b1CD981A22" as Address,
    lens: "0x7e78A8DE94f21804F7a17F4E8BF9EC2c872187ea" as Address,
    curve: "0xA7283d07812a02AFB7C09B60f8896bCEA3F90aCE" as Address,
    dexRouter: "0x0B79d71AE99528D1dB24A4148b5f4F865cc2b137" as Address,
  },
  testnet: {
    chainId: 10143,
    apiUrl: "https://dev-api.nad.fun",
    bondingCurveRouter: "0x865054F0F6A288adaAc30261731361EA7E908003" as Address,
    lens: "0xB056d79CA5257589692699a46623F901a3BB76f1" as Address,
    curve: "0x1228b0dc9481C11D3071E7A924B794CfB038994e" as Address,
  },
};
