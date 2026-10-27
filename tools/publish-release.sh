#!/usr/bin/env bash
# Builds one squashed release commit for the public upstream repo.
#
#   tools/publish-release.sh [--dry-run] [--no-install] [--ref REF] <version>
#
# Gerrit `main` stays the only place where development happens. The local
# `release` branch (rooted on upstream's template commit, no shared history
# with `main`) receives one commit per release: the allowlisted files of REF
# (default HEAD) from tools/release-include.txt, rewritten by
# tools/release-transform.mjs, on top of upstream-owned files.
#
# The commit body is the `## <version>` section of CHANGELOG.md.
#
# Nothing is pushed. The commands to review and publish are printed at the end.
# --dry-run builds and checks in a scratch worktree, then discards it.
set -euo pipefail

usage() {
	cat <<'USAGE'
usage: tools/publish-release.sh [options] <x.y.z>

Builds one squashed release commit on the local `release` branch from the
allowlisted files of a clean checkout (tools/release-include.txt), with the
commit body taken from the `## <x.y.z>` section of CHANGELOG.md. Pushes nothing.

options:
  --dry-run     build and check in a scratch worktree, then discard it
  --no-install  skip yarn install/format/package
  --ref REF     commit to release (default HEAD)
  -h, --help    show this help
USAGE
}

dry=0 install=1 ref=HEAD
while [[ $# -gt 0 ]]; do
	case $1 in
		-h|--help) usage; exit 0 ;;
		--dry-run) dry=1 ;;
		--no-install) install=0 ;;
		--ref) ref=$2; shift ;;
		-*) echo "unknown option $1" >&2; usage >&2; exit 2 ;;
		*) version=$1 ;;
	esac
	shift
done
[[ ${version:-} =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { usage >&2; exit 2; }

root=$(git rev-parse --show-toplevel)
cd "$root"
src=$(git rev-parse --verify "$ref^{commit}")
[[ -z $(git status --porcelain --untracked-files=no) ]] || { echo "working tree not clean" >&2; exit 1; }
git rev-parse --verify -q release >/dev/null || { echo "no local 'release' branch (git branch release upstream/main)" >&2; exit 1; }
git merge-base release "$src" >/dev/null 2>&1 &&
	{ echo "'release' shares history with $ref; it must stay rooted on upstream" >&2; exit 1; }
git rev-parse -q --verify "refs/tags/v$version" >/dev/null && { echo "tag v$version already exists" >&2; exit 1; }

work=$(mktemp -d)
cleanup() { git worktree remove --force "$work" 2>/dev/null || true; rm -rf "$work"; }
trap cleanup EXIT
git worktree add --quiet "$work" release

# 1. Replace everything the module owns; upstream-owned files stay.
git -C "$work" rm -rq --ignore-unmatch src companion package.json yarn.lock README.md
mapfile -t paths < <(grep -v -e '^#' -e '^$' tools/release-include.txt)
git archive "$src" -- "${paths[@]}" | tar -x -C "$work"

# 2. Public-facing rewrites.
node tools/release-transform.mjs "$work" "$version"

# 3. Prove it builds.
if [[ $install == 1 ]]; then
	(cd "$work" && yarn install && yarn format && yarn package)
	rm -rf "$work/pkg"
else
	echo "skipping yarn install/format/package (--no-install)"
fi

# 4. Leak check. Hard patterns fail the release; soft ones need a human look.
git -C "$work" add -A
hard='ATHDR|gerrit|[a-z0-9-]+\.dreamchip\.de|provideo-names|TESTPLAN|AGENTS\.md|CONTRIBUTING|TODO\.md|dct hooks|Jenkins|zephyr|phoenix|visca_map_|refs/for'
soft='internal|bsp'
if hits=$(git -C "$work" grep --cached -n -I -i -E "$hard" -- . ':!yarn.lock'); then
	echo "LEAK CHECK FAILED:" >&2; echo "$hits" >&2; exit 1
fi
if hits=$(git -C "$work" grep --cached -n -I -i -E "$soft" -- . ':!yarn.lock'); then
	echo "-- review these (soft patterns) --"; echo "$hits"
fi

echo "-- release tree vs upstream --"
git -C "$work" diff --cached --stat release

if [[ $dry == 1 ]]; then
	echo "dry run: nothing committed"
	exit 0
fi

# 5. One commit on `release`, internal provenance tag on the Gerrit commit.
msg="Release v$version"
body=$(git show "$src:CHANGELOG.md" | awk -v v="## $version" '$0 == v { on = 1; next } /^## / { on = 0 } on')
[[ -n ${body//[$' \t\n']/} ]] || { echo "no notes: add a '## $version' section to CHANGELOG.md" >&2; exit 1; }
msg+=$'\n\n'$body
git -C "$work" commit -q -m "$msg"
new=$(git -C "$work" rev-parse HEAD)
git -C "$work" checkout -q --detach   # frees `release` for the branch update
git branch -f release "$new"
git tag "v$version-internal" "$src"

cat <<MSG
Created release $new (internal tag v$version-internal on ${src:0:12}).
Review:   git push origin release:refs/for/release
Publish:  git push <public-url> release:main
          git tag v$version release && git push <public-url> v$version
MSG
