#!/usr/bin/env bash
source $(git rev-parse --show-toplevel)/ci3/source_bootstrap

set -eou pipefail

cmd=${1:-}
[ -n "$cmd" ] && shift

# Must be in dependency order for releasing.
export js_projects="
  @noir-lang/types
  @noir-lang/noir_js
  @noir-lang/noir_codegen
  @noir-lang/noirc_abi
  @noir-lang/acvm_js
"
export js_include=$(printf " --include %s" $js_projects)

# Fake this so artifacts have a consistent hash in the cache and not git hash dependent.
export GIT_COMMIT="0000000000000000000000000000000000000000"
export SOURCE_DATE_EPOCH=0
export GIT_DIRTY=false
export RUSTFLAGS="-Dwarnings"

# Update the noir-repo and compute hashes.
function noir_sync {
  # The sync.sh script strives not to send anything to `stdout`, so as not to interfere with `test_cmds` and `hash`.
  DENOISE=0 denoise "scripts/sync.sh init && scripts/sync.sh update"
}

# Calculate the content hash for caching, taking into account that `noir-repo`
# is not part of the `aztec-packages` repo itself, so the `git ls-tree` used
# by `cache_content_hash` would not take those files into account.
function noir_content_hash {
  function noir_repo_content_hash {
    echo $(REPO_PATH=./noir-repo cache_content_hash $@)
  }
  with_tests=${1:-0}
  noir_hash=$(cache_content_hash .rebuild_patterns)
  noir_repo_hash=$(noir_repo_content_hash .noir-repo.rebuild_patterns)
  if [ "$with_tests" == "1" ]; then
    noir_repo_hash_tests=$(noir_repo_content_hash .noir-repo.rebuild_patterns_tests)
  else
    noir_repo_hash_tests=""
  fi
  echo $(hash_str $noir_hash $noir_repo_hash $noir_repo_hash_tests)
}

# Builds nargo, acvm and profiler binaries.
function build_native {
  set -euo pipefail
  local hash=$(noir_content_hash)
  if cache_download noir-$hash.tar.gz; then
    return
  fi
  cd noir-repo
  parallel --tag --line-buffer --halt now,fail=1 ::: \
    "cargo fmt --all --check" \
    "cargo build --locked --release --target-dir target" \
    "cargo clippy --target-dir target/clippy --workspace --locked --release"
  cd ..
  cache_upload noir-$hash.tar.gz noir-repo/target/release/{nargo,acvm,noir-profiler}
}

# Builds js packages.
function build_packages {
  set -euo pipefail
  local hash=$(noir_content_hash)

  if cache_download noir-packages-$hash.tar.gz; then
    cd noir-repo
    npm_install_deps
    # Hack to get around failure introduced by https://github.com/AztecProtocol/aztec-packages/pull/12371
    # Tests fail with message "env: ‘mocha’: No such file or directory"
    yarn install
    return
  fi

  cd noir-repo
  npm_install_deps

  # Hack to get around failure introduced by https://github.com/AztecProtocol/aztec-packages/pull/12371
  # Tests fail with message "env: ‘mocha’: No such file or directory"
  yarn install
  yarn workspaces foreach  -A --parallel --topological-dev --verbose $js_include run build

  # We create a folder called packages, that contains each package as it would be published to npm, named correctly.
  # These can be useful for testing, or to portal into other projects.
  yarn workspaces foreach  -A --parallel $js_include pack

  cd ..
  rm -rf packages && mkdir -p packages
  for project in $js_projects; do
    p=$(cd noir-repo && yarn workspaces list --json | jq -r "select(.name==\"$project\").location")
    tar zxfv noir-repo/$p/package.tgz -C packages
    mv packages/package packages/${project#*/}
  done

  # Find all files in packages dir and use sed to in-place replace @noir-lang with @aztec/noir-
  find packages -type f -exec sed -i 's|@noir-lang/|@aztec/noir-|g' {} \;

  cache_upload noir-packages-$hash.tar.gz \
    packages \
    noir-repo/acvm-repo/acvm_js/nodejs \
    noir-repo/acvm-repo/acvm_js/web \
    noir-repo/tooling/noir_codegen/lib \
    noir-repo/tooling/noir_js/lib \
    noir-repo/tooling/noir_js_types/lib \
    noir-repo/tooling/noirc_abi_wasm/nodejs \
    noir-repo/tooling/noirc_abi_wasm/web
}

# Export functions that can be called from `parallel` in `build`,
# and all the functions they can call as well.
export -f build_native build_packages noir_content_hash

function build {
  echo_header "noir build"
  # TODO: Move to build image?
  denoise ./noir-repo/.github/scripts/wasm-bindgen-install.sh
  if ! command -v cargo-binstall &>/dev/null; then
    denoise "curl -L --proto '=https' --tlsv1.2 -sSf https://raw.githubusercontent.com/cargo-bins/cargo-binstall/main/install-from-binstall-release.sh | bash"
  fi
  if ! command -v cargo-nextest &>/dev/null; then
    denoise "cargo-binstall cargo-nextest --version 0.9.67 -y --secure"
  fi

  parallel --tag --line-buffer --halt now,fail=1 denoise ::: build_native build_packages
  # if [ -x ./scripts/fix_incremental_ts.sh ]; then
  #   ./scripts/fix_incremental_ts.sh
  # fi
}

function test {
  echo_header "noir test"
  test_cmds | filter_test_cmds | parallelise
}

# Prints the commands to run tests, one line per test, prefixed with the appropriate content hash.
function test_cmds {
  local test_hash=$(noir_content_hash 1)
  cd noir-repo
  cargo nextest list --workspace --locked --release -Tjson-pretty 2>/dev/null | \
      jq -r '
        .["rust-suites"][] |
        .testcases as $tests |
        .["binary-path"] as $binary |
        $tests |
        to_entries[] |
        select(.value.ignored == false and .value["filter-match"].status == "matches") |
        "noir/scripts/run_test.sh \($binary) \(.key)"' | \
      sed "s|$PWD/target/release/deps/||" | \
      awk "{print \"$test_hash \" \$0 }"
  echo "$test_hash cd noir/noir-repo && GIT_COMMIT=$GIT_COMMIT NARGO=$PWD/target/release/nargo" \
    "yarn workspaces foreach -A --parallel --topological-dev --verbose $js_include run test"
  # This is a test as it runs over our test programs (format is usually considered a build step).
  echo "$test_hash noir/bootstrap.sh format --check"
}

function format {
  # Check format of noir programs in the noir repo.
  export PATH="$(pwd)/noir-repo/target/release:${PATH}"
  arg=${1:-}
  cd noir-repo/test_programs
  if [ "$arg" = "--check" ]; then
    # different passing of check than nargo fmt
    ./format.sh check
  else
    ./format.sh
  fi
  cd ../noir_stdlib
  nargo fmt $arg
}

function release {
  local dist_tag=$(dist_tag)
  local version=${REF_NAME#v}
  cd packages

  for package in $js_projects; do
    local dir=${package#*/}
    [ ! -d "$dir" ] && echo "Project path not found: $dir" && exit 1
    cd $dir

    jq --arg v $version '.version = $v' package.json >tmp.json
    mv tmp.json package.json

    deploy_npm $dist_tag $version
    cd ..
  done
}

# Bump the Noir repo reference on a given branch to a given ref.
# The branch might already exist, e.g. this could be a daily job bumping the version to the
# latest nightly, and we might have to deal with updating the patch file because the latest
# Noir code conflicts with the contents of the patch, or we're debugging some integration
# test failure on CI. In that case just push another commit to the branch to bump the version
# further without losing any other commit on the branch.
function bump_noir_repo_ref {
  branch=$1
  ref=$2
  git fetch --depth 1 origin $branch || true
  git checkout --track origin/$branch || git checkout $branch || git checkout -b $branch
  scripts/sync.sh write-noir-repo-ref $ref
  git add .
  git commit -m "chore: Update noir-repo-ref to $ref" || true
  do_or_dryrun git push --set-upstream origin $branch
}

case "$cmd" in
  "clean")
    # Double `f` needed to delete the nested git repository.
    git clean -ffdx
    ;;
  "ci")
    noir_sync
    build
    test
    ;;
  ""|"fast"|"full")
    noir_sync
    build
    ;;
  test_cmds|build_native|build_packages|format|test|release)
    noir_sync
    $cmd "$@"
    ;;
  "hash")
    noir_sync
    echo $(noir_content_hash)
    ;;
  "hash-tests")
    noir_sync
    echo $(noir_content_hash 1)
    ;;
  "make-patch")
    scripts/sync.sh make-patch
    ;;
  "bump-noir-repo-ref")
    bump_noir_repo_ref $@
    ;;
  *)
    echo "Unknown command: $cmd"
    exit 1
esac
