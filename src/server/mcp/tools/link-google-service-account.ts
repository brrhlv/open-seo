import { z } from "zod";
import { requireOrgPermission } from "@/server/auth/org-gate";
import {
  type Ga4LinkResult,
  GoogleServiceAccountLinkService,
  type GscLinkResult,
} from "@/server/features/google-sa/GoogleServiceAccountLinkService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

// BRRHLV-423 / PAI-252: the machine-to-machine trigger brrhlv calls through
// /mcp/headless after a customer shares their properties with the service
// account. Safe to call repeatedly.

const inputSchema = {
  projectId: projectIdSchema,
  dryRun: z
    .boolean()
    .optional()
    .describe("Report what would be linked without saving anything."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

function describeGsc(result: GscLinkResult): string {
  switch (result.status) {
    case "linked":
      return `Search Console: ${result.changed ? "linked" : "already linked"} ${result.siteUrl} (${result.permissionLevel}).${result.alternatives.length ? ` Also visible: ${result.alternatives.join(", ")}.` : ""}`;
    case "linked_by_user":
      return `Search Console: kept ${result.siteUrl}, linked by ${result.connectedBy ?? "a user"} with their own Google sign-in.`;
    case "not_shared":
    case "error":
      return `Search Console: ${result.status === "error" ? "error. " : ""}${result.message}`;
    default:
      return `Search Console: ${result.status}.`;
  }
}

function describeGa4(result: Ga4LinkResult): string {
  switch (result.status) {
    case "linked":
      return `Google Analytics: ${result.changed ? "linked" : "already linked"} ${result.propertyDisplayName} (${result.propertyId}, stream ${result.streamHost}).`;
    case "linked_by_user":
      return `Google Analytics: kept ${result.propertyId}, linked by ${result.connectedBy ?? "a user"} with their own Google sign-in.`;
    case "ambiguous":
      return `Google Analytics: ${result.candidates.length} properties have a web stream on this domain (${result.candidates.map((c) => `${c.displayName} ${c.propertyId}`).join(", ")}); none was linked. Pick one in the project's integrations.`;
    case "not_shared":
    case "error":
      return `Google Analytics: ${result.status === "error" ? "error. " : ""}${result.message}`;
    default:
      return `Google Analytics: ${result.status}.`;
  }
}

export const linkGoogleServiceAccountTool = {
  name: "link_google_properties",
  config: {
    title: "Link Google properties via the service account",
    description:
      "Find the Search Console property and the GA4 property for the project's domain among the properties shared with the service account, and link them to the project. sc-domain properties win over URL-prefix ones; www and apex are treated as one site. A project already linked through a person's own Google sign-in is left as is. Idempotent: calling again with nothing new writes nothing. Per product, status is linked | linked_by_user | not_shared (the customer still has to add serviceAccountEmail) | ambiguous (GA4 only) | no_domain | not_configured | error. Uses no credits.",
    inputSchema,
    outputSchema: z
      .object({
        serviceAccountEmail: z.string().nullable(),
        domain: z.string().nullable(),
        dryRun: z.boolean(),
        gsc: looseObjectOutputSchema,
        ga4: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: true,
      destructiveHint: false,
      idempotentHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    // Same gate as picking a property in the app's integrations page.
    if (!args.dryRun) {
      requireOrgPermission(context.auth, { integration: ["manage"] });
    }
    const result = await GoogleServiceAccountLinkService.linkProject({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      domain: context.project.domain,
      actorUserId: context.auth.userId,
      dryRun: args.dryRun,
    });
    const header =
      result.gsc.status === "not_configured"
        ? "No Google service account is configured on this deployment."
        : result.gsc.status === "no_domain"
          ? "The project has no domain, so there is nothing to match."
          : `Service account ${result.serviceAccountEmail} · ${result.domain}${result.dryRun ? " · dry run, nothing saved" : ""}`;
    return mcpResponse({
      text: [header, describeGsc(result.gsc), describeGa4(result.ga4)].join(
        "\n",
      ),
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/settings/integrations`,
      ),
      structuredContent: { ...result },
    });
  }),
};
