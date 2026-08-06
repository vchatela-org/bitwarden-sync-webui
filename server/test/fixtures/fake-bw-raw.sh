#!/bin/sh
# Stand-in for `bw unlock --raw` / `bw login --raw`: prints a session-key-shaped
# value with NO trailing newline (the real CLI's --raw output has none), which
# lands in the flush-on-close code path in runBw rather than the per-line handler.
printf '%s' 'FakeSessionKeyThatLooksLikeBase64=='
exit 0
