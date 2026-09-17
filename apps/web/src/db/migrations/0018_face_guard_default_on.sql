-- Face recognition + alignment (face guard) is on by default. The code treats an
-- absent row as on (`FEATURE_FLAGS[].defaultOn`); this also switches on a row an
-- admin may have left off. It stays an admin toggle afterwards.
insert into feature_flags (key, enabled, description)
values ('face_guard', true, 'Face detection (Cloud Vision) and automatic face-safe framing of stills.')
on conflict (key) do update set enabled = true, updated_at = now();
