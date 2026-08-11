package com.skarian.pebble.appmessage

import android.content.Context
import com.skarian.pebble.errors.ErrorReporter
import io.rebble.pebblekit2.client.DefaultPebbleSender
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
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
 * watch-error import, and exact-ID admission for repeatable reads.
 */
class AppMessageSession internal constructor(
    private val appUuid: UUID,
    private val transport: AppMessageTransport,
    private val errorReporter: ErrorReporter,
    private val watchErrorSource: String,
    private val state: SessionState,
    private val maxAttempts: Int,
    private val retryDelaysMillis: List<Long>,
    private val transportTimeoutMillis: Long,
    private val diagnosticAckTimeoutMillis: Long,
    private val runTransportAttempt: suspend (
        timeoutMillis: Long,
        send: suspend () -> TransmissionResult,
    ) -> TransmissionResult?,
    private val wait: suspend (Long) -> Unit,
    private val now: () -> Long,
    private val readLeaseMillis: Long,
    private val readyRepeatDelayMillis: Long,
) {
    enum class Failure(val code: String) {
        SESSION_INACTIVE("session_inactive"),
        TIMEOUT("timeout"),
        WATCH_NOT_CONNECTED("watch_not_connected"),
        WATCH_NACKED("watch_nacked"),
        DIFFERENT_APP_OPEN("different_app_open"),
        NO_PERMISSIONS("no_permissions"),
        UNKNOWN("unknown"),
        EXCEPTION("exception"),
        RETRY_EXHAUSTED("retry_exhausted");

        override fun toString() = code
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

    constructor(
        context: Context,
        appUuid: UUID,
        errorReporter: ErrorReporter = ErrorReporter.Disabled,
        watchErrorSource: String = "watch",
    ) : this(
        appUuid = appUuid,
        transport = DefaultAppMessageTransport(context.applicationContext),
        errorReporter = errorReporter,
        watchErrorSource = watchErrorSource,
        state = sharedState(appUuid),
        maxAttempts = 3,
        retryDelaysMillis = listOf(250L, 1_000L),
        transportTimeoutMillis = 8_000L,
        diagnosticAckTimeoutMillis = 500L,
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
        require(diagnosticAckTimeoutMillis > 0)
        require(readLeaseMillis > 0)
        require(readyRepeatDelayMillis >= 0)
    }

    /** Opens lifecycle state synchronously so a later close cannot be undone by queued READY work. */
    fun open(watchId: String) {
        state.open(watchId)
    }

    suspend fun announceReady(watchId: String, readyMessage: PebbleDictionary): Delivery {
        val message = readyMessage + mapOf(
            AppMessageErrorKeys.ERROR_ENABLED to
                PebbleDictionaryItem.UInt8(if (errorReporter.enabled) 1u else 0u),
        )
        val first = send(watchId, "ready", "session", message)
        if (first.failure == Failure.SESSION_INACTIVE) return first
        if (readyRepeatDelayMillis > 0) wait(readyRepeatDelayMillis)
        val repeated = send(watchId, "ready", "session", message)
        val attempts = first.attempts + repeated.attempts
        return if (first.delivered || repeated.delivered) {
            Delivery(true, attempts)
        } else {
            repeated.copy(attempts = attempts)
        }
    }

    /** Best-effort settings refresh for watches whose app session is still open. */
    suspend fun repeatReadyForOpenWatches(readyMessage: PebbleDictionary) {
        state.openWatchIds().forEach { announceReady(it, readyMessage) }
    }

    fun close(watchId: String) {
        state.close(watchId)
    }

    /** Handles the reserved watch-error envelope, or returns null for a business message. */
    suspend fun receiveWatchError(
        watchId: String,
        data: PebbleDictionary,
    ): ReceiveResult? {
        if (number(data[AppMessageErrorKeys.ERROR_COMMAND]) != AppMessageErrorKeys.IMPORT.toLong()) {
            return null
        }
        val generation = number(data[AppMessageErrorKeys.ERROR_GENERATION])
        val sequence = number(data[AppMessageErrorKeys.ERROR_SEQUENCE])
        val at = number(data[AppMessageErrorKeys.ERROR_AT])
        val payload = (data[AppMessageErrorKeys.ERROR_DATA] as? PebbleDictionaryItem.Text)?.value
        val dropped = number(data[AppMessageErrorKeys.ERROR_DROPPED]) ?: 0L
        if (generation == null || sequence == null || at == null || payload == null) {
            errorReporter.report(
                WatchErrorEnvelopeException("Watch error envelope is missing a required field."),
                "importing a watch error",
            )
            return ReceiveResult.Nack
        }
        if (generation !in 1..UINT32_MAX || sequence !in 1..UINT32_MAX ||
            at !in 1..UINT32_MAX || dropped !in 0..UINT32_MAX
        ) {
            errorReporter.report(
                WatchErrorEnvelopeException("Watch error envelope contains an out-of-range integer."),
                "importing a watch error",
            )
            return ReceiveResult.Nack
        }
        if (!errorReporter.importWatch(
                watchErrorSource, generation, sequence, at, payload, dropped,
            )
        ) return ReceiveResult.Nack

        sendDiagnosticAckIfIdle(
            watchId = watchId,
            dictionary = mapOf(
                AppMessageErrorKeys.ERROR_COMMAND to PebbleDictionaryItem.UInt8(AppMessageErrorKeys.ACK),
                AppMessageErrorKeys.ERROR_GENERATION to PebbleDictionaryItem.UInt32(generation),
                AppMessageErrorKeys.ERROR_SEQUENCE to PebbleDictionaryItem.UInt32(sequence),
            ),
        )
        return ReceiveResult.Ack
    }

    private suspend fun sendDiagnosticAckIfIdle(
        watchId: String,
        dictionary: PebbleDictionary,
    ) {
        if (!state.outbox.tryLock()) return
        try {
            if (!state.isOpen(watchId)) return
            try {
                runTransportAttempt(diagnosticAckTimeoutMillis) {
                    transport.send(appUuid, watchId, dictionary)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Throwable) {
                // Diagnostic ACKs are idle-only, one-shot, and never self-report.
            }
        } finally {
            state.outbox.unlock()
        }
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
        Delivery(true, totalAttempts)
    }

    /** Admit a repeatable read. Completed duplicates carry the original replay action. */
    fun beginRead(
        watchId: String,
        operation: String,
        requestId: String,
        identity: String = "",
    ): ReadAdmission {
        return state.beginRead(
            ReadKey(watchId, operation), requestId, identity, now(), readLeaseMillis,
        )
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

    private suspend fun sendPart(
        watchId: String,
        operation: String,
        requestId: String,
        message: PebbleDictionary,
        part: Int,
        attemptLimit: Int = maxAttempts,
    ): Delivery {
        val whileDoing = "sending a Pebble AppMessage for ${operation.take(48)}"
        var attempt = 0
        while (attempt < attemptLimit) {
            if (!state.isOpen(watchId)) {
                return Delivery(false, attempt, Failure.SESSION_INACTIVE)
            }
            attempt += 1
            val result = try {
                val transportResult = runTransportAttempt(transportTimeoutMillis) {
                    transport.send(appUuid, watchId, message)
                }
                if (transportResult == null) {
                    val timeout = AppMessageTransportTimeout(transportTimeoutMillis)
                    errorReporter.report(timeout, whileDoing)
                    Attempt.Failed(Failure.TIMEOUT, retryable = true)
                } else {
                    if (transportResult != TransmissionResult.Success) {
                        errorReporter.report(transportResult, whileDoing)
                    }
                    classify(transportResult)
                }
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (error: UnexpectedTransmissionResults) {
                errorReporter.report(error, whileDoing)
                Attempt.Failed(Failure.WATCH_NOT_CONNECTED, retryable = true)
            } catch (error: Throwable) {
                errorReporter.report(error, whileDoing)
                Attempt.Failed(Failure.EXCEPTION, retryable = true)
            }
            if (result === Attempt.Delivered) return Delivery(true, attempt)
            result as Attempt.Failed
            val retry = result.retryable && attempt < attemptLimit && state.isOpen(watchId)
            if (!retry) return Delivery(false, attempt, result.failure)
            val pause = retryDelaysMillis.getOrElse(attempt - 1) { retryDelaysMillis.lastOrNull() ?: 0L }
            if (pause > 0) wait(pause)
        }
        return Delivery(false, attempt, Failure.RETRY_EXHAUSTED)
    }

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
        fun openWatchIds() = synchronized(lock) { openWatches.toList() }

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
        const val UINT32_MAX = 0xffff_ffffL
        val STATES = mutableMapOf<UUID, SessionState>()
        fun sharedState(appUuid: UUID) = synchronized(STATES) { STATES.getOrPut(appUuid, ::SessionState) }
    }

    private fun number(item: PebbleDictionaryItem?): Long? = when (item) {
        is PebbleDictionaryItem.UInt32 -> item.value.toLong()
        is PebbleDictionaryItem.Int32 -> item.value.toLong()
        is PebbleDictionaryItem.UInt16 -> item.value.toLong()
        is PebbleDictionaryItem.Int16 -> item.value.toLong()
        is PebbleDictionaryItem.UInt8 -> item.value.toLong()
        is PebbleDictionaryItem.Int8 -> item.value.toLong()
        else -> null
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
            val results = sender.sendDataToPebble(
                appUuid, dictionary, listOf(WatchIdentifier(watchId)),
            )
            if (results == null || results.size != 1) throw UnexpectedTransmissionResults(results)
            results.values.single()
        } finally {
            sender.close()
        }
    }
}

internal class UnexpectedTransmissionResults(
    results: Map<WatchIdentifier, TransmissionResult>?,
) : IllegalStateException("Expected one Pebble transmission result; received ${results?.size ?: "null"}.") {
    val resultCount = results?.size
    val results = results?.values?.toList()
}

internal class AppMessageTransportTimeout(val timeoutMillis: Long) :
    Exception("Pebble AppMessage transport did not answer within $timeoutMillis ms.")

internal class WatchErrorEnvelopeException(message: String) : IllegalArgumentException(message)

object AppMessageErrorKeys {
    const val ERROR_COMMAND: UInt = 120u
    const val ERROR_GENERATION: UInt = 121u
    const val ERROR_SEQUENCE: UInt = 122u
    const val ERROR_AT: UInt = 123u
    const val ERROR_DATA: UInt = 124u
    const val ERROR_DROPPED: UInt = 125u
    const val ERROR_ENABLED: UInt = 126u
    const val ATTEMPT: UInt = 127u

    const val IMPORT: UByte = 1u
    const val ACK: UByte = 2u
}
