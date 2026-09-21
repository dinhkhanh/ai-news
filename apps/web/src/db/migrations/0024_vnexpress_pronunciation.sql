-- "VnExpress" is read "vi en express", not "vê nờ express". Platform dictionary entry (every workspace); the TTS reads
-- the replacement, the captions keep "VnExpress" (`pronounce` / `displayTimedWords` in src/lib/media/pronounce.ts).
insert into pronunciations (organization_id, language, term, replacement)
select null, 'vi', 'VnExpress', 'Vi En Express'
where not exists (select 1 from pronunciations where organization_id is null and language = 'vi' and term = 'VnExpress');
