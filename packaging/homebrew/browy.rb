# Homebrew formula for Browy.
#
# Distribution paths (pick one):
#
# A) Personal tap (recommended at launch — instant, no review):
#    - Push this file to github.com/browyhq/homebrew-browy as Formula/browy.rb
#    - Users install with:
#        brew tap browyhq/browy
#        brew install browy
#
# B) homebrew-core (after ~1k+ stars / proven adoption):
#    - Submit a PR to homebrew/homebrew-core. Requires reproducible builds,
#      tests, and meets the Acceptable Formulae rules.
#    - Users install with: brew install browy
#
# After every release: bump `version`, point `url`s at the new tarballs,
# and update `sha256` values from the GitHub Releases artifacts.
class Browy < Formula
  desc "AI agent that lives in your browser DevTools side panel"
  homepage "https://github.com/browyhq/browy"
  version "0.1.0"
  license "Apache-2.0"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/browyhq/browy/releases/download/v0.1.0/Browy-0.1.0-darwin-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_AFTER_BUILD"
    else
      url "https://github.com/browyhq/browy/releases/download/v0.1.0/Browy-0.1.0-darwin-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_AFTER_BUILD"
    end
  end

  on_linux do
    if Hardware::CPU.arm?
      url "https://github.com/browyhq/browy/releases/download/v0.1.0/Browy-0.1.0-linux-arm64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_AFTER_BUILD"
    else
      url "https://github.com/browyhq/browy/releases/download/v0.1.0/Browy-0.1.0-linux-x64.tar.gz"
      sha256 "REPLACE_WITH_SHA256_AFTER_BUILD"
    end
  end

  def install
    # Stage the entire bundle under libexec so the bundled node and
    # node_modules stay together. Then expose `browy` as a thin shim in bin/.
    libexec.install Dir["*"]
    (bin/"browy").write <<~SH
      #!/usr/bin/env bash
      exec "#{libexec}/node" "#{libexec}/dist/cli-bin.js" "$@"
    SH
  end

  def post_install
    # Register the Chrome/Edge/Brave native messaging manifest pointing at
    # this Cellar's wrapper so the extension can talk to us.
    system "#{libexec}/node", "#{libexec}/dist/cli-bin.js", "install-host"
  end

  def caveats
    <<~EOS
      Browy installed. Next steps:

        1. Install the Browy extension from the Chrome Web Store.
        2. Pin the extension and click it to open the side panel.

      To unregister the native messaging host (e.g., before `brew uninstall`):
        browy uninstall-host
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/browy --version 2>&1", 0)
  end
end
