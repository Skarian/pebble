package com.skarian.airquality

import kotlin.math.roundToInt

const val UNAVAILABLE: Int = Int.MIN_VALUE
const val GRAPH_COLUMNS: Int = 56
const val METRIC_COUNT: Int = 4

data class AranetReading(
    val address: String,
    val deviceName: String,
    val observedAtEpochSeconds: Long,
    val co2Ppm: Int,
    val temperatureX10: Int,
    val humidityX10: Int,
    val pressureX10: Int,
    val batteryPercent: Int,
    val co2State: Int,
)

enum class ChartScale(val wireValue: Int, val windowSeconds: Long) {
    HOUR(0, 60 * 60),
    DAY(1, 24 * 60 * 60),
    WEEK(2, 7 * 24 * 60 * 60);

    companion object {
        fun fromWire(value: Int?): ChartScale = entries.firstOrNull { it.wireValue == value } ?: HOUR
    }
}

data class ChartColumn(val metrics: List<Int?>)

data class AirSnapshot(
    val location: String,
    val current: AranetReading,
    val scale: ChartScale,
    val windowStartEpochSeconds: Long,
    val columns: List<ChartColumn>,
    val averages: List<Int?>,
)

object SnapshotAggregator {
    fun build(
        readings: List<AranetReading>,
        location: String,
        nowEpochSeconds: Long,
        scale: ChartScale = ChartScale.HOUR,
    ): AirSnapshot? {
        val current = readings.maxByOrNull { it.observedAtEpochSeconds } ?: return null
        val windowStart = nowEpochSeconds - scale.windowSeconds
        val inWindow = readings.asSequence()
            .filter { it.observedAtEpochSeconds in windowStart..nowEpochSeconds }
            .sortedBy { it.observedAtEpochSeconds }
            .toList()
        val columnTotals = Array(METRIC_COUNT) { LongArray(GRAPH_COLUMNS) }
        val columnCounts = Array(METRIC_COUNT) { IntArray(GRAPH_COLUMNS) }
        val totals = LongArray(METRIC_COUNT)
        val counts = IntArray(METRIC_COUNT)

        inWindow.forEach { reading ->
            val elapsed = reading.observedAtEpochSeconds - windowStart
            val column = ((elapsed * GRAPH_COLUMNS) / scale.windowSeconds)
                .toInt().coerceIn(0, GRAPH_COLUMNS - 1)
            repeat(METRIC_COUNT) { metric ->
                val value = metricValue(reading, metric)
                if (value == UNAVAILABLE) return@repeat
                columnTotals[metric][column] += value
                columnCounts[metric][column] += 1
                totals[metric] += value
                counts[metric] += 1
            }
        }

        val columns = (0 until GRAPH_COLUMNS).map { column ->
            ChartColumn((0 until METRIC_COUNT).map { metric ->
                val count = columnCounts[metric][column]
                if (count == 0) null else (columnTotals[metric][column].toDouble() / count).roundToInt()
            })
        }
        val averages = (0 until METRIC_COUNT).map { metric ->
            if (counts[metric] == 0) null else (totals[metric].toDouble() / counts[metric]).roundToInt()
        }
        return AirSnapshot(
            location = location.trim().ifEmpty { "ARANET4" }.take(31),
            current = current,
            scale = scale,
            windowStartEpochSeconds = windowStart,
            columns = columns,
            averages = averages,
        )
    }

    private fun metricValue(reading: AranetReading, metric: Int): Int = when (metric) {
        0 -> reading.co2Ppm
        1 -> reading.temperatureX10
        2 -> reading.humidityX10
        else -> reading.pressureX10
    }
}
