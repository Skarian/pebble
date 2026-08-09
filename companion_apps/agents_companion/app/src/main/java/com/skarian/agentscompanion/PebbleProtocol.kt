package com.skarian.agentscompanion

import io.rebble.pebblekit2.common.model.PebbleDictionaryItem

enum class WatchCommand(val wireValue: UByte) { REFRESH_AGENTS(1u), SEND(2u), RECONCILE(3u), HISTORY(4u) }
enum class PhoneEvent(val wireValue: UByte) {
    AGENTS(10u), ACCEPTED(11u), COMMENTARY(12u), COMPLETED(13u), FAILED(14u),
    STATUS_UNKNOWN(15u), AGENTS_FAILED(16u), HISTORY_ITEM(17u), HISTORY_END(18u),
}

data class WatchRequest(
    val command: WatchCommand, val agentId: String? = null, val text: String? = null,
    val requestId: String? = null, val mode: ExecutionMode = ExecutionMode.STREAM,
    val lastSequence: Int = 0,
)

data class ProjectedText(val text: String, val truncated: Boolean)

object PebbleProtocol {
    const val VERSION = 1
    const val KEY_KIND = 0u
    const val KEY_REQUEST_ID = 1u
    const val KEY_AGENT_ID = 2u
    const val KEY_TEXT = 3u
    const val KEY_MODE = 4u
    const val KEY_AGENT_COUNT = 5u
    const val KEY_ERROR_CODE = 6u
    const val KEY_CHUNK_INDEX = 7u
    const val KEY_CHUNK_COUNT = 8u
    const val KEY_PROTOCOL = 9u
    const val KEY_EVENT_SEQUENCE = 10u
    const val KEY_FLAGS = 11u
    const val KEY_AGENT_BASE = 100u
    const val FLAG_TRUNCATED = 0x01
    const val FLAG_AMBIGUOUS = 0x02
    const val FLAG_CACHED = 0x04
    const val FLAG_USER = 0x08
    const val MAX_AGENTS = 16
    const val MAX_AGENT_ID_BYTES = 32
    const val MAX_AGENT_LABEL_BYTES = 64
    const val MAX_TRANSCRIPT_BYTES = 767
    const val CHUNK_BYTES = 700
    const val MAX_CHUNKS = 8
    const val MAX_WATCH_TEXT_BYTES = CHUNK_BYTES * MAX_CHUNKS
    const val MAX_HISTORY_ITEMS = 16
    const val MAX_HISTORY_BYTES = 18000
    private const val TRUNCATION_SUFFIX = "\n\n[TRUNCATED ON WATCH]"

    fun parseWatchRequest(data: Map<UInt, PebbleDictionaryItem>): WatchRequest {
        require(number(data[KEY_PROTOCOL]) == VERSION.toLong()) { "Protocol update required." }
        val command = WatchCommand.entries.firstOrNull { it.wireValue.toLong() == number(data[KEY_KIND]) }
            ?: throw IllegalArgumentException("Unknown watch command.")
        if (command == WatchCommand.REFRESH_AGENTS) {
            return WatchRequest(command, requestId = optionalText(data[KEY_REQUEST_ID])?.also(::validateRequestId))
        }
        val requestId = text(data[KEY_REQUEST_ID]).also(::validateRequestId)
        if (command == WatchCommand.RECONCILE) {
            val sequence = data[KEY_EVENT_SEQUENCE]?.let(::number)?.toInt() ?: 0
            require(sequence in 0..65535) { "Invalid event sequence." }
            return WatchRequest(command, requestId = requestId, lastSequence = sequence)
        }
        val agentId = text(data[KEY_AGENT_ID])
        require(agentId.matches(Regex("[a-z][a-z0-9-]*")) && utf8(agentId) <= MAX_AGENT_ID_BYTES) { "Invalid agent id." }
        if (command == WatchCommand.HISTORY) {
            return WatchRequest(command, agentId = agentId, requestId = requestId)
        }
        val transcript = text(data[KEY_TEXT])
        require(transcript.isNotBlank() && utf8(transcript) <= MAX_TRANSCRIPT_BYTES) { "Invalid transcript." }
        val mode = if (data[KEY_MODE]?.let(::number)?.toInt() == 0) ExecutionMode.FINAL_JSON else ExecutionMode.STREAM
        return WatchRequest(command, agentId, transcript, requestId, mode)
    }

    fun agents(agents: List<AgentSummary>, requestId: String? = null, cached: Boolean = false): Map<UInt, PebbleDictionaryItem> {
        require(agents.size <= MAX_AGENTS) { "At most $MAX_AGENTS agents can be shown on the watch." }
        require(agents.map { it.id }.distinct().size == agents.size) { "Agent ids must be unique." }
        agents.forEach {
            require(it.id.matches(Regex("[a-z][a-z0-9-]*")) && utf8(it.id) <= MAX_AGENT_ID_BYTES) { "Agent id is not watch-compatible: ${it.id}" }
            require(it.label.isNotBlank() && utf8(it.label) <= MAX_AGENT_LABEL_BYTES) { "Agent label is not watch-compatible: ${it.id}" }
        }
        return buildMap {
            put(KEY_PROTOCOL, PebbleDictionaryItem.UInt8(VERSION.toUByte()))
            put(KEY_KIND, PebbleDictionaryItem.UInt8(PhoneEvent.AGENTS.wireValue))
            put(KEY_AGENT_COUNT, PebbleDictionaryItem.UInt8(agents.size.toUByte()))
            requestId?.let { put(KEY_REQUEST_ID, PebbleDictionaryItem.Text(it)) }
            put(KEY_FLAGS, PebbleDictionaryItem.UInt8((if (cached) FLAG_CACHED else 0).toUByte()))
            agents.forEachIndexed { index, agent ->
                val base = KEY_AGENT_BASE + (index * 2).toUInt()
                put(base, PebbleDictionaryItem.Text(agent.id)); put(base + 1u, PebbleDictionaryItem.Text(agent.label))
            }
        }
    }

    fun event(kind: PhoneEvent, requestId: String, text: String = "", code: String? = null,
              chunkIndex: Int = 0, chunkCount: Int = 1, sequence: Int = 0, flags: Int = 0) = buildMap<UInt, PebbleDictionaryItem> {
        put(KEY_PROTOCOL, PebbleDictionaryItem.UInt8(VERSION.toUByte()))
        put(KEY_KIND, PebbleDictionaryItem.UInt8(kind.wireValue)); put(KEY_REQUEST_ID, PebbleDictionaryItem.Text(requestId))
        if (text.isNotBlank()) put(KEY_TEXT, PebbleDictionaryItem.Text(text))
        if (!code.isNullOrBlank()) put(KEY_ERROR_CODE, PebbleDictionaryItem.Text(code))
        put(KEY_CHUNK_INDEX, PebbleDictionaryItem.UInt16(chunkIndex.toUShort()))
        put(KEY_CHUNK_COUNT, PebbleDictionaryItem.UInt16(chunkCount.toUShort()))
        put(KEY_EVENT_SEQUENCE, PebbleDictionaryItem.UInt16(sequence.toUShort()))
        put(KEY_FLAGS, PebbleDictionaryItem.UInt8(flags.toUByte()))
    }

    fun projectText(text: String): ProjectedText {
        if (utf8(text) <= MAX_WATCH_TEXT_BYTES) return ProjectedText(text, false)
        val suffixBytes = utf8(TRUNCATION_SUFFIX)
        return ProjectedText(takeUtf8(text, MAX_WATCH_TEXT_BYTES - suffixBytes) + TRUNCATION_SUFFIX, true)
    }

    fun chunkText(text: String, maxBytes: Int = CHUNK_BYTES): List<String> {
        require(maxBytes > 0); if (text.isEmpty()) return listOf("")
        val chunks = mutableListOf<String>(); var remaining = text
        while (remaining.isNotEmpty()) { val part = takeUtf8(remaining, maxBytes); require(part.isNotEmpty()); chunks += part; remaining = remaining.substring(part.length) }
        return chunks
    }

    private fun takeUtf8(value: String, limit: Int): String { var i = 0; var bytes = 0; while (i < value.length) { val cp = value.codePointAt(i); val chars = Character.charCount(cp); val n = String(Character.toChars(cp)).toByteArray().size; if (bytes + n > limit) break; bytes += n; i += chars }; return value.substring(0, i) }
    private fun utf8(value: String) = value.toByteArray(Charsets.UTF_8).size
    private fun validateRequestId(value: String) { require(value.matches(Regex("[A-Za-z0-9._:-]{1,64}"))) { "Invalid request id." } }
    private fun optionalText(item: PebbleDictionaryItem?) = (item as? PebbleDictionaryItem.Text)?.value
    private fun text(item: PebbleDictionaryItem?) = optionalText(item) ?: throw IllegalArgumentException("Required text field is missing.")
    private fun number(item: PebbleDictionaryItem?): Long = when (item) {
        is PebbleDictionaryItem.UInt32 -> item.value.toLong(); is PebbleDictionaryItem.Int32 -> item.value.toLong()
        is PebbleDictionaryItem.UInt16 -> item.value.toLong(); is PebbleDictionaryItem.Int16 -> item.value.toLong()
        is PebbleDictionaryItem.UInt8 -> item.value.toLong(); is PebbleDictionaryItem.Int8 -> item.value.toLong()
        else -> throw IllegalArgumentException("Required integer field is missing.")
    }
}

internal fun projectHistoryForWatch(messages: List<CachedMessage>): List<CachedMessage> {
    var bytes = 0
    val newestFirst = mutableListOf<CachedMessage>()
    for (message in messages.asReversed()) {
        if (newestFirst.size >= PebbleProtocol.MAX_HISTORY_ITEMS) break
        val projected = PebbleProtocol.projectText(message.text).text
        val messageBytes = projected.toByteArray(Charsets.UTF_8).size + 1
        if (bytes + messageBytes > PebbleProtocol.MAX_HISTORY_BYTES) break
        newestFirst += message.copy(text = projected)
        bytes += messageBytes
    }
    return newestFirst.asReversed()
}
