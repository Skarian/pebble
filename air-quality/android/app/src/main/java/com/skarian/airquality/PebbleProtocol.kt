package com.skarian.airquality

import io.rebble.pebblekit2.common.model.PebbleDictionary
import io.rebble.pebblekit2.common.model.PebbleDictionaryItem

object PebbleProtocol {
    const val APP_UUID = "496e29b5-9542-430b-b75a-14dbb399b884"

    const val PROTOCOL = 0
    const val COMMAND = 1
    const val REQUEST_ID = 2
    const val STATUS = 3
    const val OBSERVED_AT = 4
    const val FLAGS = 5
    const val LOCATION = 6
    const val ERROR_TEXT = 7
    const val CO2_STATE = 8
    const val BATTERY = 9
    const val CO2 = 10
    const val TEMP_X10 = 11
    const val HUMIDITY_X10 = 12
    const val PRESSURE_X10 = 13
    const val SCALE = 14
    const val POINT_COUNT = 15
    const val WINDOW_START = 16
    const val SERIES_CO2 = 60
    const val SERIES_TEMP_X10 = 61
    const val SERIES_HUMIDITY_X10 = 62
    const val SERIES_PRESSURE_X10 = 63
    const val AVG_CO2 = 64
    const val AVG_TEMP_X10 = 65
    const val AVG_HUMIDITY_X10 = 66
    const val AVG_PRESSURE_X10 = 67

    const val COMMAND_FETCH = 1
    const val COMMAND_PHONE_READY = 2
    const val COMMAND_SCALE = 3

    const val STATUS_OK = 0
    const val STATUS_SETUP = 1
    const val STATUS_COMPANION = 2
    const val STATUS_BLUETOOTH = 3
    const val STATUS_PERMISSION = 4
    const val STATUS_SENSOR = 5
    const val STATUS_TIMEOUT = 6
    const val STATUS_SERVICE = 7
    const val STATUS_PARTIAL = 8

    fun phoneReady(): PebbleDictionary = mapOf(
        PROTOCOL.toUInt() to PebbleDictionaryItem.UInt8(1),
        COMMAND.toUInt() to PebbleDictionaryItem.UInt8(COMMAND_PHONE_READY),
    )

    fun status(status: Int, requestId: Int, text: String = ""): PebbleDictionary {
        val result = mutableMapOf<UInt, PebbleDictionaryItem>(
            PROTOCOL.toUInt() to PebbleDictionaryItem.UInt8(1),
            STATUS.toUInt() to PebbleDictionaryItem.UInt8(status),
            REQUEST_ID.toUInt() to PebbleDictionaryItem.UInt16(requestId),
        )
        if (text.isNotBlank()) result[ERROR_TEXT.toUInt()] = PebbleDictionaryItem.Text(text.take(48))
        return result
    }

    fun snapshot(snapshot: AirSnapshot, requestId: Int, nowEpochSeconds: Long): PebbleDictionary {
        val partial = snapshot.averages.any { it == null }
        val stale = nowEpochSeconds - snapshot.current.observedAtEpochSeconds > 30 * 60
        val result = mutableMapOf<UInt, PebbleDictionaryItem>(
            PROTOCOL.toUInt() to PebbleDictionaryItem.UInt8(1),
            STATUS.toUInt() to PebbleDictionaryItem.UInt8(if (partial) STATUS_PARTIAL else STATUS_OK),
            REQUEST_ID.toUInt() to PebbleDictionaryItem.UInt16(requestId),
            OBSERVED_AT.toUInt() to PebbleDictionaryItem.UInt32(snapshot.current.observedAtEpochSeconds),
            FLAGS.toUInt() to PebbleDictionaryItem.UInt8(if (stale) 1 else 0),
            LOCATION.toUInt() to PebbleDictionaryItem.Text(snapshot.location),
            CO2_STATE.toUInt() to PebbleDictionaryItem.UInt8(snapshot.current.co2State),
            BATTERY.toUInt() to PebbleDictionaryItem.Int32(snapshot.current.batteryPercent),
            CO2.toUInt() to PebbleDictionaryItem.Int32(snapshot.current.co2Ppm),
            TEMP_X10.toUInt() to PebbleDictionaryItem.Int32(snapshot.current.temperatureX10),
            HUMIDITY_X10.toUInt() to PebbleDictionaryItem.Int32(snapshot.current.humidityX10),
            PRESSURE_X10.toUInt() to PebbleDictionaryItem.Int32(snapshot.current.pressureX10),
            SCALE.toUInt() to PebbleDictionaryItem.UInt8(snapshot.scale.wireValue),
            POINT_COUNT.toUInt() to PebbleDictionaryItem.UInt8(GRAPH_COLUMNS),
            WINDOW_START.toUInt() to PebbleDictionaryItem.UInt32(snapshot.windowStartEpochSeconds),
        )
        val seriesKeys = intArrayOf(SERIES_CO2, SERIES_TEMP_X10, SERIES_HUMIDITY_X10, SERIES_PRESSURE_X10)
        val averageKeys = intArrayOf(AVG_CO2, AVG_TEMP_X10, AVG_HUMIDITY_X10, AVG_PRESSURE_X10)
        repeat(METRIC_COUNT) { metric ->
            result[seriesKeys[metric].toUInt()] = PebbleDictionaryItem.Bytes(packSeries(snapshot, metric))
            result[averageKeys[metric].toUInt()] = PebbleDictionaryItem.Int32(
                snapshot.averages[metric] ?: UNAVAILABLE,
            )
        }
        return result
    }

    private fun packSeries(snapshot: AirSnapshot, metric: Int): ByteArray =
        ByteArray(GRAPH_COLUMNS * VALUES_PER_COLUMN * 2).also { bytes ->
            snapshot.columns.forEachIndexed { column, chartColumn ->
                val band = chartColumn.metrics[metric]
                val values = intArrayOf(
                    band.minimum ?: PACKED_UNAVAILABLE,
                    band.maximum ?: PACKED_UNAVAILABLE,
                    band.last ?: PACKED_UNAVAILABLE,
                )
                values.forEachIndexed { valueIndex, value ->
                    val offset = (column * VALUES_PER_COLUMN + valueIndex) * 2
                    val packed = value.takeIf { it in Short.MIN_VALUE + 1..Short.MAX_VALUE }
                        ?: PACKED_UNAVAILABLE
                    bytes[offset] = (packed and 0xff).toByte()
                    bytes[offset + 1] = (packed shr 8).toByte()
                }
            }
        }

    fun number(data: PebbleDictionary, key: Int): Int? = when (val item = data[key.toUInt()]) {
        is PebbleDictionaryItem.Int32 -> item.value
        is PebbleDictionaryItem.UInt32 -> item.value.toInt()
        is PebbleDictionaryItem.Int16 -> item.value.toInt()
        is PebbleDictionaryItem.UInt16 -> item.value.toInt()
        is PebbleDictionaryItem.Int8 -> item.value.toInt()
        is PebbleDictionaryItem.UInt8 -> item.value.toInt()
        else -> null
    }

    private const val VALUES_PER_COLUMN = 3
    private const val PACKED_UNAVAILABLE = Short.MIN_VALUE.toInt()
}
