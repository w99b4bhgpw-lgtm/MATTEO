#!/bin/sh
cd "$(dirname "$0")"
ruby server.rb &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null' EXIT INT TERM
sleep 1
open "http://localhost:4173"
wait "$server_pid"
