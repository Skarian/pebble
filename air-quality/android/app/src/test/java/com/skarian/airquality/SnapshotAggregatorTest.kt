package com.skarian.airquality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class SnapshotAggregatorTest {
    private val zone = ZoneId.of("America/Chicago")

    @Test
    fun buildsTodayPlusSixPreviousDaysAndAveragesSamples() {
        val now = LocalDateTime.of(2026, 8, 2, 12, 0).atZone(zone).toEpochSecond()
        val readings = listOf(
            reading(now - 60, 600),
            reading(now - 120, 700),
            reading(now - 86_400, 800),
        )
        val snapshot = SnapshotAggregator.build(readings, "HOME", now, zone)
        requireNotNull(snapshot)
        assertEquals(7, snapshot.days.size)
        assertEquals(20260802, snapshot.days[0].date)
        assertEquals(650, snapshot.days[0].co2Ppm)
        assertEquals(20260801, snapshot.days[1].date)
        assertEquals(800, snapshot.days[1].co2Ppm)
        assertNull(snapshot.days[2].co2Ppm)
    }

    @Test
    fun keepsTheNewestReadingAsCurrent() {
        val snapshot = SnapshotAggregator.build(
            listOf(reading(100, 500), reading(200, 900)), "OFFICE", 200, ZoneId.of("UTC"),
        )
        assertEquals(900, snapshot?.current?.co2Ppm)
    }

    private fun reading(time: Long, co2: Int) = AranetReading(
        "AA", "Aranet4", time, co2, 220, 450, 10100, 90,
        if (co2 < 1000) 1 else if (co2 <= 1400) 2 else 3,
    )
}
