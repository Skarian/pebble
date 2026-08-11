package com.skarian.pebble.appmessage

import com.skarian.pebble.errors.ErrorReporter
import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
import io.rebble.pebblekit2.common.model.ReceiveResult
import io.rebble.pebblekit2.common.model.TransmissionResult
import java.util.UUID
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AppMessageSessionTest {
    @Test
    fun `exception and timeout retry the identical message before success`() = runBlocking {
        val calls = mutableListOf<PebbleDictionary>()
        val reported = mutableListOf<Pair<Any, String>>()
        val original = IllegalStateException("private transport detail")
        val session = session(AppMessageTransport { _, _, message ->
            calls += message
            when (calls.size) {
                1 -> throw original
                2 -> TransmissionResult.FailedTimeout
                else -> TransmissionResult.Success
            }
        }, reporter = ErrorReporter { error, whileDoing -> reported += error to whileDoing })
        session.open(WATCH)

        val delivery = session.send(WATCH, "refresh", "7", message(1))

        assertTrue(delivery.delivered)
        assertEquals(3, delivery.attempts)
        calls.drop(1).forEach { assertSame(calls.first(), it) }
        assertSame(original, reported[0].first)
        assertSame(TransmissionResult.FailedTimeout, reported[1].first)
        assertTrue(reported.all { it.second == "sending a Pebble AppMessage for refresh" })
    }

    @Test
    fun `batch retries only the failed part and preserves order`() = runBlocking {
        val order = mutableListOf<Int>()
        var failedSecond = false
        val session = session(AppMessageTransport { _, _, data ->
            val part = (data.getValue(1u) as PebbleDictionaryItem.UInt8).value.toInt()
            order += part
            if (part == 2 && !failedSecond) {
                failedSecond = true
                TransmissionResult.FailedWatchNacked
            } else {
                TransmissionResult.Success
            }
        })
        session.open(WATCH)

        val delivery = session.sendBatch(
            WATCH, "history", "8", listOf(message(1), message(2), message(3)),
        )

        assertTrue(delivery.delivered)
        assertEquals(4, delivery.attempts)
        assertEquals(listOf(1, 2, 2, 3), order)
    }

    @Test
    fun `permanent failure is typed and never retried`() = runBlocking {
        var calls = 0
        val reported = mutableListOf<Any>()
        val session = session(AppMessageTransport { _, _, _ ->
            calls += 1
            TransmissionResult.FailedNoPermissions
        }, reporter = ErrorReporter { error, _ -> reported += error })
        session.open(WATCH)

        val delivery = session.send(WATCH, "refresh", "8", message(1))

        assertFalse(delivery.delivered)
        assertEquals(AppMessageSession.Failure.NO_PERMISSIONS, delivery.failure)
        assertEquals(1, calls)
        assertEquals(listOf(TransmissionResult.FailedNoPermissions), reported)
    }

    @Test
    fun `all batches share one ordered outbox`() = runBlocking {
        val active = AtomicInteger()
        val maximum = AtomicInteger()
        val session = session(AppMessageTransport { _, _, _ ->
            maximum.updateAndGet { maxOf(it, active.incrementAndGet()) }
            delay(5)
            active.decrementAndGet()
            TransmissionResult.Success
        })
        session.open(WATCH)

        coroutineScope {
            val first = async { session.sendBatch(WATCH, "read", "9", listOf(message(1), message(2))) }
            val second = async { session.sendBatch(WATCH, "read", "10", listOf(message(3), message(4))) }
            assertTrue(first.await().delivered)
            assertTrue(second.await().delivered)
        }

        assertEquals(1, maximum.get())
    }

    @Test
    fun `transport watchdog exhausts a hung send then releases the ordered outbox`() = runBlocking {
        val calls = mutableListOf<Int>()
        val session = session(
            transport = AppMessageTransport { _, _, data ->
                val value = (data.getValue(1u) as PebbleDictionaryItem.UInt8).value.toInt()
                calls += value
                if (value == 1) awaitCancellation()
                TransmissionResult.Success
            },
            runTransportAttempt = { _, send ->
                coroutineScope {
                    val attempt = async(start = CoroutineStart.UNDISPATCHED) { send() }
                    if (attempt.isCompleted) {
                        attempt.await()
                    } else {
                        attempt.cancelAndJoin()
                        null
                    }
                }
            },
        )
        session.open(WATCH)

        coroutineScope {
            val hung = async { session.send(WATCH, "read", "hung", message(1)) }
            val following = async { session.send(WATCH, "read", "next", message(2)) }

            val failed = hung.await()
            assertFalse(failed.delivered)
            assertEquals(3, failed.attempts)
            assertEquals(AppMessageSession.Failure.TIMEOUT, failed.failure)
            assertTrue(following.await().delivered)
        }
        assertEquals(listOf(1, 1, 1, 2), calls)
    }

    @Test
    fun `READY repeats and either successful announcement succeeds`() = runBlocking {
        val calls = mutableListOf<TransmissionResult>()
        val session = session(AppMessageTransport { _, _, _ ->
            val result = if (calls.size < 3) TransmissionResult.FailedTimeout else TransmissionResult.Success
            calls += result
            result
        }, maxAttempts = 2)

        session.open(WATCH)
        val opened = session.announceReady(WATCH, message(19))
        session.close(WATCH)
        val closed = session.send(WATCH, "refresh", "11", message(1))
        session.open(WATCH)
        val recovered = session.send(WATCH, "refresh", "11", message(1))

        assertTrue(opened.delivered)
        assertEquals(4, opened.attempts)
        assertEquals(AppMessageSession.Failure.SESSION_INACTIVE, closed.failure)
        assertTrue(recovered.delivered)
    }

    @Test
    fun `READY advertises reporter opt in on every announcement`() = runBlocking {
        val messages = mutableListOf<PebbleDictionary>()
        var optedIn = false
        val reporter = object : ErrorReporter {
            override val enabled get() = optedIn
            override fun report(originalError: Any, whileDoing: String) = Unit
        }
        val session = session(
            AppMessageTransport { _, _, data ->
                messages += data
                TransmissionResult.Success
            },
            reporter = reporter,
        )

        session.open(WATCH)
        assertTrue(session.announceReady(WATCH, message(19)).delivered)

        assertEquals(2, messages.size)
        messages.forEach {
            assertEquals(
                0u.toUByte(),
                (it[AppMessageErrorKeys.ERROR_ENABLED] as PebbleDictionaryItem.UInt8).value,
            )
        }
        messages.clear()
        optedIn = true
        session.repeatReadyForOpenWatches(message(19))
        assertEquals(2, messages.size)
        messages.forEach {
            assertEquals(1u.toUByte(),
                (it[AppMessageErrorKeys.ERROR_ENABLED] as PebbleDictionaryItem.UInt8).value)
        }
        session.close(WATCH)
        session.repeatReadyForOpenWatches(message(19))
        assertEquals(2, messages.size)
    }

    @Test
    fun `watch error is durably imported before matching ACK is sent`() = runBlocking {
        val imported = mutableListOf<List<Any>>()
        val sent = mutableListOf<PebbleDictionary>()
        val reporter = object : ErrorReporter {
            override val enabled = true
            override fun report(originalError: Any, whileDoing: String) = Unit
            override suspend fun importWatch(
                source: String,
                generation: Long,
                sequence: Long,
                atEpochSeconds: Long,
                payload: String,
                dropped: Long,
            ): Boolean {
                imported += listOf(source, generation, sequence, atEpochSeconds, payload, dropped)
                return true
            }
        }
        val session = session(
            transport = AppMessageTransport { _, _, data ->
                sent += data
                TransmissionResult.Success
            },
            reporter = reporter,
            watchSource = "agents/watch@test",
        )
        session.open(WATCH)
        val payload = WATCH_ERROR
        val result = session.receiveWatchError(WATCH, watchError(payload = payload))

        assertEquals(ReceiveResult.Ack, result)
        assertEquals(listOf("agents/watch@test", 5L, 8L, 123L, payload, 2L), imported.single())
        assertEquals(1, sent.size)
        assertEquals(
            AppMessageErrorKeys.ACK,
            (sent.single()[AppMessageErrorKeys.ERROR_COMMAND] as PebbleDictionaryItem.UInt8).value,
        )
        assertEquals(
            8u,
            (sent.single()[AppMessageErrorKeys.ERROR_SEQUENCE] as PebbleDictionaryItem.UInt32).value,
        )
    }

    @Test
    fun `watch relay rejects nonpositive identity and timestamp before import`() = runBlocking {
        var imports = 0
        val reported = mutableListOf<Any>()
        val reporter = object : ErrorReporter {
            override fun report(originalError: Any, whileDoing: String) { reported += originalError }
            override suspend fun importWatch(source: String, generation: Long, sequence: Long,
                atEpochSeconds: Long, payload: String, dropped: Long): Boolean { imports += 1; return true }
        }
        val session = session(reporter = reporter)
        session.open(WATCH)

        assertEquals(ReceiveResult.Nack, session.receiveWatchError(WATCH, watchError(generation = 0u)))
        assertEquals(ReceiveResult.Nack, session.receiveWatchError(WATCH, watchError(sequence = 0u)))
        assertEquals(ReceiveResult.Nack, session.receiveWatchError(WATCH, watchError(at = 0u)))

        assertEquals(0, imports)
        assertEquals(3, reported.size)
        assertTrue(reported.all { it is WatchErrorEnvelopeException })
    }

    @Test
    fun `watch error ACK is omitted instead of waiting behind business delivery`() = runBlocking {
        val started = CompletableDeferred<Unit>()
        val release = CompletableDeferred<Unit>()
        val sent = mutableListOf<PebbleDictionary>()
        val reporter = object : ErrorReporter {
            override fun report(originalError: Any, whileDoing: String) = Unit
            override suspend fun importWatch(source: String, generation: Long, sequence: Long,
                atEpochSeconds: Long, payload: String, dropped: Long) = true
        }
        val session = session(AppMessageTransport { _, _, data ->
            sent += data
            if (data.containsKey(1u)) { started.complete(Unit); release.await() }
            TransmissionResult.Success
        }, reporter = reporter)
        session.open(WATCH)
        val business = async { session.send(WATCH, "refresh", "1", message(1)) }
        started.await()

        assertEquals(ReceiveResult.Ack, session.receiveWatchError(WATCH, watchError()))
        assertEquals(1, sent.size)

        release.complete(Unit)
        assertTrue(business.await().delivered)
    }

    @Test
    fun `watch error ACK is one shot and never reports its own delivery failure`() = runBlocking {
        var sends = 0
        val reported = mutableListOf<Any>()
        val reporter = object : ErrorReporter {
            override fun report(originalError: Any, whileDoing: String) { reported += originalError }
            override suspend fun importWatch(source: String, generation: Long, sequence: Long,
                atEpochSeconds: Long, payload: String, dropped: Long) = true
        }
        val session = session(
            transport = AppMessageTransport { _, _, _ ->
                sends += 1
                TransmissionResult.FailedWatchNotConnected
            },
            reporter = reporter,
        )
        session.open(WATCH)

        assertEquals(ReceiveResult.Ack, session.receiveWatchError(WATCH, watchError()))
        assertEquals(1, sends)
        assertTrue(reported.isEmpty())
    }

    @Test
    fun `diagnostic ACK timeout is short and releases the business outbox`() = runBlocking {
        val timeouts = mutableListOf<Long>()
        val sent = mutableListOf<Int>()
        val reporter = object : ErrorReporter {
            override fun report(originalError: Any, whileDoing: String) = Unit
            override suspend fun importWatch(source: String, generation: Long, sequence: Long,
                atEpochSeconds: Long, payload: String, dropped: Long) = true
        }
        val session = session(
            transport = AppMessageTransport { _, _, data ->
                (data[1u] as? PebbleDictionaryItem.UInt8)?.value?.toInt()?.let(sent::add)
                TransmissionResult.Success
            },
            reporter = reporter,
            runTransportAttempt = { timeout, send ->
                timeouts += timeout
                if (timeout == 500L) null else send()
            },
        )
        session.open(WATCH)

        assertEquals(ReceiveResult.Ack, session.receiveWatchError(WATCH, watchError()))
        assertTrue(session.send(WATCH, "refresh", "1", message(7)).delivered)

        assertEquals(listOf(500L, 1L), timeouts)
        assertEquals(listOf(7), sent)
    }

    @Test
    fun `READY work queued before close cannot reopen the session`() = runBlocking {
        var calls = 0
        val session = session(AppMessageTransport { _, _, _ ->
            calls += 1
            TransmissionResult.Success
        })

        session.open(WATCH)
        session.close(WATCH)
        val ready = session.announceReady(WATCH, message(19))

        assertEquals(AppMessageSession.Failure.SESSION_INACTIVE, ready.failure)
        assertEquals(0, ready.attempts)
        assertEquals(0, calls)
    }

    @Test
    fun `read ledger coalesces exact ids rejects conflicts and replays completion`() = runBlocking {
        var now = 0L
        var replays = 0
        var starts = 0
        val session = session(now = { now }, readLeaseMillis = 100)
        session.open(WATCH)

        val started = session.beginRead(WATCH, "snapshot", "12", "scale:hour")
        assertEquals(AppMessageSession.ReadStatus.STARTED, started.status)
        requireNotNull(started.launch(this) { starts += 1 }).join()
        val coalesced = session.beginRead(WATCH, "snapshot", "12", "scale:hour")
        assertEquals(
            AppMessageSession.ReadStatus.COALESCED,
            coalesced.status,
        )
        assertEquals(null, coalesced.launch(this) { starts += 1 })
        assertEquals(1, starts)
        assertEquals(
            AppMessageSession.ReadStatus.CONFLICT,
            session.beginRead(WATCH, "snapshot", "12", "scale:day").status,
        )
        assertEquals(
            AppMessageSession.ReadStatus.BUSY,
            session.beginRead(WATCH, "snapshot", "13", "scale:hour").status,
        )
        assertTrue(session.completeRead(WATCH, "snapshot", "12") { replays += 1 })

        val replay = session.beginRead(WATCH, "snapshot", "12", "scale:hour")
        assertEquals(AppMessageSession.ReadStatus.REPLAYED, replay.status)
        assertTrue(replay.replay())
        assertEquals(1, replays)

        assertEquals(
            AppMessageSession.ReadStatus.STARTED,
            session.beginRead(WATCH, "snapshot", "13", "scale:hour").status,
        )
        now = 101
        assertEquals(
            AppMessageSession.ReadStatus.STARTED,
            session.beginRead(WATCH, "snapshot", "13", "scale:hour").status,
        )
    }

    @Test
    fun `read completion and abandonment are scoped to one watch`() = runBlocking {
        var firstReplays = 0
        val session = session()
        session.open(WATCH)
        session.open(OTHER_WATCH)
        session.beginRead(WATCH, "snapshot", "21")
        session.beginRead(OTHER_WATCH, "snapshot", "21")

        assertTrue(session.completeRead(WATCH, "snapshot", "21") { firstReplays += 1 })
        assertEquals(
            AppMessageSession.ReadStatus.REPLAYED,
            session.beginRead(WATCH, "snapshot", "21").status,
        )
        assertEquals(
            AppMessageSession.ReadStatus.COALESCED,
            session.beginRead(OTHER_WATCH, "snapshot", "21").status,
        )

        session.abandonRead(OTHER_WATCH, "snapshot", "21")
        assertEquals(
            AppMessageSession.ReadStatus.STARTED,
            session.beginRead(OTHER_WATCH, "snapshot", "21").status,
        )
        assertEquals(0, firstReplays)
    }

    @Test
    fun `closing a session cancels its active read`() = runBlocking {
        val gate = CompletableDeferred<Unit>()
        val session = session()
        session.open(WATCH)
        val admission = session.beginRead(WATCH, "snapshot", "14")
        val job = requireNotNull(admission.launch(this) { gate.await() })

        session.close(WATCH)
        job.join()

        assertTrue(job.isCancelled)
        session.open(WATCH)
        assertEquals(
            AppMessageSession.ReadStatus.STARTED,
            session.beginRead(WATCH, "snapshot", "14").status,
        )
    }

    private fun session(
        transport: AppMessageTransport = AppMessageTransport { _, _, _ -> TransmissionResult.Success },
        maxAttempts: Int = 3,
        runTransportAttempt: suspend (
            timeoutMillis: Long,
            send: suspend () -> TransmissionResult,
        ) -> TransmissionResult? = { _, send -> send() },
        now: () -> Long = System::currentTimeMillis,
        readLeaseMillis: Long = 90_000,
        reporter: ErrorReporter = ErrorReporter.Disabled,
        watchSource: String = "test/watch@test",
    ) = AppMessageSession(
        appUuid = UUID.fromString("e4491051-309d-4d5c-9f5a-5f1ab531051d"),
        transport = transport,
        errorReporter = reporter,
        watchErrorSource = watchSource,
        state = AppMessageSession.SessionState(),
        maxAttempts = maxAttempts,
        retryDelaysMillis = listOf(0L, 0L),
        transportTimeoutMillis = 1L,
        diagnosticAckTimeoutMillis = 500L,
        runTransportAttempt = runTransportAttempt,
        wait = {},
        now = now,
        readLeaseMillis = readLeaseMillis,
        readyRepeatDelayMillis = 0,
    )

    private fun message(value: Int): PebbleDictionary = mapOf(
        1u to PebbleDictionaryItem.UInt8(value.toUByte()),
    )

    private fun watchError(generation: UInt = 5u, sequence: UInt = 8u, at: UInt = 123u,
                           payload: String = WATCH_ERROR): PebbleDictionary = mapOf(
        AppMessageErrorKeys.ERROR_COMMAND to PebbleDictionaryItem.UInt8(AppMessageErrorKeys.IMPORT),
        AppMessageErrorKeys.ERROR_GENERATION to PebbleDictionaryItem.UInt32(generation),
        AppMessageErrorKeys.ERROR_SEQUENCE to PebbleDictionaryItem.UInt32(sequence),
        AppMessageErrorKeys.ERROR_AT to PebbleDictionaryItem.UInt32(at),
        AppMessageErrorKeys.ERROR_DATA to PebbleDictionaryItem.Text(payload),
        AppMessageErrorKeys.ERROR_DROPPED to PebbleDictionaryItem.UInt32(2u),
    )

    private companion object {
        const val WATCH = "watch"
        const val OTHER_WATCH = "other-watch"
        const val WATCH_ERROR = "v1\tAppMessageResult\tapp_message_outbox_send\t7\tAPP_MSG_BUSY\tbusy\tmain.c\t90\tsending"
    }
}
