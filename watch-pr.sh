#!/bin/sh
while true; do
  m=$(gh pr view 1316 --json state --jq '.state' 2>/dev/null)
  if [ "$m" = "MERGED" ]; then echo "MERGED: PR #1316 landed on main"; break; fi
  if [ "$m" = "CLOSED" ]; then echo "CLOSED: PR #1316 closed without merging"; break; fi
  red=$(gh pr checks 1316 --json name,state --jq '.[] | select(.state=="FAILURE" or .state=="ERROR" or .state=="CANCELLED" or .state=="TIMED_OUT") | "RED: \(.name)"' 2>/dev/null | sort | tr '\n' ' ')
  if [ -n "$red" ]; then echo "$red"; break; fi
  sleep 60
done
