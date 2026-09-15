/**
 * Deploy the Remotion Lambda function and the site bundle to ap-southeast-1.
 * Prints the env vars the web app needs. Idempotent: re-run after changing
 * compositions (the site name is versioned by package.json version).
 *
 *   REMOTION_AWS_ACCESS_KEY_ID=... REMOTION_AWS_SECRET_ACCESS_KEY=... pnpm --filter @ai-news/video lambda:deploy
 */
import { deployFunction, deploySite, getOrCreateBucket, getFunctions } from "@remotion/lambda";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const region = (process.env.AWS_REGION ?? "ap-southeast-1") as Parameters<typeof deployFunction>[0]["region"];
const MEMORY_MB = 2048;
const DISK_MB = 4096;
const TIMEOUT_S = 240;

async function main() {
  const existing = await getFunctions({ region, compatibleOnly: true });
  let functionName = existing[0]?.functionName;
  if (!functionName) {
    const fn = await deployFunction({
      region,
      memorySizeInMb: MEMORY_MB,
      diskSizeInMb: DISK_MB,
      timeoutInSeconds: TIMEOUT_S,
      createCloudWatchLogGroup: true,
      cloudWatchLogRetentionPeriodInDays: 14,
    });
    functionName = fn.functionName;
    console.log(`deployed function ${functionName} (${fn.alreadyExisted ? "existed" : "new"})`);
  } else {
    console.log(`using existing compatible function ${functionName}`);
  }

  const { bucketName } = await getOrCreateBucket({ region });
  const { serveUrl, siteName } = await deploySite({
    region,
    bucketName,
    siteName: `ai-news-v${pkg.version.replace(/\./g, "-")}`,
    entryPoint: path.resolve("src/index.ts"),
    options: {
      publicDir: path.resolve("public"),
      onBundleProgress: (p: number) => process.stdout.write(`\rbundling ${p}%`),
      onUploadProgress: ({ filesUploaded, totalFiles }: { filesUploaded: number; totalFiles: number }) =>
        process.stdout.write(`\ruploading ${filesUploaded}/${totalFiles}`),
    },
  });
  process.stdout.write("\n");

  console.log("\nAdd to Vercel env (apps/web):");
  console.log(`AWS_REGION=${region}`);
  console.log(`REMOTION_FUNCTION_NAME=${functionName}`);
  console.log(`REMOTION_SERVE_URL=${serveUrl}`);
  console.log(`# site: ${siteName} in bucket ${bucketName}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
