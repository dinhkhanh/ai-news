import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";

const bucket = process.env.R2_BUCKET ?? "ai-news";
let client: S3Client | undefined;

function s3() {
  if (client) return client;
  const accountId = process.env.R2_ACCOUNT_ID;
  if (!accountId) throw new Error("R2_ACCOUNT_ID not set");
  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID!, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY! },
    forcePathStyle: true,
  });
  return client;
}

export async function download(key: string, toPath: string) {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  await pipeline(res.Body as Readable, createWriteStream(toPath));
  const { size } = await stat(toPath);
  return size;
}

export async function upload(fromPath: string, key: string, contentType: string) {
  const Body = await readFile(fromPath);
  await s3().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body, ContentType: contentType }));
  return key;
}
