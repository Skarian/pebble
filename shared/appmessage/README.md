# Pebble AppMessage

`shared/appmessage` is the transport boundary for connected Pebble apps. It
owns AppMessage lifecycle, READY announcements, serialized delivery, bounded
retry, request correlation, replayable reads, and payload-free diagnostics.
Apps still own their dictionaries, domain work, persistence, and screen policy.

The three runtime entry points are:

- watch C: `AppMessageClient`
- Android/Kotlin: `AppMessageSession`
- PebbleKit JS: `createAppMessageSession`

## Contract

- READY is repeatable and advisory; the watch also has a short fallback grace.
- One logical watch operation is active at a time and keeps one request ID
  across delivery and response-timeout retries.
- Replies echo that ID; late replies for another ID are ignored.
- Reads are single-flight and may replay a completed result.
- A delivered mutation reconciles its original ID instead of submitting again.
- Phone sends and multipart batches are serialized and stop at the failed part.
- Persistent logs retain only bounded, payload-free fault incidents; routine
  lifecycle and success events remain live-only.

The watch implementation reserves AppMessage key `127` for its private outbox
attempt token. Do not declare or write that key in an app protocol. The token is
not a session-generation value and is never required in phone replies.
The machine-readable invariant list is in
[`fixtures/protocol_invariants.json`](fixtures/protocol_invariants.json).

## Watch C

Compile `watch/app_message_client.c`, add `watch/` to the include path, and keep
the callbacks limited to domain payload and UI policy:

```c
static AppMessageClient *s_phone;

static DictionaryResult write_payload(
    DictionaryIterator *out, const AppMessageClientStatus *request, void *context) {
  return dict_write_uint8(out, MESSAGE_KEY_VIEW, s_view);
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *in, const AppMessageClientStatus *request, void *context) {
  apply_domain_response(in);
  return APP_MESSAGE_RESPONSE_DONE;
}

AppMessageClientConfig config = {
  .app_name = "example",
  .inbox_size = 1024,
  .outbox_size = 128,
  .protocol = {
    .protocol_key = MESSAGE_KEY_PROTOCOL,
    .command_key = MESSAGE_KEY_COMMAND,
    .request_id_key = MESSAGE_KEY_REQUEST_ID,
    .protocol_version = 1,
    .ready_command = COMMAND_PHONE_READY,
    .request_id_codec = APP_MESSAGE_ID_UINT16,
  },
  .write_payload = write_payload,
  .response_received = receive_response,
  .state_changed = phone_state_changed,
  .request_failed = phone_request_failed,
};
s_phone = app_message_client_open(&config, &open_result);
app_message_client_start(s_phone, COMMAND_FETCH, APP_MESSAGE_OPERATION_READ,
                         NULL, APP_MESSAGE_SEND_PRIMARY);
```

Pass `NULL` to allocate a numeric read ID. A string-ID protocol supplies its
already-persisted logical ID. Call `app_message_client_close()` during teardown.

## Android/Kotlin

Add the `:pebble-appmessage` Gradle module and create one session per watchapp:

```kotlin
val messages = AppMessageSession(context, WATCHAPP_UUID, "example")

messages.open(watchId)
scope.launch { messages.announceReady(watchId, phoneReadyDictionary()) }

messages.messageReceived(watchId, "refresh", requestId)
messages.beginRead(watchId, "refresh", requestId).launch(scope) {
    val reply = fetchSnapshot()
    messages.send(watchId, "refresh", requestId, reply)
    messages.completeRead(watchId, "refresh", requestId) {
        messages.send(watchId, "refresh_replay", requestId, reply)
    }
}

messages.close(watchId)
```

Use `sendBatch` for ordered multipart output. Inspect its typed `Delivery` when
the app needs domain-specific terminal behavior.

## PebbleKit JS

The session owns raw Pebble listeners, repeatable READY, serialized sends, and
same-ID read admission:

```js
var messages = createAppMessageSession({
  app: 'example',
  pebble: Pebble,
  storage: localStorage,
  readyMessage: {PROTOCOL: 1, COMMAND: COMMAND_PHONE_READY},
  onMessage: function (payload, session) {
    if (payload.COMMAND === COMMAND_FETCH) {
      session.handleRead(payload.REQUEST_ID, 'fetch', fetchSnapshot, {
        failureResponse: function () { return {PROTOCOL: 1, STATUS: STATUS_ERROR}; }
      });
    }
  }
});
messages.open();
```

See [`../../docs/appmessage-diagnostics.md`](../../docs/appmessage-diagnostics.md)
for the persistent incident ring and retrieval commands.
