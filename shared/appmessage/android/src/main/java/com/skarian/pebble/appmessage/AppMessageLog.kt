package com.skarian.pebble.appmessage

import android.content.Context
import android.util.Log
import java.nio.charset.StandardCharsets
import java.security.MessageDigest

internal data class LogEntry(
    val at: Long = 0,
    val operation: String,
    val requestId: String = "",
    val event: String,
    val lifecycle: String = "active",
    val ready: Boolean = false,
    val attempt: Int = 0,
    val part: Int = 0,
    val result: String = "",
    val detail: String = "",
    val category: String = "",
)

internal interface LogStorage {
    fun read(): String
    fun write(value: String)
}

/** A bounded, payload-free trail for AppMessage failures and recovery. */
internal class AppMessageLog(
    private val app: String,
    private val storage: LogStorage,
    private val limit: Int = 64,
    private val now: () -> Long = System::currentTimeMillis,
    private val output: (String) -> Unit = {},
) {
    constructor(context: Context, app: String, limit: Int = 64) : this(
        app = app,
        storage = PreferencesLogStorage(context),
        limit = limit,
        output = { Log.i("PebbleAppMessage", it) },
    )

    init {
        require(limit > 0)
    }

    fun record(entry: LogEntry) {
        runCatching {
            synchronized(LOCK) {
                val safe = sanitize(entry.copy(at = entry.at.takeIf { it > 0 } ?: now()))
                storage.write((readUnsafe() + safe).takeLast(limit).joinToString("\n", transform = ::encode))
                output(oneLine(safe))
            }
        }
    }

    fun export(): String = runCatching {
        synchronized(LOCK) { json(readUnsafe()) }
    }.getOrElse { json(emptyList()) }

    fun replay() {
        runCatching { synchronized(LOCK) { readUnsafe().forEach { output(oneLine(it)) } } }
    }

    private fun readUnsafe() = storage.read().lineSequence()
        .filter(String::isNotBlank)
        .mapNotNull(::decode)
        .toList()

    private fun sanitize(value: LogEntry) = value.copy(
        operation = token(value.operation),
        requestId = request(value.requestId),
        event = token(value.event),
        lifecycle = token(value.lifecycle),
        attempt = value.attempt.coerceIn(0, 99),
        part = value.part.coerceIn(0, 999),
        result = token(value.result),
        detail = token(value.detail),
        category = token(value.category),
    )

    private fun request(value: String): String {
        if (value.isBlank() || NUMERIC_REQUEST.matches(value)) return value
        val digest = MessageDigest.getInstance("SHA-256")
            .digest(value.toByteArray(StandardCharsets.UTF_8))
            .take(6)
            .joinToString("") { "%02x".format(it) }
        return "hash:$digest"
    }

    private fun encode(value: LogEntry) = listOf(
        value.at, value.operation, value.requestId, value.event, value.lifecycle,
        if (value.ready) 1 else 0, value.attempt, value.part, value.result,
        value.detail, value.category,
    ).joinToString("\t")

    private fun decode(line: String): LogEntry? = runCatching {
        val value = line.split('\t', limit = FIELD_COUNT)
        require(value.size == FIELD_COUNT)
        LogEntry(
            at = value[0].toLong(), operation = value[1], requestId = value[2],
            event = value[3], lifecycle = value[4], ready = value[5] == "1",
            attempt = value[6].toInt(), part = value[7].toInt(), result = value[8],
            detail = value[9], category = value[10],
        )
    }.getOrNull()

    private fun json(entries: List<LogEntry>) = entries.joinToString(
        prefix = "{\n  \"version\": 1,\n  \"events\": [\n",
        separator = ",\n",
        postfix = "\n  ]\n}",
    ) {
        "    {\"at\":${it.at},\"app\":\"${escape(token(app))}\",\"operation\":\"${escape(it.operation)}\"," +
            "\"requestRef\":\"${escape(it.requestId)}\",\"event\":\"${escape(it.event)}\"," +
            "\"lifecycle\":\"${escape(it.lifecycle)}\",\"ready\":${it.ready},\"attempt\":${it.attempt}," +
            "\"part\":${it.part},\"result\":\"${escape(it.result)}\",\"detail\":\"${escape(it.detail)}\"," +
            "\"finalCategory\":\"${escape(it.category)}\"}"
    }

    private fun oneLine(value: LogEntry) =
        "at=${value.at} app=${token(app)} operation=${value.operation} request=${value.requestId} " +
            "event=${value.event} lifecycle=${value.lifecycle} ready=${value.ready} attempt=${value.attempt} " +
            "part=${value.part} result=${value.result}:${value.detail} category=${value.category}"

    private fun token(value: String) = value.takeIf(SAFE_TOKEN::matches)?.take(48).orEmpty()
    private fun escape(value: String) = value.replace("\\", "\\\\").replace("\"", "\\\"")

    private companion object {
        const val FIELD_COUNT = 11
        val LOCK = Any()
        val NUMERIC_REQUEST = Regex("[0-9]{1,10}")
        val SAFE_TOKEN = Regex("[A-Za-z0-9_.:-]{0,48}")
    }
}

private class PreferencesLogStorage(context: Context) : LogStorage {
    private val preferences = context.applicationContext.getSharedPreferences(
        "pebble_appmessage_log",
        Context.MODE_PRIVATE,
    )

    override fun read() = preferences.getString("events_v1", "").orEmpty()
    override fun write(value: String) {
        preferences.edit().putString("events_v1", value).commit()
    }
}
