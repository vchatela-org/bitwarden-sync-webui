#!/bin/sh
# Stand-in for `bw export --password` under piped (non-TTY) stdin: the real CLI's
# inquirer password prompt can't do an in-place terminal redraw there, so it re-emits
# its "prompt + cursor-movement" escape sequence once per byte of piped input, to
# stderr. This mimics that spam so bwCli.test.ts can verify runBw collapses it.
i=0
while [ $i -lt 5 ]; do
  printf '? Export file password: [input is hidden] \033[42D\033[42C\033[2K\033[G\n' 1>&2
  i=$((i + 1))
done
echo 'Saved /backups/export.json' 1>&2
exit 0
