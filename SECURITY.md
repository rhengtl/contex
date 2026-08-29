# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:

> **Security** tab → **Report a vulnerability**

That opens a private channel visible only to the maintainer. You will get an
acknowledgement, and a decision on whether it is in scope, as soon as it is
read — this is a personally maintained project, so please allow a few days
rather than a few hours.

## What to include

The more of this you can give, the faster it can be confirmed:

- What you were able to do that you should not have been able to do.
- The steps to reproduce it, and the URL or route involved.
- Whether it needs an account, and whether it affects other users' data.
- The commit or deployed version you tested against.
- Any proof-of-concept request, script or file — please redact real credentials.

## Please do not

- Publicly disclose the issue before it has been addressed.
- Run automated scanners, load tests or brute-force attempts against a
  deployed instance. Test against a local checkout instead; the README explains
  how to run one.
- Access, modify or retain data belonging to anyone else. If you encounter
  someone else's data while investigating, stop and say so in the report.

## Scope

In scope:

- The Flask application in `contex/` — authentication, session handling, the
  upload and conversion routes, the preview and download routes.
- The Firestore security rules in `firestore.rules`.
- The container definition in `Dockerfile` and what it exposes.
- Anything that lets one user reach another user's documents or history.

Known and already documented, so not a new finding — see the *Known
limitations* section of [DEPLOYMENT.md](DEPLOYMENT.md):

- Rate limiting is per process and weakens as instances scale out.
- Email verification is not required at sign-up.
- Sign-up reveals whether an address is already registered.
- Conversion results are held in memory per process for one hour.

Out of scope:

- Vulnerabilities in Firebase, Google Cloud, Gemini or other third-party
  services. Report those to the vendor.
- Findings that require an already-compromised machine or an already-stolen
  credential.
- Missing hardening headers on a route that serves no user data, absent a
  demonstrated impact.

## Supported versions

This project ships from `master`. Fixes land there; there are no maintained
release branches.

## A note on credentials

If you believe a credential has been exposed — in this repository, in a
container image, or in a deployed response — say so in the report and treat it
as urgent. The keys that matter here are the Firebase Admin SDK service
account, the Flask session secret and the Gemini API key. None of them is
committed, and both `.gitignore` and `.dockerignore` are written to keep it
that way.
