# The dashboard's configured output directory

`config/ops.json` points `dashboard.outputPath` here, and the command that
produces the page REFUSES to create a directory it was pointed at: a page
written somewhere nobody expected is a page nobody reads. So this directory is
committed, and the page it holds is not - the page is derived from the store and
is regenerable at any time.

Produce it with:

    HISTORY_DATABASE_URL=postgres://... node packages/ops/src/cli/dashboard.ts

Nothing listens. The command writes a file and exits, and the owner opens that
file.
