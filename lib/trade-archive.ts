import { promises as fs } from "fs";
import path from "path";
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} from "@aws-sdk/client-s3";
import type { TradeLog } from "./types";

const DATA_DIR = path.join(process.cwd(), ".data");
const LOCAL_FILE = "trades.json";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error("AWS_S3_BUCKET is required for S3 trade archive");
    s3Client = new S3Client({
      region: process.env.AWS_REGION || "eu-north-1",
      ...(process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY
        ? {
            credentials: {
              accessKeyId: process.env.AWS_ACCESS_KEY_ID,
              secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
            },
          }
        : {}),
    });
  }
  return s3Client;
}

function isS3ArchiveEnabled(): boolean {
  return !!process.env.AWS_S3_BUCKET;
}

function archivePrefix(): string {
  return (process.env.TRADE_ARCHIVE_PREFIX || "hyperclaw/trades").replace(/\/$/, "");
}

function sortableTs(ts: number): string {
  return String(ts).padStart(13, "0");
}

async function readLocalTrades(): Promise<TradeLog[]> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}

  const filePath = path.join(DATA_DIR, LOCAL_FILE);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as TradeLog[];
  } catch {
    return [];
  }
}

async function writeLocalTrades(trades: TradeLog[]): Promise<void> {
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
  const filePath = path.join(DATA_DIR, LOCAL_FILE);
  await fs.writeFile(filePath, JSON.stringify(trades, null, 2), "utf-8");
}

async function listS3Keys(prefix: string, maxKeys: number): Promise<string[]> {
  const client = getS3Client();
  const bucket = process.env.AWS_S3_BUCKET as string;
  const keys: string[] = [];
  let continuationToken: string | undefined;

  while (keys.length < maxKeys) {
    const pageSize = Math.min(1000, maxKeys - keys.length);
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: pageSize,
      })
    );

    for (const obj of res.Contents || []) {
      if (obj.Key) keys.push(obj.Key);
      if (keys.length >= maxKeys) break;
    }

    if (!res.IsTruncated || !res.NextContinuationToken) break;
    continuationToken = res.NextContinuationToken;
  }

  return keys;
}

async function getTradeFromKey(key: string): Promise<TradeLog | null> {
  const client = getS3Client();
  const bucket = process.env.AWS_S3_BUCKET as string;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const body = await res.Body?.transformToString();
    if (!body) return null;
    return JSON.parse(body) as TradeLog;
  } catch {
    return null;
  }
}

export async function appendTradeToArchive(log: TradeLog): Promise<void> {
  if (!isS3ArchiveEnabled()) {
    const all = await readLocalTrades();
    all.push(log);
    const trimmed = all.slice(-5000);
    await writeLocalTrades(trimmed);
    return;
  }

  const client = getS3Client();
  const bucket = process.env.AWS_S3_BUCKET as string;
  const ts = sortableTs(log.timestamp);
  const base = `${ts}-${log.id}.json`;
  const prefix = archivePrefix();

  const byAgentKey = `${prefix}/by-agent/${log.agentId}/${base}`;
  const byTimeKey = `${prefix}/by-time/${base}`;
  const body = JSON.stringify(log);

  await Promise.all([
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: byAgentKey,
        Body: body,
        ContentType: "application/json",
      })
    ),
    client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: byTimeKey,
        Body: body,
        ContentType: "application/json",
      })
    ),
  ]);
}

export async function getTradesForAgentFromArchive(agentId: string): Promise<TradeLog[]> {
  if (!isS3ArchiveEnabled()) {
    const all = await readLocalTrades();
    return all.filter((t) => t.agentId === agentId);
  }

  const maxRead = parseInt(process.env.TRADE_ARCHIVE_AGENT_MAX_READ || "10000", 10);
  const prefix = `${archivePrefix()}/by-agent/${agentId}/`;
  const keys = await listS3Keys(prefix, maxRead);
  keys.sort();

  const trades = await Promise.all(keys.map((k) => getTradeFromKey(k)));
  return trades.filter((t): t is TradeLog => !!t);
}

export async function getRecentTradesFromArchive(limit: number): Promise<TradeLog[]> {
  if (!isS3ArchiveEnabled()) {
    const all = await readLocalTrades();
    return all.slice(-limit).reverse();
  }

  const maxRead = Math.max(limit * 5, 500);
  const prefix = `${archivePrefix()}/by-time/`;
  const keys = await listS3Keys(prefix, maxRead);
  keys.sort();
  const recentKeys = keys.slice(-limit).reverse();

  const trades = await Promise.all(recentKeys.map((k) => getTradeFromKey(k)));
  return trades.filter((t): t is TradeLog => !!t);
}

export async function deleteAgentTradesFromArchive(agentId: string): Promise<void> {
  if (!isS3ArchiveEnabled()) {
    const all = await readLocalTrades();
    const filtered = all.filter((t) => t.agentId !== agentId);
    await writeLocalTrades(filtered);
    return;
  }

  const client = getS3Client();
  const bucket = process.env.AWS_S3_BUCKET as string;
  const prefix = `${archivePrefix()}/by-agent/${agentId}/`;

  // Delete both by-agent and mirrored by-time objects for this agent.
  let continuationToken: string | undefined;
  do {
    const res = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      })
    );

    const objects = (res.Contents || []).flatMap((obj) => {
      if (!obj.Key) return [];
      const base = obj.Key.split("/").pop();
      if (!base) return [{ Key: obj.Key }];
      return [
        { Key: obj.Key },
        { Key: `${archivePrefix()}/by-time/${base}` },
      ];
    });

    if (objects.length > 0) {
      await client.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: { Objects: objects },
        })
      );
    }

    continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (continuationToken);
}
