# Agents for Pebble

Agents is a voice-first Pebble app for sending a turn to a configured
`codex-router` agent. The watch app is deliberately thin: the Android
companion owns Termux discovery and routing, while the watch owns selection,
native dictation, streaming display, and short turn history.

## Interaction model

- The app opens on the first cached agent. Up reveals the agent-count summary;
  Down moves through the virtual agent list.
- Select on an agent opens Pebble's native dictation UI. Select stops recording,
  and Select on Pebble's native transcript confirmation accepts and sends it.
- While Codex works, the latest complete logical message replaces the previous
  message. Up and Down scroll long text.
- The final response adds **SELECT TO REPLY**. Holding Select opens the current
  turn's message history, newest message selected.
- Back leaves history, returns from a running turn without cancelling it, or
  closes a completed turn.

The watchapp UUID is `bba3f38f-53e5-458b-9d5f-0bcdb68ffd47`. Its only Android
companion is `com.skarian.agentscompanion` in
`companion_apps/agents_companion`.

## Build and QA

```sh
npm test
pebble build
npm run qa
```

`npm run qa` uses the real Emery firmware, Pebble's native voice service, a
deterministic mock phone bridge, an isolated emulator data directory, and the
shared `/private/tmp/pebble-emulator-qa.lock`. It writes numbered native
screenshots, a contact sheet, and a scenario manifest under `qa-results/`.
Fixtures live only in the QA driver and are never compiled into the PBW.

The production artifact is `build/agents.pbw`.
