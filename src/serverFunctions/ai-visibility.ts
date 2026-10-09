import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { AiVisibilityService } from "@/server/features/ai-visibility/services/AiVisibilityService";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { BRAND_LOOKUP_MAX_INPUT_LENGTH } from "@/types/schemas/ai-search";

// Stored snapshots only — never calls DataForSEO, so it is not plan-gated.
export const getAiVisibility = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(({ context }) => AiVisibilityService.getHistory(context.projectId));

// The Brand Lookup "Track this" toggle. Creating or pausing a tracker spends
// nothing; the monthly cron does.
export const setAiVisibilityTracking = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    z.object({
      projectId: z.string().min(1),
      target: z.string().trim().min(1).max(BRAND_LOOKUP_MAX_INPUT_LENGTH),
      active: z.boolean(),
    }),
  )
  .handler(({ data, context }) =>
    AiVisibilityService.setTracking({
      projectId: context.projectId,
      projectDomain: context.project.domain,
      target: data.target,
      active: data.active,
    }),
  );
