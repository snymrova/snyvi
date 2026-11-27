#!/usr/bin/env bash
# Fetch the speech model the ears helper is built around, check it against the
# sum written here, and unpack it.
#
#   ears/model.sh <dir>         unpack into <dir>, print the model's folder
#   ears/model.sh --pack <out>  the same three files as snyvi's own download,
#                               <out>/snyvi-ears-model-en.tar.gz, with its sum
#
# The model is Moonshine base, English, in the build sherpa-onnx publishes. It
# is named by its sum, not only its URL: a file that changed upstream stops
# here, in a build, and never reaches a reader's machine. Changing the model is
# changing these two lines, and the helper's tests say whether it still hears.
set -euo pipefail

NAME=sherpa-onnx-moonshine-base-en-quantized-2026-02-27
SHA256=43232c1d13013d37317163baec3135bd771a186a4356f28c889bab453bb0e891
URL=https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$NAME.tar.bz2

# sha256sum on Linux and in Git's bash on Windows; shasum on a Mac.
sum() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }

fetch() {
  mkdir -p "$1"
  local archive="$1/$NAME.tar.bz2"
  [ -f "$archive" ] || curl -fsSL --retry 3 -o "$archive" "$URL"
  local got
  # Read from stdin: given a path with a backslash (D:\a\_temp on a Windows
  # runner), Git's sha256sum escapes its line and the sum starts with a \.
  got=$(sum < "$archive" | cut -d' ' -f1)
  [ "$got" = "$SHA256" ] || { echo "model.sh: $archive is $got, not $SHA256" >&2; rm -f "$archive"; exit 1; }
  tar -xjf "$archive" -C "$1"
  rm -f "$archive"
}

case "${1:-}" in
  --pack)
    out=${2:?usage: ears/model.sh --pack <out>}
    tmp=$(mktemp -d)
    fetch "$tmp"
    # Only what the helper opens, and the model's licence. The clip beside it
    # upstream is for tests and stays out of a reader's download.
    mkdir -p "$tmp/snyvi-ears-model-en" "$out"
    for f in encoder_model.ort decoder_model_merged.ort tokens.txt LICENSE; do
      cp "$tmp/$NAME/$f" "$tmp/snyvi-ears-model-en/"
    done
    # The same bytes every time the model is the same: no dates, no owner, no
    # file name in the gzip. A daemon knows the model by its sum, so a release
    # that changed nothing here must not look like a new 100 MB to fetch.
    tar -C "$tmp" --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf - snyvi-ears-model-en \
      | gzip -n > "$out/snyvi-ears-model-en.tar.gz"
    (cd "$out" && sum snyvi-ears-model-en.tar.gz > snyvi-ears-model-en.tar.gz.sha256)
    rm -rf "$tmp"
    echo "$out/snyvi-ears-model-en.tar.gz"
    ;;
  ""|-*)
    echo "usage: ears/model.sh <dir> | --pack <out>" >&2
    exit 2
    ;;
  *)
    fetch "$1"
    echo "$1/$NAME"
    ;;
esac
