# Contributing

## Build and test

Node 20.19 or newer. Rust (stable) and a Vulkan adapter with ray queries are needed only for the addon and the GPU tests.

```sh
node --test              # pure JavaScript tests; the GPU tests in tests/gpu skip when the addon is not built
node build.mjs           # cargo build --release, copies build/render-native.node (needs Rust)
node tools/run-cargo-tests.mjs # the Rust unit tests and tests/dispatch.rs (cargo test with the link flags a Node addon needs on Linux)
node --test              # again, now the GPU tests run too
```

On Windows build for MSVC (`build.mjs` already adds the target). Run `node tools/check-exports.mjs` to check that every `exports` target ships in the npm package.

## Rules

- Descriptive full names, one statement per line, small functions, comments only for a reason the code does not show.
- Tests in the same change as the code. Never weaken or skip a test to make it pass.
- Validate input at the public boundary with errors that say what failed and what to pass instead.
- The packers (`pack-input.mjs`, `pack-input-v2.mjs`, `job-input.mjs`, `light-tree-v2.mjs`, `texture-mips.mjs`) and `pack-file.mjs` import nothing from Node, so a browser page can run them. Keep it that way.
- Do not claim Cook is faster or more accurate than another renderer without a measurement you can name.

## The pack revision

`PACK_REVISION` in `pack-input-v2.mjs` says which packer wrote a FORMAT-v2 input. Bump it by one in the same change that makes an input packed before it render differently or fail: a field changes meaning, a table gains required content, a flag changes its default. A change that older inputs render correctly under does not bump it. After a bump:

1. Set the oldest revision the host still reads in `engine.mjs` (`OLDEST_READABLE_PACK_REVISION`) if the host can no longer read the old ones.
2. Run `node tools/make-fixture-pack.mjs` and commit the new `fixtures/room.cookpack`; a test checks that the committed fixture equals a fresh build.
3. Say what changed in the section "Revision" of `FORMAT-v2.md`.

## How Crucible uses Cook

Crucible ([codepawl/crucible](https://github.com/codepawl/crucible)) depends on this package at one pinned commit (`git+https://github.com/codepawl/cook.git#<full sha>` in its `devDependencies`). A change here reaches Crucible only when a pull request there moves the pin. When you change something Crucible calls (the exports, `describeEngine`, the pack format), say so in the pull request so the pin can be moved with a matching change.

## Release

A release gives Windows x64 and Linux x64 users a prebuilt addon, so they need no Rust (`cook fetch-addon`).

1. Set the new version in `package.json` in a pull request, and merge it.
2. Tag the merged commit on `main` with `v<version>` and push the tag: `git tag v0.1.0 <sha>` and `git push origin v0.1.0`.
3. The `Release` workflow builds both addons, checks that they load, and attaches each one and its `.sha256` file to the release of the tag. It stops when the tag does not equal the version in `package.json`.
4. Update the version in the install steps of the README.
