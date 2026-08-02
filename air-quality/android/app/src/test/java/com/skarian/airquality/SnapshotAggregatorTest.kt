package com.skarian.airquality

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class SnapshotAggregatorTest {
    @Test
    fun preservesMinimumMaximumAndLastReadingAtScreenResolution() {
        val readings = listOf(
            reading(10, 600),
            reading(20, 800),
            reading(3_600, 700),
        )
        val snapshot = SnapshotAggregator.build(readings, "HOME", 3_600, ChartScale.HOUR)!!
        assertEquals(GRAPH_COLUMNS, snapshot.columns.size)
        assertEquals(600, snapshot.columns[0].metrics[0].minimum)
        assertEquals(800, snapshot.columns[0].metrics[0].maximum)
        assertEquals(800, snapshot.columns[0].metrics[0].last)
        assertEquals(700, snapshot.averages[0])
        assertNull(snapshot.columns[1].metrics[0].last)
    }

    @Test
    fun usesExactRollingWindowsForAllScales() {
        val now = 700_000L
        val readings = listOf(
            reading(now - 8 * 24 * 60 * 60, 400),
            reading(now - 2 * 24 * 60 * 60, 600),
            reading(now - 30 * 60, 800),
            reading(now, 1_000),
        )
        val hour = SnapshotAggregator.build(readings, "HOME", now, ChartScale.HOUR)!!
        val day = SnapshotAggregator.build(readings, "HOME", now, ChartScale.DAY)!!
        val week = SnapshotAggregator.build(readings, "HOME", now, ChartScale.WEEK)!!
        assertEquals(900, hour.averages[0])
        assertEquals(900, day.averages[0])
        assertEquals(800, week.averages[0])
        assertEquals(now - 3_600, hour.windowStartEpochSeconds)
        assertEquals(now - 604_800, week.windowStartEpochSeconds)
    }

    @Test
    fun keepsTheNewestReadingAsCurrent() {
        val snapshot = SnapshotAggregator.build(
            listOf(reading(100, 500), reading(200, 900)), "OFFICE", 200,
        )
        assertEquals(900, snapshot?.current?.co2Ppm)
    }

    private fun reading(time: Long, co2: Int) = AranetReading(
        "AA", "Aranet4", time, co2, 220, 450, 10100, 90,
        if (co2 < 1000) 1 else if (co2 <= 1400) 2 else 3,
    )
}
