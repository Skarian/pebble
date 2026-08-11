package com.skarian.airquality

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.yield
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

class AirQualityReadTest {
    @Test
    fun `reading insert failure is never silently ignored`() {
        assertThrows(IllegalStateException::class.java) { requireReadingInserted(-1) }
    }

    @Test
    fun `cached response precedes one live scan and history repair`() = runBlocking {
        val scanGate = CompletableDeferred<Unit>()
        val fixture = Fixture(live = { request ->
            scanGate.await()
            response(request, "live_snapshot")
        })

        val result = async { fixture.pipeline.execute(request(17)) }
        yield()
        assertEquals(listOf("cache", "deliver:cached_snapshot", "scan"), fixture.events)

        scanGate.complete(Unit)
        val responses = result.await()
        assertEquals(1, fixture.scans)
        assertEquals(
            listOf(
                "cache", "deliver:cached_snapshot", "scan",
                "deliver:live_snapshot", "history",
            ),
            fixture.events,
        )

        fixture.pipeline.replay(request(17), responses)
        assertEquals("deliver:live_snapshot_replay", fixture.events.last())
    }

    @Test
    fun `scale change is cache only`() = runBlocking {
        val fixture = Fixture()

        val responses = fixture.pipeline.execute(
            request(18, PebbleProtocol.COMMAND_SCALE, ChartScale.WEEK),
        )

        assertEquals(0, fixture.scans)
        assertEquals(listOf("cache", "deliver:cached_snapshot", "history"), fixture.events)
        fixture.pipeline.replay(request(18), responses)
        assertEquals("deliver:cached_snapshot_replay", fixture.events.last())
    }

    @Test
    fun `live failure retains cached response and exposes no exception content`() = runBlocking {
        val original = IllegalStateException("sensor address and payload must not escape")
        val fixture = Fixture(live = {
            throw original
        })

        val responses = fixture.pipeline.execute(request(22))

        assertEquals(
            listOf(
                "cache", "deliver:cached_snapshot", "scan", "live_failure",
                "deliver:live_scan", "history",
            ),
            fixture.events,
        )
        assertTrue(fixture.events.none { it.contains("sensor address") })
        assertSame(original, fixture.reported.single())
        fixture.pipeline.replay(request(22), responses)
        assertEquals(
            listOf("deliver:cached_snapshot_replay", "deliver:live_scan_replay"),
            fixture.events.takeLast(2),
        )
    }

    private class Fixture(
        cached: suspend (AirQualityRequest) -> AirQualityResponse? = {
            response(it, "cached_snapshot")
        },
        live: suspend (AirQualityRequest) -> AirQualityResponse = {
            response(it, "live_snapshot")
        },
        failure: suspend (AirQualityRequest) -> AirQualityResponse = {
            response(it, "live_scan", "live_failure")
        },
    ) {
        val events = mutableListOf<String>()
        val reported = mutableListOf<Throwable>()
        var scans = 0
        val pipeline = AirQualityRequestPipeline(
            cachedResponse = {
                events += "cache"
                cached(it)
            },
            liveResponse = {
                scans += 1
                events += "scan"
                live(it)
            },
            liveFailureResponse = {
                events += "live_failure"
                failure(it)
            },
            deliver = { _, value -> events += "deliver:${value.operation}" },
            deliverReplay = { _, values ->
                values.forEach { events += "deliver:${it.operation}" }
            },
            scheduleHistoryRepair = { events += "history" },
            reportError = reported::add,
        )
    }
}

private fun request(
    id: Int,
    command: Int = PebbleProtocol.COMMAND_FETCH,
    scale: ChartScale = ChartScale.HOUR,
) = AirQualityRequest(id, command, scale, "watch")

private fun response(
    request: AirQualityRequest,
    operation: String,
    category: String = "",
) = AirQualityResponse(
    operation,
    PebbleProtocol.status(
        if (category.isBlank()) PebbleProtocol.STATUS_OK else PebbleProtocol.STATUS_SERVICE,
        request.requestId,
    ),
    category,
)
