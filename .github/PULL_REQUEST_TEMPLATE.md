## What changed and why

Describe the problem and resulting behavior.

## Validation

List commands actually run, results and what remains unverified. Distinguish fixture, compilation and live runtime evidence.

## Architecture and compatibility

Explain source/store boundaries, contract impact, environment/CLI/consumer changes and any upgrade requirements. Do not silently add a migration or make a planned capability look implemented.

## Documentation

Link updated docs/changelog, or explain why none are needed.

## Review checklist

- [ ] Changes are focused; unrelated local work is excluded.
- [ ] Tests relevant to the change passed; new stores pass the same shared ReplicaStore contract suite.
- [ ] Core remains free of concrete source/store/database dependencies.
- [ ] No credentials, private endpoints, proprietary material or real customer data are included.
- [ ] Copied/adapted/generated material has its provenance, license and attribution documented.
- [ ] Compatibility and documentation impacts are described.
- [ ] Contribution commits have my DCO sign-off (`git commit -s`).
