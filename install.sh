#!/usr/bin/env bash
set -euo pipefail

# Install exactly one copy: Pi owns the package, and the CLI points at it.
# Before the npm release, use --git.
source_kind=npm
setup=yes
start=no
while (($#)); do
  case "$1" in
    --no-setup) setup=no ;;
    --start) start=yes ;;
    --git) source_kind=git ;;
    --help|-h) echo 'Usage: install.sh [--git] [--no-setup] [--start]'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done
pi_bin=${INKBOX_PI_BIN:-pi}
command -v "$pi_bin" >/dev/null || { echo 'Install Pi first: https://pi.dev/' >&2; exit 1; }
agent_dir=${PI_CODING_AGENT_DIR:-"$HOME/.pi/agent"}
if [[ "$source_kind" == git ]]; then
  "$pi_bin" install 'git:github.com/inkbox-ai/pi-plugin'
  package_dir="$agent_dir/git/github.com/inkbox-ai/pi-plugin"
else
  "$pi_bin" install 'npm:@inkbox/pi-plugin'
  package_dir="$agent_dir/npm/node_modules/@inkbox/pi-plugin"
fi
entry="$package_dir/bin/inkbox-pi.js"
[[ -f "$entry" ]] || { echo 'Pi uses a different package directory. Open Pi and run /inkbox for your CLI path.' >&2; exit 1; }
bin_dir=${INKBOX_PI_BIN_DIR:-"$HOME/.local/bin"}
mkdir -p "$bin_dir"
if [[ -e "$bin_dir/inkbox-pi" && ! -L "$bin_dir/inkbox-pi" ]]; then
  echo "Not replacing existing file: $bin_dir/inkbox-pi" >&2
  exit 1
fi
ln -sfn "$entry" "$bin_dir/inkbox-pi"
echo "Installed $bin_dir/inkbox-pi"
if [[ ":$PATH:" != *":$bin_dir:"* ]]; then echo "Add $bin_dir to PATH to run inkbox-pi by name."; fi
if [[ "$setup" == yes ]]; then
  if [[ -t 0 ]]; then "$bin_dir/inkbox-pi" setup
  elif [[ -r /dev/tty ]] && ( : </dev/tty ) 2>/dev/null; then "$bin_dir/inkbox-pi" setup </dev/tty
  else "$bin_dir/inkbox-pi" setup --print
  fi
fi
if [[ "$start" == yes ]]; then "$bin_dir/inkbox-pi" start; fi
