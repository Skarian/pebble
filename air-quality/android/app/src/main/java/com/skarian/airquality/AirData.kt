package com.skarian.airquality

import java.time.Instant
import java.time.ZoneId

const val UNAVAILABLE: Int = Int.MIN_VALUE

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

enum class ChartScale(val wireValue: Int, val bucketSeconds: Long) {
    HOUR(0, 10 * 60),
    DAY(1, 4 * 60 * 60),
    WEEK(2, 24 * 60 * 60);

    companion object {
        fun fromWire(value: Int?): ChartScale = entries.firstOrNull { it.wireValue == value } ?: HOUR
    }
}

data class BucketReading(
    val startsAtEpochSeconds: Int,
    val co2Ppm: Int?,
    val temperatureX10: Int?,
    val humidityX10: Int?,
    val pressureX10: Int?,
)

data class AirSnapshot(
    val location: String,
    val current: AranetReading,
    val scale: ChartScale,
    val points: List<BucketReading>,
)

object SnapshotAggregator {
    fun build(
        readings: List<AranetReading>,
        location: String,
        nowEpochSeconds: Long,
        scale: ChartScale = ChartScale.HOUR,
        zoneId: ZoneId = ZoneId.systemDefault(),
    ): AirSnapshot? {
        val current = readings.maxByOrNull { it.observedAtEpochSeconds } ?: return null
        val starts = if (scale == ChartScale.WEEK) {
            val today = Instant.ofEpochSecond(nowEpochSeconds).atZone(zoneId).toLocalDate()
            (0L..6L).map { today.minusDays(it).atStartOfDay(zoneId).toEpochSecond() }
        } else {
            val aligned = nowEpochSeconds - nowEpochSeconds % scale.bucketSeconds
            (0L..6L).map { aligned - it * scale.bucketSeconds }
        }
        val points = starts.map { start ->
            val end = if (scale == ChartScale.WEEK) {
                Instant.ofEpochSecond(start).atZone(zoneId).toLocalDate().plusDays(1)
                    .atStartOfDay(zoneId).toEpochSecond()
            } else start + scale.bucketSeconds
            val values = readings.filter { it.observedAtEpochSeconds in start until end }
            BucketReading(
                startsAtEpochSeconds = start.toInt(),
                co2Ppm = values.averageInt { it.co2Ppm },
                temperatureX10 = values.averageInt { it.temperatureX10 },
                humidityX10 = values.averageInt { it.humidityX10 },
                pressureX10 = values.averageInt { it.pressureX10 },
            )
        }
        return AirSnapshot(location.trim().ifEmpty { "ARANET4" }.take(31), current, scale, points)
    }

    private fun List<AranetReading>.averageInt(value: (AranetReading) -> Int): Int? {
        if (isEmpty()) return null
        return (sumOf { value(it).toLong() } / size).toInt()
    }
}
