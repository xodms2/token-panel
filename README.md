# Token panel for Claude Code

Two rows above the message box that show, for the tab you're in:

```
5h 3% · week 88%  │  context 385k (39%) oversized · cache 59:44 · reread $0.077  │  $19.43 today
week resets Mon 09:00 · tab $37.75 ($0.13/msg) · 3 subagents $0.40, kept 120k out · last compact −280k   [Keep warm] [3h ▾] [Handoff] [Tabs] [⚙]
```

Two rows that keep their size. A figure that runs out of room is cut at the row's end, least useful last, instead of making the band taller.

- **5h / week**: your plan's usage limits (yellow from 70%, red from 90%).
- **context**: how much this conversation carries, and that as a share of the model's window (where Claude Code compacts on its own); it turns yellow and says *oversized* past a limit you set.
- **cache**: how long this tab's prompt cache stays alive. Every message rereads the whole conversation: cheap while the cache is alive, a full rebuild once it expires.
- **reread**: what the next message costs to read the conversation back in, warm or cold.
- **today**: spend across all your tabs today.
- **week resets**: when the weekly limit starts over.
- **tab**: what this tab has cost so far, and per message (input and output together).
- **subagents**: how many this tab ran, what they cost, and how much they read on their own: context the main tab never had to carry and reread.
- **last compact**: how much the last compaction took off; every later message rereads that much less.

Dollar figures are what the same tokens would cost at Anthropic's API list prices. A Pro or Max plan isn't billed this way, so read them as a yardstick for comparing tabs. The prices are a table in `reader/server.py`, current as of October 2026.

## Buttons

- **Keep warm [3h ▾]**: while on, the button turns into **Warm: 14:30** (press it to stop), and it sends one tiny message ("reply ok") a few minutes before the cache would expire, for as long as you pick. It never pings a tab that is already cold. Each ping shows in the conversation and counts a little toward your plan.
- **Handoff** (bright once the tab is oversized, dim before) and **`/handoff`**: asks Claude to update your project's documents and write a handoff note, so you can start a fresh tab.
- **`/compact`**: updates the documents first, then compacts. `/compact skip-docs` compacts straight away.
- **Tabs** or **`/tokens`**: a panel with your plan limits, this tab, and your other recent tabs.
- **⚙**: settings (Keep warm length, ping timing, the oversized limit, the document list).

## Which documents get updated

Put a plain list in **`.claude/handoff-docs.md`** inside each project, one item per line, for example:

```
- docs/roadmap.md: the schedule and the log
- docs/journal.md: today's entry
- Handoff note: handoff.md in the project root
- Do not commit; say if a commit is due.
```

Without that file, Claude updates whatever the project's CLAUDE.md and memory describe.

## Install

Needs **Python 3** on your PATH (`python` on Windows, `python3` on macOS and Linux). The panel uses it to read Claude Code's own logs.

At the prompt of a terminal session:

```
/plugin install token-panel --marketplace xodms2/token-panel
```

From a shell:

```
claude plugin install token-panel --marketplace xodms2/token-panel
```

In the desktop app: click **+** next to the prompt box, then **Plugins**, **Add marketplace** with `xodms2/token-panel`, then **Add plugin**.

New sessions show the line once it's installed.

## Updating

Run these two commands in a terminal, then open a new session:

```
claude plugin marketplace update token-panel
claude plugin update token-panel@token-panel
```

If `claude` isn't found (the desktop app keeps its own copy off the PATH), use the app's copy. On Windows, in PowerShell:

```
& "$env:APPDATA\Claude\claude-code\<version>\<build>\claude.exe" plugin marketplace update token-panel
```

and the same for the second command. Or ask Claude in any session to run the update for you.

## Privacy

Everything stays on your computer. The panel reads Claude Code's session logs under `~/.claude/projects/` and writes its cache and settings to `~/.claude/token-panel/`. Nothing is sent anywhere.

## Full dashboard (optional)

For a browser page with every project and tab, run the reader as a server and open http://127.0.0.1:8777:

```
python <plugin folder>/reader/server.py
```

The Tabs panel shows the exact command with your plugin folder filled in.
