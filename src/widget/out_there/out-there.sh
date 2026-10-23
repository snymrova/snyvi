#!/bin/sh
# Out there (snyvi 1.48): this desk's GitHub repo as the world sees it --
# stars, downloads of the latest release, unique visitors in two weeks.
# Runs in the desk's folder with your own gh. Prints an empty body (the box
# clears) where there is no GitHub remote or no gh; visitors need push
# access to the repo and are left out without it.
url=$(git remote get-url origin 2>/dev/null)
repo=$(printf '%s' "$url" | sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's#\.git$##')
if [ -z "$repo" ] || ! command -v gh >/dev/null 2>&1; then
  echo '{"body":""}'
  exit 0
fi
stars=$(gh api "repos/$repo" --jq .stargazers_count 2>/dev/null) || stars=""
dl=$(gh api "repos/$repo/releases/latest" --jq '[.assets[].download_count] | add // 0' 2>/dev/null) || dl=""
seen=$(gh api "repos/$repo/traffic/views" --jq .uniques 2>/dev/null) || seen=""
[ -n "$stars" ] || { echo '{"body":""}'; exit 0; }
line="**$stars** stars"
[ -n "$dl" ] && line="$line · **$dl** downloads"
[ -n "$seen" ] && line="$line · **$seen** visitors, 14 d"
printf '{"body":"%s","count":"%s","tone":"ok","lines":1}\n' "$line" "$stars"
