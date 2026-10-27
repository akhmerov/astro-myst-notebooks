# Local runtime security

The linux-64 Pixi environments retain Python 3.13 and default Node 24. Runtime
floors are Python 3.13.18, Node 24.22.1, and OpenSSL 3.6.5. OpenSSL and Expat
constraints apply explicitly to both default and interop because interop does
not inherit default dependencies. CA certificates and certifi remain locked to
2026.10.19.

The 2026-10-26 lock update keeps notebook and application tool versions and
nonruntime artifacts unchanged except for the required runtime closure:
Python/libpython/cpython/python-gil, c-ares 1.34.9, SQLite 3.54.1, and libuuid
2.42.4 where required. The newer Node drops its shared Brotli dependencies;
interop retains its existing ICU and libstdcxx artifacts by keeping the
SQLite build that uses ICU.

Expat is locked to 2.9.0 (hd2095e1_0) in both native environments, with
explicit libexpat >=2.9.0,<3 floors in default and independent interop.
The 2026-10-27 followup replaces only that artifact and its two environment
references; every other artifact record and environment composition is retained.
The linux-64 availability gap observed on 2026-10-26 is historical: the verified
2.9.0 archive is now installed in both native prefixes.

These floors cover the native Pixi runtimes. Micromamba 2.9.0 links no dynamic
OpenSSL library and contains an OpenSSL 3.5.7 version string. Its embedded TLS
patch status is unverified and is not changed by upgrading shared OpenSSL.
Existing generated Xeus WASM kernel metadata identifies Python 3.13.1; those
artifacts require separate assessment and rebuilding. Their embedded
OpenSSL/Expat scope was not established. Browser binaries, existing services,
generated documentation, consumers, and deployed sites were not updated.

Validation on 2026-10-26: both installed Python environments and default Node
were queried directly and their OpenSSL/Expat linkage inspected. WIP and
committed-source snapshots each passed type checking and 48 package tests;
the committed-source snapshot also passed 8 autodoc/interop tests. Both used
the existing checkout's node_modules, without npm dependency changes. The
exact proposed manifest/lock passed `pixi lock --check --offline`. Builds and
test fixtures ran in disposable copies under the shared install lock with
a two-CPU limit, preserving the active checkout's generated artifacts.

Validation on 2026-10-27: the exact proposed index manifest/lock and working
manifest/lock pass offline checks and locked installs of both environments.
A separate fresh offline resolve with every native version/build pinned retains
all 94 default and 24 interop artifact URLs and SHA256 digests. The public Expat
archive, complete metadata, and payload digests were verified before installing.
Both candidate and original-prefix Python/C API probes verify Expat 2.9.0,
loaded library maps, XML/CDATA callbacks, malformed XML rejection, and the
upstream UTF-16LE epilog regression whole, split at 17 bytes, and byte by byte.
Python 3.13.18, default Node 24.22.1, and OpenSSL 3.6.5 are retained.

A clean HEAD source snapshot passed the existing static extraction test and
three dependency-free runtime-cache tests. A tiny synthetic notebook executed
through the tracked native Python adapter, checking kernel identity and state.
The prior 48 package / 8 autodoc-interop suite result above was not repeated:
shared node_modules differs from HEAD in launder and sanitize-html; broader
test commands also build browser assets, pack/install fixtures, or start an HTTP
server and build consumers. No npm install, dependency fetch, browser/WASM or
documentation build, consumer integration, experiment execution, or service
was used. The cache helper used only the verified TypeScript 6.0.3 compiler.
All package work ran under the retained shared lock on CPUs 0 and 1; existing
WIP and the four unstaged purls metadata edits remain outside the commit.
