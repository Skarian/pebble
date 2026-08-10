package com.skarian.pebble.appmessage

import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem
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
        val session = session(AppMessageTransport { _, _, message ->
            calls += message
            when (calls.size) {
                1 -> error("private transport detail")
                2 -> TransmissionResult.FailedTimeout
                else -> TransmissionResult.Success
            }
        })
        session.messageReceived(WATCH, "refresh", "7")

        val delivery = session.send(WATCH, "refresh", "7", message(1))

        assertTrue(delivery.delivered)
        assertEquals(3, delivery.attempts)
        calls.drop(1).forEach { assertSame(calls.first(), it) }
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
        session.messageReceived(WATCH, "history", "8")

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
        var encoded = ""
        val log = AppMessageLog("test", object : LogStorage {
            override fun read() = encoded
            override fun write(value: String) { encoded = value }
        })
        val session = session(AppMessageTransport { _, _, _ ->
            calls += 1
            TransmissionResult.FailedNoPermissions
        }, log = log)
        session.messageReceived(WATCH, "refresh", "8")

        val delivery = session.send(WATCH, "refresh", "8", message(1))

        assertFalse(delivery.delivered)
        assertEquals(AppMessageSession.Failure.NO_PERMISSIONS, delivery.failure)
        assertEquals(1, calls)
        assertTrue(log.export().contains("\"result\":\"no_permissions\""))
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
        session.messageReceived(WATCH, "read", "9")

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
        session.messageReceived(WATCH, "read", "hung")

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
        session.messageReceived(WATCH, "refresh", "11")
        val recovered = session.send(WATCH, "refresh", "11", message(1))

        assertTrue(opened.delivered)
        assertEquals(4, opened.attempts)
        assertEquals(AppMessageSession.Failure.SESSION_INACTIVE, closed.failure)
        assertTrue(recovered.delivered)
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
        session.messageReceived(WATCH, "snapshot", "12")

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
        session.messageReceived(WATCH, "snapshot", "21")
        session.messageReceived(OTHER_WATCH, "snapshot", "21")
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
        session.messageReceived(WATCH, "snapshot", "14")
        val admission = session.beginRead(WATCH, "snapshot", "14")
        val job = requireNotNull(admission.launch(this) { gate.await() })

        session.close(WATCH)
        job.join()

        assertTrue(job.isCancelled)
        session.messageReceived(WATCH, "snapshot", "14")
        assertEquals(
            AppMessageSession.ReadStatus.STARTED,
            session.beginRead(WATCH, "snapshot", "14").status,
        )
    }

    @Test
    fun `log keeps only bounded redacted incidents while routine events remain live`() {
        var encoded = listOf(
            "100\tready\tsession\tdelivery_success\tactive\t1\t1\t0\tsuccess\t\tok",
            "101\tsend\t17\tdelivery_failure\tactive\t1\t1\t0\tunknown\t\tdelivery",
        ).joinToString("\n")
        val live = mutableListOf<String>()
        val log = AppMessageLog(
            app = "agents",
            storage = object : LogStorage {
                override fun read() = encoded
                override fun write(value: String) { encoded = value }
            },
            limit = 2,
            now = { 123L },
            output = live::add,
        )

        log.record(LogEntry(operation = "send", requestId = "dictation secret@example.com", event = "request"))
        log.record(LogEntry(
            operation = "send", requestId = "dictation secret@example.com",
            event = "delivery_retry", result = "unknown", detail = "bad value with token",
            category = "pending",
        ))
        log.record(LogEntry(
            operation = "refresh", requestId = "18", event = "domain_failure",
            category = "service",
        ))

        val report = log.export()
        assertFalse(report.contains("secret@example.com"))
        assertFalse(report.contains("dictation secret"))
        assertFalse(report.contains("bad value with token"))
        assertTrue(report.contains("hash:"))
        assertFalse(report.contains("delivery_success"))
        assertFalse(report.contains("\"event\":\"request\""))
        assertTrue(report.contains("delivery_retry"))
        assertTrue(report.contains("domain_failure"))
        assertEquals(2, report.split("\"at\":").size - 1)
        assertTrue(live.any { it.contains("event=request ") })
        assertFalse(encoded.contains("delivery_success"))
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
        log: AppMessageLog = AppMessageLog("test", object : LogStorage {
            override fun read() = ""
            override fun write(value: String) = Unit
        }),
    ) = AppMessageSession(
        appUuid = UUID.fromString("e4491051-309d-4d5c-9f5a-5f1ab531051d"),
        transport = transport,
        log = log,
        state = AppMessageSession.SessionState(),
        maxAttempts = maxAttempts,
        retryDelaysMillis = listOf(0L, 0L),
        transportTimeoutMillis = 1L,
        runTransportAttempt = runTransportAttempt,
        wait = {},
        now = now,
        readLeaseMillis = readLeaseMillis,
        readyRepeatDelayMillis = 0,
    )

    private fun message(value: Int): PebbleDictionary = mapOf(
        1u to PebbleDictionaryItem.UInt8(value.toUByte()),
    )

    private companion object {
        const val WATCH = "watch"
        const val OTHER_WATCH = "other-watch"
    }
}
