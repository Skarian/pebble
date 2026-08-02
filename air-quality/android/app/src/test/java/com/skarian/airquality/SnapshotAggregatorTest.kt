package com.skarian.airquality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.time.LocalDateTime
import java.time.ZoneId

class SnapshotAggregatorTest {
    private val zone = ZoneId.of("America/Chicago")

    @Test
    fun buildsSevenDailyBucketsAndAveragesSamples() {
        val now = LocalDateTime.of(2026, 8, 2, 12, 0).atZone(zone).toEpochSecond()
        val readings = listOf(
            reading(now - 60, 600),
            reading(now - 120, 700),
            reading(now - 86_400, 800),
        )
        val snapshot = SnapshotAggregator.build(
            readings, "HOME", now, ChartScale.WEEK, zone,
        )
        requireNotNull(snapshot)
        assertEquals(7, snapshot.points.size)
        assertEquals(650, snapshot.points[0].co2Ppm)
        assertEquals(800, snapshot.points[1].co2Ppm)
        assertNull(snapshot.points[2].co2Ppm)
    }

    @Test
    fun keepsTheNewestReadingAsCurrent() {
        val snapshot = SnapshotAggregator.build(
            listOf(reading(100, 500), reading(200, 900)), "OFFICE", 200,
            zoneId = ZoneId.of("UTC"),
        )
        assertEquals(900, snapshot?.current?.co2Ppm)
    }

    @Test
    fun hourAndDayUseShortAveragingBuckets() {
        val readings = listOf(reading(3_599, 600), reading(3_100, 800), reading(2_500, 1000))
        val hour = SnapshotAggregator.build(readings, "HOME", 3_599, ChartScale.HOUR, ZoneId.of("UTC"))!!
        val day = SnapshotAggregator.build(readings, "HOME", 3_599, ChartScale.DAY, ZoneId.of("UTC"))!!
        assertEquals(700, hour.points[0].co2Ppm)
        assertEquals(1000, hour.points[1].co2Ppm)
        assertEquals(800, day.points[0].co2Ppm)
    }

    private fun reading(time: Long, co2: Int) = AranetReading(
        "AA", "Aranet4", time, co2, 220, 450, 10100, 90,
        if (co2 < 1000) 1 else if (co2 <= 1400) 2 else 3,
    )
}
