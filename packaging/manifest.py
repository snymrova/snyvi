#!/usr/bin/env python3
"""Write latest.json, the manifest a running snyvi reads to learn what is out.

  packaging/manifest.py <version> <sums-dir> [--out FILE] [--hotfix-below V]
                        [--app-min V] [--channel NAME] [--date ISO]
  packaging/manifest.py --names            the downloads a release must carry

<sums-dir> holds the .sha256 files the release workflow uploaded beside each
download under its stable name -- snyvi-linux-x64.tar.gz.sha256 and so on --
fetched back off the draft release. As with homebrew.sh and scoop.sh, no hash
is computed here: the manifest can only claim what the release carries, and a
missing or malformed checksum stops this rather than publishing a manifest that
would send a daemon to a 404.

The manifest lives at releases/latest/download/latest.json, one static file
with no rate limit. A daemon fetches it a few times a day, compares `version`
with its own, and stages the assets for its channel. Two fields steer the
daily apply: `app_min` is the oldest snyvi-app this daemon is happy with, so
an update only relaunches the window when the window's own code changed; it
is bumped by hand in Cargo.toml (`package.metadata.snyvi.app_min`) and read
from there. `hotfix_below` is null on an ordinary release and a version on the
one that fixes something every machine should have today: a machine running
anything older applies at its next check rather than its next daily slot. It
is the one field that moves every machine within hours, so it is only ever
set by hand -- a workflow_dispatch input, or a `hotfix: <version>` line in the
tag's message -- and never derived.
"""
import argparse
import json
import re
import sys
import tomllib
from datetime import datetime, timezone
from pathlib import Path

# Every stable download name, by the channel a daemon detects for itself and
# the role the file plays there. The names are the ones release.yml writes
# beside the version-stamped originals; a daemon never sees a version in a
# file name, only in the manifest.
ASSETS = {
    "linux-x64": {"snyvi": "snyvi-linux-x64.tar.gz", "app": "snyvi-app-linux-x64.tar.gz"},
    "linux-arm64": {"snyvi": "snyvi-linux-arm64.tar.gz", "app": "snyvi-app-linux-arm64.tar.gz"},
    "macos-arm64": {"bundle": "snyvi-macos-arm64.tar.gz"},
    "macos-x64": {"bundle": "snyvi-macos-x64.tar.gz"},
    "windows-x64": {"zip": "snyvi-windows-x64.zip", "setup": "snyvi-windows-x64-setup.exe"},
    "deb-x64": {"snyvi": "snyvi-linux-x64.deb", "app": "snyvi-app-linux-x64.deb"},
    "deb-arm64": {"snyvi": "snyvi-linux-arm64.deb", "app": "snyvi-app-linux-arm64.deb"},
}

VERSION = re.compile(r"^\d+\.\d+\.\d+$")
SHA256 = re.compile(r"^[0-9a-f]{64}$")


def fail(msg):
    print(f"manifest.py: {msg}", file=sys.stderr)
    sys.exit(1)


def semver(s, what):
    s = s.removeprefix("v")
    if not VERSION.match(s):
        fail(f"{what} is not a version: {s!r}")
    return tuple(int(p) for p in s.split("."))


def names():
    return [name for roles in ASSETS.values() for name in roles.values()]


def read_sum(sums, name):
    """The hash out of `<hash>  <name>`, as sha256sum writes it and `-c` reads it."""
    path = sums / f"{name}.sha256"
    if not path.is_file():
        fail(f"no checksum for {name}: {path} is missing")
    fields = path.read_text().split()
    if len(fields) < 2 or not SHA256.match(fields[0]):
        fail(f"{path} does not hold a sha256: {path.read_text().strip()!r}")
    if fields[1].lstrip("*") != name:
        fail(f"{path} is the checksum of {fields[1]}, not {name}")
    return fields[0]


def app_min_from(cargo):
    try:
        meta = tomllib.loads(cargo.read_text())["package"]["metadata"]["snyvi"]["app_min"]
    except (KeyError, FileNotFoundError, tomllib.TOMLDecodeError) as e:
        fail(f"no package.metadata.snyvi.app_min in {cargo} ({e})")
    return meta


def main():
    p = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    p.add_argument("version", nargs="?")
    p.add_argument("sums", nargs="?", type=Path)
    p.add_argument("--out", type=Path, default=Path("dist/latest.json"))
    p.add_argument("--hotfix-below", default="", help="a version, or empty for null")
    p.add_argument("--app-min", default="", help="default: package.metadata.snyvi.app_min in Cargo.toml")
    p.add_argument("--cargo", type=Path, default=Path(__file__).resolve().parent.parent / "Cargo.toml")
    p.add_argument("--channel", default="daily")
    p.add_argument("--repo", default="snymrova/snyvi")
    p.add_argument("--date", default="", help="ISO 8601, default now (UTC)")
    p.add_argument("--names", action="store_true", help="print the download names and exit")
    a = p.parse_args()

    if a.names:
        print("\n".join(names()))
        return
    if not a.version or not a.sums:
        p.error("version and sums-dir are required")

    version = a.version.removeprefix("v")
    v = semver(version, "version")
    app_min = (a.app_min or app_min_from(a.cargo)).removeprefix("v")
    if semver(app_min, "app_min") > v:
        fail(f"app_min {app_min} is newer than the release {version}")
    hotfix = a.hotfix_below.strip().removeprefix("v") or None
    if hotfix is not None and semver(hotfix, "hotfix_below") > v:
        fail(f"hotfix_below {hotfix} is newer than the release {version}: nothing could satisfy it")

    manifest = {
        "version": version,
        "date": a.date or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "channel": a.channel,
        "notes": f"https://github.com/{a.repo}/releases/tag/v{version}",
        "app_min": app_min,
        "hotfix_below": hotfix,
        "assets": {
            channel: {role: [name, read_sum(a.sums, name)] for role, name in roles.items()}
            for channel, roles in ASSETS.items()
        },
    }
    a.out.parent.mkdir(parents=True, exist_ok=True)
    a.out.write_text(json.dumps(manifest, indent=2) + "\n")
    print(a.out)


if __name__ == "__main__":
    main()
