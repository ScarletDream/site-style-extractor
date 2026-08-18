# Security

## Supported boundary

Site Style Extractor is intended for public, unauthenticated pages in a fresh isolated browser context. Do not provide cookies, a personal browser profile, signed URLs, bearer tokens, private hosts, or authenticated pages.

The collector applies best-effort SSRF defenses: it rejects loopback, private, link-local, special-use, and malformed destinations; resolves hostnames under a per-run policy; scrubs URL secrets from persisted output; and rechecks browser requests. This is not a complete network sandbox.

The beta bounds traversal and evidence sampling but does not yet impose a hard process-wide wall-clock, memory, or downloaded-byte ceiling. Use an external process timeout and container/OS resource limits when scanning an untrusted page.

Representative interaction is deliberately narrow. It blocks non-GET/HEAD requests, popups, and post-load navigation. A GET request can still be incorrectly implemented with a server-side side effect, so use interaction replay only on public disposable state.

Docker is an installation boundary, not a security boundary. Do not mount credentials, browser profiles, home directories, Docker sockets, or unrelated writable paths into the container.

## Data handling

- Captures can contain text and images visible on the target page. Review outputs before sharing them.
- Query values, fragments, and URL credentials are redacted, but target page content itself is not a secret scrubber.
- Do not commit real third-party screenshots or capture output to this repository.
- Delete or archive scan staging directories after validating the final package.

## Reporting a vulnerability

Do not publish a working exploit in a public issue. Once the public GitHub
repository enables Private Vulnerability Reporting, use its **Security → Report a
vulnerability** form. Include the affected version, reproducible input, observed
impact, and a minimal sanitized artifact.

Before that private channel is enabled, this beta is not ready for public release.
Do not send secrets through a public issue or commit them to a reproduction.
