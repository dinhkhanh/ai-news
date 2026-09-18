-- The web-video downloader (visual tier 2 + the editor's paste-a-video-page fetch)
-- is on by default. The code treats an absent row as on (`FEATURE_FLAGS[].defaultOn`);
-- this also switches on the row the seed created off. It stays an admin toggle afterwards.
insert into feature_flags (key, enabled, description)
values ('web_video_downloader', true, 'Search video sites for the story and download only the picked sections (yt-dlp on the media Lambda / NAS).')
on conflict (key) do update set enabled = true, updated_at = now();
