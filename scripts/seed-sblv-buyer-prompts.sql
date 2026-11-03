-- PAI-255: the 8 SBLV buyer prompts (SBLV-188 research.md §4).
-- NOT RUN by the branch. Apply after migration 0046 is live, through the D1
-- API (CLOUDFLARE_API_TOKEN in .env.selfhost) or `wrangler d1 execute`.
-- Equivalent MCP call: add_ai_visibility_prompts with the same 8 prompts.
--
-- next_run_at = now, so the */5 cron baselines them on ticks with no mentions
-- tracker due (2 prompts per tick, about 20 minutes). Expected cost of the
-- first run: about $0.11 (8 prompts x ChatGPT $0.004 + AI Mode $0.004 +
-- Perplexity ~$0.006). Re-running is safe: a prompt that already exists is
-- reactivated, not duplicated.

INSERT INTO ai_visibility_prompts (id, project_id, prompt, next_run_at, created_at)
VALUES
  ('47875bb8-ddc1-4337-bef1-69968901c462', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'best photo booth company for a corporate event in Las Vegas', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+1 seconds')),
  ('dff95e34-f6ed-44af-8d41-93718c894f84', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'trade show photo booth rental in Las Vegas with lead capture', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+2 seconds')),
  ('be6ef119-d4cc-4f3f-8d3c-caf8d1bb6479', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'photo booth for our exhibit booth at the Las Vegas Convention Center (CES)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+3 seconds')),
  ('c6fd1dd9-5855-4647-b34e-ef4790f51dac', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'brand activation photo booth vendor in Las Vegas', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+4 seconds')),
  ('38ad8154-30d8-406c-9f15-b1a8213560a3', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', '360 photo booth rental for a corporate event in Las Vegas', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+5 seconds')),
  ('ce82b082-3f76-4cd7-8fad-f1a291c295dd', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'how much does a photo booth cost for a corporate event in Las Vegas', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+6 seconds')),
  ('7586036b-1b56-4d06-9402-e27f4bcb5ad6', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'photo booth for a company holiday party in Las Vegas', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+7 seconds')),
  ('9338e8d4-cafb-4101-adcc-a4821b9bcf14', 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', 'Las Vegas photo booth vendor that meets venue COI and EAC requirements (Caesars Forum, Mandalay Bay)', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), datetime('now', '+8 seconds'))
ON CONFLICT (project_id, prompt) DO UPDATE SET
  is_active = 1,
  next_run_at = excluded.next_run_at;

-- Check:
-- SELECT id, prompt, next_run_at FROM ai_visibility_prompts
--   WHERE project_id = 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae' ORDER BY created_at;
