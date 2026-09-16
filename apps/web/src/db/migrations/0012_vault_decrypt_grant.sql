-- Vault 0.3+: reading vault.decrypted_secrets calls vault._crypto_aead_det_decrypt,
-- which the app role must be allowed to execute (0001 only granted the view).
-- Without it every readSecret() as ai_news_app fails with
-- "permission denied for function _crypto_aead_det_decrypt".
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'vault') then
    grant execute on function vault._crypto_aead_det_decrypt(bytea, bytea, bigint, bytea, bytea) to ai_news_app;
  else
    raise notice 'vault schema not present (local Postgres?) - skipping vault grants';
  end if;
exception when others then
  raise notice 'vault grants skipped: %', sqlerrm;
end $$;
