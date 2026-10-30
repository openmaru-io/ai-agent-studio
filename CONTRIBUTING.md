# Contributing to CogentAI AI Agent Studio

Thank you for your interest. Read this page before you open an issue or a pull request (PR).

## Issues

- Use issues for bugs, questions and feature requests.
- For a large feature, open an issue first and agree on the design. Then start the PR. This prevents work that we cannot accept.
- Do not report security problems in issues. See `SECURITY.md`.

## Pull requests

### Sign off every commit (DCO)

Each commit must have a `Signed-off-by` line. The line shows that you agree to the
[Developer Certificate of Origin 1.1](https://developercertificate.org/): you wrote the change, or you have the right to submit it under the Apache License 2.0.

```sh
git commit -s -m "Fix the model list when the key is empty"
```

The line must use your real name and an email address that you can receive mail at:

```
Signed-off-by: Your Name <you@example.com>
```

A check on each PR fails when a commit has no `Signed-off-by` line.

### How we accept a PR

This GitHub repository is a public snapshot of our internal repository. We do not merge PRs on GitHub.

1. We review the PR on GitHub. The PR checks run the tests and the DCO check.
2. When the PR is ready, we apply it to the internal repository. You stay the author of the commit, and your `Signed-off-by` line stays.
3. The next public snapshot includes your change. The snapshot commit names you as a co-author (`Co-authored-by`).
4. We close the PR with a comment that names the snapshot, and add the label `merged-via-snapshot`.

If the internal code changed after the last snapshot, we can ask you to update the PR to the latest snapshot.

### Before you open a PR

Run the checks that apply to your change:

```sh
make test-python                 # server tests (Python)
cd ui
npm run lint
npx tsc --noEmit -p .
npx vitest run
npm run build                    # includes the air-gap check of the build output
```

- Add or change tests in the same PR as the code.
- Keep the PR small and about one thing.
- For screen text, change both the Korean (`ui/src/i18n/ko`) and the English (`ui/src/i18n/en`) files.
- If you change `README.md`, change `README.ko.md` in the same PR (and the opposite).

## License

By contributing, you agree that your contribution is licensed under the Apache License 2.0 (see `LICENSE`).
