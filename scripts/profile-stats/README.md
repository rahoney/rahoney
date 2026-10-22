# Profile statistics maintained in this repository

`generate.mjs` uses only built-in Node.js modules and the GitHub GraphQL API.
There is no npm install, remote script, or third-party statistics action.
GitHub's official checkout action uses the repository-scoped built-in token;
`PROFILE_STATS_TOKEN` is supplied only to the local generation step.

## What is counted

- The total and daily 3D calendar come directly from GitHub's contribution calendar for the last year.
- Commit, issue, pull request, review, and repository creation counts are separate official contribution totals.
- Languages count commit contributions grouped by each repository's **primary language**.
  They do not identify the language of individual changed files or measure lines of code.
- The chart displays the top five languages, aggregates remaining known languages as `Other languages`,
  and separately labels commits without language metadata as `Unclassified`.
  Missing metadata can be caused by token access restrictions, repositories without a primary language,
  or GitHub's maximum of 100 repositories for the grouped contribution query.
- Private repository names, source files, and raw API responses are never written into the SVGs or logs.
  Aggregated language names and counts are public in the generated images.
- Stars and forks are summed over all accessible repositories owned by the profile account.

## Token and write boundaries

The only network destination in the local script is `https://api.github.com/graphql`.
Every request is a GraphQL **query**; there are no mutations or repository write calls.
Redirects are rejected, requests time out, and errors do not print response bodies or credentials.
Only the two green SVG files under `profile-3d-contrib/` are written and staged for commit.
The personal statistics token is not used by checkout or the commit/push step.

`read:user` can enable private contribution totals. Private repository language metadata
also requires access to the corresponding repositories. A classic `repo` token has broader write
permissions than this generator needs; the script itself does not use those write permissions.
Where supported, prefer a fine-grained token restricted to the required repositories with read-only
repository access and the account permissions needed for contribution queries. GitHub organization
policies and token capabilities can affect availability; validate totals after changing tokens.

## Run

GitHub Actions generates the images daily, manually, and when these scripts or the workflow change.
The token stays in the repository's `PROFILE_STATS_TOKEN` Actions secret.

For local development, run `node --test scripts/profile-stats/generate.test.mjs`.
To generate with live data, supply `PROFILE_STATS_TOKEN` and `USERNAME` as environment variables,
then run `node scripts/profile-stats/generate.mjs` from the repository root.
No token values belong in committed files.
