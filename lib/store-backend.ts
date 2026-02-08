/**
 * Store Backend
 *
 * Abstraction for persistent storage used by store.ts and account-manager.ts.
 * Supports file (local dev) and S3 (production: Vercel + EC2).
 *
 * When AWS_S3_BUCKET is set, uses S3. Otherwise uses local .data/ directory.
 */

import { promises as fs } from "fs";
import path from "path";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";

const DATA_DIR = path.join(process.cwd(), ".data");
const S3_PREFIX = "hyperclaw";

let s3Client: S3Client | null = null;

function getS3Client(): S3Client {
  if (!s3Client) {
    const bucket = process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error("AWS_S3_BUCKET is required for S3 store");
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

function isS3Backend(): boolean {
  return !!process.env.AWS_S3_BUCKET;
}

export async function readJSON<T>(
  filename: string,
  defaultValue: T
): Promise<T> {
  if (isS3Backend()) {
    const client = getS3Client();
    const bucket = process.env.AWS_S3_BUCKET as string;
    const key = `${S3_PREFIX}/${filename}`;
    try {
      const res = await client.send(
        new GetObjectCommand({ Bucket: bucket, Key: key })
      );
      const body = await res.Body?.transformToString();
      if (!body) return defaultValue;
      return JSON.parse(body) as T;
    } catch (err) {
      const code = (err as { name?: string })?.name;
      if (code === "NoSuchKey") return defaultValue;
      throw err;
    }
  }

  // File backend
  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
  const filePath = path.join(DATA_DIR, filename);
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return defaultValue;
  }
}

export async function writeJSON<T>(filename: string, data: T): Promise<void> {
  if (isS3Backend()) {
    const client = getS3Client();
    const bucket = process.env.AWS_S3_BUCKET as string;
    const key = `${S3_PREFIX}/${filename}`;
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: JSON.stringify(data, null, 2),
        ContentType: "application/json",
      })
    );
    return;
  }

  try {
    await fs.mkdir(DATA_DIR, { recursive: true });
  } catch {}
  const filePath = path.join(DATA_DIR, filename);
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), "utf-8");
}
