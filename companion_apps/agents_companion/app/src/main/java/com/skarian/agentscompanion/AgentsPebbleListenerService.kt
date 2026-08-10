package com.skarian.agentscompanion

import com.skarian.pebble.appmessage.AppMessageSession
import io.rebble.pebblekit2.client.BasePebbleListenerService
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import java.security.MessageDigest
import java.util.UUID

class AgentsPebbleListenerService : BasePebbleListenerService() {
    override val coroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onAppOpened(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != WATCHAPP_UUID) return
        val session = PebbleSession(watchappUUID, watch.value)
        val state = CompanionState(this)
        val messages = AgentsAppMessage(this)
        state.savePebbleSession(session)
        messages.open(session)
        coroutineScope.launch {
            val ready = messages.announceReady(session)
            if (!ready.delivered) state.saveBridgeError("Could not announce phone readiness (${ready.failure}).")
            state.loadAgents().takeIf { it.isNotEmpty() }?.let { agents ->
                val cached = messages.sendAgents(session, agents, cached = true)
                if (!cached.delivered) state.saveBridgeError("Could not send cached agents (${cached.failure}).")
            }
        }
    }

    override fun onAppClosed(watchappUUID: UUID, watch: WatchIdentifier) {
        if (watchappUUID != WATCHAPP_UUID) return
        val session = PebbleSession(watchappUUID, watch.value)
        AgentsAppMessage(this).close(session)
        CompanionState(this).clearPebbleSession(session)
    }

    override suspend fun onMessageReceived(
        watchappUUID: UUID,
        data: Map<UInt, PebbleDictionaryItem>,
        watch: WatchIdentifier,
    ): ReceiveResult {
        if (watchappUUID != WATCHAPP_UUID) return ReceiveResult.Nack
        val state = CompanionState(this)
        val session = PebbleSession(watchappUUID, watch.value)
        val messages = AgentsAppMessage(this)
        state.savePebbleSession(session)
        return try {
            val request = PebbleProtocol.parseWatchRequest(data)
            val requestId = request.requestId ?: "refresh"
            messages.messageReceived(session, request.command.name.lowercase(), requestId)
            when (request.command) {
                WatchCommand.REFRESH_AGENTS -> startAgentRefresh(session, requestId, state, messages)
                WatchCommand.RECONCILE -> coroutineScope.launch {
                    replayTurn(session, requireNotNull(request.requestId), state, rebind = true)
                }
                WatchCommand.HISTORY -> startHistoryReplay(session, request, state)
                WatchCommand.SEND -> handleSend(session, request, state)
            }
            ReceiveResult.Ack
        } catch (error: Exception) {
            messages.record("request", "invalid", "domain_failure", "invalid_request", session)
            state.saveBridgeError(error.message ?: "Watch request failed.")
            ReceiveResult.Nack
        }
    }

    private fun startAgentRefresh(
        session: PebbleSession,
        requestId: String,
        state: CompanionState,
        messages: AgentsAppMessage,
    ) {
        val admission = messages.beginRead(session, AGENT_REFRESH_OPERATION, requestId)
        when (admission.status) {
            AppMessageSession.ReadStatus.STARTED -> if (
                runCatching {
                    TermuxCommandRunner(this).refreshAgents(requestId, session.watchId)
                }.isFailure
            ) {
                state.saveBridgeError("Could not start the agent refresh.")
                coroutineScope.launch {
                    val reply = AgentRefreshReply(null, "refresh_failed")
                    val target = messages.completeRead(session, AGENT_REFRESH_OPERATION, requestId) {
                        finishAgentRefresh(this@AgentsPebbleListenerService, state, it, requestId, reply)
                    }
                    finishAgentRefresh(this@AgentsPebbleListenerService, state, target, requestId, reply)
                }
            }
            AppMessageSession.ReadStatus.REPLAYED -> coroutineScope.launch { admission.replay() }
            AppMessageSession.ReadStatus.BUSY,
            AppMessageSession.ReadStatus.CONFLICT -> coroutineScope.launch {
                finishAgentRefresh(
                    this@AgentsPebbleListenerService,
                    state,
                    session,
                    requestId,
                    AgentRefreshReply(null, if (admission.status == AppMessageSession.ReadStatus.BUSY) "refresh_busy" else "request_identity"),
                )
            }
            AppMessageSession.ReadStatus.COALESCED -> Unit
        }
    }

    private fun startHistoryReplay(
        session: PebbleSession,
        request: WatchRequest,
        state: CompanionState,
    ) {
        val requestId = requireNotNull(request.requestId)
        val agentId = requireNotNull(request.agentId)
        val messages = AgentsAppMessage(this)
        val admission = messages.beginRead(session, AGENT_HISTORY_OPERATION, requestId, agentId)
        when (admission.status) {
            AppMessageSession.ReadStatus.REPLAYED -> coroutineScope.launch { admission.replay() }
            AppMessageSession.ReadStatus.COALESCED -> Unit
            AppMessageSession.ReadStatus.BUSY,
            AppMessageSession.ReadStatus.CONFLICT -> coroutineScope.launch {
                messages.sendTextEvent(
                    session,
                    PhoneEvent.FAILED,
                    requestId,
                    "Could not load message history.",
                    if (admission.status == AppMessageSession.ReadStatus.BUSY) "busy" else "request_identity",
                    1,
                )
            }
            AppMessageSession.ReadStatus.STARTED -> coroutineScope.launch {
                val history = state.loadHistory(agentId)
                val outcome = messages.sendHistory(session, requestId, history)
                if (outcome.delivered) {
                    messages.completeRead(session, AGENT_HISTORY_OPERATION, requestId) { target ->
                        messages.sendHistory(target, requestId, history)
                    }
                } else {
                    messages.abandonRead(session, AGENT_HISTORY_OPERATION, requestId)
                    state.saveBridgeError("Could not send message history (${outcome.failure}).")
                }
            }
        }
    }

    private fun handleSend(
        session: PebbleSession,
        request: WatchRequest,
        state: CompanionState,
    ) {
        val agentId = requireNotNull(request.agentId)
        val requestId = requireNotNull(request.requestId)
        val text = requireNotNull(request.text)
        if (state.loadAgents().none { it.id == agentId }) {
            coroutineScope.launch {
                AgentsAppMessage(this@AgentsPebbleListenerService).sendTextEvent(
                    session,
                    PhoneEvent.FAILED,
                    requestId,
                    "That saved agent is no longer available.",
                    "agent_unavailable",
                    1,
                )
            }
            return
        }
        val turn = StoredTurn(requestId, agentId, sha256(text), TurnState.QUEUED, session)
        when (state.claimTurn(turn)) {
            TurnClaim.DUPLICATE -> coroutineScope.launch {
                replayTurn(session, requestId, state, rebind = true)
            }
            TurnClaim.CONFLICT -> {
                AgentsAppMessage(this).record(
                    "send", requestId, "domain_failure", "request_identity_mismatch",
                )
                throw IllegalArgumentException("Request identity conflict.")
            }
            TurnClaim.BUSY -> coroutineScope.launch {
                AgentsAppMessage(this@AgentsPebbleListenerService).sendTextEvent(
                    session,
                    PhoneEvent.FAILED,
                    requestId,
                    "Another agent turn is already running.",
                    "busy",
                    1,
                )
            }
            TurnClaim.CLAIMED -> runCatching {
                state.appendHistory(CachedMessage("$requestId/user", agentId, requestId, 0, true, text))
                RouterRunService.start(this, agentId, text, requestId)
            }.onFailure { error ->
                val failed = state.updateTurn(requestId) {
                    it.copy(
                        state = TurnState.TERMINAL,
                        eventType = "failed",
                        text = "Could not start the agent turn.",
                        code = "bridge_start_failed",
                        sequence = 1,
                    )
                }
                failed?.let {
                    state.appendHistory(CachedMessage(
                        "${it.requestId}/terminal", it.agentId, it.requestId,
                        it.sequence, false, it.text,
                    ))
                }
                failed?.let {
                    coroutineScope.launch { replayTurn(session, requestId, state) }
                }
                throw error
            }
        }
    }

    override fun onDestroy() {
        coroutineScope.cancel()
        super.onDestroy()
    }

    private suspend fun replayTurn(
        session: PebbleSession,
        requestId: String,
        state: CompanionState,
        rebind: Boolean = false,
    ) {
        var turn = state.loadTurn()?.takeIf { it.requestId == requestId }
        if (turn == null) {
            AgentsAppMessage(this).sendTextEvent(
                session,
                PhoneEvent.STATUS_UNKNOWN,
                requestId,
                "The agent may have received your message.",
                "status_unknown",
                1,
                true,
            )
            return
        }
        if (rebind && turn.session != session) {
            turn = state.updateTurn(requestId, touch = false) { it.copy(session = session) } ?: turn
        }
        if (turn.state == TurnState.QUEUED) {
            turn = if (System.currentTimeMillis() - turn.updatedAt > QUEUE_LEASE_TIMEOUT_MS) {
                val now = System.currentTimeMillis()
                state.updateTurn(requestId) {
                    if (it.state == TurnState.QUEUED && now - it.updatedAt > QUEUE_LEASE_TIMEOUT_MS) {
                        it.copy(
                            state = TurnState.TERMINAL,
                            eventType = "failed",
                            text = "The agent may have received your message.",
                            code = "status_unknown",
                            ambiguous = true,
                            sequence = maxOf(2, it.sequence + 1),
                        )
                    } else it
                } ?: turn
            } else turn.copy(
                eventType = "accepted",
                text = "",
                code = "",
                ambiguous = false,
                sequence = maxOf(1, turn.sequence),
            )
        } else if (turn.state == TurnState.RUNNING &&
            System.currentTimeMillis() - turn.updatedAt > LEASE_TIMEOUT_MS
        ) {
            val now = System.currentTimeMillis()
            turn = state.updateTurn(requestId) {
                if (it.state == TurnState.RUNNING && now - it.updatedAt > LEASE_TIMEOUT_MS) {
                    it.copy(
                        state = TurnState.TERMINAL,
                        eventType = "failed",
                        text = "The agent may have received your message.",
                        code = "status_unknown",
                        ambiguous = true,
                        sequence = (it.sequence + 1).coerceAtMost(65535),
                    )
                } else it
            } ?: turn
        }
        val kind = when {
            turn.ambiguous -> PhoneEvent.STATUS_UNKNOWN
            turn.eventType == "completed" -> PhoneEvent.COMPLETED
            turn.eventType == "failed" -> PhoneEvent.FAILED
            turn.eventType == "accepted" -> PhoneEvent.ACCEPTED
            else -> PhoneEvent.COMMENTARY
        }
        val outcome = AgentsAppMessage(this).sendTextEvent(
            session,
            kind,
            requestId,
            turn.text,
            turn.code,
            turn.sequence,
            turn.ambiguous,
        )
        if (!outcome.delivered) {
            state.saveBridgeError("Could not replay the agent turn (${outcome.failure}).")
        }
    }

    private fun sha256(text: String) = MessageDigest.getInstance("SHA-256")
        .digest(text.toByteArray())
        .joinToString("") { "%02x".format(it) }

    companion object {
        val WATCHAPP_UUID: UUID = UUID.fromString("bba3f38f-53e5-458b-9d5f-0bcdb68ffd47")
        private const val QUEUE_LEASE_TIMEOUT_MS = 15_000L
        private const val LEASE_TIMEOUT_MS = 45_000L
    }
}
