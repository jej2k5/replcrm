# Security policy

## Reporting a vulnerability

Report privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Private vulnerability reporting is enabled for this repository (verified 2026-11-23); reports are visible only to the maintainers until a fix is coordinated. Please do not open public issues or pull requests for security problems, and never include live credentials in a report. GitHub's [reporting guidance](https://docs.github.com/en/code-security/concepts/vulnerability-reporting-and-management/coordinated-disclosure) explains the process.

## Supported versions

The latest `main` branch is the current development baseline. There is no published supported-release or long-term-support matrix and no guaranteed security backport policy. ReplicaStore v1 is a persistence contract version, not a ReplCRM release or security-support promise.

## Coordinated response

Please allow private coordination before public disclosure. A report should include affected commit, source/store, impact, minimal synthetic reproduction and redacted evidence. Do not send production datasets or secrets. The maintainer will triage, discuss impact/fix/testing, coordinate disclosure and credit with the reporter where appropriate. No response or remediation SLA is promised.

Report only against systems you are authorized to test. Do not exploit another operator's CRM, database or optional destination. Rotate exposed credentials through the owning system; project issues are not a credential-revocation channel.

## Security-sensitive scope

Credential/token handling, OAuth/JWT/encryption in optional integrations, dynamic projection identifiers/queries, deployment scoping, reference identity, checkpoint/retry ordering, dependency supply chain, CI permissions and container distribution are security-sensitive. Optional integrations have separate credentials and trust boundaries; the core must remain usable without them. Fixture tests do not certify operational security, live replication or database upgrades.
