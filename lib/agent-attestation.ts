import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { evmMainnet, evmTestnet } from "@/lib/chains";
import { buildEvmExplorerTxUrl } from "@/lib/monad-vision";
import { getAgent, updateAgent } from "@/lib/store";
import { getNetworkState } from "@/lib/network";
import type { Agent, AgentOnchainAttestation } from "@/lib/types";

type DeploymentNetwork = "mainnet" | "testnet";

interface AttestationEnvelope {
  version: "hyperclaw-agent-attestation-v1";
  kind: "hyperclaw_agent";
  agent_id: string;
  handle: string;
  metadata_hash: Hex;
  metadata_uri: string | null;
}

export interface EnsureAgentAttestationOptions {
  force?: boolean;
  reason?: "agent_create" | "status_activate" | "aip_register" | "manual";
}

export interface EnsureAgentAttestationResult {
  agent: Agent;
  attestation: AgentOnchainAttestation | null;
  skipped: boolean;
  reason?: string;
}

const ATTESTATION_VERSION = "hyperclaw-agent-attestation-v1";

function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw.trim() === "") return fallback;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function isAttestationEnabled(): boolean {
  return parseBool(
    process.env.EVM_AGENT_ATTESTATION_ENABLED ?? process.env.MONAD_AGENT_ATTESTATION_ENABLED,
    true
  );
}

function isAttestationRequired(): boolean {
  const defaultRequired = process.env.NODE_ENV === "production";
  return parseBool(
    process.env.EVM_AGENT_ATTESTATION_REQUIRED ?? process.env.MONAD_AGENT_ATTESTATION_REQUIRED,
    defaultRequired
  );
}

function getAttestorPrivateKey(): Hex | null {
  const raw =
    process.env.AIP_ATTESTATION_PRIVATE_KEY ||
    process.env.RELAY_EVM_PRIVATE_KEY ||
    process.env.EVM_PRIVATE_KEY ||
    process.env.RELAY_MONAD_PRIVATE_KEY ||
    process.env.MONAD_PRIVATE_KEY ||
    "";
  const value = raw.trim();
  if (!/^0x[a-fA-F0-9]{64}$/.test(value)) return null;
  return value as Hex;
}

function getMetadataUri(): string | undefined {
  const raw = process.env.AIP_AGENT_METADATA_BASE_URI;
  if (!raw) return undefined;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || undefined;
}

function getAgentNetwork(agent: Agent): DeploymentNetwork {
  const tagged = agent.autonomy?.deploymentNetwork;
  if (tagged === "mainnet" || tagged === "testnet") return tagged;
  return getNetworkState().evmTestnet ? "testnet" : "mainnet";
}

function resolveRpcUrl(network: DeploymentNetwork): string {
  if (network === "mainnet") {
    return (
      process.env.EVM_MAINNET_RPC_URL ||
      process.env.NEXT_PUBLIC_EVM_MAINNET_RPC_URL ||
      process.env.MONAD_MAINNET_RPC_URL ||
      process.env.NEXT_PUBLIC_MONAD_MAINNET_RPC_URL ||
      evmMainnet.rpcUrls.default.http[0]
    );
  }
  return (
    process.env.EVM_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_EVM_TESTNET_RPC_URL ||
    process.env.MONAD_TESTNET_RPC_URL ||
    process.env.NEXT_PUBLIC_MONAD_TESTNET_RPC_URL ||
    evmTestnet.rpcUrls.default.http[0]
  );
}

function normalizeAddress(value: string | undefined): Address | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return null;
  return trimmed as Address;
}

function buildMetadataPayload(agent: Agent) {
  return {
    version: ATTESTATION_VERSION,
    agentId: agent.id,
    name: agent.name,
    description: agent.description,
    createdAt: agent.createdAt,
    status: agent.status,
    markets: agent.markets,
    maxLeverage: agent.maxLeverage,
    riskLevel: agent.riskLevel,
    stopLossPercent: agent.stopLossPercent,
    autonomy: {
      mode: agent.autonomy.mode,
      aggressiveness: agent.autonomy.aggressiveness,
      minConfidence: agent.autonomy.minConfidence ?? null,
      maxTradesPerDay: agent.autonomy.maxTradesPerDay,
      approvalTimeoutMs: agent.autonomy.approvalTimeoutMs,
      deploymentNetwork: agent.autonomy.deploymentNetwork ?? null,
    },
    owner: {
      privyId: agent.telegram?.ownerPrivyId ?? null,
      walletAddress: agent.telegram?.ownerWalletAddress ?? null,
    },
    hlAddress: agent.hlAddress,
    handle: `hyperclaw_${agent.id.slice(0, 8)}`,
  };
}

function computeMetadataHash(agent: Agent): Hex {
  const payload = buildMetadataPayload(agent);
  return keccak256(stringToHex(JSON.stringify(payload)));
}

function buildAttestationEnvelope(agent: Agent, metadataHash: Hex): AttestationEnvelope {
  return {
    version: ATTESTATION_VERSION,
    kind: "hyperclaw_agent",
    agent_id: agent.id,
    handle: `hyperclaw_${agent.id.slice(0, 8)}`,
    metadata_hash: metadataHash,
    metadata_uri: getMetadataUri() ? `${getMetadataUri()}/${agent.id}` : null,
  };
}

function buildAttestationData(agent: Agent, metadataHash: Hex): Hex {
  const envelope = buildAttestationEnvelope(agent, metadataHash);
  return stringToHex(JSON.stringify(envelope));
}

function buildExplorerUrl(network: DeploymentNetwork, txHash: Hex): string {
  return buildEvmExplorerTxUrl(txHash, network);
}

function hasFreshAttestation(
  agent: Agent,
  metadataHash: Hex,
  chainId: number
): agent is Agent & { aipAttestation: AgentOnchainAttestation } {
  if (!agent.aipAttestation) return false;
  return (
    agent.aipAttestation.status === "confirmed" &&
    agent.aipAttestation.metadataHash.toLowerCase() === metadataHash.toLowerCase() &&
    agent.aipAttestation.chainId === chainId
  );
}

export async function ensureAgentOnchainAttestation(
  agentId: string,
  options?: EnsureAgentAttestationOptions
): Promise<EnsureAgentAttestationResult> {
  const agent = await getAgent(agentId);
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  if (!isAttestationEnabled()) {
    return { agent, attestation: agent.aipAttestation ?? null, skipped: true, reason: "disabled" };
  }

  const required = isAttestationRequired();
  const privateKey = getAttestorPrivateKey();
  if (!privateKey) {
    if (required) {
      throw new Error(
        "EVM attestation is required but AIP_ATTESTATION_PRIVATE_KEY/RELAY_EVM_PRIVATE_KEY/EVM_PRIVATE_KEY is not configured."
      );
    }
    return { agent, attestation: agent.aipAttestation ?? null, skipped: true, reason: "missing_private_key" };
  }

  const network = getAgentNetwork(agent);
  const chain = network === "mainnet" ? evmMainnet : evmTestnet;
  const metadataHash = computeMetadataHash(agent);

  if (!options?.force && hasFreshAttestation(agent, metadataHash, chain.id)) {
    return { agent, attestation: agent.aipAttestation, skipped: true, reason: "already_attested" };
  }

  const account = privateKeyToAccount(privateKey);
  const rpcUrl = resolveRpcUrl(network);
  const sinkOverride = normalizeAddress(process.env.AIP_ATTESTATION_SINK_ADDRESS);
  if (process.env.AIP_ATTESTATION_SINK_ADDRESS && !sinkOverride) {
    throw new Error("AIP_ATTESTATION_SINK_ADDRESS is not a valid 0x address");
  }
  const sink = sinkOverride ?? account.address;
  const data = buildAttestationData(agent, metadataHash);

  const timeoutRaw = Number.parseInt(process.env.AIP_ATTESTATION_RECEIPT_TIMEOUT_MS || "180000", 10);
  const receiptTimeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 180000;

  const walletClient = createWalletClient({
    account,
    chain,
    transport: http(rpcUrl),
  });
  const publicClient = createPublicClient({
    chain,
    transport: http(rpcUrl),
  });

  const txHash = await walletClient.sendTransaction({
    account,
    to: sink,
    value: BigInt(0),
    data,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash: txHash,
    confirmations: 1,
    timeout: receiptTimeoutMs,
  });

  if (receipt.status !== "success") {
    throw new Error(`EVM attestation tx reverted for agent ${agent.id}: ${txHash}`);
  }

  const metadataUri = getMetadataUri() ? `${getMetadataUri()}/${agent.id}` : undefined;
  const attestation: AgentOnchainAttestation = {
    version: ATTESTATION_VERSION,
    status: "confirmed",
    method: "evm_tx_calldata",
    txHash,
    blockNumber: Number(receipt.blockNumber),
    chainId: chain.id,
    network,
    attestedAt: Date.now(),
    metadataHash,
    metadataUri,
    attestor: account.address,
    explorerUrl: buildExplorerUrl(network, txHash),
  };

  const updated = await updateAgent(agent.id, { aipAttestation: attestation });
  if (!updated) {
    throw new Error(`Attestation succeeded but failed to persist agent ${agent.id}`);
  }

  console.log(
    `[Attestation] Agent ${agent.id} attested on EVM ${network} (${chain.id}) tx=${txHash} reason=${options?.reason || "unknown"}`
  );

  return {
    agent: updated,
    attestation,
    skipped: false,
  };
}
