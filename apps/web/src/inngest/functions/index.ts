import { writeActivityEvent, writeUsageCost } from "./bookkeeping";
import { comicAdaptFn } from "./comic-adapt";
import { comicCastFn, comicDrawFn } from "./comic-draw";
import { comicExportFn } from "./comic-export";
import { fetchArticleFn } from "./fetch-article";
import { generateScriptFn } from "./generate-script";
import { prepareAssetsFn } from "./prepare-assets";
import { publishPublicationFn } from "./publish-publication";
import { regenerateSceneFn } from "./regenerate-scene";
import { renderProjectFn } from "./render-project";
import { runPromptEvalFn } from "./run-prompt-eval";
import { testRender } from "./test-render";

/** No crons here: the recurring jobs run from Supabase pg_cron over /api/cron/<job> (src/lib/cron-jobs.ts), so they keep running when Inngest does not. */
export const functions = [writeActivityEvent, writeUsageCost, testRender, fetchArticleFn, generateScriptFn, runPromptEvalFn, prepareAssetsFn, renderProjectFn, regenerateSceneFn, publishPublicationFn, comicAdaptFn, comicCastFn, comicDrawFn, comicExportFn];
