# Security

## Reporting a problem

Report a vulnerability through GitHub private vulnerability reporting for this repository (the "Report a vulnerability" button on the Security tab). Do not open a public issue for it. Include the Cook version, what you did and what happened. A first reply comes within about 7 days.

## What to expect from Cook

- **Pack files are untrusted input.** `decodePackFile` and `cook render` read a `.cookpack` file the way they would read a download: every length, offset and count is checked against the file size before anything is allocated or read, and a damaged file is refused with an error that names the problem. A pack file holds scene data only and never runs code. A report that a crafted pack file crashes Cook, reads outside the file or allocates far more than the file holds is a security report.
- **A pack can still ask for a lot of work.** A valid pack can describe a large scene, and `cook render` takes whatever size and sample count you give it. Use `--max-seconds` on files you did not make.
- **The OIDN library path is loaded as code.** `createNativeOidnDenoiser({ libraryPath })` opens that shared library into the process. Pass only a library you trust. The same goes for `COOK_ADDON_PATH`, which names the native addon that `findNativeAddon` loads.
- **No install scripts.** Installing the package never compiles or runs anything. `npm run build` runs `cargo build`, which downloads the crates in `Cargo.lock`; run it only where you trust that.
