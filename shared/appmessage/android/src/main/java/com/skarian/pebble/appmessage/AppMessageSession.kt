package com.skarian.pebble.appmessage

import android.content.Context
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.TransmissionResult
import io.rebble.pebblekit2.common.model.WatchIdentifier
import java.util.UUID
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

internal fun interface AppMessageTransport {
    suspend fun send(appUuid: UUID, watchId: String, dictionary: PebbleDictionary): TransmissionResult
}

/**
 * One phone-side AppMessage session: lifecycle, READY, serialized delivery, retry,
 * diagnostics, and exact-ID admission for repeatable reads.
 */
class AppMessageSession internal constructor(
    private val appUuid: UUID,
    private val transport: AppMessageTransport,
    private val log: AppMessageLog,
    private val state: SessionState,
    private val maxAttempts: Int,
    private val retryDelaysMillis: List<Long>,
    private val transportTimeoutMillis: Long,
    private val runTransportAttempt: suspend (
        timeoutMillis: Long,
        send: suspend () -> TransmissionResult,
    ) -> TransmissionResult?,
    private val wait: suspend (Long) -> Unit,
    private val now: () -> Long,
    private val readLeaseMillis: Long,
    private val readyRepeatDelayMillis: Long,
) {
    enum class Failure(val diagnosticCode: String) {
        SESSION_INACTIVE("session_inactive"),
        TIMEOUT("timeout"),
        WATCH_NOT_CONNECTED("watch_not_connected"),
        WATCH_NACKED("watch_nacked"),
        DIFFERENT_APP_OPEN("different_app_open"),
        NO_PERMISSIONS("no_permissions"),
        UNKNOWN("unknown"),
        EXCEPTION("exception"),
        RETRY_EXHAUSTED("retry_exhausted");

        override fun toString() = diagnosticCode
    }

    @ConsistentCopyVisibility
    data class Delivery internal constructor(
        val delivered: Boolean,
        val attempts: Int,
        val failure: Failure? = null,
        val failedPart: Int? = null,
    )

    enum class ReadStatus { STARTED, COALESCED, REPLAYED, CONFLICT, BUSY }

    class ReadAdmission internal constructor(
        val status: ReadStatus,
        private val replay: (suspend () -> Unit)? = null,
        private val attach: ((Job) -> Unit)? = null,
    ) {
        suspend fun replay(): Boolean {
            val action = replay ?: return false
            action()
            return true
        }

        /** Launches a new read or a stored replay; coalesced and rejected reads do nothing. */
        fun launch(scope: CoroutineScope, read: suspend () -> Unit): Job? {
            val work = when (status) {
                ReadStatus.STARTED -> read
                ReadStatus.REPLAYED -> replay ?: return null
                else -> return null
            }
            val job = scope.launch(start = CoroutineStart.LAZY) { work() }
            if (status == ReadStatus.STARTED) attach?.invoke(job)
            job.start()
            return job
        }
    }

    constructor(context: Context, appUuid: UUID, appName: String) : this(
        appUuid = appUuid,
        transport = DefaultAppMessageTransport(context.applicationContext),
        log = AppMessageLog(context.applicationContext, appName),
        state = sharedState(appUuid),
        maxAttempts = 3,
        retryDelaysMillis = listOf(250L, 1_000L),
        transportTimeoutMillis = 8_000L,
        runTransportAttempt = { timeoutMillis, send ->
            // PebbleKit's AIDL request suspension is not cancellation-aware. Race it in
            // a detached child so a lost callback cannot retain the serialized outbox.
            val attempt = CoroutineScope(currentCoroutineContext() + SupervisorJob())
                .async(start = CoroutineStart.UNDISPATCHED) { send() }
            try {
                withTimeoutOrNull(timeoutMillis) { attempt.await() }
            } finally {
                attempt.cancel()
            }
        },
        wait = { delay(it) },
        now = System::currentTimeMillis,
        readLeaseMillis = 90_000L,
        readyRepeatDelayMillis = 500L,
    )

    init {
        require(maxAttempts >= 1)
        require(transportTimeoutMillis > 0)
        require(readLeaseMillis > 0)
        require(readyRepeatDelayMillis >= 0)
    }

    /** Opens lifecycle state synchronously so a later close cannot be undone by queued READY work. */
    fun open(watchId: String) {
        state.open(watchId)
        emit("lifecycle", "", "session_open", lifecycle = "open", watchId = watchId)
    }

    suspend fun announceReady(watchId: String, readyMessage: PebbleDictionary): Delivery {
        val first = send(watchId, "ready", "session", readyMessage)
        if (first.failure == Failure.SESSION_INACTIVE) return first
        if (readyRepeatDelayMillis > 0) wait(readyRepeatDelayMillis)
        emit("ready", "session", "ready_repeat", watchId = watchId)
        val repeated = send(watchId, "ready", "session", readyMessage)
        val attempts = first.attempts + repeated.attempts
        return if (first.delivered || repeated.delivered) {
            Delivery(true, attempts)
        } else {
            repeated.copy(attempts = attempts)
        }
    }

    fun messageReceived(watchId: String, operation: String, requestId: String) {
        if (state.open(watchId)) {
            emit("lifecycle", "", "session_observed", lifecycle = "open", watchId = watchId)
        }
        emit(operation, requestId, "request", watchId = watchId)
    }

    fun close(watchId: String) {
        state.close(watchId)
        emit("lifecycle", "", "session_closed", lifecycle = "closed", watchId = watchId)
    }

    suspend fun send(
        watchId: String,
        operation: String,
        requestId: String,
        dictionary: PebbleDictionary,
    ): Delivery = sendBatch(watchId, operation, requestId, listOf(dictionary))

    suspend fun sendBatch(
        watchId: String,
        operation: String,
        requestId: String,
        dictionaries: List<PebbleDictionary>,
    ): Delivery = state.outbox.withLock {
        val messages = dictionaries.map { it.toMap() }
        if (messages.isEmpty()) return@withLock Delivery(true, 0)
        var totalAttempts = 0
        for ((part, message) in messages.withIndex()) {
            val delivery = sendPart(watchId, operation, requestId, message, part)
            totalAttempts += delivery.attempts
            if (!delivery.delivered) {
                return@withLock delivery.copy(attempts = totalAttempts, failedPart = part)
            }
        }
        emit(operation, requestId, "delivery_success", totalAttempts, messages.lastIndex, "success", watchId = watchId, category = "ok")
        Delivery(true, totalAttempts)
    }

    /** Admit a repeatable read. Completed duplicates carry the original replay action. */
    fun beginRead(
        watchId: String,
        operation: String,
        requestId: String,
        identity: String = "",
    ): ReadAdmission {
        val admission = state.beginRead(
            ReadKey(watchId, operation), requestId, identity, now(), readLeaseMillis,
        )
        emit(
            operation, requestId,
            when (admission.status) {
                ReadStatus.STARTED -> "request_started"
                ReadStatus.COALESCED -> "request_coalesced"
                ReadStatus.REPLAYED -> "request_replayed"
                ReadStatus.CONFLICT -> "request_conflict"
                ReadStatus.BUSY -> "request_busy"
            },
            watchId = watchId,
            category = when (admission.status) {
                ReadStatus.CONFLICT -> "request_identity"
                ReadStatus.BUSY -> "busy"
                else -> ""
            },
        )
        return admission
    }

    /** Completes the matching active read and retains only its bounded in-memory replay. */
    fun completeRead(
        watchId: String,
        operation: String,
        requestId: String,
        replay: suspend () -> Unit,
    ): Boolean = state.completeRead(
        ReadKey(watchId, operation), requestId, now(), readLeaseMillis, replay,
    )

    fun abandonRead(watchId: String, operation: String, requestId: String) {
        state.abandonRead(ReadKey(watchId, operation), requestId)
    }

    fun record(
        operation: String,
        requestId: String,
        event: String,
        category: String = "",
        watchId: String? = null,
    ) = emit(operation, requestId, event, watchId = watchId, category = category)

    fun exportLog(): String = log.export()
    fun replayLogcat() = log.replay()

    private suspend fun sendPart(
        watchId: String,
        operation: String,
        requestId: String,
        message: PebbleDictionary,
        part: Int,
    ): Delivery {
        var attempt = 0
        while (attempt < maxAttempts) {
            if (!state.isOpen(watchId)) {
                emit(operation, requestId, "delivery_failure", attempt, part, "session_inactive", watchId = watchId, category = "delivery")
                return Delivery(false, attempt, Failure.SESSION_INACTIVE)
            }
            attempt += 1
            val result = try {
                runTransportAttempt(transportTimeoutMillis) {
                    transport.send(appUuid, watchId, message)
                }?.let(::classify)
                    ?: Attempt.Failed(
                        Failure.TIMEOUT,
                        detail = "transport_timeout",
                        retryable = true,
                    )
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: Throwable) {
                Attempt.Failed(Failure.EXCEPTION, error.javaClass.simpleName, retryable = true)
            }
            if (result === Attempt.Delivered) return Delivery(true, attempt)
            result as Attempt.Failed
            val retry = result.retryable && attempt < maxAttempts && state.isOpen(watchId)
            emit(
                operation, requestId,
                if (retry) "delivery_retry" else "delivery_failure",
                attempt, part, result.failure.diagnosticCode, result.detail,
                watchId = watchId,
                category = if (retry) "pending" else "delivery",
            )
            if (!retry) return Delivery(false, attempt, result.failure)
            val pause = retryDelaysMillis.getOrElse(attempt - 1) { retryDelaysMillis.lastOrNull() ?: 0L }
            if (pause > 0) wait(pause)
        }
        return Delivery(false, attempt, Failure.RETRY_EXHAUSTED)
    }

    private fun emit(
        operation: String,
        requestId: String,
        event: String,
        attempt: Int = 0,
        part: Int = 0,
        result: String = "",
        detail: String = "",
        lifecycle: String = "active",
        watchId: String? = null,
        category: String = "",
    ) = log.record(LogEntry(
        operation = operation, requestId = requestId, event = event,
        lifecycle = lifecycle, ready = watchId?.let(state::isOpen) == true,
        attempt = attempt, part = part, result = result, detail = detail, category = category,
    ))

    private fun classify(result: TransmissionResult): Attempt = when (result) {
        TransmissionResult.Success -> Attempt.Delivered
        TransmissionResult.FailedTimeout -> Attempt.Failed(Failure.TIMEOUT, retryable = true)
        TransmissionResult.FailedWatchNotConnected -> Attempt.Failed(Failure.WATCH_NOT_CONNECTED, retryable = true)
        TransmissionResult.FailedWatchNacked -> Attempt.Failed(Failure.WATCH_NACKED, retryable = true)
        TransmissionResult.FailedDifferentAppOpen -> Attempt.Failed(Failure.DIFFERENT_APP_OPEN)
        TransmissionResult.FailedNoPermissions -> Attempt.Failed(Failure.NO_PERMISSIONS)
        is TransmissionResult.Unknown -> Attempt.Failed(Failure.UNKNOWN)
    }

    private sealed interface Attempt {
        data object Delivered : Attempt
        data class Failed(
            val failure: Failure,
            val detail: String = "",
            val retryable: Boolean = false,
        ) : Attempt
    }

    internal data class ReadKey(val watchId: String, val operation: String)

    internal class SessionState {
        val outbox = Mutex()
        private val lock = Any()
        private val openWatches = mutableSetOf<String>()
        private val reads = mutableMapOf<ReadKey, ReadEntry>()

        fun open(watchId: String): Boolean = synchronized(lock) { openWatches.add(watchId) }

        fun close(watchId: String) {
            val jobs = synchronized(lock) {
                openWatches.remove(watchId)
                val matching = reads.filterKeys { it.watchId == watchId }
                reads.keys.removeAll { it.watchId == watchId }
                matching.values.mapNotNull { it.job }
            }
            jobs.forEach(Job::cancel)
        }

        fun isOpen(watchId: String) = synchronized(lock) { watchId in openWatches }

        fun beginRead(
            key: ReadKey,
            requestId: String,
            identity: String,
            at: Long,
            leaseMillis: Long,
        ): ReadAdmission = synchronized(lock) {
            val stored = reads[key]
            val current = stored?.takeUnless { at - it.at >= leaseMillis }
            if (current == null) {
                stored?.job?.cancel()
                reads[key] = ReadEntry(requestId, identity, at)
                return@synchronized startedAdmission(key, requestId)
            }
            if (current.requestId != requestId) {
                if (current.replay == null) return@synchronized ReadAdmission(ReadStatus.BUSY)
                reads[key] = ReadEntry(requestId, identity, at)
                return@synchronized startedAdmission(key, requestId)
            }
            if (current.identity != identity) return@synchronized ReadAdmission(ReadStatus.CONFLICT)
            current.replay?.let { ReadAdmission(ReadStatus.REPLAYED, it) }
                ?: ReadAdmission(ReadStatus.COALESCED)
        }

        private fun startedAdmission(key: ReadKey, requestId: String) = ReadAdmission(
            ReadStatus.STARTED,
            attach = { job ->
                synchronized(lock) {
                    val current = reads[key]
                    if (current?.requestId == requestId && current.replay == null) {
                        reads[key] = current.copy(job = job)
                    } else {
                        job.cancel()
                    }
                }
            },
        )

        fun completeRead(
            key: ReadKey,
            requestId: String,
            at: Long,
            leaseMillis: Long,
            replay: suspend () -> Unit,
        ): Boolean = synchronized(lock) {
            reads.entries.removeAll { (_, entry) ->
                val expired = at - entry.at >= leaseMillis
                if (expired) entry.job?.cancel()
                expired
            }
            val entry = reads[key]
            if (entry?.requestId != requestId || entry.replay != null) return@synchronized false
            reads[key] = entry.copy(at = at, replay = replay, job = null)
            true
        }

        fun abandonRead(key: ReadKey, requestId: String) = synchronized(lock) {
            val entry = reads[key]
            if (entry?.requestId == requestId && entry.replay == null) reads.remove(key)
        }

        private data class ReadEntry(
            val requestId: String,
            val identity: String,
            val at: Long,
            val replay: (suspend () -> Unit)? = null,
            val job: Job? = null,
        )
    }

    private companion object {
        val STATES = mutableMapOf<UUID, SessionState>()
        fun sharedState(appUuid: UUID) = synchronized(STATES) { STATES.getOrPut(appUuid, ::SessionState) }
    }
}

private class DefaultAppMessageTransport(context: Context) : AppMessageTransport {
    private val applicationContext = context.applicationContext

    override suspend fun send(
        appUuid: UUID,
        watchId: String,
        dictionary: PebbleDictionary,
    ): TransmissionResult {
        val sender = DefaultPebbleSender(applicationContext)
        return try {
            sender.sendDataToPebble(appUuid, dictionary, listOf(WatchIdentifier(watchId)))
                .orEmpty().values.singleOrNull() ?: TransmissionResult.FailedWatchNotConnected
        } finally {
            sender.close()
        }
    }
}
