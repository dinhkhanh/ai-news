# External filings to start in phase 1

These have multi-week lead times. File them now; publishing code lands in phase 5.

## YouTube Data API quota increase
- Default 10,000 units/day = 6 uploads (`videos.insert` costs 1,600). Target 50 uploads/day ⇒ request **80,000–100,000 units/day**.
- Form: Google Cloud Console → APIs & Services → YouTube Data API v3 → Quotas → *Apply for higher quota* (YouTube API Services – Audit and Quota Extension Form).
- Needed: project number, app description (internal newsroom tool that uploads short news videos produced by staff), demo video/screenshots of the review → approve → publish flow, privacy policy URL, statement that the OAuth client is Internal to `suzu.group` and no third-party users exist.
- Also confirm the OAuth consent screen is **Internal** (no verification required for the `youtube.upload` scope).

## Meta (Facebook Reels + Instagram Reels)
1. **Business Verification** for the company in Meta Business Suite (legal name, address, business document, domain). ~1–2 weeks.
2. Meta app (type *Business*) → add *Facebook Login for Business* and *Instagram Graph API*.
3. **App Review** for permissions: `pages_manage_posts`, `pages_read_engagement`, `publish_video`, `instagram_basic`, `instagram_content_publish`, `business_management`.
   Needs a screencast showing an admin connecting a Page and a publisher posting a Reel, plus the privacy policy and data-deletion URLs.
4. Until approved, only users with a role on the app can publish, which is enough for internal testing.

## TikTok Content Posting API
1. Register at developers.tiktok.com, create app **ai-news**, add *Login Kit* + *Content Posting API*.
2. Scopes: `user.info.basic`, `video.publish`, `video.upload`.
3. Submit for review with a demo video. Unaudited apps can only post **private** videos; the audit (\"Direct Post\" approval) lifts that. Plan for 2–4 weeks and one round of feedback.

## Remotion
- Company licence confirmed in the plan. Keep the invoice/licence key with the AWS deployment notes.

## Mubert
- Business/API plan needed for commercial use; confirm tier and monthly track cap before phase 3.

## AWS
- Lambda concurrency increase in `ap-southeast-1` to ≥1,000 (Service Quotas → Lambda → Concurrent executions). Remotion needs high burst concurrency for chunked renders.
