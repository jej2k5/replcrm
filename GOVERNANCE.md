# Governance

ReplCRM is an independent project. It is not governed by or affiliated with a software foundation or vendor.

## Maintainer

The initial maintainer is **[@jej2k5](https://github.com/jej2k5)**, the source-project repository owner. This identifies the project role, not a legal determination of ownership of every contribution. No steering committee or additional maintainer is claimed. Private contact and final publication tasks in the [readiness report](docs/oss-clean-release-readiness.md) remain open.

## Decisions and review

Use issues and PRs for proposals and evidence. The maintainer makes merge decisions after considering correctness, contract neutrality, compatibility, maintenance cost and test results. Significant architectural decisions should have a durable rationale in `docs/` before implementation. ReplicaStore v1 changes require explicit compatibility discussion and shared-contract coverage; implementation convenience is not grounds to weaken invariants.

A maintainer reviews contributions, DCO sign-off, provenance, tests and docs. Small fixes need a clear PR, not a committee process. Maintainers should explain rejected proposals and remain open to a smaller alternative or new evidence. Contributors retain the rights established by their work and applicable licenses.

## Releases and permissions

The maintainer authorizes release/tag creation and artifact publication after documented validation. Repository visibility changes are a separate explicit decision. A contract version is not a product release. Public-readiness blockers must be resolved before making the repository public. Protect publishing credentials and tags; untrusted PR checks must remain credential-free.

## Growing maintainership

Add maintainers deliberately based on sustained review, reliability, architectural understanding and respectful conduct, not sponsorship or vendor affiliation. Record additions and permission changes publicly when appropriate. Give departing maintainers a documented transition; remove access that is no longer needed, particularly for security or inactivity, with a proportionate explanation that preserves private information.

## Conflicts and conduct

Discuss technical disagreements with reproducible evidence and document the decision. Ask for reconsideration through an issue/PR when new evidence exists. Conduct concerns follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) and its private enforcement channel, which must be completed before publication. While the project has one maintainer, there is no independent appeals body; do not imply otherwise. A future expansion should establish an appropriate conflict-of-interest/appeal route.
