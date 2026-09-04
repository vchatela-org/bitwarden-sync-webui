#!/bin/sh
# Stand-in for a `bw` invocation that dies before it ever reads stdin — a rejected
# argument, or a prompt it decides it doesn't need. The parent is mid-write when the
# pipe's read end disappears, so its write fails with EPIPE. runBw must survive that.
echo 'Not enough arguments.' 1>&2
exit 1
