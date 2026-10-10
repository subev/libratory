import { describe, expect, it } from "vitest";
import { pickReachable, type Interface } from "./reachable-address.ts";

const lo: Interface = { address: "127.0.0.1", family: "IPv4", internal: true };
const lan: Interface = { address: "192.168.4.12", family: "IPv4", internal: false };
const lan6: Interface = { address: "fe80::1", family: "IPv6", internal: false };
const tailnet: Interface = { address: "100.101.102.103", family: "IPv4", internal: false };

describe("pickReachable", () => {
  it("prefers the Tailscale name, which keeps working off Wi-Fi", () => {
    expect(pickReachable([lo, lan, tailnet], "mini.tail4a2f.ts.net", 3034)).toEqual({
      host: "mini.tail4a2f.ts.net",
      origin: "http://mini.tail4a2f.ts.net:3034",
      via: "tailscale",
    });
  });

  it("falls back to the tailnet address when the CLI gave no name", () => {
    expect(pickReachable([lo, lan, tailnet], null, 3034)).toEqual({
      host: "100.101.102.103",
      origin: "http://100.101.102.103:3034",
      via: "tailscale",
    });
  });

  it("falls back to the LAN address, and says it is only the LAN", () => {
    expect(pickReachable([lo, lan6, lan], null, 3034)).toEqual({ host: "192.168.4.12", origin: "http://192.168.4.12:3034", via: "lan" });
  });

  it("answers null with nothing but loopback, so the page can say so", () => {
    expect(pickReachable([lo], null, 3034)).toBeNull();
  });

  it("does not mistake 100.x outside the CGNAT range for a tailnet", () => {
    const other: Interface = { address: "100.10.0.5", family: "IPv4", internal: false };
    expect(pickReachable([other], null, 3034)).toMatchObject({ host: "100.10.0.5", via: "lan" });
  });
});
