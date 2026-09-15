import { writeActivityEvent, writeUsageCost } from "./bookkeeping";
import { fetchArticleFn } from "./fetch-article";
import { generateScriptFn } from "./generate-script";
import { runPromptEvalFn } from "./run-prompt-eval";
import { testRender } from "./test-render";

export const functions = [writeActivityEvent, writeUsageCost, testRender, fetchArticleFn, generateScriptFn, runPromptEvalFn];
