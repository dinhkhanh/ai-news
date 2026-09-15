import "server-only";
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { env } from "@/lib/env";

let client: S3Client | undefined;

export function r2Endpoint() {
  const e = env();
  if (!e.R2_ACCOUNT_ID) throw new Error("R2_ACCOUNT_ID is not set");
  return `https://${e.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
}

export function r2() {
  if (client) return client;
  const e = env();
  if (!e.R2_ACCESS_KEY_ID || !e.R2_SECRET_ACCESS_KEY) throw new Error("R2 credentials are not set");
  client = new S3Client({
    region: "auto",
    endpoint: r2Endpoint(),
    credentials: { accessKeyId: e.R2_ACCESS_KEY_ID, secretAccessKey: e.R2_SECRET_ACCESS_KEY },
    forcePathStyle: true,
  });
  return client;
}

export const r2Bucket = () => env().R2_BUCKET;

/**
 * Key layout (lifecycle rules in infra/r2/lifecycle.json key off these prefixes):
 *   candidates/<org>/<project>/...   unused B-roll candidates, 7 d
 *   tmp/<org>/<project>/...          intermediates (VO, music, stems), 24 h
 *   timelines/<org>/<project>/...    superseded versions, 90 d
 *   renders/<org>/<project>/...      final renders, 12 mo unless pinned/
 *   pinned/<org>/<project>/...       never expires
 *   articles/<org>/<project>/...     snapshots, 12 mo
 *   media/<org>/<project>/...        selected B-roll, VO, music, mixes, 12 mo
 *   library/...                      music + brand assets, never expires
 */
export const r2Key = {
  candidate: (org: string, project: string, name: string) => `candidates/${org}/${project}/${name}`,
  tmp: (org: string, project: string, name: string) => `tmp/${org}/${project}/${name}`,
  render: (org: string, project: string, name: string) => `renders/${org}/${project}/${name}`,
  pinned: (org: string, project: string, name: string) => `pinned/${org}/${project}/${name}`,
  article: (org: string, project: string, name: string) => `articles/${org}/${project}/${name}`,
  media: (org: string, project: string, name: string) => `media/${org}/${project}/${name}`,
  library: (name: string) => `library/${name}`,
  test: (name: string) => `tmp/_test/${name}`,
};

export async function presignGet(key: string, expiresIn = 3600) {
  return getSignedUrl(r2(), new GetObjectCommand({ Bucket: r2Bucket(), Key: key }), { expiresIn });
}

export async function presignPut(key: string, contentType: string, expiresIn = 900) {
  return getSignedUrl(r2(), new PutObjectCommand({ Bucket: r2Bucket(), Key: key, ContentType: contentType }), {
    expiresIn,
  });
}

export async function putObject(key: string, body: Buffer | Uint8Array | string, contentType: string) {
  await r2().send(new PutObjectCommand({ Bucket: r2Bucket(), Key: key, Body: body, ContentType: contentType }));
  return key;
}

export async function headObject(key: string) {
  try {
    const res = await r2().send(new HeadObjectCommand({ Bucket: r2Bucket(), Key: key }));
    return { exists: true as const, size: res.ContentLength ?? 0, contentType: res.ContentType ?? null };
  } catch (err) {
    if ((err as { name?: string }).name === "NotFound") return { exists: false as const };
    throw err;
  }
}

export async function getObjectBuffer(key: string) {
  const res = await r2().send(new GetObjectCommand({ Bucket: r2Bucket(), Key: key }));
  if (!res.Body) throw new Error(`empty body for ${key}`);
  return Buffer.from(await res.Body.transformToByteArray());
}

/** Absolute URLs pass through; R2 keys become presigned GET URLs (Remotion Lambda fetches them). */
export async function resolveSrc(keyOrUrl: string, expiresIn = 3 * 3600) {
  return /^https?:\/\//.test(keyOrUrl) ? keyOrUrl : presignGet(keyOrUrl, expiresIn);
}

export async function copyObject(from: string, to: string) {
  await r2().send(new CopyObjectCommand({ Bucket: r2Bucket(), CopySource: `/${r2Bucket()}/${encodeURI(from)}`, Key: to }));
  return to;
}

export async function deleteObject(key: string) {
  await r2().send(new DeleteObjectCommand({ Bucket: r2Bucket(), Key: key }));
}
