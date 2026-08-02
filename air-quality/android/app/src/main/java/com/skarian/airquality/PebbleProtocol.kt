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

    const val COMMAND_FETCH = 1
    const val COMMAND_PHONE_READY = 2

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
        val partial = snapshot.days.any {
            it.co2Ppm == null || it.temperatureX10 == null ||
                it.humidityX10 == null || it.pressureX10 == null
        }
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
        )
        snapshot.days.take(7).forEachIndexed { index, day ->
            val base = 20 + index * 5
            result[base.toUInt()] = PebbleDictionaryItem.UInt32(day.date.toLong())
            result[(base + 1).toUInt()] = PebbleDictionaryItem.Int32(day.co2Ppm ?: UNAVAILABLE)
            result[(base + 2).toUInt()] = PebbleDictionaryItem.Int32(day.temperatureX10 ?: UNAVAILABLE)
            result[(base + 3).toUInt()] = PebbleDictionaryItem.Int32(day.humidityX10 ?: UNAVAILABLE)
            result[(base + 4).toUInt()] = PebbleDictionaryItem.Int32(day.pressureX10 ?: UNAVAILABLE)
        }
        return result
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
}
