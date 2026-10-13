#!/usr/bin/env bash
# Shares your Claude plan's usage with Agent Orrery. Claude Code hands every status line its plan
# limits; this writes them, and only them, to ~/.claude/orrery/usage.json for the dashboard to read.
#
# Use it as your status line: it prints "5h 65% · 7d 40%". Or, from a status line of your own, pass
# it the same input and ignore what it prints:
#   printf '%s' "$input" | bash ~/.claude/orrery-usage.sh >/dev/null
#
# Needs jq. Plans without limits (an API key) write nothing.
set -uo pipefail

input=$(cat)
dir="$HOME/.claude/orrery"

# Each window's used percentage and reset time, and when they were seen. Nothing else.
usage=$(printf '%s' "$input" | jq -c '
  def window: if type == "object" then {used_percentage, resets_at} else null end;
  select(.rate_limits != null)
  | {at: now, five_hour: (.rate_limits.five_hour | window), seven_day: (.rate_limits.seven_day | window)}' 2>/dev/null)

if [ -n "$usage" ]; then
    # Written beside the file, then moved over it, so the dashboard never reads half of one.
    mkdir -p "$dir" && printf '%s\n' "$usage" > "$dir/usage.json.$$" && mv "$dir/usage.json.$$" "$dir/usage.json"
fi

printf '%s' "$input" | jq -r '[
  (.rate_limits.five_hour.used_percentage // empty | "5h \(round)%"),
  (.rate_limits.seven_day.used_percentage // empty | "7d \(round)%")
] | join(" · ")' 2>/dev/null
