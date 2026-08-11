package com.skarian.pebble.errors

import android.util.AtomicFile
import android.util.Log
import java.io.File
import java.lang.reflect.Modifier
import java.nio.charset.StandardCharsets.UTF_8
import java.time.Instant
import java.time.format.DateTimeFormatterBuilder
import java.util.Collections
import java.util.IdentityHashMap
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
internal data class JournalStatus(val queued: Int, val held: Int)
internal class ErrorJournal(
    private val store: JournalStore,
    private val maxBytes: Int = 256 * 1024,
    private val maxRecords: Int = 128,
) {
    private val lock = synchronized(locks) { locks.getOrPut(store.lockKey, ::Any) }

    fun add(incoming: List<JSONObject>) = synchronized(lock) {
        val state = readOrRecover(incoming.firstOrNull()?.optString("source").orEmpty())
        incoming.forEach { record ->
            val kind = record.optString("_kind")
            if (state.records.none { it.getString("id") == record.getString("id") ||
                    kind.isNotEmpty() && it.optString("_kind") == kind }) {
                state.records += bound(record)
            }
        }
        while (state.records.size > maxRecords || encode(state).toByteArray().size > maxBytes) {
            val index = state.records.indexOfFirst { it.optString("_kind") != "overflow" }
            check(index >= 0) { "Error journal is too small for its overflow record." }
            val removed = state.records.removeAt(index)
            val overflow = state.records.firstOrNull { it.optString("_kind") == "overflow" }
            if (overflow == null) state.records += Capture.queueOverflow(removed.optString("source"))
            else overflow.getJSONObject("error").increment("dropped")
        }
        store.write(encode(state))
    }

    fun next(includePrivate: Boolean = false) = synchronized(lock) {
        readOrRecover().records.firstOrNull { !it.optBoolean("_held") }
            ?.let { if (includePrivate) JSONObject(it.toString()) else it.copyPublic() }
    }

    fun acknowledge(id: String) = synchronized(lock) {
        val state = readOrRecover().apply { records = records.filter { it.getString("id") != id }.toMutableList() }
        if (state.records.isEmpty()) store.clear() else store.write(encode(state))
    }

    fun status() = synchronized(lock) { readOrRecover().let { state ->
        val held = state.records.count { it.optBoolean("_held") }
        JournalStatus(state.records.size - held, held)
    } }

    fun clear() = synchronized(lock) { store.clear() }

    private fun bound(record: JSONObject): JSONObject {
        if (record.toString().toByteArray().size <= 16 * 1024) return record
        for (limit in listOf(2_048, 1_024, 512, 256, 128, 64)) {
            val compact = JSONObject(record.toString()).put(
                "error", trimJson(record.getJSONObject("error"), limit).also { it.put("truncated", true) },
            )
            if (compact.toString().toByteArray().size <= 16 * 1024) return compact
        }
        error("Unable to bound an error record.")
    }

    private fun read(): State = store.read()?.let { raw ->
        val root = JSONObject(raw)
        require(root.optInt("version", 1) == 1) { "Unsupported private error journal." }
        val records = root.optJSONArray("records")?.objects() ?: mutableListOf()
        root.optLong("dropped").takeIf { it > 0 }?.let { old ->
            records += Capture.queueOverflow(records.firstOrNull()?.optString("source").orEmpty(), old)
        }
        State(records)
    } ?: State()

    private fun readOrRecover(source: String = ""): State = try {
        read()
    } catch (error: Throwable) {
        Log.e("PebbleErrors", "Recovering a corrupt private error journal", error)
        State(mutableListOf(Capture.journalRecovery(source, error))).also {
            store.write(encode(it))
        }
    }

    private fun encode(state: State) = JSONObject().put("version", 1).put("records", JSONArray(state.records)).toString()
    private data class State(var records: MutableList<JSONObject> = mutableListOf())
    private companion object { val locks = mutableMapOf<Any, Any>() }
}

private fun trimJson(value: JSONObject, stringLimit: Int, depth: Int = 0): JSONObject {
    val result = JSONObject()
    val keys = value.keys().asSequence().toList()
    val kept = keys.take(listOf(64, 32, 16, 8)[depth.coerceAtMost(3)])
    kept.forEach { key -> result.put(key, trimJsonValue(value.get(key), stringLimit, depth + 1)) }
    if (kept.size < keys.size) result.put("truncatedFields", keys.size - kept.size)
    return result
}

private fun trimJsonValue(value: Any?, stringLimit: Int, depth: Int): Any? = when (value) {
    is String -> bounded(value, stringLimit)
    is JSONObject -> if (depth >= 4) "[TRUNCATED]" else trimJson(value, stringLimit, depth)
    is JSONArray -> if (depth >= 4) "[TRUNCATED]" else JSONArray().apply {
        val kept = minOf(value.length(), if (depth < 2) 16 else 8)
        repeat(kept) { put(trimJsonValue(value.get(it), stringLimit, depth + 1)) }
        if (kept < value.length()) put("[TRUNCATED ${value.length() - kept} ITEMS]")
    }
    else -> value
}

internal object Capture {
    fun error(
        source: String, whileDoing: String, original: Any, secrets: Collection<String>,
        id: String = UUID.randomUUID().toString(), at: String = iso(),
        redactor: (Any?, Collection<String>) -> Any? = Redaction::apply,
    ): List<JSONObject> {
        require(whileDoing.isNotBlank())
        val raw = Snapshot(original) as? Map<*, *> ?: mapOf("type" to original.javaClass.name, "value" to original.toString())
        return try { listOf(record(id, at, source, whileDoing, JSONObject(redactor(raw, secrets) as Map<*, *>))) }
        catch (failure: Throwable) { listOf(
            record(id, at, source, whileDoing, JSONObject(raw)).put("_held", true),
            record(UUID.randomUUID().toString(), iso(), source, "redacting an error report", JSONObject()
                .put("name", "ErrorRedactionFailure")
                .put("message", "The source error is held locally because redaction failed.")
                .put("failureType", failure.javaClass.name)).put("_kind", "redaction"),
        ) }
    }

    fun watch(source: String, generation: Long, sequence: Long, at: Long, payload: String,
              dropped: Long, secrets: Collection<String>): List<JSONObject> {
        val field = payload.split('\t', limit = 9)
        require(field.size == 9 && field[0] == "v1") { "Unsupported watch error payload." }
        val raw = linkedMapOf<String, Any?>(
            "type" to field[1], "function" to field[2], "code" to (field[3].toLongOrNull() ?: field[3]),
            "symbol" to field[4], "message" to field[5], "file" to field[6],
            "line" to (field[7].toIntOrNull() ?: field[7]),
        )
        val whenAt = iso(Instant.ofEpochSecond(at.takeIf { it > 0 } ?: Instant.now().epochSecond))
        val records = error(source, field[8], raw, secrets, "watch:$source:$generation:$sequence", whenAt)
        return if (dropped == 0L) records else records + record(
            "watch-overflow:$source:$generation:$sequence", whenAt, source, "preserving watch errors",
            JSONObject().put("name", "WatchErrorQueueOverflow")
                .put("message", "Older watch errors were discarded after the bounded queue filled.").put("dropped", dropped),
        )
    }

    fun internal(source: String, whileDoing: String, original: Any, secrets: Collection<String>) =
        error(source, whileDoing, original, secrets).map { it.put("_kind", "upload") }
    fun queueOverflow(source: String, dropped: Long = 1) = record(
        UUID.randomUUID().toString(), iso(), source.ifBlank { "pebble-errors/android" }, "preserving queued errors",
        JSONObject().put("name", "QueueOverflow").put("message", "Older errors were discarded after the queue filled.")
            .put("dropped", dropped),
    ).put("_kind", "overflow")
    fun journalRecovery(source: String, failure: Throwable) = record(
        UUID.randomUUID().toString(), iso(), source.ifBlank { "pebble-errors/android" },
        "recovering the private error journal",
        JSONObject().put("name", "ErrorJournalRecovery")
            .put("message", "The private error journal was corrupt and has been reset.")
            .put("failureType", failure.javaClass.name),
    ).put("_kind", "journal")
    private fun record(id: String, at: String, source: String, whileDoing: String, error: JSONObject) = JSONObject()
        .put("id", id).put("at", at).put("source", source).put("while", whileDoing).put("error", error)
}

private object Snapshot {
    operator fun invoke(input: Any?) = value(input, Collections.newSetFromMap(IdentityHashMap()), 0)
    private fun value(input: Any?, seen: MutableSet<Any>, depth: Int): Any? {
        if (input == null || input is Boolean || input is Number) return input
        if (input is String || input is Char) return bounded(input.toString(), 8_192)
        if (depth == 7) return "[TRUNCATED]"
        if (!seen.add(input)) return "[CYCLE]"
        return try { when (input) {
            is Throwable -> linkedMapOf(
                "name" to input.javaClass.name, "message" to input.message?.let { bounded(it, 8_192) },
                "stack" to bounded(input.stackTraceToString(), 12_000),
                "cause" to input.cause?.let { value(it, seen, depth + 1) },
                "suppressed" to input.suppressed.take(32).map { value(it, seen, depth + 1) },
                "fields" to fields(input, seen, depth),
            )
            is Enum<*> -> mapOf("type" to input.javaClass.name, "name" to input.name)
            is Map<*, *> -> input.entries.take(48).associate { bounded(it.key.toString(), 96) to value(it.value, seen, depth + 1) }
            is Iterable<*> -> input.take(48).map { value(it, seen, depth + 1) }
            is Array<*> -> input.take(48).map { value(it, seen, depth + 1) }
            else -> linkedMapOf("type" to input.javaClass.name,
                "value" to runCatching { bounded(input.toString(), 8_192) }.getOrElse { "[UNAVAILABLE]" },
                "fields" to fields(input, seen, depth))
        } } finally { seen.remove(input) }
    }

    @Suppress("DEPRECATION")
    private fun fields(input: Any, seen: MutableSet<Any>, depth: Int) = input.javaClass.declaredFields.asSequence()
        .filterNot { it.isSynthetic || Modifier.isStatic(it.modifiers) }.take(32).associate { field ->
            field.name to runCatching { field.isAccessible = true; value(field.get(input), seen, depth + 1) }
                .getOrElse { "[UNAVAILABLE: ${it.javaClass.name}]" }
        }
}

private object Redaction {
    private val sensitive = setOf("authorization", "proxyauthorization", "cookie", "setcookie", "password", "passwd",
        "token", "accesstoken", "refreshtoken", "clientsecret", "idtoken", "apikey", "credential", "credentials",
        "secret", "transcript", "usermessage", "messagebody")
    private val embedded = Regex(
        "(?i)((?:password|token|access[_-]?token|refresh[_-]?token|id[_-]?token|session[_-]?token|api[_-]?key|credentials?|secret|client[_-]?secret)[\\\"']?\\s*[:=]\\s*[\\\"']?)[^&\\s,\\\"'}]+",
    )
    fun apply(input: Any?, exact: Collection<String>, key: String = ""): Any? {
        if (key.lowercase().filter(Char::isLetterOrDigit) in sensitive) return "[REDACTED]"
        return when (input) {
            is Map<*, *> -> input.entries.associate { it.key.toString() to apply(it.value, exact, it.key.toString()) }
            is Iterable<*> -> input.map { apply(it, exact) }
            is String -> exact.filter(String::isNotEmpty).distinct().fold(
                input.replace(Regex("(?i)(Bearer\\s+)[A-Za-z0-9._~+/=-]+"), "$1[REDACTED]")
                    .replace(embedded, "$1[REDACTED]"),
            ) { text, secret -> when {
                text == secret -> "[REDACTED]"
                secret.length >= 4 -> text.replace(secret, "[REDACTED]")
                else -> text
            } }
            else -> input
        }
    }
}

private val isoMillis = DateTimeFormatterBuilder().appendInstant(3).toFormatter()
private fun iso(value: Instant = Instant.now()) = isoMillis.format(value)
private fun bounded(value: String, limit: Int): String {
    if (value.toByteArray(UTF_8).size <= limit) return value
    val marker = "[TRUNCATED]"
    var low = 0; var high = value.length
    while (low < high) { val middle = (low + high + 1) / 2
        if ((value.take(middle) + marker).toByteArray(UTF_8).size <= limit) low = middle else high = middle - 1 }
    return value.take(low) + marker
}

private fun JSONArray.objects() = (0 until length()).mapTo(mutableListOf()) { getJSONObject(it) }
internal fun JSONObject.copyPublic() = JSONObject(toString()).apply { remove("_held"); remove("_kind") }
private fun JSONObject.increment(key: String) = put(key, optLong(key) + 1)
