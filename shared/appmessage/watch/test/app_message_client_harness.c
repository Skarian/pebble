#include <assert.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "../app_message_client.h"

struct AppTimer {
  uint32_t delay;
  AppTimerCallback callback;
  void *context;
  bool cancelled;
};

static struct AppTimer s_timers[96];
static size_t s_timer_count;
static AppMessageInboxReceived s_inbox_received;
static AppMessageInboxDropped s_inbox_dropped;
static AppMessageOutboxSent s_outbox_sent;
static AppMessageOutboxFailed s_outbox_failed;
static unsigned s_registration_count;
static bool s_registered_before_open;
static DictionaryIterator s_building;
static DictionaryIterator s_sent[32];
static size_t s_sent_count;
static AppMessageResult s_send_results[16];
static size_t s_send_result_count;
static size_t s_send_result_index;

void test_app_log(int level, const char *format, ...) {
  (void)level;
  (void)format;
}

static void fix_tuple_pointers(DictionaryIterator *iterator) {
  for (size_t index = 0; index < iterator->count; index++) {
    iterator->tuples[index].value = &iterator->tuples[index].storage;
  }
}

static Tuple *append_tuple(DictionaryIterator *iterator, uint32_t key) {
  assert(iterator->count < sizeof(iterator->tuples) / sizeof(iterator->tuples[0]));
  Tuple *tuple = &iterator->tuples[iterator->count++];
  memset(tuple, 0, sizeof(*tuple));
  tuple->key = key;
  tuple->value = &tuple->storage;
  return tuple;
}

Tuple *dict_find(const DictionaryIterator *iterator, uint32_t key) {
  if (!iterator) return NULL;
  for (size_t index = 0; index < iterator->count; index++) {
    if (iterator->tuples[index].key == key) {
      return (Tuple *)&iterator->tuples[index];
    }
  }
  return NULL;
}

DictionaryResult dict_write_uint8(
    DictionaryIterator *iterator, uint32_t key, uint8_t value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_UINT;
  tuple->length = 1;
  tuple->value->uint8 = value;
  return DICT_OK;
}

DictionaryResult dict_write_uint16(
    DictionaryIterator *iterator, uint32_t key, uint16_t value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_UINT;
  tuple->length = 2;
  tuple->value->uint16 = value;
  return DICT_OK;
}

DictionaryResult dict_write_cstring(
    DictionaryIterator *iterator, uint32_t key, const char *value) {
  Tuple *tuple = append_tuple(iterator, key);
  tuple->type = TUPLE_CSTRING;
  snprintf(tuple->value->cstring, sizeof(tuple->value->cstring), "%s", value);
  tuple->length = (uint16_t)strlen(tuple->value->cstring) + 1;
  return DICT_OK;
}

AppTimer *app_timer_register(
    uint32_t timeout_ms, AppTimerCallback callback, void *context) {
  assert(s_timer_count < sizeof(s_timers) / sizeof(s_timers[0]));
  AppTimer *timer = &s_timers[s_timer_count++];
  *timer = (AppTimer){.delay = timeout_ms, .callback = callback, .context = context};
  return timer;
}

void app_timer_cancel(AppTimer *timer) {
  if (timer) timer->cancelled = true;
}

static AppTimer *next_timer(void) {
  for (size_t index = 0; index < s_timer_count; index++) {
    if (!s_timers[index].cancelled && s_timers[index].callback) return &s_timers[index];
  }
  return NULL;
}

static void fire_next_timer(void) {
  AppTimer *timer = next_timer();
  assert(timer);
  AppTimerCallback callback = timer->callback;
  void *context = timer->context;
  timer->cancelled = true;
  callback(context);
}

AppMessageInboxReceived app_message_register_inbox_received(
    AppMessageInboxReceived callback) {
  AppMessageInboxReceived previous = s_inbox_received;
  s_inbox_received = callback;
  s_registration_count++;
  return previous;
}

AppMessageInboxDropped app_message_register_inbox_dropped(
    AppMessageInboxDropped callback) {
  AppMessageInboxDropped previous = s_inbox_dropped;
  s_inbox_dropped = callback;
  s_registration_count++;
  return previous;
}

AppMessageOutboxSent app_message_register_outbox_sent(
    AppMessageOutboxSent callback) {
  AppMessageOutboxSent previous = s_outbox_sent;
  s_outbox_sent = callback;
  s_registration_count++;
  return previous;
}

AppMessageOutboxFailed app_message_register_outbox_failed(
    AppMessageOutboxFailed callback) {
  AppMessageOutboxFailed previous = s_outbox_failed;
  s_outbox_failed = callback;
  s_registration_count++;
  return previous;
}

void app_message_deregister_callbacks(void) {
  s_inbox_received = NULL;
  s_inbox_dropped = NULL;
  s_outbox_sent = NULL;
  s_outbox_failed = NULL;
}

AppMessageResult app_message_open(uint32_t inbox_size, uint32_t outbox_size) {
  assert(inbox_size > 0 && outbox_size > 0);
  s_registered_before_open = s_registration_count == 4 && s_inbox_received &&
      s_inbox_dropped && s_outbox_sent && s_outbox_failed;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_begin(DictionaryIterator **iterator) {
  memset(&s_building, 0, sizeof(s_building));
  *iterator = &s_building;
  return APP_MSG_OK;
}

AppMessageResult app_message_outbox_send(void) {
  assert(s_sent_count < sizeof(s_sent) / sizeof(s_sent[0]));
  s_sent[s_sent_count] = s_building;
  fix_tuple_pointers(&s_sent[s_sent_count]);
  s_sent_count++;
  if (s_send_result_index < s_send_result_count) {
    return s_send_results[s_send_result_index++];
  }
  return APP_MSG_OK;
}

typedef struct {
  unsigned payload_writes;
  unsigned responses;
  unsigned unsolicited;
  unsigned failures;
  AppMessageResponseAction actions[8];
  size_t action_count;
  size_t action_index;
  AppMessageFailureInfo last_failure;
  char failed_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
} Harness;

static DictionaryResult write_payload(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)request;
  Harness *harness = context;
  harness->payload_writes++;
  return dict_write_uint8(iterator, 42, 7);
}

static AppMessageResponseAction receive_response(
    DictionaryIterator *iterator,
    const AppMessageClientStatus *request,
    void *context) {
  (void)iterator;
  assert(request->request_id[0]);
  Harness *harness = context;
  harness->responses++;
  if (harness->action_index < harness->action_count) {
    return harness->actions[harness->action_index++];
  }
  return APP_MESSAGE_RESPONSE_DONE;
}

static void receive_unsolicited(
    DictionaryIterator *iterator, void *context) {
  (void)iterator;
  Harness *harness = context;
  harness->unsolicited++;
}

static void request_failed(
    const AppMessageFailureInfo *failure,
    void *context) {
  Harness *harness = context;
  harness->failures++;
  harness->last_failure = *failure;
  snprintf(harness->failed_id, sizeof(harness->failed_id), "%s", failure->request_id);
  harness->last_failure.request_id = harness->failed_id;
}

static AppMessageClient *open_client(
    Harness *harness, AppMessageRequestIdCodec codec) {
  AppMessageClientConfig config = {
    .app_name = "test",
    .inbox_size = 256,
    .outbox_size = 128,
    .protocol = {
      .protocol_key = 9,
      .command_key = 0,
      .request_id_key = 1,
      .protocol_version = 1,
      .ready_command = 19,
      .reconcile_command = 3,
      .request_id_codec = codec,
    },
    .write_payload = write_payload,
    .response_received = receive_response,
    .unsolicited_received = receive_unsolicited,
    .request_failed = request_failed,
    .context = harness,
  };
  AppMessageResult result;
  AppMessageClient *client = app_message_client_open(&config, &result);
  assert(client && result == APP_MSG_OK && s_registered_before_open);
  return client;
}

static void reset_runtime(void) {
  memset(s_timers, 0, sizeof(s_timers));
  s_timer_count = 0;
  s_registration_count = 0;
  s_registered_before_open = false;
  memset(s_sent, 0, sizeof(s_sent));
  s_sent_count = 0;
  memset(s_send_results, 0, sizeof(s_send_results));
  s_send_result_count = 0;
  s_send_result_index = 0;
}

static const char *sent_id(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 1);
  assert(tuple);
  static char numeric[8];
  if (tuple->type == TUPLE_CSTRING) return tuple->value->cstring;
  snprintf(numeric, sizeof(numeric), "%u", tuple->value->uint16);
  return numeric;
}

static uint8_t sent_command(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 0);
  assert(tuple);
  return tuple->value->uint8;
}

static uint8_t sent_token(size_t index) {
  Tuple *tuple = dict_find(&s_sent[index], 127);
  assert(tuple);
  return tuple->value->uint8;
}

static void acknowledge(size_t index) {
  assert(s_outbox_sent);
  s_outbox_sent(&s_sent[index], NULL);
}

static void reject_async(size_t index, AppMessageResult reason) {
  assert(s_outbox_failed);
  s_outbox_failed(&s_sent[index], reason, NULL);
}

static void receive_ready(void) {
  DictionaryIterator message = {0};
  dict_write_uint8(&message, 9, 1);
  dict_write_uint8(&message, 0, 19);
  s_inbox_received(&message, NULL);
}

static void receive_id(const char *id, AppMessageRequestIdCodec codec) {
  DictionaryIterator message = {0};
  dict_write_uint8(&message, 9, 1);
  dict_write_uint8(&message, 0, 10);
  if (codec == APP_MESSAGE_ID_CSTRING) dict_write_cstring(&message, 1, id);
  else dict_write_uint16(&message, 1, (uint16_t)atoi(id));
  s_inbox_received(&message, NULL);
}

static void test_ready_grace_and_lost_ready(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_UINT16);
  assert(app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, NULL, APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(s_sent_count == 0);
  receive_ready();
  assert(s_sent_count == 1);
  acknowledge(0);
  assert(next_timer()->delay == 30000);
  receive_id("1", APP_MESSAGE_ID_UINT16);
  assert(!app_message_client_is_active(client));
  app_message_client_close(client);

  reset_runtime();
  h = (Harness){0};
  client = open_client(&h, APP_MESSAGE_ID_UINT16);
  assert(app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, NULL, APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(next_timer()->delay == 1500);
  fire_next_timer();
  assert(s_sent_count == 1);
  receive_ready();
  assert(s_sent_count == 1);
  acknowledge(0);
  receive_id("1", APP_MESSAGE_ID_UINT16);
  app_message_client_close(client);
}

static void test_send_failures_retry_same_identity(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_BUSY;
  s_send_results[1] = APP_MSG_OK;
  s_send_result_count = 2;
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_READ, "retry-1", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  fire_next_timer();
  reject_async(1, APP_MSG_NOT_CONNECTED);
  fire_next_timer();
  assert(s_sent_count == 3);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  assert(strcmp(sent_id(1), sent_id(2)) == 0);
  assert(sent_token(0) != sent_token(1) && sent_token(1) != sent_token(2));
  acknowledge(2);
  receive_id("retry-1", APP_MESSAGE_ID_CSTRING);
  assert(h.failures == 0 && !app_message_client_is_active(client));
  app_message_client_close(client);
}

static void test_coalesce_stale_and_read_resend(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-7", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-7", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_COALESCED);
  assert(app_message_client_start(
      client, 4, APP_MESSAGE_OPERATION_READ, "read-8", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_BUSY);
  acknowledge(0);
  receive_id("stale-6", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 0 && app_message_client_is_active(client));
  fire_next_timer();
  fire_next_timer();
  assert(s_sent_count == 2 && strcmp(sent_id(0), sent_id(1)) == 0);
  acknowledge(1);
  receive_id("read-7", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 1 && !app_message_client_is_active(client));
  app_message_client_close(client);
}

static void test_mutation_timeout_reconciles_without_replaying(void) {
  reset_runtime();
  Harness h = {
    .actions = {
      APP_MESSAGE_RESPONSE_MORE,
      APP_MESSAGE_RESPONSE_MORE,
      APP_MESSAGE_RESPONSE_DONE,
    },
    .action_count = 3,
  };
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  assert(app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "turn-1", APP_MESSAGE_SEND_PRIMARY) ==
      APP_MESSAGE_START_STARTED);
  assert(sent_command(0) == 2);
  acknowledge(0);
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);  // ACCEPTED
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);  // COMMENTARY
  assert(h.responses == 2 && app_message_client_is_active(client));
  // The terminal update is lost. The shared response timeout reconciles the
  // same logical turn rather than replaying its primary mutation.
  fire_next_timer();
  assert(s_sent_count == 2);
  assert(sent_command(1) == 3);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  acknowledge(1);
  receive_id("turn-1", APP_MESSAGE_ID_CSTRING);
  assert(h.responses == 3 && !app_message_client_is_active(client));
  assert(s_sent_count == 2);
  app_message_client_close(client);
}

static void test_more_then_done_and_late_outbox_ignored(void) {
  reset_runtime();
  Harness h = {
    .actions = {APP_MESSAGE_RESPONSE_MORE, APP_MESSAGE_RESPONSE_DONE},
    .action_count = 2,
  };
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, "stream-1", APP_MESSAGE_SEND_PRIMARY);
  acknowledge(0);
  receive_id("stream-1", APP_MESSAGE_ID_CSTRING);
  assert(app_message_client_is_active(client));
  receive_id("stream-1", APP_MESSAGE_ID_CSTRING);
  assert(!app_message_client_is_active(client));

  app_message_client_start(
      client, 1, APP_MESSAGE_OPERATION_READ, "late-1", APP_MESSAGE_SEND_PRIMARY);
  fire_next_timer();
  fire_next_timer();
  assert(s_sent_count == 3);
  reject_async(1, APP_MSG_NOT_CONNECTED);
  assert(app_message_client_status(client)->state == APP_MESSAGE_CLIENT_WAITING_OUTBOX);
  acknowledge(2);
  receive_id("late-1", APP_MESSAGE_ID_CSTRING);
  app_message_client_close(client);
}

static void test_failure_reports_delivery_certainty(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_BUSY;
  s_send_results[1] = APP_MSG_BUSY;
  s_send_results[2] = APP_MSG_BUSY;
  s_send_result_count = 3;
  app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "fail-1", APP_MESSAGE_SEND_PRIMARY);
  fire_next_timer();
  fire_next_timer();
  assert(h.failures == 1);
  assert(h.last_failure.failure == APP_MESSAGE_FAILURE_DELIVERY);
  assert(h.last_failure.delivery == APP_MESSAGE_DELIVERY_NOT_SENT);
  assert(strcmp(h.last_failure.request_id, "fail-1") == 0);
  app_message_client_close(client);
}

static void test_outbox_timeout_preserves_unknown_delivery_across_retries(void) {
  reset_runtime();
  Harness h = {0};
  AppMessageClient *client = open_client(&h, APP_MESSAGE_ID_CSTRING);
  receive_ready();
  s_send_results[0] = APP_MSG_OK;
  s_send_results[1] = APP_MSG_BUSY;
  s_send_results[2] = APP_MSG_BUSY;
  s_send_result_count = 3;
  app_message_client_start(
      client, 2, APP_MESSAGE_OPERATION_MUTATION, "maybe-1",
      APP_MESSAGE_SEND_PRIMARY);

  fire_next_timer();  // The first outbox callback is lost; delivery is unknown.
  fire_next_timer();  // Retry is synchronously rejected.
  fire_next_timer();  // Final retry is rejected and reports the whole request.

  assert(s_sent_count == 3);
  assert(strcmp(sent_id(0), sent_id(1)) == 0);
  assert(strcmp(sent_id(1), sent_id(2)) == 0);
  assert(h.failures == 1);
  assert(h.last_failure.failure == APP_MESSAGE_FAILURE_DELIVERY);
  assert(h.last_failure.delivery == APP_MESSAGE_DELIVERY_UNKNOWN);
  assert(strcmp(h.last_failure.request_id, "maybe-1") == 0);
  app_message_client_close(client);
}

int main(void) {
  test_ready_grace_and_lost_ready();
  test_send_failures_retry_same_identity();
  test_coalesce_stale_and_read_resend();
  test_mutation_timeout_reconciles_without_replaying();
  test_more_then_done_and_late_outbox_ignored();
  test_failure_reports_delivery_certainty();
  test_outbox_timeout_preserves_unknown_delivery_across_retries();
  puts("app message client behavioral scenarios passed");
  return 0;
}
