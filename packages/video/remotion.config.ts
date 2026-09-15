import { Config } from "@remotion/cli/config";

// Output spec is fixed (docs/PLAN.md §1). Lambda renders set these explicitly
// in apps/web/src/lib/remotion.ts; this config covers local renders/studio.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(90);
Config.setCodec("h264");
Config.setCrf(18);
Config.setAudioBitrate("192k");
Config.setX264Preset("medium");
Config.setOverwriteOutput(true);
