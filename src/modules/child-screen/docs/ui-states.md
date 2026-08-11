# Child screen UI state matrix

The matrix defines renderer-independent states. Colors, incidental spacing, and private Pi object fields are intentionally excluded.

| Product state | Main region | Child region | Footer | Allowed actions |
|:--|:--|:--|:--|:--|
| No records and no delivery state | normal Main | absent | folded/hidden | normal editor actions |
| Records, expanded | sticky Main summary | list visible | extension-owned rows only | `Alt+A` collapse, `Alt+M` from active Child |
| Records, folded | normal Main | list hidden | compact Subagent summary | `Alt+A` expand |
| Selected Child | suppressed pending/status projection | transcript and input route visible | preserved owner content | prompt, `Alt+M`, lifecycle-safe navigation |
| Blocked Child interaction | local blocked notice | Child remains selected | local replacement summary | return or resolve input |
| Regular renderer | unchanged ownership contract | same snapshot | same snapshot | renderer translation only |
| Fullscreen renderer | unchanged ownership contract | same snapshot | same snapshot | renderer translation only |
| Ownership conflict or unknown layout | no partial mutation | Child not activated | original rendering retained | fail closed |

The persisted display preference affects only a newly created runtime. `Alt+A` owns the current runtime choice after initialization.
