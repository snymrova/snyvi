# Code signing policy

Free code signing provided by [SignPath.io](https://signpath.io), certificate
by [SignPath Foundation](https://signpath.org).

*Status: applied for. Until the first signed release, the Windows files are
unsigned and this page says what they will be.*

## What is signed, and by what

| Platform | Files | Signed with |
|---|---|---|
| Windows | `snyvi.exe`, `snyvi-app.exe`, `snyvi-*-setup.exe` | SignPath Foundation's certificate, through SignPath.io |
| macOS | `snyvi.app` and the executables inside it | Apple Developer ID, notarized by Apple |
| Linux | `.deb`, `.tar.gz` | not signed; each download has a `.sha256` beside it |
| Every platform | the update a running snyvi installs | [minisign](https://jedisct1.github.io/minisign/), key `4DA8F712B78D3FC1` in [`packaging/minisign.pub`](packaging/minisign.pub); an update that does not verify is refused |

Only files built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
from this repository, on GitHub-hosted runners, are sent for signing. Nothing
built on a person's machine is signed. Every release also carries GitHub's
build provenance attestation for its Windows files.

The installer's uninstaller (`unins000.exe`) is not signed: Inno Setup signs
it only by calling a signer while it compiles, which a reviewed signing
request cannot be part of. It is run from Windows Settings, on a file
already on the machine.

## Who

- **Author**, trusted to commit: [snymrova](https://github.com/snymrova)
- **Reviewer** of every change from anyone else: [snymrova](https://github.com/snymrova)
- **Approvers** of signing requests, either of whom approves a release:
  [snymrova](https://github.com/snymrova) and
  [sharmatrapti](https://github.com/sharmatrapti)

Changes from anyone else arrive as pull requests and are reviewed before they
merge. Each release is approved for signing by hand in SignPath; none is
signed automatically. GitHub and SignPath accounts with these roles use
multi-factor authentication.

## Privacy

snyvi listens on `127.0.0.1` only, has no account and sends no telemetry.
What it sends without being asked:

- **The update check**, once a day: it reads `latest.json` from this
  repository's GitHub releases. `snyvi update off` stops it.
- **The relay link**, only after you pair with a friend: a connection to
  `relay.snyvi.com` that waits for what a friend sends you. A document goes
  to a friend only when you press Send, sealed to their key; the relay
  cannot read it. With no friend, snyvi never contacts the relay.

How the friend link works is in [`docs/PEER.md`](docs/PEER.md).

## What the installer changes

- Installs to your user profile; no administrator rights.
- Adds snyvi to your user `PATH`.
- If you leave *Connect Claude Code* ticked, runs `snyvi init-claude --auto`,
  which registers snyvi with Claude Code. `snyvi uninstall-claude` takes it
  back out, and so does uninstalling.
- Uninstall from Windows *Settings → Apps*. Your documents stay in
  `%LOCALAPPDATA%\snyvi`; `snyvi reset` before uninstalling removes them too.

## Reporting a problem

Open an issue at [github.com/snymrova/snyvi/issues](https://github.com/snymrova/snyvi/issues).
A signed file you think was not built from this repository: say so there,
and it will be looked into with SignPath.
