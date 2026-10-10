import { describe, expect, it } from "vitest";
import { clientKey } from "./request-limits.ts";

describe("clientKey", () => {
  it("counts per socket when the server is reached directly, whatever the headers claim", () => {
    expect(clientKey({ "x-forwarded-for": "1.2.3.4" }, "10.0.0.9", false)).toBe("10.0.0.9");
  });

  it("counts per reported client behind a proxy, Cloudflare's header first", () => {
    expect(clientKey({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8, 10.0.0.1" }, "172.18.0.2", true)).toBe("1.2.3.4");
    expect(clientKey({ "x-forwarded-for": "5.6.7.8, 10.0.0.1" }, "172.18.0.2", true)).toBe("5.6.7.8");
    expect(clientKey({ "x-forwarded-for": ["5.6.7.8", "9.9.9.9"] }, "172.18.0.2", true)).toBe("5.6.7.8");
  });

  it("falls back to the socket behind a proxy that reports nothing", () => {
    expect(clientKey({}, "172.18.0.2", true)).toBe("172.18.0.2");
  });
});
