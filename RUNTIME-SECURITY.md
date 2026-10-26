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

Expat is locked to 2.8.5 in both environments. Conda-forge had no linux-64
libexpat >=2.9.0 when checked on 2026-10-26; the 2.8.5 manifest floor records
an interim mitigation, not complete closure of the Expat target.

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
