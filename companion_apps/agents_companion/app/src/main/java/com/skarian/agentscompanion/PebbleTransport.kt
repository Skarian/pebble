package com.skarian.agentscompanion

import android.content.Context
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.TransmissionResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.UUID

data class PebbleSession(val appUuid: UUID, val watchId: String)

class PebbleTransport(private val context: Context) {
    suspend fun send(
        session: PebbleSession,
        data: Map<UInt, PebbleDictionaryItem>,
    ): TransmissionResult {
        val sender = DefaultPebbleSender(context.applicationContext)
        return try {
            sender.sendDataToPebble(
                session.appUuid,
                data,
                listOf(WatchIdentifier(session.watchId)),
            ).orEmpty().values.singleOrNull() ?: TransmissionResult.FailedWatchNotConnected
        } finally {
            sender.close()
        }
    }

    suspend fun sendAgents(session: PebbleSession, agents: List<AgentSummary>, requestId: String? = null, cached: Boolean = false) =
        send(session, PebbleProtocol.agents(agents, requestId, cached))

    suspend fun sendTextEvent(
        session: PebbleSession,
        kind: PhoneEvent,
        requestId: String,
        text: String,
        code: String? = null,
        sequence: Int = 0,
        ambiguous: Boolean = false,
    ): List<TransmissionResult> = BATCH_LOCK.withLock {
        val projected = PebbleProtocol.projectText(text)
        val chunks = PebbleProtocol.chunkText(projected.text)
        val flags = (if (projected.truncated) PebbleProtocol.FLAG_TRUNCATED else 0) or
            (if (ambiguous) PebbleProtocol.FLAG_AMBIGUOUS else 0)
        val results = mutableListOf<TransmissionResult>()
        for ((index, chunk) in chunks.withIndex()) {
            val result = send(
                session,
                PebbleProtocol.event(kind, requestId, chunk, code, index, chunks.size, sequence, flags),
            )
            results += result
            if (result != TransmissionResult.Success) break
        }
        results
    }

    suspend fun sendHistory(session: PebbleSession, requestId: String, messages: List<CachedMessage>): List<TransmissionResult> = BATCH_LOCK.withLock {
        val results = mutableListOf<TransmissionResult>()
        val projectedMessages = projectHistoryForWatch(messages)
        for ((messageIndex, message) in projectedMessages.withIndex()) {
            val projected = PebbleProtocol.projectText(message.text)
            val chunks = PebbleProtocol.chunkText(projected.text)
            val flags = (if (projected.truncated) PebbleProtocol.FLAG_TRUNCATED else 0) or
                (if (message.user) PebbleProtocol.FLAG_USER else 0)
            for ((chunkIndex, chunk) in chunks.withIndex()) {
                val result = send(session, PebbleProtocol.event(PhoneEvent.HISTORY_ITEM, requestId, chunk,
                    chunkIndex = chunkIndex, chunkCount = chunks.size, sequence = messageIndex + 1, flags = flags))
                results += result
                if (result != TransmissionResult.Success) return@withLock results
            }
        }
        results += send(session, PebbleProtocol.event(PhoneEvent.HISTORY_END, requestId, sequence = projectedMessages.size))
        results
    }

    private companion object { val BATCH_LOCK = Mutex() }
}
