package com.skarian.pebble.errors

import androidx.work.ExistingWorkPolicy
import java.io.IOException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class ErrorReporterTest {
    @Test
    fun `opted out reporter creates no journal or work`() {
        val store = MemoryStore()
        var scheduled = 0
        val reporter = AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config()), ErrorJournal(store),
            { error("disabled reporter inspected secrets") }, { _ -> scheduled += 1 }, {},
        )

        reporter.report(IllegalStateException("failure"), "testing opt-out")

        assertEquals(0, store.writes)
        assertEquals(0, scheduled)
        assertFalse(reporter.enabled)
    }

    @Test
    fun `opted out status does not read the journal`() {
        val store = MemoryStore()
        val reporter = AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config()), ErrorJournal(store),
            { error("disabled reporter inspected secrets") }, { _ -> }, {},
        )

        assertEquals(ErrorReporter.Status(false, 0), reporter.status())
        assertEquals(0, store.reads)
    }

    @Test
    fun `startup schedules a preexisting enabled queue and does nothing while disabled`() {
        val enabledStore = MemoryStore()
        ErrorJournal(enabledStore).add(listOf(record("queued")))
        val policies = mutableListOf<ExistingWorkPolicy>()

        AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config(true, "key")),
            ErrorJournal(enabledStore), { emptyList() }, { policies += it }, {},
        )
        val disabledStore = MemoryStore().apply { value = enabledStore.value }
        AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config()), ErrorJournal(disabledStore),
            { error("disabled reporter inspected secrets") }, { policies += it }, {},
        )

        assertEquals(listOf(ExistingWorkPolicy.KEEP), policies)
        assertEquals(0, disabledStore.reads)
    }

    @Test
    fun `broken settings cannot escape through the optional reporter`() {
        val store = MemoryStore()
        val reporter = AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config(true, "key"), failReads = true),
            ErrorJournal(store), { emptyList() }, { _ -> error("scheduled") }, {},
        )

        reporter.report(IllegalStateException("source failure"), "testing broken settings")

        assertFalse(reporter.enabled)
        assertEquals(ErrorReporter.Status(false, 0), reporter.status())
        assertEquals(0, store.writes)
    }

    @Test
    fun `throwable keeps source evidence while only sensitive values are redacted`() {
        val error = SourceFailure(
            503,
            mapOf("error" to "temporarily_unavailable", "refresh_token" to "refresh-456",
                "detail" to "message user-secret remains structured", "payload" to "ordinary evidence",
                "history" to "past events", "dictionary" to "wire evidence", "short" to "xy",
                "token" to "generic-token", "api_key" to "generic-api-key",
                "credential" to "generic-credential", "secret" to "generic-secret"),
            IOException("authorization Bearer access-123; token=generic-message-token and nearby text"),
        ).also { it.addSuppressed(IllegalArgumentException("secondary")) }
        val record = Capture.error(
            "agents/android@test", "calling the router", error,
            listOf("access-123", "refresh-456", "user-secret", "xy"),
        ).single()
        val captured = record.getJSONObject("error")
        val encoded = captured.toString()

        assertEquals(SourceFailure::class.java.name, captured.getString("name"))
        assertTrue(encoded.contains("503"))
        assertTrue(encoded.contains("temporarily_unavailable"))
        assertTrue(encoded.contains("nearby text"))
        assertTrue(encoded.contains("secondary"))
        assertTrue(encoded.contains("ordinary evidence"))
        assertTrue(encoded.contains("past events"))
        assertTrue(encoded.contains("wire evidence"))
        assertTrue(encoded.contains("[REDACTED]"))
        assertFalse(encoded.contains("access-123"))
        assertFalse(encoded.contains("refresh-456"))
        assertFalse(encoded.contains("user-secret"))
        assertFalse(encoded.contains("generic-token"))
        assertFalse(encoded.contains("generic-api-key"))
        assertFalse(encoded.contains("generic-credential"))
        assertFalse(encoded.contains("generic-secret"))
        assertFalse(encoded.contains("generic-message-token"))
        assertTrue(captured.getString("stack").contains("ErrorReporterTest"))
    }

    @Test
    fun `opting out clears configuration queue and cancels upload`() {
        val settings = MemorySettings(Config(true, "private-key"))
        val store = MemoryStore()
        val journal = ErrorJournal(store)
        journal.add(listOf(record("queued")))
        var cancelled = 0
        val reporter = AndroidErrorReporter(
            "agents/android@test", settings, journal, { emptyList() }, { _ -> },
            { cancelled += 1 },
        )

        reporter.configure(false)

        assertFalse(reporter.enabled)
        assertEquals("", settings.read().key)
        assertEquals(0, reporter.status().queued)
        assertEquals(1, cancelled)
    }

    @Test
    fun `report snapshots and persists mutable evidence before returning`() {
        val journal = ErrorJournal(MemoryStore())
        val reporter = AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config(true, "key")),
            journal, { emptyList() }, { _ -> }, {},
        )
        val evidence = mutableMapOf("detail" to "before")

        reporter.report(evidence, "testing synchronous capture")
        evidence["detail"] = "after"

        val stored = requireNotNull(journal.next()).toString()
        assertTrue(stored.contains("before"))
        assertFalse(stored.contains("after"))
    }

    @Test
    fun `failed opt out still cancels work and clears queued errors`() {
        val settings = MemorySettings(Config(true, "key"), failWrites = 1)
        val journal = ErrorJournal(MemoryStore()).also { it.add(listOf(record("queued"))) }
        val runtime = ReporterState()
        var cancelled = 0
        fun reporter(state: ReporterState) = AndroidErrorReporter(
            "agents/android@test", settings, journal, { emptyList() }, { _ -> }, { cancelled++ }, state,
        )
        val current = reporter(runtime)

        assertThrows(IOException::class.java) { current.configure(false) }

        assertFalse(current.enabled)
        assertFalse(reporter(runtime).enabled)
        assertEquals(0, current.status().queued)
        assertEquals(1, cancelled)
        assertTrue(reporter(ReporterState()).enabled)
        assertEquals(0, reporter(ReporterState()).status().queued)
    }

    @Test
    fun `opt out cannot race a report into the cleared journal`() {
        val enteredCapture = CountDownLatch(1)
        val releaseCapture = CountDownLatch(1)
        val disabled = CountDownLatch(1)
        val journal = ErrorJournal(MemoryStore())
        val reporter = AndroidErrorReporter(
            "agents/android@test", MemorySettings(Config(true, "key")),
            journal, { enteredCapture.countDown(); releaseCapture.await(); emptyList() }, { _ -> }, {},
        )
        val reporting = thread { reporter.report(IllegalStateException("failure"), "testing race") }
        assertTrue(enteredCapture.await(1, TimeUnit.SECONDS))
        val disabling = thread { reporter.configure(false); disabled.countDown() }
        assertFalse(disabled.await(100, TimeUnit.MILLISECONDS))
        releaseCapture.countDown()
        reporting.join(); disabling.join()

        assertFalse(reporter.enabled)
        assertEquals(0, reporter.status().queued)
    }

    @Test
    fun `background capture keeps work while rekey and manual send replace it`() {
        val settings = MemorySettings(Config(true, "old-key"))
        val journal = ErrorJournal(MemoryStore()).also { it.add(listOf(record("queued"))) }
        val policies = mutableListOf<ExistingWorkPolicy>()
        val reporter = AndroidErrorReporter(
            "agents/android@test", settings, journal, { emptyList() }, { policies += it }, {},
        )

        reporter.report(IllegalStateException("captured"), "testing normal scheduling")
        reporter.configure(true, "old-key")
        reporter.configure(true, "new-key")
        reporter.sendNow()

        assertEquals("new-key", settings.read().key)
        assertEquals(2, reporter.status().queued)
        assertEquals(listOf(
            ExistingWorkPolicy.KEEP, ExistingWorkPolicy.KEEP, ExistingWorkPolicy.KEEP,
            ExistingWorkPolicy.REPLACE, ExistingWorkPolicy.REPLACE,
        ), policies)
        assertEquals("https://pebble.exe.xyz", ErrorReporter.ENDPOINT)
    }

    @Test
    fun `redaction failure holds source locally and adds one safe error`() {
        val records = Capture.error(
            "agents/android@test", "processing a result",
            IllegalStateException("private-source-value"), emptyList(),
            redactor = { _, _ -> error("redactor broke") },
        )
        val journal = ErrorJournal(MemoryStore())
        journal.add(records)

        assertEquals(2, records.size)
        assertTrue(records.first().optBoolean("_held"))
        assertTrue(records.first().toString().contains("private-source-value"))
        assertFalse(records.last().toString().contains("private-source-value"))
        assertEquals(1, journal.status().held)
        assertEquals("ErrorRedactionFailure", requireNotNull(journal.next()).getJSONObject("error").getString("name"))
    }

    @Test
    fun `upload retry preserves original identity and order`() {
        val journal = ErrorJournal(MemoryStore())
        val first = record("one")
        val second = record("two")
        journal.add(listOf(first, second))
        val attempted = mutableListOf<String>()
        var fail = true
        val transport = UploadTransport { value ->
            attempted += value.getString("id")
            if (fail) UploadResult.Failed(IOException("offline"), true) else UploadResult.Accepted
        }

        assertEquals(Drain.TRANSIENT, Uploader(journal, transport).drain())
        fail = false
        assertEquals(Drain.COMPLETE, Uploader(journal, transport).drain())

        assertEquals(listOf("one", "one", "two"), attempted.take(3))
        assertEquals(0, journal.status().queued)
    }

    @Test
    fun `upload health keeps one identity across repeated failure and lost ACK`() {
        val journal = ErrorJournal(MemoryStore()).also { it.add(listOf(record("source"))) }
        var sourceAttempts = 0
        val acceptedHealthIds = mutableListOf<String>()
        val transport = UploadTransport { value ->
            assertFalse(value.has("_kind"))
            if (value.getJSONObject("error").getString("name") == "TestError") {
                sourceAttempts++
                if (sourceAttempts <= 2) UploadResult.Failed(IOException("offline"), true)
                else UploadResult.Accepted
            } else {
                acceptedHealthIds += value.getString("id")
                if (acceptedHealthIds.size == 1) UploadResult.Failed(IOException("accepted but ACK lost"), true)
                else UploadResult.Accepted
            }
        }

        assertEquals(Drain.TRANSIENT, Uploader(journal, transport).drain())
        assertEquals(2, journal.status().queued)
        assertEquals(Drain.TRANSIENT, Uploader(journal, transport).drain())
        assertEquals(2, journal.status().queued)
        assertEquals(Drain.TRANSIENT, Uploader(journal, transport).drain())
        assertEquals(Drain.COMPLETE, Uploader(journal, transport).drain())

        assertEquals(2, acceptedHealthIds.size)
        assertEquals(1, acceptedHealthIds.distinct().size)
        assertEquals(0, journal.status().queued)
    }

    @Test
    fun `journal coalesces overflow and retains it until server ACK`() {
        val journal = ErrorJournal(MemoryStore(), maxBytes = 64 * 1024, maxRecords = 3)
        journal.add(listOf(record("one"), record("two"), record("three"), record("four")))

        listOf("three", "four").forEach { id ->
            assertEquals(id, requireNotNull(journal.next()).getString("id"))
            journal.acknowledge(id)
        }
        val overflow = requireNotNull(journal.next())
        assertEquals("QueueOverflow", overflow.getJSONObject("error").getString("name"))
        assertEquals(2L, overflow.getJSONObject("error").getLong("dropped"))
        assertEquals(overflow.getString("id"), requireNotNull(journal.next()).getString("id"))
        journal.acknowledge(overflow.getString("id"))
        assertEquals(0, journal.status().queued)
    }

    @Test
    fun `corrupt journal resets once and preserves the next source error`() {
        val store = MemoryStore().apply { value = "not-json" }
        val journal = ErrorJournal(store)

        journal.add(listOf(record("source")))

        val recovery = requireNotNull(journal.next(includePrivate = true))
        assertEquals("ErrorJournalRecovery", recovery.getJSONObject("error").getString("name"))
        assertEquals("journal", recovery.getString("_kind"))
        journal.acknowledge(recovery.getString("id"))
        assertEquals("source", requireNotNull(journal.next()).getString("id"))
        assertEquals(1, journal.status().queued)
    }

    @Test
    fun `HTTP upload error retains the bounded original response body`() {
        val error = HttpUploadError(401, "https://pebble.exe.xyz", "{\"error\":\"invalid key\"}")
        val captured = Capture.error(
            "agents/android@test", "uploading an error report", error, emptyList(),
        ).single().getJSONObject("error").toString()

        assertTrue(captured.contains("invalid key"))
        assertTrue(captured.contains("401"))
    }

    @Test
    fun `failed queue deletion cannot revive stale errors after re-enable`() {
        val settings = MemorySettings(Config(true, "key"))
        val store = MemoryStore()
        val journal = ErrorJournal(store).also { it.add(listOf(record("stale"))) }
        val reporter = AndroidErrorReporter(
            "agents/android@test", settings, journal, { emptyList() }, { _ -> }, {},
        )
        store.failClears = 2

        assertThrows(IOException::class.java) { reporter.configure(false) }
        assertFalse(reporter.enabled)
        assertThrows(IOException::class.java) { reporter.configure(true, "new-key") }
        assertFalse(reporter.enabled)

        reporter.configure(true, "new-key")
        assertTrue(reporter.enabled)
        assertEquals(0, reporter.status().queued)
    }

    @Test
    fun `uncaught handler reports the original throwable then always delegates`() {
        val fatal = IllegalStateException("fatal source error")
        val events = mutableListOf<String>()
        val reporter = object : ErrorReporter {
            override val enabled = true
            override fun report(originalError: Any, whileDoing: String) {
                assertSame(fatal, originalError)
                assertTrue(whileDoing.contains("fatal-worker"))
                events += "reported"
                throw IOException("report failed")
            }
        }
        val delegate = Thread.UncaughtExceptionHandler { _, error ->
            assertSame(fatal, error)
            events += "delegated"
        }

        ReportingUncaughtHandler(reporter, delegate)
            .uncaughtException(Thread("fatal-worker"), fatal)
        ReportingUncaughtHandler(ErrorReporter { _, _ -> error("disabled reporter ran") }, delegate)
            .uncaughtException(Thread("fatal-worker"), fatal)

        assertEquals(listOf("reported", "delegated", "delegated"), events)
    }

    @Test
    fun `oversized error keeps a searchable source snapshot instead of dropping custom fields`() {
        val record = Capture.error(
            "agents/android@test", "handling a Termux result",
            mapOf(
                "exitCode" to 17,
                "stdout" to "stdout-marker-" + "o".repeat(20_000),
                "stderr" to "stderr-marker-" + "e".repeat(20_000),
            ), emptyList(),
        ).single()
        val journal = ErrorJournal(MemoryStore())

        journal.add(listOf(record))

        val error = requireNotNull(journal.next()).getJSONObject("error")
        assertTrue(error.getBoolean("truncated"))
        assertEquals(17, error.getInt("exitCode"))
        assertTrue(error.getString("stdout").startsWith("stdout-marker"))
        assertTrue(error.getString("stdout").endsWith("[TRUNCATED]"))
        assertTrue(error.getString("stderr").startsWith("stderr-marker"))
        assertTrue(requireNotNull(journal.next()).toString().toByteArray().size <= 16 * 1024)
    }

    @Test
    fun `watch relay retains nine source fields with stable identity and ISO time`() {
        val journal = ErrorJournal(MemoryStore())
        val payload = "v1\tAppMessageResult\tapp_message_outbox_send\t7\tAPP_MSG_BUSY\tOutbox busy\tsrc/main.c\t91\tsending refresh"
        repeat(2) {
            journal.add(Capture.watch(
                "agents/watch@test", 41, 9, 1234, payload, 2, emptyList(),
            ))
        }

        assertEquals(2, journal.status().queued)
        val value = requireNotNull(journal.next())
        val error = value.getJSONObject("error")
        assertEquals("watch:agents/watch@test:41:9", value.getString("id"))
        assertEquals("1970-01-01T00:20:34.000Z", value.getString("at"))
        assertEquals("sending refresh", value.getString("while"))
        assertEquals("Outbox busy", error.getString("message"))
        assertEquals(7L, error.getLong("code"))
        assertFalse(error.has("droppedBefore"))
        journal.acknowledge(value.getString("id"))
        val overflow = requireNotNull(journal.next()).getJSONObject("error")
        assertEquals("WatchErrorQueueOverflow", overflow.getString("name"))
        assertEquals(2L, overflow.getLong("dropped"))
    }

    private fun record(id: String) = JSONObject().put("id", id)
        .put("at", "2026-08-10T12:00:00Z").put("source", "test/android@test")
        .put("while", "testing").put("error", JSONObject().put("name", "TestError").put("message", id))

    private class SourceFailure(
        val status: Int, val response: Map<String, String>, cause: Throwable,
    ) : Exception("router returned HTTP $status", cause)

    private class MemorySettings(
        private var value: Config,
        var failWrites: Int = 0,
        private val failReads: Boolean = false,
    ) : Settings {
        override fun read() = if (failReads) throw IOException("read failed") else value
        override fun write(value: Config) {
            if (failWrites-- > 0) throw IOException("commit failed")
            this.value = value
        }
    }

    private class MemoryStore : JournalStore {
        var value: String? = null
        var reads = 0
        var writes = 0
        var failClears = 0
        override fun read() = value.also { reads++ }
        override fun write(value: String) { this.value = value; writes += 1 }
        override fun clear() {
            if (failClears > 0) { failClears--; throw IOException("clear failed") }
            value = null
        }
    }
}
