import { describe, expect, it, vi } from "vitest";
import type { handleHeadlessMcpRequest } from "@/server/mcp/headless-auth";
import type { handleSelfHostedOpenSeoMcpRequest } from "@/server/mcp/transport";

const mocks = vi.hoisted(() => ({
  handleHeadlessMcpRequest: vi.fn<typeof handleHeadlessMcpRequest>(),
  handleSelfHostedOpenSeoMcpRequest:
    vi.fn<typeof handleSelfHostedOpenSeoMcpRequest>(),
}));

vi.mock("@/server/mcp/headless-auth", () => ({
  MCP_HEADLESS_ROUTE: "/mcp/headless",
  handleHeadlessMcpRequest: mocks.handleHeadlessMcpRequest,
}));

vi.mock("@/server/mcp/transport", () => ({
  handleSelfHostedOpenSeoMcpRequest: mocks.handleSelfHostedOpenSeoMcpRequest,
}));

import { routeSelfHostedMcpRequest } from "@/server/mcp/selfhost-routing";

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function route(path: string, authMode: "cloudflare_access" | "local_noauth") {
  const request = new Request(`https://seo.example.com${path}`, {
    method: "POST",
  });
  return routeSelfHostedMcpRequest(request, authMode, {}, ctx);
}

describe("routeSelfHostedMcpRequest", () => {
  it("sends /mcp/headless to the headless handler under cloudflare_access", () => {
    expect(route("/mcp/headless", "cloudflare_access")).not.toBeNull();
    expect(mocks.handleHeadlessMcpRequest).toHaveBeenCalledOnce();
    expect(mocks.handleSelfHostedOpenSeoMcpRequest).not.toHaveBeenCalled();
  });

  it("never serves /mcp/headless under local_noauth", () => {
    expect(route("/mcp/headless", "local_noauth")).toBeNull();
    expect(mocks.handleHeadlessMcpRequest).not.toHaveBeenCalled();
    expect(mocks.handleSelfHostedOpenSeoMcpRequest).not.toHaveBeenCalled();
  });

  it.each(["cloudflare_access", "local_noauth"] as const)(
    "keeps /mcp on the Access/OAuth handler under %s",
    (authMode) => {
      expect(route("/mcp", authMode)).not.toBeNull();
      expect(mocks.handleSelfHostedOpenSeoMcpRequest).toHaveBeenCalledWith(
        expect.any(Request),
        authMode,
        {},
        ctx,
      );
      expect(mocks.handleHeadlessMcpRequest).not.toHaveBeenCalled();
    },
  );

  it("leaves every other path to the app", () => {
    expect(route("/mcp/other", "cloudflare_access")).toBeNull();
  });
});
