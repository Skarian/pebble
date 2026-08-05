package com.skarian.agentscompanion

import android.content.Context
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.TransmissionResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
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

    suspend fun sendAgents(session: PebbleSession, agents: List<AgentSummary>) =
        send(session, PebbleProtocol.agents(agents))

    suspend fun sendTextEvent(
        session: PebbleSession,
        kind: PhoneEvent,
        requestId: String,
        text: String,
        code: String? = null,
    ): List<TransmissionResult> {
        val chunks = PebbleProtocol.chunkText(text)
        return chunks.mapIndexed { index, chunk ->
            send(
                session,
                PebbleProtocol.event(kind, requestId, chunk, code, index, chunks.size),
            )
        }
    }
}
