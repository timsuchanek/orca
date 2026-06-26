# Station Native Attach V0

Orca can attach to a live Station Workspace and open terminal panes backed by Station-tracked PTYs.

## User Flow

Create or find a Station workspace in a terminal:

```bash
station ls
station enter --create --repo github.com/expandai/expand
```

In Orca, run:

```text
Attach Station Workspace -> ws_...
```

Orca creates a terminal-only synthetic worktree. New terminal tabs and split panes in that worktree create separate Station PTYs inside `/home/station/workspace`.

Closing a Station-backed Orca pane detaches Orca locally and leaves the Station PTY running. An explicit kill action terminates the Station PTY by calling Station's PTY terminate endpoint.

## Current Scope

V0 is intentionally terminal-only:

- no Station Workspace picker/search
- no route/service panel
- no Station-backed file explorer
- no Station-backed git/source-control provider
- no persistent restore of Station tabs after Orca restart
- no multi-user sharing UI

## Implementation Contract

Station workspaces use a synthetic connection id:

```text
station:<workspace-id>
```

That connection id routes PTY operations through Orca's Station PTY provider, not the SSH provider. Station worktrees must not open the SSH reconnect dialog or persist SSH remote PTY leases.

The Station provider uses:

- workspace inspect
- PTY Session create
- PTY stream-info by Station PTY Session id
- direct workspaced WebSocket stream resolved by Station
- tracked PTY resize by Station PTY Session id
- explicit PTY terminate by Station PTY Session id

## Smoke Test

With `stationd` running and a provider-live workspace:

```bash
station pty list --workspace <workspace-id>
```

Attach from Orca, then run in the terminal:

```bash
pwd
echo station_orca_ok
codex --version
```

Create a split/new terminal pane from the same Station worktree and run:

```bash
echo station_orca_split_ok
```

`station pty list --workspace <workspace-id>` should show separate `orca-shell` PTYs for the Orca panes.
