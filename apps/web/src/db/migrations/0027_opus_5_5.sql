-- Script and faithfulness move from Claude Opus 5 ($5 / $25 per MTok) to Claude Opus 5.5 ($4 / $20), same effort (high).
-- A template's `model` overrides the code default, so the stored templates (built-in and admin versions) move with it.
UPDATE "prompt_templates" SET "model" = 'claude-opus-5-5' WHERE "model" = 'claude-opus-5';
