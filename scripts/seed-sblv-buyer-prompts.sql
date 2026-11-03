-- PAI-255: the 8 SBLV buyer prompts (SBLV-188 research.md §4).
-- NOT RUN by the branch. Apply after migration 0046 is live, through the D1
-- API (CLOUDFLARE_API_TOKEN in .env.selfhost) or `wrangler d1 execute`.
-- Equivalent MCP call: add_ai_visibility_prompts with the same 8 prompts.
--
-- Timing (Bryan, 2026-11-03): prompts run only with the monthly AI-visibility
-- check that feeds the monthly report, never mid-month. next_run_at is the
-- SBLV tracker's next monthly check (its next_check_at while that is on a
-- 1st), else 06:00 UTC on the next 1st. For an immediate first run, call
-- run_ai_visibility_prompts (about $0.11). Expected cost per monthly run:
-- about $0.11 (8 prompts x ChatGPT $0.004 + AI Mode $0.004 + Perplexity
-- ~$0.006). Re-running is safe: a prompt that already exists is only
-- reactivated; its schedule and this month's attempts are untouched.

WITH first_run(at) AS (
  SELECT coalesce(
    (SELECT next_check_at FROM ai_visibility_configs
      WHERE project_id = 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae'
        AND is_active = 1 AND schedule_interval = 'monthly'
        AND substr(next_check_at, 9, 2) = '01'),
    strftime('%Y-%m-01T06:00:00.000Z', 'now', 'start of month', '+1 month')
  )
),
prompts(id, prompt, n) AS (VALUES
  ('47875bb8-ddc1-4337-bef1-69968901c462', 'best photo booth company for a corporate event in Las Vegas', 1),
  ('dff95e34-f6ed-44af-8d41-93718c894f84', 'trade show photo booth rental in Las Vegas with lead capture', 2),
  ('be6ef119-d4cc-4f3f-8d3c-caf8d1bb6479', 'photo booth for our exhibit booth at the Las Vegas Convention Center (CES)', 3),
  ('c6fd1dd9-5855-4647-b34e-ef4790f51dac', 'brand activation photo booth vendor in Las Vegas', 4),
  ('38ad8154-30d8-406c-9f15-b1a8213560a3', '360 photo booth rental for a corporate event in Las Vegas', 5),
  ('ce82b082-3f76-4cd7-8fad-f1a291c295dd', 'how much does a photo booth cost for a corporate event in Las Vegas', 6),
  ('7586036b-1b56-4d06-9402-e27f4bcb5ad6', 'photo booth for a company holiday party in Las Vegas', 7),
  ('9338e8d4-cafb-4101-adcc-a4821b9bcf14', 'Las Vegas photo booth vendor that meets venue COI and EAC requirements (Caesars Forum, Mandalay Bay)', 8)
)
INSERT INTO ai_visibility_prompts (id, project_id, prompt, next_run_at, created_at)
SELECT prompts.id, 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae', prompts.prompt, first_run.at,
       datetime('now', '+' || prompts.n || ' seconds')
FROM prompts, first_run
WHERE true
ON CONFLICT (project_id, prompt) DO UPDATE SET is_active = 1;

-- Check:
-- SELECT id, prompt, next_run_at FROM ai_visibility_prompts
--   WHERE project_id = 'c65ed7c9-ee05-4b6d-a61f-8817c7a003ae' ORDER BY created_at;
