package com.skarian.airquality

import java.time.Instant
import java.time.LocalDate
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

data class DailyReading(
    val date: Int,
    val co2Ppm: Int?,
    val temperatureX10: Int?,
    val humidityX10: Int?,
    val pressureX10: Int?,
)

data class AirSnapshot(
    val location: String,
    val current: AranetReading,
    val days: List<DailyReading>,
)

object SnapshotAggregator {
    fun build(
        readings: List<AranetReading>,
        location: String,
        nowEpochSeconds: Long,
        zoneId: ZoneId = ZoneId.systemDefault(),
    ): AirSnapshot? {
        val current = readings.maxByOrNull { it.observedAtEpochSeconds } ?: return null
        val today = Instant.ofEpochSecond(nowEpochSeconds).atZone(zoneId).toLocalDate()
        val byDay = readings.groupBy {
            Instant.ofEpochSecond(it.observedAtEpochSeconds).atZone(zoneId).toLocalDate()
        }
        val days = (0L..6L).map { offset ->
            val day = today.minusDays(offset)
            val values = byDay[day].orEmpty()
            DailyReading(
                date = packDate(day),
                co2Ppm = values.averageInt { it.co2Ppm },
                temperatureX10 = values.averageInt { it.temperatureX10 },
                humidityX10 = values.averageInt { it.humidityX10 },
                pressureX10 = values.averageInt { it.pressureX10 },
            )
        }
        return AirSnapshot(location.trim().ifEmpty { "ARANET4" }.take(31), current, days)
    }

    private fun List<AranetReading>.averageInt(value: (AranetReading) -> Int): Int? {
        if (isEmpty()) return null
        return (sumOf { value(it).toLong() } / size).toInt()
    }

    private fun packDate(date: LocalDate): Int =
        date.year * 10000 + date.monthValue * 100 + date.dayOfMonth
}
