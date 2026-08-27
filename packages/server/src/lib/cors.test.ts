import { describe, it, expect } from "vitest";
import { isAllowedOrigin, parseTrustedHosts } from "./cors.ts";

const NONE = parseTrustedHosts("");

describe("isAllowedOrigin", () => {
  it("allows a request with no Origin at all", () => {
    expect(isAllowedOrigin(undefined, "192.168.1.50:3034", NONE)).toBe(true);
  });

  it("allows the loopback names the desktop app and Vite use", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:3034", "http://[::1]:3034"]) {
      expect(isAllowedOrigin(origin, "localhost:3034", NONE)).toBe(true);
    }
  });

  it("allows a phone reading the library at this server's own address", () => {
    expect(isAllowedOrigin("http://192.168.1.50:3034", "192.168.1.50:3034", NONE)).toBe(true);
    expect(isAllowedOrigin("http://[fd00::1]:3034", "[fd00::1]:3034", NONE)).toBe(true);
  });

  it("refuses a rebound name whose Origin and Host agree", () => {
    expect(isAllowedOrigin("http://attacker.example", "attacker.example", NONE)).toBe(false);
  });

  it("accepts a name only once TRUSTED_HOSTS says it fronts this server", () => {
    const trusted = parseTrustedHosts("library.example.com, box.local:3034");
    expect(isAllowedOrigin("http://library.example.com", "library.example.com", trusted)).toBe(true);
    expect(isAllowedOrigin("http://box.local:3034", "box.local:3034", trusted)).toBe(true);
    expect(isAllowedOrigin("http://other.example.com", "other.example.com", trusted)).toBe(false);
  });

  it("matches the Host case-insensitively, as a Host header is", () => {
    const trusted = parseTrustedHosts("Library.Example.com");
    expect(isAllowedOrigin("http://library.example.com", "Library.Example.com", trusted)).toBe(true);
  });

  it("refuses an origin that only shares the hostname", () => {
    expect(isAllowedOrigin("http://192.168.1.50:9999", "192.168.1.50:3034", NONE)).toBe(false);
    expect(isAllowedOrigin("http://192.168.1.51:3034", "192.168.1.50:3034", NONE)).toBe(false);
  });

  it("refuses when there is no Host to judge against, or the Origin is unparseable", () => {
    expect(isAllowedOrigin("http://192.168.1.50:3034", undefined, NONE)).toBe(false);
    expect(isAllowedOrigin("null", "192.168.1.50:3034", NONE)).toBe(false);
  });
});
