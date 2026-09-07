#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
set -euo pipefail
: "${ADVISOR_DIR:?}" "${GITHUB_WORKFLOW_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
out="${1:?output directory required}"
test -d "$ADVISOR_DIR/node_modules" && test ! -L "$ADVISOR_DIR/node_modules"
rm -rf -- "$out"
mkdir -p -- "$out/stage/bin"
case "$(tar --version 2>/dev/null | head -n 1)" in
  *"GNU tar"*) tar_kind="gnu" ;;
  bsdtar*) tar_kind="bsd" ;;
  *)
    echo "Unsupported tar implementation. Install GNU tar or bsdtar." >&2
    exit 1
    ;;
esac
if [[ "$tar_kind" == "gnu" ]]; then
  cp -a -- "$ADVISOR_DIR/node_modules" "$out/stage/node_modules"
else
  # bsdtar cannot flatten hard links while writing, so flatten every link in the staging copy.
  cp -RL -- "$ADVISOR_DIR/node_modules" "$out/stage/node_modules"
fi
for name in rg fdfind; do
  source_path="$(readlink -f "$(command -v "$name")")"
  test -f "$source_path" && test ! -L "$source_path"
  cp -- "$source_path" "$out/stage/bin/$name"
done
cp -- "$out/stage/bin/fdfind" "$out/stage/bin/fd"
printf '%s\n' "$GITHUB_WORKFLOW_SHA" >"$out/stage/workflow-sha"
printf '%s\n' "$GITHUB_RUN_ID" >"$out/stage/run-id"
printf '%s\n' "$GITHUB_RUN_ATTEMPT" >"$out/stage/run-attempt"
if [[ "$tar_kind" == "gnu" ]]; then
  (cd "$out/stage" && tar --dereference --hard-dereference --sort=name --mtime=@0 --owner=0 --group=0 --numeric-owner -cf ../runtime.tar .)
else
  find "$out/stage" -exec touch -h -t 197001010000.00 {} +
  (
    cd "$out/stage"
    LC_ALL=C find . -print0 \
      | LC_ALL=C sort -z \
      | tar --no-recursion --null --files-from=- --uid=0 --gid=0 --uname= --gname= --numeric-owner \
        --no-acls --no-fflags --no-mac-metadata --no-xattrs -cf ../runtime.tar
  )
fi
sha256sum "$out/runtime.tar" | awk '{print $1}' >"$out/runtime.sha256"
chmod 0600 "$out/runtime.tar" "$out/runtime.sha256"
if [[ -n "${GITHUB_OUTPUT:-}" ]]; then printf 'payload-sha=%s\n' "$(<"$out/runtime.sha256")" >>"$GITHUB_OUTPUT"; fi
rm -rf -- "$out/stage"
