# Contributing

## Build and test

Node 20.19 or newer. Rust (stable) and a Vulkan adapter with ray queries are needed only for the addon and the GPU tests.

```sh
node --test              # pure JavaScript tests; the GPU tests in tests/gpu skip when the addon is not built
node build.mjs           # cargo build --release, copies build/render-native.node (needs Rust)
cargo test               # the Rust unit tests and tests/dispatch.rs
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

## How 67js uses Cook

67js ([codepawl/67.js](https://github.com/codepawl/67.js)) depends on this package at one pinned commit (`git+https://github.com/codepawl/cook.git#<full sha>` in its `devDependencies`). A change here reaches 67js only when a pull request there moves the pin. When you change something 67js calls (the exports, `describeEngine`, the pack format), say so in the pull request so the pin can be moved with a matching change.
