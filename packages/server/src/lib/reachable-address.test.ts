import { describe, expect, it } from "vitest";
import { pickReachable, reachableAddresses, type Interface } from "./reachable-address.ts";

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

describe("reachableAddresses", () => {
  it("lists the Tailscale name first and every LAN address after it, for a phone off the tailnet", () => {
    const ethernet: Interface = { address: "10.0.0.7", family: "IPv4", internal: false };
    expect(reachableAddresses([lo, lan, lan6, tailnet, ethernet], "mini.tail4a2f.ts.net", 3034)).toEqual([
      { host: "mini.tail4a2f.ts.net", origin: "http://mini.tail4a2f.ts.net:3034", via: "tailscale" },
      { host: "192.168.4.12", origin: "http://192.168.4.12:3034", via: "lan" },
      { host: "10.0.0.7", origin: "http://10.0.0.7:3034", via: "lan" },
    ]);
  });

  it("stands the tailnet address in for a missing name, and never lists it beside one", () => {
    expect(reachableAddresses([lo, lan, tailnet], null, 3034).map((a) => a.host)).toEqual(["100.101.102.103", "192.168.4.12"]);
    expect(reachableAddresses([lo, lan, tailnet], "mini.tail4a2f.ts.net", 3034).map((a) => a.host)).toEqual(["mini.tail4a2f.ts.net", "192.168.4.12"]);
  });

  it("leaves out the bridges and tunnels no phone is behind", () => {
    const wifi: Interface = { name: "en0", address: "192.168.8.4", family: "IPv4", internal: false };
    const bridge: Interface = { name: "bridge100", address: "192.168.139.3", family: "IPv4", internal: false };
    const tunnel: Interface = { name: "utun7", address: "100.127.78.118", family: "IPv4", internal: false };
    expect(reachableAddresses([lo, bridge, wifi, tunnel], null, 3034).map((a) => a.host)).toEqual(["100.127.78.118", "192.168.8.4"]);
  });

  it("is empty with nothing but loopback", () => {
    expect(reachableAddresses([lo], null, 3034)).toEqual([]);
  });
});
