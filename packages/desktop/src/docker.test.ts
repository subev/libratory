import { afterAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CLI_CANDIDATES, SOCKET_CANDIDATES, dockerAdvice, dockerEnv, dockerHelp, firstExisting } from "./docker.cjs";

const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});

async function scratch(): Promise<string> {
  const d = await mkdtemp(path.join(tmpdir(), "docker-probe-"));
  dirs.push(d);
  return d;
}

describe("finding Docker without $PATH", () => {
  // A GUI app gets /usr/bin:/bin:/usr/sbin:/sbin, so `which docker` finds nothing on a machine
  // that is running Docker fine. Every real install location has to be listed instead.
  it("covers Docker Desktop, OrbStack, Homebrew and /usr/local", () => {
    expect(CLI_CANDIDATES).toEqual(expect.arrayContaining([
      "/usr/local/bin/docker",
      "/opt/homebrew/bin/docker",
      "/Applications/Docker.app/Contents/Resources/bin/docker",
      "/Applications/OrbStack.app/Contents/MacOS/xbin/docker",
    ]));
  });

  it("looks for OrbStack's and Colima's sockets, not only /var/run", () => {
    expect(SOCKET_CANDIDATES[0]).toBe("/var/run/docker.sock");
    expect(SOCKET_CANDIDATES.some((s) => s.includes(".orbstack"))).toBe(true);
    expect(SOCKET_CANDIDATES.some((s) => s.includes(".colima"))).toBe(true);
  });

  it("returns the first candidate that exists, in order", async () => {
    const dir = await scratch();
    const second = path.join(dir, "second");
    await writeFile(second, "");
    expect(await firstExisting([path.join(dir, "first"), second])).toBe(second);
  });

  it("returns null when none exist rather than guessing", async () => {
    const dir = await scratch();
    expect(await firstExisting([path.join(dir, "nope")])).toBeNull();
  });

  // Pulling an image shells out to docker-credential-osxkeychain, which sits beside the CLI in
  // Docker.app, OrbStack's xbin and Homebrew alike. Handing docker the same bare PATH the app got
  // is what made a first run die in the database step on a working machine, with docker blaming a
  // missing credential helper rather than the search path (#20).
  it("hands docker a PATH that reaches the credential helper", async () => {
    const dir = await scratch();
    const own = path.join(dir, "bin");
    const env = await dockerEnv(path.join(own, "docker"));
    const dirs = env.PATH?.split(":") ?? [];
    expect(dirs).toEqual(expect.arrayContaining([
      own,
      "/Applications/Docker.app/Contents/Resources/bin",
      "/opt/homebrew/bin",
    ]));
    expect(dirs[0]).toBe(own); // the CLI's own helper answers, not another install's
  });
});

// Docker is the one prerequisite the app cannot install, and the people hitting this screen are
// not developers — so the two states have to be told apart in words, and "get it" needs a link.
describe("what someone without Docker is told", () => {
  it("tells someone with Docker stopped to start it, not to install it", () => {
    const help = dockerHelp({ kind: "installed-not-running", cli: "/usr/local/bin/docker" });
    expect(help.title).toMatch(/not running/i);
    expect(help.body).toMatch(/Applications folder/i);
    expect(help.links).toHaveLength(0);
  });

  it("gives someone without Docker somewhere to download it", () => {
    const help = dockerHelp({ kind: "missing" });
    expect(help.links.map((l: { url: string }) => l.url)).toEqual([
      "https://www.docker.com/products/docker-desktop/",
      "https://orbstack.dev/download",
    ]);
    // No jargon in the sentence that has to land with someone who has never heard of Docker
    expect(help.body).not.toMatch(/container|daemon|CLI|socket/i);
  });

  it("says nothing extra once Docker is answering", () => {
    expect(dockerHelp({ kind: "ready", cli: "/usr/local/bin/docker", version: "28.6.0" })).toBeNull();
    expect(dockerAdvice({ kind: "ready", cli: "/usr/local/bin/docker", version: "28.6.0" })).toBe("Docker 28.6.0");
  });
});
