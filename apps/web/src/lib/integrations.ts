/** Catalogue of admin-managed shared integrations (secret stored in Supabase Vault). */
export const INTEGRATIONS = [
  { provider: "anthropic", label: "Anthropic (Claude)", secretLabel: "API key", hasSpendCap: true, hasCredits: false },
  { provider: "pexels", label: "Pexels", secretLabel: "API key", hasSpendCap: false, hasCredits: false },
  { provider: "pixabay", label: "Pixabay", secretLabel: "API key", hasSpendCap: false, hasCredits: false },
  { provider: "mubert", label: "Mubert (API v3)", secretLabel: "CUSTOMER_ID:ACCESS_TOKEN", hasSpendCap: true, hasCredits: false },
  { provider: "firecrawl", label: "Firecrawl (fallback fetch)", secretLabel: "API key", hasSpendCap: false, hasCredits: true },
  { provider: "cloudflare_browser", label: "Cloudflare Browser Rendering", secretLabel: "API token", hasSpendCap: false, hasCredits: false },
  { provider: "google_veo", label: "Google Vertex AI (Gemini image / Veo)", secretLabel: "Google Cloud Project ID (auth via GOOGLE_APPLICATION_CREDENTIALS_JSON)", hasSpendCap: true, hasCredits: false },
  { provider: "resend", label: "Resend (email)", secretLabel: "API key", hasSpendCap: false, hasCredits: false },
  { provider: "slack_webhook", label: "Slack webhook", secretLabel: "Webhook URL", hasSpendCap: false, hasCredits: false },
  { provider: "langfuse", label: "Langfuse", secretLabel: "Secret key", hasSpendCap: false, hasCredits: false },
  { provider: "meta_app", label: "Meta app (Facebook + Instagram Reels)", secretLabel: "APP_ID:APP_SECRET", hasSpendCap: false, hasCredits: false },
  { provider: "tiktok_app", label: "TikTok app (Content Posting API)", secretLabel: "CLIENT_KEY:CLIENT_SECRET", hasSpendCap: false, hasCredits: false },
] as const;

export type IntegrationProvider = (typeof INTEGRATIONS)[number]["provider"];
export const isIntegrationProvider = (p: string): p is IntegrationProvider =>
  INTEGRATIONS.some((i) => i.provider === p);

/** `defaultOn`: the state of a flag nobody has set yet (no `feature_flags` row); everything else starts off. */
export const FEATURE_FLAGS = [
  { key: "web_video_downloader", label: "Web-video downloader (yt-dlp)", description: "Visual tier 2 (same rank as other outlets' images): search YouTube / video pages about the story, download only the picked sections through the media Lambda." },
  { key: "ai_media", label: "AI media (Gemini image on Vertex)", description: "Last tier of the visual priority: generate stills only for shots the article, other outlets and stock could not fill. Subject to the daily ai_media quota and the Vertex spend cap." },
  { key: "face_guard", defaultOn: true, label: "Face guard (Cloud Vision)", description: "On by default. Face detection and automatic alignment of stills before they enter a video: faces must not be cropped by the 9:16 frame, must not sit under text overlays or platform UI, and are centred on the upper-third line. Needs the Cloud Vision API on the Google service account's project." },
  { key: "scheduling", label: "Scheduled publishing", description: "Allow publish-at-time via delayed events." },
  { key: "publish_youtube", label: "Publish: YouTube Shorts", description: "Uploads via the Internal Google OAuth client (youtube.upload scope)." },
  { key: "publish_facebook", label: "Publish: Facebook Reels", description: "Needs the Meta app with publish_video approved (or app-role testers)." },
  { key: "publish_instagram", label: "Publish: Instagram Reels", description: "Needs instagram_content_publish on the Meta app." },
  { key: "publish_tiktok", label: "Publish: TikTok", description: "Unaudited TikTok apps can only post SELF_ONLY (private)." },
] as const;

/** State of a flag without a row. */
export const flagDefault = (key: string): boolean => FEATURE_FLAGS.some((f) => f.key === key && "defaultOn" in f && f.defaultOn);

export const PROMPT_PURPOSES = ["script", "faithfulness", "metadata", "rank_broll", "language_detect", "sensitive_topic"] as const;
export type PromptPurpose = (typeof PROMPT_PURPOSES)[number];

export const QUOTA_RESOURCES = [
  { key: "scripts", label: "Script generations / day", defaultUser: 20 },
  { key: "ai_media", label: "AI media generations / day", defaultUser: 5 },
  { key: "render_minutes", label: "Render minutes / day", defaultUser: 30 },
  { key: "publishes", label: "Publishes / day", defaultUser: 10 },
] as const;
