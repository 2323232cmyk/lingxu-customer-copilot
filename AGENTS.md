# Public desktop source rules

- This repository is the sanitized Windows desktop application. Preserve its existing architecture and keep changes scoped.
- Do not add customer records, chat databases, account identifiers, private service addresses, tokens, model keys, signing material or internal handoff files.
- Use synthetic fixtures and reserved example domains. The desktop application generates editable suggestions; it does not automatically send WeChat messages.
- Keep the public user-data directory and installation identity separate. Do not migrate internal-product profiles or enable an unverified update service.
- Preserve third-party notices. Prepare native dependencies from verified public upstream sources, not personal machines or closed application packages.
- Run checks appropriate to the change. Type checks, synthetic tests, packaging, installed behavior and real service outcomes are distinct acceptance levels.
