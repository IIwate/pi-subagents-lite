# Settings UI state matrix

The matrix is renderer-independent. Pi list widgets, keyboard events, and private layout ownership are platform concerns.

| Settings state | Snapshot meaning | Action result |
|:--|:--|:--|
| Root | `/agents` categories and current effective summaries | open category or leave |
| Category | Rows owned by policy modules | delegate a command or return |
| Current value | Saved/effective value and inactive management hint | open allowed choices |
| Pending update | Candidate value not yet committed | commit or cancel; no consumer sees it yet |
| Commit success | New value and affected future-call boundary | refresh snapshot through owner facade |
| Commit failure | Previous value remains effective | explicit local failure; no partial updates |
| Inactive limit | Saved but not currently actionable limit | explicit management path only |
| Prompt mode | Existing mode choice and custom-source availability | delegate to prompt/config owner; no prompt viewer |

Settings must not infer policy from row labels or duplicate owner decisions.
