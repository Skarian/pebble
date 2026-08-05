# Codex Agent Router

Status: router CLI complete; Android companion phone-validated; watchapp implemented and emulator-validated; physical end-to-end validation pending

Last updated: 2026-08-04

## Purpose

Codex Agent Router is a Pebble workflow for speaking a message, reviewing the
transcription on the watch, and then sending the confirmed text to one of a
small set of long-running Codex tasks on an Android phone running Termux.

The product should make short, expressive interactions with dedicated Codex
agents convenient from a Pebble while preserving the option to continue the
same task later through the existing remote-control interface.

Watch audio must reach the high-quality cloud provider selected in Core.
Agents uses Pebble's native dictation and transcript-confirmation UI; it does
not implement or maintain a second recording interface.

## Current preferred direction

Use the unmodified Core mobile app and its officially integrated Wispr Flow
cloud transcription. This path has now been validated on the user's physical
phone and watch: it works well, is materially faster than both the previous
local option and Codex transcription, and does not use the user's personal
Wispr Flow allowance. Build three focused pieces:

1. A Pebble watchapp in this repository (implemented at `apps/agents`).
2. A small Android companion app in this repository (implemented at
   `companion_apps/agents_companion`).
3. A separate, generally useful Codex agent-routing CLI in its own repository
   (implemented as `Skarian/codex-router`).

The Android companion is an event-driven bridge, not a replacement for Core
and not a persistent Termux daemon. Core wakes it through PebbleKit2 when the
watch sends an AppMessage. It invokes the installed router CLI through
Termux's supported `RUN_COMMAND` intent and receives stdout through a result
`PendingIntent`. A custom Pebble ASR server remains a documented contingency
if the supported Wispr Flow path becomes unavailable or unsuitable later.

This direction is preferred because it removes four substantial maintenance
burdens:

- no Core mobile-app fork;
- no alternate Pebble companion such as microPebble;
- no custom Android `RecognitionService`;
- no custom PebbleOS firmware.

## User experience

The watchapp should feel like an ordinary Pebble dictation workflow.

1. Launch the app.
2. Use Up and Down to choose a configured agent.
3. Press Select to start the native `DictationSession`.
4. Speak, then press the appropriate button to finish recording.
5. Core sends the audio to its configured cloud transcription provider.
6. The watchapp receives the resulting text through the normal dictation
   callback.
7. Pebble shows its native transcript confirmation screen.
8. Press Select to accept the native transcript and send it. Back rejects it.
9. Show distinct `SENDING` and `WORKING` states.
10. Show an acknowledgement and, when practical, a paginated final response.
11. Also surface the final response on the phone, where the user can continue
    the same Codex task through the existing remote-control workflow.

Nothing is delivered to a Codex agent until the user confirms the preview.
This protects against transcription errors and accidental recordings.

## End-to-end architecture

```text
Pebble watchapp
    |
    | native DictationSession audio
    v
Unmodified Core mobile app
    |
    | Wispr Flow cloud transcription
    v
Pebble watchapp receives text
    |
    | user reviews and confirms
    v
Core PebbleKit2
    |
    | wakes Android companion with AppMessage
    v
Codex Agent Router companion app
    |
    | Termux RUN_COMMAND intent: agent ID + text + idempotency key
    v
Codex Agent Router CLI in Termux
    |
    | thread/resume + turn/start
    v
Codex app-server
    |
    | progress + final response
    v
Termux result PendingIntent -> companion -> PebbleKit2 -> watchapp
                                      |
                                      +-> phone notification
```

Transcription and routing are deliberately separate. The transcription phase
does not need to know which Codex agent is selected. The routing phase receives
only confirmed text and never needs microphone audio.

## Transcription strategy

### Preferred: Core plus Wispr Flow

Recent Core releases include Wispr Flow as the built-in cloud recognition
provider. The user selects `Cloud Only` or an appropriate cloud-first mode in
Core's Speech Recognition settings.

Core's current implementation does not ask for a personal Wispr Flow login.
It authenticates to a Core-controlled token endpoint using the signed-in Core
Firebase user, obtains a short-lived Wispr access token, and calls Wispr's
transcription API. Therefore, the user's separate Wispr consumer account and
its Basic or Pro allowance do not appear to control Core's integration.

This has been verified on the physical phone and watch. Current findings:

- `Cloud Only` is available and works well.
- It is materially faster than the previous local transcription path and
  Codex app-server transcription.
- It does not consume the user's personal Wispr Flow plan allowance.
- Stock PebbleOS limits each native dictation recording to 15 seconds. That is
  acceptable for the intended quick-command workflow.
- PebbleOS separately allows roughly 15 seconds for the transcription result;
  Core keeps its own provider work within roughly 14 seconds.

Wispr's consumer Basic plan currently advertises platform-dependent limits,
but those limits must not be assumed to apply to Core's separately
authenticated integration.

### Fallback: custom Pebble ASR service

If Wispr through Core is unavailable, inaccurate, quota-limited, or unreliable,
retain the previously researched custom-ASR design:

1. Use Core's supported custom boot-configuration deep link.
2. Rewrite only `voice.languages[].endpoint` while proxying the rest of the
   official boot configuration.
3. Put Core in `Rebble Only` mode.
4. Run a Rebble-compatible `/NmspServlet/` endpoint in Termux.
5. Receive Pebble Speex frames, decode them to 16 kHz mono PCM/WAV, and
   transcribe them with Codex app-server.
6. Return a legacy multipart `QueryResult` to Core.

This route preserves the stock Core APK but adds a persistent ASR daemon,
Speex decoding, HTTPS exposure, custom boot-config setup, strict latency work,
and responsibility for every Pebble transcription. It should be implemented
only if the supported Wispr path later becomes unavailable or unsuitable.

### Alternatives considered but not preferred

- **Core mobile-app fork:** technically direct because Core exposes raw audio
  through `TranscriptionProvider`, and an open pull request adds arbitrary
  OpenAI-compatible transcription endpoints. Rejected for now because the
  user does not want to maintain an application fork.
- **microPebble plus custom Android `RecognitionService`:** proven capable of
  passing decoded PCM through Android's `EXTRA_AUDIO_SOURCE`. Rejected because
  it replaces the preferred Core companion and adds an Android service.
- **PebbleOS audio tee or private microphone API:** possible in an open-source
  firmware, but it duplicates an audio transport Core already supports and
  creates firmware maintenance.
- **Index recording webhook:** it uploads raw Index ring recordings but is not
  connected to Pebble watch dictation in stock Core. Useful evidence that Core
  can webhook audio, but not needed in the preferred design.

## Repository boundaries

### This Pebble repository

Pebble-specific pieces belong here:

```text
apps/codex-agent-router/
    Pebble C watchapp
    emulator and device QA

docs/codex-agent-router/
    this plan and later protocol/testing notes

tools/pebble-asr/
    reserved for the custom-ASR fallback; do not create until required

companion_apps/agents_companion/
    PebbleKit2 listener, Termux command bridge, setup/status UI
```

The watchapp should follow the repository's established Pebble practices:
short, plain copy; large, legible typography; production builds free of test
fixtures; deterministic fake-data emulator QA; and physical-device validation
before publication.

### Separate Codex routing repository

The generic routing tool should live in a separate repository because it
should know nothing about Pebble, Speex, Core, or watch UI.

Working name: `codex-agent-router`. The final repository and package name are
not yet decided.

It should expose a command-line interface with structured JSON output:

```text
codex-agent-router agents list
codex-agent-router send <agent-id> --text "message"
codex-agent-router send <agent-id>            # read text from stdin
codex-agent-router status <turn-id>
codex-agent-router doctor
```

The router owns:

- the agent registry;
- trusted working directories;
- existing Codex task IDs;
- model and reasoning configuration;
- Codex app-server lifecycle and protocol handling;
- turn progress and final output;
- concurrency policy;
- idempotency and retry behavior;
- structured JSON output;
- optional Android/Termux notifications.

The router must be usable independently from Pebble by shell scripts, Termux
widgets, Android share actions, and future clients.

## Agent model

An agent is a trusted, locally configured alias. It is not an arbitrary task
definition supplied by the watch.

Example configuration:

```toml
[agents.pebble]
label = "Pebble"
cwd = "/data/data/com.termux/files/home/projects/pebble"
thread_id = "019..."
model = "configured-model"

[agents.home]
label = "Home"
cwd = "/data/data/com.termux/files/home/projects/home"
thread_id = "019..."
model = "configured-model"
```

The watch receives only IDs and display labels. It must not be allowed to send
arbitrary directories, task IDs, models, or app-server arguments.

## CLI protocol

The companion invokes only fixed router subcommands. The first CLI contract
should remain deliberately small:

```text
codex-agent-router agents list --json
codex-agent-router send <agent-id> --stdin --request-id <uuid> --json
codex-agent-router status <turn-id> --json
codex-agent-router doctor --json
```

Example turn request:

```json
{
  "agentId": "pebble",
  "text": "Please build and test the current watchapp.",
  "clientRequestId": "random-uuid"
}
```

`clientRequestId` is required so Bluetooth retries, Android redelivery, or
repeated button events cannot start the same Codex turn twice.

The CLI should emit newline-delimited structured events or a final JSON result.
For version 1, the Android companion may wait for the `RUN_COMMAND` result and
send progress states of its own. If turns regularly exceed a safe Android
execution window, the CLI can return an accepted turn ID quickly and a later
one-shot `status` invocation can recover the result without introducing a
persistent HTTP server.

Expected states:

```text
accepted -> running -> completed
                    -> failed
```

The router should expose structured errors that distinguish unknown agents,
busy agents, invalid task IDs, app-server failures, timeouts, and delivery
failures.

## Watch and Android companion responsibilities

The watchapp owns:

- agent selection;
- invoking native dictation;
- transcription preview and confirmation;
- retry/cancel behavior;
- progress and result screens;
- AppMessage chunk assembly and acknowledgement;
- concise error presentation.

The Android companion owns:

- receiving AppMessages through Core's PebbleKit2 listener service;
- invoking the router's fixed commands through Termux `RUN_COMMAND`;
- passing transcript text through stdin rather than shell interpolation;
- receiving command stdout, stderr, and exit status through a result
  `PendingIntent`;
- fetching, caching, and advertising the available agent list;
- correlating each CLI execution with the watch request ID;
- chunking long text across AppMessage;
- reconnect/retry behavior;
- preserving the idempotency key across retries.

The watch should cache the most recent valid agent list and selected agent so
it remains understandable during temporary network failures. Cached data must
never authorize an unknown agent on the router.

## Mobile application

A small Android companion application is required. It is the durable Android
boundary between Core/PebbleKit2 and Termux, and it owns agent discovery and
bidirectional request delivery.

It should remain narrow:

- no microphone or transcription implementation;
- no Core code or fork;
- no arbitrary shell command supplied by the watch;
- no continuously running process;
- one minimal setup/status screen for Termux permission, router health, and
  cached agents;
- an exported PebbleKit2 listener service that Core can wake;
- a private result receiver/service for Termux callbacks.

On watchapp launch, the companion should return its cached agent list
immediately when available, then invoke `agents list --json` to refresh it.
This keeps startup responsive even if Termux needs to be cold-started.

Termux setup requires the companion to request
`com.termux.permission.RUN_COMMAND`, the user to grant that permission, and
`allow-external-apps=true` in Termux. The companion must invoke a fixed router
executable and validate agent IDs locally; it must never turn watch data into
an arbitrary command line.

## Security and privacy

- Keep agent definitions and Codex task IDs in Termux, never on the watch.
- Grant Termux `RUN_COMMAND` permission only to the signed companion app.
- Invoke one fixed router executable and a fixed set of subcommands.
- Do not log transcription audio or sensitive transcript text by default.
- Redact tokens, task IDs, and user content from diagnostics.
- Treat the watch as an untrusted presentation and input client.
- Preserve a clear confirmation step before agent delivery.
- Never execute a duplicate request with the same idempotency key.

## Reliability expectations

- The watch should distinguish sending, queued/running, and genuine failure.
- The router should retain enough job state for the watch to reconnect and
  retrieve the final result.
- Agent turns should be serialized per task until concurrent-turn behavior is
  explicitly validated.
- A phone notification should provide the complete response when watch display
  space is insufficient.
- Long watch responses should be paginated rather than rendered with tiny
  typography.
- The user can always continue the task in the existing remote-control app.

## Open decisions

These are intentionally unresolved:

- Final watchapp, CLI, repository, and package names.
- Whether the router should be written in TypeScript, Rust, or another runtime
  already reliable in the user's Termux environment.
- Whether the final response should always appear on the watch or only a short
  acknowledgement plus phone notification.
- Maximum transcript and response lengths supported over AppMessage.
- Exact button mapping for retry, cancel, scrolling, and response dismissal.
- Whether agents reject new turns while busy or queue them.
- Whether model selection remains fixed per agent or can be changed through a
  trusted phone-side interface.
- Whether the custom ASR fallback should ever become a published tool rather
  than a personal recovery path.
- Whether a future workflow will need recordings longer than PebbleOS's
  15-second native dictation limit.
- Whether long-running turns should keep one Termux command alive until final
  output or return a turn ID and use later one-shot `status` calls.

## Recommended order of operations

### Phase 0: validate the simplifying assumption — complete

Before writing product code, test stock Core on the physical phone and watch:

1. Confirm the installed Core version exposes Wispr Flow and `Cloud Only`.
2. Select `Cloud Only`.
3. Record a fixed set of short, medium, punctuation-heavy, proper-name, and
   coding-oriented phrases.
4. Compare accuracy and latency with the current local transcription.
5. Verify notification replies and an existing dictation watchapp.
6. Repeat enough times to expose quotas, intermittent fallback, or auth
   failures.
7. Record whether the user's personal Wispr account is involved anywhere in
   setup or usage.

Result: the supported Core/Wispr path is accurate and fast enough for the
project. Custom ASR is removed from the initial build scope. The 15-second
recording limit is accepted for version 1.

### Phase 1: build the generic router CLI — complete

Create the separate router repository and prove the narrowest useful command:

```text
echo "hello" | codex-agent-router send <agent-id>
```

Validate against one real existing task in Termux. Confirm correct cwd, task
resume behavior, model selection, final stdout, exit codes, and duplicate-turn
protection before integrating the Android companion.

### Phase 2: prove the Android-to-Termux command bridge — complete

Build a tiny Android spike that invokes `agents list --json` and `send` through
Termux `RUN_COMMAND`, receives the result through a `PendingIntent`, and shows
it on a diagnostic screen. Validate cold-start behavior after Android has
killed both the companion and Termux processes.

Result: both final and streaming modes were validated on the physical phone.
The spike has since been productized into a headless-first companion with a
PebbleKit2 listener, setup/health screen, router doctor, cached agents,
short-lived streaming bridge, notifications, request deduplication, and
chunked watch responses.

### Phase 3: build the watchapp against a fake router — complete

Implemented agent selection, native dictation callback handling, streaming
replacement, scrollable final responses, turn history, and recoverable error
states. The deterministic Emery pipeline drives Pebble's real voice service
and a QA-only mock phone bridge, producing numbered native screenshots and a
23-state contact sheet without embedding fixtures in the production PBW.

### Phase 4: integrate the Android companion with the watchapp — implemented, device validation pending

Connect the watchapp to the companion through PebbleKit2, implement agent-list
advertising, AppMessage chunking, request correlation, and idempotent retries,
and validate loss/reconnect behavior.

### Phase 5: physical-device validation

Test the full watch -> Core/Wispr -> preview -> router -> Codex task -> result
path on the Android phone and physical Pebble. Do not publish or push a final
release until the user confirms the workflow works well in normal use.

### Phase 6: optional polish

Only after the core workflow is reliable, consider richer phone
notifications, response pagination, a setup helper, broader agent management,
or the custom ASR fallback.

## Research references

- Core mobile app pull request for an OpenAI-compatible speech provider:
  <https://github.com/coredevices/mobileapp/pull/261>
- Core Wispr Flow REST transcription implementation:
  <https://github.com/coredevices/mobileapp/blob/96e860bb9e9366d82f357cad2c592325ddd8934c/util/src/commonMain/kotlin/coredevices/util/transcription/WisprFlowRESTTranscriptionService.kt>
- Core Wispr token authentication:
  <https://github.com/coredevices/mobileapp/blob/96e860bb9e9366d82f357cad2c592325ddd8934c/util/src/commonMain/kotlin/coredevices/api/WisprFlowAuth.kt>
- Core speech-recognition settings:
  <https://github.com/coredevices/mobileapp/blob/96e860bb9e9366d82f357cad2c592325ddd8934c/pebble/src/commonMain/kotlin/coredevices/pebble/ui/WatchSettingsScreen.kt>
- Core mobile-app changelog:
  <https://ndocs.repebble.com/Pebble-Mobile-App-Changelog-22bfbb55ea848043ad0edf100c328a86>
- Wispr Flow consumer pricing and free-plan information:
  <https://wisprflow.ai/business>
- Custom ASR protocol reference:
  <https://github.com/pebble-dev/rebble-asr>
- Android external audio source for speech recognition:
  <https://developer.android.com/reference/android/speech/RecognizerIntent#EXTRA_AUDIO_SOURCE>
- Codex app-server audio input documentation:
  <https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md#example-start-a-turn-send-user-input>
- Termux `RUN_COMMAND` intent, command input, and result `PendingIntent`:
  <https://github.com/termux/termux-app/wiki/RUN_COMMAND-Intent>
- Core PebbleKit2 listener and sender integration:
  <https://github.com/coredevices/mobileapp/tree/96e860bb9e9366d82f357cad2c592325ddd8934c/libpebble3/src/androidMain/kotlin/io/rebble/libpebblecommon/pebblekit/two>

## Current conclusion

The product is a watchapp, a narrow Android bridge, and a generic Codex Router
CLI. Stock Core and its Wispr Flow integration provide recording and
transcription. Core's PebbleKit2 support wakes the companion, and Termux's
`RUN_COMMAND` intent wakes the CLI, so version 1 requires no persistent HTTP or
ASR daemon. Transcription, the router CLI, and the Android companion have
passed their device gates. The production watchapp now passes deterministic
native-firmware QA. The next milestone is physical end-to-end PebbleKit2
validation of the complete watch -> Core dictation -> companion -> Termux ->
Codex -> watch path.
