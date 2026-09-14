// The Homebrew cask, rendered from a version and a checksum. `pnpm ship` writes the result into
// the tap after it publishes a release; run by hand it prints the same file for a bump the script
// could not make:
//
//   node scripts/cask.mjs 26.911.0 <sha256 of Libratory-arm64.zip>
//
// The tap is its own repository because Homebrew clones a tap whole, and this one carries the
// build machinery and screen recordings nobody installing an app should have to download.
export const TAP = { repo: "subev/homebrew-libratory", path: "Casks/libratory.rb", name: "subev/libratory" };
export const ZIP = "Libratory-arm64.zip";

export function renderCask({ version, sha256 }) {
  // The same shape release.mjs enforces: three numeric parts, or electron-updater rejects it.
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`Not a release version: ${version}`);
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error(`Not a sha256: ${sha256}`);

  // Stanza order is the one `brew style` enforces. `auto_updates` because electron-updater
  // replaces the app in place, so `brew upgrade` leaves it alone unless asked with --greedy.
  return `cask "libratory" do
  version "${version}"
  sha256 "${sha256}"

  url "https://github.com/subev/libratory/releases/download/v#{version}/${ZIP}"
  name "Libratory"
  desc "Turns PDFs and EPUBs into audiobooks you can read along with"
  homepage "https://libratory.dev/"

  livecheck do
    url :url
    strategy :github_latest
  end

  auto_updates true
  depends_on arch: :arm64
  depends_on macos: :ventura

  app "Libratory.app"

  zap trash: [
    "~/Library/Application Support/Libratory",
    "~/Library/Caches/@libratorydesktop-updater",
    "~/Library/Caches/dev.libratory.app",
    "~/Library/Caches/dev.libratory.app.ShipIt",
    "~/Library/HTTPStorages/dev.libratory.app",
    "~/Library/Preferences/dev.libratory.app.plist",
    "~/Library/Saved Application State/dev.libratory.app.savedState",
  ]

  caveats do
    <<~EOS
      Libratory keeps your library in Postgres, run through Docker. Install Docker Desktop
      or OrbStack and have it running before the first launch:

        brew install --cask orbstack        # lighter, Mac only
        brew install --cask docker-desktop  # or the original

      \`brew uninstall --zap\` removes the app, its Python runtime and the data folder holding
      your finished audiobooks, but not the Docker volume with the library or the downloaded
      models. https://github.com/subev/libratory/blob/main/docs/uninstall.md lists those.
    EOS
  end
end
`;
}

if (process.argv[1] && import.meta.url === new URL(process.argv[1], "file://").href) {
  const [version, sha256] = process.argv.slice(2);
  if (!version || !sha256) {
    console.error("usage: node scripts/cask.mjs <version> <sha256>");
    process.exit(1);
  }
  process.stdout.write(renderCask({ version, sha256 }));
}
