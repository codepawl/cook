# Third-party notices

Cook is MIT licensed (see [LICENSE](./LICENSE)). Parts of the `cycles` kernel are translations of code from Blender Cycles and Open Shading Language, which are under other licences. The package licence expression is `MIT AND Apache-2.0 AND BSD-3-Clause`. The full Apache License 2.0 is in [LICENSE-APACHE](./LICENSE-APACHE); the BSD 3-Clause text is below.

## Files with a licence header other than MIT

Each file below carries the SPDX header quoted next to it. The copyright lines are copied exactly from the headers.

### Apache-2.0, Blender Foundation

```
SPDX-FileCopyrightText: 2011-2022 Blender Foundation
SPDX-License-Identifier: Apache-2.0
```

- `src/cycles/camera.wgsl`
- `src/cycles/filter.wgsl`
- `src/cycles/filter_table.rs`
- `src/cycles/integrator.wgsl`
- `src/cycles/light_tree.wgsl`
- `src/cycles/lights.wgsl`
- `src/cycles/sampler.wgsl`
- `light-tree-v2.mjs`

```
SPDX-FileCopyrightText: 2011-2026 Blender Foundation
SPDX-License-Identifier: Apache-2.0
```

- `src/cycles/abi.wgsl`
- `src/cycles/bootstrap_main.wgsl`

### BSD-3-Clause and Apache-2.0, Sony Pictures Imageworks and Blender Foundation

These files adapt code from Open Shading Language and Blender Cycles.

```
SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
SPDX-FileCopyrightText: 2011-2026 Blender Foundation
SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
```

- `src/cycles/bsdf_coat.wgsl`
- `src/cycles/bsdf_glass.wgsl`
- `src/cycles/bsdf_microfacet.wgsl`
- `src/cycles/closure.wgsl`
- `src/cycles/luts.rs`

```
SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al. All Rights Reserved.
SPDX-FileCopyrightText: 2011-2022 Blender Foundation
SPDX-License-Identifier: BSD-3-Clause AND Apache-2.0
```

- `src/cycles/bsdf_diffuse.wgsl`

### BSD 3-Clause licence of the Sony Pictures Imageworks code

Copyright (c) 2009-2010 Sony Pictures Imageworks Inc., et al.
All Rights Reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are
met:

* Redistributions of source code must retain the above copyright
  notice, this list of conditions and the following disclaimer.
* Redistributions in binary form must reproduce the above copyright
  notice, this list of conditions and the following disclaimer in the
  documentation and/or other materials provided with the distribution.
* Neither the name of Sony Pictures Imageworks nor the names of its
  contributors may be used to endorse or promote products derived from
  this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
"AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

### Apache License 2.0 of the Blender Foundation code

The Apache License, Version 2.0 applies to the Blender Cycles code listed above. Its full text is in [LICENSE-APACHE](./LICENSE-APACHE).

## Rust crates (direct dependencies)

The addon is built from the crates named in `Cargo.toml`, at the versions pinned in `Cargo.lock`. The licences below are the ones the crates declare on their release pages; they were not re-checked against the pinned versions here. They are not part of the npm package (it ships source, and the addon is built on the user's machine).

| Crate | Declared licence |
| :--- | :--- |
| `bytemuck` | Zlib OR Apache-2.0 OR MIT |
| `libloading` | ISC |
| `napi` | MIT |
| `napi-derive` | MIT |
| `pollster` | Apache-2.0 OR MIT |
| `wgpu` | MIT OR Apache-2.0 |
| `napi-build` (build dependency) | MIT |

A full list of every crate in the build, with its licence text, is generated (for example with `cargo about`) and added to this file before any prebuilt binary is published.

## Open Image Denoise

Cook does not contain Open Image Denoise (Apache-2.0). `createNativeOidnDenoiser` loads its shared library at run time from a path the caller gives, so the library is the caller's to obtain and licence.
