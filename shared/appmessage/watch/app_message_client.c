#include "app_message_client.h"

#include <stdlib.h>
#include <string.h>

#define APP_MESSAGE_INTERNAL_ATTEMPT_KEY 127
#define READY_GRACE_MS 1500
#define OUTBOX_TIMEOUT_MS 5000
#define RESPONSE_TIMEOUT_MS 30000
#define RETRY_BACKOFF_MS 400
#define MAX_PRIMARY_ATTEMPTS 3
#define MAX_RECONCILE_ATTEMPTS 2

struct AppMessageClient {
  AppMessageClientConfig config;
  AppMessageClientStatus status;
  AppMessageOperationType operation_type;
  AppTimer *timer;
  uint16_t next_numeric_id;
  uint8_t primary_attempts;
  uint8_t reconcile_attempts;
  uint8_t attempt_token;
  bool active;
  bool opened;
  bool phone_ready;
  bool acknowledged;
  bool delivery_unknown;
  char request_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
};

static AppMessageClient *s_open_client;

static void timer_fired(void *context);

static const char *app_name(const AppMessageClient *client) {
  return client->config.app_name ? client->config.app_name : "watchapp";
}

static void cancel_timer(AppMessageClient *client) {
  if (!client->timer) return;
  app_timer_cancel(client->timer);
  client->timer = NULL;
}

static void notify_state(AppMessageClient *client, AppMessageClientState state) {
  client->status.state = state;
  APP_LOG(APP_LOG_LEVEL_DEBUG,
          "appmessage event=state app=%s op=%u id=%.16s ready=%u state=%u primary=%u reconcile=%u ack=%u",
          app_name(client), client->status.operation, client->request_id,
          client->phone_ready, state, client->primary_attempts,
          client->reconcile_attempts, client->acknowledged);
  if (client->config.state_changed) {
    client->config.state_changed(&client->status, client->config.context);
  }
}

static void arm_timer(AppMessageClient *client, uint32_t delay_ms) {
  cancel_timer(client);
  client->timer = app_timer_register(delay_ms ? delay_ms : 1, timer_fired, client);
}

static uint8_t attempts(const AppMessageClient *client) {
  return client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? client->reconcile_attempts : client->primary_attempts;
}

static uint8_t max_attempts(const AppMessageClient *client) {
  return client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? MAX_RECONCILE_ATTEMPTS : MAX_PRIMARY_ATTEMPTS;
}

static void reset_request(AppMessageClient *client) {
  cancel_timer(client);
  client->active = false;
  client->attempt_token = 0;
  client->status.operation = 0;
  client->operation_type = APP_MESSAGE_OPERATION_READ;
  client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
  client->primary_attempts = 0;
  client->reconcile_attempts = 0;
  client->acknowledged = false;
  client->delivery_unknown = false;
  client->request_id[0] = '\0';
  notify_state(client, APP_MESSAGE_CLIENT_IDLE);
}

static void fail_request(
    AppMessageClient *client,
    AppMessageClientFailure failure,
    AppMessageResult result) {
  cancel_timer(client);
  notify_state(client, APP_MESSAGE_CLIENT_FAILED);
  APP_LOG(APP_LOG_LEVEL_ERROR,
          "appmessage event=terminal_failure app=%s op=%u id=%.16s failure=%u result=%d ack=%u",
          app_name(client), client->status.operation, client->request_id,
          failure, result, client->acknowledged);
  if (client->config.request_failed) {
    AppMessageFailureInfo info = {
      .failure = failure,
      .result = result,
      .delivery = client->acknowledged ? APP_MESSAGE_DELIVERY_ACKNOWLEDGED
          : client->delivery_unknown ? APP_MESSAGE_DELIVERY_UNKNOWN
          : failure == APP_MESSAGE_FAILURE_DELIVERY &&
                result != APP_MSG_SEND_TIMEOUT
              ? APP_MESSAGE_DELIVERY_NOT_SENT
              : APP_MESSAGE_DELIVERY_UNKNOWN,
      .operation = client->status.operation,
      .send_kind = client->status.send_kind,
      .request_id = client->request_id,
    };
    client->config.request_failed(&info, client->config.context);
  }
  reset_request(client);
}

static void retry_or_fail(
    AppMessageClient *client,
    AppMessageClientFailure failure,
    AppMessageResult result) {
  if (failure == APP_MESSAGE_FAILURE_OUTBOX_TIMEOUT ||
      result == APP_MSG_SEND_TIMEOUT) {
    client->delivery_unknown = true;
  }
  if (attempts(client) >= max_attempts(client)) {
    fail_request(client, failure, result);
    return;
  }
  notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
  arm_timer(client, RETRY_BACKOFF_MS * attempts(client));
}

static bool tuple_number(const Tuple *tuple, uint32_t *value) {
  if (!tuple || !value) return false;
  if (tuple->type == TUPLE_UINT) {
    if (tuple->length == 1) *value = tuple->value->uint8;
    else if (tuple->length == 2) *value = tuple->value->uint16;
    else *value = tuple->value->uint32;
    return true;
  }
  if (tuple->type == TUPLE_INT) {
    int32_t number = tuple->length == 1 ? tuple->value->int8
        : tuple->length == 2 ? tuple->value->int16 : tuple->value->int32;
    if (number < 0) return false;
    *value = (uint32_t)number;
    return true;
  }
  return false;
}

static bool parse_uint16_id(const char *text, uint16_t *value) {
  if (!text || !text[0] || !value) return false;
  uint32_t result = 0;
  for (const char *cursor = text; *cursor; cursor++) {
    if (*cursor < '0' || *cursor > '9') return false;
    result = result * 10 + (uint32_t)(*cursor - '0');
    if (result > UINT16_MAX) return false;
  }
  if (result == 0) return false;
  *value = (uint16_t)result;
  return true;
}

static bool decode_request_id(
    const AppMessageClient *client,
    DictionaryIterator *iterator,
    char *buffer,
    size_t buffer_size) {
  Tuple *tuple = dict_find(iterator, client->config.protocol.request_id_key);
  if (!tuple) return false;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_CSTRING) {
    if (tuple->type != TUPLE_CSTRING) return false;
    const char *value = tuple->value->cstring;
    size_t length = strlen(value);
    if (!length || length >= buffer_size) return false;
    snprintf(buffer, buffer_size, "%s", value);
    return true;
  }
  uint32_t number;
  if (!tuple_number(tuple, &number) || number == 0 || number > UINT16_MAX) return false;
  snprintf(buffer, buffer_size, "%u", (unsigned)number);
  return true;
}

static DictionaryResult write_envelope(
    AppMessageClient *client, DictionaryIterator *iterator) {
  DictionaryResult result = dict_write_uint8(
      iterator, client->config.protocol.protocol_key,
      client->config.protocol.protocol_version);
  if (result != DICT_OK) return result;
  uint8_t command = client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? client->config.protocol.reconcile_command : client->status.operation;
  result = dict_write_uint8(iterator, client->config.protocol.command_key, command);
  if (result != DICT_OK) return result;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_CSTRING) {
    result = dict_write_cstring(
        iterator, client->config.protocol.request_id_key, client->request_id);
  } else {
    uint16_t numeric_id;
    if (!parse_uint16_id(client->request_id, &numeric_id)) return DICT_INVALID_ARGS;
    result = dict_write_uint16(
        iterator, client->config.protocol.request_id_key, numeric_id);
  }
  if (result != DICT_OK) return result;
  return dict_write_uint8(
      iterator, APP_MESSAGE_INTERNAL_ATTEMPT_KEY, client->attempt_token);
}

static AppMessageResult send_dictionary(AppMessageClient *client) {
  DictionaryIterator *iterator;
  AppMessageResult result = app_message_outbox_begin(&iterator);
  if (result != APP_MSG_OK) return result;
  if (write_envelope(client, iterator) != DICT_OK) return APP_MSG_BUFFER_OVERFLOW;
  if (client->config.write_payload &&
      client->config.write_payload(
          iterator, &client->status, client->config.context) != DICT_OK) {
    return APP_MSG_BUFFER_OVERFLOW;
  }
  return app_message_outbox_send();
}

static void send_attempt(AppMessageClient *client) {
  if (!client->active) return;
  cancel_timer(client);
  uint8_t *count = client->status.send_kind == APP_MESSAGE_SEND_RECONCILE
      ? &client->reconcile_attempts : &client->primary_attempts;
  (*count)++;
  client->attempt_token++;
  if (!client->attempt_token) client->attempt_token++;
  APP_LOG(APP_LOG_LEVEL_INFO,
          "appmessage event=send_attempt app=%s op=%u kind=%u id=%.16s attempt=%u",
          app_name(client), client->status.operation, client->status.send_kind,
          client->request_id, *count);
  AppMessageResult result = send_dictionary(client);
  if (result == APP_MSG_OK) {
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_OUTBOX);
    arm_timer(client, OUTBOX_TIMEOUT_MS);
    return;
  }
  APP_LOG(APP_LOG_LEVEL_WARNING,
          "appmessage event=send_rejected app=%s op=%u id=%.16s result=%d",
          app_name(client), client->status.operation, client->request_id, result);
  retry_or_fail(client, APP_MESSAGE_FAILURE_DELIVERY, result);
}

static void start_reconcile(AppMessageClient *client) {
  if (!client->config.protocol.reconcile_command) {
    fail_request(client, APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT, APP_MSG_OK);
    return;
  }
  client->status.send_kind = APP_MESSAGE_SEND_RECONCILE;
  client->reconcile_attempts = 0;
  send_attempt(client);
}

static void response_timed_out(AppMessageClient *client) {
  APP_LOG(APP_LOG_LEVEL_WARNING,
          "appmessage event=response_timeout app=%s op=%u kind=%u id=%.16s",
          app_name(client), client->status.operation, client->status.send_kind,
          client->request_id);
  if (client->operation_type == APP_MESSAGE_OPERATION_READ) {
    client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
    if (client->primary_attempts < MAX_PRIMARY_ATTEMPTS) {
      notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
      arm_timer(client, RETRY_BACKOFF_MS * client->primary_attempts);
    } else {
      fail_request(client, APP_MESSAGE_FAILURE_RESPONSE_TIMEOUT, APP_MSG_OK);
    }
    return;
  }
  if (client->status.send_kind != APP_MESSAGE_SEND_RECONCILE) {
    start_reconcile(client);
  } else if (client->reconcile_attempts < MAX_RECONCILE_ATTEMPTS) {
    notify_state(client, APP_MESSAGE_CLIENT_BACKING_OFF);
    arm_timer(client, RETRY_BACKOFF_MS * client->reconcile_attempts);
  } else {
    fail_request(client, APP_MESSAGE_FAILURE_RECONCILE_TIMEOUT, APP_MSG_OK);
  }
}

static void timer_fired(void *context) {
  AppMessageClient *client = context;
  client->timer = NULL;
  if (!client->active) return;
  switch (client->status.state) {
    case APP_MESSAGE_CLIENT_WAITING_READY:
    case APP_MESSAGE_CLIENT_BACKING_OFF:
      send_attempt(client);
      break;
    case APP_MESSAGE_CLIENT_WAITING_OUTBOX:
      APP_LOG(APP_LOG_LEVEL_WARNING,
              "appmessage event=outbox_timeout app=%s op=%u id=%.16s",
              app_name(client), client->status.operation, client->request_id);
      retry_or_fail(
          client, APP_MESSAGE_FAILURE_OUTBOX_TIMEOUT, APP_MSG_SEND_TIMEOUT);
      break;
    case APP_MESSAGE_CLIENT_WAITING_RESPONSE:
      response_timed_out(client);
      break;
    default:
      break;
  }
}

static bool is_ready_message(
    const AppMessageClient *client, DictionaryIterator *iterator) {
  uint32_t protocol;
  uint32_t command;
  return tuple_number(
             dict_find(iterator, client->config.protocol.protocol_key), &protocol) &&
      protocol == client->config.protocol.protocol_version &&
      tuple_number(
          dict_find(iterator, client->config.protocol.command_key), &command) &&
      command == client->config.protocol.ready_command;
}

static void inbox_received(DictionaryIterator *iterator, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened) return;
  if (is_ready_message(client, iterator)) {
    client->phone_ready = true;
    APP_LOG(APP_LOG_LEVEL_INFO,
            "appmessage event=ready app=%s ready=1", app_name(client));
    if (client->active && client->status.state == APP_MESSAGE_CLIENT_WAITING_READY) {
      send_attempt(client);
    }
    return;
  }

  char response_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
  if (!decode_request_id(client, iterator, response_id, sizeof(response_id))) {
    if (client->config.unsolicited_received) {
      client->config.unsolicited_received(
          iterator, client->config.context);
    }
    return;
  }
  if (!client->active || strcmp(response_id, client->request_id) != 0) {
    APP_LOG(APP_LOG_LEVEL_WARNING,
            "appmessage event=stale_response app=%s op=%u id=%.16s",
            app_name(client), client->status.operation, response_id);
    return;
  }
  if (!client->config.response_received) return;
  AppMessageResponseAction action = client->config.response_received(
      iterator, &client->status, client->config.context);
  if (!client->active || strcmp(response_id, client->request_id) != 0) return;
  if (action == APP_MESSAGE_RESPONSE_MORE) {
    cancel_timer(client);
    client->acknowledged = true;
    if (client->operation_type == APP_MESSAGE_OPERATION_MUTATION) {
      client->status.send_kind = APP_MESSAGE_SEND_PRIMARY;
      client->reconcile_attempts = 0;
    }
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_RESPONSE);
    arm_timer(client, RESPONSE_TIMEOUT_MS);
  } else if (action == APP_MESSAGE_RESPONSE_DONE) {
    reset_request(client);
  }
}

static void inbox_dropped(AppMessageResult reason, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened) return;
  APP_LOG(APP_LOG_LEVEL_WARNING,
          "appmessage event=inbox_dropped app=%s op=%u id=%.16s result=%d",
          app_name(client), client->status.operation, client->request_id, reason);
}

static bool callback_matches(
    AppMessageClient *client, DictionaryIterator *iterator) {
  char request_id[APP_MESSAGE_CLIENT_ID_CAPACITY];
  if (!client->active ||
      !decode_request_id(client, iterator, request_id, sizeof(request_id)) ||
      strcmp(request_id, client->request_id) != 0) return false;
  uint32_t token;
  return tuple_number(dict_find(iterator, APP_MESSAGE_INTERNAL_ATTEMPT_KEY), &token) &&
      token != 0 && token == client->attempt_token &&
      client->status.state == APP_MESSAGE_CLIENT_WAITING_OUTBOX;
}

static void outbox_sent(DictionaryIterator *iterator, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened || !callback_matches(client, iterator)) return;
  cancel_timer(client);
  client->acknowledged = true;
  notify_state(client, APP_MESSAGE_CLIENT_WAITING_RESPONSE);
  arm_timer(client, RESPONSE_TIMEOUT_MS);
}

static void outbox_failed(
    DictionaryIterator *iterator, AppMessageResult reason, void *context) {
  (void)context;
  AppMessageClient *client = s_open_client;
  if (!client || !client->opened || !callback_matches(client, iterator)) {
    APP_LOG(APP_LOG_LEVEL_WARNING,
            "appmessage event=stale_outbox_failure app=%s result=%d",
            client ? app_name(client) : "watchapp", reason);
    return;
  }
  cancel_timer(client);
  APP_LOG(APP_LOG_LEVEL_WARNING,
          "appmessage event=outbox_failed app=%s op=%u id=%.16s result=%d",
          app_name(client), client->status.operation, client->request_id, reason);
  retry_or_fail(client, APP_MESSAGE_FAILURE_DELIVERY, reason);
}

AppMessageClient *app_message_client_open(
    const AppMessageClientConfig *config, AppMessageResult *open_result) {
  if (open_result) *open_result = APP_MSG_INVALID_ARGS;
  if (!config || !config->inbox_size || !config->outbox_size ||
      !config->response_received || s_open_client) return NULL;
  AppMessageClient *client = calloc(1, sizeof(*client));
  if (!client) {
    if (open_result) *open_result = APP_MSG_OUT_OF_MEMORY;
    return NULL;
  }
  client->config = *config;
  client->status.request_id = client->request_id;
  client->status.state = APP_MESSAGE_CLIENT_IDLE;
  s_open_client = client;
  app_message_register_inbox_received(inbox_received);
  app_message_register_inbox_dropped(inbox_dropped);
  app_message_register_outbox_sent(outbox_sent);
  app_message_register_outbox_failed(outbox_failed);
  AppMessageResult result = app_message_open(
      client->config.inbox_size, client->config.outbox_size);
  if (result != APP_MSG_OK) {
    APP_LOG(APP_LOG_LEVEL_ERROR,
            "appmessage event=open_failed app=%s result=%d",
            app_name(client), result);
    app_message_deregister_callbacks();
    s_open_client = NULL;
    free(client);
    if (open_result) *open_result = result;
    return NULL;
  }
  client->opened = true;
  APP_LOG(APP_LOG_LEVEL_INFO, "appmessage event=open app=%s", app_name(client));
  if (open_result) *open_result = APP_MSG_OK;
  return client;
}

void app_message_client_close(AppMessageClient *client) {
  if (!client) return;
  cancel_timer(client);
  client->active = false;
  client->opened = false;
  if (s_open_client == client) {
    app_message_deregister_callbacks();
    s_open_client = NULL;
  }
  APP_LOG(APP_LOG_LEVEL_INFO, "appmessage event=close app=%s", app_name(client));
  free(client);
}

static bool assign_request_id(AppMessageClient *client, const char *request_id) {
  if (!request_id) {
    if (client->config.protocol.request_id_codec != APP_MESSAGE_ID_UINT16) return false;
    client->next_numeric_id++;
    if (!client->next_numeric_id) client->next_numeric_id++;
    snprintf(client->request_id, sizeof(client->request_id), "%u",
             client->next_numeric_id);
    return true;
  }
  if (!request_id[0] || strlen(request_id) >= sizeof(client->request_id)) return false;
  if (client->config.protocol.request_id_codec == APP_MESSAGE_ID_UINT16) {
    uint16_t numeric_id;
    if (!parse_uint16_id(request_id, &numeric_id)) return false;
    if (numeric_id > client->next_numeric_id) client->next_numeric_id = numeric_id;
  }
  snprintf(client->request_id, sizeof(client->request_id), "%s", request_id);
  return true;
}

AppMessageStartResult app_message_client_start(
    AppMessageClient *client,
    uint8_t operation,
    AppMessageOperationType operation_type,
    const char *request_id,
    AppMessageSendKind initial_send_kind) {
  if (!client || !client->opened || !operation ||
      (initial_send_kind == APP_MESSAGE_SEND_RECONCILE &&
       !client->config.protocol.reconcile_command)) return APP_MESSAGE_START_INVALID;
  if (client->active) {
    bool same_id = request_id
        ? strcmp(client->request_id, request_id) == 0 : true;
    return client->status.operation == operation &&
            client->operation_type == operation_type && same_id
        ? APP_MESSAGE_START_COALESCED : APP_MESSAGE_START_BUSY;
  }
  if (!assign_request_id(client, request_id)) return APP_MESSAGE_START_INVALID;
  client->active = true;
  client->status.operation = operation;
  client->operation_type = operation_type;
  client->status.send_kind = initial_send_kind;
  client->primary_attempts = 0;
  client->reconcile_attempts = 0;
  client->acknowledged = initial_send_kind == APP_MESSAGE_SEND_RECONCILE;
  client->delivery_unknown = false;
  client->attempt_token = 0;
  if (client->phone_ready) {
    send_attempt(client);
  } else {
    notify_state(client, APP_MESSAGE_CLIENT_WAITING_READY);
    arm_timer(client, READY_GRACE_MS);
  }
  return APP_MESSAGE_START_STARTED;
}

bool app_message_client_is_active(const AppMessageClient *client) {
  return client && client->active;
}

bool app_message_client_has_request(
    const AppMessageClient *client, const char *request_id) {
  return client && client->active && request_id &&
      strcmp(client->request_id, request_id) == 0;
}

const AppMessageClientStatus *app_message_client_status(
    const AppMessageClient *client) {
  return client ? &client->status : NULL;
}

void app_message_client_cancel(AppMessageClient *client) {
  if (client && client->active) reset_request(client);
}
