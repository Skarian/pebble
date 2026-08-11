package com.skarian.pebble.errors

import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.UUID
import org.json.JSONArray
import org.json.JSONObject

internal interface JournalStore {
    val lockKey: Any get() = this
    fun read(): String?
    fun write(value: String)
    fun clear()
}
internal class FileStore(file: File) : JournalStore {
    private val file = AtomicFile(file)
    override val lockKey get() = file.baseFile.absolutePath
    override fun read() = file.baseFile.takeIf(File::exists)?.let { file.openRead().bufferedReader().use { it.readText() } }
    override fun write(value: String) {
        file.baseFile.parentFile?.mkdirs()
        val output = file.startWrite()
        try { output.write(value.toByteArray()); file.finishWrite(output) }
        catch (error: Throwable) { file.failWrite(output); throw error }
    }
    override fun clear() {
        file.delete()
        check(!file.baseFile.exists()) { "Could not clear the private error journal." }
    }
}

internal class ErrorJournal(
    private val store: JournalStore,
    private val maxBytes: Int = 256 * 1024,
    private val maxRecords: Int = 128,
) {
    private val lock = synchronized(locks) { locks.getOrPut(store.lockKey, ::Any) }

    fun add(incoming: List<JSONObject>) = synchronized(lock) {
        val records = readOrReset()
        incoming.forEach { incomingRecord ->
            if (records.none { it.getString("id") == incomingRecord.getString("id") }) records += bound(incomingRecord)
        }
        while (records.size > maxRecords || encode(records).toByteArray().size > maxBytes) {
            val index = records.indexOfFirst { it.optString("_kind") != "overflow" }
            check(index >= 0) { "Error journal is too small for its overflow record." }
            val removed = records.removeAt(index)
            records.firstOrNull { it.optString("_kind") == "overflow" }
                ?.getJSONObject("error")?.increment("dropped")
                ?: records.add(Capture.queueOverflow(removed.optString("source")))
        }
        store.write(encode(records))
    }

    fun next() = synchronized(lock) { readOrReset().firstOrNull()?.let { JSONObject(it.toString()) } }
    fun acknowledge(id: String) = synchronized(lock) {
        val remaining = readOrReset().filterTo(mutableListOf()) { it.getString("id") != id }
        if (remaining.isEmpty()) store.clear() else store.write(encode(remaining))
    }
    fun size() = synchronized(lock) { readOrReset().size }
    fun clear() = synchronized(lock) { store.clear() }

    private fun bound(record: JSONObject): JSONObject {
        if (record.toString().toByteArray().size <= RECORD_BYTES) return record
        val source = record.getJSONObject("error")
        for (limit in listOf(2_048, 1_024, 512, 256, 128)) {
            val error = JSONObject()
            source.keys().asSequence().take(48).forEach { key ->
                val value = source.get(key)
                error.put(key, if (value is Number || value is Boolean) value else bounded(value.toString(), limit))
            }
            val compact = JSONObject(record.toString()).put("error", error.put("truncated", true))
            if (compact.toString().toByteArray().size <= RECORD_BYTES) return compact
        }
        error("Unable to bound an error record.")
    }

    private fun readOrReset(): MutableList<JSONObject> = try {
        store.read()?.let { raw ->
            val root = JSONObject(raw)
            require(root.optInt("version", 1) == 1) { "Unsupported private error journal." }
            root.optJSONArray("records")?.objects() ?: mutableListOf()
        } ?: mutableListOf()
    } catch (error: Throwable) {
        Log.e("PebbleErrors", "Resetting a corrupt private error journal", error)
        mutableListOf()
    }
    private fun encode(records: List<JSONObject>) = JSONObject()
        .put("version", 1).put("records", JSONArray(records)).toString()

    private companion object {
        const val RECORD_BYTES = 16 * 1024
        val locks = mutableMapOf<Any, Any>()
    }
}

internal object Capture {
    fun error(
        source: String, whileDoing: String, original: Any, secrets: Collection<String>,
        id: String = UUID.randomUUID().toString(), at: String = iso(),
    ): List<JSONObject> {
        require(whileDoing.isNotBlank())
        val raw = snapshot(original) as? Map<*, *>
            ?: mapOf("type" to original.javaClass.name, "value" to original.toString())
        @Suppress("UNCHECKED_CAST")
        val safe = redact(raw, secrets) as Map<String, Any?>
        return listOf(record(id, at, source, whileDoing, JSONObject(safe)))
    }

    fun watch(source: String, generation: Long, sequence: Long, at: Long, payload: String,
              dropped: Long, secrets: Collection<String>): List<JSONObject> {
        val field = payload.split('\t', limit = 9)
        require(field.size == 9 && field[0] == "v1") { "Unsupported watch error payload." }
        val raw = linkedMapOf<String, Any?>(
            "type" to field[1], "function" to field[2],
            "code" to (field[3].toLongOrNull() ?: field[3]), "symbol" to field[4],
            "message" to field[5], "file" to field[6],
            "line" to (field[7].toIntOrNull() ?: field[7]),
        )
        val whenAt = iso(Instant.ofEpochSecond(at.takeIf { it > 0 } ?: Instant.now().epochSecond))
        val records = error(source, field[8], raw, secrets, "watch:$source:$generation:$sequence", whenAt)
        return if (dropped == 0L) records else records + record(
            "watch-overflow:$source:$generation:$sequence", whenAt, source, "preserving watch errors",
            JSONObject().put("name", "WatchErrorQueueOverflow").put("dropped", dropped),
        )
    }

    fun queueOverflow(source: String, dropped: Long = 1) = record(
        UUID.randomUUID().toString(), iso(), source.ifBlank { "pebble-errors/android" },
        "preserving queued errors", JSONObject().put("name", "QueueOverflow").put("dropped", dropped),
    ).put("_kind", "overflow")

    private fun record(id: String, at: String, source: String, whileDoing: String, error: JSONObject) = JSONObject()
        .put("id", id).put("at", at).put("source", source).put("while", whileDoing).put("error", error)
}

/** Captures Throwables and caller-supplied Map/Enum fields without reflecting into private objects. */
private fun snapshot(input: Any?, depth: Int = 0): Any? = when {
    input == null || input is Boolean || input is Number -> input
    input is String || input is Char -> bounded(input.toString(), 8_192)
    depth == 7 -> "[TRUNCATED]"
    input is Throwable -> linkedMapOf(
        "name" to input.javaClass.name,
        "message" to input.message?.let { bounded(it, 8_192) },
        "stack" to bounded(input.stackTraceToString(), 12_000),
        "cause" to input.cause?.let { snapshot(it, depth + 1) },
        "suppressed" to input.suppressed.take(32).map { snapshot(it, depth + 1) },
    )
    input is Enum<*> -> mapOf("type" to input.javaClass.name, "name" to input.name)
    input is Map<*, *> -> input.entries.take(48).associate {
        bounded(it.key.toString(), 96) to snapshot(it.value, depth + 1)
    }
    input is Iterable<*> -> input.take(48).map { snapshot(it, depth + 1) }
    input is Array<*> -> input.take(48).map { snapshot(it, depth + 1) }
    else -> mapOf("type" to input.javaClass.name,
        "value" to runCatching { bounded(input.toString(), 8_192) }.getOrDefault("[UNAVAILABLE]"))
}

private val sensitiveKeys = setOf(
    "authorization", "proxyauthorization", "cookie", "setcookie", "password", "passwd", "token",
    "accesstoken", "refreshtoken", "clientsecret", "idtoken", "apikey", "credential", "credentials",
    "secret", "transcript", "usermessage", "messagebody",
)
private val embeddedSecret = Regex(
    "(?i)((?:password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|credentials?|secret|client[_-]?secret)[\"']?\\s*[:=]\\s*[\"']?)[^&\\s,\"'}]+",
)
private fun redact(input: Any?, exact: Collection<String>, key: String = ""): Any? {
    if (key.lowercase().filter(Char::isLetterOrDigit) in sensitiveKeys) return "[REDACTED]"
    return when (input) {
        is Map<*, *> -> input.entries.associate { it.key.toString() to redact(it.value, exact, it.key.toString()) }
        is Iterable<*> -> input.map { redact(it, exact) }
        is String -> exact.filter(String::isNotEmpty).distinct().fold(
            input.replace(Regex("(?i)(Bearer\\s+)[A-Za-z0-9._~+/=-]+"), "$1[REDACTED]")
                .replace(embeddedSecret, "$1[REDACTED]"),
        ) { text, secret -> when {
            text == secret -> "[REDACTED]"
            secret.length >= 4 -> text.replace(secret, "[REDACTED]")
            else -> text
        } }
        else -> input
    }
}

private val isoMillis = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
private fun iso(value: Instant = Instant.now()) = isoMillis.format(value)
private fun bounded(value: String, limit: Int): String {
    if (value.toByteArray(UTF_8).size <= limit) return value
    val marker = "[TRUNCATED]"
    var low = 0; var high = value.length
    while (low < high) {
        val middle = (low + high + 1) / 2
        if ((value.take(middle) + marker).toByteArray(UTF_8).size <= limit) low = middle
        else high = middle - 1
    }
    return value.take(low) + marker
}
private fun JSONArray.objects() = (0 until length()).mapTo(mutableListOf()) { getJSONObject(it) }
internal fun JSONObject.copyPublic() = JSONObject(toString()).apply { remove("_kind") }
private fun JSONObject.increment(key: String) = put(key, optLong(key) + 1)
