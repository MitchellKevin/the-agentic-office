# Agent Office

A local, source-available observability app for [Claude Code](https://claude.com/claude-code), shown as a 3D office building in a small city.

- **Every project is a building.** Pick the one you want in the **Building** menu at the top left. The project's name hangs over the entrance.
- **Every floor is a department:** Development, Design, QA, or whatever you add. A building has a lobby with a reception desk, one glass-walled floor per department, and a roof with a sign showing the project's name next to the Agent Office logo.
- **A glass lift** runs up the outside of the building. Robots ride it when they move to another department, and when they go and talk to another department.
- **Around it:** a whole city grid. There are streets with traffic, crosswalks and traffic lights, plus pavements with street trees, lamps and parked cars. The buildings are office blocks, glass towers, brick apartments and shops with awnings, and the block in front of Agent Office is a fountain square. It all sits under a sky with drifting clouds that follows the time of day. The sun crosses the sky and turns golden at sunrise and sunset. At night the page goes dark, and the city gets stars, a moon and lit windows. The city is batched into a handful of draw calls, so it stays smooth.
- **Each Claude Code session is a robot at a desk** on its department's floor. Its eyes and antenna light show its status: cyan while working, flashing red when it needs you, blue on your turn, dimmed when idle.
- **Subagents are interns**: small robots with a badge, standing next to their parent's desk.
- **Robots can work as a team.** Give the departments one goal and they take turns on their own: each one works, then rides the lift to the next department and tells it, in a speech bubble, what it did. See [Teams](#teams-departments-working-together).

You start outside, looking at the whole building. Every floor has a tag on the facade with its department name and live dots for working and needs-you agents. Pick a floor in the menu on the left, or click it on the building, and the camera flies inside. The floors above and that floor's glass front are cut away, so you look straight in at the agents. **Building** in the menu flies back out.

| What you see | What it means |
|---|---|
| Typing at a glowing monitor | **working**. The speech bubble shows the current tool, e.g. `Edit server.js` |
| Standing up and waving, red **!** | **needs you**: a permission prompt, a question, or a plan to approve |
| Walking to the water cooler | **your turn**: it finished and is waiting for your next prompt |
| Slumped with a drifting **zzz** | **idle** for more than 30 minutes |
| Riding the lift with an orange **→ QA** tag | on its way to another department |
| A white speech bubble with a department name | what it says to another robot (team runs) |

Everything runs on your machine:

- no telemetry, no accounts, no outbound requests
- zero npm dependencies
- the 3D renderer is a few hundred lines of plain WebGL2 in [public/gl.js](public/gl.js). It renders in HDR with 4× MSAA, soft shadow maps, specular and rim lighting, bloom, ACES tone mapping and fog.
- every model is built in code from primitives (boxes, spheres, cylinders), with no third-party assets

## Quick start

Needs Node 20 or newer and a browser with WebGL2 (any current Chrome, Edge, Firefox or Safari).

```bash
npm start
# → http://localhost:4317
```

Open **http://localhost:4317** in a normal browser tab. Opening `public/index.html` directly, or through an editor's preview server, won't work: the page needs the live data stream from the Agent Office server.

No real sessions yet? **http://localhost:4317/?demo=1** runs simulated agents, approvals and a team run included. Use it to show the UI without exposing real work or spending tokens.

### Controls

| Action | Mouse / trackpad | Touch |
|---|---|---|
| Switch building (project) | **Building** menu, top left | same |
| Pan | drag | one finger |
| Rotate | right-drag, or shift-drag | two-finger twist |
| Zoom | scroll / pinch | pinch |
| Go to a floor | Floors menu, click a floor, or `[` / `]` | tap |
| Back to the building | **Building** in the menu, `B`, or `Esc` | tap **Building** |
| Re-frame the current view | `F` or the ⤢ button | ⤢ button |
| Open a session | click a character | tap |
| Close panel / drawer | `Esc` | ✕ |

`?zoom=1.5` sets a starting zoom, which is handy for a wall display.

### Departments

A new building has one floor, **General**, where all its robots work. To add floors:

1. Press **＋ Add department** under the floor list, or **✎** to edit the ones you have.
2. Pick a ready-made department (**Product, Design, Development, QA, Docs, DevOps, Security, Research**) or **Custom…**.
3. Each department has a **role**: a short description of what it does. The ready-made ones come with one, and you can change it.
4. Use **↑** and **↓** to change the floor order. **✕** removes a department, and its robots move to the bottom floor.

**The role is given to the department's robots.** Every task Agent Office starts for a robot in a department with a role gets that role as an appended system prompt (`--append-system-prompt`). Sessions you run in a terminal are not changed.

**Moving a robot:** open it and pick another floor under **Department** in the side panel. It gets up, takes the lift and sits down at a desk on its new floor.

**Hiring into a department:** the task dialog has a **＋ New robot in _department_** option for every floor.

### Sending robots home

To tidy the office up, send robots you're done with home:

- **One robot:** open it and press **🚕 Send home**.
- **All idle robots in this building:** press **🚕** under the floor list.

The robot says goodbye, takes the lift down, walks out of the front door and gets into a taxi at the rank in front of the building. The taxi drives off.

What it does and doesn't do:

- **Nothing is deleted.** The session's transcript stays on disk; Agent Office only stops showing it.
- **It comes back by itself.** As soon as the session does something new (you resume it, or give it a task), it walks back in.
- **Busy robots stay.** A robot that is working, waiting on you, on a task or part of a running team can't be sent home.
- **Show N hidden sessions** at the bottom left shows them again for now.

### Teams: departments working together

Press **Team** in the top bar, then **Start a team…**:

1. **Goal:** what the team should get done, for example *Add a wishlist to the product pages, with tests*.
2. **Departments:** which floors take part, and which one **starts**.
3. **Permissions:** the same three modes as for tasks. They apply to every turn.
4. **Turns:** the most turns the team may take (8 by default). Each turn is one department's go.

Then the team works on its own, one department at a time:

- **Each department gets its own robot** for the run, hired onto its floor. When the work comes back to that department, the same robot is resumed, so it remembers its earlier turns.
- **At the end of its turn, a robot hands the work on.** It picks the next department itself and writes a short line to say out loud plus a message with the details. The robot gets up, rides the lift to that department, walks to the robot there and says its line in a speech bubble. The other robot answers and starts working.
- **When the goal is met,** the last robot rides down to the lobby and reports to reception, and you get a toast.
- **The team feed** (the **Team** drawer) shows every message: who said what to whom, with the full message one click away. Click a department to fly to its floor, or a message to open the robot.

How a hand-off works under the hood:

- Every turn is a normal headless task (`claude -p`) in the building's most recently used folder.
- The prompt has the goal, the list of departments with their roles, and the message from the previous department.
- The robot ends its reply with one line: `HANDOFF {"to": "qa", "say": "Ready for testing", "message": "…"}`. If that line is missing or names an unknown department, the work goes to the next floor up, and after the top floor the run ends.
- One team at a time per building. A run stops when it is done, when it runs out of turns, when a turn fails, or when you press **Stop**. Runs stop with the server.

Things to know:

- **A team uses tokens like any task.** Every turn is a full Claude Code turn. Start with **Plan only** or a low turn limit to see how your departments get along.
- **Turns run one after another in the same folder**, so departments never edit at the same time. They do edit your working folder, so commit or stash first if you want an easy way back.
- **Approvals** from team robots show up in the Approvals drawer like any other task.

### Giving a robot a task

Press **New task** in the top bar (or `T`), or **Give task** in a robot's side panel. Then:

1. **Who:** pick a robot, or **＋ New robot in _department_** to hire a new one on that floor.
2. **Task:** write the prompt.
3. **Permissions:** choose a mode.
   - **Edit files** (`acceptEdits`): reads and edits without asking. Anything else that needs permission shows up in the Approvals drawer if the hooks are installed. Without hooks it is refused, because nobody is at a terminal to approve it.
   - **Plan only** (`plan`): looks around and writes a plan. Changes nothing.
   - **Auto** (`auto`): Claude Code's own safety check decides what may run.

Each task runs headless as `claude -p` in the robot's project folder:

- **An existing robot** is resumed with `--resume <session id>`. It leaves the water cooler and goes back to work at its desk.
- **A new robot** gets a fresh `--session-id` and walks onto the floor. The camera flies to it.

The side panel shows a task strip with the elapsed time and a **Stop** button. A toast tells you when a task fails, or when it's done and you weren't watching. The top-bar button shows how many tasks are running.

Things to know:

- **Busy robots can't take a task.** A robot that is working or needs you can't get a new one. Pick a robot that's on your turn or idle, or hire a new one.
- **Open windows won't update.** If the robot's session is still open in a terminal or editor, that window won't show what the task did until you resume the session there.
- **Tasks stop with the server.** When you stop Agent Office, its running tasks stop too.
- **Finding the CLI:** Agent Office looks for the Claude Code CLI on `PATH`, then in the usual install folders, then for the newest copy bundled with the VS Code (or Cursor/Windsurf) extension or the desktop app. Set `tasks.claudePath` to choose one yourself.
- **Approvals wait longer for task robots.** Robots started from Agent Office have no terminal, so their permission requests wait in the Approvals drawer for up to 10 minutes (`tasks.approvalWaitSeconds`) instead of 45 seconds.

### Project files

Press **Files** (the folder icon) in the top bar to open the project files of the building on show. Add the material your robots may need, such as specs, designs, briefs, screenshots or data:

- **＋ Add files**, or drop files on the drawer. A file with the same name is replaced, after you confirm.
- **✕** removes a file.
- The badge on the button shows how many files the building has.

Each building has its own folder under `~/.agent-office/files/` (the path is shown at the bottom of the drawer). The robots don't read every file up front. They are told where the folder is and which files are in it, and they read a file when their work calls for it, or when you ask them to (*"check the brief in the project files"*):

- **Tasks and team turns** started from Agent Office get the folder with `--add-dir`, so they can read it without asking, and a note about it in their appended system prompt.
- **Sessions you start yourself** get the same note when they start, through the `SessionStart` hook (install the hooks with `npm run setup-hooks`). The folder is outside their project, so Claude Code asks before the first read, or it shows up in Approvals. Sessions that were already running when you added files don't know about the folder yet. Point them to it, or start a new session.

The note tells the robots to treat the files as reference material, not as instructions.

### Talking to a robot from the Conversation tab

Open a robot and go to its **Conversation** tab. Below the conversation is a message box:

- **Enter sends** the message as the robot's next task. **Shift+Enter** adds a new line.
- **The dropdown** picks the permission mode, the same three as in the task dialog.
- **The branch** the robot works on is shown next to it.
- **Your message appears straight away,** marked "sending…", until the robot's transcript picks it up.

While the robot is working or waiting on you, the box explains why and the send button is disabled. You can keep typing, and drafts are kept per robot until you send.

### Branches

On a project that is a git repo, every branch can have its own robots.

**Buildings are repos.** All robots working in any folder of the same repo (the main folder or any worktree) work in the same building.

**Branch zones:** on every floor of a git building, desks are grouped per branch. Each branch gets a tinted rug and a hanging sign with its name.

**Floors menu:** the floor you're on lists its branches with live dots for working and needs-you robots.
- **Click a branch** to fly to its zone. Robots on other branches fade back.
- **All branches** shows everyone again.
- **The + next to a branch** opens the task dialog for a new robot on that branch.
- **Show N other branches** lists branches without robots.
- **＋ New branch…** creates a branch and gives it a task.

**A task on a branch always runs on that branch.** When you hire a new robot on a git floor, the task dialog has a **Branch** field:

| You pick | Where the robot works |
|---|---|
| The branch checked out in your project folder | your project folder |
| A branch that already has a worktree | that worktree |
| Any other branch | a new git worktree: `~/agent-office-worktrees/<repo>/<branch>` |
| **＋ New branch…** with a name and a "from" branch | a new branch in a new worktree |

A worktree is a separate checkout of the same repo, so robots on different branches can work at the same time without touching each other's files, and your project folder never switches branch.

What Agent Office does and doesn't do with git:
- It only runs read-only git commands, plus `git worktree add` (with `-b` for a new branch) when you start a task on a branch.
- It never checks out, deletes, commits or pushes. Committing and merging stay with you (or the task you give).
- To clean up a worktree you no longer need, run `git worktree remove <path>` in the repo.
- Change the folder with `tasks.worktreeRoot` in config.json.

An existing robot keeps the folder and branch it already has: giving it a task never moves it to another branch.

### Time of day

By default the office follows your computer's clock:

- **07:00 to 19:00:** the page is light and the city is in daylight.
- **Outside those hours:** the page is dark and the city is at night.

The light shifts through the day. Mornings and evenings are warm and low, with long shadows, and the hour after sunset keeps a purple glow on the horizon.

To pick a time yourself, click the sun or moon button on the right of the top bar and drag the slider. Your choice is remembered, and the button shows the time you picked. **Follow clock** goes back to real time. `?hour=21.5` in the URL sets a time for that visit only, which is handy for screenshots.

### The console and the side panel

The top bar shows **Needs you**, **Working** (plus how many interns are working), **Tokens today** and **Est. cost** for today. Hover the token count to see the breakdown.

On the right of the top bar:

- the approvals drawer
- a chime that plays when an agent needs you
- **Safe to film**, which blurs prompts, conversation, file paths and approval inputs, and reduces speech bubbles to the tool name only
- the time-of-day button (sun or moon) with its slider

Clicking a character opens the side panel:

| Tab | Shows |
|---|---|
| **Steps** | every tool call, newest first, with duration bars and error / denied / interrupted markers. Click a step to see its input and result, or open the intern it started. |
| **Conversation** | your prompts, Claude's replies and tool calls, with a message box at the bottom to give the robot its next task |
| **Files** | files changed by Edit, Write, MultiEdit and NotebookEdit. Denied or failed calls aren't counted. |
| **Tokens** | context-window meter, token breakdown, estimated cost per model, and Claude Code's own cost figure when the transcript has one |
| **Approvals** | pending permission requests for this session |

## How it works

### Data source 1: transcripts (no setup)

Claude Code writes every session to `~/.claude/projects/<project>/<session>.jsonl`. Subagents go to `<session>/subagents/agent-*.jsonl`, and workflow agents one level deeper. Agent Office:

- **opens these files read-only** and tails them by byte offset. A partial last line stays buffered until it is complete.
- **links subagents to their parent:** the `toolUseId` in each `agent-*.meta.json` matches the parent's `Agent`/`Task` call.
- **counts usage once per message:** streamed messages repeat one `message.id` over several lines, so usage is deduplicated by that id.
- **takes the title** from Claude Code's `ai-title`, then the `summary`, then the first prompt you actually typed. Slash commands, system reminders and meta lines are skipped.
- **estimates cost** with the pricing table in [config.json](config.json), matched by model family. Cache writes are priced separately for the 5-minute and 1-hour TTLs. Cost is always labelled **est.**
- **keeps startup fast:** only files touched in the last 12 hours (or since midnight, for "Tokens today") are parsed at startup. On a folder of about 900 MB, that takes about 200 ms.

**Status without hooks is a best guess:**

- **working:** a prompt was just sent, a tool is running, or a reply is still streaming.
- **needs you:**
  - an `AskUserQuestion` or `ExitPlanMode` call is waiting, or
  - a quick tool (Edit, Write, Read, Grep, Glob…) has been open for more than 8 seconds. That almost always means a permission prompt.
- **your turn:** the last reply ended its turn, or you interrupted it.
- **idle:** nothing happened for 30 minutes.

Sessions older than 12 hours are hidden. **Show older sessions** at the bottom left brings back the ones already loaded.

### Data source 2: hooks (optional: exact status and approvals from the browser)

```bash
npm run setup-hooks     # adds entries to ~/.claude/settings.json (backs it up first)
npm run remove-hooks    # removes exactly those entries again
```

`setup-hooks`:

- **Writes a backup first:** `settings.json.agent-office-<timestamp>.bak`.
- **Keeps your existing hooks** and is safe to run twice.
- **Refuses to touch an unparsable settings file.**
- **Registers [hooks/hook.js](hooks/hook.js)** for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `Stop`, `SubagentStop`, `SessionEnd` and `PermissionRequest`.

Both scripts accept `--settings <path>` to target a different file.

**What the hook does:**

- **Every event:** forwards the event JSON to `http://127.0.0.1:4317/hook`. If Agent Office isn't running, it exits at once with no output, so Claude Code behaves exactly as before. Expect a few tens of milliseconds per event.
- **PermissionRequest** appears in the **Approvals** drawer.
  - If an Agent Office tab is open, the hook waits up to 45 seconds for **Allow** or **Deny**, then answers Claude Code directly.
  - If no tab is open, or nobody answers in time, it prints nothing. Your normal terminal prompt appears as usual.
  - If you answer in the terminal first, the browser card disappears.
- **AskUserQuestion and ExitPlanMode** are never answered from the browser. They only mark the agent as **needs you**.

With hooks installed, status comes from the hook events, which are exact, and the transcript fills in the rest.

## Privacy and security

- The server binds to **127.0.0.1 only** and makes **no outbound network requests** itself. The only process it starts is `claude -p`, and only when you give a robot a task. That process talks to Anthropic exactly like Claude Code in your terminal does. The page loads no fonts, scripts or images from anywhere else, and a strict Content-Security-Policy enforces that.
- Transcripts are opened **read-only**. Agent Office itself writes only these:
  - `~/.agent-office/org.json`: your departments (names, roles, floor order), which robot works on which floor, and which robots you sent home. It holds session ids and times, no prompts or conversations, and is written only when you change departments, move a robot, hire one into a department or send robots home. Set `orgFile` to `null` to keep it in memory only.
  - `~/.claude/settings.json`, only when you run `setup-hooks` or `remove-hooks`.
  - `~/.agent-office/files/`: the project files you add with the **Files** button, one folder per building. They stay until you remove them in the drawer. The page only names a building and a file name, never a path, so it can't read or write anywhere else.
- Tasks and team runs you start can edit files in their project, like any Claude Code session. Set `tasks.enabled` to `false` to turn both off completely.
- **Task folders come from the server, never from the page.** A task always runs in the working folder of a session Agent Office already knows. The prompt goes to the process on stdin, never through a shell.
- **Protection against other websites:**
  - Requests whose `Host` isn't localhost are rejected, which blocks DNS rebinding.
  - Requests with a foreign `Origin` are rejected.
  - Approving a tool or starting a task needs a random per-run token that only the served page knows. No website can answer a permission prompt or start a task for you.

## Configuration

All settings live in [config.json](config.json). `PORT=xxxx npm start` overrides the port.

| Key | Default | Meaning |
|---|---|---|
| `port` | 4317 | HTTP port. 4317 is also OpenTelemetry's default gRPC port; change it if you run an OTel collector. |
| `projectsDir` | `~/.claude/projects` | Where Claude Code keeps transcripts |
| `hideOlderThanHours` | 12 | Hide sessions with no activity for this long |
| `idleMinutes` | 30 | After this long without activity, a session counts as idle |
| `permissionGuessSeconds` | 8 | A quick tool open this long counts as "probably waiting for permission" |
| `approvalWaitSeconds` | 45 | How long the hook waits for Allow/Deny before falling back to the terminal |
| `tasks.enabled` | `true` | Allow giving robots tasks from the page |
| `tasks.claudePath` | `null` | Path to the `claude` CLI. When empty, it is found automatically. |
| `tasks.defaultMode` | `acceptEdits` | Mode preselected in the task dialog: `acceptEdits`, `plan` or `auto` |
| `tasks.maxRunning` | 6 | Most tasks that may run at once |
| `orgFile` | `~/.agent-office/org.json` | Where departments and floor assignments are kept. `null` keeps them in memory only. `AGENT_OFFICE_ORG_FILE` overrides it. |
| `files.dir` | `~/.agent-office/files` | Where project files are kept, one folder per building |
| `files.maxFileMB` | 50 | Largest project file you can add |
| `files.maxFiles` | 200 | Most project files per building |
| `teams.defaultTurns` | 8 | Turn limit preselected in the **Start a team** dialog |
| `teams.maxTurns` | 30 | The highest turn limit a team run may have |
| `contextWindows` | | Context-window size per model family. It is raised automatically if a session uses more context than the table allows. |
| `pricing` | | USD per million tokens per model family. The first `match` that is part of the model id wins. |

The pricing table is an **estimate**. On real transcripts it matches Claude Code's own cost figure within a few cents for most sessions. Known gaps:

- tiered pricing (for example Haiku 5.5 above 100K tokens)
- server-side tools such as web search
- some workflow agents whose transcripts aren't written to disk

## Development

```bash
npm test     # node:test, no dependencies
```

```
src/parser.js     pure transcript parser (fixtures in test/fixtures)
src/status.js     status heuristics + hook overlay
src/pricing.js    model → price / context window
src/tail.js       incremental, partial-line-safe JSONL reader
src/store.js      file discovery, subagent linking, summaries, change detection
src/server.js     HTTP + SSE + /hook + approvals and tasks API
src/tasks.js      runs tasks as headless `claude -p` processes; finds the CLI
src/org.js        departments per building and which robot works on which floor (org.json)
src/teams.js      team runs: turn prompts, HANDOFF parsing, passing the work between departments
src/watcher.js    fs.watch (recursive) plus a light polling safety net
hooks/hook.js     the Claude Code hook
scripts/          setup-hooks / remove-hooks
public/gl.js      tiny WebGL2 renderer (HDR + MSAA, shadow map, specular/rim light, bloom, ACES, fog, billboards)
public/office.js  the 3D building and city: floors, desks, the lift, characters, trips, speech bubbles, cutaway views, camera flights
public/app.js     UI shell; panel.js, tasks.js (task dialog), team.js (departments, team dialog and feed), demo.js, live.js, util.js
```

## Demo video

```bash
npm run record-demo            # → site/assets/demo.mp4 (1920×1080, 30 fps, under two minutes)
npm run record-demo -- --stills  # checks the MP4 plays and saves preview frames to media/stills/ (git-ignored)
```

The recorder uses the **demo office**, so the video never shows your real sessions, prompts or file paths. It plays a scripted tour with captions and a moving cursor, plus letterboxed cinematic shots where the UI fades away:

1. the building: a street-level opening on the entrance sign, a crane up the facade to the rooftop sign, then the whole building
2. the floors (departments)
3. the robots, with close-ups of a robot at work and one waving because it needs you
4. branch zones
5. talking to a robot in the Conversation tab
6. a new task on a new branch
7. a team run: a close-up on the first robot, a tracking shot as it walks to the lift, the ride up seen from outside the glass shaft, and the hand-over on the next floor
8. approvals
9. day turning into night, with a low sweep through the lit-up streets to the glowing rooftop sign

It needs Google Chrome (or set `CHROME_PATH`) and Node 22+, and nothing else: Chrome renders every frame and encodes H.264 itself, so no ffmpeg is needed. Time inside the page is simulated, so the video is a smooth 30 fps no matter how fast your machine renders.

**Soundtrack:** the video comes with an original lofi track that the recorder composes itself with Web Audio, so it's free to share anywhere. It has:
- electric-piano chords (Fmaj9 → Em9 → Dm9 → Cmaj9 at 78 BPM)
- bass and swung drums
- a soft melody
- vinyl crackle and tape wobble

It's encoded to AAC (Opus if this Chrome can't do AAC) in the same MP4. To use your own track instead, run `RECORD_MUSIC=/path/to/song.mp3 npm run record-demo`. It's trimmed to the video and faded out at the end; make sure you have the rights to it. `RECORD_MUSIC=none` gives a silent video.

Other options: `RECORD_FPS`, `RECORD_OUT`, `RECORD_BITRATE` (video bits per second, 4000000 by default, which keeps the file well under GitHub's 50 MB warning) and `RECORD_GL` (`metal`, `swiftshader` or `default`).

`--stills` saves a frame every 3 seconds. The landing page uses three of them, under fixed names in `site/assets/`: `t03.0.jpg` (the video poster: the whole building), `t14.0.jpg` (a floor with robots) and `t55.0.jpg` (the building at night). After a new recording, copy the frames you like over those three files.

## Website

The landing page lives in [site/](site/): plain HTML, CSS and JS with no build step and no external requests. Open `site/index.html` in a browser to preview it.

- **Repo URL:** set it once in the `<meta name="repo">` tag in `site/index.html`. The clone command and the GitHub link are filled from it.
- **Publishing:** [.github/workflows/pages.yml](.github/workflows/pages.yml) deploys `site/` to GitHub Pages on every push to `main`. Turn it on once under **Settings → Pages → Source: GitHub Actions**.

## Contributing

This repository doesn't accept outside contributions. Pull requests from anyone other than the owner are closed automatically. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Agent Office is **source-available** under the [Functional Source License, Version 1.1, MIT Future License](LICENSE) (FSL-1.1-MIT). © 2026 Mitchell Scholte.

- **You may** use it for free, also at work, and read, change and share the code.
- **You may not** use it to build a competing product or service: selling it, offering it as a service, or releasing a rebranded copy that does the same thing.
- **Two years after each release,** that version also becomes available under the MIT license.

The name and logo are not covered by the license. A modified copy you share must not use them.
