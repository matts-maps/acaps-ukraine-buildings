# Ukraine Damages Auto-Updater

This repository automatically updates the Ukraine Damages dataset from the ACAPS API every week.

## Setup

1. Create a GitHub repository.

2. Upload your existing CSV to:

   data/ukraine-damages.csv

3. Add a GitHub Secret:

   ACAPS_API_TOKEN

4. Enable GitHub Actions.

5. Run the workflow manually once from the Actions tab.

## Output

The workflow updates:

data/ukraine-damages.csv

every Monday at 00:00 UTC.

## Manual Run

Actions → Update Ukraine Damages → Run workflow
