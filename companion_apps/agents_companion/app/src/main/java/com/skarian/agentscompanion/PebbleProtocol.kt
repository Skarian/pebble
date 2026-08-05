package com.skarian.agentscompanion

import io.rebble.pebblekit2.common.model.PebbleDictionaryItem

enum class WatchCommand(val wireValue: UByte) {
    REFRESH_AGENTS(1u),
    SEND(2u),
}

enum class PhoneEvent(val wireValue: UByte) {
    AGENTS(10u),
    ACCEPTED(11u),
    COMMENTARY(12u),
    COMPLETED(13u),
    FAILED(14u),
}

data class WatchRequest(
    val command: WatchCommand,
    val agentId: String? = null,
    val text: String? = null,
    val requestId: String? = null,
    val mode: ExecutionMode = ExecutionMode.STREAM,
)

object PebbleProtocol {
    const val KEY_KIND = 0u
    const val KEY_REQUEST_ID = 1u
    const val KEY_AGENT_ID = 2u
    const val KEY_TEXT = 3u
    const val KEY_MODE = 4u
    const val KEY_AGENT_COUNT = 5u
    const val KEY_ERROR_CODE = 6u
    const val KEY_CHUNK_INDEX = 7u
    const val KEY_CHUNK_COUNT = 8u
    const val KEY_AGENT_BASE = 100u
    const val MAX_AGENTS = 16
    const val MAX_TEXT_CHARS = 4096

    fun parseWatchRequest(data: Map<UInt, PebbleDictionaryItem>): WatchRequest {
        val kind = number(data[KEY_KIND])
        val command = WatchCommand.entries.firstOrNull { it.wireValue.toLong() == kind }
            ?: throw IllegalArgumentException("Unknown watch command.")
        if (command == WatchCommand.REFRESH_AGENTS) return WatchRequest(command)

        val agentId = text(data[KEY_AGENT_ID])
        val transcript = text(data[KEY_TEXT])
        require(agentId.matches(Regex("[a-z][a-z0-9-]*"))) { "Invalid agent id." }
        require(transcript.isNotBlank()) { "Transcript is empty." }
        require(transcript.length <= MAX_TEXT_CHARS) { "Transcript is too long." }
        val requestId = text(data[KEY_REQUEST_ID])
        require(requestId.matches(Regex("[A-Za-z0-9._:-]{1,64}"))) { "Invalid request id." }
        val mode = when (data[KEY_MODE]?.let(::number)?.toInt()) {
            0 -> ExecutionMode.FINAL_JSON
            else -> ExecutionMode.STREAM
        }
        return WatchRequest(command, agentId, transcript, requestId, mode)
    }

    fun agents(agents: List<AgentSummary>): Map<UInt, PebbleDictionaryItem> = buildMap {
        val bounded = agents.take(MAX_AGENTS)
        put(KEY_KIND, PebbleDictionaryItem.UInt8(PhoneEvent.AGENTS.wireValue))
        put(KEY_AGENT_COUNT, PebbleDictionaryItem.UInt8(bounded.size.toUByte()))
        bounded.forEachIndexed { index, agent ->
            val base = KEY_AGENT_BASE + (index * 2).toUInt()
            put(base, PebbleDictionaryItem.Text(agent.id))
            put(base + 1u, PebbleDictionaryItem.Text(agent.label))
        }
    }

    fun event(
        kind: PhoneEvent,
        requestId: String,
        text: String = "",
        code: String? = null,
        chunkIndex: Int = 0,
        chunkCount: Int = 1,
    ): Map<UInt, PebbleDictionaryItem> = buildMap {
        put(KEY_KIND, PebbleDictionaryItem.UInt8(kind.wireValue))
        put(KEY_REQUEST_ID, PebbleDictionaryItem.Text(requestId))
        if (text.isNotBlank()) put(KEY_TEXT, PebbleDictionaryItem.Text(text))
        if (!code.isNullOrBlank()) put(KEY_ERROR_CODE, PebbleDictionaryItem.Text(code))
        put(KEY_CHUNK_INDEX, PebbleDictionaryItem.UInt16(chunkIndex.toUShort()))
        put(KEY_CHUNK_COUNT, PebbleDictionaryItem.UInt16(chunkCount.toUShort()))
    }

    fun chunkText(text: String, maxBytes: Int = 700): List<String> {
        require(maxBytes > 0)
        if (text.isEmpty()) return listOf("")
        val chunks = mutableListOf<String>()
        var start = 0
        var index = 0
        var bytes = 0
        while (index < text.length) {
            val codePoint = text.codePointAt(index)
            val chars = Character.charCount(codePoint)
            val encoded = String(Character.toChars(codePoint)).toByteArray(Charsets.UTF_8).size
            if (bytes > 0 && bytes + encoded > maxBytes) {
                chunks += text.substring(start, index)
                start = index
                bytes = 0
            }
            bytes += encoded
            index += chars
        }
        chunks += text.substring(start)
        return chunks
    }

    private fun text(item: PebbleDictionaryItem?): String =
        (item as? PebbleDictionaryItem.Text)?.value
            ?: throw IllegalArgumentException("Required text field is missing.")

    // PebbleKit2 normalizes all incoming watch integers to 32-bit values.
    private fun number(item: PebbleDictionaryItem?): Long = when (item) {
        is PebbleDictionaryItem.UInt32 -> item.value.toLong()
        is PebbleDictionaryItem.Int32 -> item.value.toLong()
        is PebbleDictionaryItem.UInt16 -> item.value.toLong()
        is PebbleDictionaryItem.Int16 -> item.value.toLong()
        is PebbleDictionaryItem.UInt8 -> item.value.toLong()
        is PebbleDictionaryItem.Int8 -> item.value.toLong()
        else -> throw IllegalArgumentException("Required integer field is missing.")
    }
}
