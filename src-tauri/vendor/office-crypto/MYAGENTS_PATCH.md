# MyAgents adapter patch

This directory is the crates.io `office-crypto` `0.3.0` source (MIT).

MyAgents carries one narrow behavioral patch: the two explicit legacy DOC
RC4/RC4 CryptoAPI password-verifier failures return `DecryptError::InvalidPassword`
instead of the crate's shared `InvalidStructure` variant. This lets the Worker
map a verified wrong password to `DOCUMENT_PASSWORD_INVALID` while preserving
truncated or structurally corrupt containers as `DOCUMENT_MALFORMED`.

No parser, cipher, container, or decrypted-output behavior is changed.
