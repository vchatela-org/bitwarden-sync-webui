#!/bin/sh
# Stand-in for the bw CLI used by bwCli.test.ts: prints a fake vault item dump to
# stdout (as `bw list items` would) and a diagnostic line to stderr, then exits 0.
echo '[{"name":"Example Site","login":{"username":"alice","password":"hunter2"}}]'
echo 'a diagnostic warning' 1>&2
exit 0
