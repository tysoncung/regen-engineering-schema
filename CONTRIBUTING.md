# Contributing

## Releasing

Publishing is tag-driven, never automatic on push. A version number is a promise to strangers: once `0.3.1` exists it can never mean anything else, and an accidental publish cannot be withdrawn.

Two ways, both equivalent:

```bash
# bump "version" in package.json, commit, then either:
git tag v0.3.1 && git push --tags          # tag push
gh release create v0.3.1 --generate-notes  # or draft a GitHub release
```

Dry run first if you want to see what would happen without publishing anything:

```bash
gh workflow run publish.yml -f dry_run=true
```

The workflow runs the tests, refuses to publish if the tag disagrees with `package.json`, scans the tarball for credential-shaped files, and publishes with provenance. It needs an `NPM_TOKEN` repository secret (a granular token with write access to this package and bypass-2FA); without one it skips cleanly.


Governance, the REP process, house style, and how to report a field report all live in one place, so there is only one copy to keep true:

**https://github.com/tysoncung/regen.engineering/blob/main/CONTRIBUTING.md**

Code of conduct: https://github.com/tysoncung/regen.engineering/blob/main/CODE_OF_CONDUCT.md

## Short version for this repository

- Bug fixes, clarifications, examples, and adapters: open a pull request.
- Changes to the schema or the methodology itself: open an issue, then a [REP](https://github.com/tysoncung/regen.engineering/tree/main/reps).
- Ran the Regeneration Test on your own code? Tell us what happened, especially if it failed. That is the most useful contribution available.
